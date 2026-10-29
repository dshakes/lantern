# ADR 0030 — Egress data-loss prevention (DLP) on the broker

**Status:** Accepted  
**Date:** 2026-10-28  
**Author:** Lantern runtime team

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

### Detectors

| Detector | Description |
|----------|-------------|
| `card_number` | 13–19-digit sequences (spaces/dashes stripped) that pass the Luhn check |
| `secret_key` | AWS access keys (`AKIA`/`ASIA` prefix), GitHub PATs (`ghp_`/`gho_`/`ghs_`/`github_pat_`), Slack tokens (`xoxb-`/`xoxp-`/`xoxa-`/`xoxe-`), PEM private keys (`-----BEGIN * PRIVATE KEY-----`) |
| `email` | RFC 5321 email addresses — triggered at a configurable count threshold |
| `phone` | E.164 and North American formats — triggered at a configurable count threshold |
| `regex` | Caller-supplied `regex` pattern |

### Modes (per rule)

| Mode | Behaviour |
|------|-----------|
| `off` | Rule is inactive (compiled out) |
| `audit` | Log + emit `dlp_match` audit event; let request through |
| `block` | Emit `dlp_match` audit event; return `403 Forbidden` to guest |

Block mode **fails closed** on inspection error (the request is denied, never
silently allowed through).

### Policy storage

`dlp_policies` — a per-tenant table in the control-plane Postgres instance.
RLS-enforced (invariant #7). Rows: `(tenant_id, rule_id, detector, pattern,
mode, threshold)`. The whole table is a flat list of rules; there is no
hierarchy, no ordering guarantee between rules (block beats audit at scan time).

The policy is loaded at VM schedule time (when the control-plane builds the
`AgentSpec`) and shipped to the runtime-manager in `AgentSpec.dlp_policy`
(proto field 19). The broker receives it via `ScheduleRequest.dlp_policy` →
compiled into a `DlpEngine` at `Broker::new` time. No per-request policy
fetch; the VM's policy is fixed at spawn.

### Audit events

Action: `dlp_match`. Attrs: `rule_id`, `detector`, `host`, `byte_offset`,
`byte_count`, `mode` (`audit` or `block`). **The matched value is NEVER
logged or audited (invariant #10).**

Audit events travel the same `mpsc::Sender<pb::AuditEvent>` channel as
`egress` / `egress_inject` events — fail-safe, locally-logged first, never
silently dropped on a full channel.

### Performance

Max inspected bytes per request: `DlpPolicy.max_inspect_bytes` (default
65 536 bytes). The broker buffers at most this many bytes before forwarding;
the rest of the body streams normally. An unset or 0 value uses the default.
The detectors run on `O(n)` byte scans — no backtracking, no quadratic regexes.

---

## Consequences

- Block mode is a new fail path on the egress hot path. Tested via unit +
  integration tests in `egress_broker.rs`.
- Opaque tunnels are intentionally not inspected — this is a documented
  limitation. A future ADR may add byte-level byte-rate anomaly detection on
  those paths.
- Custom regex patterns are tenant-supplied and compiled at engine construction
  (not at scan time), so a bad pattern fails the schedule, not the request.
- Matching a rule in block mode returns `403 Forbidden` to the guest. The
  workload should treat this as a policy violation, not a server error.
