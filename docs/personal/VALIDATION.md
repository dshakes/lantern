# Validating the intelligence layer (live, safely)

Automated tests prove the code is internally consistent. They do **not** prove
the bot behaves right against your real Messages / WhatsApp / Mac. This is the
runbook for that last mile. Do **Phase 1 first** — it has zero risk of messaging
any contact.

All features are on `master`. Run a bridge the usual way (Terminal for iMessage
so it has Full Disk Access; the WhatsApp LaunchAgent for WA).

---

## Phase 1 — owner self-chat (ZERO contact risk)

These features fire only in **your own self-chat** and never message a contact.
Send each line to yourself and check the result + the log line.

| Send to self-chat | Expect | Log line to grep |
| --- | --- | --- |
| `+15551234567 is Testname` | `📝 noted — saved …` then a corrected reply | `identity correction captured` |
| `512 is just spam` | **no** save (correctly ignored) | _(nothing)_ |
| `don't tell Testname where I am` | `📝 noted — I won't tell …` | `disclosure preference captured` |
| `you can tell Testname where I am again` | `📝 noted — I can share …` | `disclosure preference captured` (deny:false) |
| `what did <a real contact> say` | a summary from the real thread | `buildThreadPeekBlock` (only on failure) |
| `brief me` | today's calendar + who's waiting + your plate | _(none; check it's not hallucinated)_ |

**The litmus test for `brief me`:** every line it gives back must be real —
cross-check the calendar items against your actual calendar. If it invents an
event, that's a bug (the block is built deterministically, so a hallucination
means the LLM ignored the block — tell me and I'll tighten the prompt).

**Promise-keeping + closed-loop need `LANTERN_CONCIERGE=on`** (default off):
```bash
launchctl setenv LANTERN_CONCIERGE on   # then restart the bridge
```
Then: add a calendar event via self-chat (`remind me to renew my passport`),
approve it, and confirm `brief me` later shows it under **Handled recently**
(log: `calendar action` + the recordAction).

## Phase 2 — contact-facing (use a SECOND number you own)

These need a contact to message you, so test with your own second
phone/number — never a real contact during validation.

| From the 2nd number | Expect | Log |
| --- | --- | --- |
| (after `I'm at the gym till 6` in self-chat) ask "where are you?" | bot says at the gym | presence |
| (after `don't tell <2nd-num-name> where I am`) ask "where are you?" | bot does **not** reveal the place | `denyLoc` path |
| have the bot promise "I'll send you X tonight" | shows as a tracked commitment + in `brief me` | `promise captured` |

## What "good" looks like in the logs

Tail the bridge log and watch for the capture lines above. The features are
**fail-safe**: every catch logs at `debug`/`warn` and the reply still goes out,
so a broken feature degrades to prior behavior — it won't crash a reply. If you
see a feature's `*_failed` warn, send me that line.

## Rollback

Everything is a series of commits on `master`. To pull a single feature out,
`git revert <sha>` (they're independent). To park the whole layer, the last
pre-layer commit is `d2f2f47`. None of it changes the control plane or schema,
so rollback is just the bridge processes restarting on the reverted code.
