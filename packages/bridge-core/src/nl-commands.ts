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
  | "killswitch-off"   // restore from killswitch
  | "approvals-on"     // VIP + low-conf contacts queue drafts for approval
  | "approvals-off"    // VIPs go silent, low-conf falls through to auto-reply
  | "vip-list"         // show all VIPs
  | "vip-clear"        // remove every VIP entry
  | "escalation-on"    // master switch for panic channels (push + voice + macOS notif)
  | "escalation-off"   // disable panic channels; primary alerts (WA/iM/email) still fire
  | "pushover-on"      // just the Pushover siren channel
  | "pushover-off"     // disable Pushover siren
  | "call-conference"  // dial X, ask if free, conference owner in
  | "call-voicemail"   // dial X, speak message, hang up
  | "call-task";       // dial business/IVR with a one-shot task

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
  // ── Outbound call commands (call-conference / call-voicemail /
  //    call-task) populate these fields. Caller resolves `target`
  //    to a phone number via the owner profile / contact lookup
  //    before dialing.
  // Who to call. Either a contact name ("Madhu", "mom") or a raw
  // phone-ish ("+15125551234", "1-800-MY-CVS").
  callTarget?: string;
  // For voicemail / agent-task: the spoken message body.
  callMessage?: string;
  // Stated reason for the call (for risk-tier classification).
  callReason?: string;
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
// Approval-queue toggle. Strict anchored regex so plain chat doesn't
// trip ("approved!" / "thanks for the approval" never match).
const APPROVALS_ON_VERBS =
  /^(?:approvals?|drafts?|queue|vip\s+(?:approvals?|queue))\s+(?:on|enable|enabled)$/i;
const APPROVALS_OFF_VERBS =
  /^(?:approvals?|drafts?|queue|vip\s+(?:approvals?|queue))\s+(?:off|disable|disabled)$/i;
// VIP list / clear management.
const VIP_LIST_VERBS = /^(?:vips?|list\s+vips?|show\s+vips?|who'?s\s+(?:a\s+)?vip)$/i;
const VIP_CLEAR_VERBS = /^(?:vips?\s+(?:clear|reset|none|empty)|clear\s+vips?|reset\s+vips?|remove\s+all\s+vips?)$/i;
// Escalation master switch — life-threat panic channels (push +
// voice + macOS notif). Primary alerts always fire regardless.
const ESCALATION_ON_VERBS =
  /^(?:escalations?|panic|sirens?)\s+(?:on|enable|enabled)$/i;
const ESCALATION_OFF_VERBS =
  /^(?:escalations?|panic|sirens?)\s+(?:off|disable|disabled|mute)$/i;
// Pushover channel toggle.
const PUSHOVER_ON_VERBS =
  /^(?:pushover|push)\s+(?:on|enable|enabled)$/i;
const PUSHOVER_OFF_VERBS =
  /^(?:pushover|push)\s+(?:off|disable|disabled|mute)$/i;

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

// Outbound-call NL forms. We accept these only when the message
// LOOKS like a call request — bare verbs like "call" misfire on
// conversational text ("can you call me back later?"), so we require
// a recognizable target word after the verb.
//
//   "lantern, call Madhu"
//   "call mom and tell her i'll be late"
//   "ring CVS to refill metformin"
//   "leave a voicemail for Sarika saying happy birthday"
//   "conference me with Manasa"
//   "get me on a call with Madhu"
//
// All forms return:
//   action:       "call-conference" | "call-voicemail" | "call-task"
//   callTarget:   the name or number after the verb
//   callMessage:  the spoken body (for voicemail/task)
//   callReason:   1-line context for risk-tier classifier
const CALL_CONFERENCE_RE =
  /^(?:lantern,?\s+)?(?:(?:get|put)\s+me\s+on\s+(?:a\s+)?(?:call|line)\s+with|conference\s+me\s+with|(?:three[-\s]?way|3[-\s]?way)\s+(?:me\s+)?with|bridge\s+me\s+with|connect\s+me\s+(?:with|to)|dial\s+me\s+in\s+with)\s+(\S.+)$/i;
const CALL_VOICEMAIL_RE =
  /^(?:lantern,?\s+)?leave\s+(?:a\s+)?(?:voice\s*mail|voicemail|message|note)\s+(?:for|to|with)\s+([\w'.\s+-]+?)\s+(?:saying|that\s+says|with|telling|that|—|-)\s+(.+)$/i;
const CALL_TASK_RE =
  /^(?:lantern,?\s+)?(?:call|ring|dial|phone)\s+([\w'.\s+-]+?)(?:\s+(?:and|to|about|for|regarding|saying|that|—|-)\s+(.+))?$/i;

function parseCallCommands(body: string): ParsedCommand | null {
  // Conference takes priority — most specific phrasing.
  const conf = body.match(CALL_CONFERENCE_RE);
  if (conf) {
    return {
      action: "call-conference",
      callTarget: conf[1].trim().replace(/[?.!,]+$/, ""),
      echo: `📞 conferencing you with ${conf[1].trim()}`,
      explicit: false,
    };
  }
  const vm = body.match(CALL_VOICEMAIL_RE);
  if (vm) {
    return {
      action: "call-voicemail",
      callTarget: vm[1].trim(),
      callMessage: vm[2].trim().replace(/^"|"$/g, ""),
      echo: `📞 voicemail for ${vm[1].trim()}: "${vm[2].trim().slice(0, 80)}"`,
      explicit: false,
    };
  }
  const task = body.match(CALL_TASK_RE);
  if (task) {
    const target = task[1].trim().replace(/[?.!,]+$/, "");
    // "call madhu" with no body → confer with them (they're a person).
    // "call cvs to refill" with a body → task. Heuristic: target is a
    // single proper noun (no spaces or short) → conference;
    // otherwise → task. Owner can override with explicit "conference".
    if (!task[2]) {
      return {
        action: "call-conference",
        callTarget: target,
        echo: `📞 conferencing you with ${target}`,
        explicit: false,
      };
    }
    return {
      action: "call-task",
      callTarget: target,
      callMessage: task[2].trim(),
      callReason: task[2].trim(),
      echo: `📞 calling ${target}: ${task[2].trim().slice(0, 80)}`,
      explicit: false,
    };
  }
  return null;
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

  // Call commands have their own dedicated parser (they need to
  // capture the target + message; the regex set is tuned to avoid
  // misfiring on conversational text). Run this BEFORE the generic
  // verb-prefix gate below since "call Madhu" is 2 words.
  const callCmd = parseCallCommands(raw);
  if (callCmd) return callCmd;

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
      /^(pause|mute|stop|off|hush|quiet|silence|sleep|resume|unmute|wake|on|status|ping|help|what'?s|how'?s|how\s+are|list|show|approvals?|drafts?|queue|vips?|clear|reset|who'?s|escalations?|panic|sirens?|pushover|push|call|ring|dial|phone|conference|voicemail|leave|get|put|bridge|connect)\b/i.test(raw);
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
  if (APPROVALS_ON_VERBS.test(body)) {
    return { action: "approvals-on", echo: "👁️ VIP + unfamiliar drafts will queue for your approval", explicit };
  }
  if (APPROVALS_OFF_VERBS.test(body)) {
    return { action: "approvals-off", echo: "🤐 VIPs go silent, unfamiliar contacts auto-reply", explicit };
  }
  if (VIP_CLEAR_VERBS.test(body)) {
    return { action: "vip-clear", echo: "🧹 cleared all VIPs", explicit };
  }
  if (VIP_LIST_VERBS.test(body)) {
    return { action: "vip-list", echo: "listing VIPs", explicit };
  }
  if (ESCALATION_ON_VERBS.test(body)) {
    return { action: "escalation-on", echo: "🚨 panic channels ENABLED (pushover + voice + macOS notif)", explicit };
  }
  if (ESCALATION_OFF_VERBS.test(body)) {
    return { action: "escalation-off", echo: "🔕 panic channels DISABLED — primary WA/iM/email still fire", explicit };
  }
  if (PUSHOVER_ON_VERBS.test(body)) {
    return { action: "pushover-on", echo: "📲 pushover siren ENABLED", explicit };
  }
  if (PUSHOVER_OFF_VERBS.test(body)) {
    return { action: "pushover-off", echo: "🔕 pushover siren DISABLED", explicit };
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
      case "approvals": case "drafts": case "queue": {
        const arg = (rest[0] || "").toLowerCase();
        if (arg === "on" || arg === "enable") return { action: "approvals-on", echo: "👁️ approval queue ENABLED", explicit };
        if (arg === "off" || arg === "disable") return { action: "approvals-off", echo: "🤐 approval queue DISABLED", explicit };
        return { action: "status", echo: "status (with approvals state)", explicit };
      }
      case "vip": case "vips": {
        const arg = (rest[0] || "").toLowerCase();
        if (arg === "clear" || arg === "reset" || arg === "empty") return { action: "vip-clear", echo: "🧹 cleared all VIPs", explicit };
        if (arg === "list" || arg === "" || arg === "show") return { action: "vip-list", echo: "listing VIPs", explicit };
        return { action: "vip-list", echo: "listing VIPs", explicit };
      }
      case "escalation": case "escalations": case "panic": case "siren": case "sirens": {
        const arg = (rest[0] || "").toLowerCase();
        if (arg === "on" || arg === "enable") return { action: "escalation-on", echo: "🚨 panic channels ENABLED", explicit };
        if (arg === "off" || arg === "disable") return { action: "escalation-off", echo: "🔕 panic channels DISABLED", explicit };
        return { action: "status", echo: "status (with escalation state)", explicit };
      }
      case "pushover": case "push": {
        const arg = (rest[0] || "").toLowerCase();
        if (arg === "on" || arg === "enable") return { action: "pushover-on", echo: "📲 pushover siren ENABLED", explicit };
        if (arg === "off" || arg === "disable") return { action: "pushover-off", echo: "🔕 pushover siren DISABLED", explicit };
        return { action: "status", echo: "status (with pushover state)", explicit };
      }
      case "call": case "ring": case "dial": case "phone": {
        // /lantern call <target> [reason...]
        // /lantern call-vm <target> | <message>
        // /lantern conference <target>
        const target = rest[0];
        if (!target) return { action: "help", echo: "usage: /lantern call <name>", explicit };
        const reason = rest.slice(1).join(" ");
        return reason
          ? { action: "call-task", callTarget: target, callMessage: reason, callReason: reason, echo: `📞 call ${target}`, explicit }
          : { action: "call-conference", callTarget: target, echo: `📞 conference with ${target}`, explicit };
      }
      case "conference": {
        const target = rest.join(" ").trim();
        if (!target) return { action: "help", echo: "usage: /lantern conference <name>", explicit };
        return { action: "call-conference", callTarget: target, echo: `📞 conference with ${target}`, explicit };
      }
      case "voicemail": case "vm": {
        // /lantern vm <target> | <message>
        const joined = rest.join(" ");
        const split = joined.indexOf("|");
        if (split === -1) return { action: "help", echo: "usage: /lantern vm <name> | <message>", explicit };
        const target = joined.slice(0, split).trim();
        const message = joined.slice(split + 1).trim();
        if (!target || !message) return { action: "help", echo: "usage: /lantern vm <name> | <message>", explicit };
        return { action: "call-voicemail", callTarget: target, callMessage: message, echo: `📞 voicemail for ${target}`, explicit };
      }
      case "killswitch": case "kill": {
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
    "*VIP + approval queue*",
    "• *approvals on* — VIPs + unfamiliar contacts queue drafts for your approval (instead of auto-reply)",
    "• *approvals off* — VIPs go silent, unfamiliar contacts auto-reply",
    "• *vips* / *list vips* — show your VIP list",
    "• *vips clear* — remove every VIP",
    "• tap ❤️ on a contact's message to mark them VIP; 🗑 to remove",
    "• `/lantern approvals on|off`, `/lantern vips clear` — slash forms",
    "",
    "*safety*",
    "• *kill switch on* — 🚨 emergency stop (mutes ALL bot activity until released)",
    "• *kill switch off* — release the kill switch",
    "• `/lantern killswitch on|off` — slash form",
    "",
    "*life-threat escalation channels*",
    "• *escalation on* / *escalation off* — master switch for panic channels (pushover + voice + macOS notif). Primary alerts (WA/iM/email) always fire regardless.",
    "• *pushover on* / *pushover off* — just the Pushover siren channel",
    "• `/lantern escalation on|off`, `/lantern pushover on|off` — slash forms",
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

// ── Presence / "I'm away" status ────────────────────────────────────
// Owner sets a timed, free-text status from self-chat so the bot can tell
// contacts where they are + offer to take a message. Returns null when the
// text isn't a presence command (caller falls through to normal handling).
type PresenceState = "busy" | "meeting" | "driving" | "dnd" | "sleep" | "free";

export type PresenceCommand =
  | { action: "set"; label: string; place?: string; durationMs?: number; state?: PresenceState; takeMessage?: boolean }
  | { action: "clear" };

// QUICK STATUS — natural one-liners the owner fires in self-chat so the bot can
// answer "did you eat?" / "are you home?" FACTUALLY instead of guessing. Each
// carries a smart default TTL (a meal is "just ate" for a few hours; sleep till
// morning) which an explicit "for 2h" / "until 5pm" overrides. Ordered most →
// least specific. takeMessage defaults true (offer to pass a message) except
// for transient states like "just ate" where the owner isn't really away.
const QUICK_STATUS: Array<{
  re: RegExp;
  label: string;
  state: PresenceState;
  ms: number;
  place?: string;
  takeMessage?: boolean;
}> = [
  { re: /\b(?:just ate|already ate|ate already|had (?:lunch|dinner|breakfast|food|my meal)|finished (?:lunch|dinner|eating|my meal|food)|done (?:eating|with lunch|with dinner))\b/i, label: "just ate", state: "free", ms: 3 * 3_600_000, takeMessage: false },
  { re: /\b(?:i'?m eating|having (?:lunch|dinner|breakfast|food|my meal)|at lunch|on (?:a )?lunch(?: break)?|eating (?:now|lunch|dinner))\b/i, label: "having food", state: "busy", ms: 60 * 60_000 },
  { re: /\b(?:heading home|on my way home|omw home|coming home|headed home|leaving (?:now|work|the office))\b/i, label: "heading home", state: "busy", ms: 60 * 60_000 },
  { re: /\b(?:reached home|back home|i'?m home(?:\s+now)?|at home now|home now|got home)\b/i, label: "home", state: "free", ms: 4 * 3_600_000, place: "home", takeMessage: false },
  { re: /\b(?:at the gym|hitting the gym|going to (?:the )?gym|gym now|working out|at (?:a )?workout)\b/i, label: "at the gym", state: "busy", ms: 2 * 3_600_000, place: "the gym" },
  { re: /\b(?:going to (?:bed|sleep)|i'?m sleeping|sleeping now|gonna crash|crashing (?:now|for the night)|off to bed|good\s?night|gn\b)\b/i, label: "asleep", state: "sleep", ms: 8 * 3_600_000 },
  { re: /\b(?:i'?m driving|on the road|in the car|commuting)\b/i, label: "driving", state: "driving", ms: 60 * 60_000 },
  { re: /\b(?:heads.?down|deep work|focusing|in the zone|can'?t talk(?:\s+now)?|busy right now)\b/i, label: "heads-down", state: "busy", ms: 2 * 3_600_000 },
];

const PRESENCE_CLEAR_RE =
  /^(?:lantern,?\s+)?(?:i'?m\s+back|back\s+now|status\s+off|clear\s+(?:my\s+)?status|i'?m\s+(?:free|available|around)|presence\s+off|status\s+clear)\s*[!.]?$/i;

// "I'm at the temple", "I'm in a meeting", "I'm driving", "set status: at the gym",
// "away: lunch", "status: at the dentist" — optionally "for 2h" / "until 5pm".
const PRESENCE_SET_RE =
  /^(?:lantern,?\s+)?(?:(?:set\s+)?status\s*[:=]\s*|away\s*[:=]\s*|presence\s*[:=]\s*|(?:i'?m|i\s+am|i'?ll\s+be|i\s+will\s+be)\s+(?:at\s+|in\s+|on\s+)?)(.+?)(?:\s+(?:for\s+(\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)|(?:until|till|til)\s+(.+?)))?\s*[!.]?$/i;

function parseDurationMs(num?: string, unit?: string, untilText?: string): number | undefined {
  if (num && unit) {
    const n = parseInt(num, 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return /^m/i.test(unit) ? n * 60_000 : n * 3_600_000;
  }
  if (untilText) {
    // "5pm", "5:30 pm", "17:00" — strip a trailing timezone token ("est"/
    // "pt"/"gmt"…) the user may tack on, so "7:30 pm est" still parses.
    const cleaned = untilText
      .trim()
      .replace(/\s+(?:e[sd]t|p[sd]t|c[sd]t|m[sd]t|gmt|utc|ist|[ecmp]t)\.?$/i, "")
      .trim();
    const m = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (m) {
      let hr = parseInt(m[1], 10);
      const min = m[2] ? parseInt(m[2], 10) : 0;
      const mer = m[3]?.toLowerCase();
      if (mer === "pm" && hr < 12) hr += 12;
      if (mer === "am" && hr === 12) hr = 0;
      const now = new Date();
      const target = new Date(now);
      target.setHours(hr, min, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1); // next occurrence
      return target.getTime() - now.getTime();
    }
  }
  return undefined;
}

export function parsePresenceCommand(input: string): PresenceCommand | null {
  const raw = (input || "").trim();
  if (!raw || raw.length > 160) return null;
  // A question is never a status the owner is SETTING ("are you home?").
  if (/\?/.test(raw)) return null;
  if (PRESENCE_CLEAR_RE.test(raw)) return { action: "clear" };

  // Quick status: natural phrases → label + state + smart TTL. An explicit
  // "for Xh" / "until Y" in the same message overrides the default duration.
  for (const q of QUICK_STATUS) {
    if (q.re.test(raw)) {
      const dm = raw.match(/\bfor\s+(\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i);
      const um = raw.match(/\b(?:until|till|til)\s+(.+?)\s*[!.]?$/i);
      const durationMs = dm
        ? parseDurationMs(dm[1], dm[2])
        : um
          ? parseDurationMs(undefined, undefined, um[1])
          : q.ms;
      return { action: "set", label: q.label, place: q.place, durationMs, state: q.state, takeMessage: q.takeMessage };
    }
  }

  const m = raw.match(PRESENCE_SET_RE);
  if (!m) return null;
  let label = (m[1] || "").trim().replace(/[?.!,]+$/, "");
  if (!label || label.length < 2) return null;
  // Reject obvious non-status sentences ("i'm at a loss", questions, etc.)
  if (/[?]/.test(raw)) return null;
  const durationMs = parseDurationMs(m[2], m[3], m[4]);
  // Derive a place from the label when it reads like a location.
  const placeMatch = label.match(/^(?:the\s+)?(.+)$/i);
  const place = placeMatch ? placeMatch[1] : undefined;
  // Normalize label into a natural "at the temple" / "in a meeting" phrasing.
  const lower = label.toLowerCase();
  const naturalLabel = /^(?:at|in|on)\b/.test(lower) || /meeting|driving|lunch|gym|busy|away|sleep/.test(lower)
    ? label
    : `at ${label}`;
  return { action: "set", label: naturalLabel, place, durationMs };
}
