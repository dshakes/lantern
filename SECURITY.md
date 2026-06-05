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

- Go standard-library advisories surfaced by `govulncheck` are resolved by
  building with a patched Go toolchain release.
- Transitive Rust advisories via `tonic`/`kube` (`rand` unsoundness,
  unmaintained `backoff`/`instant`/`rustls-pemfile`) require upstream/major
  upgrades; tracked, not exploitable in our usage.

## Must-close before running UNTRUSTED code in production (GA blockers)

Several hot-path Rust components are pre-1.0 and currently **fail closed**
(they refuse rather than pretend to be secure). Before executing untrusted /
hostile agent code in production, these need real implementations:

- **microVM isolation backend** — the Firecracker backend is a stub and is
  gated behind `LANTERN_ALLOW_FIRECRACKER_STUB`; Hostile/Untrusted schedules
  hard-fail without a real microVM backend. Implement Firecracker/Kata for
  real isolation (invariant #5).
- **Secret vending** — the harness `vend_secret` is gated behind
  `LANTERN_ALLOW_SECRET_STUB`; implement the manager-side `VendSecret` RPC that
  binds each vend to the calling VM's authenticated tenant/run and rejects any
  `secret_uri` not in that VM's AgentSpec (invariant #10).
- **TLS on the data path** — terminate TLS at the gateway (rustls) or front it
  with a TLS/mTLS ingress; enable TLS on gateway→control-plane and
  harness→manager channels. Do not run these plaintext across a network.
- **Egress firewall** — the in-VM allowlist (port + private-IP/metadata deny)
  is defense-in-depth; pair it with a host-level nftables/DNS-stub egress
  firewall, and a real heartbeat RPC so policy revocations propagate.
- **RBAC** — API-key scopes + `RequireScopeMiddleware` exist; wire scope
  enforcement onto all mutating routes, and run the app DB role as a
  non-owner (`infra/db/least-privilege.sql`).
- **K8s job hardening** — emit a default-deny NetworkPolicy per job and add
  `seccomp: RuntimeDefault` + `cap_drop: [ALL]` to the job SecurityContext.

Set these in production regardless: `LANTERN_ENV=production`, `JWT_SECRET`,
`LANTERN_RECEIPT_SECRET`, `LANTERN_CREDENTIAL_KEY` (the control-plane refuses
to boot without them when `LANTERN_ENV` is prod).
