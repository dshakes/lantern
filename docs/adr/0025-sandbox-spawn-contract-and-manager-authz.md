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
- A restored VM still runs with the *source* VM's in-guest identity (vm_id,
  cert). Re-issuing identity on restore is a follow-up that belongs with the ADR
  0007 drive-state work. Until then, restore is meant for same-tenant warm starts,
  which ownership enforcement makes safe.
