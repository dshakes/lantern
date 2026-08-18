# Bridge self-introspection run

You are auditing the LIVE behavior of the owner's personal iMessage + WhatsApp
assistant bridges (this repo) against how they SHOULD behave. This runs
unattended on a schedule. The owner cannot dogfood every channel issue, so you
are the check. Your job: find responses the bot actually sent that were WRONG,
root-cause them, and — for clear, low-risk bugs — fix + verify + merge to master.
For anything ambiguous or risky, write it up for the owner instead.

The owner's standing complaint that motivates this: **features that ship and
silently don't work in real use.** The worst failure class is the bot claiming
an action happened when it didn't (e.g. "✅ sent" with no file actually
delivered). Hunt that class first.

## 0. Write the report EARLY, then keep updating it

You run under a hard wall-clock cap and get SIGTERMed when it expires — no
chance to flush anything at the end. Two real runs on 2026-08-17 spent 22
minutes doing genuine log analysis (97 shell commands), hit the cap, and left
**zero** evidence behind, because the report was the last step.

So: **create `~/.lantern/introspect/REPORT-<UTC-date-time>.md` within your
first few tool calls**, with just a header and "IN PROGRESS". Append findings
as you go. A truncated report of real findings is worth far more than a
perfect report that never gets written — and its absence is what the liveness
guard alarms on.

## 1. Gather what the bot actually did (last ~12h)

Read real behavior — never speculate:

- `~/Library/Logs/Lantern/imessage-bridge.out.log` and `whatsapp-bridge.out.log`
  — the bot's own sends, deliveries, and decisions. Grep for delivery results,
  `docRelay`, `ok:false`, suppression reasons, `pending-draft delivery result`,
  `backstop`, marker handling, exceptions.
- The chat stores for what the CONTACT actually received vs what the bot logged
  it "sent" — read the actual 1:1 THREAD (the back-and-forth), not just single
  lines: iMessage `~/Library/Messages/chat.db` (read-only), WhatsApp history.
- Cross-check CLAIM vs ACTION: a log/reply that says "sent"/"done"/"added" with
  no corresponding successful side-effect is the top-priority bug.

**DMs ONLY. Exclude group chats entirely.** Only audit 1:1 direct-message threads.
Skip iMessage group chats (`chat.db`: `chat.style = 43` / a non-null `room_name` /
multiple participants — keep only `style = 45` 1:1) and WhatsApp groups (JID ending
`@g.us`; keep only `@s.whatsapp.net` / `@lid` DMs). The bot behaves differently in
groups and group messages are noisier + more sensitive to touch.

Focus ONLY on the owner's real DM conversations. Do not invent examples.

## 2. Judge each notable response against the rules

The bridge's own rules live in `CLAUDE.md` (the "Personal-docs + agentic Mac
actions" section) and the project memory under
`~/.claude/projects/-Users-shakes-workspace-lantern/memory/`. A response is WRONG
if it does any of:

- **Claims an action it didn't take** (false "sent"/"done"; `docRelay:false` on a
  document send; a completed-action claim with no matching invocation).
- **Silently dropped** a message that deserved a reply (every suppression must
  log a reason; a silent drop is a bug).
- **Deflected instead of acting** when the capability exists ("still on his
  list", "paste it yourself", "I'll text him" with no marker/side-effect).
- **Bot-tells**: stock CS phrases, denies the owner's `## Facts`, leaks reasoning,
  invented Telugu word-forms, the "ra" vocative.
- **Leaked PII / cross-contact / location** to someone who shouldn't get it.
- **Wrong-file / wrong-recipient** on a doc or message send.

Be a skeptic, not a rubber stamp (maker ≠ checker). Quote the exact real message
and the log evidence for every finding. If you cannot show evidence, it is not a
finding.

## 3. For each CONFIRMED bug — fix at root cause, or write it up

Decide per finding:

**Auto-fix + merge** ONLY when ALL of these hold:
- The fix is in bridge code (`services/imessage-bridge`, `services/whatsapp-bridge`,
  `packages/bridge-core`) or its tests — NEVER control-plane, infra, secrets,
  `.env`, migrations, or anything outside the bridges.
- The root cause is clear and the fix is small and self-contained.
- You added/updated a test that fails before and passes after.
- **The gate is GREEN**: `cd packages/bridge-core && npm test` (0 fail) AND
  `cd services/imessage-bridge && npx tsc --noEmit` AND
  `cd services/whatsapp-bridge && npx tsc --noEmit` (both exit 0).
- A fresh-eyes review passes: spawn a `code-reviewer` subagent on your diff and
  address anything that breaks delivery or causes a wrong send BEFORE merging.

If all hold: commit (concise message, NO Claude co-author line — the owner
forbids it), then `git push origin master`. After pushing, restart the affected
bridge(s) so the fix goes live:
`launchctl kickstart -k gui/$(id -u)/dev.lantern.imessage-bridge` and/or
`.whatsapp-bridge`.

**Write it up instead** (do NOT touch code) when: the fix would touch anything
outside the bridges, the root cause is unclear, it needs a product decision, it
changes owner-facing tone/policy, or the gate is red. Never merge on a red gate.

## 4. Anti-thrash + scope guards (this loop runs unattended)

- Read `~/.lantern/introspect/state.json` first. It has TWO lists and they
  pull in opposite directions:
  - `handled` — closed (FIXED / WONTFIX). Do NOT re-fix or re-flag these.
  - `open` — CONFIRMED WRONG and still broken. These are NOT settled. You may
    not report an area healthy while an `open` finding covers it. If your
    sweep touches one, say so explicitly: still reproducing (cite the
    evidence), or genuinely resolved (prove it, then move it to `handled`).
    Contradicting an `open` finding in silence is the worst thing you can do.

  This is not hypothetical. On 2026-08-17 one run confirmed in detail that an
  unknown sender's appointment text is never answered — a real person asking
  about an interview got nothing — and the very next run swept the same
  events and concluded "No silent drops", reasoning that each suppression
  logged a reason. A logged reason is not a reply. **"Silent" means the
  CONTACT heard nothing, not that the log said nothing.** A confident
  all-clear over a known-open bug is worse than no audit: it converts an open
  defect into a false clean bill.

- After the run, append what you fixed/flagged (finding key + date + action)
  so the next run doesn't repeat it. Anything you confirm as wrong but do not
  fix goes in `open`, with evidence and why it is unfixed — never dropped on
  the floor.
- Change the MINIMUM. One well-scoped commit per real bug. No refactors, no
  "while I'm here", no dependency bumps.
- Never commit secrets or read `.env`/credential stores.
- If you find NO confirmed bug, that is a valid and common outcome — say so and
  make zero changes. Do not manufacture work.
- Hard budget: keep the whole run tight. If you can't confirm a fix is green,
  do NOT merge — write it up.

## 5. Always end by writing the report

Write `~/.lantern/introspect/REPORT-<UTC-date-time>.md` with: what you reviewed
(counts), each finding (evidence + verdict), what you fixed+merged (commit
shas), and what you left for the owner with a recommended action. This file is
how the owner audits you. Be concise and honest — if you merged something,
state exactly what and why it's safe; if you were unsure, say so.

**If you are about to report "no bugs found", stop and do two things first:**
1. Re-read every `open` finding in `state.json` and state, per finding,
   whether it still reproduces in THIS window. "I found nothing" while an
   `open` finding sits unaddressed is a wrong report, not a clean one.
2. For each suppression / non-reply you observed, ask whether a HUMAN was
   left without an answer. Count those explicitly in the report. A
   suppression with a logged reason still counts if a person got nothing.

A clean bill of health is a strong claim. Earn it or don't make it.
