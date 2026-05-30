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
 *  persona prompt. Returns "" for English (no extra guidance needed). */
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
  return lines.join("\n");
}
