# ADR 0047 — PAL deployment model: device appliance + cloud control plane

**Status:** Accepted (control-plane side shipped; bridge-side pairing is a flag-gated follow-up)
**Date:** 2026-10-30
**Deciders:** Platform team
**Relates to:** ADR 0011 (RLS), ADR 0027 (auth lifecycle / route scopes), ADR 0032 (rename to PAL)

---

## Context

The PAL consumer product is a bespoke appliance for one person (GA-AUDIT #4, #6):

- **One bridge = one owner = one Mac.** The iMessage and WhatsApp bridges run
  under the owner's launchd, read `chat.db` / Apple Mail / AddressBook in-process,
  and talk to the control plane as the dev tenant
  `00000000-0000-0000-0000-000000000001`. There is no way to attach a second
  person's Mac to a second tenant.
- **`/v1/signals` is single-owner.** iPhone Shortcuts POST device context with a
  shared secret (`PAL_SIGNAL_TOKEN`); the handler appends to one file in the
  API process's home directory that the bridge reads. There is no tenant, so a
  second user's signals would land in the first user's file.

Shipping PAL to a second user is impossible without a device/tenancy model. The
first user's live install must keep working unchanged throughout.

## Decision

### Deployment model: appliance + cloud control plane

| Lives on the user's Mac (the **bridge appliance**) | Lives in the control plane (per **tenant**) |
| --- | --- |
| `chat.db`, Apple Mail Envelope Index, AddressBook, local documents, OCR cache, knowledgeC.db | Tenant + users, billing / budgets, dashboard |
| The reply pipeline's raw inputs (full threads, mail bodies, files) | Agent + persona config, owner profile (as it moves server-side) |
| Device-local encrypted stores (`secure-store.ts`) | Cross-channel memory the user has approved (`/v1/memory/*`, `/v1/people/*`) |
| The bridge credential (Keychain in the follow-up) | Device registry (`bridges`), tenant-scoped `device_signals`, life-events, commitments |

**Privacy rule (load-bearing):** raw personal sources — messages, mail, files,
contacts, app usage — never leave the Mac. What crosses the wire is the minimal
derived context a feature needs and the user has approved: a person-memory
event, a summarized signal, a life-event row, the LLM request for one reply
(which already goes through the tenant's provider keys and the model router).
Server-side features that want more must ask the bridge for a summary, not pull
the source. This keeps the control plane out of the business of storing a
user's message history.

A paired device is a **principal of its tenant**, not a user: it has its own
credential with a narrow scope set, it shows up in Settings → Devices, and it can
be revoked without touching the user's login.

### Enrollment (pairing) flow

```
 dashboard (JWT)                control plane                     device (no creds)
 ─────────────── POST /v1/bridges/enroll ──▶ mint code, store sha256(code),
                 ◀── {code, expiresAt} ───   TTL 10 min, single-use
 show code + QR  pal://pair?code=…&server=…
                                                     ◀── POST /v1/bridges/pair {code}
                                  consume code (atomic UPDATE … WHERE unconsumed
                                  AND unexpired), insert bridges row with
                                  sha256(token), same tx  ── {bridgeId, tenantId, token} ──▶
                                                                    store token (Keychain)
 device uses `Authorization: Bearer pal_brg_…` on bridge endpoints
```

- **Code:** 10 Crockford-base32 characters (50 bits, `XXXXX-XXXXX`), typed or
  scanned. Input is normalized (case, separators, O→0, I/L→1). Stored only as
  SHA-256; at most 5 unconsumed codes per tenant (429 past that).
- **Pair is unauthenticated by construction** — the code *is* the credential.
  Guessing is bounded by entropy × TTL × single-use, and the endpoint is
  rate-limited per peer IP (10/min) and globally (300/min) per replica.
  `X-Forwarded-For` is ignored for limiting (client-controlled).
- **Token:** `pal_brg_` + 256 random bits, returned exactly once, stored as
  SHA-256 (same scheme as `api_keys.key_hash`; high-entropy secrets need no
  stretching). A 16-char non-secret prefix is kept for display.
- **Scopes** are fixed at enroll time from a per-platform ceiling:
  `macos` → `bridge:signals:write`, `bridge:signals:read`;
  `ios-shortcuts` → `bridge:signals:write` only. They are disjoint from the
  API-key lattice. **A bridge token is accepted only by bridge endpoints** — it
  is deliberately not understood by `validateRequest`, so a stolen device
  credential cannot drive the tenant's agents, runs, keys or settings, and a
  device can never enroll, list or revoke devices (403).
- enroll / list / revoke require a tenant user (JWT, or an API key holding
  `settings:write` / `read`); kiosk sessions never qualify. These checks are
  enforced unconditionally — credential management is not left to the
  `PAL_AUTHZ_ENFORCE` staging flag.

### Rotation and revocation

- **Revocation** (`DELETE /v1/bridges/{id}`) is a soft delete (`revoked_at`); the
  token fails on the next request (every request re-validates against the DB —
  no cache to wait out). Cross-tenant, unknown or malformed ids are 404 (no
  existence leak); re-revoking is a 200 no-op.
- **Rotation** (`POST /v1/bridges/self/rotate`, bridge-authenticated) swaps the
  hash in place and kills the old token at once. A device that loses the
  response re-pairs with a fresh code — the user is always the recovery path,
  which is the property we want for a credential that can read personal
  context. The follow-up bridge rotates on a schedule (e.g. every 30 days).
- **Lost / stolen Mac:** revoke in the dashboard. Signals and memory already in
  the control plane stay with the tenant; nothing on the device is trusted again.

### Multi-device

A tenant may pair any number of devices (one row each): a home Mac running the
iMessage bridge, a second Mac running WhatsApp, an iPhone Shortcuts source.
Each has its own credential, scopes, last-seen time and revocation. Signals are
tenant-scoped and stamped with the writing `bridge_id`, so a reader sees the
tenant's merged stream. Which device owns which channel (to avoid two Macs both
answering the same iMessage account) is a bridge-side lease concern for the
follow-up — the registry is the place it will live.

### Tenant-scoped signals

`device_signals` (migration 0033, RLS `ENABLE`+`FORCE`, `tenant_isolation`
policy, in the `TestRLSEnforcement_AllTenantTables` catalog) replaces the file
for every tenant-credentialed caller. `/v1/signals` resolves its caller in this
order:

1. **`Authorization` present → judged on that credential only** (never falls
   back to the shared secret):
   `Bearer pal_brg_…` → bridge path (scope `bridge:signals:write`/`:read`);
   anything else → JWT / API key (`write`/`read`, kiosk refused).
   Reads/writes go through `WithTenantConn` on the RLS pool.
2. **No `Authorization` → legacy single-owner path**, unchanged:
   `PAL_SIGNAL_TOKEN` in `x-lantern-signal-token` (or `x-pal-signal-token`),
   fail-closed when unset. Writes still append to the device-signals file the
   live bridge reads (the file is authoritative and decides the response), and
   are additionally mirrored best-effort (2 s budget, errors logged, never
   surfaced) into `device_signals` for **one** tenant:
   `PAL_SIGNALS_LEGACY_OWNER_TENANT` (default the dev tenant; `off` disables the
   legacy path; a malformed value fails closed). GET still reads the file.

Retention: each tenant write prunes that tenant's rows older than
`PAL_SIGNALS_RETENTION_DAYS` (default 30) — signals are app-context PII.

### Upgrade path for the existing single-owner install

Nothing changes for tenant `…0001` on deploy: the Shortcuts keep the shared
header, the API keeps writing the same file, the bridges keep reading it, no
bridge code changes in this ADR's first PR. The mirror starts filling that
tenant's `device_signals`, so the dashboard and the future bridge reader see
history from day one. Migration, in order, each step reversible:

1. **(this PR)** Registry, pairing, tenant signals, Settings → Devices.
2. **Bridge pairing behind a flag** (`PAL_BRIDGE_PAIRING=1`, default off =
   byte-identical): `pal bridge pair <code>` stores the token in the Keychain;
   the bridge sends it on control-plane calls and reads signals from
   `GET /v1/signals` instead of the file. Validated in the owner's real logs.
3. **Re-point the owner's Shortcuts** at a paired `ios-shortcuts` device token.
4. **Retire the legacy path:** set `PAL_SIGNALS_LEGACY_OWNER_TENANT=off`.
   Multi-tenant deployments should set this from the start.
5. Bridge refuses the dev tenant outside a dev profile (GA-AUDIT T3/G11) once
   pairing is the only way a bridge learns its tenant.

## Consequences

- **New trust boundary:** an unauthenticated endpoint (`/v1/bridges/pair`) that
  mints tenant credentials. Mitigated by code entropy, TTL, single-use,
  hash-at-rest, rate limiting, and scope-narrow tokens. The in-memory limiter is
  per replica; a gateway-level limit is the stronger follow-up for large fleets.
- Bridge tokens are bearer secrets; transport is the existing TLS/tunnel. Device
  attestation (Secure Enclave key, mTLS client cert per device) is a later
  hardening and fits the same registry (add a public key column, require
  proof-of-possession on pair and rotate).
- The legacy shared-token path remains a single-tenant hole by design until
  step 4; it can only ever write into the one configured tenant.
- `bridge_pairing_codes` / `bridges` / `device_signals` are GDPR-exported and
  erased with the tenant (catalog-driven); hash/token columns are redacted from
  export.

## Alternatives considered

- **Pure SaaS (bridge runs in our cloud):** impossible for iMessage (needs a
  signed-in Mac) and violates the privacy rule (chat.db would leave the device).
- **Reuse API keys for devices:** an API key authenticates the whole REST
  surface; a device credential must not. Separate prefix, table and scopes keep
  the blast radius small and the dashboard honest about what is paired.
- **OAuth device-authorization grant (RFC 8628):** the right shape if a
  third-party OAuth server fronted auth. Our flow is the same idea inverted
  (code shown in the signed-in browser, entered on the device), which avoids
  device polling and works with a QR.
