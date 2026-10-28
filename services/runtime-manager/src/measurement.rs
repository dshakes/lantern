//! Host-asserted software measurement (ADR 0030).
//!
//! At spawn/restore the manager computes a SHA-256 over the five canonical
//! inputs it directly controls: kernel image, rootfs image, harness binary
//! (when separately installed), kernel boot arguments, and the spawn contract
//! without secret material. The result is a single 64-character lowercase hex
//! string — the "software measurement" — that uniquely identifies what the
//! host *claims* it booted.
//!
//! # HOST-ASSERTED, not hardware-attested
//!
//! This measurement is computed and recorded by the manager host. It proves
//! what the host recorded it launched; it does **not** prove what actually ran
//! inside the VM. Hardware attestation (AMD SEV-SNP / Intel TDX) is a
//! separate concern covered by ADR 0023. Both can coexist: the host-asserted
//! measurement is available on every Firecracker node; hardware attestation
//! requires CC hardware and Kata-CC.
//!
//! # Canonical input order (ADR 0030 §Measurement algorithm)
//!
//! 1. **kernel image** — SHA-256 of file bytes at `FC_KERNEL_PATH`
//! 2. **rootfs image** — SHA-256 of file bytes at `FC_ROOTFS_PATH`
//! 3. **harness binary** — SHA-256 of file bytes at `FC_HARNESS_PATH`
//!    (optional; 32 zero bytes when the harness is baked into the rootfs and
//!    no separate path is configured)
//! 4. **boot arguments** — SHA-256 of the kernel cmdline UTF-8 bytes
//! 5. **spawn contract** — SHA-256 of the spawn.json canonical JSON with
//!    secret-bearing fields zeroed out (see below)
//!
//! **Final value:** SHA-256 of the 160-byte concatenation of the five
//! 32-byte component hashes, in the order above.
//!
//! # "Minus secrets" for the spawn contract
//!
//! Secrets are excluded so the measurement is reproducible without access to
//! runtime credential values and so invariant #10 (no secrets in logs/traces)
//! is satisfied. Fields cleared before hashing:
//! - `declared_secrets` (vault refs)
//! - `exec_token` (bearer credential)
//! - `egress_rules[*].inject` (credential-injection specs)
//!
//! # Enforce gate
//!
//! Controlled by `LANTERN_MEASUREMENT_GATE` (`off` | `warn` | `enforce`):
//!
//! - `off` — measurement is computed and recorded but never compared.
//! - `warn` (default) — measurement is compared to reference values
//!   (`LANTERN_REFERENCE_MEASUREMENTS`); a mismatch is warn-logged and the
//!   VM is allowed to start.
//! - `enforce` — a mismatch causes the manager to refuse to start the VM.
//!
//! Reference values are configured as `LANTERN_REFERENCE_MEASUREMENTS`, a
//! comma-separated list of lowercase hex SHA-256 strings. An empty list means
//! no reference set is configured; `warn` mode produces no warning when there
//! are no reference values to compare against (no comparison can be made).

use sha2::{Digest, Sha256};

use crate::backends::firecracker::SpawnContract;

/// OID arc for the Lantern software-measurement X.509 extension.
///
/// `1.3.6.1.4.1.99999.3` — private arc under a placeholder PEN.
/// Replace 99999 with the assigned PEN before production deployment.
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
    /// Read the gate mode from `LANTERN_MEASUREMENT_GATE`.
    pub fn from_env() -> Self {
        match std::env::var("LANTERN_MEASUREMENT_GATE")
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "enforce" => MeasurementGate::Enforce,
            "off" | "0" | "false" | "disabled" => MeasurementGate::Off,
            _ => MeasurementGate::Warn, // includes "warn", "", or anything unrecognised
        }
    }
}

/// Load the reference measurement set from `LANTERN_REFERENCE_MEASUREMENTS`
/// (comma-separated lowercase hex strings). Returns an empty `Vec` when the
/// env var is absent or blank.
pub fn reference_measurements_from_env() -> Vec<String> {
    std::env::var("LANTERN_REFERENCE_MEASUREMENTS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect()
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
    let args_hash = hash_bytes(boot_args.as_bytes());
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
                measurement,
                "SECURITY: software measurement does not match any reference value \
                 (gate=warn — proceeding; set LANTERN_MEASUREMENT_GATE=enforce to block)"
            );
            Ok(())
        }
        MeasurementGate::Enforce => {
            tracing::error!(
                target: "lantern_audit",
                vm_id,
                measurement,
                "SECURITY: refusing to start VM — software measurement does not match \
                 any reference value (gate=enforce)"
            );
            Err(anyhow::anyhow!(
                "SECURITY: software measurement {measurement} does not match any \
                 configured reference value; set LANTERN_MEASUREMENT_GATE=warn \
                 to allow with a warning, or update LANTERN_REFERENCE_MEASUREMENTS"
            ))
        }
        MeasurementGate::Off => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hash_file(path: &str) -> anyhow::Result<[u8; 32]> {
    let bytes =
        std::fs::read(path).map_err(|e| anyhow::anyhow!("measurement: read {path}: {e}"))?;
    Ok(hash_bytes(&bytes))
}

fn hash_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

/// Serialize `contract` to canonical JSON with secret-bearing fields zeroed.
fn contract_bytes_sans_secrets(contract: &SpawnContract) -> anyhow::Result<Vec<u8>> {
    let mut s = contract.clone();
    s.declared_secrets = Vec::new();
    s.exec_token = String::new();
    for rule in &mut s.egress_rules {
        rule.inject = Vec::new();
    }
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
