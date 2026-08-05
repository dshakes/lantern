# Runbook — enabling Row-Level Security enforcement

> **Audience:** operators turning on `LANTERN_RLS_ENFORCE` for an environment.
> **Goal:** make tenant isolation actually enforced by Postgres, without taking
> the environment down on the way.

RLS policies exist on 45 tenant-scoped tables and are **inert until enforcement
is switched on**. Both the control-plane and the workflow engine ship with the
scoping code merged and the flag off. This runbook is the cutover.

**Read the ordering section before doing anything.** The failure mode is not
gradual: with `LANTERN_RLS_ENFORCE=1` and no usable `lantern_app` credential,
both services **refuse to start**. That is deliberate — a service that believes
it is enforcing isolation and is not is worse than one that is plainly down —
but it means the wrong order takes the environment offline rather than degrading
it.

---

## Why two roles

| role | RLS applies? | used for |
| --- | --- | --- |
| `lantern` (owner/superuser) | **NO — bypassed** | migrations, cross-tenant sweeps, the scheduler's poll |
| `lantern_app` (non-superuser) | **yes** | every tenant-scoped query |

A superuser **bypasses RLS entirely**. Pointing the app pool at the superuser
leaves policies inert while every dashboard says enforcement is on — the exact
false-green this runbook exists to prevent. `secrets.appDbPassword` is the
`lantern_app` password and must never be set to the superuser's.

Conversely the cross-tenant paths must **not** use `lantern_app`: under
enforcement a restricted connection with no `app.tenant_id` set matches **no
rows**, so the scheduler would stop finding work and the engine would go quiet
rather than error. Both roles are required; neither is sufficient.

---

## Order of operations

Database first, services second. Every step is idempotent.

### 1. Confirm the role exists and can log in

```sql
SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'lantern_app';
```

Expect `rolcanlogin = t` and **`rolsuper = f`**. The role is created by the
control-plane's baseline migration. If it is missing, run migrations first.

### 2. Set its password

```sql
ALTER ROLE lantern_app PASSWORD '<strong-random>';
```

Store it wherever the environment keeps secrets. It is passed to Helm at deploy
time and never committed:

```bash
helm upgrade --install lantern infra/helm/lantern \
  -f infra/helm/lantern/values.yaml \
  -f infra/helm/lantern/values-staging.yaml \
  --set secrets.appDbPassword="$LANTERN_APP_DB_PASSWORD"
```

### 3. Verify grants — this is the step that bites

Policies restrict *rows*; grants decide whether the role may touch the *table*
at all. A tenant-scoped transaction in the workflow engine writes `runs`,
`journal_events`, `run_locks` and `step_state` **in one transaction**, so a
single missing grant fails ordinary work with a permission error rather than a
row-level denial.

```sql
SELECT t AS table_name,
       has_table_privilege('lantern_app', t, 'SELECT') AS can_select,
       has_table_privilege('lantern_app', t, 'INSERT') AS can_insert
FROM unnest(ARRAY['runs','agents','journal_events','run_locks','step_state']) t;
```

All must be `t`. The control-plane's baseline migration grants the tables it
owns; the workflow-engine migration grants `step_state`, `journal_events` and
`run_locks`, which it creates. If any are false, run **both** services'
migrations before continuing.

### 4. Confirm the policies are present

```sql
SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation';
```

Expect 45 (as of this writing). A lower number means migrations are behind.

### 5. Supply the secrets `LANTERN_ENV=staging` demands

This trips people, and it is not about RLS. `values-staging.yaml` sets
`LANTERN_ENV: "staging"`, which is prod-like — and that **arms the
control-plane's fail-closed startup guards**. It will refuse to boot without:

| secret | Helm value |
| --- | --- |
| `JWT_SECRET` (and not the dev default) | `secrets.jwtSecret` |
| `LANTERN_CREDENTIAL_KEY` | `secrets.credentialKey` |
| `LANTERN_RECEIPT_SECRET` | `secrets.receiptSecret` |
| `LANTERN_GRPC_SERVICE_TOKEN` | `secrets.grpcServiceToken` |
| `LANTERN_APP_DB_PASSWORD` | `secrets.appDbPassword` |

Missing any one of them is a `Fatal` at startup, not a warning — deliberate, but
it means a deploy that supplies only the RLS password fails on something that
looks unrelated. Set them together:

```bash
helm upgrade --install lantern infra/helm/lantern \
  -f infra/helm/lantern/values.yaml \
  -f infra/helm/lantern/values-staging.yaml \
  --set secrets.appDbPassword="$LANTERN_APP_DB_PASSWORD" \
  --set secrets.credentialKey="$LANTERN_CREDENTIAL_KEY" \
  --set secrets.receiptSecret="$LANTERN_RECEIPT_SECRET" \
  --set secrets.grpcServiceToken="$LANTERN_GRPC_SERVICE_TOKEN" \
  --set secrets.jwtSecret="$JWT_SECRET"
```

### 6. Deploy with enforcement on

`values-staging.yaml` sets `LANTERN_RLS_ENFORCE: "1"` for the control-plane and
the workflow engine. Both need the password too; they fail closed without it.

---

## Verifying it actually took effect

Do not trust "the pods are running". They run happily with enforcement off.

```bash
curl -s http://<control-plane>:8080/healthz
```

```json
{"status":"ok","rlsEnforce":true,"appPoolActive":true,"lanternAppRoleExists":true}
```

**`appPoolActive: true` is the one that matters.** `rlsEnforce: true` with
`appPoolActive: false` means the flag is set and the restricted pool was never
built — enforcement is *off* while the flag says on. That combination should be
impossible (the services fail closed), so treat it as a bug worth reporting
rather than a state to work around.

The workflow engine has no equivalent endpoint; check its startup log for
`RLS enforcement on: tenant-scoped queries use the lantern_app pool`.

### Prove isolation end to end

The strongest check is a cross-tenant read that *should* fail:

```sql
SET ROLE lantern_app;
SELECT set_config('app.tenant_id', '<tenant-A-uuid>', false);
SELECT count(*) FROM runs WHERE tenant_id = '<tenant-B-uuid>';  -- expect 0
RESET ROLE;
```

Zero rows while connected as `lantern_app` with tenant A's GUC — but non-zero
for the same query as the owner role — is the proof. A test that only shows
tenant A seeing its own rows does not distinguish enforcement from an ordinary
`WHERE` clause.

**Make sure the check is not vacuous.** Compare totals across the two roles:

```sql
-- as owner
SELECT count(*) FROM runs;                       -- e.g. 17323
-- as lantern_app with tenant A's GUC set
SELECT count(*) FROM runs;                       -- e.g. 17318
```

The second number must be **lower**. If they are equal, either the environment
has only one tenant — in which case the test proves nothing and you should
create a second tenant's row first — or enforcement is not actually on. Verified
on a database with 4 tenants: 17323 visible to the owner, 17318 to `lantern_app`,
and 0 rows from other tenants.

---

## Rollback

Unset `LANTERN_RLS_ENFORCE` (or set it to `0`) and redeploy. The services fall
back to the single privileged pool: the `app.tenant_id` GUC is still set,
policies simply stop applying, and behaviour returns to what it was. **No
schema change, no data migration, nothing to undo** — the policies stay in
place, inert.

Leave the role, password and grants alone; they are harmless when unused and
save repeating steps 1–4 on the next attempt.

---

## What this does NOT cover

- **Enforcement is per-service.** Turning it on for the control-plane and the
  workflow engine does not enable it anywhere else; other services still connect
  as the owner role.
- **The bridges and CLI** talk to the control-plane over HTTP and are unaffected.
- **`LANTERN_RLS_ENFORCE=1` without the password is a startup failure, by
  design.** If an environment must run degraded, leave the flag off — do not
  work around the fail-closed check.
