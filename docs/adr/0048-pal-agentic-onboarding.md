# ADR 0048 — Agentic first-run for pal

- Status: Accepted
- Date: 2026-10-30
- Scope: control-plane (`/v1/pal/onboarding`), dashboard (`/pal/onboarding`), CLI (`pal setup`), bridge wrapper script

## Context

GA-AUDIT item 3: pal had no first-run. Setup meant reading a markdown doc,
hand-editing `owner-profile.md`, setting env vars, and installing LaunchAgents.
A second user could not get from install to a working assistant without the
author. The Runtime already has an agentic onboarding (`/onboarding`,
`pal onboard`): a conversation with a progress rail, server-side resume, and a
pure state machine. pal needed the same thing for its own steps.

## Decision

One flow, three surfaces, one state machine.

**Steps.** welcome (what pal is, what it touches, consent) → channels
(WhatsApp QR pair, iMessage Full Disk Access + Automation, checked live) →
voice (with consent: derive a voice profile from the owner's own sent messages
and show a draft in that voice for approval) → trust (auto/ask/off per
life-event category, holds, quiet hours) → profile (facts and relationships
captured by the LLM from what the owner says, each item confirmed) → done (the
first Brief).

**State.** `tenants.settings->'palOnboarding'`, a whitelisted typed document
that records facts, next to the Runtime's `settings->'onboarding'`. No
migration: `tenants` is the RLS-exempt tenant root and every query is scoped by
the auth tenant's own id, as the Runtime onboarding is. The resume step is
derived from the facts (`palResumeStep`), never from the stored step name.
Channels are never persisted as passed: resuming before voice lands on
channels, which checks the bridges again.

**One state machine.** The Go server owns it (`internal/handlers/pal_onboarding.go`):
PUT rejects a step the facts do not reach, and GET/PUT return `resumeStep`.
The dashboard mirrors it in `pal-onboarding-logic.ts` for instant UI. The CLI
does not re-implement it; it follows the server's `resumeStep`. All three are
pinned by `services/testdata/pal_onboarding_cases.json` (resume, gates, the
voice-consent gate, and the bridge-reading → readiness table). Change the
fixture and all three test suites run against it.

**Intelligence.** Four LLM calls, all through `CompleteInternal` (capability
`auto`, model router seam, never a vendor model):
- `guide`: the onboarding agent's turn for each step. Its system prompt holds
  a closed list of what pal does, so it cannot invent a privacy promise.
- `voice`: profile (the same shape as `bridge-core/voice-profile.ts`) plus an
  inbound/draft preview, with an optional correction ("I never use emoji").
- `profile/extract`: free text → facts/relationships in the
  `owner-profile.md` grammar. An item survives only if it quotes the owner's own
  words verbatim and passes the grammar check. The LLM can structure what was
  said, never add to it.
- `trust/suggest`: the owner's words → modes and quiet hours. It never
  proposes `auto` for `bill` or `fraud_alert`; the owner can still choose it.

Deterministic floors keep working without a model key: fallback copy for
every step, the readiness table, error → fix mapping.

**Consent gates sampling twice.** The voice endpoint reads consent from the
persisted document, not from the request, and returns 403 `consent_required`
before any model call. PUT refuses to store a derived profile without the
opt-in. On the client, `selectVoiceSamples` returns nothing without the
opt-in, so a caller that forgets to check still sends nothing. Samples are
processed in memory, never logged or persisted (invariant #10). Only the
derived profile is kept. A consent version (`2026-10`) means a change in what
pal does with data asks again.

**Every step advances on a real result.** A live bridge check (at least one
channel ready, re-checked when the owner advances), a 2xx save, a trust
read-back that matches every chosen mode, a confirmation per profile item.

**Bridges are read-only and unchanged.** The flow uses only existing
endpoints: WhatsApp `/status`, `/start`, `/qr`, `/whatsapp/search`,
`/attention`; iMessage `/diagnostics`, `/start`, `/imessage/search`,
`/attention`. The dashboard goes through the existing same-origin proxy, so
the token stays server-side. Full Disk Access and Automation are told apart by
the bridge's own diagnostic reasons (`chat-db.ts`, `applescript.ts`), not
assumed. No new bridge code, so no flag was needed.

**Applying to the Mac.** The control plane cannot write the owner's files.
`pal setup --apply` runs on the Mac and merges the confirmed items into
`## Facts` / `## Relationships` of the owner profile (replacing a confirmed
key, appending new ones, keeping every other byte). It upserts
`PAL_QUIET_START`/`PAL_QUIET_END` and, when the voice was approved,
`PAL_VOICE_REASONING=1` into `bridge.env`. Both files are backed up first,
written 0600, and verified by reading them back. The bridge wrapper now also
sources `${PAL_STATE_DIR:-~/.pal}/bridge.env` after the legacy file.

## Consequences

- A new owner can reach a working assistant without editing a file, from the
  dashboard or the terminal, and resume on either.
- The voice preview is a first impression, not the live voice path. Live
  replies still build from chat.db exemplars (and the reasoned profile when
  `PAL_VOICE_REASONING` is on).
- First-run sampling uses `fromMe` from the bridges' history search. Once the
  bridge has been sending as the owner, its own replies are also `fromMe`. At
  first run that set is empty or small, but re-running voice learning after
  months of use would learn partly from pal's own drafts. A later change
  should exclude bridge-sent rows (the bridges already track them) before
  re-learning is offered.
- `--apply` is a deliberate local step. The dashboard can't push the profile
  to the Mac until the appliance/hosted decision (GA-AUDIT G7) lands. Until
  then, the done step names the command.
