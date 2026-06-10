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
//!   `--api-sock` — or, when `FIRECRACKER_JAILER_PATH` is set, the `jailer`
//!   binary (chroot + uid/gid drop; ADR-0006 §Jailer).  Argv/path
//!   construction is pure and unit-tested; the jailed launch itself is
//!   validated by the microvm integration CI (KVM runner / Lima).
//! - `setup_tap_device`: creates a TAP device and attaches it to a bridge.
//!   Marked `// LINUX-ONLY: requires root / CAP_NET_ADMIN`.
//! - The `schedule()` / `cancel()` / `restore()` live paths after the
//!   `firecracker_available()` gate.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
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

    // Pack the loose PEM files into the read-only ext4 image the guest mounts as
    // the `certs` drive. Without this the `PUT /drives/certs` API call fails with
    // "No such file or directory" and the VM never boots.
    build_cert_image(&cfg.certs_image_path, &paths)
        .with_context(|| format!("build certs.img for vm '{}'", cfg.vm_id))?;

    tracing::info!(
        vm_id = %cfg.vm_id,
        cert = %paths.cert_path.display(),
        image = %cfg.certs_image_path,
        "provisioned per-VM client cert (CN=vm_id) + packed cert image"
    );
    Ok(())
}

/// Build the `mke2fs` argv that packs `src_dir` into a small ext4 image at
/// `image_path`. Pure — unit-tested without mke2fs. `-d` populates the
/// filesystem from a directory with NO loop mount and NO root; `size_kb`
/// 1 KiB-blocks are allocated (PEM material is a few KB, 1 MiB is ample).
#[must_use]
fn build_mke2fs_argv(image_path: &str, src_dir: &str, size_kb: u32) -> Vec<String> {
    vec![
        "-t".to_string(),
        "ext4".to_string(),
        "-F".to_string(), // operate on a plain file, not a block device
        "-q".to_string(), // quiet
        "-b".to_string(),
        "1024".to_string(),
        "-d".to_string(),
        src_dir.to_string(), // populate the fs from this directory
        image_path.to_string(),
        size_kb.to_string(),
    ]
}

/// Pack the per-VM cert material (`tls.crt`, `tls.key`, `manager-ca.crt`) into
/// the read-only `certs.img` ext4 image the guest harness mounts.
///
/// LINUX-ONLY: shells out to `mke2fs` (e2fsprogs) with `-d`, which builds and
/// populates an ext4 image from a directory without root or a loop mount. The
/// Firecracker path is already Linux+KVM gated, so the dependency is safe here.
fn build_cert_image(image_path: &str, paths: &crate::tls::VmCertPaths) -> Result<()> {
    use std::path::Path;

    let parent = Path::new(image_path)
        .parent()
        .ok_or_else(|| anyhow::anyhow!("malformed certs image path {image_path:?}"))?;
    let staging = parent.join("img-src");
    std::fs::create_dir_all(&staging)
        .with_context(|| format!("create cert image staging dir {staging:?}"))?;

    // Names the guest expects at the mount root.
    for (src, name) in [
        (&paths.cert_path, "tls.crt"),
        (&paths.key_path, "tls.key"),
        (&paths.ca_path, "manager-ca.crt"),
    ] {
        std::fs::copy(src, staging.join(name))
            .with_context(|| format!("stage {name} into certs.img source dir"))?;
    }

    let argv = build_mke2fs_argv(image_path, &staging.to_string_lossy(), 1024);
    let output = std::process::Command::new("mke2fs")
        .args(&argv)
        .output()
        .context("run mke2fs to build certs.img (is e2fsprogs installed?)")?;
    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "mke2fs failed building {image_path}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
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
    use hyper::Request;
    use hyper::body::Bytes;
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
// Jailer configuration (ADR-0006 §Jailer)
//
// Production hardening for the Firecracker launch: when enabled, the VM
// process is started via the `jailer` binary, which chroots `firecracker`
// under `<chroot_base>/<exec_basename>/<vm_id>/root/`, drops to an
// unprivileged uid/gid, and execs firecracker inside the jail.  Because the
// process is chrooted, every path Firecracker itself opens (API socket,
// kernel, drives, vsock UDS, snapshots) resolves INSIDE the jail; the
// manager stages artifacts in and translates paths back out.
//
// All argv/path construction below is pure and unit-tested on any platform.
// The live jailed launch is LINUX-ONLY and validated by the microvm
// integration CI (KVM runner / Lima), NOT unit-exec-tested.
// ---------------------------------------------------------------------------

/// Default uid the jailer drops `firecracker` to when `FIRECRACKER_JAILER_UID`
/// is unset.  123:100 is the unprivileged identity used throughout the
/// upstream Firecracker jailer documentation; non-root by construction.
pub const DEFAULT_JAILER_UID: u32 = 123;
/// Default gid (see [`DEFAULT_JAILER_UID`]).
pub const DEFAULT_JAILER_GID: u32 = 100;
/// Default chroot base directory when `FIRECRACKER_CHROOT_BASE` is unset.
pub const DEFAULT_CHROOT_BASE: &str = "/srv/jailer";
/// In-jail API socket path.  Matches the jailer's documented default
/// location (`<jail root>/run/firecracker.socket`); passed explicitly after
/// `--` so the contract does not depend on binary defaults.
pub const JAILED_API_SOCKET: &str = "/run/firecracker.socket";

/// Jailer launch parameters, read once from the environment at backend
/// construction.  `None` (env unset) preserves the bare-`firecracker`
/// launch path exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JailerConfig {
    /// Path to the `jailer` binary (`FIRECRACKER_JAILER_PATH`).
    pub jailer_binary_path: String,
    /// Uid the jail drops to (`FIRECRACKER_JAILER_UID`, default 123).
    pub uid: u32,
    /// Gid the jail drops to (`FIRECRACKER_JAILER_GID`, default 100).
    pub gid: u32,
    /// Chroot base directory (`FIRECRACKER_CHROOT_BASE`, default `/srv/jailer`).
    pub chroot_base_dir: String,
}

impl JailerConfig {
    /// Read the jailer configuration from the environment.
    ///
    /// Jailing is enabled if and only if `FIRECRACKER_JAILER_PATH` is set to
    /// a non-empty value — the default (unset) keeps today's bare launch.
    pub fn from_env() -> Option<Self> {
        Self::from_parts(
            std::env::var("FIRECRACKER_JAILER_PATH")
                .ok()
                .filter(|s| !s.is_empty())
                .as_deref(),
            std::env::var("FIRECRACKER_JAILER_UID").ok().as_deref(),
            std::env::var("FIRECRACKER_JAILER_GID").ok().as_deref(),
            std::env::var("FIRECRACKER_CHROOT_BASE").ok().as_deref(),
        )
    }

    /// Derive the config from raw env-shaped inputs.  Injectable for unit
    /// tests (same pattern as [`AvailabilityProbe`]) — no filesystem or env
    /// access.
    ///
    /// `None`/empty `jailer_path` disables jailing.  An unparseable or `0`
    /// uid/gid falls back to the non-root default (123:100), never to root.
    pub fn from_parts(
        jailer_path: Option<&str>,
        uid: Option<&str>,
        gid: Option<&str>,
        chroot_base: Option<&str>,
    ) -> Option<Self> {
        let jailer_binary_path = jailer_path.filter(|p| !p.is_empty())?.to_string();
        Some(JailerConfig {
            jailer_binary_path,
            uid: parse_jail_id(uid, DEFAULT_JAILER_UID, "FIRECRACKER_JAILER_UID"),
            gid: parse_jail_id(gid, DEFAULT_JAILER_GID, "FIRECRACKER_JAILER_GID"),
            chroot_base_dir: chroot_base
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_CHROOT_BASE)
                .to_string(),
        })
    }

    /// Host path of the per-VM jail directory the jailer creates:
    /// `<chroot_base>/<exec_file_basename>/<vm_id>`.
    #[must_use]
    pub fn jail_dir(&self, fc_binary_path: &str, vm_id: &str) -> String {
        let exec_name = Path::new(fc_binary_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("firecracker");
        format!(
            "{}/{exec_name}/{vm_id}",
            self.chroot_base_dir.trim_end_matches('/')
        )
    }

    /// Host path of the jail's chroot root (`<jail_dir>/root`) — the `/` the
    /// chrooted firecracker process sees.
    #[must_use]
    pub fn chroot_root(&self, fc_binary_path: &str, vm_id: &str) -> String {
        format!("{}/root", self.jail_dir(fc_binary_path, vm_id))
    }

    /// Host-visible path of the jailed VM's API socket.
    #[must_use]
    pub fn host_api_socket_path(&self, fc_binary_path: &str, vm_id: &str) -> String {
        self.host_path(fc_binary_path, vm_id, JAILED_API_SOCKET)
    }

    /// Map an in-jail absolute path to its host-visible location under the
    /// chroot root.
    #[must_use]
    pub fn host_path(&self, fc_binary_path: &str, vm_id: &str, in_jail_path: &str) -> String {
        format!("{}{in_jail_path}", self.chroot_root(fc_binary_path, vm_id))
    }
}

/// Parse a uid/gid env value, falling back to the non-root default on
/// missing, unparseable, or `0` (root would defeat the jail's purpose).
fn parse_jail_id(raw: Option<&str>, default: u32, var_name: &str) -> u32 {
    match raw {
        None => default,
        Some(s) => match s.trim().parse::<u32>() {
            Ok(v) if v != 0 => v,
            Ok(_) | Err(_) => {
                tracing::warn!(
                    var = var_name,
                    value = s,
                    fallback = default,
                    "invalid jailer uid/gid (must be a non-zero u32); using default"
                );
                default
            }
        },
    }
}

/// Build the firecracker-level argv (everything after the program name).
/// Shared by the bare and jailed launch paths.  Pure.
///
/// Firecracker has no `--log-level` flag — log level is only configurable
/// alongside `--log-path` (a file/FIFO) or via the `PUT /logger` API. With
/// neither set, Firecracker logs to stderr, which the manager already captures
/// from the child process. So the only CLI arg we pass is `--api-sock`; passing
/// a bogus `--log-level` makes Firecracker exit 153 ("Found argument 'log-level'
/// which wasn't expected"), which is what broke the live boot before this fix.
#[must_use]
pub fn build_firecracker_argv(api_socket_path: &str) -> Vec<String> {
    vec!["--api-sock".to_string(), api_socket_path.to_string()]
}

/// Build the jailer argv: jail identity flags, then `--`, then the
/// firecracker args to exec inside the jail.  Pure — unit-tested without a
/// jailer binary or Linux.
///
/// Cgroup flags are intentionally omitted: the jailer only needs them when
/// imposing cgroup limits, and resource limits are already enforced via the
/// Firecracker machine-config (vcpu/mem).  Cgroup confinement is a
/// follow-up hardening layer.
#[must_use]
pub fn build_jailer_argv(
    jailer: &JailerConfig,
    fc_binary_path: &str,
    vm_id: &str,
    fc_args: &[String],
) -> Vec<String> {
    let mut argv = vec![
        "--id".to_string(),
        vm_id.to_string(),
        "--exec-file".to_string(),
        fc_binary_path.to_string(),
        "--uid".to_string(),
        jailer.uid.to_string(),
        "--gid".to_string(),
        jailer.gid.to_string(),
        "--chroot-base-dir".to_string(),
        jailer.chroot_base_dir.clone(),
        "--".to_string(),
    ];
    argv.extend(fc_args.iter().cloned());
    argv
}

/// In-jail path where a host artifact is staged: `/<basename>` directly
/// under the chroot root.  Pure.
#[must_use]
pub fn jail_artifact_path(host_path: &str) -> String {
    let name = Path::new(host_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("artifact");
    format!("/{name}")
}

/// Resolve the `(program, argv)` pair for spawning a VM process — the bare
/// `firecracker` invocation, or the `jailer`-wrapped one when jailing is
/// enabled.  Pure — unit-tested on any platform.
#[must_use]
pub fn build_spawn_invocation(cfg: &SpawnConfig) -> (String, Vec<String>) {
    match &cfg.jailer {
        None => (
            cfg.binary_path.clone(),
            build_firecracker_argv(&cfg.socket_path),
        ),
        Some(jailer) => {
            // Inside the jail the API socket is at the chroot-relative
            // JAILED_API_SOCKET; cfg.socket_path holds the host-visible
            // location (used by wait_for_socket / the API client).
            let fc_args = build_firecracker_argv(JAILED_API_SOCKET);
            (
                jailer.jailer_binary_path.clone(),
                build_jailer_argv(jailer, &cfg.binary_path, &cfg.vm_id, &fc_args),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Process management shims (Linux-only)
// ---------------------------------------------------------------------------

/// Configuration for spawning the `firecracker` binary.
#[derive(Debug)]
pub struct SpawnConfig {
    /// Path to the `firecracker` binary.
    pub binary_path: String,
    /// HOST-visible path where the API Unix socket appears.  Bare launch:
    /// the socket firecracker binds directly.  Jailed launch: the
    /// chroot-expanded location (`<chroot_root>/run/firecracker.socket`)
    /// where the in-jail socket surfaces on the host.
    pub socket_path: String,
    /// VM id — becomes the jailer `--id` (names the per-VM chroot dir).
    pub vm_id: String,
    /// When set, `firecracker` is launched via `jailer` for stronger
    /// isolation (chroot + uid/gid drop).  `None` (the default when
    /// `FIRECRACKER_JAILER_PATH` is unset) spawns the bare binary,
    /// preserving the pre-jailer behavior exactly.
    pub jailer: Option<JailerConfig>,
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
/// Jailer integration (ADR-0006 §Jailer) is implemented: when
/// `cfg.jailer` is set, the process is launched via `jailer` (chroot +
/// uid/gid drop) with argv from the pure [`build_spawn_invocation`].  The
/// jailed launch itself is a Linux-only runtime path validated by the
/// microvm integration CI (KVM runner / Lima), not unit-exec-tested.
pub async fn spawn_firecracker_process(cfg: &SpawnConfig) -> Result<tokio::process::Child> {
    use tokio::process::Command;

    // Ensure the socket directory exists (idempotent; on the jailed path
    // `stage_jailed_artifacts` already created + chowned the jail's /run).
    if let Some(parent) = Path::new(&cfg.socket_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create socket dir {:?}", parent))?;
    }

    let (program, argv) = build_spawn_invocation(cfg);
    let mut cmd = Command::new(&program);
    cmd.args(&argv);

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
        .with_context(|| format!("failed to spawn {program} for VM {}", cfg.vm_id))?;

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

/// Stage boot artifacts into the jail root so the chrooted `firecracker`
/// can reach them, and pre-create the in-jail directories it binds sockets
/// into (API socket, vsock UDS, snapshots).
///
/// Artifacts are **copied** (not hard-linked) so the chown to the jail
/// uid/gid never mutates the shared base images (chowning a hard link
/// changes the source inode's ownership).  The copy cost is a deliberate
/// cold-start tradeoff; per-VM CoW scratch images are the follow-up
/// optimization.
///
/// LINUX-ONLY (jailed live path): only reached when jailing is enabled,
/// which sits behind the Linux availability gate.  Validated by the microvm
/// integration CI (KVM runner / Lima), not unit-exec-tested.
async fn stage_jailed_artifacts(
    cfg: &VmConfig,
    jailer: &JailerConfig,
    chroot_root: &str,
) -> Result<()> {
    // Every directory level we create must be owned by the jail uid/gid —
    // the dropped-privilege firecracker creates sockets/files inside them.
    let mut owned_paths = vec![
        chroot_root.to_string(),
        format!("{chroot_root}/run"),
        format!("{chroot_root}/run/lantern"),
        format!("{chroot_root}/run/lantern/vsock"),
        format!("{chroot_root}/run/lantern/snapshots"),
        format!("{chroot_root}/run/lantern/snapshots/{}", cfg.vm_id),
    ];
    for dir in [&owned_paths[3], &owned_paths[5]] {
        tokio::fs::create_dir_all(dir)
            .await
            .with_context(|| format!("create jail dir {dir}"))?;
    }

    let artifacts = [
        cfg.kernel_image_path.as_str(),
        cfg.rootfs_path.as_str(),
        cfg.certs_image_path.as_str(),
    ];
    // Artifacts land at /<basename>; two identical basenames would silently
    // overwrite each other inside the jail.
    let in_jail: Vec<String> = artifacts.iter().map(|p| jail_artifact_path(p)).collect();
    let unique: std::collections::HashSet<&str> = in_jail.iter().map(String::as_str).collect();
    if unique.len() != in_jail.len() {
        bail!(
            "jailer staging: artifact basename collision among kernel/rootfs/certs: {in_jail:?} \
             (rename the images so their basenames are distinct)"
        );
    }

    for (host, rel) in artifacts.iter().zip(&in_jail) {
        let dest = format!("{chroot_root}{rel}");
        tokio::fs::copy(host, &dest)
            .await
            .with_context(|| format!("stage {host} into jail at {dest}"))?;
        owned_paths.push(dest);
    }

    // The jailer drops firecracker to uid:gid; everything it must open or
    // create under the jail has to be owned by that identity.  chown is a
    // metadata syscall (microseconds) — fine inline on the boot path.
    #[cfg(unix)]
    for path in &owned_paths {
        std::os::unix::fs::chown(path, Some(jailer.uid), Some(jailer.gid))
            .with_context(|| format!("chown {path} to {}:{}", jailer.uid, jailer.gid))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Jailed snapshot restore (ADR-0006 §Jailer + ADR-0007 snapshot store)
//
// `snapshot()` makes the (possibly chrooted) firecracker write vmstate + mem
// files, and the service layer persists them through the `SnapshotStore` as
// `store://<snapshot_id>`.  Restoring under the jailer means the NEW VM's
// chrooted firecracker can only open paths inside its own jail, so the
// artifacts must be fetched back out of the store (local `SNAPSHOT_DIR`
// first, S3 tier fallback when configured) and copied into
// `<chroot_root>/snapshot/` owned by the jail uid/gid — exactly how
// kernel/rootfs are staged at boot — and the `PUT /snapshot/load` body must
// carry the in-jail RELATIVE paths, sent over the in-jail API socket.
//
// Everything below except the copy/chown/download executors is pure and
// unit-tested on macOS.  The live jailed load itself is a
// LINUX-RUNTIME-ONLY path validated by the microvm integration CI
// (KVM runner / Lima).
// ---------------------------------------------------------------------------

/// In-jail directory the snapshot artifacts are staged into for a jailed
/// restore (`<chroot_root>/snapshot/` on the host).
pub const JAILED_SNAPSHOT_DIR: &str = "/snapshot";
/// In-jail path of the staged vmstate file for `PUT /snapshot/load`.
pub const JAILED_SNAPSHOT_VMSTATE: &str = "/snapshot/vmstate";
/// In-jail path of the staged guest-memory file for `PUT /snapshot/load`.
pub const JAILED_SNAPSHOT_MEM: &str = "/snapshot/mem";

/// S3 key prefix the snapshot store uploads under.  Must mirror
/// `snapshot_store::S3_PREFIX` (kept in sync by the layout doc in
/// `src/snapshot_store.rs`).
const STORE_S3_PREFIX: &str = "snapshots";

/// Where a restore's snapshot artifacts come from, parsed from the
/// `snapshot_uri`.  Pure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotSource {
    /// `store://<snapshot_id>` — the SnapshotStore owns the artifacts
    /// (local `SNAPSHOT_DIR` tier, S3 fallback).
    Store { snapshot_id: String },
    /// `fc://<path>` or a bare path — host filesystem locations.  The mem
    /// file is the vmstate's sibling named `mem` (the layout both
    /// `snapshot()` and the store write: `<dir>/{snapshot,mem}`).
    HostPath {
        vmstate_path: String,
        mem_path: String,
    },
}

/// Parse a `snapshot_uri` into a [`SnapshotSource`].  Pure.
///
/// `HostPath` mem-file derivation: the sibling file named `mem` in the
/// vmstate's directory.  (Deliberately NOT the legacy bare-restore's
/// substring `replace("/snapshot", "/mem")`, which also rewrites a
/// `/snapshots/` directory segment — e.g. `/run/lantern/snapshots/<vm>/mem`
/// would come out as `/run/lantern/mems/<vm>/mem`.  The bare restore path is
/// left byte-identical; this parser is consumed by the jailed path only.)
#[must_use]
pub fn parse_snapshot_source(snapshot_uri: &str) -> SnapshotSource {
    if let Some(id) = snapshot_uri.strip_prefix("store://") {
        return SnapshotSource::Store {
            snapshot_id: id.to_string(),
        };
    }
    let vmstate_path = snapshot_uri
        .strip_prefix("fc://")
        .unwrap_or(snapshot_uri)
        .to_string();
    let mem_path = match vmstate_path.rsplit_once('/') {
        Some((dir, _file)) => format!("{dir}/mem"),
        None => "mem".to_string(),
    };
    SnapshotSource::HostPath {
        vmstate_path,
        mem_path,
    }
}

/// Build the `PUT /snapshot/load` body.  Pure.
///
/// - `jailed == false`: the chrooted-vs-bare process sees the same `/` the
///   host does, so the body carries the absolute HOST paths (the exact
///   contract the pre-jailer restore always used).
/// - `jailed == true`: the chrooted firecracker resolves every path inside
///   its jail, so the body carries the in-jail RELATIVE staging paths
///   ([`JAILED_SNAPSHOT_VMSTATE`] / [`JAILED_SNAPSHOT_MEM`]); the host paths
///   are where the manager staged the copies, never sent over the API.
///
/// `resume_vm` / `enable_diff_snapshots` match the existing restore
/// semantics (resume immediately; keep dirty-page tracking restorable).
#[must_use]
pub fn build_snapshot_load_body(
    jailed: bool,
    host_vmstate_path: &str,
    host_mem_path: &str,
) -> SnapshotLoadParams {
    let (snapshot_path, mem_path) = if jailed {
        (
            JAILED_SNAPSHOT_VMSTATE.to_string(),
            JAILED_SNAPSHOT_MEM.to_string(),
        )
    } else {
        (host_vmstate_path.to_string(), host_mem_path.to_string())
    };
    SnapshotLoadParams {
        snapshot_path,
        mem_backend: MemBackend {
            backend_type: "File".to_string(),
            backend_path: mem_path,
        },
        enable_diff_snapshots: Some(true),
        resume_vm: Some(true),
    }
}

/// Staging plan for a jailed restore: which directories to create and which
/// files to copy into the new VM's chroot, all of which must end up owned by
/// the jail uid/gid (the dropped-privilege firecracker has to open the
/// artifacts and bind sockets in those directories).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JailedSnapshotStaging {
    /// Directories to create, parent before child.  Mirrors the boot-time
    /// `stage_jailed_artifacts` set (API socket dir, vsock dir, snapshot
    /// dirs) plus the restore staging dir.
    pub dirs: Vec<String>,
    /// `(host_source, host-visible destination under the chroot)` copies.
    pub copies: Vec<(String, String)>,
}

impl JailedSnapshotStaging {
    /// Every path that must be chowned to the jail uid/gid after staging:
    /// all created directories plus every copied artifact.
    #[must_use]
    pub fn owned_paths(&self) -> Vec<&str> {
        self.dirs
            .iter()
            .map(String::as_str)
            .chain(self.copies.iter().map(|(_, dest)| dest.as_str()))
            .collect()
    }
}

/// Compute the staging plan for restoring a snapshot into a fresh jail.
/// Pure — unit-tested on any platform.
///
/// The vmstate + mem artifacts land at `<chroot_root>/snapshot/{vmstate,mem}`
/// (in-jail `/snapshot/vmstate` + `/snapshot/mem`).  The `run/lantern/...`
/// directories are pre-created exactly as at boot so the restored VM can
/// re-bind its vsock UDS and take further snapshots under
/// `/run/lantern/snapshots/<new_vm_id>`.
#[must_use]
pub fn plan_jailed_snapshot_staging(
    chroot_root: &str,
    new_vm_id: &str,
    host_vmstate_path: &str,
    host_mem_path: &str,
) -> JailedSnapshotStaging {
    let root = chroot_root.trim_end_matches('/');
    JailedSnapshotStaging {
        dirs: vec![
            root.to_string(),
            format!("{root}/run"),
            format!("{root}/run/lantern"),
            format!("{root}/run/lantern/vsock"),
            format!("{root}/run/lantern/snapshots"),
            format!("{root}/run/lantern/snapshots/{new_vm_id}"),
            format!("{root}{JAILED_SNAPSHOT_DIR}"),
        ],
        copies: vec![
            (
                host_vmstate_path.to_string(),
                format!("{root}{JAILED_SNAPSHOT_VMSTATE}"),
            ),
            (
                host_mem_path.to_string(),
                format!("{root}{JAILED_SNAPSHOT_MEM}"),
            ),
        ],
    }
}

/// Execute a [`JailedSnapshotStaging`] plan: create the directories, copy the
/// artifacts, chown everything to the jail uid/gid.
///
/// Artifacts are **copied** (not hard-linked) for the same reason as the boot
/// path: chowning a hard link would mutate the snapshot store's canonical
/// copy.  The mem file can be large (the guest's RAM) — this copy is the same
/// deliberate restore-latency tradeoff the boot path makes for rootfs.
///
/// LINUX-RUNTIME-ONLY (jailed live path): only reached when jailing is
/// enabled, behind the Linux availability gate.  The plan construction is
/// pure and unit-tested; this executor is validated by the microvm
/// integration CI (KVM runner / Lima).
async fn stage_jailed_snapshot(plan: &JailedSnapshotStaging, jailer: &JailerConfig) -> Result<()> {
    for dir in &plan.dirs {
        tokio::fs::create_dir_all(dir)
            .await
            .with_context(|| format!("create jail dir {dir}"))?;
    }
    for (src, dest) in &plan.copies {
        tokio::fs::copy(src, dest)
            .await
            .with_context(|| format!("stage snapshot artifact {src} into jail at {dest}"))?;
    }
    #[cfg(unix)]
    for path in plan.owned_paths() {
        std::os::unix::fs::chown(path, Some(jailer.uid), Some(jailer.gid))
            .with_context(|| format!("chown {path} to {}:{}", jailer.uid, jailer.gid))?;
    }
    Ok(())
}

/// Local snapshot-store root.  Must mirror `SnapshotStore::from_env`
/// (`SNAPSHOT_DIR`, default `/var/lib/lantern/snapshots`).
fn snapshot_store_root() -> std::path::PathBuf {
    std::path::PathBuf::from(
        std::env::var("SNAPSHOT_DIR").unwrap_or_else(|_| "/var/lib/lantern/snapshots".to_string()),
    )
}

/// Optional S3 tier for snapshot retrieval.  Must mirror
/// `SnapshotStore::from_env` (`S3_ENDPOINT` + `S3_BUCKET` +
/// `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`); `None` when unconfigured
/// or the client cannot be built (warn-logged — restore then has only the
/// local tier, matching the store's own degradation).
fn snapshot_s3_from_env() -> Option<std::sync::Arc<dyn object_store::ObjectStore>> {
    let endpoint = std::env::var("S3_ENDPOINT").unwrap_or_default();
    let bucket = std::env::var("S3_BUCKET").unwrap_or_default();
    if endpoint.is_empty() || bucket.is_empty() {
        return None;
    }
    let access_key = std::env::var("AWS_ACCESS_KEY_ID").unwrap_or_default();
    let secret_key = std::env::var("AWS_SECRET_ACCESS_KEY").unwrap_or_default();
    match object_store::aws::AmazonS3Builder::new()
        .with_endpoint(&endpoint)
        .with_bucket_name(&bucket)
        .with_access_key_id(&access_key)
        .with_secret_access_key(&secret_key)
        .with_virtual_hosted_style_request(false)
        .with_allow_http(true)
        .with_region("us-east-1")
        .build()
    {
        Ok(client) => {
            Some(std::sync::Arc::new(client) as std::sync::Arc<dyn object_store::ObjectStore>)
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                endpoint = %endpoint,
                bucket = %bucket,
                "restore: failed to build S3 client; falling back to local snapshot tier only"
            );
            None
        }
    }
}

/// From a flat listing of S3 object keys, find the `snapshot` (vmstate) and
/// `mem` artifact keys for `snapshot_id` under
/// `snapshots/<agent_version_id>/<vm_id>/<snapshot_id>/`.  Pure.
///
/// Both artifacts must live in the same snapshot directory; a half-uploaded
/// snapshot (one artifact missing) is treated as not found rather than
/// restored with a dangling memory backend.
#[must_use]
pub fn find_snapshot_keys_in_listing(
    keys: &[String],
    snapshot_id: &str,
) -> Option<(String, String)> {
    let vmstate_suffix = format!("/{snapshot_id}/snapshot");
    let vmstate_key = keys.iter().find(|k| k.ends_with(&vmstate_suffix))?;
    let mem_key = format!(
        "{}/mem",
        vmstate_key.strip_suffix("/snapshot").unwrap_or(vmstate_key)
    );
    if keys.contains(&mem_key) {
        Some((vmstate_key.clone(), mem_key))
    } else {
        None
    }
}

/// Scan the local snapshot-store tree
/// (`<root>/<agent_version_id>/<vm_id>/<snapshot_id>/`) for `snapshot_id` and
/// return the `(vmstate, mem)` file paths when found.
///
/// The store's `get` is keyed by the full `(agent_version, vm, snapshot)`
/// triple, but a `RestoreRequest` only carries `store://<snapshot_id>`, so
/// the two fixed directory levels are walked.  Snapshot ids are UUIDv4 —
/// globally unique — so the first hit is the only hit.
///
/// Returns an error (not `None`) when the snapshot directory exists but an
/// artifact is missing: that is a corrupt store entry, not an absent
/// snapshot, and restoring from it would dangle.
async fn locate_snapshot_artifacts_local(
    root: &Path,
    snapshot_id: &str,
) -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>> {
    let mut version_dirs = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("read snapshot store root {root:?}")),
    };

    while let Some(version_entry) = version_dirs
        .next_entry()
        .await
        .with_context(|| format!("scan snapshot store root {root:?}"))?
    {
        let mut vm_dirs = match tokio::fs::read_dir(version_entry.path()).await {
            Ok(entries) => entries,
            // Stray file at this level (not a directory) — skip it.
            Err(_) => continue,
        };
        while let Some(vm_entry) = vm_dirs
            .next_entry()
            .await
            .with_context(|| format!("scan snapshot store dir {:?}", version_entry.path()))?
        {
            let candidate = vm_entry.path().join(snapshot_id);
            if tokio::fs::metadata(&candidate).await.is_err() {
                continue;
            }
            let vmstate = candidate.join("snapshot");
            let mem = candidate.join("mem");
            let vmstate_ok = tokio::fs::metadata(&vmstate).await.is_ok();
            let mem_ok = tokio::fs::metadata(&mem).await.is_ok();
            if !vmstate_ok || !mem_ok {
                bail!(
                    "snapshot '{snapshot_id}' found at {candidate:?} but its artifacts are \
                     incomplete (snapshot present: {vmstate_ok}, mem present: {mem_ok}); \
                     refusing to restore from a corrupt store entry"
                );
            }
            return Ok(Some((vmstate, mem)));
        }
    }
    Ok(None)
}

/// Download one S3 object to `dest`, streaming chunk-by-chunk so a
/// multi-GiB guest-memory file is never buffered in RAM.
async fn download_s3_object(
    s3: &dyn object_store::ObjectStore,
    key: &str,
    dest: &Path,
) -> Result<()> {
    use futures::TryStreamExt;
    use tokio::io::AsyncWriteExt;

    let mut stream = s3
        .get(&object_store::path::Path::from(key))
        .await
        .with_context(|| format!("S3 get {key}"))?
        .into_stream();
    let mut file = tokio::fs::File::create(dest)
        .await
        .with_context(|| format!("create {dest:?}"))?;
    while let Some(chunk) = stream
        .try_next()
        .await
        .with_context(|| format!("read S3 object {key}"))?
    {
        file.write_all(&chunk)
            .await
            .with_context(|| format!("write {dest:?}"))?;
    }
    file.flush()
        .await
        .with_context(|| format!("flush {dest:?}"))?;
    Ok(())
}

/// S3-tier fallback: list the store prefix, find the artifact keys for
/// `snapshot_id`, and download both into the local store layout under
/// `cache_root` (so subsequent restores hit disk — same caching behavior as
/// `SnapshotStore::get`).  Returns `Ok(None)` when the snapshot is not in S3.
async fn fetch_snapshot_from_s3(
    s3: &dyn object_store::ObjectStore,
    snapshot_id: &str,
    cache_root: &Path,
) -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>> {
    use futures::TryStreamExt;

    let prefix = object_store::path::Path::from(STORE_S3_PREFIX);
    let keys: Vec<String> = s3
        .list(Some(&prefix))
        .map_ok(|meta| meta.location.to_string())
        .try_collect()
        .await
        .context("list snapshot objects in S3")?;

    let Some((vmstate_key, mem_key)) = find_snapshot_keys_in_listing(&keys, snapshot_id) else {
        return Ok(None);
    };

    // `snapshots/<av>/<vm>/<id>/snapshot` → cache under `<root>/<av>/<vm>/<id>/`.
    let rel = vmstate_key
        .strip_prefix(&format!("{STORE_S3_PREFIX}/"))
        .unwrap_or(&vmstate_key);
    let dir = match Path::new(rel).parent() {
        Some(parent) => cache_root.join(parent),
        None => cache_root.to_path_buf(),
    };
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("create local snapshot cache dir {dir:?}"))?;

    let vmstate = dir.join("snapshot");
    let mem = dir.join("mem");
    download_s3_object(s3, &vmstate_key, &vmstate).await?;
    download_s3_object(s3, &mem_key, &mem).await?;

    tracing::info!(
        snapshot_id = %snapshot_id,
        cache_dir = ?dir,
        "restore: fetched snapshot artifacts from S3 tier into local cache"
    );
    Ok(Some((vmstate, mem)))
}

/// Resolve a `store://<snapshot_id>` to the host paths of its `(vmstate,
/// mem)` artifacts: local `SNAPSHOT_DIR` tier first, then the S3 tier when
/// configured.  Mirrors `SnapshotStore::get`'s retrieval order.
///
/// A snapshot found in neither tier is a clear NOT_FOUND-style error — the
/// restore fails fast instead of booting a VM with dangling backing files.
async fn resolve_store_snapshot(
    root: &Path,
    s3: Option<&dyn object_store::ObjectStore>,
    snapshot_id: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    if let Some(found) = locate_snapshot_artifacts_local(root, snapshot_id).await? {
        return Ok(found);
    }
    if let Some(s3) = s3
        && let Some(found) = fetch_snapshot_from_s3(s3, snapshot_id, root).await?
    {
        return Ok(found);
    }
    bail!(
        "snapshot '{snapshot_id}' not found in the snapshot store (local root {root:?}; \
         S3 tier {}): nothing to restore",
        if s3.is_some() {
            "checked, no match"
        } else {
            "not configured"
        }
    )
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
    /// Jailer launch parameters (ADR-0006 §Jailer).  `Some` when
    /// `FIRECRACKER_JAILER_PATH` is set; `None` (the default) preserves the
    /// bare-`firecracker` launch path exactly.
    jailer: Option<JailerConfig>,
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
        let jailer = JailerConfig::from_env();

        if available {
            tracing::info!(
                binary = ?binary_path,
                kernel = %kernel_image_path,
                rootfs = %rootfs_path,
                jailed = jailer.is_some(),
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
            jailer,
            processes: ProcessTable::new(),
        }
    }

    /// Host-visible API socket path for a VM, jail-aware: the conventional
    /// `/run/firecracker/<vm_id>.sock` for bare launches, or the
    /// chroot-expanded location when jailing is enabled.
    fn api_socket_path(&self, vm_id: &str) -> String {
        match (&self.jailer, self.binary_path.as_deref()) {
            (Some(jailer), Some(bin)) => jailer.host_api_socket_path(bin, vm_id),
            _ => format!("/run/firecracker/{vm_id}.sock"),
        }
    }

    /// Map an in-jail absolute path to its host-visible location.  Identity
    /// when jailing is disabled (the chrooted-vs-bare process sees the same
    /// path the host does).
    fn host_vm_path(&self, vm_id: &str, in_jail_path: &str) -> String {
        match (&self.jailer, self.binary_path.as_deref()) {
            (Some(jailer), Some(bin)) => jailer.host_path(bin, vm_id, in_jail_path),
            _ => in_jail_path.to_string(),
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

        // Step 0.5: ensure the host runtime dirs for the API socket and the
        // vsock UDS exist. Firecracker binds the vsock host-side Unix socket
        // itself and fails the `PUT /vsock` with ENOENT ("No such file or
        // directory") when the parent dir is missing. Jailed launches stage
        // these inside the chroot, so this only applies to the bare path.
        if self.jailer.is_none() {
            for p in [cfg.socket_path.as_str(), cfg.vsock_uds_path.as_str()] {
                if let Some(dir) = std::path::Path::new(p).parent() {
                    tokio::fs::create_dir_all(dir)
                        .await
                        .with_context(|| format!("create runtime dir {dir:?}"))?;
                }
            }
        }

        // Step 1: TAP device.
        // LINUX-ONLY: requires CAP_NET_ADMIN / root.
        setup_tap_device(&cfg.tap_dev, self.bridge_name.as_deref()).await?;

        // Step 1.5 (jailed launches only): stage artifacts into the jail and
        // derive the jail-relative view of the config.  The chrooted
        // firecracker resolves every path it opens inside the jail, so the
        // kernel / rootfs / certs image paths sent over the API become
        // `/<basename>` (staged at `<chroot_root>/<basename>`), and the API
        // socket the manager connects to becomes the chroot-expanded host
        // path.  `vsock_uds_path` / snapshot paths stay in-jail-relative in
        // the API bodies; host-side consumers translate via `host_vm_path`.
        // LINUX-ONLY (jailed path): validated by the microvm CI, not
        // unit-exec-tested.  When jailing is disabled (`jailer` None, the
        // default) `cfg` is used untouched — bare-launch behavior is
        // bit-identical to the pre-jailer implementation.
        let mut jailed_cfg: Option<VmConfig> = None;
        if let Some(jailer) = &self.jailer {
            let chroot_root = jailer.chroot_root(binary, &cfg.vm_id);
            stage_jailed_artifacts(cfg, jailer, &chroot_root).await?;
            let mut c = cfg.clone();
            c.socket_path = jailer.host_api_socket_path(binary, &cfg.vm_id);
            c.kernel_image_path = jail_artifact_path(&cfg.kernel_image_path);
            c.rootfs_path = jail_artifact_path(&cfg.rootfs_path);
            c.certs_image_path = jail_artifact_path(&cfg.certs_image_path);
            jailed_cfg = Some(c);
        }
        let api_cfg: &VmConfig = jailed_cfg.as_ref().unwrap_or(cfg);

        // Step 2: Spawn the Firecracker process (via jailer when enabled).
        // LINUX-ONLY: requires the firecracker binary and /dev/kvm.
        let spawn_cfg = SpawnConfig {
            binary_path: binary.to_string(),
            socket_path: api_cfg.socket_path.clone(),
            vm_id: cfg.vm_id.clone(),
            jailer: self.jailer.clone(),
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

        let sock = &api_cfg.socket_path;

        // Step 3: Machine config.
        unix_socket_put(sock, "/machine-config", &api_cfg.machine_config()).await?;

        // Step 4: Boot source.
        unix_socket_put(sock, "/boot-source", &api_cfg.boot_source()).await?;

        // Step 5: Root drive.
        unix_socket_put(sock, "/drives/rootfs", &api_cfg.root_drive()).await?;

        // Step 5b: Read-only cert drive — carries the per-VM mTLS material
        // provisioned in Step 0 so the in-guest harness can read the paths the
        // boot-args reference. LINUX-ONLY (block device attach on a live VM).
        unix_socket_put(sock, "/drives/certs", &api_cfg.cert_drive()).await?;

        // Step 6: Network interface.
        unix_socket_put(
            sock,
            "/network-interfaces/eth0",
            &api_cfg.network_interface(),
        )
        .await?;

        // Step 7: Vsock.
        unix_socket_put(sock, "/vsock", &api_cfg.vsock_device()).await?;

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

    /// Jailed restore path (ADR-0006 §Jailer + ADR-0007 snapshot store).
    ///
    /// Sequence:
    ///   1. Resolve the snapshot's `(vmstate, mem)` artifacts on the host —
    ///      from the snapshot store for `store://<id>` URIs (local
    ///      `SNAPSHOT_DIR` tier, then S3 fallback when configured; a missing
    ///      id is a clear not-found error), or directly from the host
    ///      filesystem for `fc://` / bare-path URIs.
    ///   2. Stage them into the NEW VM's chroot at
    ///      `<chroot_root>/snapshot/{vmstate,mem}` owned by the jail
    ///      uid/gid — the same copy+chown pattern `stage_jailed_artifacts`
    ///      uses for kernel/rootfs at boot.
    ///   3. Spawn a fresh jailed firecracker for the new vm_id.
    ///   4. `PUT /snapshot/load` over the in-jail API socket with the
    ///      in-jail RELATIVE paths ([`JAILED_SNAPSHOT_VMSTATE`] /
    ///      [`JAILED_SNAPSHOT_MEM`]), resuming the VM — same semantics as
    ///      the bare restore.
    ///
    /// LINUX-RUNTIME-ONLY: only reached behind the `firecracker_available()`
    /// gate (Linux + KVM + jailer binary).  The path/body/staging
    /// construction is pure and unit-tested on any platform; the live jailed
    /// load is validated by the microvm integration CI (KVM runner / Lima).
    ///
    /// Known limitation (Linux-CI territory, shared with drive-state
    /// fidelity in ADR 0007 Tier 2): Firecracker's snapshot/load also
    /// requires the drive backing files the vmstate references (rootfs /
    /// certs image at their boot-time in-jail paths) to resolve inside the
    /// new chroot.  The store persists vmstate + mem today; persisting and
    /// re-staging the block-device files is the documented follow-up.
    async fn restore_jailed(
        &self,
        jailer: &JailerConfig,
        snapshot_uri: &str,
        req: &RestoreRequest,
    ) -> Result<Handle> {
        let start = Instant::now();
        let binary = self
            .binary_path
            .as_deref()
            .ok_or_else(Self::not_available_error)?;
        let vm_id = Uuid::new_v4().to_string();

        // Step 1: resolve the snapshot artifacts to host file paths.
        let (host_vmstate, host_mem) = match parse_snapshot_source(snapshot_uri) {
            SnapshotSource::HostPath {
                vmstate_path,
                mem_path,
            } => (
                std::path::PathBuf::from(vmstate_path),
                std::path::PathBuf::from(mem_path),
            ),
            SnapshotSource::Store { snapshot_id } => {
                let root = snapshot_store_root();
                let s3 = snapshot_s3_from_env();
                resolve_store_snapshot(&root, s3.as_deref(), &snapshot_id).await?
            }
        };

        tracing::info!(
            vm_id = %vm_id,
            run_id = %req.run_id,
            snapshot_uri = snapshot_uri,
            vmstate = ?host_vmstate,
            // requires Linux + /dev/kvm + jailer; validated by microvm CI
            "Firecracker: restoring from snapshot into a fresh jail (LINUX-ONLY)"
        );

        // Step 2: stage vmstate + mem into the new chroot (copy + chown to
        // the jail uid/gid, exactly as kernel/rootfs are staged at boot).
        let chroot_root = jailer.chroot_root(binary, &vm_id);
        let plan = plan_jailed_snapshot_staging(
            &chroot_root,
            &vm_id,
            &host_vmstate.display().to_string(),
            &host_mem.display().to_string(),
        );
        stage_jailed_snapshot(&plan, jailer).await?;

        // Step 3: spawn the jailed firecracker for the new VM.
        // LINUX-ONLY
        let socket_path = jailer.host_api_socket_path(binary, &vm_id);
        let child = spawn_firecracker_process(&SpawnConfig {
            binary_path: binary.to_string(),
            socket_path: socket_path.clone(),
            vm_id: vm_id.clone(),
            jailer: Some(jailer.clone()),
        })
        .await?;
        if let Some(mut prev) = self.processes.insert(&vm_id, child) {
            let _ = prev.force_kill();
            tracing::warn!(vm_id = %vm_id, "process table collision; killed stale child");
        }

        // Step 4: load the snapshot with the in-jail RELATIVE paths and
        // resume.  LINUX-ONLY
        unix_socket_put(
            &socket_path,
            "/snapshot/load",
            &build_snapshot_load_body(
                true,
                &host_vmstate.display().to_string(),
                &host_mem.display().to_string(),
            ),
        )
        .await
        .context("failed to load snapshot in jailed VM")?;

        let restore_ms = start.elapsed().as_secs_f64() * 1000.0;

        tracing::info!(
            vm_id = %vm_id,
            restore_ms,
            "Firecracker: microVM restored from snapshot (jailed)"
        );

        Ok(Handle {
            id: vm_id,
            node_name: "firecracker-local".to_string(),
            cold_start_ms: restore_ms,
        })
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

        let socket_path = self.api_socket_path(handle_id);

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

        // Jailed VMs leave a per-VM chroot with copied artifacts (rootfs can
        // be hundreds of MB) — reclaim the disk.  Best-effort: a failure here
        // must not turn a successful teardown into an error.
        if let (Some(jailer), Some(bin)) = (&self.jailer, self.binary_path.as_deref()) {
            let jail_dir = jailer.jail_dir(bin, handle_id);
            if let Err(e) = tokio::fs::remove_dir_all(&jail_dir).await {
                tracing::warn!(
                    vm_id = handle_id,
                    jail_dir = %jail_dir,
                    error = %e,
                    "Firecracker: failed to remove jail dir (non-fatal; disk leak)"
                );
            }
        }

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
        // Same convention as VmConfig::vsock_uds_path; jailed VMs surface the
        // in-jail UDS under the chroot root on the host.
        let vsock_path = self.host_vm_path(handle_id, &format!("/run/lantern/vsock/{vm_id}.sock"));

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

        let socket_path = self.api_socket_path(&req.handle_id);
        // In-jail-relative for jailed VMs (the chrooted firecracker writes
        // them inside the jail); identical to the host path for bare VMs.
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

        // The URI carries the HOST-visible location so the snapshot is
        // addressable after the VM (and its jail) is gone.
        let host_snapshot_path = self.host_vm_path(&req.handle_id, &snapshot_path);

        Ok(SnapshotInfo {
            snapshot_uri: format!("fc://{host_snapshot_path}"),
            size_bytes: 0, // actual file size populated on Linux via metadata
        })
    }

    /// Restore a microVM from a snapshot.
    ///
    /// Bare (non-jailed) sequence — unchanged from the pre-jailer contract:
    ///   1. Spawn a fresh Firecracker process for the new VM id
    ///   2. PUT /snapshot/load (absolute host paths)
    ///
    /// Jailed sequence (`FIRECRACKER_JAILER_PATH` set): delegates to
    /// [`Self::restore_jailed`], which fetches the artifacts from the
    /// snapshot store (`store://<id>`; local tier then S3 fallback) or the
    /// host filesystem (`fc://` / bare path), stages them into the new VM's
    /// chroot, and loads via the in-jail RELATIVE paths.
    ///
    /// LINUX-ONLY: requires Firecracker binary + /dev/kvm (+ jailer for the
    /// jailed path). Integration-tested on a Linux host.
    async fn restore(&self, snapshot_uri: &str, req: &RestoreRequest) -> Result<Handle> {
        if !self.available {
            return Err(Self::not_available_error());
        }

        // Jailed restore: the chrooted firecracker cannot open host paths,
        // so the artifacts are staged into the new jail first.
        // LINUX-RUNTIME-ONLY (behind the availability gate above).
        if let Some(jailer) = self.jailer.clone() {
            return self.restore_jailed(&jailer, snapshot_uri, req).await;
        }

        let start = Instant::now();
        let vm_id = Uuid::new_v4().to_string();
        let socket_path = format!("/run/firecracker/{vm_id}.sock");

        // Derive the sibling mem-file path. NOT a substring replace of
        // "/snapshot" -> "/mem" — that also rewrites a "/snapshots/" directory
        // segment (e.g. /run/lantern/snapshots/<vm>/snapshot would yield a
        // nonexistent /run/lantern/mems/<vm>/mem). parse_snapshot_source takes
        // the file basename only, the same derivation the jailed path uses.
        let (snapshot_path, mem_file_path) = match parse_snapshot_source(snapshot_uri) {
            SnapshotSource::HostPath {
                vmstate_path,
                mem_path,
            } => (vmstate_path, mem_path),
            // store:// restore is wired through the jailed path; the bare path
            // only ever receives fc:// / absolute host snapshots.
            SnapshotSource::Store { snapshot_id } => {
                return Err(anyhow::anyhow!(
                    "store:// snapshot restore requires the jailer path (snapshot_id={snapshot_id})"
                ));
            }
        };

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
            vm_id: vm_id.clone(),
            jailer: None, // bare path: jailed restore delegated above
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

    /// Exec is not supported via the host-side Firecracker REST API.
    ///
    /// Guest-exec (running a command inside the microVM) arrives via the
    /// harness channel: the in-VM `RuntimeHarness` service accepts exec
    /// requests over the harness gRPC channel, not through the host-side
    /// Firecracker REST API.  Wiring a dedicated guest-exec RPC through the
    /// harness channel is a future change; for now callers should use the
    /// harness streaming protocol directly.
    async fn exec_command(
        &self,
        handle_id: &str,
        _command: &str,
        _argv: &[String],
    ) -> anyhow::Result<crate::backend::ExecOutput> {
        anyhow::bail!(
            "exec not supported by the 'firecracker' backend (handle_id={}): \
             guest exec arrives via the harness channel (RuntimeHarness gRPC) — \
             a dedicated in-VM exec RPC is a future change",
            handle_id,
        );
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
//   6. Jailer config + argv/path construction (pure; no jailer binary, no
//      Linux — the jailed launch itself is microvm-CI / Lima territory)
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

    // -----------------------------------------------------------------------
    // 6. Jailer config + argv/path construction (ADR-0006 §Jailer)
    //
    // Pure-function tests only — no jailer binary, no Linux, no process
    // exec.  The live jailed launch is validated by the microvm CI / Lima.
    // -----------------------------------------------------------------------

    fn jailer_with_defaults() -> JailerConfig {
        JailerConfig::from_parts(Some("/usr/bin/jailer"), None, None, None)
            .expect("non-empty jailer path must enable jailing")
    }

    #[test]
    fn jailing_disabled_by_default_when_env_unset() {
        // Env unset ⇒ all parts None ⇒ jailing disabled — the existing
        // bare-firecracker launch is the default behavior.
        assert_eq!(JailerConfig::from_parts(None, None, None, None), None);
        // Empty value behaves like unset.
        assert_eq!(JailerConfig::from_parts(Some(""), None, None, None), None);
    }

    #[test]
    fn jailer_config_applies_documented_defaults() {
        let j = jailer_with_defaults();
        assert_eq!(j.jailer_binary_path, "/usr/bin/jailer");
        assert_eq!(j.uid, DEFAULT_JAILER_UID);
        assert_eq!(j.gid, DEFAULT_JAILER_GID);
        assert_eq!(j.chroot_base_dir, DEFAULT_CHROOT_BASE);
        assert_eq!((j.uid, j.gid), (123, 100));
        assert_eq!(j.chroot_base_dir, "/srv/jailer");
    }

    #[test]
    fn jailer_config_honors_custom_overrides() {
        let j = JailerConfig::from_parts(
            Some("/opt/fc/jailer"),
            Some("5001"),
            Some("5002"),
            Some("/var/jail"),
        )
        .expect("enabled");
        assert_eq!(j.jailer_binary_path, "/opt/fc/jailer");
        assert_eq!(j.uid, 5001);
        assert_eq!(j.gid, 5002);
        assert_eq!(j.chroot_base_dir, "/var/jail");
    }

    #[test]
    fn jailer_config_rejects_bad_uid_gid_never_root() {
        // Table: (uid input, gid input) → expected (uid, gid).
        let cases = [
            (Some("notanumber"), Some("alsobad"), 123, 100),
            (Some("0"), Some("0"), 123, 100), // root refused
            (Some("-1"), Some("4294967296"), 123, 100), // out of u32 range
            (Some(" 200 "), Some("300"), 200, 300), // whitespace tolerated
            (None, Some("7"), 123, 7),
        ];
        for (uid_in, gid_in, want_uid, want_gid) in cases {
            let j = JailerConfig::from_parts(Some("/usr/bin/jailer"), uid_in, gid_in, None)
                .expect("enabled");
            assert_eq!(
                (j.uid, j.gid),
                (want_uid, want_gid),
                "uid_in={uid_in:?} gid_in={gid_in:?}"
            );
            assert_ne!(j.uid, 0, "jail uid must never be root");
            assert_ne!(j.gid, 0, "jail gid must never be root");
        }
    }

    #[test]
    fn jailer_chroot_and_socket_paths() {
        let j = jailer_with_defaults();
        assert_eq!(
            j.jail_dir("/usr/bin/firecracker", "vm-1"),
            "/srv/jailer/firecracker/vm-1"
        );
        assert_eq!(
            j.chroot_root("/usr/bin/firecracker", "vm-1"),
            "/srv/jailer/firecracker/vm-1/root"
        );
        assert_eq!(
            j.host_api_socket_path("/usr/bin/firecracker", "vm-1"),
            "/srv/jailer/firecracker/vm-1/root/run/firecracker.socket"
        );
        assert_eq!(
            j.host_path(
                "/usr/bin/firecracker",
                "vm-1",
                "/run/lantern/vsock/vm-1.sock"
            ),
            "/srv/jailer/firecracker/vm-1/root/run/lantern/vsock/vm-1.sock"
        );

        // Trailing slash on the base + non-standard exec basename.
        let j2 = JailerConfig::from_parts(Some("/usr/bin/jailer"), None, None, Some("/var/jail/"))
            .expect("enabled");
        assert_eq!(
            j2.jail_dir("/opt/fc-v1.7", "vm-2"),
            "/var/jail/fc-v1.7/vm-2"
        );
    }

    #[test]
    fn jail_artifact_path_maps_to_root_basename() {
        assert_eq!(jail_artifact_path("/opt/lantern/vmlinux"), "/vmlinux");
        assert_eq!(
            jail_artifact_path("/opt/lantern/rootfs.ext4"),
            "/rootfs.ext4"
        );
        assert_eq!(
            jail_artifact_path("/run/lantern/certs/vm-1/certs.img"),
            "/certs.img"
        );
    }

    #[test]
    fn build_jailer_argv_places_flags_and_separator() {
        let j = JailerConfig::from_parts(
            Some("/usr/bin/jailer"),
            Some("321"),
            Some("654"),
            Some("/var/jail"),
        )
        .expect("enabled");
        let fc_args = vec!["--api-sock".to_string(), JAILED_API_SOCKET.to_string()];
        let argv = build_jailer_argv(&j, "/usr/bin/firecracker", "vm-abc", &fc_args);

        // Flag/value pairs land correctly.
        let flag_val = |flag: &str| -> &str {
            let i = argv
                .iter()
                .position(|a| a == flag)
                .unwrap_or_else(|| panic!("missing {flag} in {argv:?}"));
            &argv[i + 1]
        };
        assert_eq!(flag_val("--id"), "vm-abc");
        assert_eq!(flag_val("--exec-file"), "/usr/bin/firecracker");
        assert_eq!(flag_val("--uid"), "321");
        assert_eq!(flag_val("--gid"), "654");
        assert_eq!(flag_val("--chroot-base-dir"), "/var/jail");

        // The `--` separator precedes ALL firecracker args.
        let sep = argv
            .iter()
            .position(|a| a == "--")
            .expect("missing -- separator");
        assert_eq!(
            &argv[sep + 1..],
            fc_args.as_slice(),
            "everything after -- must be the firecracker args, in order"
        );
        for flag in ["--id", "--exec-file", "--uid", "--gid", "--chroot-base-dir"] {
            let i = argv.iter().position(|a| a == flag).expect("flag present");
            assert!(i < sep, "{flag} must precede the -- separator");
        }
    }

    #[test]
    fn build_firecracker_argv_matches_bare_launch_contract() {
        // Only `--api-sock` — Firecracker has no `--log-level` flag.
        assert_eq!(
            build_firecracker_argv("/run/firecracker/vm-1.sock"),
            vec!["--api-sock", "/run/firecracker/vm-1.sock"]
        );
    }

    #[test]
    fn mke2fs_argv_populates_from_dir_as_plain_file() {
        let argv = build_mke2fs_argv(
            "/run/lantern/certs/vm-1/certs.img",
            "/run/lantern/certs/vm-1/img-src",
            1024,
        );
        // -d <dir> populates the fs; -F lets mke2fs write a plain file.
        assert!(
            argv.windows(2)
                .any(|w| w == ["-d", "/run/lantern/certs/vm-1/img-src"])
        );
        assert!(argv.iter().any(|a| a == "-F"));
        assert!(argv.iter().any(|a| a == "ext4"));
        // image path then block count are the trailing positional args.
        assert_eq!(argv[argv.len() - 2], "/run/lantern/certs/vm-1/certs.img");
        assert_eq!(argv.last().unwrap(), "1024");
    }

    #[test]
    fn spawn_invocation_without_jailer_is_bare_firecracker() {
        // jailer None (the env-unset default) ⇒ exact pre-jailer invocation.
        let cfg = SpawnConfig {
            binary_path: "/usr/bin/firecracker".to_string(),
            socket_path: "/run/firecracker/vm-1.sock".to_string(),
            vm_id: "vm-1".to_string(),
            jailer: None,
        };
        let (program, argv) = build_spawn_invocation(&cfg);
        assert_eq!(program, "/usr/bin/firecracker");
        assert_eq!(argv, vec!["--api-sock", "/run/firecracker/vm-1.sock"]);
    }

    #[test]
    fn spawn_invocation_with_jailer_wraps_and_uses_in_jail_socket() {
        let jailer = jailer_with_defaults();
        let cfg = SpawnConfig {
            binary_path: "/usr/bin/firecracker".to_string(),
            // Host-visible socket (what the manager polls/connects to).
            socket_path: jailer.host_api_socket_path("/usr/bin/firecracker", "vm-9"),
            vm_id: "vm-9".to_string(),
            jailer: Some(jailer),
        };
        let (program, argv) = build_spawn_invocation(&cfg);
        assert_eq!(program, "/usr/bin/jailer");

        // Defaults land in the jailer flags.
        let sep = argv.iter().position(|a| a == "--").expect("-- present");
        assert!(argv[..sep].windows(2).any(|w| w == ["--uid", "123"]));
        assert!(argv[..sep].windows(2).any(|w| w == ["--gid", "100"]));
        assert!(
            argv[..sep]
                .windows(2)
                .any(|w| w == ["--chroot-base-dir", "/srv/jailer"])
        );
        assert!(argv[..sep].windows(2).any(|w| w == ["--id", "vm-9"]));

        // Inside the jail, firecracker gets the chroot-RELATIVE socket —
        // never the host-expanded one.
        assert_eq!(&argv[sep + 1..], ["--api-sock", JAILED_API_SOCKET]);
        assert!(
            !argv[sep + 1..].iter().any(|a| a.contains("/srv/jailer")),
            "host chroot prefix must not leak into in-jail firecracker args"
        );
    }

    // -----------------------------------------------------------------------
    // 11. Jailed snapshot restore (pure construction + store lookup)
    //
    // Construction-only coverage: load-body paths, staging plan destinations
    // + ownership set, snapshot-URI parsing, S3 key matching, and the local
    // store scan (tempdir).  No firecracker/jailer exec — the live jailed
    // load is LINUX-RUNTIME-ONLY (microvm CI / Lima).
    // -----------------------------------------------------------------------

    #[test]
    fn snapshot_load_body_jailed_uses_in_jail_relative_paths() {
        let body = build_snapshot_load_body(
            true,
            "/var/lib/lantern/snapshots/av/vm/id/snapshot",
            "/var/lib/lantern/snapshots/av/vm/id/mem",
        );
        // In-jail RELATIVE paths only — the host staging locations must
        // never be sent to the chrooted firecracker.
        assert_eq!(body.snapshot_path, JAILED_SNAPSHOT_VMSTATE);
        assert_eq!(body.snapshot_path, "/snapshot/vmstate");
        assert_eq!(body.mem_backend.backend_type, "File");
        assert_eq!(body.mem_backend.backend_path, JAILED_SNAPSHOT_MEM);
        assert_eq!(body.mem_backend.backend_path, "/snapshot/mem");
        // Existing restore semantics: resume immediately, diff snapshots on.
        assert_eq!(body.enable_diff_snapshots, Some(true));
        assert_eq!(body.resume_vm, Some(true));

        let json: serde_json::Value = serde_json::to_value(&body).unwrap();
        assert_eq!(json["snapshot_path"], "/snapshot/vmstate");
        assert_eq!(json["mem_backend"]["backend_path"], "/snapshot/mem");
        assert!(
            !serde_json::to_string(&body).unwrap().contains("/var/lib"),
            "host paths must not leak into the jailed load body"
        );
    }

    #[test]
    fn snapshot_load_body_bare_matches_legacy_host_path_contract() {
        let body = build_snapshot_load_body(
            false,
            "/run/lantern/snapshots/vm-1/snapshot",
            "/run/lantern/snapshots/vm-1/mem",
        );
        // Byte-identical to the body the pre-jailer restore always sent.
        assert_eq!(
            body,
            SnapshotLoadParams {
                snapshot_path: "/run/lantern/snapshots/vm-1/snapshot".to_string(),
                mem_backend: MemBackend {
                    backend_type: "File".to_string(),
                    backend_path: "/run/lantern/snapshots/vm-1/mem".to_string(),
                },
                enable_diff_snapshots: Some(true),
                resume_vm: Some(true),
            }
        );
    }

    #[test]
    fn parse_snapshot_source_store_uri() {
        assert_eq!(
            parse_snapshot_source("store://4a5b6c7d-0000-1111-2222-333344445555"),
            SnapshotSource::Store {
                snapshot_id: "4a5b6c7d-0000-1111-2222-333344445555".to_string()
            }
        );
    }

    #[test]
    fn parse_snapshot_source_fc_and_bare_paths_use_sibling_mem_file() {
        // The mem file is the vmstate's SIBLING named `mem` — and the
        // `/snapshots/` directory segment must survive intact (the legacy
        // substring-replace would have mangled it to `/mems/`).
        let fc = parse_snapshot_source("fc:///run/lantern/snapshots/vm-1/snapshot");
        assert_eq!(
            fc,
            SnapshotSource::HostPath {
                vmstate_path: "/run/lantern/snapshots/vm-1/snapshot".to_string(),
                mem_path: "/run/lantern/snapshots/vm-1/mem".to_string(),
            }
        );
        let bare = parse_snapshot_source("/snaps/vm-2/snapshot");
        assert_eq!(
            bare,
            SnapshotSource::HostPath {
                vmstate_path: "/snaps/vm-2/snapshot".to_string(),
                mem_path: "/snaps/vm-2/mem".to_string(),
            }
        );
    }

    #[test]
    fn jailed_snapshot_staging_plan_destinations_under_chroot() {
        let plan = plan_jailed_snapshot_staging(
            "/srv/jailer/firecracker/vm-new/root",
            "vm-new",
            "/var/lib/lantern/snapshots/av/vm-old/snap-1/snapshot",
            "/var/lib/lantern/snapshots/av/vm-old/snap-1/mem",
        );
        assert_eq!(
            plan.copies,
            vec![
                (
                    "/var/lib/lantern/snapshots/av/vm-old/snap-1/snapshot".to_string(),
                    "/srv/jailer/firecracker/vm-new/root/snapshot/vmstate".to_string(),
                ),
                (
                    "/var/lib/lantern/snapshots/av/vm-old/snap-1/mem".to_string(),
                    "/srv/jailer/firecracker/vm-new/root/snapshot/mem".to_string(),
                ),
            ]
        );
        // Directories are parent-before-child so create_dir_all + chown can
        // run in order; the set mirrors the boot-time staging dirs plus the
        // restore staging dir.
        assert_eq!(
            plan.dirs,
            vec![
                "/srv/jailer/firecracker/vm-new/root".to_string(),
                "/srv/jailer/firecracker/vm-new/root/run".to_string(),
                "/srv/jailer/firecracker/vm-new/root/run/lantern".to_string(),
                "/srv/jailer/firecracker/vm-new/root/run/lantern/vsock".to_string(),
                "/srv/jailer/firecracker/vm-new/root/run/lantern/snapshots".to_string(),
                "/srv/jailer/firecracker/vm-new/root/run/lantern/snapshots/vm-new".to_string(),
                "/srv/jailer/firecracker/vm-new/root/snapshot".to_string(),
            ]
        );
        for (i, dir) in plan.dirs.iter().enumerate().skip(1) {
            assert!(
                plan.dirs[..i].iter().any(|d| dir.starts_with(d.as_str())),
                "dir {dir} must come after a parent"
            );
        }

        // Trailing slash on the chroot root must not double the separator.
        let slashed =
            plan_jailed_snapshot_staging("/srv/j/fc/vm/root/", "vm", "/a/snapshot", "/a/mem");
        assert!(
            slashed.copies[0]
                .1
                .starts_with("/srv/j/fc/vm/root/snapshot/")
        );
        assert!(!slashed.copies[0].1.contains("//"));
    }

    #[test]
    fn jailed_snapshot_staging_ownership_covers_every_staged_path() {
        let plan = plan_jailed_snapshot_staging(
            "/srv/jailer/firecracker/vm-x/root",
            "vm-x",
            "/store/snap",
            "/store/mem",
        );
        let owned: std::collections::HashSet<&str> = plan.owned_paths().into_iter().collect();
        // Every directory and every copied artifact is chowned to the jail
        // uid/gid — the dropped-privilege firecracker must be able to open
        // the artifacts and bind sockets in the directories.
        for dir in &plan.dirs {
            assert!(owned.contains(dir.as_str()), "dir {dir} must be chowned");
        }
        for (_, dest) in &plan.copies {
            assert!(owned.contains(dest.as_str()), "copy {dest} must be chowned");
        }
        assert_eq!(
            owned.len(),
            plan.dirs.len() + plan.copies.len(),
            "ownership set is exactly the staged paths"
        );
    }

    #[test]
    fn find_snapshot_keys_requires_both_artifacts_in_same_dir() {
        let keys = vec![
            "snapshots/av1/vm1/snap-a/meta.json".to_string(),
            "snapshots/av1/vm1/snap-a/snapshot".to_string(),
            "snapshots/av1/vm1/snap-a/mem".to_string(),
            "snapshots/av2/vm9/snap-b/snapshot".to_string(), // mem missing
        ];
        assert_eq!(
            find_snapshot_keys_in_listing(&keys, "snap-a"),
            Some((
                "snapshots/av1/vm1/snap-a/snapshot".to_string(),
                "snapshots/av1/vm1/snap-a/mem".to_string(),
            ))
        );
        // Half-uploaded snapshot (mem absent) is treated as not found.
        assert_eq!(find_snapshot_keys_in_listing(&keys, "snap-b"), None);
        // Unknown id.
        assert_eq!(find_snapshot_keys_in_listing(&keys, "snap-zzz"), None);
    }

    #[tokio::test]
    async fn resolve_store_snapshot_finds_local_artifacts() {
        let root = tempfile::TempDir::new().unwrap();
        let dir = root.path().join("agent-v1").join("vm-old").join("snap-123");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("snapshot"), b"vmstate-bytes")
            .await
            .unwrap();
        tokio::fs::write(dir.join("mem"), b"mem-bytes")
            .await
            .unwrap();
        tokio::fs::write(dir.join("meta.json"), b"{}")
            .await
            .unwrap();

        let none: Option<&dyn object_store::ObjectStore> = None;
        let (vmstate, mem) = resolve_store_snapshot(root.path(), none, "snap-123")
            .await
            .expect("snapshot must be found locally");
        assert_eq!(vmstate, dir.join("snapshot"));
        assert_eq!(mem, dir.join("mem"));
    }

    #[tokio::test]
    async fn resolve_store_snapshot_missing_id_is_not_found_error() {
        let root = tempfile::TempDir::new().unwrap();
        // Store root exists but holds a different snapshot.
        let other = root.path().join("av").join("vm").join("snap-other");
        tokio::fs::create_dir_all(&other).await.unwrap();
        tokio::fs::write(other.join("snapshot"), b"x")
            .await
            .unwrap();
        tokio::fs::write(other.join("mem"), b"y").await.unwrap();

        let none: Option<&dyn object_store::ObjectStore> = None;
        let err = resolve_store_snapshot(root.path(), none, "snap-ghost")
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("not found"),
            "must be a not-found error: {err}"
        );
        assert!(
            err.contains("snap-ghost"),
            "must name the missing id: {err}"
        );
        assert!(
            err.contains("not configured"),
            "must say the S3 tier was not configured: {err}"
        );
    }

    #[tokio::test]
    async fn resolve_store_snapshot_missing_root_is_not_found_error() {
        let root = tempfile::TempDir::new().unwrap();
        let nonexistent = root.path().join("never-created");
        let none: Option<&dyn object_store::ObjectStore> = None;
        let err = resolve_store_snapshot(&nonexistent, none, "snap-1")
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("not found"),
            "must be a not-found error: {err}"
        );
    }

    #[tokio::test]
    async fn resolve_store_snapshot_incomplete_entry_is_corruption_error() {
        let root = tempfile::TempDir::new().unwrap();
        let dir = root.path().join("av").join("vm").join("snap-half");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        // vmstate present, mem missing → corrupt entry, not "absent".
        tokio::fs::write(dir.join("snapshot"), b"x").await.unwrap();

        let none: Option<&dyn object_store::ObjectStore> = None;
        let err = resolve_store_snapshot(root.path(), none, "snap-half")
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("incomplete"),
            "must flag the corrupt entry, not report not-found: {err}"
        );
    }

    #[tokio::test]
    async fn restore_jailed_with_missing_store_snapshot_does_not_exec() {
        // End-to-end through restore(): jailer configured, snapshot id
        // absent → the not-found error fires BEFORE any staging or spawn.
        // `available` is forced true to get past the gate; no firecracker
        // or jailer binary is ever exec'd because resolution fails first.
        //
        // No env mutation (set_var is unsafe + racy under the parallel test
        // runner): a freshly generated UUID cannot exist in whatever store
        // root / S3 tier the environment points at, so resolution is
        // guaranteed to miss.
        let mut backend = FirecrackerBackend::new();
        backend.available = true;
        backend.binary_path = Some("/usr/bin/firecracker".to_string());
        backend.jailer = Some(jailer_with_defaults());

        let missing_id = Uuid::new_v4().to_string();
        let uri = format!("store://{missing_id}");
        let req = crate::proto::RestoreRequest {
            snapshot_uri: uri.clone(),
            run_id: "run-1".to_string(),
            input: serde_json::Value::Null,
            env: HashMap::new(),
            secrets: vec![],
        };
        let err = backend.restore(&uri, &req).await.unwrap_err().to_string();

        assert!(
            err.contains("not found"),
            "must be a not-found error: {err}"
        );
        assert!(err.contains(&missing_id), "must name the id: {err}");
        assert!(
            backend.processes.is_empty(),
            "no process may be spawned when resolution fails"
        );
    }
}
