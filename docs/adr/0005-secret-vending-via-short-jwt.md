# ADR 0005 — Secrets are vended as short-TTL tokens at boot, never persisted in the VM image

- **Status:** Accepted
- **Date:** 2026-05-20
- **Deciders:** Lantern runtime, security
- **Tags:** runtime, secrets, security

## Context

Agents need credentials: `OPENAI_API_KEY`, database URLs, vendor API tokens. The author declares them in `AgentSpec.secrets` (`runtime.proto:97`) as `SecretRef { env_name, secret_uri }`, where `secret_uri` is a `lantern.secret://tenant/<id>/key/<name>` reference resolved at execution time.

Two questions:
1. **Who resolves the URI to a value?** (control-plane secret store)
2. **How does the value reach the worker without leaking?**

Several wrong answers exist:
- Bake secrets into the agent image. Catastrophic — the image is cacheable, snapshottable, possibly published to a marketplace.
- Pass raw long-lived secrets to the worker as environment variables. Long-lived material in the worker process means a worker compromise is a full credential leak with no rotation horizon.
- K8s Secret mounts. Works for K8s Job, but doesn't help for Firecracker or Kata; we'd need two different secret pathways.

## Decision

Secrets are **vended on demand at boot** via the harness, as short-TTL tokens. Specifically:

1. The `AgentSpec` carries `SecretRef` entries — never values.
2. On boot, the harness calls `RuntimeHarness.VendSecret(secret_uri, ttl)` for each declared secret over vsock to the local manager.
3. The manager validates the request: the requested `secret_uri` MUST be in the workload's `AgentSpec.secrets` list. Otherwise: 401 PermissionDenied. (See `runtime.proto:342` comment.)
4. The manager forwards to the control-plane secret store, which mints a **short-TTL bearer token** (default 5 min, hard cap 15 min). For provider keys that don't support delegation, the manager itself fronts the call — the worker gets a Lantern-issued token that the manager exchanges for the real key on each outbound request.
5. The harness writes the token to a tmpfs file (`/run/lantern/secrets/<env_name>`) and exports it as an env var to the worker.
6. The harness refreshes the token before expiry, in-place. The worker is expected to re-read the env on each use, or use the SDK's secret client that does this automatically.
7. Tokens are **never written to a disk that survives the VM**. `/run/lantern/secrets` is tmpfs.

The signing key for short-TTL tokens is rotated daily; old tokens fail closed at expiry.

## Consequences

### Positive

1. **Compromise blast radius is bounded by the TTL.** A worker exploit that exfils every env var gets credentials that expire in minutes.
2. **No long-lived material ever touches the guest disk.** Image is safe to cache, snapshot, publish.
3. **Audit trail is automatic.** Every `VendSecret` call is an `AuditEvent` (`runtime.proto:393`) tagged with `action=secret_vend, secret_uri, vm_id, run_id`.
4. **Same pathway across backends.** Firecracker, Kata, K8s Job, Wasm all use the harness `VendSecret` flow. No backend-specific secret plumbing.
5. **The manager can refuse requests not in the spec.** Workers cannot vend arbitrary tenant secrets; only the ones the author declared and the control-plane authorized.

### Negative

1. **The harness must be online to refresh tokens.** A harness↔manager partition expires secrets and the worker fails next call. Mitigation: vsock is a host-local channel; partition is effectively impossible without the manager being dead, in which case the VM is going down anyway.
2. **Cold start adds N round trips for N secrets.** Mitigation: vsock RTT is ~100µs; even 10 secrets is ~1ms. Vended in parallel by the harness.
3. **Some legacy vendor SDKs cache the API key at process start and never re-read.** Mitigation: the Lantern SDK provides a `getSecret(name)` helper that always re-reads tmpfs; docs flag this for vendor SDKs that don't behave.
4. **Token rotation requires harness participation.** A misbehaving harness fails closed. Acceptable.

## Alternatives considered

### Env-var injection at boot, long-lived
Simplest. Rejected because a compromised worker leaks the raw credentials with no rotation horizon — every cross-tenant blast radius story starts here.

### K8s `Secret` volume mounts
Works only for `TRUSTED` (K8s Job). Doesn't apply to Firecracker, Kata, or Wasmtime. We'd be building a second secret pathway and operating both. Also: K8s secrets are base64-not-encrypted by default, and the projection mechanism doesn't give us per-secret-URI audit logs.

### HashiCorp Vault agent sidecar
Heavyweight: a full Vault agent in every guest. Effectively the same architecture as our harness-as-vending-proxy, but with Vault's operational surface. We chose to keep the surface small.

### Long-lived tokens with rotation via redeploy
Means an emergency credential rotation requires every agent to redeploy. Pages on a Saturday. Hard pass.

## References

- [`docs/architecture/04b-microvm-productionization.md`](../architecture/04b-microvm-productionization.md) — security boundaries
- [`packages/proto/lantern/v1/runtime.proto`](../../packages/proto/lantern/v1/runtime.proto) — `SecretRef`, `VendSecret`
- [`docs/architecture/04-runtime-isolation.md`](../architecture/04-runtime-isolation.md) — secrets-via-tmpfs hardening item
