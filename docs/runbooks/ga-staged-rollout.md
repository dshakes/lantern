# Runbook — enabling the staged GA features

> **Audience:** operators turning Lantern's deliberately-staged features on in production.
> **Goal:** each feature below is **built and tested**; this is the safe enable + verify + rollback procedure for the parts that ship OFF by default so an operator can flip them on intentionally rather than by accident.

These four were left as explicit opt-ins (not auto-on) because each either needs a one-time DB/role change, real-traffic validation, or operator-provided infrastructure. They are not unfinished code — they are config + ops gates.

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
