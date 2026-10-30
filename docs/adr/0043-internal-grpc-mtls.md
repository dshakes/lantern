# ADR 0043 — Mutual TLS on every internal gRPC hop

**Status:** Accepted
**Date:** 2026-10-29
**Deciders:** Platform team

---

## Context

Invariant #7 made the shared service token (`x-lantern-service-token`) the trust
boundary on the internal gRPC ports and called mTLS "the stronger follow-up".
On 2026-10-29 the actual transport was:

| Hop | Before |
| --- | --- |
| gateway / surface-gateway → control-plane `:50051` | server-only TLS (legacy `CONTROL_PLANE_TLS_*`), callers unauthenticated by cert; surface-gateway plaintext |
| control-plane → runtime-scheduler `:50055` | plaintext |
| control-plane / workflow-engine → model-router `:50053` | plaintext — while carrying tenant provider keys (`provider_credentials`) |
| data-plane agent → workflow-engine `:50052` | plaintext |
| callers → runtime-manager `:50054` | mTLS (manager CA, ADR 0025) |

A token is a bearer secret: anything that reads it off the wire or out of an env
dump is every service at once. The model-router hop shipped tenant API keys over
that plaintext link. And the Rust clients had a latent downgrade: tonic skips TLS
for an `http://` URI even with a TLS config set, so the gateway's opt-in
`CONTROL_PLANE_TLS_CA` was silently plaintext with the chart's `http://` address.

## Decision

**Every internal gRPC server runs mutual TLS, in addition to the service token.**
Neither replaces the other: a stolen token without a cert, or a cert without the
token, is refused.

### One identity per process, one helper per language

- Env (PAL names, LANTERN fallback per ADR 0032): `PAL_GRPC_TLS_CA` / `_CERT` /
  `_KEY` — the service CA and this process's cert (serverAuth + clientAuth),
  used both to serve and to dial. `PAL_GRPC_TLS_ALLOWED_PEERS` — comma-separated
  SPIFFE IDs a server accepts.
- Go: `packages/grpctls` (stdlib + palenv, no gRPC dependency, so no version
  coupling). Rust: `packages/pal-grpc-tls-rs` (`pal_grpc_tls`). Same policy, same
  error text. The three copies of `ManagerTransportCreds` now call `grpctls`.

### Policy

- Configured → TLS 1.2+, CA pinned (no system roots). Servers **require and
  verify** a client cert, then check the peer's identity.
- Identity: a per-VM guest cert (OU `lantern-vm`, minted by the runtime-manager)
  is always refused as a service. With an allowlist, the peer must carry one of
  the listed SPIFFE IDs (`spiffe://<trust-domain>/svc/<name>`) as a URI SAN. Go
  checks it in `VerifyConnection` (handshake); Rust in a tonic interceptor
  (tonic exposes no handshake hook) returning `PERMISSION_DENIED`.
- Unset in dev → plaintext with a WARN, so `make dev`, compose and the kind CI
  job are unchanged.
- **Unset in a prod-like `PAL_ENV` → refuse to start**, for servers and clients,
  unless `PAL_GRPC_INSECURE=1`, which logs a `SECURITY:` WARN at every start.
  The runtime-manager hop has no such escape: the manager already forces mTLS.
- Half-configured or unreadable → always fatal.

### The control-plane port is shared, so its cert demand is per method

`:50051` also hosts `DataPlaneService`, the customer-VPC tunnel, which
authenticates with its own bootstrap token + session JWT and has no service
cert. So the control-plane verifies a cert *whenever presented*
(`VerifyClientCertIfGiven` + CA + allowlist at the handshake) and the
`RequireServiceCert` interceptor — first in the chain — demands one for every
method except `DataPlaneService/*` and health, the same exemptions as the token
check. Every other server demands the cert at the handshake.

The legacy server-only `PAL_CONTROL_PLANE_TLS_CERT/_KEY` still works (WARN in
prod that callers are not cert-authenticated) so an upgrade does not take the
gateway hop down before certs are issued.

### Two CAs, deliberately

The runtime-manager's CA also signs per-VM guest certs (ADR 0025). If services
shared it, every VM cert would chain to a service identity. So the chart mints
two self-signed CAs with cert-manager: the **service CA** (one leaf per service,
SPIFFE URI SAN) and the **manager CA** (manager server cert, a `manager-client`
cert for its callers, and the key the manager signs VM certs with). The OU check
above is defense in depth for any topology that merges them.

### Rotation

Leaves are 90 days, renewed 15 days early. Go services re-stat their cert file
(at most every 30 s) and hot-swap a renewed leaf via `GetCertificate` /
`GetClientCertificate`, keeping the last good pair if a read fails. tonic 0.12
loads its cert once, so the Rust deployments (gateway, surface-gateway,
model-router, runtime-manager) need a rolling restart per renewal:
`mtls.reloader=true` annotates them for stakater/Reloader. CA rotation (10 y) is
a planned rollout; CA bundles are not hot-reloaded.

### Probes

kubelet gRPC probes cannot present a client cert, so with `mtls.enabled` the
workflow-engine, model-router and runtime-manager probe the TCP socket instead.

## Consequences

- **Upgrade step for prod:** install cert-manager, deploy with `values-prod.yaml`
  (`mtls.enabled: true`). An env that sets `PAL_ENV=production` outside the chart
  must mount the certs or set `PAL_GRPC_INSECURE=1`; otherwise the control-plane,
  workflow-engine, runtime-scheduler and model-router refuse to start. That is
  intended — it is the same fail-closed stance as the service token.
- A gRPC caller outside the mesh (e.g. `lantern` CLI pointed straight at
  `:50051`) cannot call AgentService/RunService on an mTLS control-plane; the
  REST API is the external surface.
- The dedicated `pal-control-plane` / `pal-data-plane` charts are not
  wired yet; the data-plane agent's workflow-engine dial already speaks
  `PAL_GRPC_TLS_*`.
- The memory, notifier and billing Go services have gRPC servers but no callers
  and are not deployed by any chart; they are out of scope until they are.
- `make dev-certs` (`scripts/dev-certs.sh`) mints the same two-CA layout locally.

## Alternatives considered

- **Service mesh (Istio/Linkerd) sidecars.** Transparent, but adds a control
  plane, a per-pod proxy on the token-streaming hot path (invariant #4), and
  makes the boundary depend on cluster add-ons the customer-VPC data plane may
  not run. In-process mTLS works the same everywhere.
- **SPIRE-issued SVIDs.** The identities above are SPIFFE-shaped so this stays
  open; cert-manager is the lower-dependency start.
- **Drop the service token once mTLS lands.** Rejected: two independent
  credentials, one of which never leaves the TLS layer, is the point.
