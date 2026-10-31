# ADR 0030 — Egress data-loss prevention (DLP) on the broker

**Status:** Accepted  
**Date:** 2026-10-28  
**Author:** PAL Runtime runtime team

---

## Context

The egress broker (ADR 0026) enforces an allowlist of hostnames and can inject
credentials for TLS-terminated injecting rules. A VM is untrusted (ADR 0025 /
invariant #5), so a compromised workload may try to exfiltrate sensitive
material — API keys, payment card numbers, PII — through an otherwise
legitimately allowlisted upstream host.

The broker is the only place on the data path that can inspect raw request
content: the harness in the guest is bypassable, and the upstream server is
outside trust. We need DLP at this layer.

---

## Decision

### What is inspectable

| Path | Inspection |
|------|-----------|
| TLS-terminated injecting hosts (`terminate()`) | Request headers + up to `max_inspect_bytes` of body |
| Plain-HTTP allowlisted hosts (`handle_plain()`) | Request headers + up to `max_inspect_bytes` of body |
| Opaque CONNECT tunnels (`handle_connect()`, non-injecting) | NOT inspected — host/port + byte-rate policy only |

Opaque tunnels are excluded because the broker cannot read the inner TLS
stream without MitM-ing the workload's upstream TLS (a trust violation for
non-injecting hosts). Host, port, and byte rate are the only policy knobs
available there.

**DLP needs the broker.** Only broker egress mode (ADR 0026) has an enforcing
inspection point. On a node without one (guest egress mode, or a non-Firecracker
backend) the manager **refuses** a spawn/restore whose policy has a `block`
rule (`FAILED_PRECONDITION`), and records audit-only rules as not enforced (a
`pal_audit` log line, `decision=not_enforced`). A VM with DLP never comes
from the warm pool (that broker was built for another request). Restores
(pause/resume, idle auto-resume, fork) carry the restoring request's policy into
the new incarnation's broker.

### What block mode does and does not stop

Block mode stops a naive or cooperative client from sending a detector match
through an inspectable path. It does **not** stop a determined, compromised
workload, which can:

- use an **opaque CONNECT tunnel** to any allowlisted non-injecting host (never
  inspected);
- put the data **past `max_inspect_bytes`** of a body (64 KiB default, 1 MiB
  ceiling) — only the prefix is scanned, the rest is spliced;
- send it in a **keep-alive follow-on request** on the same connection — only
  the first request head + body prefix on a connection is inspected (the
  upstream leg is `Connection: close`, so this needs an upstream that ignores it);
- encode it (base64, hex, compression, encryption) so no detector matches.

Treat DLP as a guard rail and an audit trail, not a containment boundary; the
allowlist and credential injection (ADR 0026) remain the boundary.

### Detectors

| Detector | Description |
|----------|-------------|
| `card_number` | Digit groups joined by single spaces/dashes; every window of whole groups holding 13–19 digits is checked (so `4532… 12/30` still matches) against Luhn **and** an issuer prefix: 13 digits must start `4`, 14 `30`/`36`/`38`, 15–19 with `2`–`6` (drops epoch-ms/µs timestamps) |
| `secret_key` | AWS access keys (`AKIA`/`ASIA` prefix), GitHub PATs (`ghp_`/`gho_`/`ghs_`/`github_pat_`), Slack tokens (`xoxb-`/`xoxp-`/`xoxa-`/`xoxe-`), PEM private keys (`-----BEGIN * PRIVATE KEY-----`) |
| `email` | RFC 5321 email addresses — triggered at a configurable count threshold |
| `phone` | E.164 and North American formats — triggered at a configurable count threshold |
| `custom_regex` | Tenant-supplied pattern (RE2 syntax), matched over raw bytes (non-UTF-8 bodies are still scanned). Validated with Go `regexp` at write time (400) and compiled by the manager at spawn |

Detector names are one set across the API, the DB `CHECK` and the manager
(`services/testdata/dlp_detectors.json` pins it in both test suites). The
manager **fails closed** on anything else: an unknown detector, an unknown or
empty mode, or a bad pattern fails the spawn (`INVALID_ARGUMENT`) — never a
rule that silently matches nothing or a mode silently downgraded to `audit`.

### Modes (per rule)

| Mode | Behaviour |
|------|-----------|
| `off` | Rule is inactive (compiled out) |
| `audit` | Emit a `dlp` audit event (`decision=audit`); let the request through |
| `block` | Emit a `dlp` audit event (`decision=block`); return `403 Forbidden` (`X-Pal-Reason: dlp-block`) |

**Body reading.** The broker reads the body before dialling, following the
request's own framing: Content-Length → exactly `min(len, cap)` bytes; chunked
→ **de-chunked** before scanning (chunk sizes cannot split a value), up to the
terminal chunk or `cap` decoded bytes. The whole read is bounded by the
handshake timeout (10 s). `Expect: 100-continue` is answered by the broker and
stripped upstream.

**Fails closed.** With DLP configured, ambiguous framing is a `400` (both
Content-Length and Transfer-Encoding, differing Content-Length values, a
Transfer-Encoding not ending in `chunked`, malformed chunks — RFC 9112 §6.3
smuggling shapes). In block mode a body that could not be inspected up to the
cap — the guest went quiet or closed early, or padded chunk framing past the
raw budget (`2 × cap + 16 KiB`) — is refused (`403`, `dlp-incomplete`, audit
`reason=body-not-fully-inspected`), never spliced uninspected. In audit-only
mode it is forwarded and the same audit is emitted with `decision=audit`.

### Policy storage

`dlp_policies` — a per-tenant table in the control-plane Postgres instance.
RLS-enforced (invariant #7). Rows: `(tenant_id, rule_id, detector, pattern,
mode, threshold)`. The whole table is a flat list of rules; there is no
hierarchy, no ordering guarantee between rules (block beats audit at scan time).

The policy is loaded at VM schedule time (when the control-plane builds the
`AgentSpec`) and shipped to the runtime-manager in `AgentSpec.dlp_policy`
(proto field 19). The broker receives it via `ScheduleRequest.dlp_policy` →
compiled into a `DlpEngine` when the broker starts; the manager also compiles
it in `schedule()` before anything boots, so a bad policy fails the spawn
without a boot-then-kill. No per-request policy fetch; the VM's policy is fixed
at spawn. A policy that cannot be **loaded** refuses the schedule in the
control-plane (fail closed).

### Audit events

Action: `dlp`. Attrs on a match: `host`, `method`, `rule_id`, `detector`,
`byte_offset`, `byte_count`, `decision` (`audit` or `block`). On an
incompletely inspected body: `host`, `method`, `decision`,
`reason=body-not-fully-inspected`. Framing refusals are `egress` events with
`decision=deny`. **The matched value is NEVER logged or audited (invariant
#10).**

Audit events travel the same `mpsc::Sender<pb::AuditEvent>` channel as
`egress` / `egress_inject` events — fail-safe, locally-logged first, never
silently dropped on a full channel.

### Performance

Max inspected bytes per request: `DlpPolicy.max_inspect_bytes` (default
65 536 bytes, clamped to 1 MiB by the manager regardless of what is sent;
negative → default). The broker buffers at most this many decoded bytes (plus
chunk framing, bounded as above) before forwarding; the rest of the body
streams normally. The control-plane does not set it today (always default).
The detectors run on `O(n)` byte scans — no backtracking, no quadratic regexes.

---

## Consequences

- Block mode is a new fail path on the egress hot path. Tested via unit +
  integration tests in `egress_broker.rs`.
- Opaque tunnels, bytes past the cap, and keep-alive follow-on requests are not
  inspected (see "What block mode does and does not stop"). A future ADR may add
  sliding-window scanning of the whole body and byte-rate anomaly detection.
- Custom regex patterns are validated at write time and compiled before boot,
  so a bad pattern fails the API call or the schedule, never a request. Go RE2
  and Rust `regex` share RE2 syntax; a construct only one accepts is refused at
  spawn.
- Block mode can refuse legitimate requests: a client that pauses mid-body for
  longer than the handshake timeout, or streams tiny chunks with large framing
  overhead.
- Matching a rule in block mode returns `403 Forbidden` to the guest. The
  workload should treat this as a policy violation, not a server error.
