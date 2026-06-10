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

- **Isolation backend.** Two paths:
  - **K8s Job (deployable prod isolation, no bare-metal needed)** — hardened to
    default-deny egress NetworkPolicy + `seccomp: RuntimeDefault` + `cap_drop:
    [ALL]` + non-root + read-only-rootfs + no SA-token. Manifest generation is
    unit-tested; validate end-to-end against any cluster (kind/k3s). This is the
    recommended prod isolation for alpha.
  - **Firecracker (max isolation)** — fully implemented now: availability gate
    (Linux + binary + `/dev/kvm`), per-VM cert provisioning (CN=vm_id), TAP +
    process spawn, Firecracker API + InstanceStart, vsock frame parsing,
    process-table teardown; all KVM-independent logic is unit-tested and it stays
    **fail-closed** off-KVM. RESIDUAL: the live cold-boot + teardown is validated
    by `.github/workflows/microvm-integration.yml` on a **KVM runner** (kernel +
    rootfs built via `infra/firecracker/`). The live cold-boot is now VERIFIED
    on a real KVM host (Apple Silicon Lima nested-virt): the backend reports
    available and a microVM boots end-to-end. The remaining gap is the in-guest
    harness agent that performs the mTLS `VendSecret` round-trip (reads cert
    paths from `/proc/cmdline`, mounts the `certs` drive, builds the mTLS
    client) — the manager half (per-VM cert issuance, packed `certs.img`,
    fail-closed boot) is done. Jailer wrapping (chroot + drop to a non-root
    uid/gid) and jailed snapshot-restore are implemented (opt-in via
    `FIRECRACKER_JAILER_PATH`). Live paths marked `// LINUX-ONLY`.
- **Secret vending + per-VM identity** — `VendSecret` binds each vend to the
  VM's registry-recorded tenant/run/declared `secret_uris` (never
  caller-asserted), rejects undeclared URIs, caps TTL at 300s, never logs values.
  The `vm_id`-impersonation residual is now closed in code: the manager issues a
  per-VM client cert (CN=vm_id) at spawn and the `vend_secret` handler verifies
  the peer cert's CN matches the request `vm_id`. RESIDUAL: the live two-process
  mTLS handshake is validated by the KVM CI (UNVERIFIED until it runs); a
  production `SecretResolver` (Vault/cloud SM) still needs wiring — only
  `EnvSecretResolver` ships today.
- **TLS on the data path** — fail-closed in prod across the board now: gateway
  terminates rustls on :8443; harness↔manager mTLS with the CN==vm_id check; and
  the **control-plane gRPC server now serves TLS** (`LANTERN_CONTROL_PLANE_TLS_*`,
  required in prod) so the gateway→control-plane channel can be encrypted
  end-to-end. RESIDUAL: the live multi-process handshakes are exercised by the
  KVM/integration CI, not on a single macOS dev box.
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
