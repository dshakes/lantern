// Definitive predicate for "this text was produced by the bot itself."
//
// The bridges pipe every chat.db / WhatsApp inbound through this check
// BEFORE the routing decision. A true positive guarantees the message
// is bot-generated output (an ack, a progress nudge, a status reply, a
// digest, an action confirmation) and must NEVER fire the agentic
// pipeline as a fresh user query.
//
// Why a separate hard-coded pattern check on top of `recentBridgeSends`
// dedup? Because the dedup is best-effort:
//   1. recentBridgeSends is in-memory — restarts lose it.
//   2. The TTL is finite; a 180s SSE timeout + iCloud sync delay can
//      push old bot rows past the window.
//   3. chat.db / WhatsApp echo back the bot's own send moments after
//      AppleScript / Baileys hand-off — the row arrives BEFORE the
//      recordBridgeSend entry on rare timing races.
//
// These patterns cover EVERY string the bridge emits. Keep this in
// sync with new bot ack/digest/status text. Each entry is a literal
// prefix match (case-insensitive, trimmed) of the message body. We
// match prefix because the bot's lines often have a trailing newline /
// trailing details that vary.

const BOT_SELF_PREFIXES: string[] = [
  // ── Agentic pipeline acks + progress nudges ──
  "🧠 on it",
  "🧠 thinking",             // the "🧠 thinking…" progress nudge
  "🧪 ",                     // bot diagnostics ("🧪 iMessage diagnostic — …")
  "📁 one sec",
  "📁 looking through your files",
  "📁 doc",                  // "📁 doc query: ..." / "📁 doc followup: ..."
  "📷 still scanning",
  "📷 still working",
  "📷 almost there",
  "📎 grabbing it",
  "⏳",                      // any hourglass-prefixed waiting nudge
  "🪙 no monitored groups",

  // ── Action confirmations ──
  "📅 added to calendar",
  "📅 calendar event",
  "🗒 saved as a note",
  "🗒 note",
  "✉️ draft opened in mail",
  "✉️ mail draft",
  "👍 no worries",
  "👍 ok",
  "(couldn't attach",
  "(calendar failed",
  "(note failed",
  "(mail draft failed",
  "couldn't reach the agent",

  // ── Outbound call orchestration (pre-flight / dialing / errors) ──
  // Every string the call orchestrator + command executor emit. Without
  // these, a call confirmation that echoes back in self-chat AFTER the
  // recentBridgeSends window expires (iCloud sync lag + the "chat busy"
  // queue delay) is reprocessed as a fresh query → the bot replies to
  // itself → the user sees doubled "Conference call…" texts.
  "📞 conference call",      // "📞 Conference call: dial …, bridge you in"
  "📞 voicemail",            // "📞 Voicemail to …:"
  "📞 agent task call",      // "📞 Agent task call to …:"
  "📞 dialing",              // "📞 dialing … now — your phone will ring"
  "📞 calling",              // "📞 calling …:"
  "📞 couldn't place call",  // command-executor failure surface
  "(couldn't place call",    // session-level failure surface
  "(can't place the call",
  "(call failed",

  // ── Status / digest / dashboard output ──
  "🟢 *lantern",             // "🟢 *Lantern iMessage*", "🟢 *Lantern WhatsApp*"
  "🟢 lantern",
  "🔴 *lantern",
  "🔴 lantern",
  "📊 *lantern morning report",
  "📊 *lantern",
  "📊 lantern",
  "🚨 kill switch",
  "🚨 ",
  "⏸ paused contacts",
  "👀 monitored",
  "👀 monitoring",
  "🙈 stopped monitoring",

  // ── Memory + fact replies ──
  "📝 noted about",
  "📝 got it",
  "📝 saved",
  "couldn't save that note",

  // ── Error / retry surfaces (agentic pipeline + feedback loop) ──
  "sorry, i encountered an error",
  "give me a sec",
  "👎 noted",
  "noted — what was off",
  "(retry didn't produce",
  "(same answer — need",
  "(still too terse",
  "(retry hit an error",
  "(couldn't generate a better",

  // ── Permission / setup messages ──
  "personal-docs ",          // "personal-docs ENABLED", "personal-docs DISABLED"
  "bot ",                    // "bot off", "bot on" — bot status echoes

  // ── Owner heads-up / escalation PAGES (self-chat) ──
  // fireOwnerEscalation + notifyOwnerOfDrop + the appointment detector post
  // these into the owner self-chat. They were NOT registered, so once they
  // aged past the recentBridgeSends window the bot read its OWN page back as
  // an owner query, ran a doc-query on it, and replied — each reply a new
  // self-chat row that looped → the self-chat flood. These emoji prefixes are
  // bot-only (a human never opens a text with them).
  "🛡",                      // "🛡 PROMPT-INJECTION (bot refused + paged you)"
  "📨",                      // "📨 bot promised to relay — here's what they said"
  "🚨🚨",                    // "🚨🚨 LIFE-THREAT ESCALATION" (double-siren page)
  "📅 looks like an appointment", // appointment-detector heads-up
  "📍 got it",               // presence/status acks ("📍 got it — you're …")
  "🟡 medium-confidence",    // medium-confidence reply heads-up

  // ── Concierge edge (LANTERN_CONCIERGE=on) ──
  // Task-capture ack + commitment nudges. Keep in sync with
  // CONCIERGE_SELF_PREFIXES in commitments-edge.ts.
  "📝 tracking:",    // "📝 tracking: Apply for naturalization"
  "📌 ",             // "📌 Apply for naturalization (from Manu) — reply: …"

  // ── Proactive loops (LANTERN_COMMUTE=on / LANTERN_ENERGY=on / LANTERN_HEALTH=on / LANTERN_FOCUS=on) ──
  // Keep in sync with PROACTIVE_LOOP_SELF_PREFIXES in proactive-loops.ts.
  "🚗 driving",      // "🚗 driving — N things when you stop: …"
  "🅿️ parked",       // "🅿️ parked — still on your list: …" / "🅿️ parked — all clear."
  "😴 ~",            // "😴 ~5.2h last night — want me to …"
  "🏃 ",             // "🏃 4.2k steps — 3.8k to your 8k goal, quick walk before dinner?"
  "💪 nice",         // "💪 nice (ran 3mi) — workout logged"
  "🧘 this week:",   // "🧘 this week: avg 7.2k steps/day, 7h sleep avg, 3 workouts"
  "📥 while you were heads-down", // "📥 while you were heads-down (2h): meeting in 10 min; …"

  // ── Life-event engine owner pings (self-chat) ──
  // The LIFE-EVENT ENGINE surfaces typed transactional inbound (bill, delivery,
  // fraud, OTP, receipt, travel) to the owner self-chat with one-tap actions.
  // Without these prefixes the bot would re-ingest its OWN ping as an owner
  // query once the recentBridgeSends window expires. Keep in sync with
  // LIFE_EVENT_SELF_PREFIXES in life-events.ts.
  "💸 ",                     // bill ping ("💸 GEICO $1,989.85 due Jun 30…")
  "📦 ",                     // delivery ping + "📦 logged delivery" auto-act log
  "⚠️ ",                     // fraud ping ("⚠️ Amex flagged a declined charge…")
  "🔑 ",                     // OTP surface ("🔑 your code is 611586…")
  "🧾 ",                     // receipt ("🧾 Amazon $35.99 — order confirmed.")
  "✈️ ",                     // travel ("✈️ travel update …")

  // ── AUTO-ACT LADDER (self-chat logs + acks) ──
  // The bot auto-executes safe reversible actions and logs them with an undo.
  // Without these prefixes it would re-ingest its own "📅 added to your
  // calendar…" / "📦 logged delivery…" log as an owner query once the
  // recentBridgeSends window expires. Keep in sync with LIFE_EVENT_SELF_PREFIXES.
  "📅 ",                     // "📅 added to your calendar — …" auto-act log (+ "📅 added to calendar")
  "🤖 ",                     // "🤖 today i auto-handled …" recap + auto-act acks
  "↩️ ",                     // "↩️ undone — removed it." undo ack
  "⏸ automation",            // "⏸ automation paused — …" command echo
  "▶️ automation",           // "▶️ automation resumed — …" command echo
];

// Common LLM-reply patterns we've ALSO observed leaking through as
// inbound rows (the prior turn's LLM answer being treated as a new
// query when the dedup window expires). These are not bot-emitted
// fixed strings — they're model output — but their shape is
// recognizable enough to skip safely without false-positives on real
// user input. Keep this list tight: only patterns the model uses
// that a human almost never types verbatim.
const BOT_LLM_PATTERNS: RegExp[] = [
  // The "I can/can't access" disclaimer pattern the LLM falls into.
  /^i'?m having authentication issues/i,
  /^i can search your files, but i need to use a tool/i,
  /^i can'?t access your (?:files|emails|calendar|inbox)/i,
  // Call-flow model output that echoed back as a fake query.
  /^sorry,? i can'?t actually make calls/i,
  /\bi'?ll (?:call|ring|reach) .{0,40}\bvia the twilio number\b/i,
  // Owner heads-up PAGES whose prefix carries a variable handle/name (so a
  // fixed prefix can't catch them) — match a distinctive interior phrase
  // instead. Each is bot-emitted into the self-chat; without these the bot
  // re-ingests its own page as an owner query and replies to itself.
  /\bmessaged but auto-reply is (?:muted|off)\b/i,        // "⚠️ <h> messaged but auto-reply is muted"
  /\bcouldn'?t generate a reply to\b/i,                   // "⚠️ couldn't generate a reply to <h>"
  /\bmay have clocked the bot\b/i,                        // bot-clocked heads-up
  /\bbot promised to relay\b/i,                           // relay page (belt + suspenders w/ 📨)
  /\bprompt-injection \(bot refused/i,                    // injection page
  /^🚨 \*escalation/i,                                    // "🚨 *Escalation: <name>*"
];

/**
 * Returns true when the text is bot-emitted output and must be hard-
 * skipped at the top of every inbound handler.
 *
 * Performance: linear scan of <40 prefixes + 3 regexes per call.
 * Always sub-millisecond. Safe to call on every poll row.
 */
export function isBotSelfMessage(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (t.length === 0) return false;
  for (const p of BOT_SELF_PREFIXES) {
    if (t.startsWith(p.toLowerCase())) return true;
  }
  for (const re of BOT_LLM_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

// Exported for tests / regression coverage.
export const _BOT_SELF_PREFIXES = BOT_SELF_PREFIXES;
export const _BOT_LLM_PATTERNS = BOT_LLM_PATTERNS;
