//! Kernel-command-line → environment bootstrap.
//!
//! In a Firecracker microVM the harness is PID 1. There is no shell, no init
//! script, and no parent process to export variables: the kernel hands the VM
//! its parameters on the **command line**, while every other harness module
//! reads configuration from the **environment**.
//!
//! The manager encodes the spawn contract as `lantern.*` keys in boot-args
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
const CERT_MOUNT: &str = "/run/lantern/certs";

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

/// Prepare the environment for a microVM boot.
///
/// Order matters: the cert drive is mounted BEFORE boot-args are translated, so
/// the in-guest TLS paths are already published and the boot-args' host paths
/// (which never resolve in the guest) are correctly ignored.
pub fn bootstrap() {
    ensure_procfs();
    mount_cert_drive();
    hydrate_env_from_cmdline();
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
        tracing::debug!("bootenv: mounted /proc");
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
#[cfg(target_os = "linux")]
fn mount_cert_drive() {
    // Already resolvable — a real environment was injected (docker/K8s), or
    // this ran once already. Never re-mount over working material.
    if std::env::var_os("LANTERN_VM_TLS_CERT")
        .map(|p| std::path::Path::new(&p).exists())
        .unwrap_or(false)
    {
        return;
    }

    if let Err(e) = std::fs::create_dir_all(CERT_MOUNT) {
        tracing::warn!(error = %e, dir = CERT_MOUNT, "certs: cannot create cert mount point");
        return;
    }

    for device in CERT_DEVICE_CANDIDATES {
        if !std::path::Path::new(device).exists() || !mount_ro_ext4(device, CERT_MOUNT) {
            continue;
        }

        // Verify this really is the cert drive before publishing anything —
        // probing means we may have just mounted some other volume.
        let paths: Vec<String> = CERT_FILES
            .iter()
            .map(|name| format!("{CERT_MOUNT}/{name}"))
            .collect();
        if paths.iter().all(|p| std::path::Path::new(p).exists()) {
            // SAFETY: called from main before any thread is spawned.
            unsafe {
                std::env::set_var("LANTERN_VM_TLS_CERT", &paths[0]);
                std::env::set_var("LANTERN_VM_TLS_KEY", &paths[1]);
                std::env::set_var("LANTERN_MANAGER_TLS_CA", &paths[2]);
            }
            tracing::info!(
                device,
                mount = CERT_MOUNT,
                "certs: mounted per-VM cert drive (read-only) — harness→manager channel is mTLS"
            );
            return;
        }

        // Wrong volume: leave nothing mounted behind for the next candidate.
        umount(CERT_MOUNT);
    }

    tracing::warn!(
        candidates = ?CERT_DEVICE_CANDIDATES,
        "certs: no per-VM cert drive found — harness→manager channel will be PLAINTEXT"
    );
}

#[cfg(not(target_os = "linux"))]
fn mount_cert_drive() {}

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
fn umount(target: &str) {
    if let Ok(t) = std::ffi::CString::new(target) {
        unsafe { libc::umount(t.as_ptr()) };
    }
}

/// Map one boot-arg key to the environment variable the harness reads.
///
/// Returns `None` for kernel parameters that are not part of the Lantern
/// contract (`console=`, `panic=`, `pci=off`, …).
fn cmdline_key_to_env(key: &str) -> Option<String> {
    // `lantern.env.FOO=bar` carries caller-supplied env through verbatim.
    if let Some(name) = key.strip_prefix("lantern.env.") {
        return (!name.is_empty()).then(|| name.to_string());
    }
    let mapped = match key {
        "lantern.vm_id" => "LANTERN_VM_ID",
        "lantern.run_id" => "LANTERN_RUN_ID",
        "lantern.tls_cert" => "LANTERN_VM_TLS_CERT",
        "lantern.tls_key" => "LANTERN_VM_TLS_KEY",
        "lantern.manager_ca" => "LANTERN_MANAGER_TLS_CA",
        // Not emitted by the manager yet; recognised so it can start sending
        // one without requiring a matching harness release.
        "lantern.workload_cmd" => "LANTERN_WORKLOAD_CMD",
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
/// Values are never logged — `lantern.env.*` carries caller-supplied data that
/// may be sensitive (invariant: secrets never appear in logs). Only the names
/// that were set are traced.
pub fn hydrate_env_from_cmdline() {
    ensure_procfs();

    let Ok(cmdline) = std::fs::read_to_string(CMDLINE_PATH) else {
        // No procfs (non-Linux, or a container without /proc): nothing to do.
        return;
    };

    let mut applied: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();

    for (name, value) in env_from_cmdline(&cmdline) {
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
        // SAFETY: called from main before any thread is spawned, so no other
        // thread can be reading the environment concurrently.
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
        "LANTERN_VM_TLS_CERT" | "LANTERN_VM_TLS_KEY" | "LANTERN_MANAGER_TLS_CA"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_documented_contract_keys() {
        let cmdline = "console=ttyS0 reboot=k panic=1 pci=off \
             lantern.vm_id=vm-123 lantern.run_id=run-9 \
             lantern.tls_cert=/run/lantern/certs/vm-123/tls.crt \
             lantern.tls_key=/run/lantern/certs/vm-123/tls.key \
             lantern.manager_ca=/run/lantern/certs/manager-ca.crt";
        let got = env_from_cmdline(cmdline);

        let lookup = |k: &str| {
            got.iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .unwrap_or_default()
        };
        assert_eq!(lookup("LANTERN_VM_ID"), "vm-123");
        assert_eq!(lookup("LANTERN_RUN_ID"), "run-9");
        assert_eq!(
            lookup("LANTERN_VM_TLS_CERT"),
            "/run/lantern/certs/vm-123/tls.crt"
        );
        assert_eq!(
            lookup("LANTERN_VM_TLS_KEY"),
            "/run/lantern/certs/vm-123/tls.key"
        );
        assert_eq!(
            lookup("LANTERN_MANAGER_TLS_CA"),
            "/run/lantern/certs/manager-ca.crt"
        );
    }

    #[test]
    fn ignores_ordinary_kernel_parameters() {
        // Regression guard: only `lantern.*` keys may become environment.
        let got = env_from_cmdline("console=ttyS0 reboot=k panic=1 root=/dev/vda rw");
        assert!(
            got.is_empty(),
            "unexpected env from plain kernel args: {got:?}"
        );
    }

    #[test]
    fn passes_lantern_env_prefixed_vars_through_verbatim() {
        let got = env_from_cmdline("lantern.env.MY_FLAG=on lantern.env.OTHER=2");
        assert!(got.contains(&("MY_FLAG".to_string(), "on".to_string())));
        assert!(got.contains(&("OTHER".to_string(), "2".to_string())));
    }

    #[test]
    fn tolerates_junk_without_panicking() {
        // Bare flags (no '='), an empty suffix, and a trailing newline as read
        // from procfs must all be survivable — this runs before anything else
        // in the VM, so a panic here is an unbootable guest.
        let got = env_from_cmdline("quiet lantern.env.= lantern.vm_id=vm-1 \n");
        assert_eq!(got, vec![("LANTERN_VM_ID".to_string(), "vm-1".to_string())]);
    }

    #[test]
    fn keeps_values_containing_equals() {
        // split_once means only the FIRST '=' delimits; base64/query-ish
        // values must survive intact.
        let got = env_from_cmdline("lantern.env.TOKEN=abc=def==");
        assert_eq!(got, vec![("TOKEN".to_string(), "abc=def==".to_string())]);
    }
}
