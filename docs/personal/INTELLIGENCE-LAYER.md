# Intelligence layer (the "personal OS")

The iMessage + WhatsApp bridges share a set of pure, best-effort modules in
`packages/bridge-core/src/` that make the assistant feel less like a chatbot and
more like a personal OS: it knows who it's talking to, tells the truth about
where you are, never fabricates, and answers from your real message history.

Every module is owner-only, stores state as `0600` JSONL under `~/.lantern/`,
and is **best-effort** — any failure degrades to prior behavior, never a crash
or a blocked reply. Nothing here touches the control plane or another tenant.

Identical behavior is wired into **both** bridges. The owner-facing commands
below work in your **self-chat** (or your dedicated-bot DM).

---

## Capabilities

### Truthful presence (`presence.ts`)

When a contact asks where you are, the reply is grounded in a fused snapshot
(manual `[STATUS:]` override + iPhone signals + calendar) — and it will **not
fabricate a place**. A manual override ("at the gym") is dropped the moment a
fresher iPhone location/focus signal contradicts it, and the rendered line
carries an as-of clause. Place is only ever stated when it has a timestamp.

The freshness comparison uses `latestSignalTs()` (newest entry in
`~/.lantern/device-signals.jsonl`), TTL-cached 10s so it never does a per-message
disk read on the hot path.

### Stable identity + owner corrections (`identity.ts`, `entity-binding.ts`)

The bot resolves a contact's name with a fixed precedence — **your correction >
AddressBook > pushName** — and keeps that name stable across a single reply
(`TurnBindings`), so it can't flip "Arun" to "Manasa" mid-answer.

Corrections are durable and **cross-channel** (canonical-handle keyed, so a
correction on iMessage applies on WhatsApp for the same person):

> **You:** `+15125551234 is Manasa`
> **You:** `Sam's number is 512-555-1234`
> **Bot:** `📝 noted — saved +15125551234 as Manasa`

Only the **explicit-handle** form is auto-captured. Ambiguous forms ("that's
Manasa") and annotations ("512 is just spam", "512 is probably Manasa") are
deliberately ignored so a stray sentence can't permanently mislabel a number.
Stored in `~/.lantern/identity-overrides.jsonl` (last-write-wins; correct again
to change it).

### Thread-peek — answer from the real thread (`thread-peek.ts`)

Ask about a contact's recent messages and the bot pulls the **actual thread**
(chat.db on iMessage; the `wa-history` sidecar on WhatsApp) and answers from it
instead of guessing:

> **You:** `what did Arun say`
> **You:** `catch me up on Raju`
> **You:** `see messages from mom`

Resolves to a **single** contact (never merges two people who share a name).
Owner self-chat only.

### Location privacy — disclosure-deny (`disclosure.ts`)

Tell the bot to keep your whereabouts private from a specific contact. After
that, replies to them never name a place or activity — even the "he's away at X"
directive is rewritten, and a hard never-reveal instruction is injected:

> **You:** `don't tell Ravi where I am`
> **Bot:** `📝 noted — I won't tell Ravi where you are`
> **You:** `you can tell Ravi where I am again`   ← re-allow

Stored in `~/.lantern/disclosure-denies.jsonl` (cross-channel, last-write-wins).
This is owner-set, not heuristic probe-detection — a deliberate flag, consistent
with how identity corrections work.

### Cross-app synthesis (`working-memory.ts`)

For self-context questions ("where did I go", "what am I doing") the bot
synthesizes recent actions + live signals and **says what it inferred from**,
rather than punting to "I can't tell."

---

## Stores (`~/.lantern/`, all mode 0600)

| File | Written by | Read by |
| --- | --- | --- |
| `identity-overrides.jsonl` | owner corrections | name resolution (both bridges) |
| `disclosure-denies.jsonl` | owner privacy commands | contact-reply presence gate |
| `device-signals.jsonl` | iPhone Shortcuts → tunnel | presence truthfulness |
| `working-memory.jsonl` | side-effect sites | self-context inference |

These are local PII. They are never logged, traced, or sent off-device.

---

## Truthfulness guarantees

- **Never fabricate a place.** Presence states a location only with a fresh
  timestamp; a stale override yields to newer signals.
- **Never mislabel a contact.** Corrections require an explicit handle; hedges
  and verdicts are ignored.
- **Never leak location** to a contact the owner flagged.
- **Never claim an action it didn't do.** `verifiable-claims.ts` rewrites
  completed-action claims to intent unless the action actually fired.
- **Answer from real data.** Thread-peek injects the genuine transcript.

## Validation

Pure modules are unit-tested (`*.test.ts` in `packages/bridge-core/src/`). The
bridge wiring is type-checked. Per the project's "validate in reality" rule,
none of it is "done" until the behavior is seen in the owner's real bridge logs —
the smoke tests are the example commands above.
