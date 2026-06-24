# ADR 0011 — FORCE Row-Level Security across all tenant tables

- Status: Accepted
- Date: 2026-06-23
- Deciders: Platform
- Relates to: invariant #7 (multi-tenant by default), ADR 0010 (versioned migrations)

## Context

Row-Level Security (RLS) was the intended last-line tenant-isolation backstop,
but it was only landed on two tables — `agents` and `runs` (0001 baseline) — and
even there only as a `USING`-only policy. Every other tenant-scoped table
(`sessions`, `connector_installs`, `api_keys`, `llm_provider_configs`, the
runtime/voice/whatsapp/people tables, …) relied **entirely** on each handler
remembering to add `WHERE tenant_id = $1`. A single missing predicate on any of
~33 tables is a silent cross-tenant data leak, and nothing in the database would
stop it.

Two further gaps on the existing policies:

- **No `WITH CHECK`.** A `USING`-only policy gates reads/updates/deletes by the
  row's *current* tenant, but does not constrain the *post-image* of an
  `INSERT`/`UPDATE`. A buggy or hostile write could create a row under a
  `tenant_id` that doesn't match `app.tenant_id`.
- **Not landed where it matters.** The runtime manager already has an RLS-capable
  pool (`AppPool` / `lantern_app`, gated by `LANTERN_RLS_ENFORCE`), but with no
  policies on most tables, switching it on bought nothing for them.

## Decision

**Enable `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy
with BOTH `USING` and `WITH CHECK` = `tenant_id::text =
current_setting('app.tenant_id', true)` on every tenant-scoped table.** Landed
as versioned migration `0003_rls_all_tenant_tables` (per ADR 0010), and
`agents`/`runs` are retrofitted with `WITH CHECK`.

### Staged rollout (safe by construction)

The change is inert until enforcement is deliberately turned on:

1. **Land the policies (this ADR).** The privileged `lantern` superuser pool
   (`Server.Pool`) bypasses RLS — superusers are never subject to it — so all
   existing code paths, which run on `Pool`, are unaffected. `LANTERN_RLS_ENFORCE`
   is off in dev and `AppPool` aliases `Pool` when unset. Nothing breaks.
2. **Cut handlers over to `Server.WithTenant` / `TenantPool()` table by table.**
   Each cutover routes that table's tenant-scoped queries through the
   `app.tenant_id` GUC so they keep working when enforcement flips. `sessions.go`
   is the first proof cutover; `agents.go`/`runs.go` were already on the pattern.
3. **Flip `LANTERN_RLS_ENFORCE=1`** (with `LANTERN_APP_DB_PASSWORD` set so
   `AppPool` connects as `lantern_app`, a non-superuser without `BYPASSRLS`).
   From that point the database itself denies any tenant-mismatched read or
   write — defence-in-depth behind the application's `WHERE` clauses.

`FORCE` is included so even a connection that happens to be the table *owner*
cannot bypass the policy; only an explicit superuser / `BYPASSRLS` role (our
recovery pool) is exempt, which is what recovery sweeps and migrations need.

### Exempt tables (intentionally no RLS)

These have no single owning `tenant_id`, or are deliberately cross-tenant, so an
`app.tenant_id`-keyed policy is wrong for them:

| Table | Why exempt |
|---|---|
| `tenants` | The tenant registry itself; keyed by `id`, not `tenant_id`. |
| `agent_versions` | Child of `agents`; isolation enforced via the parent + FK. |
| `journal_events` | Child of `runs` (PK `run_id, seq`), no `tenant_id` column. |
| `run_locks` | Distributed lock rows (`run_id` PK), no `tenant_id`; system-owned. |
| `marketplace_agents` | Public catalog — intentionally cross-tenant readable. |
| `mcp_servers` | Curated global registry — intentionally cross-tenant. |
| `marketplace_invocations` | Spans buyer + seller tenants by design (commerce). |

The exempt set is allowlisted in code, not implicit.

## Centralized accessor + permanent gate

- `Server.WithTenant(ctx, fn)` is the one tenant-scoped DB primitive: it pulls
  the tenant from the request context (returns `Unauthenticated` if absent),
  begins a tx on `TenantPool()`, sets the `app.tenant_id` GUC transaction-local,
  and runs `fn`. Handlers should reach for this rather than touching `AppPool`
  or re-implementing `set_config`.
- `TestRLSEnforcement_AllTenantTables` is a catalog assertion over
  `pg_class.relrowsecurity` / `relforcerowsecurity` and `pg_policies` for every
  table in the enforced list, with the 7 exempt tables explicitly allowlisted.
  **Adding a new tenant table without RLS fails this test** — the gate that keeps
  this from silently regressing.

## Enforcement-on test harness + staged handler cutover (P1.1b)

Cutting ~275 handler query sites over to `WithTenant` is staged by handler
group. Each batch is proven under a **reusable enforcement-on harness** rather
than the GUC-only simulation in `internal/db/rls_test.go`:

- **Harness:** `internal/handlers/rls_integration_test.go` —
  `newEnforcedServer(t)` builds a real `server.Server` whose `TenantPool()`
  (`AppPool`) connects to Postgres **as the non-superuser `lantern_app` role**
  over its own DSN, so RLS is genuinely enforced at the database for every query
  routed through `s.srv.WithTenant`, exactly as production behaves under
  `LANTERN_RLS_ENFORCE=1`. It runs `Migrate`, stamps a test password on the
  `lantern_app` role (`ALTER ROLE … PASSWORD …`, the documented prod step), and
  reuses the production `buildAppPoolConfig` logic (parse `DATABASE_URL`, swap
  user+password, preserve all other DSN params). Skips cleanly when
  `DATABASE_URL` is unset or the role can't be made loginable.
  `TestRLSHarness_EnforcesOnAppPool` is a self-test that the harness actually
  enforces (cross-tenant read returns zero) so it guards the guard.
- **First real batch — connectors group** (cut over in P1.1b):
  `connectors.go` (install / list / get / test / uninstall / OAuth callback),
  `connector_auth.go` (pure helpers, no DB), and `connector_executor.go`. The
  HTTP `Execute` path and `executeConnectorAction` route the credential read +
  best-effort OAuth-token-refresh write through `WithTenant`;
  `executeConnectorAction` now takes a `connectorExecQuerier` interface so a
  `pgx.Tx` (RLS-enforced) is passed on the connectors path while not-yet-cut-over
  callers (memory_ingest, template_prefetch, jarvis, gmail, messaging, sms,
  tool_catalog) keep passing `srv.Pool` unchanged until their own group lands.
  Proven by `connectors_rls_test.go`:
  `TestRLSConnectors_SameTenant_FullLifecycle` (owner still installs/lists/gets/
  uninstalls — rows returned, not zero) and `TestRLSConnectors_CrossTenant_Blocked`
  (tenant B sees zero / can't act).

**Staged remainder — ALL LANDED (P1.1b cutover complete for handler groups).**
Each group below was cut over to `s.srv.WithTenant` and proven under the
`newEnforcedServer` harness with a same-tenant read/write test (rows returned,
NOT zero — the critical regression check) AND a cross-tenant-blocked test:

| Group | Files | Enforcement-on tests |
|---|---|---|
| identity/people/memory | `identity.go` (+ background `memory_ingest.go` tick injects the configured tenant) | `TestRLSIdentity_SameTenant_ResolveIngestRead`, `TestRLSIdentity_CrossTenant_Blocked` |
| voice/runtime | `voice.go`, `runtime.go`, `runtime_report.go`, `runtime_secrets.go` | `TestRLSVoice_*`, `TestRLSRuntime_*` |
| evals/experiments/budgets | `evals.go`, `experiments.go`, `budgets.go`, `forecaster.go` | `TestRLSEvals_*`, `TestRLSBudgets_*` |
| surfaces/schedules/deployments/api_keys | `surfaces.go`, `schedules.go`, `deployments.go`, `api_keys.go`, `dataplane.go` | `TestRLSSurfaces_*`, `TestRLSApiKeys_*`, `TestRLSDeployments_*` |
| whatsapp/feedback/receipts/takeover | `whatsapp_personal.go`, `feedback.go`, `receipts.go`, `takeover.go`, `rehearse.go`, `marketplace*.go` | `TestRLSTakeover_*`, `TestRLSWhatsAppVIP_*` |

**rls-exempt decisions made during this cutover** (each annotated `// rls-exempt: <reason>` at the call site):

- **Auth / trust-boundary resolution** (no tenant context yet — the query
  *establishes* it): `api_keys.go ValidateAPIKey` (gateway key→tenant),
  `surfaces.go resolveTenantID` (`tenants` registry by id/slug),
  `dataplane.go Register/Heartbeat/ReportMetrics` (bootstrap/session-token auth),
  `runtime_report.go checkReportVMBinding` + `runtime_secrets.go checkVMBinding`/
  `verifyInstanceToken` (resolve a VM's real owner by `vm_id`/`agent_instance_id`
  to verify a body-claimed tenant — must NOT trust the body).
- **Public / cross-tenant by design**: `receipts.go VerifyReceipt` (public proof
  verifier, no auth), all `marketplace*.go` reads/writes against the RLS-exempt
  catalog tables (`marketplace_agents`, `marketplace_stars`, `marketplace_invocations`)
  and the seller-run poll a buyer makes (commerce).
- **RLS-exempt child tables** (no `tenant_id` column; on the allowlist):
  `journal_events` inserts/reads in `evals.go` + `receipts.go hashJournal`.
- **Background sweeps with no request tenant**: `runtime.go reconcileOnce`
  discovery query (spans all tenants), `runtime_report.go sweepTerminatedVMMetrics`
  + `sweepOldLogs` (retention janitors).
- **Shared `*pgxpool.Pool` helpers** reused identically across handlers and
  self-scoping by an explicit `tenantID` arg: `CheckBudget`/`RecordUsage`/
  `AdjustUsageCost` (budgets), `compareToBaseline` (evals), `PickVariant`/
  `promoteAgentVersion` (experiments), `dispatchTool`/`toolsForTenant` (connectors,
  pre-existing). These take a `*Pool` (not `srv.Pool.<method>`) so they don't appear
  in the cutover grep, but are noted here for completeness.

**Remaining non-exempt `srv.Pool.<method>` tenant-scoped sites in the P1.1b handler
groups: 0.** The remaining `srv.Pool` sites in the package live in handlers NOT in
this batch's scope — `a2a.go`, `auth.go`, `gdpr.go`, `jarvis.go`, `llm_proxy.go`,
`mcp_registry.go`, `recovery.go`, `rest.go` (the run executor + workflow
interpreter), `run_events.go`, `runs.go`, `slack_command.go`, `templates.go` — and
are a follow-up batch.

**`LANTERN_RLS_ENFORCE=1` is now safe to flip per-env for the cut-over tables**:
every group above keeps same-tenant reads/writes working under the `lantern_app`
role (proven by the harness tests) and the database denies cross-tenant access.
Before flipping globally, the remaining out-of-scope handlers (above) must be cut
over too, since under enforcement their un-scoped `srv.Pool` queries on
`lantern_app` would return zero tenant rows.

## Consequences

- A future tenant table must either ship an RLS policy in its migration or be
  added to the exempt allowlist with a stated reason; the gate-test enforces the
  choice.
- Handler cutovers can proceed incrementally and safely because the policies are
  inert under the superuser pool until enforcement is enabled.
- Recovery / marketplace / migration paths must continue to use the privileged
  `Pool` (and are annotated `// rls-exempt: <reason>` where they legitimately
  cross tenants); running them on `lantern_app` under enforcement would (correctly)
  return zero cross-tenant rows.

## Verification gate (required before merge)

1. `0003` applies cleanly and is idempotent (re-runnable; `DROP POLICY IF EXISTS`
   + `to_regclass` guards skip missing tables).
2. `TestRLSEnforcement_AllTenantTables` passes — every enforced table has
   `ENABLE` + `FORCE` + a `USING`/`WITH CHECK` policy referencing `app.tenant_id`.
3. `TestRLSEnforcement_Sessions` proves cross-tenant denial + same-tenant
   visibility on the first cutover table under the `lantern_app` role.
4. The session handler tests stay green — same-tenant callers see no behaviour
   change after the `sessions.go` cutover.
5. Per cutover batch: `newEnforcedServer` harness self-test
   (`TestRLSHarness_EnforcesOnAppPool`) + that group's enforcement-on tests prove
   same-tenant reads/writes still return rows AND cross-tenant is blocked, and the
   full `internal/handlers` package stays green. Connectors batch:
   `TestRLSConnectors_SameTenant_FullLifecycle` + `TestRLSConnectors_CrossTenant_Blocked`.
6. P1.1b handler-group cutover (this batch): all `RLS`-prefixed enforcement tests
   pass under `DATABASE_URL=…lantern go test ./internal/handlers/ -run RLS` (26
   tests incl. the harness self-test + connectors batch), the full
   `internal/handlers` suite stays green, and `go test -race` on the RLS tests is
   clean. The cutover grep shows **0** non-exempt tenant-scoped `srv.Pool.<method>`
   sites in the P1.1b group files (every remaining `srv.Pool` site in those files
   carries a `// rls-exempt:` justification).
