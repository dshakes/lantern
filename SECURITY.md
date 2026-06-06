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

- **microVM isolation backend** — the Firecracker backend is now implemented
  (REST API client, VmConfig derivation, lifecycle state machine, availability
  detection; 103 unit tests) and **fail-closed**: it only boots when Firecracker
  is genuinely available (Linux + binary + readable `/dev/kvm`), else
  Hostile/Untrusted schedules hard-fail (invariant #5 holds). RESIDUAL — needs a
  Linux+KVM host to validate the live boot, plus: build a KVM kernel +
  harness rootfs (`FC_KERNEL_PATH`/`FC_ROOTFS_PATH`), TAP/bridge networking
  (`CAP_NET_ADMIN`), jailer wrapping for chroot/uid/cgroup isolation, per-VM
  mTLS cert provisioning (CN=vm_id), and the real vsock event loop. The live
  I/O paths are marked `// LINUX-ONLY` in source.
- **Secret vending** — the manager-side `VendSecret` RPC is now implemented:
  it binds each vend to the calling VM's registry-recorded tenant/run/declared
  secret_uris (never caller-asserted), rejects undeclared URIs, caps TTL at
  300s, and never logs values. RESIDUAL (must close before untrusted prod):
  the VM is currently authenticated by `vm_id` over a topology-trusted channel
  — add mTLS with per-VM client certs (CN=vm_id) or vsock peer-credential
  enforcement so a VM can't impersonate another by guessing its `vm_id`; and
  wire a production `SecretResolver` (Vault/cloud SM) — only `EnvSecretResolver`
  ships today (invariant #10).
- **TLS on the data path** — implemented + fail-closed in prod: the gateway
  terminates TLS (rustls) on :8443 (refuses to boot in prod without cert/key);
  harness↔manager is mTLS with a `vm_id`↔client-cert identity check. RESIDUAL
  wiring: the manager must (a) provision a per-VM cert (CN=vm_id) at spawn and
  inject `LANTERN_VM_TLS_CERT/KEY` + `LANTERN_MANAGER_TLS_CA`, and (b) extract
  the peer cert from the tonic request to run the identity check on every
  VendSecret. The gateway→control-plane channel has opt-in client TLS
  (`LANTERN_CONTROL_PLANE_TLS_CA`); the Go control-plane gRPC server must serve
  TLS before it can be required.
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
