// Owner-voice rephrasing for proactive nudges. The nano-loops (commute / energy
// / health / focus) compute a DETERMINISTIC nudge string — correct + replay-safe
// — but the owner sees the identical sentence every day, and that sameness is
// itself a bot-tell. This rewrites the nudge in the owner's own casual texting
// voice so the wording varies day to day, WITHOUT ever changing a fact.
//
// GA-safe by construction: the rephrase is accepted ONLY if it introduces no
// number that wasn't in the original (a changed step-count / hour is the one
// thing we must never ship) and preserves any "reply X" affordance. On any
// doubt — LLM failure, a new number, a dropped affordance, wrong length — it
// returns the deterministic text unchanged.

// Canonical numeric tokens in a string. "8k"→8000, "1,500"→1500, "6.2h"→6.2.
function numTokens(s: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (!m[1]) continue;
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    if (m[2]) n *= 1000;
    out.push(n);
  }
  return out;
}

export interface RephraseNudgeOpts {
  ownerName?: string;
  /** Owner-voice persona block (from formatOwnerVoiceBlock) — few-shot for register. */
  voiceBlock?: string;
}

/**
 * Rephrase a deterministic nudge in the owner's voice. Returns the rephrased
 * line, or the original `deterministic` unchanged when the rewrite can't be
 * trusted. `llmCall` is a plain text-completion seam; pass undefined to no-op.
 */
export async function rephraseNudge(
  deterministic: string,
  llmCall?: (prompt: string) => Promise<string>,
  opts: RephraseNudgeOpts = {},
): Promise<string> {
  const original = (deterministic ?? "").trim();
  if (!original || !llmCall) return deterministic;

  const leadEmoji = original.match(/^\s*(\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*)/u)?.[1] ?? "";
  const hasReply = /\breply\b/i.test(original);

  const prompt =
    `Rewrite this short proactive nudge in ${opts.ownerName || "the owner"}'s OWN casual texting voice so it doesn't read like the same template every day.\n` +
    `HARD RULES: keep every number/time/fact EXACTLY as given (do not change, round, or add any number). One short line. No exclamation marks. No "Certainly"/"Of course"/corporate tone.${leadEmoji ? ` Start with "${leadEmoji}".` : ""}${hasReply ? ` Keep the "reply ..." ask.` : ""} Do NOT explain, plan, or restate the task — output ONLY the single rewritten line, nothing before or after.\n` +
    `${opts.voiceBlock ? opts.voiceBlock + "\n" : ""}Nudge: """${original}"""\nRewrite:`;

  let out: string;
  try {
    out = (await llmCall(prompt)) ?? "";
  } catch {
    return deterministic;
  }
  out = out.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  out = out.replace(/^["'>`\s]+|["'`\s]+$/g, "").trim();
  if (!out || out.length < 4 || out.length > Math.max(160, original.length + 60)) return deterministic;
  // Safety: if the original led with an emoji, the rewrite must too. This kills
  // reasoning-leak preambles ("Plan: ...", "Here's my rewrite:") cheaply — a
  // real nudge starts with its emoji, a leaked thought doesn't.
  if (leadEmoji && !out.startsWith(leadEmoji)) return deterministic;

  // Safety: the rewrite must not introduce any number absent from the original.
  const origNums = new Set(numTokens(original).map((n) => n.toString()));
  const outNums = numTokens(out).map((n) => n.toString());
  for (const n of outNums) {
    if (!origNums.has(n)) return deterministic;
  }
  // Safety: if the nudge is FACTUAL (has numbers), the rewrite must keep at
  // least one of them — else the model dropped the substance or emitted a
  // meta-preamble ("Here's my plan:") that says nothing. Fall back.
  if (origNums.size > 0 && !outNums.some((n) => origNums.has(n))) return deterministic;
  // Safety: don't drop the actionable "reply ..." affordance.
  if (hasReply && !/\b(reply|yes)\b/i.test(out)) return deterministic;

  return out;
}
