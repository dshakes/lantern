# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's [**Private Vulnerability Reporting**](https://github.com/dshakes/lantern/security/advisories/new)
(Security → Advisories → Report a vulnerability). We aim to acknowledge within
72 hours and to ship a fix or mitigation for confirmed High/Critical issues as
quickly as is responsibly possible.

When reporting, please include: affected component (service/package + version
or commit), reproduction steps or a proof-of-concept, and the impact you
observed.

## Supported versions

Lantern is pre-1.0 and ships from `master`. Security fixes land on `master`;
there are no long-term support branches yet.

## Scope & hardening notes

- **Dev credentials are dev-only.** The seeded `admin@lantern.dev` / `lantern`
  login, the `lantern-dev-jwt-secret-do-not-use-in-production` JWT secret, and
  the local Postgres/MinIO credentials in `docs`/compose are for local
  development. **Production deployments must override** `JWT_SECRET`,
  `LANTERN_CREDENTIAL_KEY`, database/object-store credentials, and disable or
  rotate the seeded admin user.
- **Secrets at rest** (`connector_installs`, `llm_provider_configs`,
  `voice_numbers`) are AES-256-GCM encrypted via `internal/secrets` when
  `LANTERN_CREDENTIAL_KEY` is set. If it is unset the code falls back to
  plaintext pass-through for local dev — **always set it in production.**
- **Multi-tenant isolation** is enforced by `tenant_id` on every row, gRPC
  metadata, and Postgres Row-Level Security (`FORCE ROW LEVEL SECURITY`) on
  `agents`/`runs`. **In production, run the app as a non-owner DB role** so RLS
  is not bypassed by the table owner — apply
  [`infra/db/least-privilege.sql`](infra/db/least-privilege.sql) and point
  `DATABASE_URL` at `lantern_app`, running schema migrations separately as the
  owner. Report any path that can read or write across tenants.
- **The macOS personal-assistant bridges** are owner-only: inbound from
  non-owner contacts never reaches the personal-docs or agentic-action
  pipeline, and the sealed `## Private` profile vault is never injected into a
  contact-facing reply. Report any way to cross those boundaries.
- **Never commit secrets or personal data.** `.env*`, real `owner-profile.md`,
  and credential stores are gitignored; use the placeholders/templates provided.

## Known advisories (dev-only / tracked)

- `vitest` UI-server advisory (GHSA-5xrq-8626-4rwp) affects only the dev-time
  `vitest --ui` server; it is a `devDependency`, never shipped to consumers or
  run in CI/production. Tracked for a major-version upgrade.
- Go standard-library advisories surfaced by `govulncheck` are resolved by
  building with a patched Go toolchain release.
