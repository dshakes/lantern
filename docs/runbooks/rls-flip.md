# Runbook: Flip LANTERN_RLS_ENFORCE=1

**Audience**: operators deploying the Lantern control-plane.  
**Risk level**: medium — flipping the flag activates RLS enforcement for
all tenant-scoped queries.  No data is deleted; the worst outcome of a
premature flip is a running API that returns empty rows for authenticated
tenants until rolled back.  
**Time to execute**: ~10 min (excluding run-time observation period).

---

## What this changes

When `LANTERN_RLS_ENFORCE=1` AND `LANTERN_APP_DB_PASSWORD` is set, the
control-plane opens a second database connection pool (`AppPool`) as the
`lantern_app` role — a non-superuser with no `BYPASSRLS` grant.

All handler queries that flow through `srv.WithTenant` (the tenant-scoped
accessor) are routed through this pool.  The database then enforces
`tenant_isolation` RLS policies on every tenant-scoped table, providing a
database-layer backstop against missing `WHERE tenant_id = $1` predicates.

Recovery sweeps and migrations continue to use the privileged `lantern`
superuser pool, which bypasses RLS — so system operations are unaffected.

---

## Prerequisites

- [ ] Migrations have been applied (`0003_rls_all_tenant_tables` must be
  present — confirmed by `TestRLSEnforcement_AllTenantTables`).
- [ ] The `lantern_app` role exists (`SELECT rolname FROM pg_roles WHERE rolname='lantern_app'`).
- [ ] You have a strong password ready for the `lantern_app` role.
- [ ] `make dev-infra` (or the target Postgres) is running.
- [ ] All `TestRLS*` tests pass against the target database (step 1 below).

---

## Step 1 — Validate locally (or against the target DB)

Run the pre-flip validation suite:

```bash
make rls-validate
# or, for a clean-slate proof with a throwaway database:
RLS_VALIDATE_FRESH=1 make rls-validate
```

Both modes run:
- `go test -race ./internal/db/ -run TestRLSEnforcement` — catalog gate + cross-tenant proof
- `go test -race -p 1 ./internal/handlers/ -run ^(TestRLS|TestRLSHarness)` — handler cutover paths

**Expected output (tail):**

```
✓  All RLS validation suites passed.
```

If any test fails, **do not proceed**.  Fix root cause or report in the
tracking issue.

To validate against a remote (non-dev) Postgres:

```bash
DATABASE_URL=postgres://lantern:<pw>@<host>:5432/lantern?sslmode=require \
  make rls-validate
```

### What is validated vs. what is not

| Validated by `make rls-validate` | Requires the target cluster |
|---|---|
| RLS policies enabled + forced on all ~40 tenant tables | `LANTERN_APP_DB_PASSWORD` accepted by target Postgres |
| `lantern_app` role exists and is RLS-subject | AppPool actually connects as `lantern_app` in the live process |
| Cross-tenant reads return 0 rows | Live traffic / RLS miss-rate under production load |
| Same-tenant reads still return rows (no regression) | Response time impact under real concurrency |
| Handler cutover paths (`WithTenant` / `WithTenantConn`) correct | |

---

## Step 2 — Set the lantern_app password

On the target Postgres (run as the `lantern` superuser or a role with
`CREATEROLE`):

```sql
ALTER ROLE lantern_app PASSWORD '<strong-random-password>';
```

Keep the password in your secrets store.  It will be set as
`LANTERN_APP_DB_PASSWORD` in the next step.

---

## Step 3 — Set the env vars on the control-plane

Add or update these environment variables for the control-plane process
(Kubernetes Secret, docker-compose env, launchd plist, etc.):

```
LANTERN_RLS_ENFORCE=1
LANTERN_APP_DB_PASSWORD=<strong-random-password>
```

The two vars must be set **together**.  Setting `LANTERN_RLS_ENFORCE=1`
without `LANTERN_APP_DB_PASSWORD` logs a warning and aliases `AppPool` to
the superuser pool — enforcement is not active.

---

## Step 4 — Restart the control-plane

Perform a rolling restart (or a canary restart on one pod first):

```bash
# Kubernetes example:
kubectl rollout restart deployment/control-plane -n lantern

# docker-compose example:
docker compose restart control-plane
```

After restart, confirm enforcement is active by checking the logs:

```
INFO  RLS enforcement active — AppPool connects as lantern_app
```

And from `lantern doctor` (or `GET /healthz`):

```bash
curl -s http://localhost:8080/healthz | jq '{rlsEnforce, appPoolActive, lanternAppRoleExists}'
```

Expected:
```json
{"rlsEnforce": true, "appPoolActive": true, "lanternAppRoleExists": true}
```

---

## Step 5 — Observe for 15 min

Monitor:
- **Error rate**: 5xx on tenant-scoped endpoints (`/v1/agents`, `/v1/runs`,
  `/v1/sessions`, etc.) must not increase.
- **Empty-result rate**: watch for patterns where authenticated calls return
  empty arrays instead of the expected data — this indicates a missing GUC
  set or a handler path not yet on `WithTenant`.
- **Database errors**: search logs for `ERROR: new row violates row-level
  security` — this would indicate a write path that sets the wrong `tenant_id`.
- **AppPool connection errors**: if `lantern_app` cannot log in, the API
  will log connection errors and fall through to the superuser alias (RLS
  inactive but not fatal — check `LANTERN_APP_DB_PASSWORD` matches the
  ALTER ROLE).

---

## Rollback

Rollback is instant: unset `LANTERN_RLS_ENFORCE` (or set it to `0`) and
restart the process.  The `AppPool` aliases back to the superuser pool;
all queries behave as before the flip.  No database changes are required
to roll back.

```
# Remove or set to 0:
LANTERN_RLS_ENFORCE=0
```

Then restart the control-plane (same as step 4).

---

## Troubleshooting

### "AppPool aliased to privileged pool; RLS not enforced at runtime"

`LANTERN_RLS_ENFORCE=1` is set but `LANTERN_APP_DB_PASSWORD` is missing
or wrong.  Run `ALTER ROLE lantern_app PASSWORD '...'` and update the
secret.

### Tests pass but live traffic returns empty rows

A handler path is not yet using `WithTenant` — it queries the `Pool`
(superuser) directly without setting `app.tenant_id`.  The RLS policy
evaluates `current_setting('app.tenant_id', true)` → `''` → no rows.

Grep for `// rls-exempt: <reason>` and `srv.Pool.` sites in
`internal/handlers/` to find remaining non-cutover paths.

### "permission denied for table X"

`lantern_app` lacks the necessary GRANTs on table X.  Check migration
`0001_baseline.sql` — it should `GRANT SELECT, INSERT, UPDATE, DELETE ON
ALL TABLES IN SCHEMA public TO lantern_app`.  If the table was added after
the baseline, add a targeted GRANT in a new migration.

### TestRLSEnforcement_AllTenantTables fails on a new table

A new tenant-scoped table was added without an RLS policy.  Either add the
`tenant_isolation` policy in a migration, or add the table to `rlsExemptTables`
in `internal/db/rls_test.go` with a written justification.
