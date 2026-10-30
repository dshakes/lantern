//! Kernel-command-line → environment bootstrap.
//!
//! In a Firecracker microVM the harness is PID 1. There is no shell, no init
//! script, and no parent process to export variables: the kernel hands the VM
//! its parameters on the **command line**, while every other harness module
//! reads configuration from the **environment**.
//!
//! The manager encodes the spawn contract as `pal.*` keys in boot-args
//! (see runtime-manager `backends/firecracker.rs::build_boot_args`, whose
//! comment says "so the init process can export them into the harness
//! environment" — the harness *is* that init process). Nothing performed that
//! translation, so `parse_env` saw an empty environment, failed on the first
//! required variable, and PID 1 exiting panicked the guest kernel
//! ("Attempted to kill init!"). This module is that missing step.
//!
//! Backends that inject a real environment (docker, K8s) are unaffected: an
//! existing variable always wins, and a host without `/proc/cmdline` is a
//! silent no-op.

/// Where the kernel exposes the boot command line.
const CMDLINE_PATH: &str = "/proc/cmdline";

/// In-guest mount point for the per-VM cert drive.
#[cfg(target_os = "linux")]
const CERT_MOUNT: &str = "/run/pal/certs";

/// Block devices to probe for the cert drive.
///
/// Firecracker exposes drives as virtio-blk in configuration order — rootfs is
/// `/dev/vda` and the cert drive `/dev/vdb` — but nothing in the API contract
/// guarantees that, so probe a few and verify the contents before trusting one.
#[cfg(target_os = "linux")]
const CERT_DEVICE_CANDIDATES: [&str; 3] = ["/dev/vdb", "/dev/vdc", "/dev/vdd"];

/// Filenames the manager packs at the root of `certs.img`
/// (see runtime-manager `backends/firecracker.rs::build_cert_image`).
#[cfg(target_os = "linux")]
const CERT_FILES: [&str; 3] = ["tls.crt", "tls.key", "manager-ca.crt"];

/// Spawn contract the manager writes at the root of the cert drive.
#[cfg(target_os = "linux")]
const SPAWN_FILE: &str = "spawn.json";

/// Harness-only (0700) home for the mTLS material once copied off the drive.
///
/// The drive's file modes are whatever the host-side image builder produced,
/// and the workload now runs as an unprivileged uid that may well match the
/// host uid that owns them. Copying into a root-owned 0700 dir and unmounting
/// the drive makes "the workload cannot read tls.key (or spawn.json's env)"
/// true by construction instead of by image-builder convention.
#[cfg(target_os = "linux")]
const PRIVATE_DIR: &str = "/run/pal/harness";

/// The manager→harness spawn contract (`spawn.json` on the cert drive).
///
/// Exists because the kernel command line cannot carry it: args split on
/// whitespace and quotes are stripped, so `python main.py` or a JSON egress
/// list arrived mangled. Every field is optional; unknown fields are ignored
/// so the manager can add fields ahead of a harness release.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct SpawnContract {
    pub version: u32,
    pub workload_cmd: Option<Vec<String>>,
    pub env: std::collections::BTreeMap<String, String>,
    pub egress_rules: Option<Vec<crate::proto::EgressRule>>,
    pub workload_uid: Option<u32>,
    pub workload_gid: Option<u32>,
    /// This VM's identity (== the cert CN on the same drive). Re-read on
    /// resume detection — see `reidentify.rs`.
    pub vm_id: Option<String>,
    pub declared_secrets: Option<Vec<crate::proto::SecretRef>>,
    /// Point-to-point addressing; only used to re-address a restored guest
    /// (a cold boot is configured by the kernel's `ip=`).
    pub network: Option<GuestNetwork>,
    /// Per-incarnation exec-server bearer (→ `PAL_HARNESS_EXEC_TOKEN`).
    pub exec_token: Option<String>,
    /// The manager's environment class (→ `PAL_ENV`). Typed, so it can
    /// never come from the caller-supplied `env` map.
    pub pal_env: Option<String>,
    /// `"broker"` → no NIC; egress is bridged over vsock to the host-side
    /// broker (ADR 0026). Absent → legacy in-guest proxy.
    pub egress_mode: Option<String>,
    /// PEM of the per-VM broker CA (public) the workload must trust for
    /// hosts with a credential-injection rule.
    pub egress_ca_pem: Option<String>,
    /// Guest→host vsock ports for egress and the manager control channel.
    pub vsock_egress_port: Option<u32>,
    pub vsock_manager_port: Option<u32>,
}

/// `PAL_*` keys a caller may legitimately put in the workload env (agent
/// identity, trace parent, crash-resume marker). Any other `PAL_*` key is
/// harness configuration — `PAL_ENV`, egress, workload uid, … — and only
/// the manager's typed fields / own boot-args may set it. Keep in sync with
/// the manager's `service::CALLER_PAL_KEYS`.
pub const CALLER_PAL_KEYS: [&str; 4] = [
    "PAL_AGENT_INSTANCE_ID",
    "PAL_AGENT_INSTANCE_TOKEN",
    "PAL_TRACE_PARENT",
    "PAL_RESUME",
];

/// `pal.env.PAL_*` boot-args the MANAGER itself emits (not caller env;
/// the manager strips caller `PAL_*` keys before building boot-args).
const MANAGER_CMDLINE_KEYS: [&str; 3] = [
    "PAL_MANAGER_ADDR",
    "PAL_WORKLOAD_UID",
    "PAL_ENV",
];

/// Identity keys the MANAGER stamps into the free-form env from the request's
/// authenticated typed fields, after stripping any caller-supplied value
/// (runtime-manager `service::own_workload_env`). Accepted on the env channel
/// (`spawn.json` `env` / `pal.env.*`) because that is how the manager
/// sends them; the harness itself never reads them — they are for the
/// workload SDK.
const MANAGER_IDENTITY_KEYS: [&str; 2] = ["PAL_TENANT_ID", "PAL_AGENT_VERSION_ID"];

/// Whether a free-form env key may be applied: anything outside the
/// `PAL_`/`PAL_` namespaces, an allowlisted caller key, or a
/// manager-stamped identity key. EVERY `PAL_*` key is dropped (ADR 0032):
/// nothing upstream stamps or replaces `PAL_` identity yet, so even the twin
/// of a legitimate caller key (`PAL_AGENT_INSTANCE_TOKEN`) is caller-chosen.
/// Relax only when the writers flip (rename plan step 4).
fn caller_key_allowed(key: &str) -> bool {
    !key.starts_with("PAL_")
        && (!key.starts_with("PAL_")
            || CALLER_PAL_KEYS.contains(&key)
            || MANAGER_IDENTITY_KEYS.contains(&key))
}

/// `spawn.json` `network` — this VM's /30 (manager = `host_ip`).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(default)]
pub struct GuestNetwork {
    pub guest_ip: String,
    pub host_ip: String,
    pub netmask: String,
}

pub fn parse_spawn_contract(bytes: &[u8]) -> serde_json::Result<SpawnContract> {
    serde_json::from_slice(bytes)
}

/// The environment a contract publishes, one entry per key. A free-form
/// `env` entry is dropped when a typed field sets the same key, so it can never
/// override the uid/argv/egress the manager set explicitly.
pub fn contract_env_pairs(c: &SpawnContract) -> serde_json::Result<Vec<(String, String)>> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    if let Some(argv) = c.workload_cmd.as_ref().filter(|a| !a.is_empty()) {
        // ARGV is authoritative (see main.rs::parse_env); CMD is kept for
        // logs and older readers.
        pairs.push(("PAL_WORKLOAD_ARGV".into(), serde_json::to_string(argv)?));
        pairs.push(("PAL_WORKLOAD_CMD".into(), argv.join(" ")));
    }
    if let Some(rules) = &c.egress_rules {
        pairs.push(("PAL_EGRESS_RULES".into(), serde_json::to_string(rules)?));
    }
    if let Some(uid) = c.workload_uid {
        pairs.push(("PAL_WORKLOAD_UID".into(), uid.to_string()));
    }
    if let Some(gid) = c.workload_gid {
        pairs.push(("PAL_WORKLOAD_GID".into(), gid.to_string()));
    }
    if let Some(t) = c.exec_token.as_ref().filter(|t| !t.is_empty()) {
        pairs.push(("PAL_HARNESS_EXEC_TOKEN".into(), t.clone()));
    }
    if let Some(vm_id) = c.vm_id.as_ref().filter(|v| !v.is_empty()) {
        pairs.push(("PAL_VM_ID".into(), vm_id.clone()));
    }
    if let Some(secrets) = c.declared_secrets.as_ref().filter(|s| !s.is_empty()) {
        pairs.push((
            "PAL_DECLARED_SECRETS".into(),
            serde_json::to_string(secrets)?,
        ));
    }
    if let Some(env) = c.pal_env.as_ref().filter(|e| !e.is_empty()) {
        pairs.push(("PAL_ENV".into(), env.clone()));
    }
    if let Some(mode) = c.egress_mode.as_ref().filter(|m| !m.is_empty()) {
        pairs.push(("PAL_EGRESS_MODE".into(), mode.clone()));
    }
    if let Some(pem) = c.egress_ca_pem.as_ref().filter(|p| !p.is_empty()) {
        pairs.push(("PAL_EGRESS_CA_PEM".into(), pem.clone()));
    }
    if let Some(port) = c.vsock_egress_port.filter(|p| *p != 0) {
        pairs.push(("PAL_EGRESS_VSOCK_PORT".into(), port.to_string()));
    }
    if let Some(port) = c.vsock_manager_port.filter(|p| *p != 0) {
        pairs.push(("PAL_MANAGER_VSOCK_PORT".into(), port.to_string()));
    }
    let typed = pairs.len();
    let mut dropped: Vec<&str> = Vec::new();
    for (k, v) in &c.env {
        if !caller_key_allowed(k) {
            dropped.push(k);
        } else if !pairs[..typed].iter().any(|(t, _)| t == k) {
            pairs.push((k.clone(), v.clone()));
        }
    }
    if !dropped.is_empty() {
        // Names only — values may be sensitive.
        tracing::warn!(keys = ?dropped, "bootenv: ignored PAL_*/PAL_* keys in spawn.json env (harness config is manager-owned)");
    }
    Ok(pairs)
}

/// Turn the raw `spawn.json` read into env pairs, applying the malformed-file
/// policy: prod refuses to boot (a half-understood contract must not run a
/// workload with cmdline-derived — i.e. mangled — argv/egress/uid); dev warns
/// and falls back to the cmdline.
pub fn resolve_spawn_contract(
    raw: std::io::Result<Option<Vec<u8>>>,
    prod: bool,
) -> anyhow::Result<Vec<(String, String)>> {
    let parsed = raw
        .map_err(anyhow::Error::from)
        .and_then(|bytes| match bytes {
            None => Ok(None),
            Some(b) => {
                let c = parse_spawn_contract(&b)?;
                Ok(Some(contract_env_pairs(&c)?))
            }
        });
    match parsed {
        Ok(None) => Ok(Vec::new()),
        Ok(Some(pairs)) => {
            // Names only — `env` values may be sensitive.
            let names: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
            tracing::info!(vars = ?names, "bootenv: applied spawn.json contract");
            Ok(pairs)
        }
        Err(e) if prod => Err(e.context(
            "spawn.json is present but unreadable/malformed; refusing to start the workload \
             in production",
        )),
        Err(e) => {
            tracing::warn!(error = %e, "bootenv: spawn.json malformed — falling back to boot-args (dev)");
            Ok(Vec::new())
        }
    }
}

/// Boot-args pairs with the spawn contract layered on top: any key the
/// contract sets is never taken from the (lossy) command line.
pub fn layer_boot_env(
    cmdline: Vec<(String, String)>,
    contract: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = cmdline
        .into_iter()
        .filter(|(k, _)| !contract.iter().any(|(c, _)| c == k))
        .collect();
    out.extend(contract);
    out
}

/// Copy the drive's cert files into `dst` (created/forced 0700, files 0600)
/// and return the copies' paths in `CERT_FILES` order.
#[cfg(any(target_os = "linux", test))]
fn stash_private(
    src: &std::path::Path,
    dst: &std::path::Path,
    names: &[&str],
) -> std::io::Result<Vec<std::path::PathBuf>> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dst)?;
    // Pre-existing dir: force the mode, never trust it.
    std::fs::set_permissions(dst, std::fs::Permissions::from_mode(0o700))?;
    names
        .iter()
        .map(|name| {
            let to = dst.join(name);
            std::fs::copy(src.join(name), &to)?;
            std::fs::set_permissions(&to, std::fs::Permissions::from_mode(0o600))?;
            Ok(to)
        })
        .collect()
}

/// Set when this process mounted procfs itself, so `bootstrap` can report it
/// once tracing exists — `ensure_procfs` may run before the subscriber does.
#[cfg(target_os = "linux")]
static PROCFS_MOUNTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The log filter carried in boot-args, if any.
///
/// Split out so the selection is testable without touching `/proc` or process
/// environment.
pub fn log_filter_from_cmdline(cmdline: &str) -> Option<String> {
    env_from_cmdline(cmdline)
        .into_iter()
        .find(|(name, _)| name == "RUST_LOG")
        .map(|(_, value)| value)
}

/// Publish `RUST_LOG` from boot-args BEFORE the tracing subscriber is built.
///
/// `EnvFilter::try_from_default_env` reads `RUST_LOG` once, at initialisation.
/// The rest of the boot-args bridge runs after that — deliberately, so its work
/// is visible in the log — which left no way to configure logging from
/// boot-args at all: a `pal.env.RUST_LOG=...` was applied long after the
/// filter had been fixed. Diagnosing a guest therefore meant editing the
/// harness's compiled-in default and rebuilding the image.
///
/// So this one variable is resolved first, silently (there is nothing to log
/// to yet). Everything else stays in `bootstrap`, which runs after the
/// subscriber exists. An explicit `RUST_LOG` in the environment still wins.
pub fn preinit_log_filter() {
    if std::env::var_os("RUST_LOG").is_some() {
        return;
    }
    ensure_procfs();
    let Ok(cmdline) = std::fs::read_to_string(CMDLINE_PATH) else {
        return;
    };
    if let Some(filter) = log_filter_from_cmdline(&cmdline) {
        // SAFETY: `main` runs this before it builds the Tokio runtime, so the
        // process is still single-threaded. See the contract on `main`.
        unsafe { std::env::set_var("RUST_LOG", filter) };
    }
}

/// Prepare the environment for a microVM boot.
///
/// Order matters: the cert drive is mounted BEFORE boot-args are translated, so
/// the in-guest TLS paths are already published and the boot-args' host paths
/// (which never resolve in the guest) are correctly ignored.
///
/// Errors only when `spawn.json` is malformed in production — the caller must
/// then refuse to start the workload.
pub fn bootstrap() -> anyhow::Result<()> {
    ensure_procfs();
    #[cfg(target_os = "linux")]
    if PROCFS_MOUNTED.load(std::sync::atomic::Ordering::Relaxed) {
        tracing::debug!("bootenv: mounted /proc");
    }
    report_entropy_source();
    let spawn = mount_cert_drive();
    // Decide prod-ness before the contract is applied (whether a malformed
    // contract is fatal cannot depend on that same contract) — but from the
    // boot-args too, which are not hydrated yet: on Firecracker that is where
    // PAL_ENV arrives.
    let cmdline = std::fs::read_to_string(CMDLINE_PATH).ok();
    let prod = boot_is_prod(
        std::env::var("PAL_ENV").ok().as_deref(),
        cmdline.as_deref(),
    );
    let contract = resolve_spawn_contract(spawn, prod)?;
    hydrate_env_from_cmdline(contract);
    assemble_declared_secrets();
    pin_manager_hostname();
    Ok(())
}

/// Whether this boot is production, for decisions taken before boot-args are
/// hydrated. Prod if EITHER the process env or the boot-args say so. An
/// unreadable cmdline counts as prod: it is only in doubt inside a guest
/// (spawn.json only exists where the cert drive mounts, i.e. Linux with
/// procfs), and there doubt must fail closed.
pub fn boot_is_prod(process_env: Option<&str>, cmdline: Option<&str>) -> bool {
    if process_env.is_some_and(crate::tls::is_prod_value) {
        return true;
    }
    let Some(cmdline) = cmdline else {
        return true;
    };
    env_from_cmdline(cmdline)
        .iter()
        .any(|(k, v)| k == "PAL_ENV" && crate::tls::is_prod_value(v))
}

/// Rebuild `PAL_DECLARED_SECRETS` from the per-secret boot-args keys.
///
/// The manager emits one `pal.secret.<ENV_NAME>=<uri>` per declared secret
/// (a JSON blob cannot survive the kernel command line: args are
/// whitespace-separated and quotes are stripped from values). The rest of the
/// harness reads a JSON array, so assemble it here.
///
/// Without this the secret cache sees nothing declared and refuses every
/// request, so a spec declaring secrets behaves exactly like one declaring
/// none — VendSecret is never reached.
fn assemble_declared_secrets() {
    // An explicitly-provided value wins, as everywhere else in this module.
    if std::env::var_os("PAL_DECLARED_SECRETS").is_some() {
        return;
    }
    let Ok(cmdline) = std::fs::read_to_string(CMDLINE_PATH) else {
        return;
    };

    let declared: Vec<serde_json::Value> = cmdline
        .split_whitespace()
        .filter_map(|token| token.split_once('='))
        .filter_map(|(key, uri)| {
            key.strip_prefix("pal.secret.")
                .filter(|name| !name.is_empty() && !uri.is_empty())
                .map(|name| serde_json::json!({ "env_name": name, "secret_uri": uri }))
        })
        .collect();

    if declared.is_empty() {
        return;
    }
    let count = declared.len();
    match serde_json::to_string(&declared) {
        Ok(json) => {
            // SAFETY: single-threaded startup — see the contract on `main`.
            unsafe { std::env::set_var("PAL_DECLARED_SECRETS", &json) };
            // Names only — a secret URI can identify sensitive material.
            tracing::info!(count, "bootenv: assembled declared secrets from boot-args");
        }
        Err(e) => tracing::warn!(error = %e, "bootenv: could not encode declared secrets"),
    }
}

/// Name the manager is reached by from inside the guest.
///
/// Must match a DNS SAN on the manager's server certificate.
pub(crate) const MANAGER_HOSTNAME: &str = "manager.pal.internal";

/// Make the manager reachable by NAME rather than by address.
///
/// Every microVM sits on its own point-to-point link, so the manager's address
/// differs per VM (172.16.x.1) and can never be a certificate SAN. The intended
/// fix was `ClientTlsConfig::domain_name`, but rustls is observably still
/// verifying against `IpAddress(172.16.x.1)` — the override does not reach the
/// connection — so the server certificate is checked against an address it was
/// never issued for.
///
/// Pin the name in `/etc/hosts` and dial that instead. The URI itself then
/// carries a DNS name, so the TLS server name is correct by construction and
/// does not depend on a library override taking effect. One certificate with a
/// `DNS:manager.pal.internal` SAN covers every VM.
///
/// Best-effort: if the address cannot be parsed or `/etc/hosts` cannot be
/// written, the original address is left in place and the connection behaves
/// exactly as before.
fn pin_manager_hostname() {
    let Ok(addr) = std::env::var("PAL_MANAGER_ADDR") else {
        return;
    };
    // Only an IP literal needs pinning; a name already resolves.
    let Some((host, port)) = addr.rsplit_once(':') else {
        return;
    };
    if host.parse::<std::net::Ipv4Addr>().is_err() {
        return;
    }

    let entry = format!("{host}\t{MANAGER_HOSTNAME}\n");
    let existing = std::fs::read_to_string("/etc/hosts").unwrap_or_default();
    if !existing.contains(MANAGER_HOSTNAME) {
        let contents = if existing.is_empty() {
            format!("127.0.0.1\tlocalhost\n{entry}")
        } else {
            format!("{existing}{entry}")
        };
        if let Err(e) = std::fs::write("/etc/hosts", contents) {
            tracing::warn!(error = %e, "bootenv: cannot write /etc/hosts; dialing the manager by IP");
            return;
        }
    }

    let named = format!("{MANAGER_HOSTNAME}:{port}");
    // SAFETY: single-threaded startup — see the contract on `main`.
    unsafe { std::env::set_var("PAL_MANAGER_ADDR", &named) };
    tracing::info!(
        manager_ip = host,
        manager_addr = %named,
        "bootenv: pinned the manager hostname so TLS verifies against a name, not an address"
    );
}

/// Report whether the guest has a usable kernel entropy source.
///
/// A minimal rootfs ships an empty `/dev`, and every TLS handshake needs
/// randomness. If `/dev/urandom` is missing or unreadable the failure surfaces
/// far from its cause, so state it plainly at boot.
fn report_entropy_source() {
    let path = std::path::Path::new("/dev/urandom");
    if !path.exists() {
        tracing::error!(
            "entropy: /dev/urandom is ABSENT — TLS and any RNG-dependent path will fail"
        );
        return;
    }
    // Existing but unreadable is just as fatal, and looks identical from afar.
    let mut probe = [0u8; 16];
    match std::fs::File::open(path).and_then(|mut f| std::io::Read::read(&mut f, &mut probe)) {
        Ok(n) if n > 0 => tracing::debug!(bytes = n, "entropy: /dev/urandom readable"),
        Ok(_) => tracing::error!("entropy: /dev/urandom returned no bytes"),
        Err(e) => tracing::error!(error = %e, "entropy: /dev/urandom unreadable"),
    }
}

/// Mount procfs if `/proc/cmdline` is not readable yet.
///
/// As PID 1 in a microVM the harness starts with nothing mounted — the rootfs
/// ships an empty `/proc` directory and mounting it is an init duty. Without
/// this, the command line simply cannot be read and every boot parameter is
/// silently lost. Best-effort: an already-mounted procfs (EBUSY) or a failure
/// both fall through, and the caller degrades to "no boot-args".
#[cfg(target_os = "linux")]
fn ensure_procfs() {
    if std::path::Path::new(CMDLINE_PATH).exists() {
        return;
    }
    let src = c"proc";
    let target = c"/proc";
    let fstype = c"proc";
    // MS_NOSUID | MS_NODEV | MS_NOEXEC
    let flags: libc::c_ulong = 0x2 | 0x4 | 0x8;
    let rc = unsafe {
        libc::mount(
            src.as_ptr(),
            target.as_ptr(),
            fstype.as_ptr(),
            flags,
            std::ptr::null(),
        )
    };
    if rc == 0 {
        // Cannot log yet: this may run before tracing is initialised (see
        // `preinit_log_filter`). Record it and let `bootstrap` report it.
        PROCFS_MOUNTED.store(true, std::sync::atomic::Ordering::Relaxed);
    } else {
        let errno = std::io::Error::last_os_error();
        if errno.raw_os_error() != Some(libc::EBUSY) {
            tracing::warn!(error = %errno, "bootenv: /proc mount failed; boot-args unavailable");
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn ensure_procfs() {}

/// Mount the read-only per-VM cert drive and publish the in-guest TLS paths.
///
/// The manager provisions each VM's mTLS material into a small ext4 image and
/// attaches it as a second, read-only drive — "the guest must never be able to
/// rewrite its own identity". It names that material by HOST path in boot-args,
/// which cannot resolve inside the guest; the drive has to be mounted and the
/// paths rewritten to where they actually live. Nothing did that, so the
/// harness→manager channel silently stayed plaintext.
///
/// Mounted `MS_RDONLY` (plus nosuid/nodev/noexec) to preserve the read-only
/// property the manager relies on. Best-effort: any failure leaves the TLS env
/// unset, which degrades to the plaintext channel rather than refusing to boot.
///
/// Returns the raw `spawn.json` from the drive root (`Ok(None)` when there is
/// no drive or no file). The drive is UNMOUNTED before returning, after its
/// cert material is copied into the harness-only `PRIVATE_DIR` — see there.
/// The block device the cert drive was found on at boot — what the
/// re-identify watcher polls (`reidentify.rs`).
static CERT_DEVICE: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

pub fn cert_device() -> Option<&'static str> {
    CERT_DEVICE.get().copied()
}

/// What one mount of the cert drive yielded.
#[cfg(target_os = "linux")]
pub struct CertDriveLoad {
    /// Raw `spawn.json` (`Ok(None)` when absent).
    pub spawn: std::io::Result<Option<Vec<u8>>>,
    /// Paths of the harness-only copies (cert, key, CA), when stashed.
    pub private: Option<Vec<std::path::PathBuf>>,
}

/// Mount `device`, verify it is the cert drive, copy its material into the
/// harness-only dir (overwriting — the paths stay the same, so every later
/// connect presents whatever identity is there now), read `spawn.json`,
/// unmount. `None` when `device` is not the cert drive.
#[cfg(target_os = "linux")]
pub fn load_cert_device(device: &str) -> Option<CertDriveLoad> {
    if !std::path::Path::new(device).exists() || !mount_ro_ext4(device, CERT_MOUNT) {
        return None;
    }
    // Verify this really is the cert drive before trusting anything —
    // probing means we may have just mounted some other volume.
    let is_cert_drive = CERT_FILES
        .iter()
        .all(|name| std::path::Path::new(&format!("{CERT_MOUNT}/{name}")).exists());
    if !is_cert_drive {
        // Wrong volume: leave nothing mounted behind for the next candidate.
        umount(CERT_MOUNT);
        return None;
    }
    let spawn = match std::fs::read(format!("{CERT_MOUNT}/{SPAWN_FILE}")) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    };
    let private = match stash_private(
        std::path::Path::new(CERT_MOUNT),
        std::path::Path::new(PRIVATE_DIR),
        &CERT_FILES,
    ) {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!(error = %e, "certs: cannot stash cert material");
            None
        }
    };
    // Nothing on the drive may stay reachable by the workload uid.
    if !umount(CERT_MOUNT) {
        tracing::error!(
            mount = CERT_MOUNT,
            error = %std::io::Error::last_os_error(),
            "certs: SECURITY could not unmount the cert drive — its files remain \
             subject to the image's file modes"
        );
    }
    Some(CertDriveLoad { spawn, private })
}

#[cfg(target_os = "linux")]
fn mount_cert_drive() -> std::io::Result<Option<Vec<u8>>> {
    // Already resolvable — a real environment was injected (docker/K8s), or
    // this ran once already. Never re-mount over working material.
    if std::env::var_os("PAL_VM_TLS_CERT")
        .map(|p| std::path::Path::new(&p).exists())
        .unwrap_or(false)
    {
        return Ok(None);
    }

    if let Err(e) = std::fs::create_dir_all(CERT_MOUNT) {
        tracing::warn!(error = %e, dir = CERT_MOUNT, "certs: cannot create cert mount point");
        return Ok(None);
    }

    for device in CERT_DEVICE_CANDIDATES {
        let Some(load) = load_cert_device(device) else {
            continue;
        };
        let _ = CERT_DEVICE.set(device);
        match load.private {
            Some(private) => {
                // SAFETY: single-threaded startup — see the contract on `main`.
                unsafe {
                    std::env::set_var("PAL_VM_TLS_CERT", &private[0]);
                    std::env::set_var("PAL_VM_TLS_KEY", &private[1]);
                    std::env::set_var("PAL_MANAGER_TLS_CA", &private[2]);
                }
                tracing::info!(
                    device,
                    private_dir = PRIVATE_DIR,
                    "certs: per-VM cert drive copied to harness-only dir — \
                     harness→manager channel is mTLS"
                );
            }
            None => tracing::warn!(
                "certs: cannot stash cert material — harness→manager channel will be PLAINTEXT"
            ),
        }
        return load.spawn;
    }

    tracing::warn!(
        candidates = ?CERT_DEVICE_CANDIDATES,
        "certs: no per-VM cert drive found — harness→manager channel will be PLAINTEXT"
    );
    Ok(None)
}

#[cfg(not(target_os = "linux"))]
fn mount_cert_drive() -> std::io::Result<Option<Vec<u8>>> {
    Ok(None)
}

/// Mount `device` at `target` as read-only ext4. Returns whether it succeeded.
#[cfg(target_os = "linux")]
fn mount_ro_ext4(device: &str, target: &str) -> bool {
    use std::ffi::CString;
    let (Ok(src), Ok(tgt), Ok(fstype)) = (
        CString::new(device),
        CString::new(target),
        CString::new("ext4"),
    ) else {
        return false;
    };
    // MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC
    let flags: libc::c_ulong = 0x1 | 0x2 | 0x4 | 0x8;
    let rc = unsafe {
        libc::mount(
            src.as_ptr(),
            tgt.as_ptr(),
            fstype.as_ptr(),
            flags,
            std::ptr::null(),
        )
    };
    rc == 0
}

#[cfg(target_os = "linux")]
fn umount(target: &str) -> bool {
    std::ffi::CString::new(target)
        .map(|t| unsafe { libc::umount(t.as_ptr()) } == 0)
        .unwrap_or(false)
}

/// Map one boot-arg key to the environment variable the harness reads.
///
/// Returns `None` for kernel parameters that are not part of the PAL
/// contract (`console=`, `panic=`, `pci=off`, …).
fn cmdline_key_to_env(key: &str) -> Option<String> {
    // `pal.env.FOO=bar` carries caller-supplied env through verbatim.
    // `PAL_*` names are harness config: only the manager's own keys and
    // the caller allowlist are honoured (a caller value that slipped through an
    // older manager must not configure the harness).
    if let Some(name) = key.strip_prefix("pal.env.") {
        let ok =
            !name.is_empty() && (caller_key_allowed(name) || MANAGER_CMDLINE_KEYS.contains(&name));
        return ok.then(|| name.to_string());
    }
    let mapped = match key {
        "pal.vm_id" => "PAL_VM_ID",
        "pal.run_id" => "PAL_RUN_ID",
        "pal.tls_cert" => "PAL_VM_TLS_CERT",
        "pal.tls_key" => "PAL_VM_TLS_KEY",
        "pal.manager_ca" => "PAL_MANAGER_TLS_CA",
        // Not emitted by the manager yet; recognised so it can start sending
        // one without requiring a matching harness release.
        "pal.workload_cmd" => "PAL_WORKLOAD_CMD",
        _ => return None,
    };
    Some(mapped.to_string())
}

/// Parse a kernel command line into `(env_name, value)` pairs.
///
/// Split on whitespace because that is how the kernel tokenises it — which
/// also means a value containing a space cannot survive the trip.
pub fn env_from_cmdline(cmdline: &str) -> Vec<(String, String)> {
    cmdline
        .split_whitespace()
        .filter_map(|token| token.split_once('='))
        .filter_map(|(key, value)| cmdline_key_to_env(key).map(|name| (name, value.to_string())))
        .collect()
}

/// Populate the process environment from `/proc/cmdline`.
///
/// MUST be called from `main` before any configuration is read and before any
/// threads are spawned: `set_var` mutates process-global state and is unsound
/// once other threads are running.
///
/// Values are never logged — `pal.env.*` carries caller-supplied data that
/// may be sensitive (invariant: secrets never appear in logs). Only the names
/// that were set are traced.
///
/// `contract` (from `spawn.json`) takes precedence over boot-args for every
/// key it sets.
pub fn hydrate_env_from_cmdline(contract: Vec<(String, String)>) {
    ensure_procfs();

    // No procfs (non-Linux, or a container without /proc): the contract alone.
    let cmdline = std::fs::read_to_string(CMDLINE_PATH).unwrap_or_default();

    let mut applied: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();

    for (name, value) in layer_boot_env(env_from_cmdline(&cmdline), contract) {
        // An explicitly-provided environment always wins over boot-args.
        if std::env::var_os(&name).is_some() {
            continue;
        }
        // The manager names its mTLS material by HOST path; those files reach
        // the guest on a separate cert drive that nothing mounts yet (guest
        // mTLS is planned — see manager_client.rs). Publishing a path that
        // does not resolve is worse than publishing nothing: the TLS builder
        // would take its "certs declared" branch and fail hard, instead of
        // falling back to the plaintext channel that works today.
        if is_guest_path_var(&name) && !std::path::Path::new(&value).exists() {
            unresolved.push(name);
            continue;
        }
        // SAFETY: single-threaded startup — `main` does all of this before the
        // Tokio runtime exists, so no other thread can be reading the
        // environment concurrently. See the contract on `main`.
        unsafe { std::env::set_var(&name, &value) };
        applied.push(name);
    }

    if !applied.is_empty() {
        tracing::debug!(vars = ?applied, "hydrated environment from kernel cmdline");
    }
    if !unresolved.is_empty() {
        // Loud, not silent: this is the difference between an mTLS channel and
        // a plaintext one.
        tracing::warn!(
            vars = ?unresolved,
            "bootenv: manager declared mTLS material but the paths do not resolve in-guest \
             (cert drive not mounted) — falling back to a plaintext manager channel"
        );
    }
}

/// Variables whose value is an in-guest file path, and which are therefore only
/// worth publishing when that file actually resolves.
fn is_guest_path_var(name: &str) -> bool {
    matches!(
        name,
        "PAL_VM_TLS_CERT" | "PAL_VM_TLS_KEY" | "PAL_MANAGER_TLS_CA"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_filter_is_picked_out_of_boot_args() {
        // The whole point: a filter passed as a boot-arg must be findable
        // before tracing exists.
        let cmdline = "console=ttyS0 pal.vm_id=vm-1 \
             pal.env.RUST_LOG=info,rustls=trace pal.env.OTHER=x";
        assert_eq!(
            log_filter_from_cmdline(cmdline).as_deref(),
            Some("info,rustls=trace")
        );
    }

    #[test]
    fn no_log_filter_in_boot_args_is_none() {
        assert!(log_filter_from_cmdline("console=ttyS0 pal.vm_id=vm-1").is_none());
        assert!(log_filter_from_cmdline("").is_none());
    }

    #[test]
    fn maps_the_documented_contract_keys() {
        let cmdline = "console=ttyS0 reboot=k panic=1 pci=off \
             pal.vm_id=vm-123 pal.run_id=run-9 \
             pal.tls_cert=/run/pal/certs/vm-123/tls.crt \
             pal.tls_key=/run/pal/certs/vm-123/tls.key \
             pal.manager_ca=/run/pal/certs/manager-ca.crt";
        let got = env_from_cmdline(cmdline);

        let lookup = |k: &str| {
            got.iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .unwrap_or_default()
        };
        assert_eq!(lookup("PAL_VM_ID"), "vm-123");
        assert_eq!(lookup("PAL_RUN_ID"), "run-9");
        assert_eq!(
            lookup("PAL_VM_TLS_CERT"),
            "/run/pal/certs/vm-123/tls.crt"
        );
        assert_eq!(
            lookup("PAL_VM_TLS_KEY"),
            "/run/pal/certs/vm-123/tls.key"
        );
        assert_eq!(
            lookup("PAL_MANAGER_TLS_CA"),
            "/run/pal/certs/manager-ca.crt"
        );
    }

    #[test]
    fn ignores_ordinary_kernel_parameters() {
        // Regression guard: only `pal.*` keys may become environment.
        let got = env_from_cmdline("console=ttyS0 reboot=k panic=1 root=/dev/vda rw");
        assert!(
            got.is_empty(),
            "unexpected env from plain kernel args: {got:?}"
        );
    }

    #[test]
    fn passes_pal_env_prefixed_vars_through_verbatim() {
        let got = env_from_cmdline("pal.env.MY_FLAG=on pal.env.OTHER=2");
        assert!(got.contains(&("MY_FLAG".to_string(), "on".to_string())));
        assert!(got.contains(&("OTHER".to_string(), "2".to_string())));
    }

    #[test]
    fn tolerates_junk_without_panicking() {
        // Bare flags (no '='), an empty suffix, and a trailing newline as read
        // from procfs must all be survivable — this runs before anything else
        // in the VM, so a panic here is an unbootable guest.
        let got = env_from_cmdline("quiet pal.env.= pal.vm_id=vm-1 \n");
        assert_eq!(got, vec![("PAL_VM_ID".to_string(), "vm-1".to_string())]);
    }

    #[test]
    fn spawn_contract_parses_full_schema_and_ignores_unknown_fields() {
        let c = parse_spawn_contract(
            br#"{"version":1,"workload_cmd":["python","main.py"],"env":{"K":"V"},
                "egress_rules":[{"pattern":"api.example.com","http_methods":["GET"],"rate_bps":0}],
                "workload_uid":1000,"workload_gid":1001,"future_field":{"x":1}}"#,
        )
        .expect("valid contract");
        let pairs = contract_env_pairs(&c).expect("encodable");
        let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        // Spaces survive — the whole point of the file.
        assert_eq!(
            get("PAL_WORKLOAD_ARGV").as_deref(),
            Some(r#"["python","main.py"]"#)
        );
        assert_eq!(
            get("PAL_WORKLOAD_CMD").as_deref(),
            Some("python main.py")
        );
        assert_eq!(get("K").as_deref(), Some("V"));
        assert_eq!(get("PAL_WORKLOAD_UID").as_deref(), Some("1000"));
        assert_eq!(get("PAL_WORKLOAD_GID").as_deref(), Some("1001"));
        let rules: Vec<crate::proto::EgressRule> =
            serde_json::from_str(&get("PAL_EGRESS_RULES").unwrap_or_default())
                .expect("egress JSON round-trips");
        assert_eq!(rules[0].pattern, "api.example.com");
        assert_eq!(rules[0].http_methods, vec!["GET".to_string()]);
    }

    #[test]
    fn spawn_contract_broker_fields_map_to_env() {
        let c = parse_spawn_contract(
            br#"{"version":1,"egress_mode":"broker","egress_ca_pem":"-----BEGIN CERTIFICATE-----\nX\n",
                "vsock_egress_port":3128,"vsock_manager_port":50054,
                "egress_rules":[{"pattern":"api.openai.com","inject":[{"header":"Authorization","secret_uri":"pal.secret://t/k"}]}]}"#,
        )
        .expect("broker contract");
        let pairs = contract_env_pairs(&c).expect("encodable");
        let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("PAL_EGRESS_MODE").as_deref(), Some("broker"));
        assert!(get("PAL_EGRESS_CA_PEM").is_some_and(|p| p.starts_with("-----BEGIN")));
        assert_eq!(get("PAL_EGRESS_VSOCK_PORT").as_deref(), Some("3128"));
        assert_eq!(get("PAL_MANAGER_VSOCK_PORT").as_deref(), Some("50054"));
        // An injection spec (should one ever arrive) is dropped, not parsed
        // into the guest's rules — the manager strips it anyway.
        assert!(
            !get("PAL_EGRESS_RULES")
                .unwrap_or_default()
                .contains("secret")
        );
    }

    #[test]
    fn spawn_contract_without_broker_fields_is_legacy_mode() {
        // An older manager's spawn.json: no broker keys → no broker env, so
        // the harness runs the in-guest proxy exactly as before.
        let c = parse_spawn_contract(br#"{"version":1,"egress_rules":[{"pattern":"x.com"}]}"#)
            .expect("legacy contract");
        let pairs = contract_env_pairs(&c).expect("encodable");
        for k in [
            "PAL_EGRESS_MODE",
            "PAL_EGRESS_CA_PEM",
            "PAL_EGRESS_VSOCK_PORT",
            "PAL_MANAGER_VSOCK_PORT",
        ] {
            assert!(pairs.iter().all(|(n, _)| n != k), "{k} must be absent");
        }
    }

    #[test]
    fn spawn_contract_all_fields_optional() {
        let c = parse_spawn_contract(b"{}").expect("empty object is valid");
        assert!(contract_env_pairs(&c).expect("encodable").is_empty());
        // A partial egress rule takes defaults rather than failing the file.
        let c = parse_spawn_contract(br#"{"egress_rules":[{"pattern":"x"}]}"#).expect("partial");
        assert_eq!(c.egress_rules.map(|r| r[0].rate_bps), Some(0));
    }

    #[test]
    fn typed_contract_fields_beat_free_form_env() {
        // A user-supplied `env` entry must not override the manager's uid.
        let c =
            parse_spawn_contract(br#"{"env":{"PAL_WORKLOAD_UID":"0"},"workload_uid":1000}"#)
                .expect("valid");
        let pairs = contract_env_pairs(&c).expect("encodable");
        let uids: Vec<&str> = pairs
            .iter()
            .filter(|(k, _)| k == "PAL_WORKLOAD_UID")
            .map(|(_, v)| v.as_str())
            .collect();
        // One entry per key (hydration keeps the first value it sees).
        assert_eq!(uids, vec!["1000"]);
    }

    /// ADR 0032: every caller `PAL_*` key is dropped — harness config,
    /// forged identity, and even the twin of a legitimate caller key, which
    /// nothing upstream stamps or replaces under the `PAL_` name.
    #[test]
    fn caller_pal_keys_are_all_dropped() {
        let c = parse_spawn_contract(
            br#"{"env":{
                "PAL_WORKLOAD_UID":"0","PAL_ENV":"dev","PAL_EGRESS_FAIL_CLOSED":"0",
                "PAL_HARNESS_EXEC_TOKEN":"forged","PAL_TENANT_ID":"other-tenant",
                "PAL_RESUME":"1","PAL_TRACE_PARENT":"00-abc-def-01",
                "PAL_AGENT_INSTANCE_ID":"i","PAL_AGENT_INSTANCE_TOKEN":"caller-chosen",
                "PAL_RESUME":"1",
                "PAL_TENANT_ID":"t1","KEEP":"1"
            }}"#,
        )
        .expect("valid");
        let pairs = contract_env_pairs(&c).expect("encodable");
        let mut keys: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["KEEP", "PAL_RESUME", "PAL_TENANT_ID"]);
    }

    #[test]
    fn spawn_contract_takes_precedence_over_cmdline() {
        let cmdline = env_from_cmdline(
            "pal.vm_id=vm-1 pal.workload_cmd=python \
             pal.env.PAL_WORKLOAD_UID=0 pal.env.KEEP=1",
        );
        let c =
            parse_spawn_contract(br#"{"workload_cmd":["python","main.py"],"workload_uid":1000}"#)
                .expect("valid");
        let got = layer_boot_env(cmdline, contract_env_pairs(&c).expect("encodable"));
        let all = |k: &str| -> Vec<&str> {
            got.iter()
                .filter(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .collect()
        };
        // Exactly one value per contract key, and it is the contract's.
        assert_eq!(all("PAL_WORKLOAD_CMD"), vec!["python main.py"]);
        assert_eq!(all("PAL_WORKLOAD_UID"), vec!["1000"]);
        // Keys the contract does not set still come from boot-args.
        assert_eq!(all("PAL_VM_ID"), vec!["vm-1"]);
        assert_eq!(all("KEEP"), vec!["1"]);
    }

    /// Caller env (spawn.json `env` / `pal.env.*`) cannot set harness
    /// config: PAL_ENV=dev from the caller on a prod manager stays prod;
    /// egress/proxy knobs are ignored; agent identity keys pass through.
    #[test]
    fn caller_env_cannot_set_harness_security_config() {
        let contract = parse_spawn_contract(
            br#"{"pal_env":"prod","env":{
                "PAL_ENV":"dev","PAL_EGRESS_FAIL_CLOSED":"0",
                "PAL_NO_PROXY":"*","PAL_EGRESS_RULES":"[]",
                "PAL_WORKLOAD_UID":"0","PAL_AGENT_INSTANCE_ID":"inst",
                "PAL_AGENT_INSTANCE_TOKEN":"tok","FOO":"bar",
                "PAL_TENANT_ID":"t-auth","PAL_AGENT_VERSION_ID":"av-1"}}"#,
        )
        .unwrap();
        let pairs = contract_env_pairs(&contract).unwrap();
        let get = |k: &str| {
            pairs
                .iter()
                .filter(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(get("PAL_ENV"), ["prod"]);
        for k in [
            "PAL_EGRESS_FAIL_CLOSED",
            "PAL_NO_PROXY",
            "PAL_EGRESS_RULES",
            "PAL_WORKLOAD_UID",
        ] {
            assert!(get(k).is_empty(), "{k} must not come from caller env");
        }
        assert_eq!(get("PAL_AGENT_INSTANCE_ID"), ["inst"]);
        assert_eq!(get("PAL_AGENT_INSTANCE_TOKEN"), ["tok"]);
        assert_eq!(get("FOO"), ["bar"]);
        // Manager-stamped identity (the manager strips any caller value first).
        assert_eq!(get("PAL_TENANT_ID"), ["t-auth"]);
        assert_eq!(get("PAL_AGENT_VERSION_ID"), ["av-1"]);

        // Boot-args: same rule; the manager's own keys still apply.
        let cmd = env_from_cmdline(
            "pal.env.PAL_EGRESS_FAIL_CLOSED=0 pal.env.PAL_NO_PROXY=* \
             pal.env.PAL_HARNESS_EXEC_TOKEN=x pal.env.PAL_MANAGER_ADDR=10.0.0.1:50054 \
             pal.env.PAL_ENV=prod pal.env.PAL_WORKLOAD_UID=1000 \
             pal.env.PAL_AGENT_INSTANCE_ID=inst pal.env.FOO=bar \
             pal.env.PAL_TENANT_ID=t-auth",
        );
        let names: Vec<&str> = cmd.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            [
                "PAL_MANAGER_ADDR",
                "PAL_ENV",
                "PAL_WORKLOAD_UID",
                "PAL_AGENT_INSTANCE_ID",
                "FOO",
                "PAL_TENANT_ID"
            ]
        );

        // Prod manager, caller "dev" in spawn.json env only, no typed field
        // (older manager): the manager's boot-arg PAL_ENV=prod wins.
        let old = parse_spawn_contract(br#"{"env":{"PAL_ENV":"dev"}}"#).unwrap();
        let layered = layer_boot_env(
            env_from_cmdline("pal.env.PAL_ENV=prod"),
            contract_env_pairs(&old).unwrap(),
        );
        assert_eq!(layered, vec![("PAL_ENV".into(), "prod".into())]);
    }

    /// PAL_ENV carried only in boot-args (the Firecracker path) must make
    /// a malformed spawn.json fatal even though boot-args are hydrated later.
    #[test]
    fn prod_from_boot_args_makes_malformed_contract_fatal() {
        let cmd =
            |env: &str| format!("console=ttyS0 pal.vm_id=v pal.env.PAL_ENV={env}");
        assert!(boot_is_prod(None, Some(&cmd("prod"))));
        assert!(boot_is_prod(None, Some(&cmd("Staging"))));
        assert!(!boot_is_prod(None, Some(&cmd("dev"))));
        assert!(!boot_is_prod(None, Some("console=ttyS0")));
        // Process env alone still counts; a dev cmdline cannot downgrade it.
        assert!(boot_is_prod(Some("production"), Some(&cmd("dev"))));
        // No cmdline to read: in doubt → prod (fail closed).
        assert!(boot_is_prod(None, None));

        let bad = Ok(Some(b"not json".to_vec()));
        assert!(resolve_spawn_contract(bad, boot_is_prod(None, Some(&cmd("prod")))).is_err());
    }

    #[test]
    fn malformed_spawn_contract_is_fatal_in_prod_and_ignored_in_dev() {
        let bad = || Ok(Some(b"{\"workload_cmd\": \"python main.py\"}".to_vec()));
        assert!(resolve_spawn_contract(bad(), true).is_err());
        assert!(
            resolve_spawn_contract(bad(), false)
                .expect("dev falls back")
                .is_empty()
        );

        let garbage = || Ok(Some(b"not json".to_vec()));
        assert!(resolve_spawn_contract(garbage(), true).is_err());

        let unreadable = || Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(resolve_spawn_contract(unreadable(), true).is_err());
        assert!(
            resolve_spawn_contract(unreadable(), false)
                .expect("dev")
                .is_empty()
        );

        // Absent file is the normal cmdline path, prod or not.
        assert!(
            resolve_spawn_contract(Ok(None), true)
                .expect("absent")
                .is_empty()
        );
        let ok = resolve_spawn_contract(Ok(Some(br#"{"workload_uid":7}"#.to_vec())), true)
            .expect("valid in prod");
        assert_eq!(ok, vec![("PAL_WORKLOAD_UID".into(), "7".into())]);
    }

    #[test]
    fn cert_material_is_stashed_harness_only() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("pal-stash-{}", std::process::id()));
        let src = base.join("drive");
        let dst = base.join("private");
        std::fs::create_dir_all(&src).expect("mk src");
        for n in ["tls.crt", "tls.key", "manager-ca.crt"] {
            std::fs::write(src.join(n), n).expect("write");
            std::fs::set_permissions(src.join(n), std::fs::Permissions::from_mode(0o644))
                .expect("chmod");
        }
        // A pre-existing, too-open dir must be tightened, not trusted.
        std::fs::create_dir_all(&dst).expect("mk dst");
        std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let out =
            stash_private(&src, &dst, &["tls.crt", "tls.key", "manager-ca.crt"]).expect("stash");
        let mode =
            |p: &std::path::Path| std::fs::metadata(p).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode(&dst), 0o700);
        assert_eq!(out[1], dst.join("tls.key"));
        assert_eq!(mode(&out[1]), 0o600);
        assert_eq!(std::fs::read_to_string(&out[1]).expect("read"), "tls.key");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn contract_identity_and_secrets_beat_the_cmdline() {
        // spawn.json is the identity of record: the cmdline copy is frozen in
        // guest memory and may name a snapshot's source VM.
        let c = parse_spawn_contract(
            br#"{"vm_id":"vm-new","declared_secrets":[{"env_name":"K","secret_uri":"u"}]}"#,
        )
        .expect("valid");
        let got = layer_boot_env(
            env_from_cmdline("pal.vm_id=vm-old"),
            contract_env_pairs(&c).expect("encodable"),
        );
        let get = |k: &str| got.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PAL_VM_ID"), Some("vm-new"));
        assert_eq!(
            get("PAL_DECLARED_SECRETS"),
            Some(r#"[{"env_name":"K","secret_uri":"u"}]"#)
        );
        let c = parse_spawn_contract(
            br#"{"exec_token":"tok","env":{"PAL_HARNESS_EXEC_TOKEN":"forged"}}"#,
        )
        .expect("valid");
        let pairs = contract_env_pairs(&c).expect("ok");
        let toks: Vec<&str> = pairs
            .iter()
            .filter(|(k, _)| k == "PAL_HARNESS_EXEC_TOKEN")
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(toks, vec!["tok"], "typed token beats free-form env");
        // An empty vm_id never overrides the cmdline.
        let c = parse_spawn_contract(br#"{"vm_id":""}"#).expect("valid");
        assert!(contract_env_pairs(&c).expect("ok").is_empty());
    }

    #[test]
    fn keeps_values_containing_equals() {
        // split_once means only the FIRST '=' delimits; base64/query-ish
        // values must survive intact.
        let got = env_from_cmdline("pal.env.TOKEN=abc=def==");
        assert_eq!(got, vec![("TOKEN".to_string(), "abc=def==".to_string())]);
    }
}
