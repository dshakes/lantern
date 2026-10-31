//! Re-identify a guest that was restored from a snapshot (ADR 0025 addendum).
//!
//! A Firecracker snapshot freezes guest memory, so a restored harness resumes
//! believing it is the SOURCE VM: same vm_id, same private key, same secret
//! cache, same IP config. Resume (same wire vm_id, new incarnation) and fork
//! (N new vm_ids from one snapshot) both need the guest to become the VM the
//! manager just spawned.
//!
//! Mechanism: before resuming, the manager swaps the read-only cert drive's
//! backing file for a freshly built image (new cert CN/SAN = new vm_id, new
//! key, the restoring request's `spawn.json`). Every image is a fresh
//! `mke2fs`, so its ext4 UUID differs. This watcher polls that UUID; on a
//! change it reloads the drive — new cert/key/CA overwrite the harness-only
//! copies in place (TLS config is re-read on every connect), clears the
//! secret cache, adopts the new declared secrets + egress rules, re-addresses
//! eth0, and bumps the client's identity generation so Heartbeat/Report
//! reconnect under the new cert. Until it does, the manager's per-incarnation
//! cert pin refuses the stale identity (fail-closed).
//!
//! What is NOT re-applied: the workload's argv/env/uid. The restored workload
//! is already running — that state is what the snapshot exists to preserve.

use std::sync::Arc;
use std::time::Duration;

use crate::bootenv::{GuestNetwork, SpawnContract};
use crate::egress::EgressPolicy;
use crate::manager_client::ManagerClient;
use crate::proto::{AuditEvent, EgressRule, HarnessReport, SecretRef, now_unix_ms};
use crate::secrets::SecretCache;

/// Poll cadence — the upper bound on how long a restored guest runs under
/// the stale (already pinned-out, so inert) identity, and so on the first
/// exec after resume/fork (the manager waits for the new identity).
/// A dead manager stream also triggers an immediate read (`restore_hinted`):
/// on restore Firecracker resets every vsock connection, so broker-mode
/// guests usually re-identify before this tick; TAP guests only notice on
/// their next send (≤ 5 s), so they rely on the poll.
// ponytail: one 2 KiB virtio-blk read per tick per VM (~4/s). Upgrade path:
// trigger on the VMGenID uevent (6.10+ aarch64 guests) and drop this to 5 s.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// ext4 superblock: at byte 1024; magic (le16 0xEF53) at +0x38; UUID at +0x68.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // readers are Linux-only
const SB_OFFSET: usize = 1024;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // readers are Linux-only
const SB_MAGIC: u16 = 0xEF53;

/// The filesystem UUID of an ext4 image, from its first 2 KiB.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // readers are Linux-only
pub fn ext4_fs_uuid(head: &[u8]) -> Option<[u8; 16]> {
    let sb = head.get(SB_OFFSET..SB_OFFSET + 0x78)?;
    if u16::from_le_bytes([sb[0x38], sb[0x39]]) != SB_MAGIC {
        return None;
    }
    sb[0x68..0x78].try_into().ok()
}

/// Change detector over successive cert-drive UUID reads.
#[derive(Debug, Default)]
pub struct IdentityWatch {
    seen: Option<[u8; 16]>,
}

impl IdentityWatch {
    pub fn new(baseline: Option<[u8; 16]>) -> Self {
        Self { seen: baseline }
    }

    /// `true` exactly when a readable drive differs from the last one seen.
    /// An unreadable read is transient, never a change; the first readable
    /// one becomes the baseline.
    pub fn observe(&mut self, current: Option<[u8; 16]>) -> bool {
        let Some(cur) = current else {
            return false;
        };
        let changed = self.seen.is_some_and(|s| s != cur);
        self.seen = Some(cur);
        changed
    }

    /// Forget the last observation so the next readable poll re-triggers
    /// (used when applying a re-identify failed).
    pub fn retry(&mut self, previous: Option<[u8; 16]>) {
        self.seen = previous;
    }
}

/// What a re-identify adopts, derived from the new drive's `spawn.json`.
#[derive(Debug)]
pub struct Reidentify {
    pub vm_id: String,
    /// The new incarnation's exec-server token (`None` = not provided).
    pub exec_token: Option<String>,
    /// The new incarnation's agent identity (`spawn.json` env
    /// `PAL_AGENT_INSTANCE_TOKEN`; minted per fork child).
    pub agent_instance_token: Option<String>,
    pub declared_secrets: Vec<SecretRef>,
    pub egress_rules: Vec<EgressRule>,
    pub network: Option<GuestNetwork>,
    /// Broker mode: the new incarnation's broker CA (ADR 0026). Each
    /// incarnation's broker mints its own, so the old one stops verifying.
    pub egress_ca_pem: Option<String>,
}

/// Validate a new drive's contract. A contract without a `vm_id` cannot say
/// who we now are — refuse rather than keep presenting a guess.
pub fn plan(contract: SpawnContract) -> anyhow::Result<Reidentify> {
    let vm_id = contract
        .vm_id
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("spawn.json on the new cert drive carries no vm_id"))?;
    let nonempty = |t: Option<&String>| t.filter(|t| !t.is_empty()).cloned();
    Ok(Reidentify {
        vm_id,
        exec_token: nonempty(contract.exec_token.as_ref()),
        agent_instance_token: nonempty(contract.env.get("PAL_AGENT_INSTANCE_TOKEN")),
        declared_secrets: contract.declared_secrets.unwrap_or_default(),
        egress_rules: contract.egress_rules.unwrap_or_default(),
        network: contract
            .network
            .filter(|n| !n.guest_ip.is_empty() && !n.host_ip.is_empty()),
        egress_ca_pem: contract.egress_ca_pem.filter(|p| {
            !p.is_empty() && crate::egress::is_broker_mode(contract.egress_mode.as_deref())
        }),
    })
}

/// Re-install the new incarnation's broker CA (same files the workload's
/// `SSL_CERT_FILE` etc. and `http_fetch` read). `Ok(false)` = nothing to do.
pub fn reinstall_broker_ca(pem: Option<&str>, dir: &std::path::Path) -> std::io::Result<bool> {
    let Some(pem) = pem else {
        return Ok(false);
    };
    crate::egress::install_broker_ca(dir, pem, &crate::egress::SYSTEM_CA_BUNDLES)?;
    Ok(true)
}

/// The exec token the new incarnation runs with. Never the previous one: if
/// exec was authenticated and the new drive carries no token, refuse (the
/// caller retries; the stale identity is already pinned out manager-side).
/// Unauthenticated dev stays unauthenticated.
pub fn next_exec_token(new: Option<String>, current: &str) -> anyhow::Result<String> {
    match new {
        Some(t) => Ok(t),
        None if current.is_empty() => Ok(String::new()),
        None => anyhow::bail!(
            "new cert drive carries no exec token; refusing to keep the previous \
             incarnation's"
        ),
    }
}

/// `/etc/hosts` with the manager's name re-pinned to `host_ip` (the restored
/// guest's old pin points at the source VM's link).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // readers are Linux-only
pub fn hosts_with_manager(existing: &str, host_ip: &str) -> String {
    let name = crate::bootenv::MANAGER_HOSTNAME;
    let mut out: String = existing
        .lines()
        .filter(|l| !l.split_whitespace().skip(1).any(|h| h == name))
        .map(|l| format!("{l}\n"))
        .collect();
    if out.is_empty() {
        out.push_str("127.0.0.1\tlocalhost\n");
    }
    out.push_str(&format!("{host_ip}\t{name}\n"));
    out
}

/// Watch the cert drive forever (poll + stream-death hint); re-identify on change.
pub async fn run(
    manager: ManagerClient,
    secrets: Arc<SecretCache>,
    egress: Arc<EgressPolicy>,
    device: &'static str,
    baseline: Option<[u8; 16]>,
) {
    let mut watch = IdentityWatch::new(baseline);
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        next_check(&mut ticker, &manager).await;
        let previous = watch.seen;
        let current = tokio::task::spawn_blocking(move || read_marker(device))
            .await
            .ok()
            .flatten();
        if !watch.observe(current) {
            continue;
        }
        tracing::warn!(
            vm_id = %manager.vm_id(),
            "reidentify: cert drive replaced (restored from a snapshot) — adopting the new identity"
        );
        if let Err(e) = apply(&manager, &secrets, &egress, device).await {
            // The stale identity is already pinned out by the manager, so
            // failing here is fail-closed; retry on the next tick.
            tracing::error!(error = format!("{e:#}"), "reidentify: failed; will retry");
            watch.retry(previous);
        }
    }
}

/// Wait for the next poll tick or a restore hint, whichever comes first.
async fn next_check(ticker: &mut tokio::time::Interval, manager: &ManagerClient) {
    tokio::select! {
        _ = ticker.tick() => {}
        () = manager.restore_hinted() => {}
    }
}

async fn apply(
    manager: &ManagerClient,
    secrets: &SecretCache,
    egress: &EgressPolicy,
    device: &'static str,
) -> anyhow::Result<()> {
    let load = tokio::task::spawn_blocking(move || load_drive(device)).await??;
    let next = plan(crate::bootenv::parse_spawn_contract(&load)?)?;
    // Decide before mutating anything, so a refusal leaves state untouched.
    let exec_token = next_exec_token(next.exec_token, &manager.exec_token())?;

    // Secrets first: anything vended to the old identity is dead.
    secrets.reset(next.declared_secrets);
    if let Some(net) = next.network {
        let host_ip = net.host_ip.clone();
        match tokio::task::spawn_blocking(move || apply_network(&net)).await? {
            Ok(()) => tracing::info!(%host_ip, "reidentify: re-addressed eth0"),
            // Not fatal: same-subnet resumes still reach the manager.
            Err(e) => tracing::error!(error = %e, "reidentify: could not re-address eth0"),
        }
    }
    egress.replace_rules(next.egress_rules).await;
    // Broker mode: without this, injected hosts fail TLS after resume/fork
    // (the new broker presents leaves from a CA the guest never saw).
    let pem = next.egress_ca_pem;
    match tokio::task::spawn_blocking(move || {
        reinstall_broker_ca(
            pem.as_deref(),
            std::path::Path::new(crate::egress::BROKER_CA_DIR),
        )
    })
    .await?
    {
        Ok(true) => tracing::info!("reidentify: installed the new incarnation's broker CA"),
        Ok(false) => {}
        // Not fatal: only injected hosts are affected, and they fail closed.
        Err(e) => tracing::error!(error = %e, "reidentify: could not install the broker CA"),
    }

    let previous = manager.vm_id();
    // Last: reconnects present the cert installed by `load_drive`.
    manager.reidentify(crate::manager_client::Identity {
        vm_id: next.vm_id.clone(),
        exec_token,
        agent_instance_token: next.agent_instance_token,
    });
    manager
        .enqueue_report(HarnessReport::Audit(AuditEvent {
            vm_id: next.vm_id.clone(),
            action: "reidentify".into(),
            at_unix_ms: now_unix_ms(),
            attrs: std::collections::HashMap::from([("previous_vm_id".into(), previous)]),
        }))
        .await;
    tracing::info!(vm_id = %next.vm_id, "reidentify: now running as the restored VM's identity");
    Ok(())
}

/// Reload the drive: stash the new cert material, return the new `spawn.json`.
#[cfg(target_os = "linux")]
fn load_drive(device: &str) -> anyhow::Result<Vec<u8>> {
    let load = crate::bootenv::load_cert_device(device)
        .ok_or_else(|| anyhow::anyhow!("{device} is no longer a mountable cert drive"))?;
    anyhow::ensure!(
        load.private.is_some(),
        "could not install the new cert material"
    );
    load.spawn?
        .ok_or_else(|| anyhow::anyhow!("new cert drive has no spawn.json"))
}

#[cfg(not(target_os = "linux"))]
fn load_drive(_device: &str) -> anyhow::Result<Vec<u8>> {
    anyhow::bail!("cert drive reload is Linux-only")
}

/// Read the cert drive's ext4 UUID. Cached pages are dropped first so the
/// read reflects the backing file the VMM serves NOW.
#[cfg(target_os = "linux")]
pub fn read_marker(device: &str) -> Option<[u8; 16]> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    let mut f = std::fs::File::open(device).ok()?;
    // SAFETY: valid open fd; advisory call with no memory effects.
    unsafe { libc::posix_fadvise(f.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    let mut head = [0u8; 2048];
    f.read_exact(&mut head).ok()?;
    ext4_fs_uuid(&head)
}

#[cfg(not(target_os = "linux"))]
pub fn read_marker(_device: &str) -> Option<[u8; 16]> {
    None
}

/// Point eth0 at this VM's /30 and re-pin the manager's name.
#[cfg(target_os = "linux")]
fn apply_network(net: &GuestNetwork) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    use std::net::Ipv4Addr;
    let parse = |s: &str| {
        s.parse::<Ipv4Addr>()
            .map_err(|e| Error::new(ErrorKind::InvalidInput, format!("{s:?}: {e}")))
    };
    let (guest, host, mask) = (
        parse(&net.guest_ip)?,
        parse(&net.host_ip)?,
        parse(&net.netmask)?,
    );
    netcfg::set_ipv4("eth0", guest, mask)?;
    netcfg::replace_default_route(host)?;
    let existing = std::fs::read_to_string("/etc/hosts").unwrap_or_default();
    std::fs::write("/etc/hosts", hosts_with_manager(&existing, &net.host_ip))
}

#[cfg(not(target_os = "linux"))]
fn apply_network(_net: &GuestNetwork) -> std::io::Result<()> {
    Err(std::io::Error::other("re-addressing is Linux-only"))
}

/// Legacy-ioctl IPv4 configuration: the guest rootfs has no `ip` binary.
#[cfg(target_os = "linux")]
mod netcfg {
    use std::io::{Error, Result};
    use std::net::Ipv4Addr;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    fn inet_socket() -> Result<OwnedFd> {
        // SAFETY: plain socket(2); the fd is owned immediately below.
        let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
        if fd < 0 {
            return Err(Error::last_os_error());
        }
        // SAFETY: fd is a freshly opened, otherwise unowned descriptor.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn sockaddr(ip: Ipv4Addr) -> libc::sockaddr {
        // SAFETY: all-zero is a valid sockaddr_in; sockaddr_in and sockaddr
        // are both 16 bytes, so the transmute is size-exact.
        unsafe {
            let mut sin: libc::sockaddr_in = std::mem::zeroed();
            sin.sin_family = libc::AF_INET as libc::sa_family_t;
            sin.sin_addr.s_addr = u32::from(ip).to_be();
            std::mem::transmute::<libc::sockaddr_in, libc::sockaddr>(sin)
        }
    }

    fn ioctl<T>(fd: &OwnedFd, req: libc::c_ulong, arg: &mut T) -> Result<()> {
        // SAFETY: `arg` is the struct type the kernel expects for `req`.
        let rc = unsafe { libc::ioctl(fd.as_raw_fd(), req as _, arg as *mut T) };
        if rc < 0 {
            Err(Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub fn set_ipv4(iface: &str, addr: Ipv4Addr, mask: Ipv4Addr) -> Result<()> {
        let fd = inet_socket()?;
        // SAFETY: all-zero is a valid ifreq.
        let mut req: libc::ifreq = unsafe { std::mem::zeroed() };
        for (dst, b) in req
            .ifr_name
            .iter_mut()
            .zip(iface.bytes().take(libc::IFNAMSIZ - 1))
        {
            *dst = b as libc::c_char;
        }
        req.ifr_ifru.ifru_addr = sockaddr(addr);
        ioctl(&fd, libc::SIOCSIFADDR as libc::c_ulong, &mut req)?;
        req.ifr_ifru.ifru_netmask = sockaddr(mask);
        ioctl(&fd, libc::SIOCSIFNETMASK as libc::c_ulong, &mut req)
    }

    /// Drop the (source VM's) default route, add one via `gateway`.
    pub fn replace_default_route(gateway: Ipv4Addr) -> Result<()> {
        let fd = inet_socket()?;
        let any = Ipv4Addr::UNSPECIFIED;
        // SAFETY: all-zero is a valid rtentry.
        let mut rt: libc::rtentry = unsafe { std::mem::zeroed() };
        rt.rt_dst = sockaddr(any);
        rt.rt_genmask = sockaddr(any);
        rt.rt_flags = libc::RTF_UP;
        // Best-effort: usually already flushed with the old address.
        let _ = ioctl(&fd, libc::SIOCDELRT as libc::c_ulong, &mut rt);
        rt.rt_gateway = sockaddr(gateway);
        rt.rt_flags = libc::RTF_UP | libc::RTF_GATEWAY;
        match ioctl(&fd, libc::SIOCADDRT as libc::c_ulong, &mut rt) {
            Err(e) if e.raw_os_error() == Some(libc::EEXIST) => Ok(()),
            r => r,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ext4_head(uuid: [u8; 16]) -> Vec<u8> {
        let mut h = vec![0u8; 2048];
        h[SB_OFFSET + 0x38..SB_OFFSET + 0x3a].copy_from_slice(&SB_MAGIC.to_le_bytes());
        h[SB_OFFSET + 0x68..SB_OFFSET + 0x78].copy_from_slice(&uuid);
        h
    }

    #[test]
    fn fs_uuid_needs_ext4_magic_and_enough_bytes() {
        assert_eq!(ext4_fs_uuid(&ext4_head([7; 16])), Some([7; 16]));
        let mut not_ext4 = ext4_head([7; 16]);
        not_ext4[SB_OFFSET + 0x38] = 0;
        assert_eq!(ext4_fs_uuid(&not_ext4), None);
        assert_eq!(ext4_fs_uuid(&[0u8; 1100]), None, "truncated");
    }

    #[test]
    fn watch_fires_only_on_a_readable_change() {
        let (a, b) = (Some([1; 16]), Some([2; 16]));
        let mut w = IdentityWatch::new(a);
        assert!(!w.observe(a), "same drive");
        assert!(!w.observe(None), "unreadable is transient, not a change");
        assert!(
            w.observe(b),
            "drive swapped under us = restored from a snapshot"
        );
        assert!(!w.observe(b), "fires once per swap");
        // A failed apply re-arms the trigger.
        w.retry(a);
        assert!(w.observe(b));
        // No boot baseline: the first readable read baselines silently.
        let mut cold = IdentityWatch::default();
        assert!(!cold.observe(b));
        assert!(cold.observe(a));
    }

    #[test]
    fn plan_adopts_the_restoring_contract_and_requires_a_vm_id() {
        let c = crate::bootenv::parse_spawn_contract(
            br#"{"version":1,"vm_id":"vm-fork-2",
                "declared_secrets":[{"env_name":"K","secret_uri":"pal.secret://t/K"}],
                "egress_rules":[{"pattern":"api.example.com"}],
                "network":{"guest_ip":"172.16.0.6","host_ip":"172.16.0.5","netmask":"255.255.255.252"}}"#,
        )
        .expect("valid");
        let p = plan(c).expect("plan");
        assert_eq!(p.vm_id, "vm-fork-2");
        assert_eq!(p.declared_secrets[0].secret_uri, "pal.secret://t/K");
        assert_eq!(p.egress_rules[0].pattern, "api.example.com");
        assert_eq!(p.network.expect("net").host_ip, "172.16.0.5");

        for bad in [&br#"{"version":1}"#[..], br#"{"vm_id":"  "}"#] {
            let c = crate::bootenv::parse_spawn_contract(bad).expect("parses");
            assert!(plan(c).is_err(), "no identity → refuse");
        }
        // Optional parts default to "none declared".
        let p = plan(crate::bootenv::parse_spawn_contract(br#"{"vm_id":"v"}"#).unwrap()).unwrap();
        assert!(p.declared_secrets.is_empty() && p.egress_rules.is_empty() && p.network.is_none());
    }

    #[test]
    fn hosts_repins_the_manager_name_only() {
        let before = "127.0.0.1\tlocalhost\n172.16.0.1\tmanager.pal.internal\n10.0.0.9 other\n";
        assert_eq!(
            hosts_with_manager(before, "172.16.0.5"),
            "127.0.0.1\tlocalhost\n10.0.0.9 other\n172.16.0.5\tmanager.pal.internal\n"
        );
        assert_eq!(
            hosts_with_manager("", "172.16.0.5"),
            "127.0.0.1\tlocalhost\n172.16.0.5\tmanager.pal.internal\n"
        );
    }

    #[tokio::test]
    async fn secret_cache_reset_drops_old_identity_values() {
        let m = ManagerClient::new("127.0.0.1:1".into(), "vm-src".into());
        let cache = SecretCache::new(
            m.clone(),
            vec![SecretRef {
                env_name: "OLD".into(),
                secret_uri: "pal.secret://t/OLD".into(),
            }],
        );
        cache.reset(vec![SecretRef {
            env_name: "NEW".into(),
            secret_uri: "pal.secret://t/NEW".into(),
        }]);
        let err = cache
            .get_or_vend("OLD")
            .await
            .expect_err("no longer declared");
        assert!(err.to_string().contains("not declared"), "{err}");
        // NEW is declared now (vend itself fails: no manager on :1).
        let err = cache
            .get_or_vend("NEW")
            .await
            .expect_err("unreachable manager");
        assert!(!err.to_string().contains("not declared"), "{err}");
    }

    #[test]
    fn plan_takes_the_new_incarnations_tokens() {
        let c = crate::bootenv::parse_spawn_contract(
            br#"{"vm_id":"vm-f","exec_token":"exec-new",
                "env":{"PAL_AGENT_INSTANCE_TOKEN":"agent-new","OTHER":"x"}}"#,
        )
        .expect("valid");
        let p = plan(c).expect("plan");
        assert_eq!(p.exec_token.as_deref(), Some("exec-new"));
        assert_eq!(p.agent_instance_token.as_deref(), Some("agent-new"));
        let c = crate::bootenv::parse_spawn_contract(br#"{"vm_id":"v","exec_token":""}"#).unwrap();
        let p = plan(c).unwrap();
        assert!(p.exec_token.is_none() && p.agent_instance_token.is_none());
    }

    /// Resume/fork in broker mode: the new incarnation's CA replaces the old
    /// one in the files the workload and `http_fetch` trust.
    #[test]
    fn reidentify_reinstalls_the_new_broker_ca() {
        let old = "-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n";
        let new = "-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----\n";
        let dir = std::env::temp_dir().join(format!("pal-reid-ca-{}", std::process::id()));
        crate::egress::install_broker_ca(&dir, old, &[]).unwrap();
        let c = crate::bootenv::parse_spawn_contract(
            format!(
                r#"{{"vm_id":"vm-f","egress_mode":"broker","egress_ca_pem":{}}}"#,
                serde_json::to_string(new).unwrap()
            )
            .as_bytes(),
        )
        .unwrap();
        let p = plan(c).unwrap();
        assert_eq!(p.egress_ca_pem.as_deref(), Some(new));
        assert!(reinstall_broker_ca(p.egress_ca_pem.as_deref(), &dir).unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.join("egress-ca.crt")).unwrap(),
            new
        );
        assert!(
            std::fs::read_to_string(dir.join("egress-ca-bundle.crt"))
                .unwrap()
                .ends_with(new)
        );
        // Guest mode / no CA: nothing installed.
        let c = crate::bootenv::parse_spawn_contract(
            br#"{"vm_id":"vm-g","egress_ca_pem":"-----BEGIN CERTIFICATE-----"}"#,
        )
        .unwrap();
        assert!(plan(c).unwrap().egress_ca_pem.is_none());
        assert!(!reinstall_broker_ca(None, &dir).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn exec_token_never_carries_over_from_the_previous_incarnation() {
        assert_eq!(next_exec_token(Some("new".into()), "old").unwrap(), "new");
        assert!(next_exec_token(None, "old").is_err(), "no silent reuse");
        assert_eq!(next_exec_token(None, "").unwrap(), "", "dev stays dev");
    }

    /// A dead manager stream re-reads the drive at once, not on the next tick.
    #[tokio::test(start_paused = true)]
    async fn restore_hint_preempts_the_poll() {
        let m = ManagerClient::new("127.0.0.1:1".into(), "vm".into());
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        next_check(&mut ticker, &m).await; // first tick is immediate
        let t0 = tokio::time::Instant::now();
        // A hint raised before anyone waits is kept, not lost.
        m.clone().hint_restore();
        next_check(&mut ticker, &m).await;
        assert_eq!(t0.elapsed(), Duration::ZERO, "hint wakes immediately");
        // No hint: the poll is the backstop.
        next_check(&mut ticker, &m).await;
        assert_eq!(t0.elapsed(), POLL_INTERVAL);
    }

    #[tokio::test]
    async fn reidentify_swaps_identity_across_clones_and_signals_streams() {
        let m = ManagerClient::new("127.0.0.1:1".into(), "vm-src".into());
        let clone = m.clone();
        let changed = clone.identity_changed();
        m.reidentify(crate::manager_client::Identity {
            vm_id: "vm-fork-1".into(),
            exec_token: "exec-fork-1".into(),
            agent_instance_token: Some("agent-fork-1".into()),
        });
        assert_eq!(
            clone.vm_id(),
            "vm-fork-1",
            "every subsystem sees the new id"
        );
        assert_eq!(clone.exec_token(), "exec-fork-1");
        assert_eq!(
            clone.agent_instance_token().as_deref(),
            Some("agent-fork-1")
        );
        tokio::time::timeout(Duration::from_secs(1), changed)
            .await
            .expect("long-lived streams are told to reconnect");
    }
}
