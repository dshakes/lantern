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

## Consequences / limitations (follow-ups)

- **Exec / ExecTool / file API are unavailable on broker VMs.** The manager dials the
  in-guest exec server over the TAP. With no NIC, exec needs host-initiated vsock
  (`CONNECT <port>` on the base UDS) plus a vsock listener in the harness. Until then,
  exec on a broker VM returns `FAILED_PRECONDITION` ("harness not connected"). Loopback
  heartbeat peers, which only the vsock relay produces, are deliberately not recorded as
  dial-back addresses. This also blocks workflow `tool_call` steps on broker VMs.
- **Restore/fork stay guest mode.** Only cold boots honour broker mode. Snapshots carry
  NIC config.
- **Resolver binding.** The broker resolves on the ADR 0008 shared-token path (no agent
  bearer). The ref comes from the manager's authenticated spawn record, not the guest.
  The control-plane relay must still enforce that the ref belongs to the VM's tenant.
- **Plain-HTTP injection sends the secret in cleartext** over the internet. This is only
  possible when an operator opens port 80 in `LANTERN_EGRESS_ALLOWED_PORTS`.
- **h2 is not negotiated** on terminated connections. ALPN is pinned to http/1.1, which
  costs one reconnect per injected request.
- **The harness's built-in `http_fetch` tool** does not yet trust the broker CA, so it
  fails (closed) against injecting hosts.
- **Go control-plane / SDKs** do not yet carry `EgressRule.inject`. The hand-maintained
  `gen/go` stubs need the field before the control-plane can forward it. Until then the
  field is dropped upstream and nothing is injected, which fails safe.
- Not yet exercised on a real KVM host.
