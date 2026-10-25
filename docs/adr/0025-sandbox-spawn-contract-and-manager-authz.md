# ADR 0025 — Sandbox spawn contract file, manager per-call authz, ExecTool tenant scoping, snapshot ownership

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** Lantern runtime, security
- **Tags:** runtime, security, trust-boundary, multi-tenant, snapshots

## Context

An audit of `services/runtime-manager` found four gaps at the manager ↔ guest
and manager ↔ caller boundaries (invariants #5, #7, #8):

1. **The guest never learns what to run.** `build_boot_args` passes only the
   VM id, TLS paths and caller env on the kernel cmdline. The workload command,
   the egress rules and `LANTERN_WORKLOAD_UID` are never sent, so the harness's
   secrets-socket peer auth and egress enforcement (P2-B7) have no inputs. Env values
   are also mangled: spaces and quotes are replaced with `_` because the
   cmdline is whitespace-split.
2. **The manager has no per-call authz.** Each VM gets a client cert (CN = vm_id)
   signed by the same CA the manager server trusts. Because the TLS layer
   accepts any CA-signed cert, a guest holding its own cert can call
   `RuntimeManager.Exec/Stop/ExecTool/Snapshot` on *any* vm_id.
3. **ExecTool is not tenant-scoped.** `ExecToolRequest` carries no tenant, so the
   manager cannot tell whether the caller's run owns the target VM.
4. **Snapshots have no owner.** Snapshot metadata records `agent_version_id =
   "unknown"` and no tenant, so any tenant that knows a snapshot id could restore
   it. `AgentSpec.restore_snapshot_id` was also ignored while `SpawnResponse`
   reported `from_snapshot = true` anyway.

## Decision

### 1. Spawn contract file (`spawn.json`)

The manager writes `spawn.json` at the **root of the read-only cert image** it
already attaches to every Firecracker VM (`certs.img`, mode 0600 inside):

```json
{"version":1,
 "workload_cmd":["python","-c","print('a b')"],
 "env":{"K":"value with \"quotes\" and spaces"},
 "egress_rules":[{"pattern":"*.openai.com","http_methods":["POST"],"rate_bps":0}],
 "workload_uid":1000,
 "workload_gid":1000}
```

- `workload_cmd` = `AgentSpec.command ++ AgentSpec.args`; `env` = the spawn env
  after the manager's own injections; `egress_rules` = `AgentSpec.egress_rules`.
- `workload_uid` comes from `LANTERN_WORKLOAD_UID_DEFAULT` on the manager (default
  1000), and `workload_gid` from `LANTERN_WORKLOAD_GID_DEFAULT` (default = uid).
  The manager sets these values. A caller-supplied `LANTERN_WORKLOAD_UID` in the
  spec env is dropped, because a caller who could choose the uid that peer auth
  trusts would defeat the check.
- JSON is the transport, so values arrive byte-exact. `version` lets the
  schema evolve: the harness rejects versions it does not know.
- The kernel cmdline (`lantern.env.*`, `lantern.secret.*`) is **kept** for
  backward compatibility with harness builds that predate the file, and the
  manager now also emits `lantern.env.LANTERN_WORKLOAD_UID`. When the harness
  finds `spawn.json`, it uses the file and ignores the cmdline env.

### 2. Manager per-call authz

A tonic interceptor on the `RuntimeManager` service:

- **VM certs are refused.** Per-VM certs now carry a marker
  (`OU=lantern-vm`). A peer that presents one gets `PERMISSION_DENIED` on every
  `RuntimeManager` method, even if it also has the token. Guests may reach only
  `RuntimeHarness`. Those methods keep their existing per-message binding (cert
  CN/SAN must equal the request's `vm_id`; Heartbeat/VendSecret/Report).
- **A service token is required.** Callers must send `x-lantern-service-token`
  equal to `LANTERN_GRPC_SERVICE_TOKEN`, compared in constant time. This is the
  same token and header the control-plane, workflow-engine and scheduler use
  (invariant #7).
- **Prod fails closed.** With `LANTERN_ENV` = prod/production/staging and the
  token unset, the manager refuses to start. In dev an unset token logs a warning
  and calls are allowed, which matches the Go services.

**Rollout consequence:** the manager's callers (the scheduler dialer, the
control-plane's direct exec client, and the workflow-engine's ExecTool client)
must attach the token as per-call credentials *before* the token is set on the
manager. Until then, leave the token unset on the manager (dev only).

### 3. ExecTool tenant scoping

`ExecToolRequest.tenant_id` (field 8) is added. The workflow engine sets it from the run's tenant.
The manager compares it with the registry's `HandleInfo.tenant_id`. A mismatch,
or an empty value in prod, returns `NOT_FOUND`, so the call does not reveal
whether the VM exists. An empty value in dev is allowed for rollout. The
`run_id`-only lookup applies the same filter.

### 4. Snapshot ownership and restore

- Snapshot metadata records the owning `tenant_id` and the real `agent_version_id`
  (now a `HandleInfo` field). Restore of a snapshot whose `tenant_id` differs
  from the spawn's returns `NOT_FOUND`. A legacy snapshot with no tenant also
  returns `NOT_FOUND`, and so does a malformed (non-UUID) id.
- `AgentSpec.restore_snapshot_id` now drives an actual `backend.restore` through
  the post-isolation-gate backend. A backend that cannot restore from the
  snapshot store returns `FAILED_PRECONDITION` instead of cold-booting and
  reporting `from_snapshot = true`.
- Snapshot save streams artifacts from disk into the store, using a 1 MiB buffer for both
  the hash and the S3 upload. The guest memory file is never loaded fully into
  RAM.

### 5. Spawn idempotency

The scheduler-issued vm_id is **reserved** before booting and released after
the registry rekey or on failure. A concurrent duplicate Spawn gets `ABORTED`
and should retry. The retry then hits the registry and receives the original
handle. Before this change, two concurrent Spawns could both pass the registry
check and boot two VMs.

## Consequences

- A guest that leaks its cert can no longer control other VMs. Exfiltrating its
  cert gains nothing beyond its own harness channel.
- Callers need a coordinated rollout to send the token (see §2).
- ~~A restored VM still runs with the *source* VM's in-guest identity.~~
  Superseded by the addendum below: a restore re-issues identity.

## Addendum (2026-10-23) — one identity per VM: wire vm_id at boot, re-identity on restore

Wave 2 adds pause (Snapshot + Stop), resume (Spawn with the **same** wire
vm_id and `restore_snapshot_id`) and fork (Spawn **N new** wire vm_ids, each
restoring the same snapshot). Two defects blocked that.

### A. Boot under the wire vm_id (identity gap)

The Firecracker backend booted every VM under its own random UUID, which became
the cert CN and the harness `vm_id`. The registry was then rekeyed to the
scheduler's wire vm_id. As a result, harness Heartbeat and VendSecret lookups
by the UUID missed after the rekey.

**Decision.** `Spawn` copies `SpawnRequest.handle.vm_id` into the internal
`ScheduleRequest.vm_id`. Firecracker boots under that id, so the cert CN/SAN,
the `lantern.vm_id` boot-arg, `spawn.json.vm_id`, the `Handle.id` and the
registry key are all the same value. The id is validated before it names host
paths: 1-64 chars of `[A-Za-z0-9-]` with at least 12 hex digits. The
scheduler's `vm-<uuid>` passes. The TAP name is `fc-` + the first 8 **hex
digits** of the id, which matches the old naming for UUID ids. The rekey stays
for backends that mint their own ids (docker/k8s) and is a no-op when the ids
are equal.

### B. A restore is a new identity

A snapshot freezes the whole guest identity: in memory, the vm_id, the private
key, the secret cache and the `ip=` addressing; in the vmstate, the NIC's TAP
and the cert drive. Resuming it as-is would run N forks as one VM.

**Mechanism (smallest correct one under Firecracker's snapshot model):**

1. **Manager, before the guest runs.** `backend.restore` builds a full
   `VmConfig` for the restoring request's vm_id. That gives it a fresh /30 +
   TAP, a freshly issued cert (CN/SAN = new vm_id, new key) and a fresh
   `certs.img` whose `spawn.json` carries the **restoring request's** contract
   (`vm_id`, `declared_secrets`, `egress_rules`, env, `network`). The API
   sequence is pure and unit-tested (`plan_identity_restore`):
   `PUT /snapshot/load {resume_vm:false, network_overrides:[eth0 → own TAP]}`,
   then `PATCH /drives/certs {path_on_host: new image}`, then
   `PATCH /vm {Resumed}`. Jailed restores also stage the new `certs.img` (and
   the base rootfs) at the in-jail basenames the vmstate references.
2. **Manager, authz.** The registry pins the SHA-256 of the cert issued for the
   VM's *current incarnation* (`HandleInfo.cert_sha256`, from
   `RuntimeBackend::identity_pin`). Heartbeat, VendSecret and Report require
   that exact cert. A cert frozen into a snapshot has the right CN but a
   superseded fingerprint, so it is refused. This covers a resume under the
   same id, and someone replaying the snapshot's stolen key. Secrets vended to
   the old identity cannot be refreshed. The pin is dropped on Stop.
3. **Guest, re-identify** (`services/harness/src/reidentify.rs`). Every
   `mke2fs` image gets a new ext4 UUID. The harness records the cert drive's
   UUID at boot and polls it every second (`posix_fadvise(DONTNEED)` + a 2 KiB
   read). When the UUID changes, the harness:
   - remounts the drive and overwrites the harness-only cert/key/CA copies in
     place. TLS config is re-read on every connect, so no environment mutation
     is needed.
   - clears the secret cache and adopts the new declared secrets and egress
     rules.
   - re-addresses eth0 (SIOCSIFADDR/NETMASK, default route) and re-pins
     `manager.lantern.internal` in `/etc/hosts`.
   - swaps the shared `vm_id` and bumps an identity generation, which tears
     down the Heartbeat and Report streams so they reconnect under the new
     cert.
   - adopts the new incarnation's tokens, held in the same shared state as
     `vm_id`, so every reader sees the live value:
     - `exec_token`: a typed `spawn.json` field that becomes
       `LANTERN_HARNESS_EXEC_TOKEN`. The exec server's interceptor reads it per
       call, so the previous token is rejected as soon as the swap lands.
     - `LANTERN_AGENT_INSTANCE_TOKEN` from the new contract's `env`. The
       control plane mints this per fork child.

     If exec was authenticated and the new drive carries no exec token, the
     re-identify is refused rather than keeping the old token.

   A drive whose `spawn.json` has no `vm_id` is refused, and the harness
   retries on the next tick. The fail-closed property comes from item 2, not
   from the poll.

**Not re-applied:** workload argv/env/uid. The restored workload is already
running, and that state is what the snapshot exists to keep. Its tenant and
contract, as enforced by the manager (registry tenant, secrets allowlist,
egress), are the restoring request's.

### Exec token per incarnation

The manager mints a fresh exec token for every spawn **and** every restore,
including a resume under the same vm_id. It is 244 bits taken from two v4
UUIDs. The token is written only to the 0600 cert image, never to the kernel
cmdline, and is recorded as `HandleInfo.exec_token`. The manager's two harness
exec clients (Exec and ExecTool) send it as `authorization: Bearer`. Before
this change the manager sent no token, so prod exec, which requires a token,
could never authenticate.

### Bare-mode fork of a running source fails closed

A bare (non-jailed) restore reuses the snapshot's host paths verbatim,
including the source VM's vsock UDS and `certs.img`. So when the snapshot's
source vm is still registered on this node and the backend reports
`restore_needs_stopped_source()` (bare Firecracker), the restore returns
`FAILED_PRECONDITION` with the message "fork of a running VM requires the
jailer". A resume is unaffected, because its source was stopped first. Jailed
restores give each VM its own paths and are allowed.

### Snapshot id for pause → resume/fork

`RuntimeManager.Snapshot` returns `SnapshotResponse.snapshot_id` (field 1).
That value is the bare snapshot-store id (a UUID, no `store://` prefix). Pass it
back verbatim as `AgentSpec.restore_snapshot_id`. The snapshot is recorded
under the registry tenant of the snapshotted VM, and restore is
ownership-checked against `AgentSpec.tenant_id` (§4). `SnapshotResponse.sha256`
is currently empty. Snapshot now reads the artifacts from the path the backend
reports (`fc://…`, chroot-expanded for jailed VMs). Before this change, the
service read the bare `/run/lantern/snapshots/<id>` path, so every jailed pause
failed.

### Residual risks (need a real KVM host to close)

- `network_overrides` needs Firecracker >= 1.12. Older VMMs reject the load.
- `PATCH /drives` between load and resume is assumed allowed. The guest must
  observe the new backing file; it unmounts the drive after every read, which
  drops its page cache, and also fadvises.
- The vmstate's drive and vsock paths must resolve at load. A bare fork of a
  *live* source is refused (see above). A bare fork of a stopped source still
  needs the source's `certs.img` on disk. Jailed mode stages the **base**
  rootfs, not the source VM's disk state (ADR 0007 Tier 2).
- Fork of a live source: until the fork re-identifies (≤ ~1 s), it holds the
  source's still-valid cert and IP. Exposure is same-tenant only, because
  ownership gates the restore.
- The guest re-addressing ioctls and the default-route swap are compiled and
  unit-adjacent only. They are not exercised on a real guest kernel.

## Follow-ups

- **Snapshot reclamation.** The manager has no snapshot-delete RPC, so Wave 2
  pause/resume/fork snapshots are never reclaimed. Terminating a PAUSED VM, or
  the last fork child that references a snapshot, leaves the snapshot on its
  node. The scheduler logs `snapshot orphaned` at info with `snapshot_id`,
  `vm_id`, `node` and `tenant_id`, and does not try to delete it. Needed: an
  add-only `RuntimeManager.DeleteSnapshot(snapshot_id)` with the same
  owner-tenant check as restore. The scheduler calls it best-effort when the
  last reference goes away. A running fork source does not hold its fork
  snapshot id, so only the children count as references.
