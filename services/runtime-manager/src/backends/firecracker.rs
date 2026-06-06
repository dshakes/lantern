//! Firecracker microVM backend.
//!
//! # Architecture
//!
//! The Firecracker REST API is served on a per-VM Unix domain socket
//! (`/run/firecracker/<vm-id>.sock` by convention).  This module drives that
//! API via a thin hyper/hyperlocal client — one request at a time, no
//! connection pool needed because each VM has its own socket.
//!
//! The implementation is structured so that **all logic that does not require
//! KVM is unit-testable on macOS or in CI without /dev/kvm**.  The live boot
//! path is gated behind `firecracker_available()` which checks:
//!
//!   1. OS is Linux
//!   2. `firecracker` binary is on PATH (or at the path in `FC_BINARY_PATH`)
//!   3. `/dev/kvm` is present and readable
//!
//! If any check fails, every backend method returns the same
//! "not available" error it would return on this macOS dev host.
//!
//! # Linux-only / KVM-only paths (requires integration on a Linux host)
//!
//! - `unix_socket_put` / `unix_socket_patch`: actual HTTP-over-Unix-socket
//!   I/O via `hyperlocal`.  Tagged with `// LINUX-ONLY` comments.
//! - `spawn_firecracker_process`: forks the `firecracker` binary with
//!   `--api-sock`.  Tagged `// LINUX-ONLY`.
//! - `setup_tap_device`: creates a TAP device and attaches it to a bridge.
//!   Marked `// LINUX-ONLY: requires root / CAP_NET_ADMIN`.
//! - The `schedule()` / `cancel()` / `restore()` live paths after the
//!   `firecracker_available()` gate.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::backend::{Handle, RuntimeBackend, SnapshotInfo};
use crate::proto::{RestoreRequest, RuntimeEvent, RuntimeExited, ScheduleRequest, SnapshotRequest};

// ---------------------------------------------------------------------------
// Firecracker REST API request bodies
//
// Each struct maps 1:1 to a Firecracker API endpoint body.  The field names
// must match the Firecracker JSON schema exactly — unit tests below verify
// the serialized form against the documented API contract.
// ---------------------------------------------------------------------------

/// PUT /boot-source
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BootSource {
    pub kernel_image_path: String,
    pub boot_args: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initrd_path: Option<String>,
}

/// PUT /drives/{id}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Drive {
    pub drive_id: String,
    pub path_on_host: String,
    pub is_root_device: bool,
    pub is_read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partuuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limiter: Option<RateLimiter>,
}

/// Token bucket within a rate limiter.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RateLimiter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bandwidth: Option<TokenBucket>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops: Option<TokenBucket>,
}

/// Token bucket parameters.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenBucket {
    pub size: u64,
    pub one_time_burst: u64,
    pub refill_time: u64,
}

/// PUT /machine-config
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MachineConfig {
    pub vcpu_count: u32,
    pub mem_size_mib: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smt: Option<bool>,
    /// Required for diff snapshots (live migration, fast restore).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_dirty_pages: Option<bool>,
}

/// PUT /network-interfaces/{id}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkInterface {
    pub iface_id: String,
    pub guest_mac: String,
    pub host_dev_name: String,
}

/// PUT /vsock
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct VsockDevice {
    pub vsock_id: String,
    pub guest_cid: u32,
    pub uds_path: String,
}

/// PUT /actions — InstanceStart, FlushMetrics, SendCtrlAltDel
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstanceAction {
    pub action_type: String,
}

/// PATCH /vm — pause / resume
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct VmState {
    pub state: String, // "Paused" | "Resumed"
}

/// PUT /snapshot/create
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotCreateParams {
    pub snapshot_type: String, // "Full" | "Diff"
    pub snapshot_path: String,
    pub mem_file_path: String,
}

/// PUT /snapshot/load
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotLoadParams {
    pub snapshot_path: String,
    pub mem_backend: MemBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_diff_snapshots: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_vm: Option<bool>,
}

/// Memory backend for snapshot loading.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemBackend {
    pub backend_type: String, // "File"
    pub backend_path: String,
}

// ---------------------------------------------------------------------------
// Derived VM configuration
// ---------------------------------------------------------------------------

/// All parameters needed to boot a single microVM instance.
/// Derived from `ScheduleRequest` in `VmConfig::from_schedule`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmConfig {
    pub vm_id: String,
    pub socket_path: String,
    pub kernel_image_path: String,
    pub rootfs_path: String,
    pub boot_args: String,
    pub vcpu_count: u32,
    pub mem_size_mib: u32,
    /// TAP device name on the host side.
    pub tap_dev: String,
    /// Guest-side MAC address (derived deterministically from vm_id).
    pub guest_mac: String,
    /// vsock UDS path for host-guest communication.
    pub vsock_uds_path: String,
    /// Snapshot directory (e.g. `/run/lantern/snapshots/<vm-id>`).
    pub snapshot_dir: String,
    /// Per-VM certificate paths for the harness mTLS contract.
    /// Generation runs in `provision_vm_cert` (Identity phase); these are the
    /// IN-GUEST paths the boot-args reference and the harness reads off the
    /// read-only cert drive (see `cert_drive` / `certs_image_path`).
    pub tls_cert_path: String,
    pub tls_key_path: String,
    pub manager_ca_path: String,
    /// Host path to the read-only block image carrying this VM's cert material,
    /// attached as a dedicated drive so the in-guest `tls_cert_path` etc.
    /// resolve. Built from the provisioned `/run/lantern/certs/<vm_id>/` tree.
    pub certs_image_path: String,
}

/// Defaults injected when the ScheduleRequest does not set a limit.
pub const DEFAULT_VCPU: u32 = 2;
pub const DEFAULT_MEM_MIB: u32 = 512;

impl VmConfig {
    /// Derive a `VmConfig` from a `ScheduleRequest`.
    ///
    /// Pure function — no I/O.  Unit-testable on any platform.
    pub fn from_schedule(
        req: &ScheduleRequest,
        kernel_image_path: &str,
        rootfs_path: &str,
    ) -> Self {
        let vm_id = Uuid::new_v4().to_string();
        Self::from_schedule_with_id(req, kernel_image_path, rootfs_path, &vm_id)
    }

    /// Same as `from_schedule` but caller provides the vm_id (for testing).
    pub fn from_schedule_with_id(
        req: &ScheduleRequest,
        kernel_image_path: &str,
        rootfs_path: &str,
        vm_id: &str,
    ) -> Self {
        let vcpu_count = parse_cpu_limit(&req.limits.cpu).unwrap_or(DEFAULT_VCPU);
        let mem_size_mib = parse_mem_limit(&req.limits.memory).unwrap_or(DEFAULT_MEM_MIB);

        // Deterministic MAC: use the first 6 bytes of the vm_id UUID hex.
        // Strip hyphens, take first 12 hex chars → 6 bytes.
        let hex: String = vm_id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        let guest_mac = format!(
            "02:{:>02}:{:>02}:{:>02}:{:>02}:{:>02}",
            &hex[..2],
            &hex[2..4],
            &hex[4..6],
            &hex[6..8],
            &hex[8..10],
        );

        // Build kernel boot_args; inject the Lantern env contract:
        //   LANTERN_VM_ID, LANTERN_VM_TLS_CERT/KEY, LANTERN_MANAGER_TLS_CA.
        // Note: per-VM cert generation is a paired follow-up.  We thread
        // the paths here so the boot-args contract is stable.
        let tls_cert_path = format!("/run/lantern/certs/{vm_id}/tls.crt");
        let tls_key_path = format!("/run/lantern/certs/{vm_id}/tls.key");
        let manager_ca_path = "/run/lantern/certs/manager-ca.crt".to_string();

        let boot_args = build_boot_args(
            vm_id,
            &req.run_id,
            &tls_cert_path,
            &tls_key_path,
            &manager_ca_path,
            req,
        );

        VmConfig {
            vm_id: vm_id.to_string(),
            socket_path: format!("/run/firecracker/{vm_id}.sock"),
            kernel_image_path: kernel_image_path.to_string(),
            rootfs_path: rootfs_path.to_string(),
            boot_args,
            vcpu_count,
            mem_size_mib,
            tap_dev: format!("fc-{}", &vm_id[..8]),
            guest_mac,
            vsock_uds_path: format!("/run/lantern/vsock/{vm_id}.sock"),
            snapshot_dir: format!("/run/lantern/snapshots/{vm_id}"),
            tls_cert_path,
            tls_key_path,
            manager_ca_path,
            certs_image_path: format!("/run/lantern/certs/{vm_id}/certs.img"),
        }
    }

    /// Produce the MachineConfig body for PUT /machine-config.
    pub fn machine_config(&self) -> MachineConfig {
        MachineConfig {
            vcpu_count: self.vcpu_count,
            mem_size_mib: self.mem_size_mib,
            smt: Some(false),
            track_dirty_pages: Some(true), // required for diff snapshots
        }
    }

    /// Produce the BootSource body for PUT /boot-source.
    pub fn boot_source(&self) -> BootSource {
        BootSource {
            kernel_image_path: self.kernel_image_path.clone(),
            boot_args: self.boot_args.clone(),
            initrd_path: None,
        }
    }

    /// Produce the root Drive body for PUT /drives/rootfs.
    pub fn root_drive(&self) -> Drive {
        Drive {
            drive_id: "rootfs".to_string(),
            path_on_host: self.rootfs_path.clone(),
            is_root_device: true,
            is_read_only: false,
            partuuid: None,
            rate_limiter: None,
        }
    }

    /// Produce the read-only cert Drive body for PUT /drives/certs.
    ///
    /// Attaches the per-VM cert image (built from the material `provision_vm_cert`
    /// wrote on the host) so the in-guest harness can read the paths the
    /// boot-args reference (`tls_cert_path` / `tls_key_path` / `manager_ca_path`).
    /// Read-only: the guest must never be able to rewrite its own identity.
    pub fn cert_drive(&self) -> Drive {
        Drive {
            drive_id: "certs".to_string(),
            path_on_host: self.certs_image_path.clone(),
            is_root_device: false,
            is_read_only: true,
            partuuid: None,
            rate_limiter: None,
        }
    }

    /// Produce the NetworkInterface body for PUT /network-interfaces/eth0.
    pub fn network_interface(&self) -> NetworkInterface {
        NetworkInterface {
            iface_id: "eth0".to_string(),
            guest_mac: self.guest_mac.clone(),
            host_dev_name: self.tap_dev.clone(),
        }
    }

    /// Produce the VsockDevice body for PUT /vsock.
    pub fn vsock_device(&self) -> VsockDevice {
        VsockDevice {
            vsock_id: "lantern-vsock".to_string(),
            guest_cid: 3,
            uds_path: self.vsock_uds_path.clone(),
        }
    }

    /// Snapshot directory for PUT /snapshot/create.
    pub fn snapshot_create_params(&self, snapshot_type: &str) -> SnapshotCreateParams {
        SnapshotCreateParams {
            snapshot_type: snapshot_type.to_string(),
            snapshot_path: format!("{}/snapshot", self.snapshot_dir),
            mem_file_path: format!("{}/mem", self.snapshot_dir),
        }
    }
}

// ---------------------------------------------------------------------------
// CPU / memory limit parsing (pure functions, unit-testable)
// ---------------------------------------------------------------------------

/// Parse a Kubernetes-style CPU limit string to a vcpu count.
///
/// - `"2"` → 2
/// - `"500m"` → 1   (rounds up from 0.5)
/// - `"2000m"` → 2
/// - `""` / parse error → `None` (caller uses default)
pub fn parse_cpu_limit(cpu: &str) -> Option<u32> {
    if cpu.is_empty() {
        return None;
    }
    if let Some(millis_str) = cpu.strip_suffix('m') {
        let millis: u32 = millis_str.parse().ok()?;
        Some((millis / 1000).max(1))
    } else {
        cpu.parse::<u32>().ok()
    }
}

/// Parse a Kubernetes-style memory limit string to MiB.
///
/// - `"512Mi"` → 512
/// - `"2Gi"` → 2048
/// - `""` / parse error → `None` (caller uses default)
pub fn parse_mem_limit(mem: &str) -> Option<u32> {
    if mem.is_empty() {
        return None;
    }
    if let Some(gib_str) = mem.strip_suffix("Gi") {
        let gib: u32 = gib_str.parse().ok()?;
        Some(gib * 1024)
    } else if let Some(mib_str) = mem.strip_suffix("Mi") {
        mib_str.parse().ok()
    } else {
        None
    }
}

/// Build the kernel `console=ttyS0 …` boot_args string, injecting the
/// Lantern env contract as kernel parameters the init process picks up.
///
/// Pure function — unit-testable.
pub fn build_boot_args(
    vm_id: &str,
    run_id: &str,
    tls_cert_path: &str,
    tls_key_path: &str,
    manager_ca_path: &str,
    req: &ScheduleRequest,
) -> String {
    // Encode extra env vars from the ScheduleRequest as k=v pairs on the
    // command line under the `lantern.env.` prefix so the init process can
    // export them into the harness environment.
    let extra_env: String = req
        .env
        .iter()
        .map(|(k, v)| {
            // Sanitise: strip spaces and quotes to avoid breaking the
            // command line.  Real production would use a structured config
            // file rather than kernel args for large env sets.
            let v_clean = v.replace([' ', '"', '\''], "_");
            format!(" lantern.env.{k}={v_clean}")
        })
        .collect();

    format!(
        "console=ttyS0 reboot=k panic=1 pci=off \
         lantern.vm_id={vm_id} \
         lantern.run_id={run_id} \
         lantern.tls_cert={tls_cert_path} \
         lantern.tls_key={tls_key_path} \
         lantern.manager_ca={manager_ca_path}{extra_env}"
    )
}

/// Provision the per-VM client cert + manager CA onto the host filesystem under
/// the cert root that `cfg`'s boot-args reference.
///
/// Loads the manager's signing CA from env (`tls::load_signing_ca`), issues a
/// leaf with CN=SAN=vm_id, and writes (via [`crate::tls::write_vm_cert_files`],
/// key 0600 / dir 0700):
///   - `<root>/<vm_id>/tls.crt`   (leaf cert)        == `cfg.tls_cert_path`
///   - `<root>/<vm_id>/tls.key`   (leaf key)         == `cfg.tls_key_path`
///   - `<root>/manager-ca.crt`    (manager CA cert)  == `cfg.manager_ca_path`
///
/// Fail-closed: if the signing CA is unavailable the VM is NOT booted, because
/// a VM without a client cert could never authenticate to VendSecret and would
/// be a silent dead-end. (In dev with no CA the Firecracker backend itself is
/// unavailable, so this path is only reached on a real Linux+KVM node where the
/// CA is expected to be configured.)
///
/// LINUX-ONLY in practice: only reached after `firecracker_available()`.
fn provision_vm_cert(cfg: &VmConfig) -> Result<()> {
    use std::path::Path;

    let (ca_cert_pem, ca_key_pem) = crate::tls::load_signing_ca()?.ok_or_else(|| {
        anyhow::anyhow!(
            "no manager signing CA configured (set {} / {} or {} / {}); \
             cannot issue per-VM client cert for vm '{}'. Refusing to boot a VM \
             that could not authenticate to VendSecret.",
            crate::tls::ENV_SIGNING_CA_CERT,
            crate::tls::ENV_SIGNING_CA_KEY,
            crate::tls::ENV_CA,
            crate::tls::ENV_KEY,
            cfg.vm_id,
        )
    })?;

    let issued = crate::tls::generate_vm_client_cert(&cfg.vm_id, &ca_cert_pem, &ca_key_pem)
        .with_context(|| format!("issue client cert for vm '{}'", cfg.vm_id))?;

    // The cert root is the grandparent of `<root>/<vm_id>/tls.crt`. Writing
    // through the shared helper keeps the boot-args paths and the on-disk
    // layout in lockstep (it produces exactly cfg.tls_cert_path/key_path and
    // cfg.manager_ca_path for the default VmConfig layout).
    let cert_root = Path::new(&cfg.tls_cert_path)
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| anyhow::anyhow!("malformed tls_cert_path {:?}", cfg.tls_cert_path))?;

    let paths = crate::tls::write_vm_cert_files(cert_root, &cfg.vm_id, &issued, &ca_cert_pem)
        .with_context(|| format!("write per-vm cert material for vm '{}'", cfg.vm_id))?;

    tracing::info!(
        vm_id = %cfg.vm_id,
        cert = %paths.cert_path.display(),
        "provisioned per-VM client cert (CN=vm_id, signed by manager CA)"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// VM lifecycle state machine
//
// The state enum is separate from the actual process handle so transitions
// can be unit-tested without spawning a real process.
// ---------------------------------------------------------------------------

/// Lifecycle states of a microVM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VmLifecycle {
    /// Firecracker process is started; API socket is ready.
    Configuring,
    /// InstanceStart has been sent; guest is booting.
    Starting,
    /// Guest boot is complete; harness is running.
    Running,
    /// PATCH /vm Paused sent (pre-snapshot).
    Paused,
    /// SendCtrlAltDel sent; waiting for guest to shutdown.
    ShuttingDown,
    /// Firecracker process has exited.
    Exited,
}

/// Valid transitions in the lifecycle state machine.
///
/// Returns `Ok(new_state)` or `Err` with a description of the invalid
/// transition.
pub fn transition(from: VmLifecycle, to: VmLifecycle) -> Result<VmLifecycle> {
    let ok = matches!(
        (from, to),
        (VmLifecycle::Configuring, VmLifecycle::Starting)
            | (VmLifecycle::Starting, VmLifecycle::Running)
            | (VmLifecycle::Running, VmLifecycle::Paused)
            | (VmLifecycle::Paused, VmLifecycle::Running)
            | (VmLifecycle::Running, VmLifecycle::ShuttingDown)
            | (VmLifecycle::Paused, VmLifecycle::ShuttingDown)
            | (VmLifecycle::ShuttingDown, VmLifecycle::Exited)
            // Allow forced kill from any state.
            | (_, VmLifecycle::Exited)
    );
    if ok {
        Ok(to)
    } else {
        bail!("invalid VM lifecycle transition: {from:?} → {to:?}")
    }
}

// ---------------------------------------------------------------------------
// Availability detection
//
// Injectable probe inputs so the decision logic is unit-testable without a
// real Linux + KVM environment.
// ---------------------------------------------------------------------------

/// Inputs to the availability check, injectable for unit tests.
pub struct AvailabilityProbe {
    pub is_linux: bool,
    pub firecracker_binary_path: Option<String>,
    pub kvm_readable: bool,
}

impl AvailabilityProbe {
    /// Build the probe from the real runtime environment.
    /// This is the ONLY path that touches the filesystem.
    ///
    /// LINUX-ONLY: `is_linux` is `cfg!(target_os = "linux")`;
    /// `/dev/kvm` readable check only meaningful on Linux.
    pub fn from_env() -> Self {
        let is_linux = cfg!(target_os = "linux");

        // Check for FC_BINARY_PATH override, then fall back to PATH lookup.
        let firecracker_binary_path = std::env::var("FC_BINARY_PATH")
            .ok()
            .filter(|p| !p.is_empty())
            .or_else(which_firecracker);

        // LINUX-ONLY: /dev/kvm is a Linux character device; on macOS this
        // path does not exist and the check returns false.
        let kvm_readable = is_linux && Path::new("/dev/kvm").exists();

        AvailabilityProbe {
            is_linux,
            firecracker_binary_path,
            kvm_readable,
        }
    }
}

/// Check whether Firecracker is available using the given probe inputs.
///
/// Unit-testable: pass synthetic probe values instead of reading the filesystem.
#[must_use]
pub fn is_available_with_probe(probe: &AvailabilityProbe) -> bool {
    probe.is_linux && probe.firecracker_binary_path.is_some() && probe.kvm_readable
}

/// Check whether Firecracker is available on the current host.
///
/// LINUX-ONLY: returns `false` on macOS (no /dev/kvm).
#[must_use]
pub fn firecracker_available() -> bool {
    is_available_with_probe(&AvailabilityProbe::from_env())
}

/// Find the `firecracker` binary on PATH.  Returns `None` if not found.
fn which_firecracker() -> Option<String> {
    std::env::var_os("PATH")
        .and_then(|path_var| {
            std::env::split_paths(&path_var)
                .map(|dir| dir.join("firecracker"))
                .find(|p| p.is_file())
        })
        .and_then(|p| p.into_os_string().into_string().ok())
}

// ---------------------------------------------------------------------------
// Unix-socket HTTP client for the Firecracker REST API
//
// LINUX-ONLY: the actual socket I/O below uses hyperlocal, which creates
// a Unix domain socket connection.  On macOS the socket does not exist so
// connect() would fail — but this code path is only reached after
// `firecracker_available()` returns true, which requires Linux + /dev/kvm.
// ---------------------------------------------------------------------------

/// Send an HTTP PUT to `path` on the Firecracker socket at `socket_path`.
///
/// LINUX-ONLY: requires the Firecracker process to be running and the Unix
/// socket to exist.  Integration-tested on a Linux host.
pub async fn unix_socket_put<T: Serialize>(socket_path: &str, path: &str, body: &T) -> Result<()> {
    unix_socket_request(socket_path, "PUT", path, Some(body)).await
}

/// Send an HTTP PATCH to `path` on the Firecracker socket at `socket_path`.
///
/// LINUX-ONLY: same constraints as `unix_socket_put`.
pub async fn unix_socket_patch<T: Serialize>(
    socket_path: &str,
    path: &str,
    body: &T,
) -> Result<()> {
    unix_socket_request(socket_path, "PATCH", path, Some(body)).await
}

/// Core HTTP-over-Unix-socket helper.
///
/// LINUX-ONLY: the `hyperlocal::UnixConnector` creates a Unix domain socket.
/// Fircracker's API is HTTP/1.1 over a UDS; responses are typically 204 No
/// Content on success and 4xx/5xx JSON on error.
async fn unix_socket_request<T: Serialize>(
    socket_path: &str,
    method: &str,
    path: &str,
    body: Option<&T>,
) -> Result<()> {
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;
    use hyper::Request;
    use hyper_util::client::legacy::Client;
    use hyper_util::rt::TokioExecutor;
    use hyperlocal::{UnixConnector, Uri as UnixUri};

    let uri = UnixUri::new(socket_path, path);

    let json_bytes = match body {
        Some(b) => serde_json::to_vec(b).context("failed to serialize request body")?,
        None => vec![],
    };

    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(Full::new(Bytes::from(json_bytes)))
        .context("failed to build HTTP request")?;

    // Build the client using the low-level builder API to avoid requiring the
    // `UnixClientExt` trait in scope (which triggers a spurious unused-import
    // warning on some Rust versions when only the trait method is called).
    let client: Client<UnixConnector, Full<Bytes>> =
        Client::builder(TokioExecutor::new()).build(UnixConnector);

    let response = client
        .request(req)
        .await
        .context("HTTP request to Firecracker API failed")?;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    // Collect the response body for a useful error message.
    let body_bytes = response
        .into_body()
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();
    let body_str = String::from_utf8_lossy(&body_bytes);

    bail!("Firecracker API {method} {path} returned HTTP {status}: {body_str}")
}

// ---------------------------------------------------------------------------
// Process management shims (Linux-only)
// ---------------------------------------------------------------------------

/// Configuration for spawning the `firecracker` binary.
#[derive(Debug)]
pub struct SpawnConfig {
    /// Path to the `firecracker` binary.
    pub binary_path: String,
    /// Path where the API Unix socket should be created.
    pub socket_path: String,
    /// Optional path to the jailer binary.  When set, `firecracker` is
    /// launched via `jailer` for stronger isolation (chroot + cgroup).
    pub jailer_path: Option<String>,
    /// Optional log level override (e.g. "Debug").
    pub log_level: Option<String>,
}

/// Spawn the Firecracker process and wait until the API socket is ready.
///
/// Returns the process `Child` handle, which the caller must keep alive for
/// the lifetime of the VM.  Dropping it would send SIGKILL.
///
/// LINUX-ONLY: `tokio::process::Command` is cross-platform, but the
/// `firecracker` binary and its `--api-sock` flag only work on Linux.
/// Integration-tested on a Linux host with a `vmlinux` kernel and rootfs.
///
/// NOTE: jailer integration (chroot, cgroup, UID mapping) is the next
/// hardening step; today this spawns the bare binary.  See ADR-0006 §Jailer.
pub async fn spawn_firecracker_process(cfg: &SpawnConfig) -> Result<tokio::process::Child> {
    use tokio::process::Command;

    // Ensure the socket directory exists.
    if let Some(parent) = Path::new(&cfg.socket_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create socket dir {:?}", parent))?;
    }

    let mut cmd = Command::new(&cfg.binary_path);
    cmd.arg("--api-sock").arg(&cfg.socket_path);

    if let Some(level) = &cfg.log_level {
        cmd.arg("--log-level").arg(level);
    }

    // Prevent the child from inheriting the parent's signal handlers.
    // LINUX-ONLY: `setsid` is a Unix concept; on non-Linux the build
    // would fail before reaching this line due to the availability gate.
    #[cfg(unix)]
    {
        #[allow(unused_imports)]
        use std::os::unix::process::CommandExt;
        // Safety: setsid() is async-signal-safe; we are in the pre_exec
        // closure which runs in the child after fork() and before exec().
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn firecracker at {}", cfg.binary_path))?;

    // Poll until the API socket appears (up to 2 seconds).
    // LINUX-ONLY: Unix domain socket path.
    wait_for_socket(&cfg.socket_path, Duration::from_secs(2)).await?;

    Ok(child)
}

/// Poll for the Unix socket to appear (indicates Firecracker is ready).
///
/// LINUX-ONLY: `Path::exists()` on a socket path is cross-platform but
/// the socket itself only appears after the Linux Firecracker process binds.
async fn wait_for_socket(socket_path: &str, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let p = Path::new(socket_path);
    while Instant::now() < deadline {
        if p.exists() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    bail!(
        "timed out waiting for Firecracker API socket at {socket_path} \
         (process may have failed to start)"
    )
}

/// Create a TAP network device and optionally attach it to a bridge.
///
/// LINUX-ONLY: requires `CAP_NET_ADMIN` or root.  The implementation
/// calls the `ip tuntap` and `ip link` commands rather than raw ioctl
/// to keep the code simple; production should replace with direct netlink
/// calls (rtnetlink crate) to avoid the fork overhead.
///
/// Integration-tested on a Linux host with `ip` from iproute2.
pub async fn setup_tap_device(tap_name: &str, bridge_name: Option<&str>) -> Result<()> {
    use tokio::process::Command;

    // Create the TAP device.
    let status = Command::new("ip")
        .args(["tuntap", "add", tap_name, "mode", "tap"])
        .status()
        .await
        .context("failed to run 'ip tuntap add'")?;
    if !status.success() {
        bail!("ip tuntap add {tap_name} mode tap failed: {status}");
    }

    // Bring the TAP interface up.
    let status = Command::new("ip")
        .args(["link", "set", tap_name, "up"])
        .status()
        .await
        .context("failed to run 'ip link set up'")?;
    if !status.success() {
        bail!("ip link set {tap_name} up failed: {status}");
    }

    // Attach to bridge if requested.
    if let Some(bridge) = bridge_name {
        let status = Command::new("ip")
            .args(["link", "set", tap_name, "master", bridge])
            .status()
            .await
            .context("failed to run 'ip link set master'")?;
        if !status.success() {
            bail!("ip link set {tap_name} master {bridge} failed: {status}");
        }
    }

    Ok(())
}

/// Delete a TAP device created by `setup_tap_device`.
///
/// LINUX-ONLY: same constraints as `setup_tap_device`.
pub async fn teardown_tap_device(tap_name: &str) -> Result<()> {
    use tokio::process::Command;

    let status = Command::new("ip")
        .args(["tuntap", "del", tap_name, "mode", "tap"])
        .status()
        .await
        .context("failed to run 'ip tuntap del'")?;
    if !status.success() {
        // Log but don't bail — teardown errors should not mask the primary error.
        tracing::warn!(tap_name, "ip tuntap del failed: {status}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-VM child-process table
//
// `boot_vm` spawns a `firecracker` child process per VM.  To make `cancel()`
// able to SIGKILL that process as a reliable fallback after a graceful
// `SendCtrlAltDel`, we have to keep the `Child` handle around keyed by vm_id.
//
// The table is generic over the stored value (`P`) so the insert / remove /
// cancel-selection logic is fully unit-testable with a lightweight stand-in
// process type — no real `tokio::process::Child` (and therefore no live
// Firecracker, no KVM) is needed to exercise the bookkeeping.  The live
// backend instantiates `ProcessTable<tokio::process::Child>`.
// ---------------------------------------------------------------------------

/// Anything the process table can SIGKILL.  Implemented for
/// `tokio::process::Child` (LINUX-ONLY in effect — only spawned on a real
/// node) and for test doubles.
pub trait Killable {
    /// Force-terminate the process (SIGKILL semantics).  Idempotent: killing
    /// an already-dead process must not be an error worth surfacing.
    fn force_kill(&mut self) -> Result<()>;
}

// LINUX-ONLY in effect: a `tokio::process::Child` for `firecracker` is only
// ever spawned after the `firecracker_available()` gate, i.e. on Linux + KVM.
// `start_kill` itself is cross-platform, which keeps this trait impl buildable
// (and the kill path therefore reasoned about) on the macOS dev host.
impl Killable for tokio::process::Child {
    fn force_kill(&mut self) -> Result<()> {
        // `start_kill` sends SIGKILL without awaiting reaping; the table drop
        // / explicit `wait` elsewhere reaps the zombie.  An "already exited"
        // error is benign — the goal (process gone) is met.
        match self.start_kill() {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
            Err(e) => Err(e).context("SIGKILL firecracker child"),
        }
    }
}

/// Thread-safe map of `vm_id -> child process handle`.
///
/// Cloning shares the same underlying table (`Arc`), so the backend can hand a
/// clone to the stream task while keeping one for the cancel path.
#[derive(Clone)]
pub struct ProcessTable<P> {
    inner: Arc<Mutex<HashMap<String, P>>>,
}

impl<P> Default for ProcessTable<P> {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl<P: Killable> ProcessTable<P> {
    /// Create an empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the child process for `vm_id`.  Returns the previous entry if one
    /// existed (a vm_id collision — should not happen with UUID ids, but the
    /// caller can log it).
    pub fn insert(&self, vm_id: &str, child: P) -> Option<P> {
        self.inner
            .lock()
            .expect("process table mutex poisoned")
            .insert(vm_id.to_string(), child)
    }

    /// Remove and return the child for `vm_id`, if present.
    pub fn remove(&self, vm_id: &str) -> Option<P> {
        self.inner
            .lock()
            .expect("process table mutex poisoned")
            .remove(vm_id)
    }

    /// Whether `vm_id` is currently tracked.
    pub fn contains(&self, vm_id: &str) -> bool {
        self.inner
            .lock()
            .expect("process table mutex poisoned")
            .contains_key(vm_id)
    }

    /// Number of tracked processes.
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("process table mutex poisoned")
            .len()
    }

    /// Whether the table is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Cancel-selection logic: look up `vm_id`, remove it, and SIGKILL it.
    ///
    /// Returns:
    /// - `Ok(true)` — a process was tracked and got the kill signal (the
    ///   fallback fired);
    /// - `Ok(false)` — no process was tracked for `vm_id` (already reaped, or
    ///   this manager never owned it: nothing to kill, not an error);
    /// - `Err(_)` — a process was tracked but the kill itself failed.
    ///
    /// The entry is always removed when present, even if the kill errors, so a
    /// retried cancel doesn't keep finding a doomed handle.
    pub fn kill(&self, vm_id: &str) -> Result<bool> {
        let mut child = match self.remove(vm_id) {
            Some(c) => c,
            None => return Ok(false),
        };
        child.force_kill()?;
        Ok(true)
    }
}

// ---------------------------------------------------------------------------
// vsock event-loop frame parsing
//
// The in-VM harness writes newline-delimited JSON `RuntimeEvent` frames to the
// host over vsock.  On the host the live loop (LINUX-ONLY) accepts a
// connection on a `UnixListener` bound to the vsock UDS path and reads bytes.
//
// The wire framing — splitting a byte stream into lines and decoding each
// non-empty line into a `RuntimeEvent` — is a PURE function so it is fully
// unit-tested without any socket, VM, or KVM.
// ---------------------------------------------------------------------------

/// Outcome of decoding one newline-delimited frame.
#[derive(Debug)]
pub enum FrameOutcome {
    /// A frame decoded into a `RuntimeEvent`.
    Event(RuntimeEvent),
    /// The line was blank (e.g. trailing newline) — skip it.
    Blank,
    /// The line was non-empty but failed to decode; carries the error string
    /// so the loop can log-and-continue rather than tearing down the stream on
    /// one malformed frame.
    Malformed(String),
}

/// Parse a single newline-delimited frame (without the trailing `\n`) into a
/// [`FrameOutcome`].
///
/// Pure — no I/O.  The harness emits `RuntimeEvent` in its `#[serde(tag =
/// "type")]` form, e.g. `{"type":"Log","level":"info","message":"..","timestamp":".."}`.
pub fn parse_vsock_frame(line: &str) -> FrameOutcome {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return FrameOutcome::Blank;
    }
    match serde_json::from_str::<RuntimeEvent>(trimmed) {
        Ok(ev) => FrameOutcome::Event(ev),
        Err(e) => FrameOutcome::Malformed(e.to_string()),
    }
}

/// Split a buffer into complete newline-delimited frames, returning the decoded
/// outcomes and any trailing partial line (no terminating `\n` yet) that the
/// caller must carry into the next read.
///
/// Pure — this is the byte-stream framing the live vsock loop relies on, made
/// testable in isolation.  A frame is only emitted once its terminating `\n`
/// has been seen, so a partial JSON object split across two `read()`s is never
/// mis-parsed as malformed.
pub fn drain_vsock_frames(buf: &str) -> (Vec<FrameOutcome>, String) {
    let mut outcomes = Vec::new();
    // Find the last newline; everything after it is an incomplete remainder.
    match buf.rfind('\n') {
        Some(idx) => {
            let complete = &buf[..idx]; // excludes the final '\n'
            let remainder = buf[idx + 1..].to_string();
            for line in complete.split('\n') {
                outcomes.push(parse_vsock_frame(line));
            }
            (outcomes, remainder)
        }
        None => {
            // No complete frame yet; the whole buffer is the remainder.
            (outcomes, buf.to_string())
        }
    }
}

/// Forward one drained batch of frames to the consumer channel.
///
/// Pure-ish glue between [`drain_vsock_frames`] and the mpsc sender, factored
/// out so the malformed-frame and channel-closed handling is exercised by the
/// live loop and reasoned about independently.  Returns `false` when the
/// receiver has been dropped (caller should stop reading).
async fn forward_frames(
    outcomes: Vec<FrameOutcome>,
    tx: &tokio::sync::mpsc::Sender<RuntimeEvent>,
) -> bool {
    for outcome in outcomes {
        match outcome {
            FrameOutcome::Event(ev) => {
                if tx.send(ev).await.is_err() {
                    return false; // consumer gone
                }
            }
            FrameOutcome::Blank => {}
            FrameOutcome::Malformed(err) => {
                // Log-and-continue: one bad frame must not tear down the stream.
                tracing::warn!(error = %err, "vsock: dropping malformed frame");
            }
        }
    }
    true
}

/// Live vsock event loop: bind a `UnixListener` on `vsock_path`, accept the
/// harness connection, and stream decoded `RuntimeEvent`s into `tx` until EOF.
///
/// The wire framing is delegated to the pure [`drain_vsock_frames`]; this
/// function owns only the socket/read I/O so the parsing stays unit-testable.
///
/// LINUX-ONLY: only reached after the `firecracker_available()` gate. The vsock
/// UDS path is created by Firecracker on a real Linux + KVM node; on the macOS
/// dev host this code is never executed (the `available` guard in `stream`
/// short-circuits before we get here).
async fn vsock_event_loop(
    vsock_path: &str,
    tx: &tokio::sync::mpsc::Sender<RuntimeEvent>,
) -> Result<()> {
    use tokio::io::AsyncReadExt;
    use tokio::net::UnixListener;

    // Firecracker connects to <uds_path>_<port> for guest-initiated streams; the
    // harness uses the base path. A stale socket file from a crashed prior run
    // would make bind() fail with EADDRINUSE, so clear it first (best effort).
    let _ = tokio::fs::remove_file(vsock_path).await;
    if let Some(parent) = Path::new(vsock_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create vsock dir {parent:?}"))?;
    }

    let listener =
        UnixListener::bind(vsock_path).with_context(|| format!("bind vsock UDS {vsock_path}"))?;

    let (mut conn, _addr) = listener
        .accept()
        .await
        .context("accept harness vsock connection")?;

    let mut read_buf = [0u8; 8192];
    let mut pending = String::new();

    loop {
        let n = conn
            .read(&mut read_buf)
            .await
            .context("read from harness vsock")?;
        if n == 0 {
            // EOF: harness closed the connection. Flush any complete trailing
            // frame (one without a terminating newline) before exiting.
            let trailing = parse_vsock_frame(&pending);
            if !forward_frames(vec![trailing], tx).await {
                return Ok(());
            }
            return Ok(());
        }

        pending.push_str(&String::from_utf8_lossy(&read_buf[..n]));
        let (outcomes, remainder) = drain_vsock_frames(&pending);
        pending = remainder;
        if !forward_frames(outcomes, tx).await {
            // Consumer dropped the receiver; stop reading.
            return Ok(());
        }
    }
}

// ---------------------------------------------------------------------------
// FirecrackerBackend
// ---------------------------------------------------------------------------

/// Firecracker microVM backend.
///
/// All methods fail-closed when Firecracker is not available (not Linux,
/// binary missing, or /dev/kvm absent).  The availability check runs once
/// at construction time so the per-call overhead is a single boolean read.
pub struct FirecrackerBackend {
    /// Path to the Linux kernel image for microVMs.
    /// Defaults to `/opt/lantern/vmlinux`; override with `FC_KERNEL_PATH`.
    kernel_image_path: String,
    /// Path to the root filesystem image.
    /// Defaults to `/opt/lantern/rootfs.ext4`; override with `FC_ROOTFS_PATH`.
    rootfs_path: String,
    /// Network bridge to attach TAP devices to.
    /// Defaults to `fcbridge0`; override with `FC_BRIDGE`.
    bridge_name: Option<String>,
    /// Whether Firecracker is available on this host (cached at construction).
    available: bool,
    /// Binary path (cached from the availability probe).
    binary_path: Option<String>,
    /// Per-VM `firecracker` child processes, keyed by vm_id, so `cancel()` can
    /// SIGKILL as a reliable fallback after `SendCtrlAltDel`.  Empty on hosts
    /// where the backend is unavailable (no VM is ever spawned there).
    processes: ProcessTable<tokio::process::Child>,
}

impl FirecrackerBackend {
    /// Create a new `FirecrackerBackend`.
    ///
    /// Performs the availability check once and caches the result.
    pub fn new() -> Self {
        let probe = AvailabilityProbe::from_env();
        let available = is_available_with_probe(&probe);

        let kernel_image_path =
            std::env::var("FC_KERNEL_PATH").unwrap_or_else(|_| "/opt/lantern/vmlinux".to_string());
        let rootfs_path = std::env::var("FC_ROOTFS_PATH")
            .unwrap_or_else(|_| "/opt/lantern/rootfs.ext4".to_string());
        let bridge_name = std::env::var("FC_BRIDGE").ok().filter(|s| !s.is_empty());
        let binary_path = probe.firecracker_binary_path;

        if available {
            tracing::info!(
                binary = ?binary_path,
                kernel = %kernel_image_path,
                rootfs = %rootfs_path,
                "Firecracker backend: available"
            );
        } else {
            tracing::info!(
                "Firecracker backend: not available on this host \
                 (requires Linux + firecracker binary + /dev/kvm). \
                 Hostile/Untrusted workloads will be refused."
            );
        }

        FirecrackerBackend {
            kernel_image_path,
            rootfs_path,
            bridge_name,
            available,
            binary_path,
            processes: ProcessTable::new(),
        }
    }

    /// Return the "not available" error used in all fail-closed paths.
    fn not_available_error() -> anyhow::Error {
        anyhow::anyhow!(
            "Firecracker microVM backend is not available on this host. \
             Requirements: Linux OS + 'firecracker' binary on PATH (or \
             FC_BINARY_PATH) + /dev/kvm readable. \
             Hostile/Untrusted workloads cannot run here."
        )
    }

    /// Configure and start a microVM from a `VmConfig`.
    ///
    /// Sequence:
    ///   1. Create TAP device (LINUX-ONLY)
    ///   2. Spawn `firecracker` process (LINUX-ONLY)
    ///   3. PUT /machine-config
    ///   4. PUT /boot-source
    ///   5. PUT /drives/rootfs
    ///   6. PUT /network-interfaces/eth0
    ///   7. PUT /vsock
    ///   8. PUT /actions  { action_type: "InstanceStart" }
    ///
    /// LINUX-ONLY: steps 1-2 and the actual HTTP calls require Linux + KVM.
    /// Integration-tested on a Linux host.
    async fn boot_vm(&self, cfg: &VmConfig) -> Result<()> {
        let binary = self
            .binary_path
            .as_deref()
            .ok_or_else(Self::not_available_error)?;

        // Step 0: provision the per-VM client cert (CN=vm_id, signed by the
        // manager CA) and write it to the paths the boot-args already
        // reference, so the in-VM harness can present it on the
        // harness↔manager mTLS channel. Issuance is cryptographic identity,
        // not topology — VendSecret rejects any cert whose CN != vm_id.
        provision_vm_cert(cfg)?;

        // Step 1: TAP device.
        // LINUX-ONLY: requires CAP_NET_ADMIN / root.
        setup_tap_device(&cfg.tap_dev, self.bridge_name.as_deref()).await?;

        // Step 2: Spawn the Firecracker process.
        // LINUX-ONLY: requires the firecracker binary and /dev/kvm.
        let spawn_cfg = SpawnConfig {
            binary_path: binary.to_string(),
            socket_path: cfg.socket_path.clone(),
            jailer_path: None, // jailer integration: ADR-0006 §Jailer
            log_level: Some("Info".to_string()),
        };
        // Store the Child handle in the per-VM process table keyed by vm_id so
        // `cancel()` can SIGKILL it as a reliable fallback after the graceful
        // SendCtrlAltDel (ADR-0006 §Lifecycle). The process otherwise runs
        // until SendCtrlAltDel or natural exit.
        let child = spawn_firecracker_process(&spawn_cfg).await?;
        if let Some(prev) = self.processes.insert(&cfg.vm_id, child) {
            // vm_ids are UUIDs, so a collision means a prior boot for the same
            // id never got reaped. Kill the stale handle defensively.
            let mut prev = prev;
            let _ = prev.force_kill();
            tracing::warn!(vm_id = %cfg.vm_id, "process table collision; killed stale child");
        }

        let sock = &cfg.socket_path;

        // Step 3: Machine config.
        unix_socket_put(sock, "/machine-config", &cfg.machine_config()).await?;

        // Step 4: Boot source.
        unix_socket_put(sock, "/boot-source", &cfg.boot_source()).await?;

        // Step 5: Root drive.
        unix_socket_put(sock, "/drives/rootfs", &cfg.root_drive()).await?;

        // Step 5b: Read-only cert drive — carries the per-VM mTLS material
        // provisioned in Step 0 so the in-guest harness can read the paths the
        // boot-args reference. LINUX-ONLY (block device attach on a live VM).
        unix_socket_put(sock, "/drives/certs", &cfg.cert_drive()).await?;

        // Step 6: Network interface.
        unix_socket_put(sock, "/network-interfaces/eth0", &cfg.network_interface()).await?;

        // Step 7: Vsock.
        unix_socket_put(sock, "/vsock", &cfg.vsock_device()).await?;

        // Step 8: InstanceStart.
        unix_socket_put(
            sock,
            "/actions",
            &InstanceAction {
                action_type: "InstanceStart".to_string(),
            },
        )
        .await?;

        Ok(())
    }
}

impl Default for FirecrackerBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl RuntimeBackend for FirecrackerBackend {
    /// Schedule (cold-boot) a new microVM.
    ///
    /// Fail-closed when Firecracker is not available.
    ///
    /// LINUX-ONLY (live path): TAP setup, process spawn, and all
    /// Firecracker API calls require Linux + /dev/kvm.
    /// Integration-tested on a Linux host.
    async fn schedule(&self, req: &ScheduleRequest) -> Result<Handle> {
        if !self.available {
            return Err(Self::not_available_error());
        }

        let start = Instant::now();
        let cfg = VmConfig::from_schedule(req, &self.kernel_image_path, &self.rootfs_path);
        let vm_id = cfg.vm_id.clone();

        tracing::info!(
            vm_id = %vm_id,
            run_id = %req.run_id,
            vcpus = cfg.vcpu_count,
            mem_mib = cfg.mem_size_mib,
            tap_dev = %cfg.tap_dev,
            // requires Linux + /dev/kvm; integration-tested on a Linux host
            "Firecracker: booting microVM (LINUX-ONLY)"
        );

        self.boot_vm(&cfg).await.with_context(|| {
            format!(
                "failed to boot Firecracker microVM {vm_id} for run {}",
                req.run_id
            )
        })?;

        let cold_start_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            vm_id = %vm_id,
            cold_start_ms,
            "Firecracker: microVM started"
        );

        Ok(Handle {
            id: vm_id,
            node_name: "firecracker-local".to_string(),
            cold_start_ms,
        })
    }

    /// Cancel a running microVM.
    ///
    /// Sends SendCtrlAltDel for a graceful ACPI shutdown; falls back to
    /// SIGKILL on the Firecracker process.
    ///
    /// LINUX-ONLY (live path): requires the VM to be running.
    /// Integration-tested on a Linux host.
    async fn cancel(&self, handle_id: &str, reason: &str) -> Result<()> {
        if !self.available {
            return Err(Self::not_available_error());
        }

        let socket_path = format!("/run/firecracker/{handle_id}.sock");

        tracing::info!(
            vm_id = handle_id,
            reason,
            // requires Linux + /dev/kvm; integration-tested on a Linux host
            "Firecracker: sending SendCtrlAltDel (LINUX-ONLY)"
        );

        // Graceful: SendCtrlAltDel triggers the guest's ACPI power-off.
        let result = unix_socket_put(
            &socket_path,
            "/actions",
            &InstanceAction {
                action_type: "SendCtrlAltDel".to_string(),
            },
        )
        .await;

        if let Err(e) = result {
            tracing::warn!(
                vm_id = handle_id,
                error = %e,
                "Firecracker: SendCtrlAltDel failed; VM may already be gone"
            );
        }

        // Reliable fallback: SIGKILL the firecracker child if we still own its
        // handle. ACPI shutdown can hang (no guest ACPI handler, wedged guest);
        // killing the host process tears the VM down unconditionally. A missing
        // entry (already exited / reaped) is fine — `kill` returns Ok(false).
        match self.processes.kill(handle_id) {
            Ok(true) => tracing::info!(
                vm_id = handle_id,
                "Firecracker: SIGKILL fallback fired on child process"
            ),
            Ok(false) => tracing::debug!(
                vm_id = handle_id,
                "Firecracker: no child handle tracked; nothing to SIGKILL"
            ),
            Err(e) => tracing::warn!(
                vm_id = handle_id,
                error = %e,
                "Firecracker: SIGKILL fallback failed"
            ),
        }

        // LINUX-ONLY: TAP cleanup.
        let tap_dev = format!("fc-{}", &handle_id[..8.min(handle_id.len())]);
        teardown_tap_device(&tap_dev).await?;

        Ok(())
    }

    /// Stream runtime events from a microVM.
    ///
    /// The in-VM harness writes newline-delimited JSON `RuntimeEvent` frames to
    /// the host over the vsock device (CID 3).  Firecracker surfaces the host
    /// side of that vsock as a `UnixListener` on the configured UDS path; this
    /// method binds that listener, accepts the harness connection, and runs the
    /// event loop in [`vsock_event_loop`].  The byte-stream framing itself lives
    /// in the pure, unit-tested [`drain_vsock_frames`] / [`parse_vsock_frame`].
    ///
    /// LINUX-ONLY (live loop): binding/accepting the vsock UDS and a running VM
    /// to talk to it require Linux + /dev/kvm; gated behind `self.available`.
    async fn stream(&self, handle_id: &str) -> Result<BoxStream<'static, RuntimeEvent>> {
        let vm_id = handle_id.to_string();
        let available = self.available;
        // Same convention as VmConfig::vsock_uds_path.
        let vsock_path = format!("/run/lantern/vsock/{vm_id}.sock");

        let (tx, rx) = tokio::sync::mpsc::channel::<RuntimeEvent>(256);

        tokio::spawn(async move {
            if !available {
                // Not running; signal a clean exit immediately.
                let _ = tx
                    .send(RuntimeEvent::Exited(RuntimeExited {
                        exit_code: 1,
                        error: "Firecracker not available on this host".to_string(),
                    }))
                    .await;
                return;
            }

            tracing::info!(
                vm_id = %vm_id,
                vsock = %vsock_path,
                // requires Linux; integration-tested on a Linux host
                "Firecracker: opening vsock event stream (LINUX-ONLY)"
            );

            // LINUX-ONLY: bind + accept + read loop over the vsock UDS.
            let result = vsock_event_loop(&vsock_path, &tx).await;

            // Whatever the loop's fate, terminate the stream so callers never
            // block forever. A loop error becomes a non-zero Exited frame; a
            // clean EOF (harness closed the connection) becomes Exited(0).
            let exit = match result {
                Ok(()) => RuntimeExited {
                    exit_code: 0,
                    error: String::new(),
                },
                Err(e) => RuntimeExited {
                    exit_code: 1,
                    error: format!("vsock event loop ended: {e}"),
                },
            };
            let _ = tx.send(RuntimeEvent::Exited(exit)).await;
        });

        Ok(Box::pin(ReceiverStream::new(rx)))
    }

    /// Create a snapshot of a running microVM.
    ///
    /// Sequence:
    ///   1. Pause the VM (PATCH /vm Paused)
    ///   2. PUT /snapshot/create
    ///   3. Resume the VM (PATCH /vm Resumed)
    ///
    /// LINUX-ONLY: requires a running VM.  Integration-tested on a Linux host.
    async fn snapshot(&self, req: &SnapshotRequest) -> Result<SnapshotInfo> {
        if !self.available {
            return Err(Self::not_available_error());
        }

        let socket_path = format!("/run/firecracker/{}.sock", req.handle_id);
        let snapshot_dir = format!("/run/lantern/snapshots/{}", req.handle_id);
        let snapshot_path = format!("{snapshot_dir}/snapshot");
        let mem_file_path = format!("{snapshot_dir}/mem");

        tracing::info!(
            vm_id = %req.handle_id,
            snapshot_dir = %snapshot_dir,
            // requires Linux; integration-tested on a Linux host
            "Firecracker: creating snapshot (LINUX-ONLY)"
        );

        // Pause before snapshotting.
        // LINUX-ONLY
        unix_socket_patch(
            &socket_path,
            "/vm",
            &VmState {
                state: "Paused".to_string(),
            },
        )
        .await
        .context("failed to pause VM before snapshot")?;

        // Create snapshot.
        // LINUX-ONLY
        unix_socket_put(
            &socket_path,
            "/snapshot/create",
            &SnapshotCreateParams {
                snapshot_type: "Full".to_string(),
                snapshot_path: snapshot_path.clone(),
                mem_file_path: mem_file_path.clone(),
            },
        )
        .await
        .context("failed to create snapshot")?;

        // Resume after snapshot.
        // LINUX-ONLY
        unix_socket_patch(
            &socket_path,
            "/vm",
            &VmState {
                state: "Resumed".to_string(),
            },
        )
        .await
        .context("failed to resume VM after snapshot")?;

        tracing::info!(
            vm_id = %req.handle_id,
            snapshot_path = %snapshot_path,
            "Firecracker: snapshot created"
        );

        Ok(SnapshotInfo {
            snapshot_uri: format!("fc://{snapshot_path}"),
            size_bytes: 0, // actual file size populated on Linux via metadata
        })
    }

    /// Restore a microVM from a snapshot.
    ///
    /// Sequence:
    ///   1. Spawn a fresh Firecracker process for the new VM id
    ///   2. PUT /snapshot/load
    ///
    /// LINUX-ONLY: requires Firecracker binary + /dev/kvm.
    /// Integration-tested on a Linux host.
    async fn restore(&self, snapshot_uri: &str, req: &RestoreRequest) -> Result<Handle> {
        if !self.available {
            return Err(Self::not_available_error());
        }

        let start = Instant::now();
        let vm_id = Uuid::new_v4().to_string();
        let socket_path = format!("/run/firecracker/{vm_id}.sock");

        let snapshot_path = snapshot_uri.strip_prefix("fc://").unwrap_or(snapshot_uri);
        let mem_file_path = snapshot_path.replace("/snapshot", "/mem");

        tracing::info!(
            vm_id = %vm_id,
            run_id = %req.run_id,
            snapshot_uri = snapshot_uri,
            // requires Linux + /dev/kvm; integration-tested on a Linux host
            "Firecracker: restoring from snapshot (LINUX-ONLY)"
        );

        let binary = self
            .binary_path
            .as_deref()
            .ok_or_else(Self::not_available_error)?;

        // Spawn fresh Firecracker process.
        // LINUX-ONLY
        let _child = spawn_firecracker_process(&SpawnConfig {
            binary_path: binary.to_string(),
            socket_path: socket_path.clone(),
            jailer_path: None,
            log_level: Some("Info".to_string()),
        })
        .await?;

        // Load snapshot.
        // LINUX-ONLY
        unix_socket_put(
            &socket_path,
            "/snapshot/load",
            &SnapshotLoadParams {
                snapshot_path: snapshot_path.to_string(),
                mem_backend: MemBackend {
                    backend_type: "File".to_string(),
                    backend_path: mem_file_path,
                },
                enable_diff_snapshots: Some(true),
                resume_vm: Some(true),
            },
        )
        .await
        .context("failed to load snapshot")?;

        let restore_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            vm_id = %vm_id,
            restore_ms,
            "Firecracker: microVM restored from snapshot"
        );

        Ok(Handle {
            id: vm_id,
            node_name: "firecracker-local".to_string(),
            cold_start_ms: restore_ms,
        })
    }

    fn name(&self) -> &'static str {
        "firecracker"
    }
}

// ---------------------------------------------------------------------------
// Unit tests
//
// Everything below runs on macOS without /dev/kvm.  The tests verify:
//   1. Request body serialization (exact JSON shapes match the FC API)
//   2. VmConfig derivation from ScheduleRequest (CPU/mem parsing + defaults)
//   3. Lifecycle state machine transitions
//   4. Availability detection logic (injectable probe)
//   5. boot_args construction and env injection
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{IsolationClass, ResourceLimits, ScheduleRequest};
    use std::collections::HashMap;

    // -----------------------------------------------------------------------
    // Helper builders
    // -----------------------------------------------------------------------

    fn minimal_schedule_req() -> ScheduleRequest {
        ScheduleRequest {
            run_id: "run-001".to_string(),
            bundle_uri: "s3://bucket/bundle.tar.gz".to_string(),
            bundle_digest: vec![],
            isolation_class: IsolationClass::Hostile,
            limits: ResourceLimits::default(),
            env: HashMap::new(),
            secrets: vec![],
            input: serde_json::Value::Null,
            command: vec![],
            args: vec![],
            image: "sha256:abc".to_string(),
            network_policy: crate::proto::NetworkPolicyClass::default(),
            egress_rules: vec![],
        }
    }

    fn req_with_limits(cpu: &str, memory: &str) -> ScheduleRequest {
        let mut req = minimal_schedule_req();
        req.limits.cpu = cpu.to_string();
        req.limits.memory = memory.to_string();
        req
    }

    // -----------------------------------------------------------------------
    // 1. JSON serialization — verify exact Firecracker API contract
    // -----------------------------------------------------------------------

    #[test]
    fn boot_source_serializes_without_initrd() {
        let b = BootSource {
            kernel_image_path: "/opt/vmlinux".to_string(),
            boot_args: "console=ttyS0".to_string(),
            initrd_path: None,
        };
        let json: serde_json::Value = serde_json::to_value(&b).unwrap();
        // initrd_path must be absent (skip_serializing_if)
        assert!(
            json.get("initrd_path").is_none(),
            "initrd_path should be absent when None"
        );
        assert_eq!(json["kernel_image_path"], "/opt/vmlinux");
        assert_eq!(json["boot_args"], "console=ttyS0");
    }

    #[test]
    fn boot_source_serializes_with_initrd() {
        let b = BootSource {
            kernel_image_path: "/opt/vmlinux".to_string(),
            boot_args: "console=ttyS0".to_string(),
            initrd_path: Some("/opt/initrd.img".to_string()),
        };
        let json: serde_json::Value = serde_json::to_value(&b).unwrap();
        assert_eq!(json["initrd_path"], "/opt/initrd.img");
    }

    #[test]
    fn drive_root_serializes_correctly() {
        let d = Drive {
            drive_id: "rootfs".to_string(),
            path_on_host: "/opt/rootfs.ext4".to_string(),
            is_root_device: true,
            is_read_only: false,
            partuuid: None,
            rate_limiter: None,
        };
        let json: serde_json::Value = serde_json::to_value(&d).unwrap();
        assert_eq!(json["drive_id"], "rootfs");
        assert_eq!(json["path_on_host"], "/opt/rootfs.ext4");
        assert_eq!(json["is_root_device"], true);
        assert_eq!(json["is_read_only"], false);
        assert!(
            json.get("partuuid").is_none(),
            "partuuid should be absent when None"
        );
        assert!(
            json.get("rate_limiter").is_none(),
            "rate_limiter should be absent when None"
        );
    }

    #[test]
    fn machine_config_serializes_correctly() {
        let mc = MachineConfig {
            vcpu_count: 2,
            mem_size_mib: 512,
            smt: Some(false),
            track_dirty_pages: Some(true),
        };
        let json: serde_json::Value = serde_json::to_value(&mc).unwrap();
        assert_eq!(json["vcpu_count"], 2);
        assert_eq!(json["mem_size_mib"], 512);
        assert_eq!(json["smt"], false);
        assert_eq!(json["track_dirty_pages"], true);
    }

    #[test]
    fn machine_config_optional_fields_omitted_when_none() {
        let mc = MachineConfig {
            vcpu_count: 1,
            mem_size_mib: 256,
            smt: None,
            track_dirty_pages: None,
        };
        let json: serde_json::Value = serde_json::to_value(&mc).unwrap();
        assert!(json.get("smt").is_none());
        assert!(json.get("track_dirty_pages").is_none());
    }

    #[test]
    fn network_interface_serializes_correctly() {
        let ni = NetworkInterface {
            iface_id: "eth0".to_string(),
            guest_mac: "02:ab:cd:ef:01:23".to_string(),
            host_dev_name: "fc-abcd1234".to_string(),
        };
        let json: serde_json::Value = serde_json::to_value(&ni).unwrap();
        assert_eq!(json["iface_id"], "eth0");
        assert_eq!(json["guest_mac"], "02:ab:cd:ef:01:23");
        assert_eq!(json["host_dev_name"], "fc-abcd1234");
    }

    #[test]
    fn vsock_device_serializes_correctly() {
        let v = VsockDevice {
            vsock_id: "lantern-vsock".to_string(),
            guest_cid: 3,
            uds_path: "/tmp/vsock.sock".to_string(),
        };
        let json: serde_json::Value = serde_json::to_value(&v).unwrap();
        assert_eq!(json["vsock_id"], "lantern-vsock");
        assert_eq!(json["guest_cid"], 3);
        assert_eq!(json["uds_path"], "/tmp/vsock.sock");
    }

    #[test]
    fn instance_action_start_serializes_correctly() {
        let a = InstanceAction {
            action_type: "InstanceStart".to_string(),
        };
        let json: serde_json::Value = serde_json::to_value(&a).unwrap();
        assert_eq!(json["action_type"], "InstanceStart");
        // Verify the exact JSON that Firecracker's InstanceStart expects.
        let expected = r#"{"action_type":"InstanceStart"}"#;
        assert_eq!(serde_json::to_string(&a).unwrap(), expected);
    }

    #[test]
    fn instance_action_send_ctrl_alt_del_serializes_correctly() {
        let a = InstanceAction {
            action_type: "SendCtrlAltDel".to_string(),
        };
        let json: serde_json::Value = serde_json::to_value(&a).unwrap();
        assert_eq!(json["action_type"], "SendCtrlAltDel");
    }

    #[test]
    fn vm_state_paused_serializes_correctly() {
        let s = VmState {
            state: "Paused".to_string(),
        };
        let json: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(json["state"], "Paused");
        let expected = r#"{"state":"Paused"}"#;
        assert_eq!(serde_json::to_string(&s).unwrap(), expected);
    }

    #[test]
    fn snapshot_create_params_serialize_correctly() {
        let p = SnapshotCreateParams {
            snapshot_type: "Full".to_string(),
            snapshot_path: "/snapshots/vm1/snap".to_string(),
            mem_file_path: "/snapshots/vm1/mem".to_string(),
        };
        let json: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert_eq!(json["snapshot_type"], "Full");
        assert_eq!(json["snapshot_path"], "/snapshots/vm1/snap");
        assert_eq!(json["mem_file_path"], "/snapshots/vm1/mem");
    }

    #[test]
    fn snapshot_load_params_serialize_correctly() {
        let p = SnapshotLoadParams {
            snapshot_path: "/snapshots/vm1/snap".to_string(),
            mem_backend: MemBackend {
                backend_type: "File".to_string(),
                backend_path: "/snapshots/vm1/mem".to_string(),
            },
            enable_diff_snapshots: Some(true),
            resume_vm: Some(true),
        };
        let json: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert_eq!(json["snapshot_path"], "/snapshots/vm1/snap");
        assert_eq!(json["mem_backend"]["backend_type"], "File");
        assert_eq!(json["mem_backend"]["backend_path"], "/snapshots/vm1/mem");
        assert_eq!(json["enable_diff_snapshots"], true);
        assert_eq!(json["resume_vm"], true);
    }

    #[test]
    fn snapshot_load_params_optional_fields_omitted() {
        let p = SnapshotLoadParams {
            snapshot_path: "/s/snap".to_string(),
            mem_backend: MemBackend {
                backend_type: "File".to_string(),
                backend_path: "/s/mem".to_string(),
            },
            enable_diff_snapshots: None,
            resume_vm: None,
        };
        let json: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert!(json.get("enable_diff_snapshots").is_none());
        assert!(json.get("resume_vm").is_none());
    }

    // -----------------------------------------------------------------------
    // 2. VmConfig derivation from ScheduleRequest
    // -----------------------------------------------------------------------

    #[test]
    fn vm_config_uses_default_cpu_when_empty() {
        let req = req_with_limits("", "");
        let cfg =
            VmConfig::from_schedule_with_id(&req, "/k", "/r", "aaaabbbbccccdddd0000111122223333");
        assert_eq!(cfg.vcpu_count, DEFAULT_VCPU);
        assert_eq!(cfg.mem_size_mib, DEFAULT_MEM_MIB);
    }

    #[test]
    fn vm_config_parses_integer_cpu() {
        let req = req_with_limits("4", "1024Mi");
        let cfg =
            VmConfig::from_schedule_with_id(&req, "/k", "/r", "aaaabbbbccccdddd0000111122223333");
        assert_eq!(cfg.vcpu_count, 4);
        assert_eq!(cfg.mem_size_mib, 1024);
    }

    #[test]
    fn vm_config_parses_millicpu() {
        // 500m → 1 vCPU (rounds up from 0.5)
        let req = req_with_limits("500m", "256Mi");
        let cfg =
            VmConfig::from_schedule_with_id(&req, "/k", "/r", "aaaabbbbccccdddd0000111122223333");
        assert_eq!(cfg.vcpu_count, 1);
        assert_eq!(cfg.mem_size_mib, 256);
    }

    #[test]
    fn vm_config_parses_2000m_cpu() {
        let req = req_with_limits("2000m", "512Mi");
        let cfg =
            VmConfig::from_schedule_with_id(&req, "/k", "/r", "aaaabbbbccccdddd0000111122223333");
        assert_eq!(cfg.vcpu_count, 2);
    }

    #[test]
    fn vm_config_parses_gi_memory() {
        let req = req_with_limits("2", "2Gi");
        let cfg =
            VmConfig::from_schedule_with_id(&req, "/k", "/r", "aaaabbbbccccdddd0000111122223333");
        assert_eq!(cfg.mem_size_mib, 2048);
    }

    #[test]
    fn vm_config_socket_path_includes_vm_id() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        assert_eq!(cfg.socket_path, format!("/run/firecracker/{vm_id}.sock"));
    }

    #[test]
    fn vm_config_tap_dev_is_8_char_prefix() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        assert_eq!(cfg.tap_dev, "fc-aaaabbbb");
    }

    #[test]
    fn vm_config_guest_mac_has_local_bit() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        // First octet is always "02" (locally administered, unicast)
        assert!(
            cfg.guest_mac.starts_with("02:"),
            "MAC must be locally-administered: {}",
            cfg.guest_mac
        );
    }

    #[test]
    fn vm_config_tls_paths_use_vm_id() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        assert!(cfg.tls_cert_path.contains(vm_id));
        assert!(cfg.tls_key_path.contains(vm_id));
        // Manager CA is shared across VMs.
        assert!(!cfg.manager_ca_path.contains(vm_id));
    }

    #[test]
    fn vm_config_machine_config_body() {
        let req = req_with_limits("4", "2Gi");
        let cfg =
            VmConfig::from_schedule_with_id(&req, "/k", "/r", "aaaabbbbccccdddd0000111122223333");
        let mc = cfg.machine_config();
        assert_eq!(mc.vcpu_count, 4);
        assert_eq!(mc.mem_size_mib, 2048);
        assert_eq!(mc.smt, Some(false));
        assert_eq!(mc.track_dirty_pages, Some(true));
    }

    #[test]
    fn vm_config_boot_source_body() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/opt/vmlinux", "/opt/rootfs.ext4", vm_id);
        let bs = cfg.boot_source();
        assert_eq!(bs.kernel_image_path, "/opt/vmlinux");
        assert!(bs.boot_args.contains(vm_id), "boot_args must contain vm_id");
        assert!(
            bs.boot_args.contains("run-001"),
            "boot_args must contain run_id"
        );
        assert!(
            bs.boot_args.contains("console=ttyS0"),
            "boot_args must include console"
        );
    }

    #[test]
    fn vm_config_root_drive_body() {
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(
            &req,
            "/k",
            "/opt/rootfs.ext4",
            "aaaabbbbccccdddd0000111122223333",
        );
        let d = cfg.root_drive();
        assert_eq!(d.drive_id, "rootfs");
        assert_eq!(d.path_on_host, "/opt/rootfs.ext4");
        assert!(d.is_root_device);
        assert!(!d.is_read_only);
    }

    #[test]
    fn vm_config_network_interface_body() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        let ni = cfg.network_interface();
        assert_eq!(ni.iface_id, "eth0");
        assert_eq!(ni.host_dev_name, cfg.tap_dev);
        assert_eq!(ni.guest_mac, cfg.guest_mac);
    }

    #[test]
    fn vm_config_vsock_body() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        let vs = cfg.vsock_device();
        assert_eq!(vs.guest_cid, 3);
        assert!(vs.uds_path.contains(vm_id));
    }

    // -----------------------------------------------------------------------
    // 3. CPU / memory parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parse_cpu_empty_returns_none() {
        assert_eq!(parse_cpu_limit(""), None);
    }

    #[test]
    fn parse_cpu_integer() {
        assert_eq!(parse_cpu_limit("4"), Some(4));
    }

    #[test]
    fn parse_cpu_millicores_rounding_up() {
        assert_eq!(parse_cpu_limit("100m"), Some(1)); // 0.1 → rounds up to 1
        assert_eq!(parse_cpu_limit("500m"), Some(1)); // 0.5 → rounds up to 1
        assert_eq!(parse_cpu_limit("999m"), Some(1)); // 0.999 → rounds up to 1
        assert_eq!(parse_cpu_limit("1000m"), Some(1));
        assert_eq!(parse_cpu_limit("2000m"), Some(2));
        assert_eq!(parse_cpu_limit("3500m"), Some(3));
    }

    #[test]
    fn parse_cpu_invalid_returns_none() {
        assert_eq!(parse_cpu_limit("bad"), None);
        assert_eq!(parse_cpu_limit("badm"), None);
    }

    #[test]
    fn parse_mem_empty_returns_none() {
        assert_eq!(parse_mem_limit(""), None);
    }

    #[test]
    fn parse_mem_mib() {
        assert_eq!(parse_mem_limit("256Mi"), Some(256));
        assert_eq!(parse_mem_limit("512Mi"), Some(512));
        assert_eq!(parse_mem_limit("1024Mi"), Some(1024));
    }

    #[test]
    fn parse_mem_gib() {
        assert_eq!(parse_mem_limit("1Gi"), Some(1024));
        assert_eq!(parse_mem_limit("2Gi"), Some(2048));
        assert_eq!(parse_mem_limit("4Gi"), Some(4096));
    }

    #[test]
    fn parse_mem_invalid_returns_none() {
        assert_eq!(parse_mem_limit("512"), None); // no unit
        assert_eq!(parse_mem_limit("badMi"), None);
    }

    // -----------------------------------------------------------------------
    // 4. Lifecycle state machine
    // -----------------------------------------------------------------------

    #[test]
    fn lifecycle_valid_transitions() {
        assert_eq!(
            transition(VmLifecycle::Configuring, VmLifecycle::Starting).unwrap(),
            VmLifecycle::Starting
        );
        assert_eq!(
            transition(VmLifecycle::Starting, VmLifecycle::Running).unwrap(),
            VmLifecycle::Running
        );
        assert_eq!(
            transition(VmLifecycle::Running, VmLifecycle::Paused).unwrap(),
            VmLifecycle::Paused
        );
        assert_eq!(
            transition(VmLifecycle::Paused, VmLifecycle::Running).unwrap(),
            VmLifecycle::Running
        );
        assert_eq!(
            transition(VmLifecycle::Running, VmLifecycle::ShuttingDown).unwrap(),
            VmLifecycle::ShuttingDown
        );
        assert_eq!(
            transition(VmLifecycle::ShuttingDown, VmLifecycle::Exited).unwrap(),
            VmLifecycle::Exited
        );
    }

    #[test]
    fn lifecycle_invalid_transition_returns_error() {
        // Can't go Running → Configuring
        assert!(transition(VmLifecycle::Running, VmLifecycle::Configuring).is_err());
        // Can't go Exited → Running
        assert!(transition(VmLifecycle::Exited, VmLifecycle::Running).is_err());
        // Can't go Configuring → Paused (must start first)
        assert!(transition(VmLifecycle::Configuring, VmLifecycle::Paused).is_err());
    }

    #[test]
    fn lifecycle_force_exit_from_any_state() {
        // Exited is reachable from any state (SIGKILL path).
        for state in [
            VmLifecycle::Configuring,
            VmLifecycle::Starting,
            VmLifecycle::Running,
            VmLifecycle::Paused,
            VmLifecycle::ShuttingDown,
        ] {
            assert_eq!(
                transition(state, VmLifecycle::Exited).unwrap(),
                VmLifecycle::Exited,
                "force-exit from {state:?} should be valid"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 5. Availability detection (injectable probe)
    // -----------------------------------------------------------------------

    #[test]
    fn available_when_all_conditions_met() {
        let probe = AvailabilityProbe {
            is_linux: true,
            firecracker_binary_path: Some("/usr/bin/firecracker".to_string()),
            kvm_readable: true,
        };
        assert!(is_available_with_probe(&probe));
    }

    #[test]
    fn unavailable_when_not_linux() {
        let probe = AvailabilityProbe {
            is_linux: false,
            firecracker_binary_path: Some("/usr/bin/firecracker".to_string()),
            kvm_readable: true,
        };
        assert!(!is_available_with_probe(&probe));
    }

    #[test]
    fn unavailable_when_binary_missing() {
        let probe = AvailabilityProbe {
            is_linux: true,
            firecracker_binary_path: None,
            kvm_readable: true,
        };
        assert!(!is_available_with_probe(&probe));
    }

    #[test]
    fn unavailable_when_kvm_not_readable() {
        let probe = AvailabilityProbe {
            is_linux: true,
            firecracker_binary_path: Some("/usr/bin/firecracker".to_string()),
            kvm_readable: false,
        };
        assert!(!is_available_with_probe(&probe));
    }

    #[test]
    fn unavailable_when_all_missing() {
        let probe = AvailabilityProbe {
            is_linux: false,
            firecracker_binary_path: None,
            kvm_readable: false,
        };
        assert!(!is_available_with_probe(&probe));
    }

    // On the macOS dev host this MUST return false (no /dev/kvm).
    #[test]
    fn firecracker_not_available_on_macos() {
        #[cfg(target_os = "macos")]
        assert!(
            !firecracker_available(),
            "must not claim available on macOS"
        );
    }

    // -----------------------------------------------------------------------
    // 6. boot_args construction
    // -----------------------------------------------------------------------

    #[test]
    fn boot_args_contains_required_fields() {
        let req = minimal_schedule_req();
        let args = build_boot_args(
            "vm-123",
            "run-456",
            "/certs/vm-123/tls.crt",
            "/certs/vm-123/tls.key",
            "/certs/manager-ca.crt",
            &req,
        );
        assert!(args.contains("console=ttyS0"));
        assert!(args.contains("lantern.vm_id=vm-123"));
        assert!(args.contains("lantern.run_id=run-456"));
        assert!(args.contains("lantern.tls_cert=/certs/vm-123/tls.crt"));
        assert!(args.contains("lantern.tls_key=/certs/vm-123/tls.key"));
        assert!(args.contains("lantern.manager_ca=/certs/manager-ca.crt"));
    }

    #[test]
    fn boot_args_injects_env_vars() {
        let mut req = minimal_schedule_req();
        req.env
            .insert("LANTERN_TENANT_ID".to_string(), "t-999".to_string());
        let args = build_boot_args("vm-1", "run-1", "/c", "/k", "/ca", &req);
        assert!(
            args.contains("lantern.env.LANTERN_TENANT_ID=t-999"),
            "env var must appear in boot args: {args}"
        );
    }

    #[test]
    fn boot_args_sanitizes_spaces_in_env_values() {
        let mut req = minimal_schedule_req();
        req.env
            .insert("MY_VAR".to_string(), "value with spaces".to_string());
        let args = build_boot_args("vm-1", "run-1", "/c", "/k", "/ca", &req);
        // Spaces replaced with underscores so the kernel cmdline isn't split.
        assert!(
            !args.contains("value with spaces"),
            "raw spaces must be sanitized"
        );
        assert!(
            args.contains("lantern.env.MY_VAR=value_with_spaces"),
            "sanitized value must appear: {args}"
        );
    }

    // -----------------------------------------------------------------------
    // 7. FirecrackerBackend: fail-closed on unavailable host
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn schedule_fails_closed_when_unavailable() {
        let mut backend = FirecrackerBackend::new();
        backend.available = false; // simulate no KVM

        let req = minimal_schedule_req();
        let err = backend.schedule(&req).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not available"),
            "error must mention 'not available': {msg}"
        );
    }

    #[tokio::test]
    async fn cancel_fails_closed_when_unavailable() {
        let mut backend = FirecrackerBackend::new();
        backend.available = false;

        let err = backend.cancel("vm-123", "test").await.unwrap_err();
        assert!(err.to_string().contains("not available"));
    }

    #[tokio::test]
    async fn snapshot_fails_closed_when_unavailable() {
        let mut backend = FirecrackerBackend::new();
        backend.available = false;

        let req = crate::proto::SnapshotRequest {
            handle_id: "vm-1".to_string(),
            bundle_digest: vec![],
            isolation_class: IsolationClass::Hostile,
        };
        let err = backend.snapshot(&req).await.unwrap_err();
        assert!(err.to_string().contains("not available"));
    }

    #[tokio::test]
    async fn restore_fails_closed_when_unavailable() {
        let mut backend = FirecrackerBackend::new();
        backend.available = false;

        let req = crate::proto::RestoreRequest {
            snapshot_uri: "fc:///snap".to_string(),
            run_id: "run-1".to_string(),
            input: serde_json::Value::Null,
            env: HashMap::new(),
            secrets: vec![],
        };
        let err = backend.restore("fc:///snap", &req).await.unwrap_err();
        assert!(err.to_string().contains("not available"));
    }

    #[tokio::test]
    async fn stream_unavailable_emits_exit_event() {
        use futures::StreamExt;

        let mut backend = FirecrackerBackend::new();
        backend.available = false;

        let mut stream = backend.stream("vm-123").await.unwrap();
        let event = stream.next().await.unwrap();
        assert!(
            matches!(
                event,
                RuntimeEvent::Exited(RuntimeExited { exit_code: 1, .. })
            ),
            "unavailable stream must emit Exited(1)"
        );
    }

    #[test]
    fn backend_name_is_firecracker() {
        let backend = FirecrackerBackend::new();
        assert_eq!(backend.name(), "firecracker");
    }

    // -----------------------------------------------------------------------
    // 8. Per-VM process table (insert / remove / cancel-selection)
    //
    // A lightweight `Killable` test double stands in for tokio::process::Child
    // so the bookkeeping + kill-selection logic runs with no real process,
    // no firecracker, no KVM.
    // -----------------------------------------------------------------------

    /// Test double: records how many times it was killed and whether the kill
    /// should fail, shared via Arc so the table can take ownership while the
    /// test still observes the effect.
    #[derive(Clone)]
    struct FakeChild {
        kills: Arc<std::sync::atomic::AtomicUsize>,
        fail: bool,
    }

    impl FakeChild {
        fn new() -> Self {
            Self {
                kills: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                fail: false,
            }
        }
        fn failing() -> Self {
            Self {
                kills: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                fail: true,
            }
        }
        fn kill_count(&self) -> usize {
            self.kills.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Killable for FakeChild {
        fn force_kill(&mut self) -> Result<()> {
            self.kills.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail {
                bail!("simulated kill failure")
            }
            Ok(())
        }
    }

    #[test]
    fn process_table_insert_and_remove() {
        let table: ProcessTable<FakeChild> = ProcessTable::new();
        assert!(table.is_empty());

        let child = FakeChild::new();
        assert!(table.insert("vm-a", child.clone()).is_none());
        assert_eq!(table.len(), 1);
        assert!(table.contains("vm-a"));
        assert!(!table.contains("vm-b"));

        let removed = table.remove("vm-a");
        assert!(removed.is_some());
        assert!(table.is_empty());
        assert!(!table.contains("vm-a"));
    }

    #[test]
    fn process_table_insert_returns_previous_on_collision() {
        let table: ProcessTable<FakeChild> = ProcessTable::new();
        let first = FakeChild::new();
        let second = FakeChild::new();
        assert!(table.insert("vm-a", first).is_none());
        // Second insert for the same id returns the prior handle.
        assert!(table.insert("vm-a", second).is_some());
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn process_table_kill_selects_and_removes_tracked_vm() {
        let table: ProcessTable<FakeChild> = ProcessTable::new();
        let child = FakeChild::new();
        let observer = child.clone();
        table.insert("vm-kill", child);

        // kill returns Ok(true): a tracked process got the signal.
        assert!(table.kill("vm-kill").unwrap());
        assert_eq!(observer.kill_count(), 1, "child must be SIGKILLed once");
        // Entry is removed so a retried cancel finds nothing.
        assert!(!table.contains("vm-kill"));
    }

    #[test]
    fn process_table_kill_unknown_vm_is_ok_false() {
        let table: ProcessTable<FakeChild> = ProcessTable::new();
        // No process tracked: not an error, just "nothing to kill".
        assert!(!table.kill("ghost-vm").unwrap());
    }

    #[test]
    fn process_table_kill_removes_entry_even_when_kill_errors() {
        let table: ProcessTable<FakeChild> = ProcessTable::new();
        let child = FakeChild::failing();
        let observer = child.clone();
        table.insert("vm-bad", child);

        let err = table.kill("vm-bad").unwrap_err();
        assert!(err.to_string().contains("simulated kill failure"));
        assert_eq!(observer.kill_count(), 1);
        // The doomed handle is gone regardless so a retry doesn't re-find it.
        assert!(
            !table.contains("vm-bad"),
            "entry must be removed even when the kill fails"
        );
    }

    #[test]
    fn process_table_clone_shares_state() {
        let table: ProcessTable<FakeChild> = ProcessTable::new();
        let clone = table.clone();
        table.insert("vm-shared", FakeChild::new());
        // The clone sees the same underlying map.
        assert!(clone.contains("vm-shared"));
        assert!(clone.kill("vm-shared").unwrap());
        assert!(!table.contains("vm-shared"));
    }

    // -----------------------------------------------------------------------
    // 9. Cert drive wiring (Identity phase → rootfs mounting)
    // -----------------------------------------------------------------------

    #[test]
    fn vm_config_cert_image_path_uses_vm_id() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        assert!(cfg.certs_image_path.contains(vm_id));
        assert!(cfg.certs_image_path.ends_with("certs.img"));
    }

    #[test]
    fn cert_drive_is_read_only_non_root() {
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        let d = cfg.cert_drive();
        assert_eq!(d.drive_id, "certs");
        assert_eq!(d.path_on_host, cfg.certs_image_path);
        assert!(d.is_read_only, "cert drive must be read-only");
        assert!(!d.is_root_device, "cert drive must not be the root device");
    }

    #[test]
    fn cert_drive_path_matches_boot_args_vm_id() {
        // The in-guest cert paths in boot_args and the cert image attached as a
        // drive must agree on the vm_id, or the harness reads the wrong certs.
        let vm_id = "aaaabbbbccccdddd0000111122223333";
        let req = minimal_schedule_req();
        let cfg = VmConfig::from_schedule_with_id(&req, "/k", "/r", vm_id);
        assert!(cfg.boot_args.contains(vm_id));
        assert!(cfg.tls_cert_path.contains(vm_id));
        assert!(cfg.cert_drive().path_on_host.contains(vm_id));
    }

    // -----------------------------------------------------------------------
    // 10. vsock frame parsing (pure, unit-tested without a socket)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_vsock_frame_decodes_log_event() {
        let line =
            r#"{"type":"Log","level":"info","message":"hi","timestamp":"2026-01-01T00:00:00Z"}"#;
        match parse_vsock_frame(line) {
            FrameOutcome::Event(RuntimeEvent::Log(l)) => {
                assert_eq!(l.level, "info");
                assert_eq!(l.message, "hi");
            }
            other => panic!("expected Log event, got {other:?}"),
        }
    }

    #[test]
    fn parse_vsock_frame_decodes_exited_event() {
        let line = r#"{"type":"Exited","exit_code":42,"error":"boom"}"#;
        match parse_vsock_frame(line) {
            FrameOutcome::Event(RuntimeEvent::Exited(e)) => {
                assert_eq!(e.exit_code, 42);
                assert_eq!(e.error, "boom");
            }
            other => panic!("expected Exited event, got {other:?}"),
        }
    }

    #[test]
    fn parse_vsock_frame_blank_line_is_skipped() {
        assert!(matches!(parse_vsock_frame(""), FrameOutcome::Blank));
        assert!(matches!(parse_vsock_frame("   "), FrameOutcome::Blank));
        assert!(matches!(parse_vsock_frame("\t"), FrameOutcome::Blank));
    }

    #[test]
    fn parse_vsock_frame_malformed_json_is_reported_not_fatal() {
        match parse_vsock_frame("{not valid json") {
            FrameOutcome::Malformed(e) => assert!(!e.is_empty()),
            other => panic!("expected Malformed, got {other:?}"),
        }
        // Valid JSON but unknown variant tag is also malformed (not a panic).
        assert!(matches!(
            parse_vsock_frame(r#"{"type":"Nope"}"#),
            FrameOutcome::Malformed(_)
        ));
    }

    #[test]
    fn drain_vsock_frames_splits_complete_lines_and_keeps_remainder() {
        let buf = concat!(
            r#"{"type":"Log","level":"info","message":"a","timestamp":"t"}"#,
            "\n",
            r#"{"type":"Log","level":"info","message":"b","timestamp":"t"}"#,
            "\n",
            r#"{"type":"Log","level":"info","message":"partial"#, // no closing + no newline
        );
        let (outcomes, remainder) = drain_vsock_frames(buf);
        assert_eq!(outcomes.len(), 2, "two complete frames");
        for o in &outcomes {
            assert!(matches!(o, FrameOutcome::Event(RuntimeEvent::Log(_))));
        }
        // The partial trailing line (no terminating newline) is carried over.
        assert!(remainder.contains("partial"));
    }

    #[test]
    fn drain_vsock_frames_no_newline_buffers_whole_input() {
        let buf = r#"{"type":"Log","level":"info"#; // incomplete, no newline
        let (outcomes, remainder) = drain_vsock_frames(buf);
        assert!(outcomes.is_empty(), "no complete frame yet");
        assert_eq!(remainder, buf, "entire buffer carried over");
    }

    #[test]
    fn drain_vsock_frames_partial_then_completed_across_reads() {
        // Simulate a JSON object split across two read() calls.
        let part1 = r#"{"type":"Exited","exit_"#;
        let (out1, rem1) = drain_vsock_frames(part1);
        assert!(out1.is_empty());
        assert_eq!(rem1, part1);

        // Next read brings the rest plus the terminating newline.
        let combined = format!("{rem1}{}", "code\":7,\"error\":\"\"}\n");
        let (out2, rem2) = drain_vsock_frames(&combined);
        assert_eq!(out2.len(), 1);
        assert!(matches!(
            &out2[0],
            FrameOutcome::Event(RuntimeEvent::Exited(e)) if e.exit_code == 7
        ));
        assert!(rem2.is_empty(), "remainder consumed once frame completed");
    }

    #[test]
    fn drain_vsock_frames_blank_line_between_events() {
        let buf = concat!(
            r#"{"type":"Log","level":"info","message":"a","timestamp":"t"}"#,
            "\n",
            "\n", // blank line
            r#"{"type":"Log","level":"info","message":"b","timestamp":"t"}"#,
            "\n",
        );
        let (outcomes, remainder) = drain_vsock_frames(buf);
        assert_eq!(outcomes.len(), 3, "two events + one blank");
        assert!(remainder.is_empty());
        let events = outcomes
            .iter()
            .filter(|o| matches!(o, FrameOutcome::Event(_)))
            .count();
        let blanks = outcomes
            .iter()
            .filter(|o| matches!(o, FrameOutcome::Blank))
            .count();
        assert_eq!(events, 2);
        assert_eq!(blanks, 1);
    }

    #[tokio::test]
    async fn forward_frames_sends_events_and_skips_blank_and_malformed() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<RuntimeEvent>(8);
        let outcomes = vec![
            FrameOutcome::Event(RuntimeEvent::Log(crate::proto::LogLine {
                level: "info".to_string(),
                message: "x".to_string(),
                timestamp: "t".to_string(),
            })),
            FrameOutcome::Blank,
            FrameOutcome::Malformed("bad".to_string()),
            FrameOutcome::Event(RuntimeEvent::Exited(RuntimeExited {
                exit_code: 0,
                error: String::new(),
            })),
        ];
        let ok = forward_frames(outcomes, &tx).await;
        assert!(ok, "receiver still open");
        drop(tx);

        let mut got = Vec::new();
        while let Some(ev) = rx.recv().await {
            got.push(ev);
        }
        // Only the two real events are forwarded; blank + malformed dropped.
        assert_eq!(got.len(), 2);
        assert!(matches!(got[0], RuntimeEvent::Log(_)));
        assert!(matches!(got[1], RuntimeEvent::Exited(_)));
    }

    #[tokio::test]
    async fn forward_frames_reports_closed_consumer() {
        let (tx, rx) = tokio::sync::mpsc::channel::<RuntimeEvent>(1);
        drop(rx); // consumer gone before we send
        let outcomes = vec![FrameOutcome::Event(RuntimeEvent::Exited(RuntimeExited {
            exit_code: 0,
            error: String::new(),
        }))];
        let ok = forward_frames(outcomes, &tx).await;
        assert!(!ok, "must report the receiver is gone so the loop can stop");
    }
}
