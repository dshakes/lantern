# ADR 0006 — Egress allowlist is enforced inside the guest by the harness

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** Lantern runtime, security
- **Tags:** runtime, network, security

## Context

Untrusted workloads must be prevented from talking to arbitrary destinations on the internet. The author declares `AgentSpec.egress_rules` (a list of `{pattern, http_methods, rate_bps}`) and `AgentSpec.network` (one of `NETWORK_NONE`, `ALLOWLIST_DOMAIN`, `TENANT_VPC`, `OPEN`). The platform must enforce this.

There are two enforcement points:

1. **Host-level** — CNI NetworkPolicy, host firewall, egress proxy. Lives on the host outside the guest. Can do IP/CIDR rules and TLS-SNI inspection.
2. **Guest-level** — nftables / iptables inside the guest's network namespace, applied by the harness before the worker runs. Has the request's full context (process, syscall args) and can do domain-name rules without TLS-SNI inspection (resolves at request time).

Most platforms pick one. Host-only is the easy default (E2B and Modal both rely on host firewalls). Guest-only is what egress proxies inside Docker images use. Neither is sufficient alone for hostile / untrusted workloads.

## Decision

Egress filtering is **enforced inside the guest by the harness**, with the host firewall as defense-in-depth. Specifically:

1. The harness reads `AgentSpec.egress_rules` from the spec passed in via the boot cmdline / vsock spec channel.
2. Before exec'ing the worker, the harness installs nftables rules in the guest's network namespace:
   - Default `DROP` for OUTPUT.
   - Per-rule `ACCEPT` with domain resolution at install time (re-resolved every 5 min).
   - HTTP method enforcement via a thin user-space proxy on `127.0.0.1` that the worker is configured to use via `HTTP_PROXY` env var.
   - Per-rule rate limit via nftables `limit rate`.
3. The host CNI still enforces a per-tenant IP/CIDR policy as a backstop.
4. Every denied connection is logged as an `AuditEvent { action: "egress_denied", attrs: { rule, destination } }` (`runtime.proto:393`) and metered as `lantern_egress_denied_total{vm_id}`.
5. `NETWORK_NONE` short-circuits: harness brings up loopback only, no NIC at all.

The dynamic-policy push pathway: `HeartbeatAck.egress_overrides` (`runtime.proto:360`) lets the manager push updated rules without a restart — used for emergency-block during an active incident.

## Consequences

### Positive

1. **Defense in depth.** A bug in either the host firewall or the in-guest nftables alone does not produce an egress hole.
2. **Domain rules without TLS-SNI inspection.** Host-level domain rules require either DNS pinning (fragile) or TLS-SNI inspection (expensive, breaks ECH/eSNI when it lands). In-guest, the harness resolves at request time and matches on the resolved IP set.
3. **HTTP method enforcement is feasible.** A host firewall can't tell GET from POST without proxying every TLS connection. The in-guest proxy does it natively.
4. **Per-rule rate limiting per VM.** nftables `limit rate` per-rule is trivial; doing it on a shared host firewall means N rules × M VMs explodes.
5. **Audit logs have full context.** The harness sees the requesting process, syscall args, and the resolved destination. Host-only sees five-tuple.

### Negative

1. **The harness is now in the dataplane.** A bug here is a dataplane bug. Mitigation: keep the harness tiny, fuzz the nftables generator, run the egress proxy in a separate seccomp-sandboxed sub-process inside the guest.
2. **DNS resolution lives in the guest.** Means the guest has a recursive resolver (or proxies DNS to the host). We proxy DNS to the host's resolver with the same allowlist applied at the proxy.
3. **More to keep correct across the two enforcement points.** Mitigation: both are generated from the same `AgentSpec.egress_rules`; CI tests both pathways against a shared denylist of escape patterns.
4. **A worker that bypasses the loopback proxy.** Mitigation: nftables default-DROP applies regardless of whether the worker uses `HTTP_PROXY`. The proxy is for method enforcement; the basic destination check is unconditional.

## Alternatives considered

### Host-only (no in-guest filtering)
This is the industry baseline. Rejected because:
- We support a `HOSTILE` class where the threat model is "this code is actively trying to escape." Single layer is not enough.
- Method-level (GET vs POST) and rate-per-rule enforcement is hard to express at the CNI layer.
- Host-only egress proxies that do TLS-SNI inspection break ECH/eSNI; we don't want that future hazard.

### Guest-only
The host would be unaware of which destinations are allowed and couldn't reject obvious cross-tenant pivots. Also: a guest exploit that drops the harness's nftables rules has full network access. Defense in depth is cheap.

### No egress allowlist (open by default)
A non-starter for `UNTRUSTED` and `HOSTILE`. The whole isolation table in [`04-runtime-isolation.md`](../architecture/04-runtime-isolation.md) hinges on bounded egress for those classes.

### Service-mesh sidecar (Istio/Linkerd) for egress
Adds a full mesh dataplane to every guest — way too heavy. Service meshes solve service-to-service; we need egress-to-internet with domain-name rules.

## References

- [`docs/architecture/04-runtime-isolation.md`](../architecture/04-runtime-isolation.md) — Untrusted hardening item #3
- [`packages/proto/lantern/v1/runtime.proto`](../../packages/proto/lantern/v1/runtime.proto) — `EgressRule`, `NetworkPolicy`, `HeartbeatAck.egress_overrides`
- [`docs/architecture/04b-microvm-productionization.md`](../architecture/04b-microvm-productionization.md) — where the harness fits in the security boundary table
