// Regression tests for the bot-self predicate.
//
// Every string in BOT_TEXTS comes directly from the production log
// where the bridge was processing its own outputs as fresh user
// queries. If isBotSelfMessage misses any of these, the catastrophic
// echo loop returns.
//
// USER_TEXTS are real owner messages that must STAY routable to the
// agentic pipeline.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isBotSelfMessage } from "./bot-self.ts";

const BOT_TEXTS = [
  // From the 2026-05-29 log: bridge processing its own acks/progress
  "📁 one sec — looking through your files…",
  "📁 doc query: When should I apply for naturalization",
  "📁 doc followup: send it",
  "🧠 on it…",
  "📷 still scanning — almost there…",
  "📷 still working — almost there…",
  "📎 grabbing it…",
  "⏳ still on the previous one — I'll get to this next",
  "⏳ still working on the previous one — give me a sec",
  // Action confirmations
  "📅 added to calendar — Naturalization renewal reminder",
  "🗒 saved as a note — \"Passport expiry\"",
  "✉️ draft opened in Mail — review + send when ready",
  "👍 no worries",
  "(couldn't attach — file \"foo.pdf\" not found in any allowed root)",
  "(calendar failed: AppleScript error)",
  "couldn't reach the agent — try again in a sec.",
  // Status / digest / dashboard
  "🟢 *Lantern iMessage*\n• bot: on\n• personal-docs: on",
  "🟢 *Lantern WhatsApp*\n• bot: on",
  "📊 *lantern morning report* — fri, may 29\n• quiet night — no urgent",
  "🚨 kill switch ENGAGED",
  "⏸ paused contacts (3):",
  "👀 monitoring this group — I'll flag urgent msgs",
  "👀 monitored groups (2):",
  "🙈 stopped monitoring this group.",
  // Memory replies
  "📝 noted about Manasa: she's vegetarian",
  "📝 got it — noted about Shiva: birthday june 3",
  "personal-docs ENABLED",
  "personal-docs DISABLED",
  // LLM disclaimers we've observed as leakage
  "i'm having authentication issues with your google services.",
  "I can search your files, but I need to use a tool that's not currently attached",
  "I can't access your emails or calendar from here",
  // From the 2026-06-02 self-chat doubling bug: call orchestration output
  // echoed back as fresh queries → doubled "Conference call…" texts.
  "📞 Conference call: dial you (+15126088977), ask if free, bridge you in\n🟡 TIER B — known contact: you\n💸 est. ~$0.08\n\n*Reply \"yes\" to dial (offer expires in 10 min) · \"no\" to cancel.*",
  "📞 Conference call: dial +16303475128, ask if free, bridge you in\n🔴 TIER C — unknown destination, no contact record",
  "📞 Voicemail to Manu: I'll have him call you back",
  "📞 Agent task call to the clinic: confirm the appointment",
  "📞 dialing Manu now — your phone will ring",
  "📞 calling Raju: ask about the invoice",
  "📞 couldn't place call: couldn't resolve \"manu\" to a phone. try the full name, or paste a phone number directly",
  "(couldn't place call: unknown)",
  "(can't place the call — orchestrator deps missing, ask me again)",
  "(call failed — Twilio 400)",
  "🧠 thinking…",
  "🧪 iMessage diagnostic — if you see this in chat, polling works",
  // Call-flow model output that echoed back as a fake query.
  "Sorry, I can't actually make calls directly from here.",
  "got it, i'll call her via the twilio number",
];

const USER_TEXTS = [
  "When should I apply for US naturalization?",
  "When does my greencard expire",
  "When does my license expire",
  "When did I go to turkey",
  "Who is my son",
  "find my passport",
  "send me the lease pdf",
  "I 485 folder should have all the documents",
  "remind me tomorrow about the dentist",
  "You have my personal docs. You should be intelligent enough",
  "the files you have on your desktop are from 2017",
  "No thanks",
  "ok",
  "Status",
  // Real call requests from the owner — MUST still route to the pipeline,
  // not be swallowed as bot-self output.
  "call manu",
  "call raju about the invoice",
  "can you call the dentist and confirm my appointment",
  "ring mom for me",
  // A contact's own message that mentions calling — must stay routable.
  "call me back when you're free",
  "give me a call via the office line later",
];

test("bot-self: every known bot output matches", () => {
  for (const t of BOT_TEXTS) {
    assert.equal(isBotSelfMessage(t), true, `expected bot-self match for: ${JSON.stringify(t)}`);
  }
});

test("bot-self: real user text never matches", () => {
  for (const t of USER_TEXTS) {
    assert.equal(isBotSelfMessage(t), false, `false positive on user text: ${JSON.stringify(t)}`);
  }
});

test("bot-self: empty input does not match", () => {
  assert.equal(isBotSelfMessage(""), false);
  assert.equal(isBotSelfMessage("   "), false);
});

test("bot-self: case insensitivity", () => {
  assert.equal(isBotSelfMessage("📁 ONE SEC — LOOKING"), true);
  assert.equal(isBotSelfMessage("📊 *Lantern Morning Report*"), true);
});
