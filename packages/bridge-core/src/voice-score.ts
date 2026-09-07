// Authorship distance (ADR 0024, W4): "does this draft read like the owner?"
// measured, not vibed.
//
// The literature (Yang 2026, Beaver 2025; see the ADR) says LLM-as-judge for
// voice is circular and more exemplars don't help. What does work is an
// authorship-verification score with a floor set from the HUMAN's own text.
// The honest local approximation is classic stylometry — a Burrows-style
// z-score delta over deterministic surface features (length, case, emoji,
// punctuation, function-word rates, Telugu share). Pure, no I/O, no model.
//
//   ponytail: stylometry, not a LUAR embedding — swap `styleFeatures` for an
//   embedding when one is reachable from the bridge; the floor logic stays.
//
// The floor is the 95th percentile of the owner's OWN samples' delta from
// their centroid: a draft fails only when it is further from the owner than
// 95% of what the owner really writes. Precision-first — a false positive
// silences a reply, which the owner has said is worse than a slightly-off one.

const FUNCTION_WORDS = [
  "i", "you", "the", "to", "a", "and", "is", "it", "that", "for", "of", "in", "on", "my", "me", "we",
  "will", "can", "just", "so", "ok", "okay", "yeah", "ya", "ha", "haha", "lol", "sure", "please", "thanks",
  "sare", "kuda", "ippudu", "repu", "nenu", "nuvvu", "ela", "undi", "cheptha", "chustha", "vasta",
];
const TELUGU_SCRIPT_RE = /[ఀ-౿]/;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu;

export const FEATURE_NAMES = [
  "log_chars", "log_words", "avg_word_len", "lower_start", "upper_ratio", "emoji_per_word", "ends_emoji",
  "exclaim_per_word", "question_per_word", "comma_per_word", "period_per_word", "ellipsis", "apostrophe_per_word",
  "sentences", "digits_ratio", "telugu_script", "dash",
  ...FUNCTION_WORDS.map((w) => `fw_${w}`),
] as const;

function tokens(s: string): string[] {
  return s.toLowerCase().replace(EMOJI_RE, " ").split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

/** Deterministic surface-style feature vector. Rates are per word so the
 *  vector is comparable across short and long messages. */
export function styleFeatures(text: string): number[] {
  const t = text.trim();
  const words = tokens(t);
  const n = Math.max(1, words.length);
  const chars = Math.max(1, t.length);
  const emoji = (t.match(EMOJI_RE) ?? []).length;
  const upper = (t.match(/\p{Lu}/gu) ?? []).length;
  const letters = Math.max(1, (t.match(/\p{L}/gu) ?? []).length);
  const digits = (t.match(/\p{N}/gu) ?? []).length;
  const first = t.match(/\p{L}/u)?.[0] ?? "";
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const v = [
    Math.log(chars), Math.log(n), words.reduce((a, w) => a + w.length, 0) / n,
    first && first === first.toLowerCase() ? 1 : 0, upper / letters, emoji / n,
    /[\p{Extended_Pictographic}\p{Emoji_Presentation}]\s*$/u.test(t) ? 1 : 0,
    (t.match(/!/g) ?? []).length / n, (t.match(/\?/g) ?? []).length / n, (t.match(/,/g) ?? []).length / n,
    (t.match(/\./g) ?? []).length / n, /\.{3}|…/.test(t) ? 1 : 0, (t.match(/'/g) ?? []).length / n,
    Math.min(6, t.split(/[.!?]+\s+|\n+/).filter((s) => s.trim()).length), digits / chars,
    TELUGU_SCRIPT_RE.test(t) ? 1 : 0, /—|–| - /.test(t) ? 1 : 0,
  ];
  for (const w of FUNCTION_WORDS) v.push((counts.get(w) ?? 0) / n);
  return v;
}

export interface VoiceModel {
  centroid: number[];
  scale: number[];
  /** p95 of the owner's own deltas. */
  floor: number;
  samples: number;
}

const MIN_SAMPLES = 50;

/** Mean absolute z-score distance from the centroid (Burrows' Delta). */
export function voiceDelta(model: VoiceModel, text: string): number {
  const f = styleFeatures(text);
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += Math.abs((f[i] - model.centroid[i]) / model.scale[i]);
  return sum / f.length;
}

/** Fit on the owner's own sent messages. Null below MIN_SAMPLES — with too
 *  few samples the floor is noise and the guard must not fire. Samples of
 *  one or two words are skipped: acks carry no style signal. */
export function fitVoiceModel(samples: string[], percentile = 0.95): VoiceModel | null {
  const use = samples.map((s) => s.trim()).filter((s) => tokens(s).length >= 3);
  if (use.length < MIN_SAMPLES) return null;
  const feats = use.map(styleFeatures);
  const dim = feats[0].length;
  const centroid = new Array(dim).fill(0);
  for (const f of feats) for (let i = 0; i < dim; i++) centroid[i] += f[i] / feats.length;
  const scale = new Array(dim).fill(0);
  for (const f of feats) for (let i = 0; i < dim; i++) scale[i] += (f[i] - centroid[i]) ** 2 / feats.length;
  // A floor on the spread, not an epsilon: on ~50 short messages many features
  // have zero variance, and 1e-3 would turn one stray comma into a z of 100.
  for (let i = 0; i < dim; i++) scale[i] = Math.max(Math.sqrt(scale[i]), 0.05);
  const model: VoiceModel = { centroid, scale, floor: 0, samples: use.length };
  const deltas = use.map((s) => voiceDelta(model, s)).sort((a, b) => a - b);
  model.floor = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * percentile))];
  return model;
}

export interface VoiceVerdict { ok: boolean; delta: number; floor: number; hint?: string }

const HINTS: Partial<Record<(typeof FEATURE_NAMES)[number], [string, string]>> = {
  log_chars: ["shorter — they write less", "a bit longer — they write more than this"],
  log_words: ["fewer words", "more words"],
  // index 0 fires when the DRAFT has more of the feature than the owner.
  lower_start: ["they usually start with a capital", "they usually start lowercase"],
  upper_ratio: ["fewer capitals", "more capitals"],
  emoji_per_word: ["fewer emoji", "an emoji or two, the way they do"],
  exclaim_per_word: ["drop the exclamation marks", "they use exclamation marks more"],
  comma_per_word: ["fewer commas / clauses", "they use more commas"],
  period_per_word: ["they don't end with periods", "they use periods"],
  sentences: ["fewer sentences", "more sentences"],
  telugu_script: ["they write Telugu romanized, not in script", "they use Telugu script"],
  dash: ["no dashes — they never use them", "they use dashes"],
  apostrophe_per_word: ["fewer contractions", "more contractions"],
};

/** Score a draft; when it fails the floor, name the two features that pull
 *  it furthest from the owner as a corrective hint for the regeneration. */
export function scoreVoice(model: VoiceModel | null, draft: string): VoiceVerdict | null {
  if (!model || tokens(draft).length < 3) return null;
  const delta = voiceDelta(model, draft);
  if (delta <= model.floor) return { ok: true, delta, floor: model.floor };
  const f = styleFeatures(draft);
  const z = f.map((x, i) => ({ i, z: (x - model.centroid[i]) / model.scale[i] }))
    .filter((e) => HINTS[FEATURE_NAMES[e.i]])
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 2);
  const hint = z.map((e) => HINTS[FEATURE_NAMES[e.i]]![e.z > 0 ? 0 : 1]).join("; ");
  return { ok: false, delta, floor: model.floor, hint };
}
