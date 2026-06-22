# Identity and Secrets

Every agent instance that Lantern spawns gets a **short-lived, per-instance
identity** and accesses secrets through **short-TTL vending over mTLS** — not
through environment variables baked into the image.

For the full reasoning see [ADR 0005](../adr/0005-secret-vending-via-short-jwt.md)
(why short-TTL vending) and [ADR 0008](../adr/0008-runtime-secret-relay.md) (why
secrets flow through the control-plane relay, not the manager's env).

## Per-instance identity

At spawn time the control-plane mints a short-lived identity token for the workload:

- **Algorithm:** Ed25519 (externally verifiable) over HS256, with the public key
  published at `/.well-known/lantern-agent-identity`. The alg-confusion surface is
  defended — a published Ed25519 public key cannot be used as an HMAC secret.
- **Claims:** `instance_id`, `tenant_id`, `run_id`, `agent_version_id`, `typ=agent-instance`.
- **Injected as:** `LANTERN_AGENT_INSTANCE_ID` and `LANTERN_AGENT_INSTANCE_TOKEN`
  in the workload environment.
- **Persisted on:** `runtime_vms.agent_instance_id`; stamped on every
  `runtime_audit_events` row for the lifetime of the VM.
- **Used for:** the harness presents this token as a Bearer on every `VendSecret`
  call. The manager forwards it to the control-plane secret relay, which cross-checks
  it against the `runtime_vms` row (non-terminal state, matching `tenant_id`) before
  decrypting and returning the secret value.

**Why per-instance, not per-tenant?** A compromised workload that gets its instance
token stolen can only vend secrets that were declared in *its own* `AgentSpec`. It
cannot impersonate another running instance or access another tenant's secrets. The
blast radius of a credential leak is bounded to the single run.

## External verification

The identity token's Ed25519 signature can be verified by anyone with the public key:

```bash
# Fetch the public key
curl https://your-lantern-control-plane/.well-known/lantern-agent-identity
# → {"alg":"EdDSA","crv":"Ed25519","kty":"OKP","x":"<base64url>"}

# Verify the token (e.g. with jwt-cli)
jwt decode --secret @/path/to/public.pem $LANTERN_AGENT_INSTANCE_TOKEN
```

This is the same mechanism used for [verifiable receipts](verifiable-receipts.md)
— the same key pair signs both per-instance identity tokens and run receipts.

## Declaring secrets in agent.yaml

Secrets are declared as **refs**, never values:

```yaml
spec:
  secrets:
    - env_name: OPENAI_API_KEY
      secret_uri: lantern.secret://tenant/my-tenant/key/openai-api-key

    - env_name: DATABASE_URL
      secret_uri: lantern.secret://tenant/my-tenant/key/postgres-url
```

The `lantern.secret://` URI is an opaque ref. The control-plane resolves it to the
actual value (stored AES-256-GCM-encrypted in `llm_provider_configs` or
`connector_installs`) only when the harness asks for it at boot.

**The image never contains secrets.** A cached image, a snapshot, or a marketplace-published
agent bundle contains only refs — no credential material.

## How secret vending works

```text
workload boots
  harness calls VendSecret(secret_uri, ttl) over vsock → mTLS → manager
    manager validates: is secret_uri in the AgentSpec? → 401 if not
    manager calls POST /v1/runtime/secrets/resolve on the control-plane
      (shared token auth, VM-binding check, rate-limited, audited)
      control-plane decrypts the value, returns a short-TTL token
    manager returns the value to the harness
  harness writes value to tmpfs /run/lantern/secrets/<env_name> (mode 0600)
  harness exports as env var to the workload process
  harness refreshes before TTL expiry, in-place
```

The workload reads the env var normally. The Lantern SDK's secret client
re-reads the env on each use, so it picks up rotated values transparently.

**The manager never holds the decryption key** (`LANTERN_CREDENTIAL_KEY`). That key
lives only on the control-plane. A compromised manager node cannot decrypt any
tenant's secrets on its own.

## mTLS between harness and manager

The harness authenticates to the manager over mTLS using a per-VM certificate injected
at spawn. The cert is short-lived and scoped to the VM's `vm_id`. On `VendSecret`,
the manager cert-binds the reported `vm_id` to the mTLS peer — a workload cannot
claim to be a different VM to escalate its secret access.

When the VM is terminated, the cert expires and the instance token becomes invalid
(the `runtime_vms` row moves to a terminal state). Any subsequent `VendSecret` with
the expired token returns `UNAUTHENTICATED`.

## `LANTERN_ALLOW_SECRET_STUB=1`

In development without a real manager, the harness falls back to reading secrets
from its own env when `LANTERN_ALLOW_SECRET_STUB=1` is set. This flag must never
be set in production — the control-plane secret relay is the only production path.

## Secrets in the control-plane

Tenant credentials (LLM provider API keys, connector OAuth tokens) are stored
AES-256-GCM-encrypted at rest in Postgres. Set `LANTERN_CREDENTIAL_KEY` on the
control-plane. When unset, values are stored in plaintext (dev convenience only;
clearly logged at startup as a warning).

## RBAC on secret vending

The `POST /v1/runtime/secrets/resolve` endpoint requires the `LANTERN_RUNTIME_SECRET_TOKEN`
pre-shared token (set on both control-plane and manager). Without it, the endpoint
returns `403` (fail-closed). The endpoint is not exposed to end-user JWT auth.
