# ADR 0031 — Host-Asserted Software Measurement

**Status:** Accepted  
**Date:** 2026-10-28  
**Deciders:** Platform team

---

## Context

Operators need a tamper-evident record of *what the runtime-manager claims it
booted* inside each Firecracker microVM. This enables:

- Audit: receipts carry a measurement tied to the exact (kernel, rootfs, harness,
  boot args, spawn contract) tuple that was used.
- Policy gating: a deployment can refuse VMs whose measurement does not match a
  known-good reference set (`LANTERN_MEASUREMENT_GATE=enforce`).
- Debugging: a post-incident investigation can compare the receipt measurement to
  the expected value for that image/harness version.

ADR 0023 covers confidential-compute attestation (AMD SEV-SNP / Intel TDX, which
requires CC hardware and Kata-CC). That remains marked **UNVERIFIED — hardware
required**. The present ADR is a *complementary, orthogonal* mechanism that is
available on *every* Firecracker node regardless of hardware.

---

## Decision

### HOST-ASSERTED, not hardware-attested

The measurement is computed by the **runtime-manager host process** from files it
reads. It proves what the host **recorded** it launched; it does **not** prove
what actually executed inside the VM. A compromised host could forge it.

Hardware attestation (ADR 0023) is the stronger guarantee; this is the pragmatic
step available today on commodity Firecracker nodes. Both mechanisms can coexist.

### Canonical input order

The measurement is SHA-256 over five 32-byte component hashes concatenated in this
fixed order:

| # | Component | Source |
|---|-----------|--------|
| 1 | **kernel image** | SHA-256 of file bytes at `FC_KERNEL_PATH` |
| 2 | **rootfs image** | SHA-256 of file bytes at `FC_ROOTFS_PATH` |
| 3 | **harness binary** | SHA-256 of file bytes at `FC_HARNESS_PATH` (32 zero bytes when unset — harness baked into rootfs) |
| 4 | **boot arguments** | SHA-256 of the kernel cmdline with per-VM tokens removed (see below) |
| 5 | **spawn contract** | SHA-256 of `spawn.json` canonical JSON with secret-bearing fields zeroed (see below) |

**Final value:** SHA-256 of the 160-byte concatenation of the five 32-byte
hashes (in the order above). Output: 64-character lowercase hex string.

### "Minus secrets" rule

To make the measurement reproducible without live secret material (and to satisfy
invariant #10 — no secrets in logs/traces/receipts), these fields are zeroed
before the spawn-contract hash is computed:

- `declared_secrets` — vault references (URIs only, but URIs reveal vault topology)
- `exec_token` — bearer credential used by the harness for `VendSecret` calls
- `egress_rules[*].inject` — per-rule credential injection specifications

### "Minus identity" rule

The measurement must be reproducible across VMs launched from the same images
and spec, or no reference set could ever match it. So per-incarnation values are
excluded too: the contract's `vm_id`, `network` and per-VM `egress_ca_pem`; and
from the cmdline the `ip=`, `lantern.vm_id=`, `lantern.run_id=`,
`lantern.tls_cert=`/`lantern.tls_key=` (per-VM paths),
`lantern.env.LANTERN_MANAGER_ADDR=` (per-VM host IP) and `lantern.secret.*`
tokens (minus-secrets).

All other spawn-contract fields (workload command, env, egress rules *sans inject*,
uid/gid, egress mode) and the remaining cmdline are included. A changed workload
command, changed uid, or changed egress policy changes the measurement.

The value is never written to logs (gate warnings carry only `vm_id`); it reaches
relying parties through the signed receipt, the VM cert extension and
`runtime_vms`. Obtain reference values by running the target images/spec once
with `gate=warn` and reading the receipt.

### Enforce gate

Controlled by `LANTERN_MEASUREMENT_GATE`:

| Value | Behaviour |
|-------|-----------|
| `off` | Measurement computed and recorded; never compared against references. |
| `warn` | Measurement compared; **mismatch logs a WARN and proceeds** (default). |
| `enforce` | Mismatch causes the manager to **refuse to start the VM** with an error. |

Reference values are configured via `LANTERN_REFERENCE_MEASUREMENTS`
(comma-separated lowercase hex strings). An empty list means no reference set is
configured; `warn` mode produces no warning (no comparison possible), and
`enforce` also passes (you cannot fail-closed against an unspecified allowed set
without first providing one).

### Binding points

The measurement flows through the system as follows:

1. **Computation**: `services/runtime-manager/src/measurement.rs` — pure, no I/O
   side effects; called from `tokio::task::spawn_blocking` at spawn/restore time.
2. **Per-VM cert (X.509 extension)**: embedded by
   `tls::generate_vm_client_cert(vm_id, ca_cert, ca_key, Some(measurement))` as a
   custom extension with OID `1.3.6.1.4.1.99999.3` — a PLACEHOLDER: a
   registered IANA Private Enterprise Number is needed and must replace 99999
   before production use. The DER value
   is a UTF8String containing the 64-character hex measurement.
3. **Handle registry**: stored in `HandleInfo.software_measurement` so the
   manager can return it in `ScheduleResponse` and `List` responses.
4. **Proto propagation**: `VmHandle.software_measurement` (field 5) carries it
   from the manager through the scheduler to the control-plane.
5. **Database**: `runtime_vms.software_measurement TEXT` (migration
   `0029_software_measurement`). Written by the reconciler the first time
   `ListStates` returns a non-empty value (i.e., after spawn completes).
6. **Run receipts**: included as `softwareMeasurement` in the signed
   `receiptPayload` (additive — `omitempty` keeps existing receipts byte-identical
   and their Ed25519 signatures valid).

### Async propagation note

The scheduler's `Schedule` gRPC RPC returns a `VmHandle` immediately (before
spawn completes, because spawn is an async goroutine). The `software_measurement`
field is therefore empty in the initial `VmHandle`. The measurement is recorded
on the stored VM (`ClusterStore.SetVMMeasurement`, copy-on-write under the store
lock) in `dispatchSpawn` after the manager's Spawn response arrives, and the control-plane's periodic reconciler reads it via
`ListStates` within its next sweep interval (default 5 s). Receipt generation
(which happens after run completion) therefore always sees the measurement.

---

## Consequences

- Every Firecracker spawn and restore now runs a SHA-256 over three files and two
  small byte strings in a blocking task. The cost is proportional to image size
  (~100 ms per GiB on a typical SSD); it is measured once, not at runtime.
- A missing image file makes the computation fail-open (measurement is `None`,
  warn-logged, VM starts normally) under `off`/`warn`: a measurement gap is
  better than an unbootable cluster because the harness binary moved. Under
  `enforce` with a reference set it is fail-CLOSED — an unmeasurable boot must
  not slip past the gate meant to stop it.
- `enforce` mode is an ops decision. Deployers MUST populate
  `LANTERN_REFERENCE_MEASUREMENTS` before enabling it; with an empty list the
  gate passes everything (it cannot fail closed against an unspecified set), so
  `enforce` without references is NOT protection.
- The X.509 OID `1.3.6.1.4.1.99999.3` is a PLACEHOLDER: Lantern holds no
  registered IANA Private Enterprise Number yet, and one is needed. It must be
  replaced with the assigned IANA PEN before cross-organisation certificate
  verification is meaningful.
- This mechanism does NOT replace ADR 0023. It is a complement: cheaper,
  ubiquitous, host-trusted; ADR 0023 is stronger, hardware-dependent,
  confidential-compute only.

---

## Env vars added

| Var | Default | Purpose |
|-----|---------|---------|
| `LANTERN_MEASUREMENT_GATE` | `warn` | `off` / `warn` / `enforce` |
| `LANTERN_REFERENCE_MEASUREMENTS` | _(empty)_ | Comma-separated expected hex measurements |
| `FC_HARNESS_PATH` | _(unset)_ | Path to separately-installed harness binary; 32 zero bytes when unset |

---

## Alternatives considered

**Skip until hardware attestation (ADR 0023)**: Hardware CC requires specific
nodes and Kata-CC. The host-asserted measurement is a pragmatic step that works
on every Firecracker node today.

**Record in a separate audit log instead of the receipt**: Receipts are the
verifiable artifact operators share. Binding the measurement to the receipt
makes the chain unforgeable without access to the signing key.

**Use HMAC instead of SHA-256 chaining**: The chained SHA-256 scheme provides
binding (order matters) and is entirely deterministic — the same inputs always
produce the same value with no key material, making it suitable as a reference
value operators store in configuration.
