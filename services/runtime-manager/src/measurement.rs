//! Host-asserted software measurement (ADR 0031).
//!
//! At spawn the manager computes a SHA-256 over the five canonical inputs it
//! directly controls: kernel image, rootfs image, harness binary (when
//! separately installed), kernel boot arguments, and the spawn contract — each
//! minus secrets and minus per-VM identity. The result is a single
//! 64-character lowercase hex string — the "software measurement" — that is
//! identical for every VM booted from the same images and spec, so a reference
//! set can match it. A restore / resume / fork does NOT re-measure: it
//! INHERITS the source's spawn measurement from the snapshot metadata (see
//! [`check_inherited`]).
//!
//! # HOST-ASSERTED, not hardware-attested
//!
//! This measurement is computed and recorded by the manager host. It proves
//! what the host *recorded* it launched; it does **not** prove what actually
//! ran inside the VM. Files are hashed by path and Firecracker opens them
//! later (TOCTOU): a host that can rewrite the images in between defeats it —
//! but such a host can forge the value anyway. Hardware attestation (AMD
//! SEV-SNP / Intel TDX) is ADR 0023.
//!
//! # Canonical input order (ADR 0031 §Measurement algorithm)
//!
//! 1. **kernel image** — SHA-256 of file bytes at `FC_KERNEL_PATH`
//! 2. **rootfs image** — SHA-256 of file bytes at `FC_ROOTFS_PATH`
//! 3. **harness binary** — SHA-256 of file bytes at `FC_HARNESS_PATH`
//!    (32 zero bytes when unset — harness baked into the rootfs)
//! 4. **boot arguments** — SHA-256 of the kernel cmdline minus per-VM tokens,
//!    secret refs and the legacy `lantern.env.*` copy ([`canonical_boot_args`])
//! 5. **spawn contract** — SHA-256 of `spawn.json` canonical JSON minus
//!    secrets and per-VM identity ([`contract_bytes_sans_secrets`])
//!
//! **Final value:** SHA-256 of the 160-byte concatenation of the five
//! 32-byte component hashes, in the order above. Image hashes are streamed
//! and cached per `(dev, ino, size, mtime, ctime)`.
//!
//! # Gate
//!
//! `LANTERN_MEASUREMENT_GATE` = `off` | `warn` (default) | `enforce`, against
//! `LANTERN_REFERENCE_MEASUREMENTS` (comma-separated 64-hex). Unknown gate
//! values and malformed references refuse startup; so does `enforce` with no
//! references in prod.

use sha2::{Digest, Sha256};

use crate::backends::firecracker::SpawnContract;

/// OID arc for the Lantern software-measurement X.509 extension.
///
/// `1.3.6.1.4.1.99999.3` — private arc under a placeholder PEN.
/// PLACEHOLDER: 99999 is not ours. A registered IANA Private Enterprise
/// Number is required; replace 99999 with it before production deployment
/// (relying parties pin this OID, so changing it later is a breaking change).
///
/// The extension DER value is a UTF8String containing the 64-character
/// lowercase hex measurement.
pub const MEASUREMENT_CERT_OID: &[u64] = &[1, 3, 6, 1, 4, 1, 99999, 3];

// ---------------------------------------------------------------------------
// Gate and reference values
// ---------------------------------------------------------------------------

/// Behaviour when a computed measurement does not match any configured
/// reference value. Controlled by `LANTERN_MEASUREMENT_GATE`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeasurementGate {
    /// Compute and record the measurement; never compare (no gate).
    Off,
    /// Warn on mismatch; proceed regardless. **Default.**
    Warn,
    /// Refuse to start a VM whose measurement does not match any reference.
    Enforce,
}

impl MeasurementGate {
    /// Parse a `LANTERN_MEASUREMENT_GATE` value. Unset/blank = `Warn`; an
    /// unrecognised value is an error (the manager refuses to start) — a typo
    /// of `enforce` must never silently downgrade to `warn`.
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw
            .map(str::trim)
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "enforce" => Ok(MeasurementGate::Enforce),
            "" | "warn" => Ok(MeasurementGate::Warn),
            "off" | "0" | "false" | "disabled" => Ok(MeasurementGate::Off),
            other => Err(format!(
                "invalid LANTERN_MEASUREMENT_GATE {other:?} (expected off, warn or enforce)"
            )),
        }
    }

    /// Read the gate mode from `LANTERN_MEASUREMENT_GATE`.
    pub fn from_env() -> Result<Self, String> {
        Self::parse(std::env::var("LANTERN_MEASUREMENT_GATE").ok().as_deref())
    }
}

/// Load the reference measurement set from `LANTERN_REFERENCE_MEASUREMENTS`
/// (comma-separated hex strings, trimmed + lowercased). Every entry must be a
/// 64-char hex SHA-256 — a malformed one is an error, not a silently
/// unmatchable reference.
pub fn reference_measurements_from_env() -> Result<Vec<String>, String> {
    parse_references(&std::env::var("LANTERN_REFERENCE_MEASUREMENTS").unwrap_or_default())
}

fn parse_references(raw: &str) -> Result<Vec<String>, String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let s = s.to_ascii_lowercase();
            if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
                Ok(s)
            } else {
                Err(format!(
                    "invalid LANTERN_REFERENCE_MEASUREMENTS entry (want 64 hex chars, got {} chars)",
                    s.len()
                ))
            }
        })
        .collect()
}

/// Startup guard: in prod (`LANTERN_ENV` prod/production/staging) an
/// `enforce` gate with NO references would pass every VM — protection in
/// name only. Refuse to start rather than run that way.
pub fn check_startup(
    gate: MeasurementGate,
    references: &[String],
    prod: bool,
) -> Result<(), String> {
    if prod && gate == MeasurementGate::Enforce && references.is_empty() {
        return Err("LANTERN_MEASUREMENT_GATE=enforce in production with no \
             LANTERN_REFERENCE_MEASUREMENTS: the gate would admit every VM; \
             configure references (or use gate=warn)"
            .to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// Compute the host-asserted software measurement for a Firecracker VM boot.
///
/// Returns a 64-character lowercase hex string (SHA-256). Reads the kernel and
/// rootfs files from disk; `harness_path` may be `None` (component hash is
/// 32 zero bytes).
///
/// # Errors
///
/// Returns an error when any image file cannot be read.
pub fn compute(
    kernel_path: &str,
    rootfs_path: &str,
    harness_path: Option<&str>,
    boot_args: &str,
    contract: &SpawnContract,
) -> anyhow::Result<String> {
    let kernel_hash = hash_file(kernel_path)?;
    let rootfs_hash = hash_file(rootfs_path)?;
    let harness_hash = match harness_path {
        Some(p) => hash_file(p)?,
        None => [0u8; 32],
    };
    let args_hash = hash_bytes(canonical_boot_args(boot_args).as_bytes());
    let contract_hash = hash_bytes(&contract_bytes_sans_secrets(contract)?);

    // Final measurement: SHA-256 of the five 32-byte component hashes in order.
    let mut h = Sha256::new();
    h.update(kernel_hash);
    h.update(rootfs_hash);
    h.update(harness_hash);
    h.update(args_hash);
    h.update(contract_hash);
    Ok(hex::encode(h.finalize()))
}

/// Like [`compute`] but skips file I/O and takes pre-computed component hashes
/// as hex strings. Intended for testing without real image files.
///
/// Each string must be exactly 64 hex characters (a SHA-256 hex digest).
#[cfg(test)]
pub fn compute_from_hashes(
    kernel_hex: &str,
    rootfs_hex: &str,
    harness_hex: &str,
    args_hex: &str,
    contract_hex: &str,
) -> String {
    fn from_hex(s: &str) -> [u8; 32] {
        let bytes = hex::decode(s).expect("valid hex");
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        out
    }
    let mut h = Sha256::new();
    h.update(from_hex(kernel_hex));
    h.update(from_hex(rootfs_hex));
    h.update(from_hex(harness_hex));
    h.update(from_hex(args_hex));
    h.update(from_hex(contract_hex));
    hex::encode(h.finalize())
}

// ---------------------------------------------------------------------------
// Gate check
// ---------------------------------------------------------------------------

/// Apply the gate check for a freshly computed `measurement`.
///
/// - `Off` → always `Ok(())`.
/// - `Warn` → warn-log on mismatch; always `Ok(())`.
/// - `Enforce` → return `Err` on mismatch.
///
/// When `references` is empty no comparison is possible; the function returns
/// `Ok(())` at every gate level (you cannot fail-closed against an empty
/// allowed-set without an operator providing one first).
pub fn check(
    measurement: &str,
    references: &[String],
    gate: MeasurementGate,
    vm_id: &str,
) -> anyhow::Result<()> {
    if references.is_empty() || gate == MeasurementGate::Off {
        return Ok(());
    }
    if references.iter().any(|r| r == measurement) {
        return Ok(());
    }
    match gate {
        MeasurementGate::Warn => {
            tracing::warn!(
                target: "lantern_audit",
                vm_id,
                "SECURITY: software measurement does not match any reference value \
                 (gate=warn — proceeding; set LANTERN_MEASUREMENT_GATE=enforce to block)"
            );
            Ok(())
        }
        MeasurementGate::Enforce => {
            tracing::error!(
                target: "lantern_audit",
                vm_id,
                "SECURITY: refusing to start VM — software measurement does not match \
                 any reference value (gate=enforce)"
            );
            Err(anyhow::anyhow!(
                "SECURITY: software measurement does not match any \
                 configured reference value; set LANTERN_MEASUREMENT_GATE=warn \
                 to allow with a warning, or update LANTERN_REFERENCE_MEASUREMENTS"
            ))
        }
        MeasurementGate::Off => Ok(()),
    }
}

/// Gate a restore / resume / fork, which INHERITS its source VM's spawn
/// measurement (carried in the snapshot's metadata) instead of re-measuring.
///
/// A restored guest resumes from vmstate + mem + the captured disk, none of
/// which the spawn inputs describe, so re-measuring the base images under a
/// restore-shaped contract would produce a value no reference can match (and
/// fail every resume closed under `enforce`). The inherited value is the
/// measurement of the boot this guest's lineage started from; it is re-checked
/// against the CURRENT references, so retiring an image's reference also
/// refuses restores of its snapshots. A snapshot that carries no measurement
/// (legacy, or its source was unmeasured) is refused under an enforcing gate
/// with references — an unmeasured lineage must not slip past it.
pub fn check_inherited(
    inherited: Option<&str>,
    references: &[String],
    gate: MeasurementGate,
    vm_id: &str,
) -> anyhow::Result<Option<String>> {
    let Some(m) = inherited.filter(|m| !m.is_empty()) else {
        if gate == MeasurementGate::Enforce && !references.is_empty() {
            tracing::error!(
                target: "lantern_audit",
                vm_id,
                "SECURITY: refusing to restore VM — snapshot carries no software \
                 measurement (gate=enforce)"
            );
            anyhow::bail!(
                "SECURITY: refusing to restore VM — its snapshot carries no software \
                 measurement to inherit (legacy or unmeasured source; gate=enforce)"
            );
        }
        return Ok(None);
    };
    check(m, references, gate, vm_id)?;
    tracing::info!(
        target: "lantern_audit",
        vm_id,
        "software measurement inherited from snapshot source (restore/fork)"
    );
    Ok(Some(m.to_string()))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Streaming SHA-256 of a file (never read whole: the rootfs is GiB-sized and
/// spawns run concurrently), cached by `(dev, ino, size, mtime, ctime)` so an
/// unchanged image is hashed once per manager process, not once per spawn.
// ponytail: cache is cleared past 64 entries; keyed on metadata, so it shares
// the documented TOCTOU limitation (ADR 0031) — a same-size rewrite within one
// ctime tick would be missed. Upgrade path: hash the staged per-VM copy.
fn hash_file(path: &str) -> anyhow::Result<[u8; 32]> {
    use std::collections::HashMap;
    use std::os::unix::fs::MetadataExt;
    use std::sync::{Mutex, OnceLock};
    type Key = (u64, u64, u64, i64, i64, i64, i64);
    static CACHE: OnceLock<Mutex<HashMap<Key, [u8; 32]>>> = OnceLock::new();

    let err = |e: std::io::Error| anyhow::anyhow!("measurement: read {path}: {e}");
    let file = std::fs::File::open(path).map_err(err)?;
    let md = file.metadata().map_err(err)?;
    let key: Key = (
        md.dev(),
        md.ino(),
        md.size(),
        md.mtime(),
        md.mtime_nsec(),
        md.ctime(),
        md.ctime_nsec(),
    );
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some(h) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return Ok(*h);
    }
    let mut h = Sha256::new();
    std::io::copy(
        &mut std::io::BufReader::with_capacity(1 << 20, file),
        &mut h,
    )
    .map_err(err)?;
    let digest: [u8; 32] = h.finalize().into();
    let mut c = cache.lock().unwrap_or_else(|p| p.into_inner());
    if c.len() >= 64 {
        c.clear();
    }
    c.insert(key, digest);
    Ok(digest)
}

fn hash_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

/// Kernel cmdline reduced to its stable boot configuration. Removed:
/// per-incarnation tokens (VM/run identity, per-VM cert paths, `ip=`),
/// declared-secret refs (minus-secrets), and EVERY `lantern.env.*` token. The
/// env tokens are a lossy legacy copy of `spawn.json`'s env (the harness
/// ignores them when `spawn.json` is present), emitted in `HashMap` order —
/// keeping them made identical specs measure differently, and they carry
/// per-VM identity and caller credentials (`LANTERN_AGENT_INSTANCE_*`). The
/// authoritative env is measured, sanitized, in the contract.
fn canonical_boot_args(args: &str) -> String {
    const PER_VM: &[&str] = &[
        "ip=",
        "lantern.vm_id=",
        "lantern.run_id=",
        "lantern.tls_cert=",
        "lantern.tls_key=",
        "lantern.env.",
        "lantern.secret.",
    ];
    args.split_whitespace()
        .filter(|t| !PER_VM.iter().any(|p| t.starts_with(p)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Env key names whose VALUES are credentials: the value is blanked before
/// hashing (the key's presence is still measured). A published measurement
/// must never be a hash over a live secret (ADR 0031 "minus secrets").
fn is_secret_env_name(key: &str) -> bool {
    const MARKERS: &[&str] = &[
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "API_KEY",
        "APIKEY",
        "PRIVATE_KEY",
        "CREDENTIAL",
    ];
    let k = key.to_ascii_uppercase();
    MARKERS.iter().any(|m| k.contains(m))
}

/// Serialize `contract` to canonical JSON with secret-bearing fields zeroed
/// and per-incarnation identity removed. `env` is a `BTreeMap`, so the JSON is
/// key-ordered and deterministic.
fn contract_bytes_sans_secrets(contract: &SpawnContract) -> anyhow::Result<Vec<u8>> {
    let mut s = contract.clone();
    s.declared_secrets = Vec::new();
    s.exec_token = String::new();
    for rule in &mut s.egress_rules {
        rule.inject = Vec::new();
    }
    // Caller-set per-incarnation keys (agent instance id + its bearer token,
    // trace parent, crash-resume marker) differ for every VM — dropped.
    s.env
        .retain(|k, _| !crate::service::CALLER_LANTERN_KEYS.contains(&k.as_str()));
    for (k, v) in &mut s.env {
        if is_secret_env_name(k) {
            v.clear();
        }
    }
    // Per-incarnation identity: unique for every VM, so hashing it would make
    // every measurement unique and a reference set unmatchable.
    s.vm_id = String::new();
    s.network = None;
    s.egress_ca_pem = String::new();
    serde_json::to_vec(&s).map_err(|e| anyhow::anyhow!("measurement: serialize contract: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backends::firecracker::SpawnContract;

    fn empty_contract() -> SpawnContract {
        SpawnContract {
            version: 1,
            workload_cmd: vec!["python".into(), "-c".into(), "print('hi')".into()],
            env: Default::default(),
            egress_rules: vec![],
            workload_uid: 1000,
            workload_gid: 1000,
            vm_id: "vm-test".into(),
            declared_secrets: vec![],
            network: None,
            exec_token: String::new(),
            lantern_env: String::new(),
            egress_mode: String::new(),
            egress_ca_pem: String::new(),
            vsock_egress_port: 0,
            vsock_manager_port: 0,
        }
    }

    /// All five 32-byte zero hashes → known fixed output.
    #[test]
    fn deterministic_all_zeros() {
        let zero32 = "0000000000000000000000000000000000000000000000000000000000000000";
        let a = compute_from_hashes(zero32, zero32, zero32, zero32, zero32);
        let b = compute_from_hashes(zero32, zero32, zero32, zero32, zero32);
        assert_eq!(a, b, "same inputs must produce the same measurement");
        assert_eq!(a.len(), 64, "output is a 64-char hex string");
        // The specific value is fixed; pin it so a future algorithm change fails loudly.
        let expected = {
            let mut h = Sha256::new();
            for _ in 0..5 {
                h.update([0u8; 32]);
            }
            hex::encode(h.finalize())
        };
        assert_eq!(a, expected);
    }

    /// Flipping one bit in any input component changes the measurement.
    #[test]
    fn sensitivity_kernel() {
        let zero = "0000000000000000000000000000000000000000000000000000000000000000";
        let one = "0000000000000000000000000000000000000000000000000000000000000001";
        let a = compute_from_hashes(zero, zero, zero, zero, zero);
        let b = compute_from_hashes(one, zero, zero, zero, zero);
        assert_ne!(a, b, "kernel hash change must change the measurement");
    }

    #[test]
    fn sensitivity_rootfs() {
        let zero = "0000000000000000000000000000000000000000000000000000000000000000";
        let one = "0000000000000000000000000000000000000000000000000000000000000001";
        let a = compute_from_hashes(zero, zero, zero, zero, zero);
        let b = compute_from_hashes(zero, one, zero, zero, zero);
        assert_ne!(a, b);
    }

    #[test]
    fn sensitivity_harness() {
        let zero = "0000000000000000000000000000000000000000000000000000000000000000";
        let one = "0000000000000000000000000000000000000000000000000000000000000001";
        let a = compute_from_hashes(zero, zero, zero, zero, zero);
        let b = compute_from_hashes(zero, zero, one, zero, zero);
        assert_ne!(a, b);
    }

    #[test]
    fn sensitivity_boot_args() {
        let zero = "0000000000000000000000000000000000000000000000000000000000000000";
        let one = "0000000000000000000000000000000000000000000000000000000000000001";
        let a = compute_from_hashes(zero, zero, zero, zero, zero);
        let b = compute_from_hashes(zero, zero, zero, one, zero);
        assert_ne!(a, b);
    }

    #[test]
    fn sensitivity_contract() {
        let zero = "0000000000000000000000000000000000000000000000000000000000000000";
        let one = "0000000000000000000000000000000000000000000000000000000000000001";
        let a = compute_from_hashes(zero, zero, zero, zero, zero);
        let b = compute_from_hashes(zero, zero, zero, zero, one);
        assert_ne!(a, b);
    }

    /// No component ordering ambiguity: inputs [A,B,X,X,X] ≠ [B,A,X,X,X].
    #[test]
    fn order_matters() {
        let a_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let b_hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let zero = "0000000000000000000000000000000000000000000000000000000000000000";
        let ab = compute_from_hashes(a_hash, b_hash, zero, zero, zero);
        let ba = compute_from_hashes(b_hash, a_hash, zero, zero, zero);
        assert_ne!(ab, ba, "order of kernel/rootfs inputs must matter");
    }

    /// `check` passes when the measurement is in the reference set.
    #[test]
    fn check_passes_on_match() {
        let m = "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";
        let refs = vec![m.to_string()];
        assert!(check(m, &refs, MeasurementGate::Enforce, "vm-1").is_ok());
    }

    /// `check` rejects an enforce gate when no reference matches.
    #[test]
    fn check_enforce_rejects_mismatch() {
        let known = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let unknown = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let refs = vec![known.to_string()];
        let result = check(unknown, &refs, MeasurementGate::Enforce, "vm-x");
        assert!(
            result.is_err(),
            "enforce must reject an unrecognised measurement"
        );
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("does not match"),
            "error message must describe the mismatch"
        );
    }

    /// `check` with `warn` returns Ok even on mismatch.
    #[test]
    fn check_warn_allows_mismatch() {
        let known = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let unknown = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let refs = vec![known.to_string()];
        assert!(
            check(unknown, &refs, MeasurementGate::Warn, "vm-x").is_ok(),
            "warn gate must allow mismatch"
        );
    }

    /// `check` with `off` always passes regardless of refs.
    #[test]
    fn check_off_always_passes() {
        let unknown = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let refs =
            vec!["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()];
        assert!(check(unknown, &refs, MeasurementGate::Off, "vm-x").is_ok());
    }

    /// `check` with empty references never fails regardless of gate.
    #[test]
    fn check_empty_refs_always_passes() {
        let m = "abcdef00abcdef00abcdef00abcdef00abcdef00abcdef00abcdef00abcdef00";
        assert!(check(m, &[], MeasurementGate::Enforce, "vm-x").is_ok());
        assert!(check(m, &[], MeasurementGate::Warn, "vm-x").is_ok());
        assert!(check(m, &[], MeasurementGate::Off, "vm-x").is_ok());
    }

    /// Secrets are stripped from the contract before hashing.
    #[test]
    fn contract_sans_secrets_excludes_sensitive_fields() {
        use crate::backends::firecracker::ContractSecret;
        let mut contract = empty_contract();
        contract.declared_secrets = vec![ContractSecret {
            env_name: "MY_SECRET".into(),
            secret_uri: "lantern.secret/vault/my-key".into(),
        }];
        contract.exec_token = "super-secret-token".into();

        let bytes_with_secret = contract_bytes_sans_secrets(&contract).unwrap();
        let deserialized: SpawnContract = serde_json::from_slice(&bytes_with_secret).unwrap();
        assert!(
            deserialized.declared_secrets.is_empty(),
            "declared_secrets must be cleared before hashing"
        );
        assert!(
            deserialized.exec_token.is_empty(),
            "exec_token must be cleared before hashing"
        );

        // Changing the secret must NOT change the hash (since it's stripped).
        contract.declared_secrets[0].secret_uri = "lantern.secret/vault/other-key".into();
        let bytes_different_secret = contract_bytes_sans_secrets(&contract).unwrap();
        // The non-secret fields are the same, so the JSON must be the same
        // (declared_secrets is cleared in both).
        assert_eq!(bytes_with_secret, bytes_different_secret);
    }

    /// Two VMs from the same spec measure the same: per-VM identity (vm_id,
    /// network, per-VM CA, cmdline identity/IP/cert paths) is excluded, so a
    /// reference set can actually match (ADR 0031).
    #[test]
    fn identity_free_across_vms() {
        use crate::backends::firecracker::ContractNetwork;
        let mut c1 = empty_contract();
        let mut c2 = empty_contract();
        c1.vm_id = "vm-a".into();
        c2.vm_id = "vm-b".into();
        c1.egress_ca_pem = "CA-A".into();
        c2.egress_ca_pem = "CA-B".into();
        c2.network = Some(ContractNetwork {
            guest_ip: "172.16.0.6".into(),
            host_ip: "172.16.0.5".into(),
            netmask: "255.255.255.252".into(),
        });
        assert_eq!(
            contract_bytes_sans_secrets(&c1).unwrap(),
            contract_bytes_sans_secrets(&c2).unwrap()
        );
        let a = "console=ttyS0 ip=172.16.0.2::172.16.0.1 lantern.vm_id=vm-a \
                 lantern.run_id=r1 lantern.tls_cert=/c/vm-a/tls.crt lantern.tls_key=/c/vm-a/tls.key \
                 lantern.manager_ca=/c/manager-ca.crt lantern.env.LANTERN_MANAGER_ADDR=172.16.0.1:50054 \
                 lantern.secret.K=lantern.secret/x lantern.env.FOO=1";
        let b = "console=ttyS0 ip=172.16.0.6::172.16.0.5 lantern.vm_id=vm-b \
                 lantern.run_id=r2 lantern.tls_cert=/c/vm-b/tls.crt lantern.tls_key=/c/vm-b/tls.key \
                 lantern.manager_ca=/c/manager-ca.crt lantern.env.LANTERN_MANAGER_ADDR=172.16.0.5:50054 \
                 lantern.secret.K=lantern.secret/y lantern.env.FOO=1";
        assert_eq!(canonical_boot_args(a), canonical_boot_args(b));
        // A real boot-configuration change still changes it.
        assert_ne!(
            canonical_boot_args(a),
            canonical_boot_args(&a.replace("console=ttyS0", "console=ttyS1"))
        );
    }

    /// B1(a): `lantern.env.*` tokens are emitted in HashMap order — the same
    /// env in a different order must canonicalise identically (they are
    /// dropped; the env is measured, ordered, in the contract).
    #[test]
    fn boot_args_env_order_does_not_matter() {
        let a = "console=ttyS0 lantern.env.A=1 lantern.env.B=2 lantern.env.C=3";
        let b = "console=ttyS0 lantern.env.C=3 lantern.env.A=1 lantern.env.B=2";
        assert_eq!(canonical_boot_args(a), canonical_boot_args(b));
        assert!(!canonical_boot_args(a).contains("lantern.env."));
    }

    /// B1(b): per-VM caller identity (instance id + bearer token, trace
    /// parent) never reaches the measured bytes, and a credential-named env
    /// value never influences or appears in them.
    #[test]
    fn contract_measures_no_identity_or_secret_values() {
        let mk = |inst: &str, tok: &str, key: &str, vm: &str| {
            let mut c = empty_contract();
            c.vm_id = vm.into();
            c.exec_token = format!("exec-{tok}");
            for (k, v) in [
                ("LANTERN_AGENT_INSTANCE_ID", inst),
                ("LANTERN_AGENT_INSTANCE_TOKEN", tok),
                ("LANTERN_TRACE_PARENT", inst),
                ("OPENAI_API_KEY", key),
                ("DB_PASSWORD", key),
                ("MODE", "fast"),
            ] {
                c.env.insert(k.into(), v.into());
            }
            c
        };
        let a = contract_bytes_sans_secrets(&mk("inst-a", "tok-AAAA", "sk-AAAA", "vm-a")).unwrap();
        let b = contract_bytes_sans_secrets(&mk("inst-b", "tok-BBBB", "sk-BBBB", "vm-b")).unwrap();
        assert_eq!(
            a, b,
            "identity/secret values must not influence the measurement"
        );
        let text = String::from_utf8(a).unwrap();
        for leaked in ["tok-AAAA", "sk-AAAA", "inst-a", "exec-"] {
            assert!(
                !text.contains(leaked),
                "{leaked} leaked into measured bytes"
            );
        }
        // Non-secret env still counts.
        let mut c = mk("i", "t", "k", "v");
        c.env.insert("MODE".into(), "slow".into());
        assert_ne!(
            contract_bytes_sans_secrets(&c).unwrap(),
            contract_bytes_sans_secrets(&mk("i", "t", "k", "v")).unwrap()
        );
    }

    /// S1: streaming hash equals the plain SHA-256 of the bytes, and a
    /// rewritten file is re-hashed (cache keyed on metadata, not path).
    #[test]
    fn hash_file_streams_and_invalidates_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("img");
        std::fs::write(&p, vec![7u8; (1 << 20) + 3]).unwrap();
        let ps = p.to_str().unwrap();
        assert_eq!(
            hash_file(ps).unwrap(),
            hash_bytes(&vec![7u8; (1 << 20) + 3])
        );
        assert_eq!(hash_file(ps).unwrap(), hash_file(ps).unwrap());
        std::fs::write(&p, b"different").unwrap();
        assert_eq!(hash_file(ps).unwrap(), hash_bytes(b"different"));
    }

    /// S2: gate values are trimmed; anything unrecognised is an error, never a
    /// silent downgrade of `enforce` to `warn`.
    #[test]
    fn gate_parse_trims_and_rejects_unknown() {
        assert_eq!(
            MeasurementGate::parse(Some(" Enforce \n")),
            Ok(MeasurementGate::Enforce)
        );
        assert_eq!(MeasurementGate::parse(None), Ok(MeasurementGate::Warn));
        assert_eq!(
            MeasurementGate::parse(Some("  ")),
            Ok(MeasurementGate::Warn)
        );
        assert_eq!(
            MeasurementGate::parse(Some("off")),
            Ok(MeasurementGate::Off)
        );
        assert!(MeasurementGate::parse(Some("enforced")).is_err());
        assert!(MeasurementGate::parse(Some("block")).is_err());
    }

    #[test]
    fn references_must_be_sha256_hex() {
        let good = "A".repeat(64);
        assert_eq!(
            parse_references(&format!(" {good} , ")).unwrap(),
            vec!["a".repeat(64)]
        );
        assert!(parse_references("abc").is_err());
        assert!(parse_references(&"z".repeat(64)).is_err());
        assert!(parse_references("").unwrap().is_empty());
    }

    /// S2: prod + enforce + no references refuses to start.
    #[test]
    fn startup_refuses_enforce_without_references_in_prod() {
        let refs = vec!["a".repeat(64)];
        assert!(check_startup(MeasurementGate::Enforce, &[], true).is_err());
        assert!(check_startup(MeasurementGate::Enforce, &refs, true).is_ok());
        assert!(check_startup(MeasurementGate::Enforce, &[], false).is_ok());
        assert!(check_startup(MeasurementGate::Warn, &[], true).is_ok());
    }

    /// B2: a restore/resume/fork inherits the spawn measurement; under
    /// `enforce` with the spawn-derived reference it boots, while an
    /// unmeasured (legacy) snapshot or a retired reference is refused.
    #[test]
    fn restore_inherits_spawn_measurement_under_enforce() {
        let spawn_m = compute_from_hashes(
            &"1".repeat(64),
            &"2".repeat(64),
            &"0".repeat(64),
            &"3".repeat(64),
            &"4".repeat(64),
        );
        let refs = vec![spawn_m.clone()];
        let e = MeasurementGate::Enforce;
        assert_eq!(
            check_inherited(Some(&spawn_m), &refs, e, "fork-1").unwrap(),
            Some(spawn_m.clone())
        );
        assert!(check_inherited(None, &refs, e, "vm").is_err());
        assert!(check_inherited(Some(""), &refs, e, "vm").is_err());
        assert!(check_inherited(Some(&"f".repeat(64)), &refs, e, "vm").is_err());
        assert_eq!(
            check_inherited(None, &refs, MeasurementGate::Warn, "vm").unwrap(),
            None
        );
        assert_eq!(check_inherited(None, &[], e, "vm").unwrap(), None);
    }

    /// The gate never puts the measurement value in its error (invariant #10
    /// posture: measurements reach relying parties via receipt/cert, not logs).
    #[test]
    fn check_error_omits_measurement() {
        let unknown = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let refs = vec!["a".repeat(64)];
        let msg = check(unknown, &refs, MeasurementGate::Enforce, "vm-x")
            .unwrap_err()
            .to_string();
        assert!(!msg.contains(unknown));
    }

    /// Changing a non-secret field of the contract changes the hash.
    #[test]
    fn contract_non_secret_fields_affect_hash() {
        let c1 = empty_contract();
        let mut c2 = empty_contract();
        c2.workload_cmd = vec!["bash".into()];
        let b1 = contract_bytes_sans_secrets(&c1).unwrap();
        let b2 = contract_bytes_sans_secrets(&c2).unwrap();
        assert_ne!(b1, b2);
    }
}
