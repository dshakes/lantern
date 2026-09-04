# ADR 0024 — A present-tense self-model, reasoned routing, and a measured reply loop

- **Status:** Proposed
- **Date:** 2026-09-04
- **Deciders:** Shekhar Mudarapu, bridge-core, imessage-bridge, whatsapp-bridge, control-plane
- **Relates to:** ADR 0021 (self-consistency confidence), `docs/personal/INTELLIGENCE-LAYER.md`, PRs #224–#230, the outbound audit log, invariant #9 (observability)

## Context

Between 2026-08-23 and 2026-09-04 the owner reported the bridges as "an
annoying bot, templated, no cross-app context." Fourteen production failures
were root-caused from real logs and `chat.db` in that window. Every one of
them is listed here because the plan below is derived from them, not from a
wishlist.

| # | What the owner saw | Actual cause | PR |
|---|---|---|---|
| 1 | "I don't see a flight to track" 70 min after announcing a watch | `WatchStore` never injected into the owner prompt; its own `📡 watching:` line filtered out as bot-self | #224 |
| 2 | Bot books an event, then replies to that contact as if nothing happened | 9 `recordAction()` writes, **zero** reads on the contact path | #224 (watches only) |
| 3 | Real human drafts silently killed | `AI_TELL_WORDS` matched substrings: "as personal" tripped "as per" | #224 |
| 4 | A week of traffic left 33 verbatim replies | Successful sends were never logged with their text | #224, #228 |
| 5 | "what did we decide about the decorations" → nothing | 14-day window hid 88 % of chat history from relevance; keyword and vector were either/or | #224 |
| 6 | A contact answered with `[[NO_REPLY]]` | `Set<number>` cached `null` chat-rowid → ten contacts classified as the owner | #225 |
| 7 | "mute for 2h" became forever | Unmute was an in-memory timer; restart killed it, flag persisted | #226 |
| 8 | 320 messages dropped, no one told | Muted gate logged nothing; owner notice deduped on a 5-min window during a weeks-long mute | #227 |
| 9 | Debugging sent down a dead end | `isContactEnabled` called from nowhere; comment still claimed "default DENY" | #227 |
| 10 | A contact's thread dead for 31 min | POST had no timeout; per-jid promise chain wedged behind it; SSE timeout was on the wrong half of the handshake | #229 |
| 11 | Budgets reading empty rollups | `json.Marshal(nil map)` → `null` → `jsonb_object_keys` on an array. 11,074 silent failures | #229 |
| 12 | "congrats to them" about the owner's own store | No bucket for a **public** fact; `## Facts` is do-not-confirm; `## Private` is sealed | #230 |
| 13 | Foreign-language mode on an English announcement | "Brambleton, **VA**" scored French 0.95 on one 2-letter lexicon hit | #230 |
| 14 | Owner's own Telugu scored as English | "vasta", "cheptha", "matladtham" absent from the detector | #230 |

Three facts about this list matter more than any single row.

**None of the fourteen threw an error.** Every one was a silent drop, a stale
flag, a missing log line, or a fact the prompt could not represent. The bot
did not fail at reasoning. It reasoned correctly over context that was
missing the thing that mattered.

**The owner told the assistant the facts and they never reached the bot.**
"We are opening crispy cones franchise on Sep 10" was said on 2026-08-23 to
Claude Code. Twelve days later the bridge had no representation of it. The
bot's model of the owner's present life is whatever the owner happens to
type into self-chat with a teaching verb — there is no present-tense
self-model, only a static biography plus operational scraps in a sealed
section.

**Static classifiers pre-empt reasoning at every gate.** A 2-letter wordlist
decides language. A capitalization regex plus a 30-noun allowlist is the
*only* key for cross-thread recall (`social-graph.ts:150`). Emotional
register is 115 English lexemes for a Telugu code-switching owner
(`emotional-register.ts:56`). Location-privacy denial is 6 hand-written
regexes (`disclosure.ts:100`). A suppressed draft falls to five hardcoded
greetings, hash-indexed so the same contact gets the byte-identical string
forever (`natural.ts:164`). `verifiable-claims.ts:107` rewrites the model's
own prose with regexes, unconditionally. Each of these was the shortest
diff at the time. Together they are why the owner's contacts can "easily
determine it as a bot": the model writes a person; the gates around it
write a machine.

The 2026 research reviewed for this work (PersonalBench, arXiv:2604.26460,
2509.14543, 2510.24469) is unambiguous on the intuitive fixes: prompting-based
voice cloning scores *below the human floor*; more style exemplars measurably
do nothing and topic-matched selection actively hurts; per-user LoRA measured
0.00 stylometric gain; LLM-as-judge for "sounds like me" is circular. What
does work is subtraction (removing AI residue), critique against the owner's
*own* retrieved text, and — above all — measuring against a real corpus with a
calibrated floor. This repo had no corpus until #224.

## Decision

Five workstreams, in dependency order. Each names the invariant it
establishes, the gate that proves it, and the files it touches. None adds a
new service, database, or language.

### W1 — The bot can see what it is doing and what the owner is living through

*Invariant: any state the bot writes about its own actions or the owner's
present situation is readable on every reply path that could be asked about it.*

1. **Present-tense self-model.** A `## Now` section in `owner-profile.md`
   (siblings: `## Public` shipped in #230; `## Private` sealed). Free-form
   bullets, dated, with an `until:` for anything time-bound: "opening Crispy
   Cones Sep 10", "Sowmyadhar visiting until Sep 1", "GM seat unfilled through
   opening". Parsed like Facts, injected into **both** audiences with audience-
   specific framing (owner: ground truth; contact: context — confirm what is
   in `## Public`, deflect the rest). Expired bullets drop out of the prompt
   automatically. `owner-profile.ts`, `natural.ts` (mirror of `ownerPublic`).
2. **Teaching reaches the bot from every channel.** The auto-teach extractor
   (`owner-profile-auto-update.ts`) currently fires only on self-chat with a
   teaching verb. Extend the same extractor to (a) the owner's *sent*
   messages to anyone ("we're opening Sep 10" said to a friend is a fact),
   and (b) a `lantern teach "<fact>"` CLI entry so anything said to an
   assistant can be written down. Both route through the existing
   `## Now` / `## Public` / `## Facts` writer; nothing new is invented.
3. **Contact path reads working memory.** `WorkingAction` gains an optional
   `contact` field; `recordAction()` call sites that know the contact set it
   (calendar-added for X, message-sent to X, doc-sent to X). `selfContextBlock`
   (#224) renders watches **and** contact-attributed actions. Unattributed
   actions stay out — surfacing them would leak one contact's business to
   another, which is why #224 stopped at watches.
4. **Relationship inference, reasoned.** Row 12's contact had no relationship
   entry, so confidence fired with zero signals. When a contact has ≥ N prior
   messages and no `## Relationships` line, one LLM call over the thread
   infers `{relationship, confidence, evidence}` and proposes it to the owner
   in self-chat ("Bhavik reads as a close friend from the Chill Boyz thread —
   save?"). Never auto-written; the owner's `📝 noted` ack is the write.

### W2 — Reasoned gates replace string tables where a wrong call is visible to a contact

*Invariant: no decision that changes what a contact reads is made by a
regex, wordlist, or hash table alone.*

Ranked by how often the owner's contacts see the result. Each becomes a
small, purpose-keyed LLM call (`${jid}::purpose`, per the session-pollution
rule) with the static version kept as the *fail-safe fallback*, never the
primary.

1. `natural.ts:164` **greeting fallback** — five strings, hash-indexed. A
   suppressed draft gets a third generation at low temperature with the
   suppression reason as a corrective hint; the table is the fallback only
   if that also fails.
2. `verifiable-claims.ts:74–210` — thirteen regexes rewrite the model's
   sentences. Gate the rewrite on the action log (`recentActions`): rewrite
   only when the claimed action provably did not run. The unconditional
   "I let him know" rewrite (line 107) is removed; the persona rule already
   forbids the claim.
3. `social-graph.ts:150` **topic extraction** — the sole key for cross-thread
   recall — moves to the control-plane semantic index (`/v1/memory/context`,
   already hybrid RRF as of #224). The local capitalization regex + noun
   allowlist is deleted; cross-thread retrieval stops depending on exact
   string equality between "wedding" and "marriage".
4. `emotional-register.ts:56` — the 115-lexeme English table becomes a
   one-line register judgment in the same call that already drafts the
   reply (no extra round trip). Telugu distress stops reading as neutral.
5. `language.ts` — after #230 the scorer is safe against 2-letter
   collisions, but it is still a wordlist. Keep it as the cheap first pass;
   when it fires below 0.7, confirm with the model before engaging a
   foreign-language reply mode.

Explicitly **kept static**: `isBotSelfMessage` (echo-loop guard — must be
deterministic), `isNoReplySentinel`, `detectPromptInjection`, the escalation
detector. Those protect the owner from the model; they must not depend on it.

### W3 — The guard catches what the audit corpus says actually fails

*Invariant: `detectBotTells` coverage is derived from observed failures, not
from a list written in advance.*

`detectBotTells` fired **zero** times in the audited week while five real
patterns went uncaught (from the 33-sample audit): burst repetition to one
contact, the unconditional "want me to…" closer (`humanize.ts` *guarantees*
an offer), promises with no follow-through, filler questions, emoji-only
non-answers. Coverage fix, not threshold fix:

1. **Per-thread reply history** in the bot-tell context: the last 3 replies
   to this contact. A draft that is a near-duplicate skeleton of the last
   one is suppressed with reason `repeat-skeleton` → regenerate with the
   prior replies as negative examples.
2. **The offer is a judgment, not a guarantee.** `humanizeWithOffer` asks
   the model whether a follow-up adds value; the "guarantee an offer" branch
   is deleted.
3. **Promise ledger.** A reply that commits to a future action ("I'll grab it
   and send it") is recorded as a commitment (`commitments-edge.ts` already
   exists) and re-surfaced to the owner if unmet in 4h. A promise with no
   tracking path is rewritten to a non-commitment before send.
4. **Critique-refine against the owner's own text (PerFine).** For MEDIUM
   and LOW tier drafts only: one extra call compares the draft to the 5
   most-similar *owner-sent* messages (`owner-voice` corpus, already seeded
   from `chat.db`) and emits targeted edits. Grounded critique — the one
   reflection pattern the literature shows working — not "is this good?".

### W4 — Every reply is measured, and "sounds like me" has a number

*Invariant: no change to voice, persona, or the guard ships without a
before/after on the same held-out set.*

1. **Corpus.** The outbound audit log (#224, completed #228) is the source.
   Weekly job pairs each `outbound sent` with its inbound and the tier, into
   `bridge_state/<tenant>/replies.jsonl` (0600, AES-GCM via `secure-store`).
2. **Held-out owner set.** 500 of the owner's *own* sent messages from
   `chat.db` (decoded via `attributed-body.ts` — 620 of 621 sent rows live
   there, not in `text`), stratified by contact and length, never used as
   exemplars.
3. **Metric.** An authorship-verification score (LUAR-class embedding or the
   stylometric stack from arXiv:2509.14543) of each bot reply against the
   held-out set, reported with the **human floor** (owner-vs-owner on
   disjoint halves) and **ceiling**. A number without the floor is meaningless.
   No LLM judge for this metric; it was shown circular.
4. **Secondary signals.** 👎 rate per 100 replies (already collected),
   regenerate rate, `repeat-skeleton` rate, promise-unmet rate. These are the
   product metrics; the authorship score is the diagnostic.
5. **Gate.** `scripts/introspect/` (already runs 4×/day) gains a `voice`
   check: a PR touching `natural.ts`, `humanize.ts`, or the guard must not
   move the authorship score below the previous release by more than one
   floor-width.

### W5 — Silence is a bug, and a merge is not a deploy

*Invariant: every reply-suppressing path emits a log line with a reason; a
state that suppresses replies is reported every tick; the running process is
never more than one merge behind master.*

1. Extend `silent-drop-audit.test.ts` (#227) from the muted/group gates to
   **every** early `return` in `handleInbound` and the WhatsApp message loop.
   The test enumerates returns and asserts a `logger.*` call within 6 lines;
   adding a bare return fails the build.
2. `reportSilentDrops` (#227) is iMessage-only. Mirror it in WhatsApp.
3. **Deploy step.** Three services ran stale code for weeks — the API since
   Jul 19, both bridges since Aug 17 — and six PRs were "merged" while the
   bugs kept running. A `make deploy-local` target: fast-forward master,
   restart the three LaunchAgents, then **prove** it by checking each
   process's start time and one build-identifying log line. The merge gate
   in `pr-shepherd` calls it. A merge that does not restart is not done.
4. **Liveness on the control-plane.** `RecordUsage` failed 11,074 times at
   WARN and nobody counted. Any WARN that repeats > 100×/hour with the same
   message key pages the owner's self-chat once. Cheap, and it would have
   caught row 11 in the first hour instead of the third month.

```
 owner's life ──► ## Now / ## Public / ## Facts / ## Private   (W1)
                       │ typed, audience-framed
                       ▼
 inbound ──► reasoned gates (W2) ──► draft ──► critique vs OWN text (W3)
                       │                              │
                       │      detectBotTells + per-thread history (W3)
                       ▼                              ▼
                 outbound audit ──► corpus ──► authorship score vs floor (W4)
                       │
                 every suppression logged · liveness tick · deploy proves itself (W5)
```

## What this deliberately does not do

- **No multi-agent fan-out on the reply path.** The literature: ~15× token
  cost, up to 17× error amplification, ~80 % of tasks compile to one agent.
  Subagents stay where they are — auxiliary, purpose-keyed, off the hot path.
- **No fine-tuning, no more exemplars.** Both measured as null or negative.
- **No new store.** `owner-profile.md`, the JSONL state files, and the
  control-plane's pgvector index (11,088 rows, 100 % embedded — it already
  exists) cover everything above.
- **Crispy Cones stays a separate agent.** Only the *fact* that the business
  exists belongs in Lantern's self-model (done, #230).

## Consequences

- One more LLM call on MEDIUM/LOW drafts (W3.4) and one per novel contact
  (W1.4). Both purpose-keyed, both bounded; the POST timeout from #229 caps
  the worst case.
- `owner-profile.md` gains a section the owner must actually maintain, or
  the bot's present tense goes stale. W1.2 is what keeps that honest —
  teaching from any channel, not just self-chat.
- The authorship metric (W4) will initially report the bot **below the
  human floor**. That is the published finding for every prompting-based
  system in 2026 and is the honest starting point. The purpose of the number
  is to make W2/W3 changes falsifiable, not to be flattering.
- Rollout is per workstream behind env flags, W1 → W5 in order, because W4
  is what makes W2 and W3 measurable and W5 is what makes any of it
  deployable.

## Sequencing

| Order | Workstream | Why first |
|---|---|---|
| 1 | W5.3 deploy step | Every other change is inert until it runs |
| 2 | W1.1–W1.2 `## Now` + multi-channel teaching | Highest owner-visible impact per line; row 12 class |
| 3 | W4.1–W4.3 corpus + metric + floor | Makes 4 and 5 falsifiable |
| 4 | W3.1–W3.3 repeat/offer/promise coverage | The five audited failures |
| 5 | W2.1–W2.3 greeting, claims, topic key | The static gates contacts see most |
| 6 | W1.3–W1.4, W2.4–W2.5, W3.4, W5.1–W5.4 | Remainder, each gated by W4 |
