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

**TOCTOU limitation.** The manager hashes the kernel/rootfs/harness *by path*
before boot; Firecracker opens them afterwards (and the jailer stages copies).
A process able to rewrite those files between the hash and the open can boot
something other than what was measured. That attacker already controls the host
the measurement trusts, so this is consistent with "host-asserted", but it is a
real gap: a stricter variant would hash the staged per-VM copy Firecracker
actually opens. Image hashes are cached per `(dev, inode, size, mtime, ctime)`,
which shares the same trust assumption.

### Canonical input order

The measurement is SHA-256 over five 32-byte component hashes concatenated in this
fixed order:

| # | Component | Source |
|---|-----------|--------|
| 1 | **kernel image** | SHA-256 of file bytes at `FC_KERNEL_PATH` |
| 2 | **rootfs image** | SHA-256 of file bytes at `FC_ROOTFS_PATH` |
| 3 | **harness binary** | SHA-256 of file bytes at `FC_HARNESS_PATH` (32 zero bytes when unset — harness baked into rootfs) |
| 4 | **boot arguments** | SHA-256 of the kernel cmdline with per-VM tokens, secret refs and the `lantern.env.*` copy removed (see below) |
| 5 | **spawn contract** | SHA-256 of `spawn.json` canonical JSON (env is a `BTreeMap`, so key-ordered) minus secrets and per-VM identity (see below) |

**Final value:** SHA-256 of the 160-byte concatenation of the five 32-byte
hashes (in the order above). Output: 64-character lowercase hex string.

### "Minus secrets" rule

To make the measurement reproducible without live secret material (and to satisfy
invariant #10 — no secrets in logs/traces/receipts), these fields are zeroed
before the spawn-contract hash is computed:

- `declared_secrets` — vault references (URIs only, but URIs reveal vault topology)
- `exec_token` — bearer credential used by the harness for `VendSecret` calls
- `egress_rules[*].inject` — per-rule credential injection specifications
- the **values** of env keys whose name looks credential-bearing (contains
  `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `PRIVATE_KEY`,
  `CREDENTIAL`) — the key is still measured, the value is blanked. A published
  measurement must never be a hash over a live secret. This is a name
  heuristic: a credential under an innocuous name is measured; declare
  credentials as secrets (`lantern.secret/…`) rather than plain env.

### "Minus identity" rule

The measurement must be reproducible across VMs launched from the same images
and spec, or no reference set could ever match it. So per-incarnation values are
excluded too: the contract's `vm_id`, `network` and per-VM `egress_ca_pem`, and
the caller-set per-incarnation env keys (`CALLER_LANTERN_KEYS`:
`LANTERN_AGENT_INSTANCE_ID`, `LANTERN_AGENT_INSTANCE_TOKEN` — a live bearer
credential — `LANTERN_TRACE_PARENT`, `LANTERN_RESUME`); and from the cmdline the
`ip=`, `lantern.vm_id=`, `lantern.run_id=`, `lantern.tls_cert=`/`lantern.tls_key=`
(per-VM paths), `lantern.secret.*` tokens, and **every** `lantern.env.*` token.
The `lantern.env.*` tokens are a lossy legacy copy of the contract env, emitted
in `HashMap` iteration order (so identical specs produced different cmdlines)
and carrying the instance id/token; the harness ignores them when `spawn.json`
is present, and the authoritative env is measured in the contract.

All other spawn-contract fields (workload command, env, egress rules *sans inject*,
uid/gid, egress mode, `LANTERN_TENANT_ID`, `LANTERN_AGENT_VERSION_ID`) and the
remaining cmdline are included. A changed workload command, env value, uid, or
egress policy changes the measurement. Reference values are therefore per
(images, spec, tenant, agent version).

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
without first providing one) — except in production (`LANTERN_ENV`
prod/production/staging), where `enforce` with no references **refuses to
start** the manager. The gate value is trimmed and case-insensitive; an
unrecognised value (e.g. `enforced`) refuses startup rather than silently
degrading to `warn`, and so does a reference that is not 64 hex characters.

### Restore, resume and fork: inherited measurement

A restored guest does not boot from the spawn inputs: it resumes from the
snapshot's vmstate + memory + captured disk. Re-measuring the base images under
the restore-shaped contract (which has, e.g., an empty workload command) would
yield a value no reference matches, so every resume / idle auto-resume / fork
would fail closed under `enforce`. Instead:

1. At snapshot time the manager records the source VM's spawn measurement in
   `SnapshotMeta.software_measurement` (the store's `meta.json`, alongside the
   existing `sha256` digest over all snapshot artifacts).
2. On restore the manager reads it from its own store — never from the caller —
   and the restored VM **inherits** it: same value in its cert extension,
   `ScheduleResponse`, scheduler store and `runtime_vms`, labelled in the audit
   log as `inherited from snapshot source`.
3. The inherited value is re-checked against the **current** reference set, so
   retiring an image's reference also refuses restores of its snapshots.
4. A snapshot with no recorded measurement (taken before this field, or from an
   unmeasured source) is refused under `enforce` with references, and restores
   unmeasured under `warn`/`off`.

The inherited value attests the lineage's *original boot*, not the snapshot's
memory/disk state (which the workload has mutated since); relying parties
needing the latter must use the snapshot `sha256` from the store metadata.

### Binding points

The measurement flows through the system as follows:

1. **Computation**: `services/runtime-manager/src/measurement.rs` — reads the
   image files (streamed, cached) but has no other side effects; called from
   `tokio::task::spawn_blocking` at spawn time. Restores call
   `measurement::check_inherited` instead.
2. **Per-VM cert (X.509 extension)**: embedded by
   `tls::generate_vm_client_cert(vm_id, ca_cert, ca_key, Some(measurement))` as a
   custom extension with OID `1.3.6.1.4.1.99999.3` — a PLACEHOLDER: a
   registered IANA Private Enterprise Number is needed and must replace 99999
   before production use. The DER value
   is a UTF8String containing the 64-character hex measurement.
3. **Handle registry**: stored in `HandleInfo.software_measurement` so the
   manager can return it in `ScheduleResponse` and `List` responses.
4. **Proto propagation**: `VmHandle.software_measurement` (field 5) carries it
   from the manager through the scheduler to the control-plane. The scheduler
   records it from the manager's `Spawn` response for cold spawns
   (`dispatchSpawn`) and restores (`spawnFromSnapshot`: resume + fork) and
   persists it in `sched_vms.software_measurement` so a scheduler restart keeps it.
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

- The first Firecracker spawn per image version streams a SHA-256 over the
  kernel/rootfs/harness (~100 ms per GiB on a typical SSD, constant memory);
  later spawns hit the per-file-identity cache. Restores do not hash images.
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
| `LANTERN_MEASUREMENT_GATE` | `warn` | `off` / `warn` / `enforce`; unknown → refuse to start |
| `LANTERN_REFERENCE_MEASUREMENTS` | _(empty)_ | Comma-separated expected 64-hex measurements; malformed → refuse to start; empty + `enforce` in prod → refuse to start |
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
