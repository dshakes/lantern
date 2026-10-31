// PID 1 init duties: mount tmpfs, set rlimits, prep directories.
//
// On non-Linux developer hosts (macOS) these calls are no-ops with a log
// line; on Linux inside the microVM they actually take effect.

use anyhow::Result;

/// Boot the guest: prep /run/pal, mount tmpfs on /tmp, set rlimits.
pub async fn boot() -> Result<()> {
    let run_dir = std::env::var("PAL_RUN_DIR").unwrap_or_else(|_| "/run/pal".to_string());
    if let Err(e) = tokio::fs::create_dir_all(&run_dir).await {
        tracing::warn!(error = %e, %run_dir, "init: could not create run dir (continuing)");
    }

    #[cfg(target_os = "linux")]
    {
        mount_tmpfs();
        set_rlimits();
        loopback_up();
    }
    #[cfg(not(target_os = "linux"))]
    {
        tracing::info!("init: non-linux host, skipping tmpfs mount + rlimits");
    }

    Ok(())
}

/// Bring `lo` up. Nothing else does in a broker-mode guest (ADR 0026): with
/// no NIC there is no kernel `ip=` autoconfig, which was what used to raise
/// loopback, and the egress forwarder (127.0.0.1:3128) and every workload's
/// `HTTP(S)_PROXY` need it. Idempotent; harmless when `lo` is already up.
#[cfg(target_os = "linux")]
fn loopback_up() {
    // SAFETY: plain socket(2); closed below on every path.
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        tracing::warn!(error = %std::io::Error::last_os_error(), "init: cannot open socket to raise lo");
        return;
    }
    // SAFETY: ifreq is plain-old-data; zeroed is valid. "lo\0" fits IFNAMSIZ.
    let mut ifr: libc::ifreq = unsafe { std::mem::zeroed() };
    for (dst, src) in ifr.ifr_name.iter_mut().zip(b"lo\0") {
        *dst = *src as libc::c_char;
    }
    // SAFETY: SIOCGIFFLAGS/SIOCSIFFLAGS read/write `ifr`, which outlives both calls.
    let ok = unsafe {
        libc::ioctl(fd, libc::SIOCGIFFLAGS as _, &mut ifr) == 0 && {
            ifr.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
            libc::ioctl(fd, libc::SIOCSIFFLAGS as _, &ifr) == 0
        }
    };
    if !ok {
        tracing::warn!(error = %std::io::Error::last_os_error(), "init: could not bring lo up");
    }
    // SAFETY: closing the fd we opened above.
    unsafe { libc::close(fd) };
}

#[cfg(target_os = "linux")]
fn mount_tmpfs() {
    // Direct libc::mount — nix's wrapper signature varies across versions
    // and we want this code to be portable across nix bumps. /tmp may
    // already be tmpfs from the VM image; if so we treat EBUSY as success.
    let src = c"tmpfs";
    let target = c"/tmp";
    let fstype = c"tmpfs";
    let data = c"size=512m,mode=1777";
    // MS_NOSUID | MS_NODEV
    let flags: libc::c_ulong = 0x2 | 0x4;
    let rc = unsafe {
        libc::mount(
            src.as_ptr(),
            target.as_ptr(),
            fstype.as_ptr(),
            flags,
            data.as_ptr() as *const _,
        )
    };
    if rc == 0 {
        tracing::info!("init: /tmp tmpfs mounted");
    } else {
        let errno = std::io::Error::last_os_error();
        if errno.raw_os_error() == Some(libc::EBUSY) {
            tracing::info!("init: /tmp already mounted, skipping");
        } else {
            tracing::warn!(error = %errno, "init: tmpfs mount failed (continuing)");
        }
    }
}

#[cfg(target_os = "linux")]
// glibc types RLIMIT_* as u32 (cast is a no-op there); musl uses c_int.
#[allow(clippy::unnecessary_cast)]
fn set_rlimits() {
    // Cap open files at 4096 — generous for workload, prevents fd-exhaust DoS.
    do_setrlimit(libc::RLIMIT_NOFILE as u32, 4096);
    if let Ok(bytes) = std::env::var("PAL_RLIMIT_AS_BYTES")
        .and_then(|s| s.parse::<u64>().map_err(|_| std::env::VarError::NotPresent))
    {
        do_setrlimit(libc::RLIMIT_AS as u32, bytes);
    }
}

#[cfg(target_os = "linux")]
fn do_setrlimit(resource: u32, value: u64) {
    let rlim = libc::rlimit {
        rlim_cur: value as libc::rlim_t,
        rlim_max: value as libc::rlim_t,
    };
    // SAFETY: setrlimit is the standard POSIX call. The resource arg is
    // typed differently on glibc (`__rlimit_resource_t` newtype-u32) vs
    // musl (`c_int`); the `as _` lets the trampoline coerce to whichever
    // the platform expects.
    let rc = unsafe { libc::setrlimit(resource as _, &rlim) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        tracing::warn!(resource, error = %err, "init: setrlimit failed");
    }
}
