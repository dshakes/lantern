# ADR 0026 — Host-side egress broker over vsock (broker egress mode)

- **Status:** Accepted (opt-in; default unchanged)
- **Date:** 2026-10-26
- **Supersedes:** nothing. Extends [ADR 0006](0006-egress-allowlist-at-harness.md) (egress at the harness) and [ADR 0008](0008-runtime-secret-relay.md) (secret vending); amends the [ADR 0025](0025-sandbox-spawn-contract-and-manager-authz.md) spawn contract.

## Context

Today a Firecracker guest has a TAP NIC. Egress is filtered **inside** the guest by
the harness's CONNECT allowlist proxy on `127.0.0.1:3128`, made non-bypassable by an
in-guest iptables REDIRECT, and workloads fetch short-TTL secret **values** over
`/run/lantern/secrets.sock`. Two consequences:

1. The enforcement point lives in the same kernel as untrusted code. A guest kernel
   or harness compromise disables the allowlist.
2. Any credential a workload uses to call an API exists, in plaintext, inside the VM.
   A prompt-injected agent can print it, write it to a file, or exfiltrate it to any
   allow-listed host.

Google's Agent Compute Engine model is the bar: *no credentials in the sandbox; egress
leaves via a host-side proxy over vsock; the proxy injects credentials on the way out.*

## Decision

Add `LANTERN_EGRESS_MODE=broker` on the runtime-manager (default `guest` = today).
In broker mode, for Firecracker cold boots:

- **No network device.** The manager omits `PUT /network-interfaces/eth0`, creates no
  TAP, and drops the kernel `ip=` arg. The guest's only path off the VM is vsock. This
  is the strongest isolation available: there is no NIC to bypass a proxy through, so
  the iptables REDIRECT preflight no longer applies. Enforcement is structural and on
  the host.
- **Host egress broker** (`runtime-manager/src/egress_broker.rs`). Per VM, it listens on
  the Firecracker host UDS for guest-initiated vsock port 3128 (`<vsock_uds>_3128`).
  It enforces `egress_rules`: host pattern, `LANTERN_EGRESS_ALLOWED_PORTS` (default
  443), private/metadata IP denial on literals and on resolved addresses (resolve once,
  dial the checked address), `http_methods`, and `rate_bps`. It dials upstream from the
  host. Every decision is audited (`egress`, `egress_inject`) through the existing
  report path, and logged locally first under `lantern_audit`.
- **Credential injection.** `EgressRule.inject` (new proto field 4, `CredentialInjection
  {header, secret_uri, value_prefix}`) names headers to set. The broker resolves
  `secret_uri` through the manager's `SecretResolver` (relay or env, ADR 0008) at request
  time and **replaces** any same-named header the workload sent (e.g. a placeholder).
  Plain HTTP is rewritten in place. HTTPS is TLS-terminated **only for hosts whose rule
  injects**: the broker presents a leaf from a **per-VM ephemeral CA**, re-encrypts to
  the real upstream (verified against the host's native roots), and forces
  `Connection: close` so every injected request is its own upstream connection. Every
  other host is an opaque CONNECT tunnel, so its TLS stays end-to-end with the workload.
- **The CA** is generated at schedule time. It is name-constrained to exactly the
  injecting hosts, path-length 0, and its key never leaves manager memory. Its public
  cert ships in `spawn.json` (`egress_ca_pem`). The harness installs it into
  `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` (system bundle + CA) and
  `NODE_EXTRA_CA_CERTS`.
- **Guest side.** The harness, seeing `egress_mode: "broker"`, does not run the in-guest
  proxy. It runs a byte forwarder (`egress_forwarder.rs`) from `127.0.0.1:3128` to vsock
  CID 2 port 3128, so workloads keep using `HTTP(S)_PROXY` unchanged. The harness's own
  gRPC control channel to the manager (Report, Heartbeat, VendSecret) uses a vsock
  connector (port 50054). The manager relays `<vsock_uds>_50054` byte-for-byte to its
  own gRPC listener, so mTLS stays end-to-end and the server name is still
  `manager.lantern.internal`.
- **Injection specs never enter the guest.** `spawn.json` `egress_rules` have `inject`
  stripped, including the secret refs.

### Spawn contract

`spawn.json` gains `egress_mode`, `egress_ca_pem`, `vsock_egress_port` and
`vsock_manager_port`. All are optional and omitted when empty, so a guest-mode
`spawn.json` is byte-identical to before. `version` stays 1. The harness ignores unknown
fields and has no version gate, so a bump would add no protection. An **older harness on
a broker VM fails closed**: with no NIC it can reach neither the manager nor the
internet. It never falls open.

## New trust boundary

The broker is new host-side code that parses bytes from an untrusted guest. Mitigations:

- request heads are capped at 64 KiB;
- header names from the spec are RFC 7230 tokens;
- secret values or prefixes containing CR/LF are refused, so a secret cannot inject
  headers;
- error strings returned to the guest are static.

The broker also holds plaintext secrets transiently: one header write per request. They
are dropped immediately after and never logged, traced, or audited. Audit attrs carry
header **names** only (tests assert on captured tracing output and on the audit
channel).

## Exec, restore/fork, and the end-to-end path

- **Exec / ExecTool / file API work on broker VMs.** With no NIC the manager reaches the
  in-guest exec server by **host-initiated vsock**: it connects to the VM's Firecracker
  base UDS, sends `CONNECT 50056\n`, waits for `OK <port>\n`, and runs the same
  `RuntimeHarness.Exec` gRPC over that stream (`HarnessTarget::Vsock` in `service.rs`).
  The harness serves the exec gRPC on an `AF_VSOCK` listener in broker mode. The
  per-incarnation exec-token interceptor is unchanged, so a stale incarnation's token is
  refused over vsock exactly as over the TAP. The exec channel is plaintext gRPC plus the
  bearer token on both transports, as before; vsock is host-only, so it is no weaker than
  the TAP link. mTLS on this listener remains the existing follow-up. Loopback heartbeat
  peers (the vsock control relay) are never recorded as dial-back addresses.
- **Restore and fork honour broker mode.** A restored/forked incarnation is built in the
  node's mode: no TAP, no `network_overrides` in the snapshot load, and a fresh per-VM CA
  and broker per incarnation (the previous incarnation's broker is aborted). Snapshot
  metadata records `egress_mode`, and `restore_owned_snapshot` refuses a mode mismatch.
  A guest-mode snapshot loaded without a NIC override would reattach the source VM's TAP;
  a broker snapshot has no eth0 to re-point.
- **`RuntimeStream` no longer binds Firecracker's base vsock UDS.** It used to
  remove-and-bind it, which cut the host-initiated channel. It uses guest port 1024.
- **Tenant-scoped resolution.** `SecretResolver::resolve_scoped` carries the VM's
  registry tenant and vm_id; VendSecret and the broker both use it. Before this, the relay
  sent the node env's `LANTERN_TENANT_ID` / `LANTERN_VM_ID`, which are empty on a
  multi-tenant node, so the control-plane's VM↔tenant binding was never checked against
  the real VM. The control-plane relay resolves a ref only within the verified tenant;
  a cross-tenant ref returns "not found" (`TestResolveSecrets_TenantIsolation_*`,
  `TestResolveSecrets_VMBinding_WrongTenant`).
- **End to end.**
  - `gen/go` is regenerated with the same protoc / protoc-gen-go versions.
  - Control-plane schedule accepts `egress[].inject {header, secretRef, valuePrefix}` and
    returns 400 on anything that is not a `lantern.secret/...` ref, a bad header name, a
    CR/LF prefix, or an IP/CIDR pattern. Error messages never echo the ref.
  - The scheduler passes the spec through unchanged, including on fork respawns.
  - TS, Python and Go SDKs have `EgressRule` / `CredentialInjection` types.
  - The harness `http_fetch` tool trusts the broker CA.
- **Live verification:** `infra/firecracker/broker-e2e.sh` (Linux/KVM).

## Consequences / limitations

- **Plain-HTTP injection sends the secret in cleartext** over the internet. This is only
  possible when an operator opens port 80 in `LANTERN_EGRESS_ALLOWED_PORTS`.
- **h2 is not negotiated** on terminated connections. ALPN is pinned to http/1.1, which
  costs one reconnect per injected request.
- **Egress mode is node-wide** (`LANTERN_EGRESS_MODE`), not per-spec. Restore is refused
  across nodes with different modes.
