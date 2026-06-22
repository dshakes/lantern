# ADR 0010 — Versioned DB migrations via golang-migrate (baseline-on-existing)

- Status: Accepted
- Date: 2026-06-22
- Deciders: Platform
- Supersedes: the spike-era idempotent `CREATE TABLE IF NOT EXISTS` runner in `internal/db/migrate.go`

## Context

Schema changes are applied by `db.Migrate(ctx, pool, seedDev)`, which executes a
Go slice of idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … IF NOT
EXISTS` statements on every control-plane startup. This was always labelled
spike-only (the function's own doc comment says "in production, use a proper
migration tool"). It has real GA-blocking gaps:

- **No version ledger.** There is no record of which schema version a database
  is at. You cannot tell a half-applied database from a current one.
- **No reversibility.** There are no down migrations; a bad change cannot be
  rolled back, only forward-patched.
- **No ordering guarantees across replicas.** Two control-plane replicas
  starting simultaneously both run the full set; idempotency hides races but
  does not make them correct.
- **Destructive changes are impossible to express.** `IF NOT EXISTS` can only
  add. Column drops, type changes, backfills, and data migrations have no home.

## Decision

Adopt **golang-migrate** as the migration runner, with the **current schema
captured as an idempotent baseline migration `0001`** so existing deployed
databases adopt the tool without a dump/restore.

- Migrations live as embedded SQL files under
  `internal/db/migrations/NNNN_name.{up,down}.sql`, shipped via `embed.FS` (no
  files to mount in the container).
- `0001_baseline.up.sql` is the entire current schema, generated from — and
  byte-verified against — the retired Go statement slice. Because every
  statement is `IF NOT EXISTS`, running it against an **already-migrated**
  database is a no-op that simply records version 1 in `schema_migrations`
  (adopt-on-existing). Running it against a **fresh** database creates the full
  schema.
- `Migrate()` keeps its signature (`ctx, pool, seedDev`). It derives a
  `database/sql` handle from the pool's connection string via the pgx stdlib
  driver, runs `migrate.Up()`, and treats `ErrNoChange` as success. The
  dev-seed (well-known tenant + admin) stays a separate, env-gated step — it is
  data, not schema, and must never be a versioned migration that could run in
  production.
- New schema changes are added as the next numbered pair (`0002_*.up.sql` +
  `0002_*.down.sql`). Down migrations are mandatory for every change after the
  baseline. The baseline's own down is a documented full-schema drop (used only
  to reset a dev database).

## Why golang-migrate over Atlas

golang-migrate is a thin, dependency-light runner that matches our existing
"plain SQL, embedded in the binary" posture and adds nothing to the runtime
beyond a `schema_migrations` table. Atlas is declarative-schema-first (HCL or
inspect-and-diff) — powerful, but it would introduce a separate schema
authoring model and toolchain for marginal benefit at our size. The named
fallback in `CLAUDE.md` was "golang-migrate or Atlas"; we take the lighter one.

## Consequences

- **All services that touch Postgres** now assume a `schema_migrations` ledger.
  Only the control-plane runs migrations (it owns the schema); other services
  read/write tables but never migrate. Unchanged.
- A clean clone + fresh DB is created by `0001` exactly as before; CI and
  `make test-db` behaviour is preserved.
- Already-running production/self-host databases adopt the ledger transparently
  on the next control-plane deploy — no manual step, no downtime.
- The 1300-line Go statement slice is retired; SQL is now the source of truth,
  which is reviewable as SQL and runnable with `migrate` CLI out-of-band for
  ops.

## Verification gate (required before merge)

1. **Fresh DB**: `0001` produces a schema identical (table + column + index +
   constraint set) to the retired Go runner. Proven by applying both to two
   fresh databases and diffing `information_schema`.
2. **Adopt-on-existing**: against a database already created by the old runner,
   `Migrate()` records version 1 and makes no schema change (no error, no DDL).
3. The full control-plane Go test suite (which calls `db.Migrate`) stays green
   on a fresh DB.
