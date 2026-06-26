# scheduler

Cron + delayed-run scheduler. Selects due `schedules` rows, takes a Postgres
advisory lock (multi-replica safe), advances `next_fire_at`, and **creates a run
via the control-plane** for the schedule's agent.

## Creating runs (control-plane RunService)

When a schedule fires, the scheduler does **not** write the `runs` table directly
(invariant #2). It calls `RunService.CreateRun` on the control-plane gRPC server
through `internal/runclient`:

- One long-lived `grpc.ClientConn` is dialed at startup and shared by the cron
  ticker and the delayed-run processor; it is closed on shutdown.
- The request is built with `trigger_kind = TRIGGER_KIND_SCHEDULE` and the
  schedule's `input_template` (a JSON object) decoded into the run input struct.
- **Invariant #7:** the schedule's `tenant_id` is injected into outgoing gRPC
  metadata under the key `tenant_id`, which the control-plane's tenant
  interceptor reads.
- A run that fails to create after retries is moved to the `dead_letter` table.

### Env

| Var                           | Default            | Purpose                                                                                                       |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `CONTROL_PLANE_ADDR`          | `localhost:50051`  | Control-plane gRPC address the scheduler dials for `CreateRun`. In-cluster: `control-plane:50051`.            |
| `LANTERN_GRPC_SERVICE_TOKEN`  | _(unset)_          | When set, attached as `x-lantern-service-token` metadata so the control-plane's service-token interceptor accepts the call. When unset, nothing extra is attached (additive, dev pass-through). |

Transport is insecure (cleartext) — the scheduler↔control-plane hop is on a
private network / service mesh, matching how the runtime-scheduler dials the
runtime-manager.
