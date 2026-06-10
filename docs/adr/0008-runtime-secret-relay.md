# ADR 0008 — Runtime-manager resolves tenant secrets via a control-plane relay endpoint

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Lantern runtime, security
- **Tags:** runtime, secrets, security, trust-boundary

## Context

ADR 0005 established that secrets are vended to workers at boot via the harness,
which calls the runtime-manager over vsock. The manager must therefore resolve
`lantern.secret/...` refs to plaintext values before forwarding them to the harness.

In the current dev-mode implementation
(`services/runtime-manager/src/secret_resolver.rs`) the manager reads values
directly from its own process environment — a shortcut that is explicitly
non-production. Production requires the manager to fetch the *actual* tenant
secrets stored in the control-plane: `llm_provider_configs.api_key_encrypted`
and `connector_installs.config` / `oauth_token_encrypted`, both AES-256-GCM
encrypted at rest via `internal/secrets` (`LANTERN_CREDENTIAL_KEY`).

The manager cannot hold `LANTERN_CREDENTIAL_KEY` — that would require every
manager node to have access to the master key, spreading the blast radius of a
node compromise to every tenant's credentials. The control-plane is the right
and only boundary for decrypting credential material.

This ADR governs the new control-plane endpoint that the runtime-manager calls to
resolve refs on behalf of a specific VM and its owning tenant.

## Decision

Add `POST /v1/runtime/secrets/resolve` to the control-plane. The runtime-manager
authenticates with a pre-shared token (`LANTERN_RUNTIME_SECRET_TOKEN`); the
control-plane decrypts and returns plaintext values for all requested refs that
belong to the specified tenant.

### Ref grammar

A ref is a string of the form `lantern.secret/<scope>/<path>`. Three sub-types are
supported today:

```
lantern.secret/llm/<provider>
    → decrypted api_key_encrypted from llm_provider_configs
      for the request's tenant_id and the named provider
      (e.g. "anthropic", "openai", "gemini").

lantern.secret/connector/<install_id>/<config_key>
    → the value at config_key inside the decrypted config JSONB blob
      from connector_installs for the request's tenant_id and the
      named install UUID. Top-level string values only; nested
      objects are not supported and return "not found".

lantern.secret/connector/<install_id>/oauth
    → the raw decrypted JSON string from oauth_token_encrypted (JSONB)
      for the named connector install. The reserved key name "oauth"
      reads a separate column from the ordinary config blob and returns
      the full token document as a string (e.g. the serialised object
      containing access_token, refresh_token, token_type, etc.).
      Returns "not found" when the column is NULL.
```

Unknown scope prefixes and refs that do not match these patterns return a per-ref
`"error": "not found"` in the response (see below).

### Authentication (service-to-service)

The caller supplies the header `X-Lantern-Runtime-Token: <token>`. The
control-plane reads `LANTERN_RUNTIME_SECRET_TOKEN` from its environment at
request time. Both the expected and supplied tokens are SHA-256-hashed to
fixed-size 32-byte arrays before `crypto/subtle.ConstantTimeCompare`, eliminating
any length-based timing side-channel.

**Fail-closed:** when `LANTERN_RUNTIME_SECRET_TOKEN` is unset the endpoint
immediately returns `403 Forbidden` with `{"error":"relay disabled"}`. Feature is
off by default; a misconfigured production deployment with no token set cannot be
used as a credential oracle.

**Brute-force protection:** authentication failures are tracked per remote IP in
a sliding window (10 failures per minute). Excess attempts receive
`429 Too Many Requests`. The runtime-manager is expected to be the sole caller;
the rate limit exists as a guard against an attacker who has network access to the
control-plane port.

### Transport

**TLS is required in production.** The endpoint returns plaintext credential
values; sending these over an unencrypted connection exposes them on the wire.

- The control-plane TLS listener is the same one used for all other
  `/v1/runtime/...` routes — no new listener is needed.
- The Rust runtime-manager client (`services/runtime-manager/src/secret_resolver.rs`)
  MUST use an `https://` URL. It will refuse to connect over `http://` unless
  the env var `LANTERN_RUNTIME_RELAY_ALLOW_INSECURE=1` is set (development only).
- In local dev (loopback) plain HTTP is acceptable if TLS is not configured. Set
  `LANTERN_RUNTIME_RELAY_ALLOW_INSECURE=1` in the dev `.env` to permit it.
- For multi-host production, the connection SHOULD additionally use mTLS so both
  sides authenticate each other at the transport layer (defense-in-depth alongside
  the token header).

### Request

```json
{
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "vm_id":     "vm-abc123",
  "refs": [
    "lantern.secret/llm/anthropic",
    "lantern.secret/connector/11111111-1111-1111-1111-111111111111/apiKey"
  ]
}
```

`tenant_id` and `vm_id` are both required. `refs` must be non-empty.

### Response

```json
{
  "resolved": [
    {"ref": "lantern.secret/llm/anthropic",          "value": "sk-ant-..."},
    {"ref": "lantern.secret/connector/11.../apiKey", "error": "not found"}
  ]
}
```

For refs that resolve successfully the `"value"` key is present and `"error"` is
absent. For refs that fail (not found, wrong tenant, parse error), `"error"` is
present and `"value"` is absent. The distinction between "does not exist" and
"belongs to another tenant" is intentionally collapsed to `"not found"` — the
endpoint is not a tenant-existence oracle.

### Tenant scoping and VM binding

`tenant_id` in the request body is used as the filter for all DB lookups. The
endpoint returns only rows whose `tenant_id` column matches the value in the
request.

**VM binding check (implemented).** After token authentication and request
validation, the handler queries `runtime_vms` for the supplied `vm_id` and
verifies:

1. A row with that `vm_id` exists.
2. Its `tenant_id` column matches the `tenant_id` in the request.
3. Its `state` is not terminal (`terminated` or `failed`).

On any mismatch the handler returns `404 Not Found` with an identical body
regardless of which condition triggered the denial — no oracle that reveals
whether the vm_id exists, belongs to a different tenant, or has finished. The
denial also increments the per-IP auth-failure counter so binding-probers
(enumerating vm_ids or tenant_ids) are throttled at the same rate as
token brute-forcers.

**Trust ceiling.** With the VM binding check in place, a shared-token holder
can only resolve secrets for tenants that have a *live VM* (state in
`pending` / `spawning` / `running` / `draining`) whose UUID they know. In
practice this means only the tenants whose VMs are actively running on that
manager — which is the inherent and correct trust ceiling for a single
runtime-manager node.

**Ordering invariant.** The `runtime_vms` row is inserted by the
`Schedule` handler with `state='pending'` atomically *after*
`scheduler.Schedule()` returns the `vm_id`. The manager calls
`ResolveSecrets` only after it processes the schedule response from the
control-plane, so the row is always committed by the time a legitimate
request arrives. Accepting `state='pending'` in the binding check is
therefore correct: the VM row exists but the harness may not yet have
transitioned it to `running`.

**Remaining compensating controls:**
1. `LANTERN_RUNTIME_SECRET_TOKEN` must be a ≥ 256-bit random token stored in
   the same secrets manager as `LANTERN_CREDENTIAL_KEY`; rotation requires a
   rolling restart.
2. The endpoint should be network-policy-restricted so only runtime-manager
   pods can reach it (not arbitrary workloads or the public internet).
3. mTLS between the runtime-manager and control-plane (see Transport above)
   adds a second authentication factor that IS node-scoped.
4. **Optional future hardening:** per-VM short-lived MAC tokens minted at
   schedule time (see Alternatives Considered) would make the token scope
   match the VM scope exactly. With the VM binding check now in place, this
   is low-urgency; it would add defence-in-depth against a token leak but
   not change the operational trust boundary.

### Audit

Every request (successful or not, after auth) inserts one row into
`runtime_audit_events` with:

- `action = "secret_resolve"`
- `vm_id` from the request
- `attrs` containing `ref_names` (the list of requested ref strings) and
  `resolved_count` (how many were found)

Secret **values** are never written to the audit log, the Zap logger, or any trace.
Only ref names (e.g. `"lantern.secret/llm/anthropic"`) are recorded.

### No server-side caching

The endpoint resolves on every call. The runtime-manager (harness) is responsible
for caching within the TTL window established by ADR 0005 (5-minute default). The
control-plane does not add a cache because a cached plaintext value at the HTTP
layer would widen the blast radius if the cache were exposed.

## Consequences

### Positive

1. **The credential key stays in one process.** Only the control-plane holds
   `LANTERN_CREDENTIAL_KEY`. Manager nodes have no access to encrypted material or
   the key — a node compromise does not expose other tenants' raw credentials.
2. **VM binding closes the shared-token tenant-escalation gap.** The endpoint
   now verifies that the requested `vm_id` exists, belongs to the claimed
   `tenant_id`, and is in a non-terminal state before resolving any secrets.
   A token holder can only resolve secrets for tenants with a live VM whose
   UUID they know — i.e., the tenants actually running on that manager node.
   This is the inherent trust ceiling; the per-VM MAC token path (see
   Alternatives Considered) remains available as optional future hardening
   with reduced urgency now that the vm-binding check is in place.
3. **Fail-closed by default.** Unset `LANTERN_RUNTIME_SECRET_TOKEN` → 403 on every
   call; no credentials are accidentally exposed on a fresh deployment.
4. **Audit trail is complete.** Every resolution attempt is logged with the ref
   names so security reviews can trace credential access without the endpoint ever
   logging a value.
5. **Feature flag is a single env var.** Turning off the relay (e.g. to revert to
   dev-mode env-var resolution) is one unset.

### Negative

1. **New inter-service trust boundary.** The manager→control-plane token must be
   rotated on compromise; rotation requires a rolling restart of both services.
   Mitigation: `LANTERN_RUNTIME_SECRET_TOKEN` can be set in the same secrets
   manager that holds `LANTERN_CREDENTIAL_KEY`, so rotation is a single operation.
2. **Added latency on secret vend.** Each harness boot adds one HTTP round-trip to
   the control-plane per distinct ref (or one request for all refs batched). At
   intra-cluster latency (~1ms) this is acceptable; the harness already pays N
   vsock round-trips per secret.
3. **Control-plane is now a dependency for VM boot.** If the control-plane is down,
   new VMs cannot vend secrets and will fail to start. This is already true for
   quota checks and VM registration; the marginal dependency increase is accepted.

## Alternatives considered

### Direct DB access from the runtime-manager

The manager could hold its own Postgres connection and read
`llm_provider_configs` / `connector_installs` directly. Rejected: it would also
need `LANTERN_CREDENTIAL_KEY` to decrypt rows, which spreads the key across every
node. Architectural invariant 1 also prohibits components outside the control-plane
from touching the credential store directly.

### HashiCorp Vault or AWS Secrets Manager as intermediary

Would remove the control-plane from the hot path. Deferred: introduces a new
infrastructure dependency (Vault cluster or IAM plumbing) that we are not ready
to operate. The relay endpoint is a clean interface that can be replaced by a
Vault-backed implementation without changing the manager-side client contract.

### Including the vm_id in the token (MAC-signed per-VM token)

Would cryptographically bind each request to a specific VM, preventing the manager
from issuing requests on behalf of VMs it does not own. Deferred: adds key
management complexity (per-VM tokens must be minted at schedule time and rotated).
The combination of the pre-shared token and the runtime-side vm-binding check
(see Tenant Scoping and VM Binding above) achieves the same operational trust
ceiling without per-VM key management. The per-VM MAC token design is retained
as an optional future hardening step with reduced urgency.

## References

- [`docs/adr/0005-secret-vending-via-short-jwt.md`](0005-secret-vending-via-short-jwt.md) — harness-side vend contract
- [`services/control-plane/internal/secrets/secrets.go`](../../services/control-plane/internal/secrets/secrets.go) — AES-256-GCM envelope
- [`services/control-plane/internal/handlers/runtime_secrets.go`](../../services/control-plane/internal/handlers/runtime_secrets.go) — implementation
- [`packages/proto/lantern/v1/runtime.proto`](../../packages/proto/lantern/v1/runtime.proto) — `SecretRef`, `VendSecret`
