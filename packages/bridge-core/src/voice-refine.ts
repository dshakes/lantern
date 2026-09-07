// Critique-refine against the owner's OWN text (ADR 0024 W3.4, "PerFine").
//
// The one reflection pattern the literature shows working is grounded
// critique: not "is this good?" but "here are five things this person
// actually wrote — edit the draft to read like them". One extra call, only
// for MEDIUM/LOW drafts, purpose-keyed so it never touches a contact's live
// session, and the result is ACCEPTED ONLY when it is measurably closer to
// the owner (voice delta not worse) and clears the bot-tell guard. Any
// failure keeps the original draft.
//
// Pure: prompt + parse. The bridge supplies the exemplars, the LLM call, and
// the acceptance metric.

export interface RefinePromptInput {
  ownerName: string;
  draft: string;
  inbound: string;
  exemplars: string[];
}

export function buildRefinePrompt(i: RefinePromptInput): string {
  const ex = i.exemplars.map((e, n) => `${n + 1}. ${e}`).join("\n");
  return [
    `You are editing a text message so it reads exactly like ${i.ownerName} writes. Below are ${i.exemplars.length} messages ${i.ownerName} REALLY sent (verbatim). Study their length, casing, punctuation, emoji, and how they mix languages.`,
    ``,
    `${i.ownerName}'s real messages:`,
    ex,
    ``,
    `They received: "${i.inbound.slice(0, 300)}"`,
    `Draft reply: "${i.draft.slice(0, 600)}"`,
    ``,
    `Rewrite the draft so it could sit unnoticed among the real messages above: same length band, same casing habits, same punctuation, same amount of emoji, same code-switching. KEEP the meaning and every fact; do not add new promises, offers, or questions that the draft did not have; do not copy an example's content. If the draft already reads like them, return it unchanged.`,
    `Output ONLY the message text — no quotes, no preamble, no explanation.`,
  ].join("\n");
}

/** Clean the model's output into a sendable message, or null when it is not
 *  one (empty, wrapped, explanatory, or wildly longer than the draft). */
export function parseRefine(raw: string | null | undefined, draft: string): string | null {
  let t = (raw ?? "").trim();
  if (!t) return null;
  t = t.replace(/^```[a-z]*\s*|\s*```$/gi, "").trim();
  t = t.replace(/^(?:rewritten|revised|edited|draft|reply|message|output)\s*:\s*/i, "").trim();
  if (/^["'“‘]/.test(t) && /["'”’]$/.test(t)) t = t.slice(1, -1).trim();
  if (!t) return null;
  if (/^[{[]/.test(t)) return null;                                   // structured output leaked
  if (/^(here|sure|i (?:have|'ve) )/i.test(t) && /\n/.test(t)) return null; // explanation + message
  if (t.length > Math.max(160, draft.length * 1.6)) return null;      // "refined" into a paragraph
  if (t.split(/\n/).length > draft.split(/\n/).length + 1) return null;
  return t;
}
