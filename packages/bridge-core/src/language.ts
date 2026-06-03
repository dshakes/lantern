// Language detector for inbound messages.
//
// Goal: when a contact pings the owner in a language other than English,
// the bot should reply in the same language with the same dialect.
// Many South-Asian languages get sent as Romanized Latin script ("ela
// undi", "kya kar rahe ho") mixed with native script ("వాళ్లు ఏం
// చేస్తున్నారు"), so we can't just look at Unicode ranges.
//
// The detector returns a compact LanguageHint that the persona prompt
// builder uses to nudge the LLM. We do NOT translate; the LLM is
// multilingual.
//
// Generic by design: the Telugu lexicon is one of N — add more (Hindi,
// Tamil, Spanish, etc.) by appending to LEX. The user's own profile
// (~/.lantern/owner-profile.md) can list their nativity to bias which
// dialect the LLM uses when responding.

export type DetectedLanguage =
  | "english"
  | "telugu"
  | "hindi"
  | "tamil"
  | "kannada"
  | "malayalam"
  | "marathi"
  | "bengali"
  | "gujarati"
  | "punjabi"
  | "spanish"
  | "french"
  | "german"
  | "unknown";

export interface LanguageHint {
  /** Primary detected language; "english" when no strong signal. */
  primary: DetectedLanguage;
  /** True if the message contains the language's native script. */
  hasNativeScript: boolean;
  /** True if the message contains Romanized (Latin-script) form of the
   *  language with high-confidence tokens. */
  hasRomanized: boolean;
  /** True if the message mixes English + a non-English language. */
  mixed: boolean;
  /** Lowercase confidence (0..1). >0.6 → strong signal; <0.3 → keep
   *  English as default. */
  confidence: number;
}

// Native-script Unicode ranges per language. These are exact ISO ranges.
const SCRIPTS: Array<{ lang: DetectedLanguage; ranges: Array<[number, number]> }> = [
  { lang: "telugu",    ranges: [[0x0C00, 0x0C7F]] },
  { lang: "hindi",     ranges: [[0x0900, 0x097F]] }, // Devanagari (also Marathi)
  { lang: "tamil",     ranges: [[0x0B80, 0x0BFF]] },
  { lang: "kannada",   ranges: [[0x0C80, 0x0CFF]] },
  { lang: "malayalam", ranges: [[0x0D00, 0x0D7F]] },
  { lang: "bengali",   ranges: [[0x0980, 0x09FF]] },
  { lang: "gujarati",  ranges: [[0x0A80, 0x0AFF]] },
  { lang: "punjabi",   ranges: [[0x0A00, 0x0A7F]] },
];

// High-confidence Romanized lexicon. Each entry: a word that almost
// never appears in English text but is very common in the source
// language. Greetings, kinship terms, common verbs, particles.
//
// Tuned for false-negative AVOIDANCE (better to over-detect Telugu
// than miss it; the LLM falls back to English gracefully on a
// borderline call).
const LEX: Record<DetectedLanguage, string[]> = {
  english: [],
  telugu: [
    // Greetings + acks
    "namaste", "namaskaram", "vandanam", "alaiya", "alaina",
    // Kinship (Telangana dialect)
    "anna", "akka", "vadina", "bava", "mama", "atta", "ammama", "nanna",
    "amma", "tammudu", "chelli", "bidda", "buddi", "babai", "pinni",
    // Common pronouns / particles
    "naaku", "neeku", "vaaru", "vaadu", "vaadi", "vaaru", "memu", "manchi",
    "okati", "rendu", "moodu", "naalugu",
    // Telangana verbs / phrases — give-away tokens
    "ela", "undi", "undav", "undadu", "undali", "untava",
    "em", "emi", "enti", "endi", "endhi", "edhi", "evaru", "evarini",
    "chestunnav", "chesthunnav", "chestunnaru", "chesinav", "chesthunnaru",
    "veluthunnav", "vellindu", "ostunnav", "ostunnaru", "vacchinaru",
    "vachhinaru", "vacchav", "vachav", "vachindi", "vachindu",
    "thinnav", "tinnav", "tindav", "tinnara", "thinnara",
    "cheppu", "chepa", "cheppara", "cheppadu", "cheppindi",
    "vellipoyamu", "vellipothunna", "ostara", "ostam",
    "eppudu", "eppudostunnaru", "eppudostunnav", "eppudostara",
    "repu", "monna", "nedu", "ela", "ledu", "leru", "lev", "ledhu",
    "tappakunda", "tarvata", "appudu", "ikkada", "akkada", "ekkada",
    // Telangana flavor particles
    "ra", "ro", "vora", "ay", "ayya", "amma",
    // Numbers/units commonly mixed in
    "ipudu", "ipuduu", "innaalla", "innallu", "appudo", "edaina",
  ],
  hindi: [
    "kya", "hai", "ho", "mein", "main", "hum", "tum", "aap", "yaar",
    "kar", "rahe", "raha", "rahi", "kaisa", "kaisi", "kaise",
    "achha", "thik", "theek", "haan", "nahi", "nahin", "abhi", "kab",
    "kahan", "kyun", "kyu", "mujhe", "tujhe", "namaste", "shukriya",
    "matlab", "bhai", "bhaiya", "didi", "papa", "mummy", "chal", "chalo",
    "milte", "milenge", "milna", "kal", "aaj", "subah", "shaam",
  ],
  tamil: [
    "vanakkam", "epdi", "epdi", "iruka", "irukku", "irukkay", "iruken",
    "neenga", "naan", "naa", "ena", "yenna", "anna", "akka", "tata",
    "thambi", "thangachi", "amma", "appa", "machaan",
    "varum", "vandhutu", "varuven", "ponen", "poiten",
  ],
  kannada: [
    "namaskara", "nimage", "nanage", "yaru", "yaake", "yenu", "yelli",
    "irutte", "irutaai", "anna", "akka", "appa", "amma", "thangi",
    "barthini", "barthidhini", "hogthini",
  ],
  malayalam: [
    "namaskaram", "ningal", "njan", "enthu", "evide", "engane", "epol",
    "vannu", "pokum", "irikum", "chetan", "chechi", "amma", "achan",
  ],
  marathi: [
    "namaskar", "kasa", "kashi", "ahes", "ahe", "ahet", "kuthe", "kay",
    "mi", "tu", "amhi", "tumhi", "aai", "baba", "dada", "tai",
  ],
  bengali: [
    "ami", "tumi", "apni", "ki", "kemon", "acho", "achen", "kothay",
    "kobe", "ekhon", "boudi", "dada", "didi", "baba", "ma",
  ],
  gujarati: [
    "kem", "chho", "che", "tame", "hu", "amne", "tamne", "shu",
    "kyaan", "kyaare", "ben", "bhai", "mummy", "pappa",
  ],
  punjabi: [
    "sat sri akal", "tussi", "tuhada", "tuhanu", "asi", "saadi",
    "ki", "haal", "veer", "paaji", "bhabhi", "biji",
  ],
  spanish: [
    "hola", "como", "estas", "estoy", "soy", "tu", "yo", "ella", "el",
    "donde", "cuando", "porque", "que", "muy", "bien", "mal", "amigo",
    "hermano", "hermana", "mama", "papa", "buenos", "dias", "tarde", "noche",
    "gracias", "por", "favor", "claro", "vale",
  ],
  french: [
    "bonjour", "salut", "merci", "oui", "non", "comment", "ca", "va",
    "tres", "bien", "mon", "ma", "frere", "soeur", "papa", "maman",
    "ou", "quand", "pourquoi", "qu'est", "ce", "que", "je", "tu", "vous",
  ],
  german: [
    "hallo", "guten", "tag", "morgen", "abend", "wie", "geht", "es", "dir",
    "danke", "bitte", "ja", "nein", "ich", "du", "wir", "ihr",
    "bruder", "schwester", "mutter", "vater",
  ],
  unknown: [],
};

// Frozen lookup tables for fast scoring.
const LEX_SET: Map<DetectedLanguage, Set<string>> = new Map();
for (const [lang, words] of Object.entries(LEX) as Array<[DetectedLanguage, string[]]>) {
  LEX_SET.set(lang, new Set(words.map((w) => w.toLowerCase())));
}

function hasScript(text: string, ranges: Array<[number, number]>): boolean {
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp === undefined) continue;
    for (const [lo, hi] of ranges) {
      if (cp >= lo && cp <= hi) return true;
    }
  }
  return false;
}

function countScriptChars(text: string, ranges: Array<[number, number]>): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp === undefined) continue;
    for (const [lo, hi] of ranges) {
      if (cp >= lo && cp <= hi) { n++; break; }
    }
  }
  return n;
}

export function detectLanguageHints(text: string): LanguageHint {
  const t = (text || "").trim();
  if (t.length === 0) {
    return { primary: "english", hasNativeScript: false, hasRomanized: false, mixed: false, confidence: 0 };
  }

  // 1. Native-script scan. If we hit native characters, that's a very
  //    strong signal — return immediately at high confidence.
  let scriptHit: DetectedLanguage | null = null;
  let scriptChars = 0;
  for (const { lang, ranges } of SCRIPTS) {
    if (hasScript(t, ranges)) {
      const n = countScriptChars(t, ranges);
      if (n > scriptChars) { scriptHit = lang; scriptChars = n; }
    }
  }

  // 2. Romanized lexicon scan. Tokenize on whitespace/punct and
  //    count hits per language.
  const tokens = t.toLowerCase().split(/[\s,.!?;:()'"—–\-]+/).filter(Boolean);
  let bestLang: DetectedLanguage = "english";
  let bestHits = 0;
  for (const [lang, set] of LEX_SET) {
    if (lang === "english") continue;
    let hits = 0;
    for (const tok of tokens) {
      if (set.has(tok)) hits++;
    }
    if (hits > bestHits) { bestHits = hits; bestLang = lang; }
  }

  // 3. Combine signals.
  const hasNativeScript = scriptHit !== null;
  const hasRomanized = bestHits > 0;
  // English presence: any token that's an obvious English word.
  const englishMarkers = new Set([
    "the", "and", "you", "are", "for", "with", "this", "that", "have", "what",
    "when", "where", "why", "how", "can", "will", "would", "could", "should",
    "i'm", "im", "i", "me", "my", "your", "their", "we", "us",
  ]);
  let englishHits = 0;
  for (const tok of tokens) {
    if (englishMarkers.has(tok)) englishHits++;
  }

  // Decision tree:
  //   - Native script wins (devanagari/telugu/etc.) — primary = scriptHit.
  //   - Otherwise lexicon hits win when >= 1 token AND english hits don't dominate.
  //   - mixed = native or romanized hit ≥ 1 AND english hits ≥ 2.
  let primary: DetectedLanguage = "english";
  let confidence = 0;
  if (scriptHit) {
    primary = scriptHit;
    // Strong: 1 native char is enough, more increases confidence.
    confidence = Math.min(1, 0.7 + scriptChars * 0.05);
  } else if (bestHits >= 1) {
    primary = bestLang;
    // Romanized: weight by token ratio.
    const ratio = bestHits / Math.max(1, tokens.length);
    confidence = Math.min(0.95, 0.4 + ratio * 1.5);
  }
  const mixed = (hasNativeScript || hasRomanized) && englishHits >= 2;

  return { primary, hasNativeScript, hasRomanized, mixed, confidence };
}

/** Map a detected language → human-readable guidance for the LLM
 *  persona prompt. Returns "" for English (no extra guidance needed).
 *
 *  IMPORTANT: vocabulary preferences (specific words the owner avoids
 *  or prefers in this language) live in the owner profile's
 *  "## Nativity" section and are surfaced via the `Who you are` block.
 *  This modality block tells the LLM to CONSULT that profile for
 *  style — so individual quirks (e.g. "I never use the 'ra' particle
 *  in Telugu") propagate without us having to hard-code them per
 *  language here. */
export function languageModalityHint(hint: LanguageHint, opts: { nativity?: string } = {}): string {
  if (hint.primary === "english" || hint.confidence < 0.4) return "";
  const langName: Record<DetectedLanguage, string> = {
    english: "English",
    telugu: "Telugu",
    hindi: "Hindi",
    tamil: "Tamil",
    kannada: "Kannada",
    malayalam: "Malayalam",
    marathi: "Marathi",
    bengali: "Bengali",
    gujarati: "Gujarati",
    punjabi: "Punjabi",
    spanish: "Spanish",
    french: "French",
    german: "German",
    unknown: "their language",
  };
  const lang = langName[hint.primary];
  const scriptNote = hint.hasNativeScript && hint.hasRomanized
    ? "mix of native script + Romanized"
    : hint.hasNativeScript
      ? "native script"
      : "Romanized (Latin) script";

  const lines: string[] = [];
  lines.push(`## Language modality`);
  lines.push(`The inbound message is in **${lang}** (${scriptNote}). Reply in the SAME language and SAME script style they used — if they wrote Romanized, you write Romanized; if they wrote native script, you mix accordingly. Match their dialect / regional flavor naturally, the way ${opts.nativity ? `someone from ${opts.nativity}` : "a native speaker"} would.`);
  if (opts.nativity) {
    lines.push(`Owner nativity: ${opts.nativity}. Use the regional dialect and vocabulary natural to that place. Don't sound textbook — sound like a real person from there.`);
  }
  if (hint.mixed) {
    lines.push(`The user code-switched between English and ${lang}. Same — code-switch the same way they do.`);
  }
  // Always-on reminder: the owner's profile (above in this prompt)
  // may include specific vocabulary preferences for THIS language
  // (words to use, particles to avoid, etc.). Honor them strictly —
  // they encode personal style that no generic dialect rule captures.
  lines.push(`Honor any vocabulary preferences from the owner profile above — specific words/particles they prefer or avoid take precedence over generic dialect norms. If the profile says "never use X", DO NOT use X.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Voice-note transcription language biasing.
//
// Whisper auto-detects the spoken language. For low-resource South-Asian
// languages it frequently misdetects — Telangana Telugu speech routinely
// comes back transcribed in KANNADA script (adjacent Dravidian language,
// overlapping phonemes). The fix is to pass an explicit `language` ISO
// code + a script-priming `prompt` so Whisper decodes into the right
// language instead of guessing.
// ---------------------------------------------------------------------------

// ISO-639-1 code per detected language. Whisper accepts these as its
// `language` parameter. "english" maps to "en" but we never bias toward
// English (auto-detect is reliable for English) — callers treat "" /
// "auto" as "let Whisper decide".
const ISO_639_1: Partial<Record<DetectedLanguage, string>> = {
  english: "en",
  telugu: "te",
  hindi: "hi",
  tamil: "ta",
  kannada: "kn",
  malayalam: "ml",
  marathi: "mr",
  bengali: "bn",
  gujarati: "gu",
  punjabi: "pa",
  spanish: "es",
  french: "fr",
  german: "de",
};

// A short native-script + Romanized priming sentence per language. Whisper
// uses `prompt` as a decoding hint: priming with the target script strongly
// biases the output toward that script and away from a phonetically-adjacent
// one (the Telugu→Kannada failure mode). Kept short — Whisper only reads the
// last ~224 tokens of the prompt.
const WHISPER_PRIME: Partial<Record<DetectedLanguage, string>> = {
  telugu: "ఇది తెలుగు సంభాషణ. Telugu conversation, Telangana dialect.",
  hindi: "यह हिंदी बातचीत है. Hindi conversation.",
  tamil: "இது தமிழ் உரையாடல். Tamil conversation.",
  kannada: "ಇದು ಕನ್ನಡ ಸಂಭಾಷಣೆ. Kannada conversation.",
  malayalam: "ഇത് മലയാളം സംഭാഷണമാണ്. Malayalam conversation.",
  marathi: "ही मराठी संभाषण आहे. Marathi conversation.",
  bengali: "এটি একটি বাংলা কথোপকথন। Bengali conversation.",
  gujarati: "આ ગુજરાતી વાતચીત છે. Gujarati conversation.",
  punjabi: "ਇਹ ਪੰਜਾਬੀ ਗੱਲਬਾਤ ਹੈ। Punjabi conversation.",
};

export interface VoiceLangHint {
  /** ISO-639-1 language to pass to Whisper, or "" to let it auto-detect. */
  iso: string;
  /** Optional script-priming prompt to bias the decoder, or "". */
  prompt: string;
  /** The resolved DetectedLanguage (for the garbled-output script check). */
  lang: DetectedLanguage;
}

// Normalize an env / profile value to a DetectedLanguage. Accepts ISO
// codes ("te"), English names ("telugu", "Telugu"), or "auto".
//   - ""/whitespace → "unset" (caller falls through to nativity/default)
//   - "auto"        → explicit auto-detect (caller disables biasing)
//   - known lang    → that DetectedLanguage
//   - unrecognized  → null (caller falls through)
function normalizeLangToken(raw: string): DetectedLanguage | "auto" | "unset" | null {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return "unset";
  if (v === "auto") return "auto";
  for (const [lang, iso] of Object.entries(ISO_639_1) as Array<[DetectedLanguage, string]>) {
    if (v === iso || v === lang) return lang;
  }
  return null;
}

/** Resolve the Whisper language bias for a voice note.
 *
 *  Precedence: explicit `LANTERN_VOICE_LANG` env (an ISO code, a language
 *  name, or "auto") → owner-profile nativity text → default Telugu (this
 *  deployment's owner speaks Telangana Telugu).
 *
 *  CRITICAL — we only ever send an explicit `iso` (Whisper's `language`
 *  param) when the OWNER set `LANTERN_VOICE_LANG` to a real ISO code. The
 *  Whisper API rejects some valid ISO codes (notably "te"/Telugu) with a
 *  400 `unsupported_language`, which used to kill the whole transcription →
 *  the contact got dead silence. So out of the box we run AUTO-DETECT
 *  (iso = "") and rely purely on the script-priming `prompt` to bias the
 *  decoder toward the right script. The `lang` field still carries the
 *  expected language so `looksGarbledTranscript` can flag a wrong-script
 *  mis-decode. Auto-detect + a Telugu-script prompt = no 400, correct
 *  script bias.
 *
 *  `nativity` is the owner-profile nativity line (e.g. "Hyderabad,
 *  Telangana — Telugu"); we scan it for a known language name so the
 *  prompt follows the profile without extra config. */
export function voiceTranscriptionLangHint(opts: { nativity?: string } = {}): VoiceLangHint {
  const none: VoiceLangHint = { iso: "", prompt: "", lang: "english" };

  // 1. Explicit env override. "auto" disables biasing; a known language
  //    wins (and ONLY here do we force an explicit `iso`); unset/empty/
  //    unrecognized falls through to nativity/default.
  const envRaw = (typeof process !== "undefined" && process.env?.LANTERN_VOICE_LANG) || "";
  const envTok = normalizeLangToken(envRaw);
  if (envTok === "auto") return none;
  if (envTok && envTok !== "unset" && envTok !== "english") {
    return { iso: ISO_639_1[envTok] ?? "", prompt: WHISPER_PRIME[envTok] ?? "", lang: envTok };
  }

  // 2. Owner-profile nativity — find the first language name mentioned.
  //    Auto-detect (iso = "") + the language's script-priming prompt.
  const nat = (opts.nativity || "").toLowerCase();
  if (nat) {
    for (const lang of Object.keys(ISO_639_1) as DetectedLanguage[]) {
      if (lang === "english") continue;
      if (nat.includes(lang)) {
        return { iso: "", prompt: WHISPER_PRIME[lang] ?? "", lang };
      }
    }
  }

  // 3. Default for this deployment: Telugu — auto-detect + Telugu-script
  //    prompt (NOT a forced "te" `language`, which Whisper 400s on).
  return { iso: "", prompt: WHISPER_PRIME.telugu ?? "", lang: "telugu" };
}

// ---------------------------------------------------------------------------
// Degraded voice-note handling.
//
// When a voice note can't be understood (mis-decoded script, empty/garbled
// transcript, transcription proxy unavailable) the bridge must NOT feed a
// placeholder to the LLM — the model emits a "your transcription is garbled"
// meta-reply that the bot-tell filter then suppresses, leaving the contact in
// DEAD SILENCE. Instead we short-circuit before the LLM and send a brief,
// warm, human ack in the owner's voice. NEVER let a voice note end in silence.
// ---------------------------------------------------------------------------

/** A voice-note MediaAnnotation shape (the subset this module reasons about).
 *  Both bridges' MediaAnnotation are structurally compatible with this. */
export interface VoiceNoteOutcome {
  ok: boolean;
  kind: string;
  degraded?: boolean;
  syntheticText?: string;
}

/** Decide whether a voice-note annotation must short-circuit to a human ack
 *  (true) instead of flowing into the LLM as a real inbound message.
 *
 *  Short-circuit when it's a voice note AND either:
 *    - it was explicitly marked `degraded` (mis-decoded / unavailable), or
 *    - it produced no usable `syntheticText` (empty / whitespace), or
 *    - the `syntheticText` is a bracketed `[…]` placeholder rather than a
 *      real transcript (defensive: any leftover placeholder must never reach
 *      the LLM as if the contact had typed it).
 *
 *  A clean transcript (`[voice note transcribed] …`) is NOT short-circuited —
 *  that prefix is stripped downstream and the real words flow to the LLM. */
export function shouldShortCircuitVoiceNote(a: VoiceNoteOutcome): boolean {
  if (a.kind !== "voice") return false;
  if (a.degraded) return true;
  const t = (a.syntheticText || "").trim();
  if (!t) return true;
  // A real transcript is carried as "[voice note transcribed] <words>".
  // Anything else that is a pure bracketed placeholder (e.g.
  // "[voice note — transcription unavailable]") must not reach the LLM.
  if (/^\[voice note transcribed\]/i.test(t)) return false;
  if (/^\[[^\]]*\]$/.test(t)) return true;
  return false;
}

/** The warm human ack sent when a voice note can't be transcribed.
 *
 *  Owner self-chat gets the "type it / re-record" nudge (the owner can act on
 *  it). A contact gets a reassuring "will listen and call/get back" — in
 *  Telugu (Romanized) when the contact normally writes Telugu, else English.
 *  Kept short and casual so it reads as the owner, not a bot. */
export function degradedVoiceAck(opts: {
  isOwner: boolean;
  contactWritesTelugu?: boolean;
}): string {
  if (opts.isOwner) {
    return "🎙️ couldn't quite make out that voice note — mind typing it or re-recording?";
  }
  if (opts.contactWritesTelugu) {
    return "voice note vచ్చింది 🙏 vini malli call chesta";
  }
  return "got your voice note 🙏 will listen properly and get back to you";
}

/** Heuristic: does a transcript look garbled / mis-decoded?
 *
 *  Two failure modes we catch (both observed in prod):
 *   1. WRONG SCRIPT — Whisper decoded into a script that isn't the
 *      expected language and isn't Latin. The canonical bug is Telangana
 *      Telugu coming back as Kannada script. We flag when the dominant
 *      non-Latin script differs from the expected language's script.
 *   2. LOW ALPHA RATIO — mostly punctuation/digits/noise, no real words.
 *
 *  Conservative by design: a clean Telugu-script OR Romanized transcript
 *  must NOT be flagged. Returns false for empty input (caller handles
 *  the empty case separately). */
export function looksGarbledTranscript(
  transcript: string,
  expected: DetectedLanguage,
): boolean {
  const t = (transcript || "").trim();
  if (t.length < 2) return false;

  // Alpha ratio: letters (any script) vs. total non-space chars. A real
  // utterance is mostly letters; noise/garble is mostly symbols.
  let letters = 0;
  let nonSpace = 0;
  for (const ch of t) {
    if (/\s/.test(ch)) continue;
    nonSpace++;
    if (/\p{L}/u.test(ch)) letters++;
  }
  if (nonSpace >= 4 && letters / nonSpace < 0.45) return true;

  // Script check. Find the dominant native (non-Latin) script.
  let dominant: DetectedLanguage | null = null;
  let dominantChars = 0;
  for (const { lang, ranges } of SCRIPTS) {
    const n = countScriptChars(t, ranges);
    if (n > dominantChars) { dominant = lang; dominantChars = n; }
  }
  // No native script at all → it's Latin/Romanized; that's fine.
  if (!dominant || dominantChars === 0) return false;

  // The expected language's own script (or Latin) is always acceptable.
  // Devanagari is shared by Hindi + Marathi, so treat them as compatible.
  const compatible =
    dominant === expected ||
    (expected === "english") ||
    ((expected === "hindi" || expected === "marathi") &&
      (dominant === "hindi" || dominant === "marathi"));
  if (compatible) return false;

  // Dominant script is a DIFFERENT native script than expected (e.g.
  // Kannada output for a Telugu speaker) and it carries real weight
  // (≥ 3 chars) → garbled mis-decode.
  return dominantChars >= 3;
}
