# ADR 0042 — AuthZ + RLS: secure defaults in production

- **Status:** Accepted
- **Relates to:** ADR 0011 (RLS), ADR 0018 (SOC 2 / authZ gaps), ADR 0027 (per-endpoint scope authZ), ADR 0032 (PAL rename)

## Context

Two security controls exist but shipped as **opt-in** with flag defaults of OFF:

1. **Per-endpoint scope authZ** (`PAL_AUTHZ_ENFORCE`): `AuthHandler.WithScope` wraps every route and checks that an API-key's declared scopes permit the action. When enforcement is OFF, a missing scope is logged at debug and the request proceeds — any API key can reach any endpoint.

2. **Row-Level Security** (`PAL_RLS_ENFORCE` + `PAL_APP_DB_PASSWORD`): in production every tenant-scoped query must run through the `lantern_app` role so Postgres's RLS policies enforce `tenant_id` isolation at the query level. When the app pool is not configured, the privileged `lantern` superuser bypasses RLS.

Additionally, read endpoints (GET) had no scope annotation at all — only POST/PUT/PATCH/DELETE routes were annotated. A `read`-scoped API key could read any tenant data regardless of which table.

### Gap analysis (PAL Runtime gap #7)

- **AuthZ enforcement off by default** means every new deployment is misconfigured until an operator sets the flag. An operator who forgets gets no enforcement, no alert.
- **RLS requires manual opt-in** even in production. A deployment that sets `PAL_RLS_ENFORCE=1` but forgets `PAL_APP_DB_PASSWORD` gets the RLS flag set but the app pool aliased to the privileged superuser — RLS bypassed silently.
- **Read endpoints unannotated** means the scope lattice has a gap: write operations are guarded, reads are not. A `write`-scoped key already implies read, but there is no way to grant read-only access without implicitly granting write.

## Decision

### 1. Annotate every authenticated GET route with `WithScope`

Every GET route that returns tenant-scoped data now carries `WithScope(scope, handler)`. New read scope constants:

| Constant | Value |
|---|---|
| `ScopeConnectorsRead` | `connectors:read` |
| `ScopeBudgetsRead` | `budgets:read` |
| `ScopeSettingsRead` | `settings:read` |

Existing `scopeImplies` lattice extended: `connectors:write` implies `connectors:read`, and so on. The coarse `read` scope implies all `*:read` fine-grained scopes.

Unannotated GET routes are intentional exemptions documented in `TestEveryGetRouteHasScope`:

- Auth flow endpoints (OAuth, `/auth/me`)
- Public/unauthenticated endpoints (marketplace listing, MCP catalog, A2A well-known, receipt well-known)
- Shared-token endpoints (`/v1/signals` gated by `PAL_SIGNAL_TOKEN`)
- Runtime endpoints (use in-handler `requireRuntimeScope`)
- Capability-URL download (`/dl/{token}`, auth is the signed path token)

### 2. AuthZ enforcement default ON in production

`authzEnforce()` (in `internal/handlers/env.go`) now returns:

```
OFF  when PAL_AUTHZ_ENFORCE=0/false/off (explicit opt-out)
ON   when PAL_AUTHZ_ENFORCE=1/true/on (explicit opt-in)
ON   when PAL_AUTHZ_ENFORCE is unset AND PAL_ENV=prod/production/staging (secure default)
OFF  when PAL_AUTHZ_ENFORCE is unset AND PAL_ENV is not prod (dev default)
```

A startup `AuthzGuardDecision` emits a WARN when enforcement is explicitly disabled in production, so an alert can key on the `enforced=false` log field.

### 3. RLS enforcement secure defaults in production

`rlsGuardDecision()` (in `cmd/server/main.go`) now:

- **prod + `PAL_APP_DB_PASSWORD` set** → implicit RLS ON; `PAL_RLS_ENFORCE` need not be set.
- **prod + no password + `PAL_RLS_ENFORCE` not "0"** → FATAL at startup. A production server without an app password cannot enforce RLS and must not start silently.
- **prod + no password + `PAL_RLS_ENFORCE=0`** → WARN and continue. The operator has explicitly acknowledged operating without tenant isolation.
- **dev** → advisory WARN if password is missing; never fatal.

`rlsEnforceActive()` drives the actual app-pool creation:

```
false  when PAL_RLS_ENFORCE=0/false/off
true   when PAL_RLS_ENFORCE=1/true/on
true   when PAL_RLS_ENFORCE is unset AND prod AND PAL_APP_DB_PASSWORD is set
```

### 4. GRANT audit: fix missing `lantern_app` grant on `brief_items`

Migration `0020_brief_items` created the table without granting `SELECT/INSERT/UPDATE/DELETE` to `lantern_app`. Migration `0031_grant_brief_items` adds the missing grants. All future migrations must include grants to `lantern_app` for tenant-scoped tables.

### 5. Permanent gate tests

Two permanent tests enforce the invariants:

- `TestEveryMutatingRouteHasScope` (existing) — fails when POST/PUT/PATCH/DELETE is registered without `WithScope` and without an exemption reason.
- `TestEveryGetRouteHasScope` (new) — same check for GET routes.

Both scan `main.go` and `internal/handlers/*.go` and require stale exemptions to be removed.

## Operator migration steps

### Upgrading an existing deployment

1. **Run migrations** — `0031_grant_brief_items` adds the missing `lantern_app` grant. Safe to run against a live database.

2. **AuthZ enforcement** — now defaults ON in production. If you are running with unscoped API keys, either:
   - Set `PAL_AUTHZ_ENFORCE=0` temporarily and set appropriate scopes on existing keys, then remove the override.
   - Or accept that existing keys will be refused until scoped.
   JWT sessions (dashboard) are unaffected — they get full access regardless of enforcement.

3. **RLS enforcement** — if `PAL_APP_DB_PASSWORD` is not yet configured:
   - Set `PAL_RLS_ENFORCE=0` to acknowledge operating without enforcement (loud WARN).
   - Or configure `PAL_APP_DB_PASSWORD` + `ALTER ROLE lantern_app PASSWORD '<strong>'` to activate enforcement (the recommended path).

4. **No production deployment should start without at least one of:**
   - `PAL_APP_DB_PASSWORD` set (RLS enforced), OR
   - `PAL_RLS_ENFORCE=0` explicitly set (acknowledged opt-out with WARN).

### New deployments

New deployments should set `PAL_APP_DB_PASSWORD` from the start. The startup fatal prevents an accidental unguarded deployment.

## Consequences

- **Secure by default in production.** An operator who forgets to set the flag still gets enforcement.
- **Dev stays friction-free.** `make dev` works without any DB role management or env flags.
- **Read-only API keys work correctly.** A key with `read` or `agents:read` scope can read agent data but cannot mutate it.
- **Stale exemption lists are compile-checked.** Removing a route removes it from the gate test; leaving a stale exemption fails the test.
- **Startup guard prevents silent misconfiguration.** A prod server with no app password and no explicit opt-out refuses to start.

## Alternatives considered

- **Leave defaults as opt-in.** Retains backward-compat with zero effort. Rejected: the SOC 2 gap analysis (ADR 0018) calls out both controls as gaps, and every new deployment is misconfigured until the flag is set.
- **Hard-require `PAL_RLS_ENFORCE=1` in prod.** More explicit, but `PAL_APP_DB_PASSWORD` presence is a better proxy for "RLS is ready to enforce" than a flag (the flag without the password does nothing). The implicit-from-password approach prevents the silent no-op.
