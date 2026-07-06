# ADR 0018 — SOC 2 Type II readiness: controls mapping + gap analysis

- **Status:** Proposed
- **Date:** 2026-07-06
- **Deciders:** Shekhar Mudarapu, control-plane
- **Relates to:** ADR 0011 (RLS), invariant #7/#9/#10

## Context

Enterprise buyers will not sign without a SOC 2 report. Type II specifically
attests that controls operated *effectively over a period* (typically 3–12
months), so we cannot bolt this on at the last minute — the evidence has to be
accumulating now. This ADR is the honest inventory: what the codebase already
enforces vs. what is missing, split into **PRODUCT gaps** (code we must build)
and **PROCESS gaps** (policy, cadence, and human review — no code).

Scope is the SOC 2 2017 Trust Services Criteria. We commit to **Security (the
Common Criteria, CC1–CC9)** and add **Availability (A1)** and **Confidentiality
(C1)**. We deliberately exclude Processing Integrity and Privacy from the
initial audit scope — they widen the control set materially and neither is a
common enterprise gate.

What already exists (grounded in the tree):

- **Tenant isolation** — Postgres FORCE Row-Level Security on every
  tenant-scoped table, gated by `LANTERN_RLS_ENFORCE=1`, with a catalog
  gate-test that fails CI if a new tenant table ships without a policy
  (ADR 0011; `internal/handlers/*_rls_test.go`).
- **gRPC trust boundary** — shared-service-token interceptor on `:50051`,
  `:50052`, `:50055`, fail-closed in prod (invariant #7,
  `LANTERN_GRPC_SERVICE_TOKEN`).
- **Encryption at rest for secrets** — AES-256-GCM via `internal/secrets` for
  `llm_provider_configs.api_key_encrypted`, `connector_installs`, voice provider
  config, and bridge PII stores (`bridge-core/src/secure-store.ts`).
- **Egress control** — harness two-layer allowlist, fail-closed in prod
  (`services/harness/src/egress.rs`).
- **Verifiable receipts** — Ed25519-signed run receipts embedding the SHA-256 of
  the run's `journal_events` stream, so tampering invalidates the signature
  (`internal/handlers/receipts.go`).
- **Observability** — OTel spans stamped with `tenant_id`/`user_id`/`run_id`/
  `step_id` via `internal/middleware.EnrichSpan` on both HTTP and gRPC entry
  points (invariant #9).
- **Authn** — bcrypt password hash (12-char minimum), JWT `LanternClaims`,
  Google/GitHub OIDC, hashed API keys with scopes, login rate-limiting
  (`auth.go`, `api_keys.go`).
- **Right-to-erasure** — owner-scoped tenant purge (`gdpr.go`,
  `DELETE /v1/tenants/{id}`).

## Decision

Adopt the controls matrix below as the readiness baseline. Track it as a living
document; each row's evidence must be an artifact an auditor can pull.

### Controls matrix

| # | TSC control | Status | Evidence / gap |
|---|-------------|--------|----------------|
| CC6.1 | Logical access — tenant isolation | **Have** | RLS all tenant tables + catalog gate-test (ADR 0011) |
| CC6.1 | Logical access — service-to-service authn | **Have** | gRPC service-token interceptor, fail-closed prod (invariant #7) |
| CC6.1 | Encryption at rest (secrets/PII) | **Have** | `internal/secrets` AES-GCM; `secure-store.ts` for bridge PII |
| CC6.1 | Encryption in transit | **Partial** | Gateway TLS (`:8443`); inter-service gRPC is token-auth but **plaintext** — mTLS is the named follow-up (invariant #7). GAP: mTLS between services |
| CC6.2 | User registration/authorization | **Have** | `auth.go` register/login; role on `users` (`owner`/`admin`/`member`) |
| CC6.2 | SSO for enterprise identity | **Gap (PRODUCT)** | Only Google/GitHub OIDC today; SAML+SCIM designed in ADR 0019 |
| CC6.3 | Role-based access enforcement | **Partial** | `claims.Role` checks are ad-hoc per-handler (e.g. `cross_app.go:323`); no central RBAC policy or documented role→permission matrix. GAP: formalize |
| CC6.6 | Boundary protection / egress | **Have** | Harness egress allowlist, fail-closed prod (`egress.rs`) |
| CC6.7 | Secrets never in logs/traces | **Have** | Invariant #10; `lantern.secret/...` refs; token redaction in `auth.go` |
| CC6.8 | Malicious-code / untrusted-code isolation | **Have** | User code runs in Firecracker/Kata microVM only (invariant #5) |
| CC7.1 | Vulnerability detection | **Partial** | `make audit` (govulncheck/cargo-audit/npm audit) + `sdlc-lint` CI. GAP: no scheduled/continuous scan, no dependency-update SLA |
| CC7.2 | Anomaly / security monitoring | **Partial** | OTel spans + harness security audit events exist; no alerting rules, no SIEM sink. GAP (PRODUCT+PROCESS) |
| CC7.2 | Tamper-evident audit trail | **Partial** | `journal_events` is append-only-by-convention (PK `run_id,seq`) and receipts hash it, but it is **run-scoped**, not an org-wide security/admin audit log (logins, role changes, key issuance, config changes). GAP (PRODUCT) |
| CC7.3–7.5 | Incident response | **Gap (PROCESS)** | No documented IR plan, on-call, or breach-notification runbook |
| CC8.1 | Change management | **Partial** | Git history + required CI checks (`sdlc-qa`, `sdlc-lint`) + ADRs. GAP (PROCESS): PR-approval policy, change-ticket linkage, evidence retention |
| CC9.1 | Risk assessment | **Gap (PROCESS)** | No documented periodic risk assessment |
| CC9.2 | Vendor management | **Gap (PROCESS)** | Sub-processors (OpenAI, Anthropic, Twilio, LiveKit, ElevenLabs, cloud) not inventoried with DPAs/risk tier |
| A1.1 | Availability — capacity | **Partial** | Runtime quota per tenant (402 on exceed); no documented SLO/capacity plan |
| A1.2 | Backup / recovery | **Gap (PROCESS+PRODUCT)** | Postgres/S3 backup cadence + tested restore not documented; no RPO/RTO |
| A1.2 | Durable execution / crash-resume | **Have** | Journal-based reclaim + resume (invariant #3; `recovery.go`) |
| C1.1 | Confidentiality — data classification | **Gap (PROCESS)** | No written classification of tenant data / PII tiers |
| C1.2 | Confidential data disposal | **Have (product), Partial (process)** | `gdpr.go` tenant purge exists; retention schedule + disposal proof undocumented |
| — | Access reviews | **Gap (PROCESS)** | No periodic review of who has prod/DB/console access |
| — | Pen-test cadence | **Gap (PROCESS)** | No annual third-party pen test on record |

### Product gaps we will build (priority order)

1. **Org-wide tamper-evident audit log.** The single most-requested SOC 2
   artifact. A new `audit_log` table (append-only, tenant-scoped, RLS) capturing
   security-relevant events — login success/failure, role change, API-key
   issue/revoke, LLM-provider-key change, tenant purge, SSO/SCIM provisioning,
   budget/policy change. Reuse the receipts pattern: hash-chain each row
   (`prev_hash`, `row_hash`) so deletion or mutation is detectable, and expose an
   authenticated export endpoint (`GET /v1/audit/export`) for the customer's own
   SIEM. Distinct from `journal_events` (run execution); reuses the Ed25519
   signing key from `receipts.go` for periodic checkpoint signatures.
2. **mTLS between services.** Close the CC6.1 in-transit gap the trust-boundary
   ADR already names as the follow-up. Token-auth stays as the authz layer;
   mTLS adds transport authn + confidentiality.
3. **Central RBAC.** Replace scattered `claims.Role != "owner"` checks with a
   documented role→permission matrix and a single enforcement helper, so the
   access-control story is auditable rather than grep-able.
4. **Retention + backup automation.** Configurable retention on `journal_events`
   / `audit_log` / `run_receipts`; documented, tested Postgres+S3 restore.

### Process gaps (policy, not code)

Written IR plan + breach-notification runbook; quarterly access reviews; annual
third-party pen test; sub-processor inventory with DPAs; documented risk
assessment; change-management policy referencing the existing required CI checks
as the evidence trail; data-classification + retention policy. These are the
security team's to own — no code, but the Type II window cannot start until they
are operating.

## Consequences

- **+** A grounded, defensible posture: ~9 controls already substantially met by
  shipped code, which shortens both the audit and the sales conversation.
- **+** The audit-log build (gap #1) is reusable beyond compliance — it is the
  foundation for the CC7.2 anomaly-monitoring gap and for enterprise
  "who-did-what" views.
- **−** Type II attests over a period: even after the product gaps ship, the
  clock starts only once controls *operate*, so the earliest report is ~3–6
  months after the process gaps are live. Offer the Type I (point-in-time)
  report as the interim gate.
- **−** mTLS and central RBAC touch every service and every handler
  respectively; both need their own ADR before implementation.
- **Risk:** treating the run-scoped `journal_events` as the security audit log
  would fail the audit — it records no logins, role changes, or admin actions.
  The separate `audit_log` (gap #1) is non-negotiable.
