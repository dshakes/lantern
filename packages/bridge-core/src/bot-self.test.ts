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
  "📝 noted about Sam: she's vegetarian",
  "📝 got it — noted about Shiva: birthday june 3",
  "personal-docs ENABLED",
  "personal-docs DISABLED",
  // LLM disclaimers we've observed as leakage
  "i'm having authentication issues with your google services.",
  "I can search your files, but I need to use a tool that's not currently attached",
  "I can't access your emails or calendar from here",
  // From the 2026-06-02 self-chat doubling bug: call orchestration output
  // echoed back as fresh queries → doubled "Conference call…" texts.
  "📞 Conference call: dial you (+15555550100), ask if free, bridge you in\n🟡 TIER B — known contact: you\n💸 est. ~$0.08\n\n*Reply \"yes\" to dial (offer expires in 10 min) · \"no\" to cancel.*",
  "📞 Conference call: dial +16303475128, ask if free, bridge you in\n🔴 TIER C — unknown destination, no contact record",
  "📞 Voicemail to Mae: I'll have him call you back",
  "📞 Agent task call to the clinic: confirm the appointment",
  "📞 dialing Mae now — your phone will ring",
  "📞 calling Raju: ask about the invoice",
  "📞 couldn't place call: couldn't resolve \"mae\" to a phone. try the full name, or paste a phone number directly",
  "(couldn't place call: unknown)",
  "(can't place the call — orchestrator deps missing, ask me again)",
  "(call failed — Twilio 400)",
  "🧠 thinking…",
  "🧪 iMessage diagnostic — if you see this in chat, polling works",
  // Call-flow model output that echoed back as a fake query.
  "Sorry, I can't actually make calls directly from here.",
  "got it, i'll call her via the twilio number",
  // Error / retry surfaces (agentic pipeline + 👎 feedback loop).
  "Sorry, I encountered an error — try again in a bit.",
  "give me a sec…",
  "👎 noted — I'll try a different take",
  "noted — what was off about that reply?",
  "(retry didn't produce a usable reply)",
  "(same answer — need a different angle)",
  "(still too terse after retry)",
  "(retry hit an error)",
  "(couldn't generate a better reply)",
  "(call failed — Twilio 500)",
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
  "call mae",
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

test("bot-self: owner heads-up PAGES are recognized (self-chat flood fix)", () => {
  // The exact strings that looped in the field — bot read its own page back
  // as an owner query and replied to itself, flooding the self-chat.
  const pages = [
    "🛡 PROMPT-INJECTION (bot refused + paged you)\nfrom: Ronit (+15551234567)",
    "📨 bot promised to relay — here's what they said\nfrom: Manu",
    "🚨🚨 LIFE-THREAT ESCALATION\nfrom: someone",
    "🚨 *Escalation: Sarah*\n\nReason: _money_",
    "📅 Looks like an appointment text from united_airlines_dsqop",
    "📍 got it — you're at work. I'll tell anyone who messages",
    "⚠️ +16303475128 messaged but auto-reply is muted — reply yourself",
    "⚠️ couldn't generate a reply to davidfernandez3784@outlook.com",
    "⚠️ Ronit may have clocked the bot (bot-insult) — consider taking over",
    "🟡 medium-confidence reply sent to Sarah",
  ];
  for (const t of pages) {
    assert.equal(isBotSelfMessage(t), true, `expected bot-self match for page: ${JSON.stringify(t)}`);
  }
});

test("bot-self: a contact's real message is not swallowed by the page guards", () => {
  // Make sure the new patterns don't eat genuine inbound.
  const real = [
    "got the appointment confirmation, see you then",
    "can you relay this to your manager?",
    "i muted the group chat lol",
    "the meeting is at 3, don't be late",
  ];
  for (const t of real) {
    assert.equal(isBotSelfMessage(t), false, `false positive on real text: ${JSON.stringify(t)}`);
  }
});
