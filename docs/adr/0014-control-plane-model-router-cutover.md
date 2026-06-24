# ADR 0014 — Control-plane routes LLM calls through model-router with per-request tenant credentials

- **Status:** Accepted
- **Date:** 2026-06-23
- **Deciders:** Lantern control-plane, model-router, security
- **Tags:** llm, model-router, trust-boundary, secrets, staged-rollout

## Context

Invariant #6 says models are addressed by capability, and the model-router (The
Spectrum) is the component that maps a capability to a concrete vendor model with
routing strategies, prompt caching, and failover. Today the control-plane's live
LLM path (`services/control-plane/internal/handlers/llm_proxy.go`) bypasses the
router and calls OpenAI / Anthropic over HTTP directly. This is the path the
WhatsApp and iMessage bridges depend on for every reply, so it is the single most
latency- and reliability-sensitive code path in the product.

Two facts make a naive cutover unsafe:

1. **The model-router has no per-tenant key path.** It builds its providers from
   PROCESS-ENV keys at startup (`services/model-router/src/{main.rs,config.rs}`)
   and `CompleteRequest` carried no credentials field. So the single-process
   router could not serve a specific tenant's traffic — it only had whatever key
   was in its own environment.
2. **The control-plane resolves a per-tenant AES-256-GCM-encrypted key per call**
   (`resolveProviderKey`). That key is the only thing that authorizes a call on
   behalf of that tenant.

The router cannot carry a tenant's traffic until it receives that tenant's key in
the request. And because this is the bridges' live path, the cutover must be
reversible instantly and must degrade to the existing direct path on any router
problem.

## Decision

### 1. Request-scoped credential map (new trust boundary)

Add `map<string,string> provider_credentials = 42;` to `CompleteRequest` (and
`= 4` to `EmbedRequest`) in `packages/proto/lantern/v1/models.proto`. Keys are
provider ids (`"openai"`, `"anthropic"`) → API key. The control-plane resolves
the tenant's key per call and ships it in this map; the router builds a
PER-REQUEST provider from it (`ModelRouter::providers_for_request`), falling back
to its startup env provider when the map is empty (single-tenant dev).

This introduces a new trust boundary: **decrypted tenant API keys now cross the
control-plane → model-router gRPC hop.** Consequences:

- **Invariant #10 (secrets never in logs/traces/state).** The credential map is
  never logged or traced on either side. The Go side logs only gRPC status on
  error (never the request); the Rust side logs only provider *ids* at debug, the
  field is `#[serde(skip)]` so it cannot enter the prompt cache key or any serde
  render, and the router does not persist the request.
- **Transport.** In-cluster the hop is plaintext gRPC today (matching the
  scheduler/runtime dial convention; TLS terminates at the edge). For any
  cross-cluster / cross-trust-zone deployment this hop MUST run over mTLS or a
  service mesh, because it now carries credential material. Flagged for the
  data-plane deployment work.
- The router still holds no master key and no per-tenant key store. It receives
  exactly one tenant's key for exactly one call and forgets it — the blast radius
  of a router-node compromise is bounded to in-flight requests, not the key
  vault (same principle as ADR 0008's relay).

### 2. Default-OFF flag with automatic fallback

The cutover is gated by `LANTERN_USE_MODEL_ROUTER` (default OFF). It is wired at
the `callLLMWithFailover` seam, which already centralizes plain provider
completions. When ON:

- Only PLAIN completions are offloaded (`len(tools) == 0` and the head candidate
  is a real hosted provider). **claude-code and the tool-use loop stay on the
  direct path** for this batch.
- On ANY router failure — dial error, timeout (30s cap), non-OK gRPC status, or
  empty body — the code FALLS THROUGH to the existing direct provider chain. The
  router error is never surfaced to the caller; the bridges keep working.
- `RecordUsage` / `CheckBudget` are unaffected: `callLLMWithFailover` returns the
  same tuple regardless of which path produced the answer, and usage accounting
  runs on that tuple in the caller.

Callers (`rest.go`, `sessions.go`, `Complete`, `CompleteInternal`) are untouched:
the function signature and return shape are identical.

### 3. Staged rollout

The fallback guarantee makes the flag safe to flip per-deployment, but the
intended rollout is still staged:

1. Enable `LANTERN_USE_MODEL_ROUTER=1` on a NON-bridge tenant first.
2. Watch traces (`gen_ai.*` spans + the router's own spans) and error rate.
3. Only then enable it for the bridge tenant.

## Alternatives considered

- **Give the router a per-tenant key store.** Rejected: spreads decryption
  authority and key material to every router node (the exact failure mode ADR
  0008 avoids for the runtime-manager).
- **Hard cutover, no flag.** Rejected: this is the bridges' live path; an
  un-reversible change with no fallback is an incident waiting to happen.
- **Offload the tool loop too.** Deferred: the tool loop and claude-code have
  control-plane-side state (connector dispatch, persona rules); offloading them is
  a larger change. This batch offloads only plain completions.

## Consequences

- The control-plane gains a lazily-dialed `ModelServiceClient`
  (`LANTERN_MODEL_ROUTER_ADDR`, default `model-router:50053`).
- The router becomes multi-tenant-capable without a key store of its own.
- A new credential-bearing gRPC hop exists and is documented as requiring mTLS
  for cross-trust-zone deployments.
- Verified by Go tests (`llm_proxy_router_test.go`): flag-OFF never dials the
  router; flag-ON+OK maps the response and populates `provider_credentials`;
  flag-ON+ERROR falls back to the direct path with no error surfaced.
