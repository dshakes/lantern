// Doc-relay owner ping — intelligent + authentic.
//
// When a contact asks the owner for a document, the bridge finds the file and
// pings the owner's self-chat to confirm before sending. This module builds the
// LLM prompt for that ping (the natural lead, in the owner's own voice) and
// finalizes it with a DETERMINISTIC confirm affordance appended. The lead is
// LLM-written (no canned phrasing); the affordance is fixed so "send"/"no"
// always work. finalize falls back to a truthful template if the LLM whiffs.

export interface DocRelayContext {
  ownerName: string;
  contactLabel: string;
  relationship?: string; // e.g. "wife", "brother", "college friend"
  request: string; // what they asked for, e.g. "PAN card"
  fileName: string; // the file we found, e.g. "Shekhar_PAN_Card.pdf"
  folder?: string; // human folder hint, e.g. "I-485/Shekhar"
}

export function buildDocRelayPrompt(c: DocRelayContext): string {
  const who = c.relationship ? `${c.contactLabel} (${c.ownerName}'s ${c.relationship})` : c.contactLabel;
  const where = c.folder ? ` You found it in the ${c.folder} folder.` : "";
  return [
    `You are ${c.ownerName}'s own assistant, sending ${c.ownerName} a quick private heads-up in their self-chat.`,
    `${who} just messaged ${c.ownerName} asking for their ${c.request}.`,
    `You searched ${c.ownerName}'s files and found "${c.fileName}".${where}`,
    ``,
    `Write ONE short line to ${c.ownerName} — their own casual texting voice, lowercase, no emoji, no greeting, no preamble — saying who's asking and that you found the file. Name the file. If you know the relationship, use it naturally ("manasa wants…"). Do NOT ask a question or add "want me to send it?" — a confirm prompt is appended after your line. Invent nothing beyond the facts above.`,
  ].join("\n");
}

// Combine the LLM's natural lead with the fixed confirm affordance. Falls back
// to a truthful template when the model returns nothing usable.
export function finalizeDocRelayPing(llmLine: string, c: DocRelayContext): string {
  let lead = (llmLine || "").trim().split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  // Reject junk / overlong / self-narrating output → fall back.
  if (!lead || lead.length > 220 || /^(sure|okay|here|as an ai|i'?ll)\b/i.test(lead)) {
    const who = c.relationship ? `${c.contactLabel} (your ${c.relationship})` : c.contactLabel;
    lead = `${who} asked for your ${c.request} — found ${c.fileName}.`;
  }
  return `📄 ${lead}\n\nsend it to ${c.contactLabel}? reply "send" or "no".`;
}

// Truthful ping when the file could NOT be found — never fabricate having it.
export function docNotFoundPing(c: Pick<DocRelayContext, "contactLabel" | "request">): string {
  return `📄 ${c.contactLabel} asked for your ${c.request} — I couldn't find it in your docs. drop me the file and I'll send it, or ignore.`;
}
