# ADR 0023 — Confidential compute: a `bool` on `AgentSpec`, orthogonal to the isolation-class axis

- **Status:** Accepted; implementation partial — placement + measurement recording
  implemented and unit-tested; attestation UNVERIFIED — not validated on SEV-SNP/TDX
  hardware; not a confidentiality guarantee.
- **Date:** 2026-07-24
- **Deciders:** Lantern runtime team
- **Tags:** runtime, security, confidential-compute, attestation, regulated-verticals
- **Related:** [ADR 0009 — Kubernetes as default runtime substrate](0009-kubernetes-default-runtime-substrate.md),
  [ADR 0022 — Two-tier agent runtime](0022-two-tier-agent-runtime.md),
  [18-agent-runtime-nextgen](../architecture/18-agent-runtime-nextgen.md)

## Context

Regulated verticals (HIPAA, FedRAMP, financial services) require that agent
workloads run in **memory-encrypted VMs** — hardware-enforced isolation where
neither the hypervisor nor the host OS can inspect guest memory. The relevant
technologies are **AMD SEV-SNP** (Secure Encrypted Virtualization with Nested
Paging) and **Intel TDX** (Trust Domain Extensions). Both are surfaced in
Kubernetes as **Kata Confidential Containers** (`kata-qemu-snp`, `kata-qemu-tdx`,
or a cluster-operator-named RuntimeClass).

Before this ADR, Lantern had no mechanism for an agent author to request
memory-encrypted execution, and the runtime had no way to refuse a confidential
workload from landing on a non-CC node.

The key design question was **where confidential compute sits relative to the
existing `IsolationClass` enum** (ADR 0002, revised in ADR 0009). Two options
were considered:

1. Add a new `IsolationClass` value (e.g. `ISOLATION_CONFIDENTIAL`).
2. Add `bool confidential = 17` on `AgentSpec` — a flag that composes
   orthogonally with any existing isolation class.

## Decision

**`bool confidential` on `AgentSpec` (proto field 17), orthogonal to
`IsolationClass`.** Its full comment in `runtime.proto`:

> SEV-SNP/TDX; implies Kata-CC on a CC-capable node; refused fail-closed,
> never downgraded.

The flag threads through the entire runtime stack:

1. **Control-plane** — `agent manifest confidential:true` → `agentSpecDTO` →
   `specMap` → `runtime_vms.confidential` (persisted at schedule time) +
   `runtime_audit_events` (schedule audit record). The `agentSpecDTO` carries
   the flag from the manifest; the `scheduleSpec` includes it in the gRPC call
   to the scheduler.

2. **Runtime-scheduler** — nodes advertise CC capability and tech via heartbeat
   (`cluster.NodeState.CCCapable`, `CCTech`). The placement filter skips any
   node where `!node.CCCapable` when `workload.Confidential` is set. No CC node
   available → the existing "no suitable node" path → `microvm_unavailable`
   upstream. Placement tests cover: confidential workload placed on CC node only;
   confidential workload with no CC node hits the no-suitable-node error; a
   non-confidential workload is unaffected by the CC filter.

3. **Runtime-manager** — two fail-closed gates, both unit-tested:
   - **`choose_backend`** (gate 1): `confidential` requires
     `backend.satisfies_confidential()`. For the K8s backend this returns `true`
     ONLY when `LANTERN_RUNTIMECLASS_KATA_CC` is configured AND the RuntimeClass
     was confirmed present by the startup preflight. Refusal emits `gRPC
     failed_precondition` + a `"SECURITY: refusing to schedule"` log line.
     Never downgraded.
   - **`build_job`** (gate 2): `confidential && kata_cc.is_none()` → bail.
     Defense-in-depth for any future caller that bypasses gate 1.

   When `confidential` passes both gates: the Kata-CC RuntimeClass overrides the
   isolation-class → RuntimeClass mapping, `LANTERN_CONFIDENTIAL=1` is injected
   into the pod env, and node affinity + toleration on the operator-set label
   `lantern.dev/confidential-compute` ensures the pod lands only on CC hardware.

4. **Harness** — on boot, when `LANTERN_CONFIDENTIAL=1`, the in-VM harness
   (`services/harness/src/cc_attest.rs`) makes a **best-effort** read of the
   CC launch measurement (SEV-SNP `/dev/sev` report / TDX `configfs-tsm` or
   `/dev/tdx_guest` quote paths). The raw bytes are sha256'd; the hash (never
   the raw bytes) is forwarded as a `cc_attestation` audit frame with attributes
   `{cc_tech, runtime_class, measurement_present, measurement_sha256?,
   verified:"false"}`. If no device path is readable, `measurement_present=false`
   and the frame still emits (no panic, no silent skip of the frame).

5. **Persistence + receipts** — migration `0017_confidential_compute` adds
   `confidential BOOLEAN`, `cc_tech TEXT`, and `attestation JSONB` to
   `runtime_vms`. When `POST /v1/runs/{id}/receipt` is called for a run that
   was scheduled confidential, the receipt gains an **additive**
   `confidentialCompute` block:

   ```json
   {
     "requested": true,
     "tech": "<cc_tech or null>",
     "runtimeClass": "<kata-cc class name>",
     "measurementSha256": "<hex, if present>",
     "attested": false
   }
   ```

   `attested` is **always `false`**. The measurement is recorded, not verified.

### Resolved decision — isolation floor

A confidential workload **upgrades any weaker isolation class to HOSTILE-tier**
(the Kata microVM tier, per ADR 0009). This is an upgrade only — never a
downgrade — and it **emits a visible log line** recording the upgrade
(`"confidential-compute: upgrading isolation to HOSTILE-tier (upgrade only,
audited)"`). The upgrade is never silent.

Rationale: a confidential workload runs in a memory-encrypted microVM regardless
of the requested class. Allowing an under-isolated substrate (e.g. `STANDARD`,
which maps to gVisor) for a confidential request would contradict the intent of
the flag. The floor closes that gap.

### Helm opt-in

Two new `runtimeManager` Helm values in `infra/helm/lantern-data-plane/values.yaml`:

| Value | Purpose |
|-------|---------|
| `runtimeManager.runtimeClasses.kataCc` | `runtimeClassName` for CC pods (e.g. `"kata-qemu-snp"`). Empty → confidential workloads refused. |
| `runtimeManager.ccTech` | Hint to the harness (`LANTERN_CC_TECH`) for tech detection. |

Operators must also label and taint CC-capable nodes:

```
lantern.dev/confidential-compute=<tech>   # e.g. sev-snp or tdx
```

This mirrors NFD (`node-feature-discovery`) labels for SEV-SNP/TDX.

## Alternatives considered and rejected

### A new `IsolationClass` enum value

Adding `ISOLATION_CONFIDENTIAL = 7` (or similar) would express confidential
compute as another point on the trust-isolation ladder. **Rejected.** Confidential
compute is **orthogonal** to the trust-isolation axis: a workload can be
`HOSTILE` (full microVM, no co-tenancy) AND confidential (memory-encrypted), or
`STANDARD` AND confidential. A bool composes with any class; an enum value would
force a false either/or and require a 2×N matrix of enum values across the
isolation × confidential space to cover the real combinations.

### Pod-level confidential containers without a VM boundary

Confidential containers that encrypt pod memory without a full VM boundary (e.g.
`cc-krunvm` in shared-kernel mode). **Rejected.** The guarantee we want is
VM-level memory encryption where the hypervisor is also excluded from guest
memory. Pod-level approaches without a VM boundary offer a weaker property that
does not meet the HIPAA/FedRAMP requirement.

### Raw Firecracker + SEV-SNP

Running Firecracker with SEV-SNP support directly, without Kata as the K8s
bridge. **Rejected.** This would introduce a second microVM substrate running
in parallel with the Kata/K8s substrate chosen in ADR 0009. The operational
cost of a parallel stack — separate provisioning, separate preflight, separate
CI path — is not worth it for v1. Kata already supports `kata-qemu-snp` and
`kata-qemu-tdx`; Kata-CC reuses everything ADR 0009 already provisions.

### Attestation-gated secret vending (release secrets only after a verified quote)

Having the `VendSecret` RPC (ADR 0005/0008) require a valid remote attestation
quote before releasing secrets, so secrets only reach a VM whose measurement
matches a known-good reference. **Deferred to v2.** This requires: (a) a
reference value store (known-good measurements per agent version / kernel),
(b) a remote attestation verifier service, and (c) protocol changes to the
`VendSecret` RPC to carry the quote. V1 records the measurement for later
comparison; v2 enforces it at the secret-release boundary. Deferring is honest
given the hardware is not yet validated.

## Consequences

### Positive

- Agent authors can declare `confidential: true` in their manifest and the
  runtime refuses to run the workload anywhere that cannot honor it — no silent
  downgrade, no fallback to a non-CC node.
- The isolation floor means a mis-declared isolation class cannot accidentally
  under-isolate a confidential workload; the upgrade is audited.
- The `confidentialCompute` receipt block gives auditors a durable, signed record
  that a run was scheduled confidential and what measurement the harness observed —
  even before attestation verification is wired.
- No protocol change for non-confidential workloads; the bool defaults to `false`
  and every existing path is unaffected.

### Negative / limitations

- **Attestation is UNVERIFIED.** The harness records the launch measurement, but
  there is no verifier, no reference value store, and no gating of secret release
  on quote validity. `attested: false` in the receipt is the honest statement of
  this. Do not claim this feature "provides confidentiality" or "attests" — it
  records an unverified measurement.
- **Hardware not validated.** The harness CC device paths (`/dev/sev`,
  `/dev/tdx_guest`, `configfs-tsm`) have been tested against the code but not
  validated on real SEV-SNP or TDX hardware.
- **Kata-CC must be installed and labelled by the operator.** If
  `LANTERN_RUNTIMECLASS_KATA_CC` is unset, confidential workloads fail closed;
  no automatic provisioning.
- **Only the K8s backend supports confidential compute.** Firecracker and Wasm
  backends return `satisfies_confidential() = false`; confidential requests routed
  to them are refused at gate 1.

### Open / v2

- Remote attestation verifier + reference value store.
- `VendSecret` gated on a verified quote (attestation-gated secret release).
- Support for `kata-qemu-tdx` as a second CC tech with independent preflight.
- Hardware validation on a real SEV-SNP node in CI.
- **Attestation backfill.** The harness `cc_attestation` frame is forwarded to
  the manager today, but the path that persists it into
  `runtime_vms.attestation` (so the receipt block surfaces `cc_tech` /
  `runtime_class` / `measurement_sha256`) is not yet wired. Until it is, the
  receipt block honestly reports `requested` + `attested:false` with the
  evidence fields empty. Recording only — this does not change the UNVERIFIED
  status.
