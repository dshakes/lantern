// Natural-language command parser.
//
// Instead of forcing slash-command syntax ("/bot off"), the user can
// type plain English in their own self-chat or any thread and the
// bridge understands it:
//
//   "pause for 2 hours"         → mute for 2h, then auto-resume
//   "mute everyone until 9am"   → mute until tomorrow 9am
//   "stop replying"             → mute indefinitely
//   "resume" / "wake up"        → unmute
//   "status" / "how are you?"   → status report
//   "what's paused?"            → list paused contacts
//   "pause for tonight"         → mute until 9am tomorrow
//   "lantern, hush"             → mute (the comma makes it obvious)
//
// Slash commands still work as power-user shortcuts; this layer
// adds a softer interface for everyone else. Parsing is regex +
// keyword based — no LLM round trip — so it's instant and free.
//
// Design notes:
//   - We DON'T want to misfire on regular owner-typed messages
//     ("I'll stop by your place at 5"). The parser only fires when:
//       a) the message starts with "lantern" / "lantern," / "hey lantern"
//          (explicit invocation), OR
//       b) the message IS short (≤ 6 words) AND contains a strong
//          command verb at the start ("pause", "mute", "stop replying").
//   - All time-bounded commands return a `durationMs` field; the
//     bridge schedules an auto-unmute timer.

export type NLCommandAction =
  | "mute"             // pause auto-reply globally
  | "unmute"           // resume auto-reply
  | "status"           // print bridge + bot state
  | "list-paused"      // show paused contacts
  | "list-chats"       // show monitored chats/groups
  | "resume-all"       // clear all per-contact pauses
  | "ping"             // liveness pong
  | "help"             // show available commands
  | "docs-on"          // enable personal-docs Q&A
  | "docs-off"         // disable personal-docs Q&A
  | "killswitch-on"    // master kill — disable ALL bot activity
  | "killswitch-off";  // restore from killswitch

export interface ParsedCommand {
  action: NLCommandAction;
  // For time-bounded mutes: how long to mute, in ms. Undefined =
  // indefinite. Common pattern: "pause for 2 hours" → 7200000.
  durationMs?: number;
  // Human-readable echo of the parsed intent ("pause for 2 hours"
  // becomes "muting auto-reply for 2 hours"). The bridge uses this in
  // its acknowledgement reply.
  echo: string;
  // True when the user used explicit "lantern, ..." invocation rather
  // than a bare verb. Mostly informational — the bridge can choose to
  // be more verbose in its reply when it's not invoked explicitly.
  explicit: boolean;
}

const INVOCATION_PREFIX = /^(?:hey\s+)?lantern[,!:\s]+/i;

const MUTE_VERBS = /\b(?:pause|mute|stop\s+replying|hush|quiet|silence|go\s+to\s+sleep)\b/i;
// Bare "on" / "off" / "stop" used to be in here but tripped on
// natural phrases like "what's on my calendar". Now we only accept
// explicit forms — bare verbs at the start of message body, full
// phrases, or the "lantern, on" / slash forms.
const UNMUTE_VERBS = /^(?:resume|unmute|wake(?:\s+up)?|reactivate|start\s+replying|come\s+back)\b/i;
const STRICT_MUTE_AT_START = /^(?:stop\s+replying|stop|off|sleep)\b/i;
const STRICT_UNMUTE_AT_START = /^(?:on)\b/i;
const STATUS_VERBS = /\b(?:status|state|diagnostics|how('s|\s+are|\s+is)|check\s*in)\b/i;
const PING_VERBS = /\b(?:ping|are\s+you\s+(?:alive|there|up|on))\b/i;
const RESUME_ALL_VERBS = /\bresume\s+(?:all|everyone|everybody)\b/i;
const LIST_PAUSED_VERBS = /\b(?:what'?s\s+paused|who'?s\s+paused|list\s+pa(used|usee)?|paused\s+contacts?|show\s+paused)\b/i;
const LIST_CHATS_VERBS = /\b(?:list\s+(chats|groups)|monitored\s+(chats|groups)|show\s+chats|show\s+groups)\b/i;
const HELP_VERBS = /\b(?:help|what\s+can\s+you\s+do|commands?|usage)\b/i;
// Personal-docs toggle. Strict prefix so plain chat ("doc this") doesn't
// misfire. Either "docs on/off" or "personal docs on/off".
const DOCS_ON_VERBS = /^(?:personal\s+)?docs?\s+(?:on|enable|enabled|allow)$/i;
const DOCS_OFF_VERBS = /^(?:personal\s+)?docs?\s+(?:off|disable|disabled|deny)$/i;
// Kill switch — master OFF for the entire bot. Both bridges check this
// before doing anything else. Recognized forms: "killswitch on",
// "kill switch off", "kill all", "lantern off", "shut down".
const KILLSWITCH_ON_VERBS =
  /^(?:kill\s*switch\s+on|kill\s+(?:all|everything|the\s+bot)|emergency\s+stop|shut\s*down|panic)$/i;
const KILLSWITCH_OFF_VERBS =
  /^(?:kill\s*switch\s+off|undo\s+kill|bring\s+(?:it|bot)\s+back|recover|reactivate\s+all)$/i;

// Parse a duration phrase like "for 2 hours", "for 30 min", "until 9am",
// "for tonight", "for an hour". Returns ms, or undefined when none.
function parseDuration(text: string): { ms?: number; phrase?: string } {
  const t = text.toLowerCase();

  // "for 2 hours" / "for 30 minutes" / "for an hour" / "for 90 min"
  const forNum = t.match(/\bfor\s+(an?|\d+)\s*(hour|hr|h|minute|min|m|day|d)s?\b/);
  if (forNum) {
    const n = forNum[1] === "a" || forNum[1] === "an" ? 1 : parseInt(forNum[1], 10);
    const unit = forNum[2];
    let ms = 0;
    if (unit.startsWith("h")) ms = n * 3_600_000;
    else if (unit.startsWith("m") && unit !== "month") ms = n * 60_000;
    else if (unit.startsWith("d")) ms = n * 86_400_000;
    if (ms > 0) return { ms, phrase: `${n} ${unit.startsWith("h") ? "hour" : unit.startsWith("m") ? "minute" : "day"}${n === 1 ? "" : "s"}` };
  }

  // "for tonight" / "until morning" / "for the night" → until 7am tomorrow
  if (/\bfor\s+tonight|\bfor\s+the\s+night|\buntil\s+morning|\buntil\s+(?:the\s+)?am\b/.test(t)) {
    const target = new Date();
    target.setHours(7, 0, 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    return { ms: target.getTime() - Date.now(), phrase: "tonight (until 7am)" };
  }

  // "until 9am" / "until 5pm" / "until 17:00"
  const untilHm = t.match(/\buntil\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (untilHm) {
    let h = parseInt(untilHm[1], 10);
    const m = untilHm[2] ? parseInt(untilHm[2], 10) : 0;
    const ampm = untilHm[3];
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (h >= 0 && h < 24) {
      const target = new Date();
      target.setHours(h, m, 0, 0);
      if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
      return { ms: target.getTime() - Date.now(), phrase: `${h}:${String(m).padStart(2, "0")}` };
    }
  }

  // "all day" → ~14h (gives a natural ceiling)
  if (/\ball\s+day\b/.test(t)) {
    return { ms: 14 * 3_600_000, phrase: "all day" };
  }

  // "an hour" / "a few hours"
  if (/\ba\s+few\s+hours?\b/.test(t)) return { ms: 3 * 3_600_000, phrase: "a few hours" };
  if (/\ban\s+hour\b/.test(t) && !forNum) return { ms: 3_600_000, phrase: "1 hour" };

  return {};
}

// Main entry. Returns null when the text isn't a command (so the
// bridge knows to treat it as a regular owner-typed message).
export function parseNLCommand(input: string): ParsedCommand | null {
  if (!input) return null;
  const raw = input.trim();

  // First: check the slash forms (backward-compatible).
  if (/^\/(?:bot|lantern)\b/i.test(raw)) {
    return parseSlash(raw);
  }

  // Natural language path. Two acceptance modes:
  //   (a) explicit "lantern, ..." invocation — strip the prefix and
  //       parse what's left
  //   (b) short, command-like phrase ("pause", "mute everyone", "status")
  //       — accept without the prefix
  let body = raw;
  let explicit = false;
  const prefixed = raw.match(INVOCATION_PREFIX);
  if (prefixed) {
    explicit = true;
    body = raw.slice(prefixed[0].length).trim();
  } else {
    // Short message + starts with a command verb? Accept. Otherwise
    // skip — we don't want to misfire on conversational text.
    const wordCount = raw.split(/\s+/).length;
    if (wordCount > 8) return null;
    const startsWithVerb =
      /^(pause|mute|stop|off|hush|quiet|silence|sleep|resume|unmute|wake|on|status|ping|help|what'?s|how'?s|how\s+are|list|show)\b/i.test(raw);
    if (!startsWithVerb) return null;
  }

  // Order matters — list-paused before mute (the words overlap).
  // Docs + killswitch use anchored ^...$ regexes so they only match
  // when the body IS the command, not when it contains the words.
  if (KILLSWITCH_ON_VERBS.test(body)) {
    return { action: "killswitch-on", echo: "🚨 kill switch ENGAGED — all bot activity halted", explicit };
  }
  if (KILLSWITCH_OFF_VERBS.test(body)) {
    return { action: "killswitch-off", echo: "✅ kill switch RELEASED — bot resumed", explicit };
  }
  if (DOCS_ON_VERBS.test(body)) {
    return { action: "docs-on", echo: "📁 personal-docs Q&A ENABLED", explicit };
  }
  if (DOCS_OFF_VERBS.test(body)) {
    return { action: "docs-off", echo: "🔒 personal-docs Q&A DISABLED", explicit };
  }
  if (RESUME_ALL_VERBS.test(body)) {
    return { action: "resume-all", echo: "resumed all paused contacts", explicit };
  }
  if (LIST_PAUSED_VERBS.test(body)) {
    return { action: "list-paused", echo: "listing paused contacts", explicit };
  }
  if (LIST_CHATS_VERBS.test(body)) {
    return { action: "list-chats", echo: "listing monitored chats", explicit };
  }
  if (PING_VERBS.test(body)) {
    return { action: "ping", echo: "pong", explicit };
  }
  if (STATUS_VERBS.test(body)) {
    return { action: "status", echo: "showing status", explicit };
  }
  if (HELP_VERBS.test(body)) {
    return { action: "help", echo: "available commands", explicit };
  }
  // Bare "on" / "off" only when invoked explicitly via "lantern, on" /
  // "lantern, off". Without the prefix they false-positive on
  // conversational phrases like "what's on my calendar" or "the lights
  // are off". The slash form (/bot on, /bot off) goes through
  // parseSlash and is unaffected.
  if (UNMUTE_VERBS.test(body) || (explicit && STRICT_UNMUTE_AT_START.test(body))) {
    return { action: "unmute", echo: "auto-reply resumed", explicit };
  }
  if (MUTE_VERBS.test(body) || (explicit && STRICT_MUTE_AT_START.test(body))) {
    const dur = parseDuration(body);
    const echo = dur.phrase
      ? `auto-reply paused for ${dur.phrase}`
      : "auto-reply paused";
    return { action: "mute", durationMs: dur.ms, echo, explicit };
  }
  return null;
}

// Slash-command parser kept for muscle-memory + scripts. Same action
// set as the NL path, slightly stricter syntax.
function parseSlash(raw: string): ParsedCommand | null {
  const [cmd, sub = "", ...rest] = raw.trim().toLowerCase().split(/\s+/);
  const explicit = true;
  if (cmd === "/bot") {
    switch (sub) {
      case "on": case "resume": case "unmute":
        return { action: "unmute", echo: "auto-reply on", explicit };
      case "off": case "pause": case "mute": {
        const dur = parseDuration(rest.join(" "));
        const echo = dur.phrase ? `auto-reply paused for ${dur.phrase}` : "auto-reply paused";
        return { action: "mute", durationMs: dur.ms, echo, explicit };
      }
      case "status":
        return { action: "status", echo: "status", explicit };
      case "resume-all": case "clear-pauses":
        return { action: "resume-all", echo: "resumed all paused", explicit };
      case "ping":
        return { action: "ping", echo: "pong", explicit };
      case "help": case "":
        return { action: "help", echo: "help", explicit };
    }
  }
  if (cmd === "/lantern") {
    switch (sub) {
      case "ping":
        return { action: "ping", echo: "pong", explicit };
      case "status":
        return { action: "status", echo: "status", explicit };
      case "chats": case "groups":
        return { action: "list-chats", echo: "listing monitored chats", explicit };
      case "docs": {
        const arg = (rest[0] || "").toLowerCase();
        if (arg === "on" || arg === "enable") return { action: "docs-on", echo: "📁 personal-docs ENABLED", explicit };
        if (arg === "off" || arg === "disable") return { action: "docs-off", echo: "🔒 personal-docs DISABLED", explicit };
        return { action: "status", echo: "status (with docs state)", explicit };
      }
      case "killswitch": case "kill": case "panic": {
        const arg = (rest[0] || "").toLowerCase();
        if (arg === "on" || arg === "engage" || arg === "" ) return { action: "killswitch-on", echo: "🚨 kill switch ENGAGED", explicit };
        if (arg === "off" || arg === "release") return { action: "killswitch-off", echo: "✅ kill switch RELEASED", explicit };
        return { action: "status", echo: "status (with killswitch state)", explicit };
      }
      case "help": case "":
        return { action: "help", echo: "help", explicit };
    }
  }
  return null;
}

// Render a human-readable reply for a parsed action. Used by the
// bridge to acknowledge the command in the same thread.
export function renderHelp(): string {
  return [
    "👋 just talk to me naturally — i understand:",
    "",
    "*auto-reply*",
    "• *pause* / *mute* / *stop replying* — pause auto-reply",
    "• *pause for 2 hours* / *mute until 9am* / *for tonight* — time-bounded pause",
    "• *resume* / *wake up* / *unmute* — turn auto-reply back on",
    "• *resume everyone* — clear all per-contact pauses",
    "",
    "*personal docs* (self-chat only — never replies in DMs or groups)",
    "• *docs on* / *docs off* — toggle local-file Q&A",
    "• `/lantern docs on|off` — slash form",
    "",
    "*safety*",
    "• *kill switch on* — 🚨 emergency stop (mutes ALL bot activity until released)",
    "• *kill switch off* — release the kill switch",
    "• `/lantern killswitch on|off` — slash form",
    "",
    "*diagnostics*",
    "• *status* — current state (incl. docs + killswitch toggles)",
    "• *what's paused* — list paused contacts",
    "• *list chats* — show monitored group chats",
    "• *ping* — liveness check",
    "",
    "starting messages with *lantern,* is the explicit way (e.g. *lantern, pause for 2h*).",
  ].join("\n");
}
