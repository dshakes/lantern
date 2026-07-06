# ADR 0019 — Enterprise SSO (SAML 2.0) + SCIM 2.0 provisioning

- **Status:** Proposed
- **Date:** 2026-07-06
- **Deciders:** Shekhar Mudarapu, control-plane
- **Relates to:** ADR 0018 (SOC 2), existing OIDC (auth.go)

## Context

Enterprise procurement gates on two identity requirements the current stack does
not meet: **SAML SSO** against the customer's IdP (Okta, Azure AD/Entra,
Ping) and **SCIM lifecycle provisioning** so that deactivating a user in the IdP
deactivates them in Lantern. This is table stakes above a certain deal size and
usually appears on the same checklist as SOC 2 (ADR 0018, CC6.2).

What exists today (grounded):

- **OIDC login only.** `auth.go` has a generic `oauthLoginProvider` abstraction
  driving Google + GitHub: PKCE, a Redis-stored state token, token exchange,
  userinfo fetch, and JIT tenant+user creation on first login. The callback
  mints a JWT and hands the dashboard a one-time code. This is the pattern SAML
  must slot beside — **not** replace.
- **Identity schema.** `users(id, tenant_id, email, display_name, auth_provider,
  auth_subject, password_hash, role)` with role ∈ `owner`/`admin`/`member`;
  `tenants(id, slug, name, tier, k8s_namespace)`. First OAuth login creates a
  fresh tenant (org) and an `owner` user.
- **Session issuance.** `generateToken(userID, tenantID, email, name, role)` →
  signed `LanternClaims` JWT is the single choke point every auth path funnels
  through. SAML/SCIM reuse it verbatim.
- **API-key path** for programmatic access with scopes (`api_keys.go`) — SCIM
  service auth reuses this rather than inventing a new credential.

The core design problem is **tenant binding**: OIDC today creates a *new* tenant
per first-seen email. Enterprise SSO is the opposite — every user from
`acme.com`'s IdP must land in Acme's *existing* tenant with the role their IdP
groups dictate. So SSO cannot reuse the "new tenant on first login" JIT path
unchanged; it needs a **connection registered per tenant** that the assertion
resolves against.

## Decision

Add SAML as a third auth provider alongside the OIDC providers, and SCIM as a
token-authed provisioning surface. Both resolve to an existing tenant via a new
`sso_connections` row; both terminate in the existing `generateToken` choke
point. **No new session model, no new user table** — reuse `LanternClaims`,
`users`, `tenants`.

### Schema (new)

- `sso_connections(id, tenant_id, kind ['saml'|'scim'], -- one tenant may have both
   idp_metadata_url, idp_entity_id, idp_sso_url, idp_x509_cert,
   sp_entity_id, default_role, domain, scim_token_hash, enabled, created_at)`
  Tenant-scoped, RLS-enforced, `scim_token_hash` and `idp_x509_cert` handling
  follow the encrypt-at-rest posture in `internal/secrets`. `domain` (verified
  email domain, e.g. `acme.com`) is how an unauthenticated SAML/SP-initiated
  login resolves *which* tenant/connection to use before any user context
  exists.
- `users` gains `external_id` (the IdP's stable user id / SCIM `externalId`) and
  `scim_active BOOL`. `auth_provider` gets the value `'saml'`; `auth_subject`
  stores the SAML NameID.

### SAML 2.0 (SP-initiated + IdP-initiated)

Use a maintained Go SAML library (`crewjam/saml`) as an SP — do **not** hand-roll
XML-DSig verification. New endpoints on the control-plane:

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/auth/saml/{tenantSlug}/metadata` | SP metadata XML the customer uploads to their IdP |
| `GET`  | `/auth/saml/{tenantSlug}/login`    | SP-initiated: build AuthnRequest, redirect to IdP |
| `POST` | `/auth/saml/{tenantSlug}/acs`      | Assertion Consumer Service — validate assertion, resolve user, mint JWT |

Assertion validation requirements (all mandatory, fail-closed):

1. **Signature** — verify XML-DSig against `idp_x509_cert` on record. Reject
   unsigned assertions and signature-wrapping (validate the *signed* element is
   the assertion the SP consumes, not a sibling).
2. **Replay protection** — enforce `NotBefore`/`NotOnOrAfter` and cache the
   assertion `ID` in Redis for the assertion's validity window; a replayed `ID`
   is rejected. Reuse the Redis pattern already used for OAuth state + one-time
   codes in `auth.go`.
3. **Audience + destination** — `Audience` must equal our SP entity ID;
   `Destination` must equal our ACS URL.
4. **Tenant binding** — resolve tenant from the `{tenantSlug}` in the ACS path
   (the connection is unambiguous), **never** from anything inside the
   assertion body. For IdP-initiated flows, `RelayState` is treated as an opaque
   return-path hint only and is validated against an allowlist — it must never
   select the tenant or a redirect target off-origin (open-redirect + tenant-
   confusion pitfall).
5. **JIT provisioning** — on a valid assertion for a known connection, upsert the
   user into `sso_connections.tenant_id` (not a new tenant) keyed by
   `external_id`/NameID, role = mapped IdP group → `owner`/`admin`/`member` or
   `default_role`. Then call the existing `generateToken` and the existing
   one-time-code handoff to the dashboard — identical to the OIDC tail.

### SCIM 2.0

Standard SCIM surface, authed by the per-connection bearer token
(`scim_token_hash`), scoped to that connection's tenant:

| Method | Path | Purpose |
|--------|------|---------|
| `GET/POST` | `/scim/v2/Users` | list / create (provision) |
| `GET/PUT/PATCH/DELETE` | `/scim/v2/Users/{id}` | read / replace / update / **deprovision** |
| `GET/POST` | `/scim/v2/Groups` | group → role mapping |
| `GET` | `/scim/v2/ServiceProviderConfig` | capability discovery |

- **Deprovision = disable, not delete.** `DELETE`/`active:false` sets
  `users.scim_active=false`; `validateToken`/session issuance then rejects the
  user. Hard-deleting would orphan `runs`, `journal_events`, receipts and break
  audit history (ADR 0018).
- **Group→role mapping** lives on the connection so a customer can map
  `Okta group "Lantern-Admins" → admin`.
- Every SCIM mutation and every SAML login writes an `audit_log` row (ADR 0018).

### Session issuance reuse

Both flows end at `generateToken(...) → LanternClaims JWT → one-time code →
dashboard`. `LanternClaims` is unchanged; `auth_provider="saml"` is the only new
value the rest of the system sees. JWT TTL, refresh, and the API-key path are
untouched.

### Phased plan

- **Phase 1 — SAML SP-initiated (highest demand).** Schema + connection CRUD in
  settings + metadata/login/acs endpoints + assertion validation + JIT into
  existing tenant. Ship behind a per-tenant flag; validate against Okta + Entra.
- **Phase 2 — SCIM Users.** Provision/deprovision/update; wire `scim_active`
  into the auth gate. This is what actually satisfies the "deactivation
  propagates" requirement.
- **Phase 3 — SCIM Groups + role mapping, IdP-initiated SAML.** IdP-initiated
  adds the RelayState hardening; defer until a customer needs it.

## Consequences

- **+** Reuses the existing provider abstraction, Redis state/replay pattern,
  `generateToken` choke point, and `users`/`tenants` schema — the new surface
  area is the SAML XML validation + SCIM CRUD, not a parallel auth system.
- **+** Deprovision-as-disable keeps run/audit history intact and satisfies both
  the SCIM lifecycle requirement and SOC 2 access-review evidence.
- **−** SAML XML-DSig is a sharp edge (signature wrapping, canonicalization).
  Using `crewjam/saml` mitigates but does not eliminate it — this path needs a
  focused security review and, ideally, inclusion in the pen-test scope
  (ADR 0018).
- **−** Tenant binding changes an assumption baked into OIDC JIT ("first login =
  new tenant"). The two must not be confused; SAML resolves an *existing* tenant
  by connection. A bug here is a cross-tenant account-takeover, so the tenant is
  taken from the URL/connection and never from assertion or RelayState content.
- **Risk / invariant:** this adds a new authentication trust boundary. Every
  isolation invariant (RLS, tenant scoping) still holds because both flows
  terminate in a `tenant_id`-bound `LanternClaims`; the danger is entirely in
  the resolution step, which is why tenant binding is URL/connection-driven and
  fail-closed.
