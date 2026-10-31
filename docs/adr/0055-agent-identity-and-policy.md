# ADR 0055 — Agent identity and per-agent least-privilege policy

- Status: Accepted
- Date: 2026-10-30
- Extends: invariant #7 (trust boundaries), ADR 0008 (runtime secret relay),
  ADR 0011 (RLS), ADR 0025 (sandbox spawn contract), ADR 0026 (broker egress)
- Plan: AGENT-LIFECYCLE-PLAN Phase 1 (risks R1, R2, R4, R5)

## Context

Before this ADR an agent was not a principal. Every tool, connector, A2A and
microVM action an agent took ran on the **tenant's ambient authority**: the run
executor and the session tool loop called `dispatchTool(tenantID, …)`, so a
prompt-injected agent could call any connector the tenant had installed (R2).
A2A invoke and marketplace invoke authenticated the **human's** JWT/API key and
ran the target on the target tenant's keys with no notion of *which agent* was
calling (R1, R4). The A2A card advertised a long-lived "PAL API key" as the
agent auth scheme (R5). The per-VM `agent-instance` token (ADR 0025) identified a
VM, not an agent, and never reached control-plane authorization.

While reading the code for this ADR we also found that, in the default
configuration (no `PAL_AGENT_IDENTITY_SECRET` / `_ED25519_SEED`), the per-VM
`agent-instance` token is HS256-signed with the **user-session JWT secret**, and
`AuthHandler.ValidateToken` did not check the token type — so the token every
microVM workload holds in `PAL_AGENT_INSTANCE_TOKEN` was accepted as an
interactive user session for its tenant. Fixed here (see "Token confusion").

SOTA reference points: SPIFFE/SPIRE (workload identity as a URI SAN, short-lived
SVIDs, automatic rotation, audience-bound JWT-SVIDs), GCP service-account
`generateIdToken` (audience-bound, minutes-long), AWS IAM roles for workloads
(per-workload least-privilege policy evaluated on every call), Cedar/OPA
(default-deny, explicit allow, every decision audited).

## Decision

### 1. Every registered agent is a principal

`agent_identities` (one row per agent, RLS-scoped):

| column | meaning |
|---|---|
| `agent_id` (PK, FK agents ON DELETE CASCADE) | the agent |
| `spiffe_id` | `spiffe://<trust-domain>/tenant/<tenant_id>/agent/<agent_id>`; trust domain = `PAL_TRUST_DOMAIN` (default `pal.local`) |
| `key_generation` | bumps on rotate and revoke |
| `public_key` | Ed25519 public key of the current generation (public data) |
| `status` | `active` \| `revoked` |

**No private key is ever stored.** The per-agent signing key is derived on demand:
`seed = HKDF-SHA256(root, salt="pal-agent-identity-v1", info=tenant_id|agent_id|generation)`,
`key = ed25519.NewKeyFromSeed(seed)`. `root` = `PAL_AGENT_IDENTITY_ROOT_KEY`
(≥32 bytes, base64/hex), else `PAL_AGENT_IDENTITY_ED25519_SEED`, else the JWT
secret (dev; a startup WARN names the fallback). Rotation = `generation+1`
(new key; every token of the old generation stops verifying immediately).
Revocation = `status='revoked'` + `generation+1` (no mint, no verify, no run).
Rotating a revoked identity re-issues it on a fresh generation.

The row is created lazily (first establish / first `GET …/identity`) so agents
created by any path — REST, kiosk, marketplace fork, loop agents — get one.

### 2. Agent tokens: short-lived, audience-bound, EdDSA-only

JWT, header `alg=EdDSA`, `kid=<agent_id>.<generation>`; claims
`iss=pal`, `typ=agent`, `sub=<spiffe_id>`, `aud=<audience>`, `tenant_id`,
`agent_id`, `agent_name`, `agent_version_id`, `run_id`, `gen`, `jti`, `iat`,
`nbf`, `exp`. TTL `PAL_AGENT_TOKEN_TTL` (default 5m, clamped to [30s, 15m]).

Verification (`agentidentity.PrincipalVerifier`): EdDSA only (an HS256 token can
never be an agent token) → `kid` resolves the identity row → generation equals
the row's current generation and status is `active` → signature verifies against
the stored public key → `typ`, `iss`, `exp`/`nbf` (30s leeway), tenant and
agent claims match the row → `aud` **exactly** equals the audience the verifier
expects. Any failure is a typed `ErrAgentToken*` and an audit row
(`token.rejected`). Tokens are returned to the caller once and are never
persisted, logged, traced, or written into audit attrs (invariant #10) — audit
rows carry only the `jti`.

Audiences:

| audience | used by |
|---|---|
| `pal:dispatch` | in-process tool/connector/MCP/sub-agent dispatch of a run or session |
| `pal:connectors` | `POST /v1/connectors/{id}/execute` called *as an agent* |
| `pal:runtime` | binding a microVM schedule to an agent |
| `<target spiffe_id>` | A2A invoke of that target |
| `pal:marketplace/<slug>` | marketplace invoke of that listing |

### 3. Per-agent policy, default-deny

`agent_policies` (one row per agent, RLS-scoped). Document shape (also the REST
body):

```json
{
  "mode": "enforce",                       // or "legacy_permissive"
  "tools": ["web_search", "shell_exec"],   // built-in + runtime tool names; glob '*'
  "connectors": {"github": ["list_*", "get_issue"], "slack": ["post_message"]},
  "mcpServers": ["filesystem"],
  "egressHosts": ["api.github.com", "*.example.org"],
  "a2aTargets": ["research-agent", "spiffe://pal.local/tenant/<t>/agent/<a>", "marketplace:<slug>"],
  "a2aInbound": ["tenant:self", "tenant:<uuid>", "spiffe://…/agent/*", "*"],
  "secrets": ["pal.secret/llm/*", "pal.secret/connector/<install>/*"],
  "budget": {"maxToolCallsPerRun": 50, "maxA2AInboundPerMinute": 30},
  "version": 3                              // optimistic concurrency
}
```

Pure evaluation lives in a shared module, `packages/agentpolicy` (control-plane
and workflow-engine both import it; no I/O). Rules: exact match or glob (`*`
matches within the field; `"*"` alone matches anything); hosts are lowercased,
`*.example.org` matches subdomains only (not the apex), ports are ignored; an
action not matched by an allow rule is **denied**. `legacy_permissive` allows
everything but is still evaluated and audited, so its blast radius is visible.

**Default-deny for new agents, legacy-permissive for existing ones.** Migration
0038 backfills every existing agent with a `legacy_permissive` policy (the live
bridges and every current agent keep working byte-for-byte), and installs an
`AFTER INSERT ON agents` trigger that gives every new agent an empty `enforce`
policy. The dashboard Security tab shows a warning on legacy-permissive agents,
and `POST /v1/agents/{name}/policy/propose` produces a least-privilege
replacement.

Sessions whose `agent_name` has no `agents` row (the WhatsApp/iMessage bridge
personas) are **not agents** — there is no principal to scope — and keep acting
under the calling user's authority, exactly as before. `PAL_AGENT_POLICY_STRICT=1`
denies tool dispatch for such unregistered names.

### 4. Enforcement at every dispatch point

`AgentAuthz.Establish(ctx, tenant, agent, run)` loads (or creates) the identity,
mints a `pal:dispatch` token, verifies it through the same verifier as every
external token, and places an `AgentPrincipal` in the context. Every dispatch
then calls `principal.Authorize(ctx, action)`, which **re-reads** identity
status/generation and the policy (one indexed query): a revoke or a policy edit
takes effect on the very next tool call of an in-flight run, and the token is
re-minted transparently 60s before expiry (SVID-style rotation).

| dispatch point | action checked |
|---|---|
| `dispatchTool` (session tool loop, `/v1/completions` tool loop, run-executor tool loop) | `tool` (built-ins) / `connector` (`<id>__<action>`) |
| workflow interpreter `tool`, `connector`, `subagent` nodes | `tool` / `connector` / `a2a` |
| workflow-engine `tool_call` step | `tool`, evaluated by the engine from the run's agent policy before `ExecTool` |
| `POST /v1/connectors/{id}/execute` with an agent token | `connector` |
| A2A invoke (`/v1/agents/{name}/a2a/invoke`) with an agent token | caller `a2a` target **and** target `a2aInbound` |
| marketplace invoke | buyer `a2a` (`marketplace:<slug>`) when an agent calls, **and** seller `a2aInbound` |
| microVM schedule bound to an agent | each egress rule host (`egress`), network=`open` needs `egressHosts:["*"]`, each secret ref and broker inject ref (`secret`) |
| runtime secret relay (`/v1/runtime/secrets/resolve`) | each ref (`secret`) against the VM's agent policy |
| run admission | identity must be `active`; a revoked agent's run fails `agent_identity_revoked` |

`budget.maxToolCallsPerRun` is counted durably from the audit log (so a
crash-resumed run does not get a fresh allowance). `budget.maxA2AInboundPerMinute`
is counted per (target agent, caller principal) from the audit log, giving each
cross-tenant caller its own rate isolation (R4). Cost ceilings stay where they
already are — `agent_budgets` (HTTP 402) — rather than introducing a second
spend system; the Security tab links to them.

A deny returns a typed `*AgentPolicyDeniedError` (`errors.Is(err,
ErrAgentPolicyDenied)`; REST surfaces `403 {"code":"agent_policy_denied", kind,
target}`), writes a `policy_denied` journal event when a run is in context, an
audit row, and an OTel span event.

### 5. MicroVMs carry the agent identity

A schedule bound to an agent (`agentName`, or the agent owning
`agentVersionId`) is authorized against the policy **before** the scheduler is
called; nothing outside the policy can be spawned. The VM's `agent-instance`
token gains `agent_id` / `agent_spiffe_id` claims, the workload env gains the
non-secret `PAL_AGENT_ID` / `PAL_AGENT_SPIFFE_ID` (added to the harness's
workload-visible allowlist), `runtime_vms.agent_id` is recorded, and the secret
relay authorizes every ref against that agent's policy — so egress (harness or
broker, both fed only policy-approved rules) and secret vending are scoped to the
agent, not the tenant.

### 6. Audit: append-only, tamper-evident

`agent_identity_audit` (RLS-scoped) records `identity.created|rotated|revoked`,
`token.minted|rejected`, `policy.allowed|denied|updated`, `a2a.invoke` with
tenant/agent/agent_version/run/step/jti/principal/action/target/decision/reason.
A `BEFORE INSERT` trigger chains rows per tenant
(`row_hash = sha256(prev_hash || canonical row)`, serialized by a per-tenant
advisory lock); a `BEFORE UPDATE OR DELETE` trigger rejects mutation for every
role, and `pal_app` is granted only `SELECT, INSERT`. `GET …/audit` returns the
rows and recomputes the chain. Spans get `pal.agent_id`, `pal.agent_version`,
`pal.policy.decision` alongside the invariant-#9 attributes.

### 7. Token confusion fix

`ValidateToken` now rejects any token carrying a `typ` claim or the
`pal-agent` issuer, and agent tokens are EdDSA-only. An `agent-instance` or
`agent` token can no longer be replayed as a user session.

### 8. A2A card

The card's `auth` now advertises the agent-token scheme
(`{type:"agent-token", audience:<spiffe_id>, header:"X-Pal-Agent-Token"}`) and
carries `spiffeId` + `jwksUri`; the API-key description is removed (R5).
Spec-shaped `securitySchemes` land with Phase 2.

## API

| Method | Path | Scope | |
|---|---|---|---|
| GET | `/v1/agents/{name}/policy` | `agents:read` | policy + `warnings[]` |
| PUT | `/v1/agents/{name}/policy` | `agents:write` | replace; `version` mismatch → 409; invalid → 400 |
| POST | `/v1/agents/{name}/policy/propose` | `agents:read` | least-privilege proposal, never persisted |
| GET | `/v1/agents/{name}/identity` | `agents:read` | `{agentId, spiffeId, keyGeneration, status, publicKeyJwk, jwksUri, tokenTtlSeconds, createdAt, rotatedAt, revokedAt}` |
| POST | `/v1/agents/{name}/identity/rotate` | `agents:write` | |
| POST | `/v1/agents/{name}/identity/revoke` | `agents:write` | body `{reason}` |
| POST | `/v1/agents/{name}/identity/token` | `admin` (JWT owner/admin) | body `{audience, runId?}` → `{token, expiresAt, jti}` |
| GET | `/v1/agents/{name}/audit` | `agents:read` | `?limit=&event=` → `{events[], chainValid}` |
| GET | `/.well-known/pal-agent-keys/{agentId}` | public | JWKS of the agent's current key |

Agent-as-caller requests send `X-Pal-Agent-Token: <jwt>`.

### Onboarding/ops agent tool spec (for #402's tool loop)

#402 (the server-side onboarding agent) is not on this base, so its wiring is
specified here and lands with it:

```
propose_agent_policy  {agentName}           -> POST /v1/agents/{name}/policy/propose
apply_agent_policy    {agentName, policy}   -> PUT  /v1/agents/{name}/policy   (user-confirm required)
verify_agent_policy   {agentName, expect}   -> GET  /v1/agents/{name}/policy  ; done only when the
                                               read-back equals the confirmed proposal (deep-equal, version advanced)
show_agent_identity   {agentName}           -> GET  /v1/agents/{name}/identity ; done on 200 + status=active
```

## Consequences

- New agents can do nothing until a policy grants it. This is the point; the
  propose endpoint + Security tab make the first policy a one-click action.
- One extra indexed query per tool dispatch, and one audit insert. Tool calls are
  already network-bound; this is noise.
- `PAL_AGENT_IDENTITY_ROOT_KEY` becomes a root secret: compromise lets an
  attacker mint any agent token (same blast radius as `JWT_SECRET` today). It
  rotates by changing the env and bumping every generation (documented runbook).
- Not in this ADR: the MCP client (Phase 3) — `mcpServers` is enforced by the
  evaluator and checked wherever an MCP call is dispatched once that exists;
  spec-compliant A2A JSON-RPC (Phase 2); egress for control-plane-side HTTP
  tools beyond `web_search` (R6).
