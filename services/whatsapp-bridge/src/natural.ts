// Natural communication layer.
//
// Makes the agent's replies feel like a human texting, not a chatbot:
//
//   1. *Don't always reply.* Trivial inbound messages ("k", "ok", "👍",
//      pure-emoji reactions) get either silence or a tiny reaction —
//      replying with a full sentence is the most "bot-like" tell.
//
//   2. *Strip assistant-isms.* "Certainly!", "I'd be happy to help",
//      "Is there anything else I can do for you?" — all signature
//      ChatGPT phrasing. Remove or rewrite.
//
//   3. *Match the recipient's register.* Mostly-lowercase friend who
//      uses "u" and "lol" should not get back proper-cased paragraphs.
//
//   4. *Split long replies into burst messages.* WhatsApp humans send
//      2-3 short messages, not one wall of text.
//
//   5. *Pace it.* A 12-word reply takes a real person 3-4 seconds to
//      type. Replying in 200ms screams "bot". We send a presence
//      "composing" indicator first and delay each message by a duration
//      proportional to its length.
//
// This module is intentionally LLM-free — it operates on the inbound
// text and the draft the LLM produced. The LLM still does the heavy
// lifting via the system prompt in `agentPersonaPrompt`.

// Stop-words that, when they're the *entire* inbound message, suggest
// a reply is unnecessary. We respond either with silence or with a
// matching reaction. Bot-replies to these are the cringe-iest pattern.
const ACK_TOKENS = new Set([
  "k",
  "kk",
  "ok",
  "okay",
  "okk",
  "okie",
  "okies",
  "cool",
  "got it",
  "gotit",
  "got",
  "noted",
  "sure",
  "yep",
  "yup",
  "yeah",
  "ye",
  "thanks",
  "thx",
  "ty",
  "tysm",
  "thank you",
  "thank u",
  "thankyou",
  "ttyl",
  "bye",
  "byee",
  "see ya",
  "good night",
  "gn",
  "gm",
  "good morning",
  "lol",
  "lmao",
  "haha",
  "hahaha",
  "rofl",
]);

// Single-token reactions we can mirror — if they send 👍 we send 👍 back,
// which is way more human than typing "you're welcome!"
const REACTION_EMOJIS = new Set([
  "👍",
  "👌",
  "🙏",
  "❤️",
  "🔥",
  "💯",
  "😂",
  "🤣",
  "🙌",
  "👏",
]);

const EMOJI_RE = /\p{Extended_Pictographic}/u;

// Drops every emoji char and trims so we can check if a message is
// "just emojis". WhatsApp glues skin-tone modifiers, ZWJ joiners, etc.
// onto a base emoji; that's all extended-pictographic.
function stripEmoji(s: string): string {
  return s.replace(/\p{Extended_Pictographic}|️|‍|\s+/gu, "").trim();
}

function isJustEmoji(text: string): boolean {
  return EMOJI_RE.test(text) && stripEmoji(text) === "";
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[!?.,;…]+$/g, "");
}

// ---------------------------------------------------------------------------
// Should we even reply?
// ---------------------------------------------------------------------------

export type ShouldRespondVerdict =
  | { respond: true; reason: string }
  | { respond: false; reason: string; reaction?: string };

/**
 * Decide whether the agent should reply at all. Returns either
 *  - { respond: true }                — go ahead, run the LLM
 *  - { respond: false, reaction }     — send this emoji reaction instead
 *  - { respond: false }               — stay silent
 *
 * The bias is conservative: when in doubt, reply. We only suppress when
 * the inbound is *clearly* an ack/reaction that doesn't deserve a full
 * answer. Replying too rarely is creepier than replying too often.
 */
export function shouldRespond(text: string): ShouldRespondVerdict {
  const raw = text.trim();
  if (!raw) return { respond: false, reason: "empty" };

  // Single emoji → mirror it as a reaction.
  if (isJustEmoji(raw)) {
    if (REACTION_EMOJIS.has(raw)) {
      return { respond: false, reason: "ack_emoji", reaction: raw };
    }
    // Unfamiliar emoji — mirror back the heart, which is a safe ack.
    return { respond: false, reason: "ack_emoji", reaction: "❤️" };
  }

  // Pure-ack token, maybe with a trailing emoji, maybe punctuation only.
  const noEmoji = raw.replace(/\p{Extended_Pictographic}|️|‍/gu, "").trim();
  const norm = normalize(noEmoji);
  if (ACK_TOKENS.has(norm)) {
    return { respond: false, reason: "ack_token", reaction: "👍" };
  }

  return { respond: true, reason: "normal" };
}

// ---------------------------------------------------------------------------
// Style profile inferred from past inbound messages
// ---------------------------------------------------------------------------

export interface StyleProfile {
  formality: "casual" | "neutral" | "formal";
  avgWordsPerMessage: number;
  mostlyLowercase: boolean;
  usesEmojis: boolean;
  usesAbbreviations: boolean;
  minimalPunctuation: boolean;
}

const ABBREVIATIONS = new Set([
  "u",
  "ur",
  "lol",
  "btw",
  "tbh",
  "imo",
  "rn",
  "afaik",
  "ngl",
  "fyi",
  "idk",
  "imho",
  "dm",
  "btw",
]);

const FORMAL_TELLS = /\b(furthermore|moreover|sincerely|regards|nevertheless|hereby|therefore)\b/i;

export function inferStyle(messages: string[]): StyleProfile {
  if (messages.length === 0) {
    return {
      formality: "neutral",
      avgWordsPerMessage: 8,
      mostlyLowercase: false,
      usesEmojis: false,
      usesAbbreviations: false,
      minimalPunctuation: false,
    };
  }
  let totalWords = 0;
  let lowercaseHits = 0;
  let emojiHits = 0;
  let abbrevHits = 0;
  let punctuationLines = 0;
  let formalHits = 0;
  for (const m of messages) {
    const trimmed = m.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/);
    totalWords += words.length;
    // "Mostly lowercase" means the first alpha char is lowercase OR
    // the whole message has no uppercase letters at all.
    const firstAlpha = trimmed.match(/[A-Za-z]/);
    if (firstAlpha && firstAlpha[0] === firstAlpha[0].toLowerCase()) {
      lowercaseHits++;
    }
    if (EMOJI_RE.test(trimmed)) emojiHits++;
    for (const w of words) {
      if (ABBREVIATIONS.has(w.toLowerCase().replace(/[^a-z]/g, ""))) {
        abbrevHits++;
        break;
      }
    }
    if (/[.!?,]/.test(trimmed)) punctuationLines++;
    if (FORMAL_TELLS.test(trimmed)) formalHits++;
  }
  const n = messages.length;
  const avgWords = totalWords / Math.max(1, n);
  const lowerRatio = lowercaseHits / n;
  const emojiRatio = emojiHits / n;
  const abbrevRatio = abbrevHits / n;
  const puncRatio = punctuationLines / n;
  const formalRatio = formalHits / n;

  let formality: StyleProfile["formality"] = "neutral";
  if (formalRatio > 0.1 || (puncRatio > 0.8 && lowerRatio < 0.2)) {
    formality = "formal";
  } else if (lowerRatio > 0.5 || abbrevRatio > 0.2 || emojiRatio > 0.4) {
    formality = "casual";
  }

  return {
    formality,
    avgWordsPerMessage: Math.round(avgWords),
    mostlyLowercase: lowerRatio > 0.5,
    usesEmojis: emojiRatio > 0.2,
    usesAbbreviations: abbrevRatio > 0.15,
    minimalPunctuation: puncRatio < 0.5,
  };
}

// ---------------------------------------------------------------------------
// System prompt — instructs the LLM to text, not assist
// ---------------------------------------------------------------------------

/**
 * Builds the persona instruction injected at the *start* of each LLM
 * turn. The owner name is interpolated so the agent thinks of itself as
 * the owner texting back, not as "Lantern Assistant".
 *
 * Style hints from the recent thread are concatenated as plain-English
 * cues. We deliberately don't ask the LLM to copy the contact's voice
 * verbatim — that's creepy and breaks under mixed registers. We just
 * tell it the conversational register so it doesn't pivot to corporate.
 */
export interface PersonaOptions {
  // Last N messages the owner ACTUALLY sent this contact. Used as
  // few-shot exemplars so the LLM matches their real voice instead of
  // a generic "casual texter". Capped to a small handful so the prompt
  // stays compact.
  ownerSamples?: string[];
  // True once the bridge has sent the one-line handoff disclosure on
  // this thread. When disclosed, the persona allows soft self-identification
  // ("the assistant") and drops the strict impersonation rules.
  disclosed?: boolean;
  // Per-agent style override (the "my voice" textarea on the agent detail
  // page). Concatenated verbatim at the end of the persona — power-user
  // hand-tuning beats inferred cues.
  stylePrompt?: string;
}

export function agentPersonaPrompt(
  ownerName: string,
  style: StyleProfile,
  isGroup: boolean,
  opts: PersonaOptions = {}
): string {
  const cues: string[] = [];
  if (style.formality === "casual") {
    cues.push("the conversation is casual — match that.");
  } else if (style.formality === "formal") {
    cues.push("the conversation is more formal — match that.");
  }
  if (style.mostlyLowercase) cues.push("they mostly type lowercase, you can too.");
  if (style.usesAbbreviations) cues.push("abbreviations like 'u', 'btw', 'lol' are fine here.");
  if (style.usesEmojis) cues.push("emoji are welcome.");
  if (style.minimalPunctuation) cues.push("minimal punctuation; no need to end every line with a period.");
  if (style.avgWordsPerMessage <= 6) {
    cues.push("they send very short messages — keep replies short too, often one line.");
  }

  const intro = opts.disclosed
    ? `You are ${ownerName}'s assistant texting on WhatsApp. The contact has already been told you're an assistant covering for ${ownerName}, so don't impersonate them — but match their tone exactly so the thread reads naturally.`
    : `You are texting on WhatsApp AS ${ownerName}. Sound exactly like a real person texting, not like a chatbot. Default to first person ("I", "me"). Do NOT announce that you're an assistant, AI, or anything unusual — the contact thinks they're texting ${ownerName} and that should keep being true unless they directly question it.`;

  // Non-disclosed mode now allows a SOFT, casual acknowledgement when the
  // contact directly asks if it's really ${ownerName} or if it's a bot —
  // a formal "I am X's assistant" reads like spam; a natural "yeah just
  // helping out, will loop them in" feels human and honest.
  const identityRule = opts.disclosed
    ? `- You may say "I'm ${ownerName}'s assistant" if asked directly. Otherwise don't bring it up.`
    : `- Do NOT proactively identify as an AI, assistant, bot, or language model.\n- ONLY if the contact directly asks "is this you / is this a bot / am i talking to ${ownerName}", reply naturally and briefly — e.g. "yeah just helping ${ownerName} stay on top of things, they'll see this", "no it's their helper covering while they're heads-down, will loop them in". Never use the words "AI", "assistant" (use "helper"), "bot", "language model".`;

  const lines: string[] = [
    intro,
    ``,
    `Hard rules — non-negotiable:`,
    identityRule,
    `- Never apologize for being slow, being an AI, or being a bot.`,
    `- Never say "How can I help you today?", "I'd be happy to assist", "Certainly!", "Of course!", "Great question", "Let me know if you need anything else", or anything that signals customer service.`,
    `- Plain text only. No markdown, no bullets, no headers, no em-dashes (—). This is a text message, not a Notion page.`,
    `- Keep replies SHORT. Default to one line, under 15 words. Two lines only when the question genuinely needs it.`,
    `- Single-word replies are fine ("yeah", "ok", "true", "lol").`,
    `- Use contractions ("I'll", "can't", "don't", "won't"). Not "I will" / "cannot".`,
    `- Don't end every line with a period.`,
    `- When you don't know, say "not sure" or "lemme check" — don't invent.`,
    `- Skip greetings and signoffs unless the contact opens with one. No "Hi!" no "Best,".`,
    `- ${isGroup ? "You are in a group chat — be brief and only reply when directly addressed." : "This is a 1-on-1 thread."}`,
    ``,
    `Inferred style for this thread:`,
    ...(cues.length > 0 ? cues.map((c) => `- ${c}`) : ["- no strong signal yet — keep it neutral and casual."]),
  ];

  const samples = (opts.ownerSamples ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 280)
    .slice(-8);
  if (samples.length > 0) {
    lines.push(``);
    lines.push(`Examples of how ${ownerName} actually writes (match this voice — length, casing, vocabulary, punctuation):`);
    for (const s of samples) lines.push(`> ${s}`);
  }

  const override = opts.stylePrompt?.trim();
  if (override) {
    lines.push(``);
    lines.push(`Style overrides (these take precedence over the rules above):`);
    lines.push(override);
  }

  lines.push(``);
  lines.push(
    opts.disclosed
      ? `Reply in plain text, in ${ownerName}'s voice, no preface, no signature.`
      : `Reply as ${ownerName}, in plain text, no quoting, no preface.`
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Naturalize a draft reply: clean, split, pace
// ---------------------------------------------------------------------------

export interface NaturalMessage {
  text: string;
  // Delay before sending this message. The first message includes the
  // "read + think" lag; subsequent messages get a shorter inter-message
  // pause to simulate a real burst.
  delayBeforeMs: number;
  // How long the typing indicator should be on before the message lands.
  // Capped so we don't make recipients wait forever.
  typingMs: number;
}

const ASSISTANT_OPENERS = [
  /^certainly[!,]?\s+/i,
  /^of course[!,]?\s+/i,
  /^absolutely[!,]?\s+/i,
  /^great question[!,]?\s+/i,
  /^happy to help[!,]?\s+/i,
  /^sure thing[!,]?\s+/i,
  /^as an ai[^.]*\.\s*/i,
  /^as a language model[^.]*\.\s*/i,
];

const ASSISTANT_CLOSERS = [
  /\s*let me know if (?:you (?:need|have) anything else|i can help with anything else)[.!?]*\s*$/i,
  /\s*is there anything else (?:you'd like|i can help with)[.!?]*\s*$/i,
  /\s*hope (?:this|that) helps[.!?]*\s*$/i,
  /\s*feel free to (?:ask|reach out)[^.]*[.!?]*\s*$/i,
];

function stripAssistantisms(text: string): string {
  let out = text;
  for (const re of ASSISTANT_OPENERS) out = out.replace(re, "");
  for (const re of ASSISTANT_CLOSERS) out = out.replace(re, "");
  // Drop opening "Sorry," apologies that aren't actually apologetic.
  out = out.replace(/^(I'm sorry|Sorry)[,!]?\s+but\s+/i, "");
  return out.trim();
}

function applyStyle(text: string, style: StyleProfile): string {
  let out = text;
  if (style.mostlyLowercase) {
    // Don't down-case proper nouns blindly; just down-case the first
    // letter of each sentence. That alone is the strongest "casual" tell.
    out = out.replace(/(^|[.!?]\s+)([A-Z])/g, (_m, lead, ch) => lead + ch.toLowerCase());
  }
  if (style.minimalPunctuation) {
    // Drop a single trailing period on each message; humans rarely use them.
    out = out.replace(/([^.!?])\.(\s|$)/g, "$1$2");
    out = out.replace(/\.$/, "");
  }
  return out;
}

// Split a long reply into up to 3 messages on sentence boundaries.
// Heuristic: aim for ~80-120 char chunks; never split mid-clause.
function splitIntoMessages(text: string, style: StyleProfile): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  // Don't split short replies.
  if (cleaned.length < 120) return [cleaned];

  // Split on sentence endings, keeping the punctuation with the previous half.
  const parts = cleaned.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return [cleaned];

  // Greedy pack into ~120 char chunks; cap at 3 messages.
  const target = style.avgWordsPerMessage > 12 ? 180 : 120;
  const maxMessages = 3;
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (!cur) {
      cur = p;
      continue;
    }
    if ((cur + " " + p).length <= target && out.length + 1 < maxMessages) {
      cur += " " + p;
    } else {
      out.push(cur);
      cur = p;
    }
    if (out.length >= maxMessages - 1) {
      // Stuff everything remaining into the last bucket so we don't drop content.
      const remaining = parts.slice(parts.indexOf(p) + 1).join(" ");
      if (remaining) cur += " " + remaining;
      break;
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, maxMessages);
}

// Approx 4 chars per word; ~50 wpm typing → ~250ms per word. We jitter
// a bit to avoid mechanical-looking exact intervals.
function typingDurationMs(text: string): number {
  const words = Math.max(1, text.split(/\s+/).length);
  const base = words * 240;
  const jitter = (Math.random() - 0.5) * 200;
  return Math.max(700, Math.min(7000, Math.round(base + jitter)));
}

// "Read time" before the first message — the lag between receiving an
// inbound and starting to type. Short inbounds get short lags.
function readDelayMs(inbound: string): number {
  const words = Math.max(1, inbound.split(/\s+/).length);
  const base = 600 + words * 80;
  const jitter = (Math.random() - 0.5) * 400;
  return Math.max(400, Math.min(4500, Math.round(base + jitter)));
}

// Inter-message pause — how long between burst messages. ~300-700ms.
function gapMs(): number {
  return 350 + Math.round(Math.random() * 350);
}

/**
 * Take a raw LLM draft + inbound context + style, and produce the burst
 * of paced messages the bridge should actually send. The output is what
 * `handleAgentReply` iterates over.
 */
export function naturalize(
  draft: string,
  opts: { inbound: string; style: StyleProfile }
): NaturalMessage[] {
  const stripped = stripAssistantisms(draft);
  if (!stripped) return [];
  const pieces = splitIntoMessages(stripped, opts.style).map((m) =>
    applyStyle(m, opts.style)
  );
  return pieces.map((text, idx) => ({
    text,
    delayBeforeMs: idx === 0 ? readDelayMs(opts.inbound) : gapMs(),
    typingMs: typingDurationMs(text),
  }));
}
