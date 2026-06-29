# ADR 0017 — Browser as Skill

**Status:** Accepted  
**Date:** 2026-06-28  
**Deciders:** Shekhar Mudarapu

---

## Context

Agents need to interact with the web: fill forms, extract data, navigate flows.
Web browsing is a powerful, side-effecting capability that touches external systems,
potentially handles PII, and can be abused if autonomy is unbounded.

---

## Decision

### Execution model: microVM only (invariant #5)

All browser execution — both reads and writes — happens inside a Firecracker
microVM via `RuntimeManager.ExecTool`. The control-plane **never** runs a
headless browser in-process. No new trust boundary is introduced; the existing
`LANTERN_RUNTIME_MANAGER_ADDR` gRPC path (used by the workflow engine) is reused.

### Read vs. write trust split

| Class | Tool name | Trust level | Auth |
|---|---|---|---|
| `browse` (extract) | `browse` | Autonomous read | Any authenticated caller |
| `browser_act` (interact) | `browser_act` | Owner-confirm write | owner/admin only; stored proposal + explicit confirm |

`browser_act` follows the same owner-confirm contract as `cross_app.ExecuteAction`:
a `commitments` row with `kind='browser_act'` and `status='suggested'` is created
by `POST /v1/browser/propose` (no side effect). `POST /v1/browser/commitments/{id}/execute`
is the sole write path and requires the owner's explicit HTTP call.

### Egress rules (enforced by the microVM harness, not the control-plane)

- No storage of session cookies or auth tokens beyond the single request.
- No CAPTCHA solving (legal / ToS boundary).
- No access to `localhost`, `169.254.0.0/16` (SSRF prevention).
- Egress is restricted to the URL in the `url` field; the harness enforces the
  `LANTERN_EGRESS_RULES` allowlist at the network layer.

### Secrets

The browser microVM receives **no** owner secrets. If a site requires auth, the
owner must explicitly wire a connector credential that the harness vends at
execution time via the secrets socket (ADR 0008). The `browse`/`browser_act`
args never carry credentials.

### Feature gate

`LANTERN_BROWSER_SKILL=on/1/true` (default **OFF**). All three endpoints return
404 when unset. This matches the `LANTERN_CROSS_APP` pattern.

---

## Increment 1 (this ADR)

The control-plane contract and owner-confirm layer. The runtime returns
`TOOL_STATUS_UNAVAILABLE` for all browser dispatches, surfaced as HTTP 503 with
the message `"browser runtime not yet available (increment 2)"`.

On `UNAVAILABLE`, `POST /v1/browser/commitments/{id}/execute` reverts the
commitment to `status='suggested'` **and** deletes the `side_effect_receipts`
row so the owner can retry without re-proposing once increment 2 ships.

## Increment 2 (follow-up)

Runtime image: a Playwright/Chromium worker baked into the Firecracker rootfs.
Runtime-manager `browse` branch: wires `ExecTool` with `tool_name="browse"` and
`tool_name="browser_act"` to the in-VM harness. No control-plane changes needed.

---

## Consequences

- **+** Owner-confirm gate prevents any autonomous write to external sites.
- **+** microVM isolation ensures the browser cannot reach the host or other VMs.
- **+** Increment 1 is fully testable and deployable without a runtime image.
- **−** `browse` reads are 503 until increment 2 — callers must handle gracefully.
- **−** One additional gRPC dial per control-plane process when `LANTERN_RUNTIME_MANAGER_ADDR` is set.
