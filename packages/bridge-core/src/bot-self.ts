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

  // ── Permission / setup messages ──
  "personal-docs ",          // "personal-docs ENABLED", "personal-docs DISABLED"
  "bot ",                    // "bot off", "bot on" — bot status echoes
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
