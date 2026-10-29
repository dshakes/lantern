# Runbook — enabling the staged GA features

> **Audience:** operators turning Lantern's deliberately-staged features on in production.
> **Goal:** each feature below is **built and tested**; this is the safe enable + verify + rollback procedure for the parts that ship OFF by default so an operator can flip them on intentionally rather than by accident.

These five were left as explicit opt-ins (not auto-on) because each either needs a one-time DB/role change, real-traffic validation, or operator-provided infrastructure. They are not unfinished code — they are config + ops gates.

---

## 1 · Row-Level Security enforcement — ADR&nbsp;0011

**State:** RLS policies exist on every tenant-scoped table; the handler cutover is complete (0 non-exempt `srv.Pool` sites). The control-plane **refuses to boot in production** without enforcement configured — see `rlsGuardDecision` in `cmd/server/main.go` (fatal when `LANTERN_ENV` is prod/production/staging and `LANTERN_RLS_ENFORCE != 1` or `LANTERN_APP_DB_PASSWORD` is empty). So prod *cannot* silently run without tenant isolation.

**Enable (one-time + env):**
```sql
-- give the non-superuser app role a real password (it is subject to RLS;
-- the privileged `lantern` superuser bypasses it)
ALTER ROLE lantern_app PASSWORD '<strong-random>';
```
```bash
# control-plane env
LANTERN_RLS_ENFORCE=1
LANTERN_APP_DB_PASSWORD=<strong-random>
```
Restart the control-plane.

**Verify (DB-gated — needs a real Postgres):**
```bash
cd services/control-plane
DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
  go test ./internal/db -run TestRLSEnforcement -count=1
```
Proves cross-tenant reads/writes are denied and same-tenant works. `TestRLSEnforcement_AllTenantTables` is the permanent catalog gate — a new tenant table without RLS (or an explicit exemption) fails it.

**Rollback:** unset `LANTERN_RLS_ENFORCE` (dev only — prod will refuse to boot).

---

## 2 · Model-router cutover — ADR&nbsp;0014

**State:** default **OFF**. When ON, *plain* provider completions route through the model-router; **any** router error (dial/timeout/non-OK/empty body) falls through to the direct provider chain, so a caller never sees a router failure. claude-code and the tool-use loop stay on the direct path. Seam: `callLLMWithFailover` in `internal/handlers/llm_proxy.go`.

**Enable — staged, never all-at-once:**
```bash
LANTERN_USE_MODEL_ROUTER=1
LANTERN_MODEL_ROUTER_ADDR=model-router:50053
```
1. Turn it on for a **non-bridge tenant first**.
2. Watch traces (`gen_ai.*` + router spans) and the error rate. The fallback keeps it safe at every step.
3. Only then enable on the bridge tenant (the WhatsApp/iMessage live path).

**Verify:**
```bash
cd services/control-plane && go test ./internal/handlers -run ModelRouter -count=1
```
Covers: flag-off → router never dialed; flag-on → response mapped; flag-on error → falls back to direct, error never leaked.

**Rollback:** unset the flag → direct path, instantly.

**Security:** for cross-trust-zone deployments the control-plane↔model-router gRPC hop must run over **mTLS** — it ships the tenant's AES-GCM key in `CompleteRequest.provider_credentials` (invariant&nbsp;#10).

---

## 3 · Kata live execution — ADRs&nbsp;0002 / 0009

**State:** `choose_backend` + `build_job` set the per-workload `RuntimeClass`; HOSTILE → Kata microVM (no co-tenancy). The cluster-e2e legs in `e2e/runtime/` ship **wired and SKIP-GREEN** without an operator kubeconfig — GitHub-hosted runners cannot nest-virtualize, so this is not fakeable in CI.

**Requirement (operator-provided — cannot run on a dev Mac or CI):** a Kubernetes cluster with the **Kata runtime installed** and a `kata` `RuntimeClass`, on bare-metal or nested-virt-capable nodes.

**Validate on a real cluster:**
```bash
KUBECONFIG=/path/to/cluster.kubeconfig make test-e2e   # runs the runtime legs
```
Without `KUBECONFIG` the Kata legs skip (not fail) — by design.

---

## 4 · In-VM tool runtime — ADR&nbsp;0015

**State (honest):** `RuntimeManager.ExecTool` validates the request and returns `TOOL_STATUS_UNAVAILABLE` — **fail-closed, never a fabricated success** — because there is no in-guest *typed* tool runner yet. The harness serves a raw `Exec` shell channel (the one `lantern vm exec` uses), not a typed tool registry. `tool_call` workflow steps therefore fail with the typed `ErrRuntimeManagerUnavailable` rather than faking output.

**Remaining work (the last mile):** an in-guest tool runner baked into the VM image that the manager forwards `exec_tool` to, mapping a typed tool registry over the existing exec channel. This is a Rust change in `services/harness` + `services/runtime-manager`; building the VM image and validating the in-guest run end-to-end requires the Kata/Firecracker substrate from §3 (it cannot be E2E-validated on a dev laptop), so it stays explicitly `UNAVAILABLE` until that lands.

---

## 5 · API-key scope enforcement — `LANTERN_AUTHZ_ENFORCE`

**State:** the code is flag-gated (`WithScope`, `internal/handlers/auth.go`). `values-prod.yaml` and `values-staging.yaml` now set `controlPlane.env.LANTERN_AUTHZ_ENFORCE: "1"` (base `values.yaml` stays `""`). **Owner-approved for prod; do not apply to a cluster before the soak below passes.** RLS is already `"1"` in prod values and `LANTERN_APP_DB_PASSWORD` is wired from the chart secret (`app-db-password`, `templates/control-plane/deployment.yaml`); the control-plane refuses to boot in prod without both (`rlsGuardDecision`).

### Who is affected (and who is not)

`HasScope` (`auth.go`) lets through: any JWT session (dashboard, owner/admin, bridge credential login, a `LANTERN_API_TOKEN` that is a JWT), and any API key whose `scopes` list is **empty** (legacy/unrestricted). Only two populations can get a 403:

1. API keys with a **non-empty** scope list that lacks the endpoint's scope.
2. The anonymous **kiosk** role (ADR 0029), scoped to `read, agents:read, agents:write, runs:read, runs:execute` — it was designed for enforcement and gets 403 on `connectors/budgets/settings:write`, `admin`, and coarse `write` routes.

Scope lattice: `admin` ⊃ everything; `write` ⊃ all fine writes + reads; `read` ⊃ `agents:read`, `runs:read`; `agents:write` ⊃ `agents:read`; `runs:execute` ⊃ `runs:read`, `runs:write`; `runs:write` ⊃ `runs:read`. Fine scopes do **not** imply each other (e.g. `agents:write` does not allow `POST /v1/runs`).

### Keys that need re-scoping before the flip

Audit of every API-key caller (grep of the repo; routes from `cmd/server/main.go` `WithScope`, pinned by `cmd/server/routes_scope_test.go`):

| Caller | Credential | Endpoints / scope it needs | Action |
| --- | --- | --- | --- |
| Gateway (`services/gateway`, `introspect.rs`) | `X-API-Key` → `/internal/auth/introspect-key` → scopes in claims | Enforces scopes from the key's own list on whatever the client calls | None for the gateway itself; the clients' keys below matter |
| TS / Python / Go SDKs, `lantern` CLI (`LANTERN_API_KEY`) | Bearer API key | Management calls: `agents:write` (agents, schedules, deployments, workflow, mcp attach, eval suites/baselines, experiments, marketplace), `runs:execute` (runs, sessions, completions, connector execute, forecast, a2a), `runs:write` (receipts, feedback, rehearse, eval-runs, takeover), `budgets:write`, `connectors:write`, `settings:write` (surfaces, llm-providers, voice numbers), `admin` (api-keys, data-planes, tenant delete) | **Re-scope** any key minted with a narrow list: list with `GET /v1/api-keys`, confirm each key's `scopes` covers what its owner's scripts call. Prefer coarse `write` for CI deploy keys; `admin` only where api-keys/data-planes are used |
| `examples/eval-gated-deploy/scripts/{eval,release}.sh`, `scripts/bench/runtime-latency.sh` | Bearer key | `eval-runs` = `runs:write`, `eval-baselines` + deploy = `agents:write`; bench = runtime routes | Key needs `runs:write` + `agents:write` (bench: runtime routes have their own `runtime:*` checks, unchanged) |
| WhatsApp / iMessage bridges (`bridge-core/src/auth.ts`) | `LANTERN_API_TOKEN` (JWT) or credential login (JWT) | Writes to `/v1/people/*`, `/v1/memory/events`, `/v1/life-events`, `/v1/commitments`, `/v1/completions`, sessions | **None** — JWT sessions pass. Re-scope only if an operator replaced the token with a scoped API key: then it needs `write` + `runs:execute` |
| surface-gateway | gRPC to control-plane under `LANTERN_GRPC_SERVICE_TOKEN` | not the HTTP `WithScope` path | None |
| runtime-manager relay (`report_forwarder.rs`) | `X-Lantern-Runtime-Token` | `/v1/runtime/secrets/resolve`, own token auth | None |
| Dashboard (`apps/web`) | HttpOnly-cookie JWT | all | None |
| Kiosk visitors | kiosk token | see above | Expected: 403 on write-class routes outside its list |
| Third-party webhooks (Twilio, Slack, WhatsApp heartbeat, signals) | their own shared-secret/signature auth | not `WithScope` | None |

To find keys at risk in the target DB (read-only; run as the `lantern` role, not through the app):

```sql
SELECT tenant_id, name, key_prefix, scopes, last_used_at FROM api_keys
WHERE revoked_at IS NULL AND cardinality(scopes) > 0 ORDER BY last_used_at DESC NULLS LAST;
```

Keys with `cardinality(scopes) = 0` are unaffected. For each row, check `last_used_at` (stale keys: revoke instead of re-scoping), and issue a replacement with `POST /v1/api-keys` `{"name":..., "scopes":[...]}` as an owner/admin JWT, rotate the consumer, then `DELETE /v1/api-keys/{id}`. Scopes cannot be edited in place.

### Staging soak (72 h)

1. Deploy staging with `values-staging.yaml` (already `"1"`). Confirm the boot log: `authz: API-key scope enforcement {"enforced": true}`.
2. Run kiosk/test traffic for 72 h: the demo kiosk, the e2e suites with each SDK's scoped key, a bridge, and the dashboard.
3. Exit criteria: no unexplained 403s (each one maps to a key you knowingly under-scoped), no `ControlPlane403RateElevated` firing without a known cause, `ControlPlane5xxRateHigh` quiet. Attach an alert-silence report (alerts fired/silenced during the window) to the rollout PR.
4. Only then, with the owner's go-ahead, roll prod (`helm upgrade` is an operator action; nothing in this repo applies it).

### What to watch

- **Boot log** `authz: API-key scope enforcement` (`enforced=true|false`) — confirms the flag actually reached the pod.
- **403 ratio** — `ControlPlane403RateElevated` (`infra/monitoring/prometheus/alerts.yml`, existing `http_server_request_duration_seconds_count{http_response_status_code="403"}`; >2% for 10 min). There is **no per-route 403 metric**; to find the route, query traces for `http.response.status_code=403` grouped by span name (the low-cardinality route template, invariant #9) or search for the response body `API key missing required scope: <scope>`, which names the missing scope.
- Baseline first: 403s also come from legitimate cross-tenant 404/403 probes and the kiosk, so compare to the pre-flip rate in staging.

### Rollback

Set `controlPlane.env.LANTERN_AUTHZ_ENFORCE: ""` (or `"0"`) and `helm upgrade`, or `kubectl set env` equivalent by the operator. Missing scopes go back to a debug log and requests proceed. No data migration, no schema change; keys re-scoped during the flip stay valid.
