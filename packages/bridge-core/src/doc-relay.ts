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

// Generic words that don't identify WHICH document (they match card/copy/etc.
// across many docs). Excluded from the match gate so the distinctive term wins.
const DOC_GENERIC = new Set([
  "card", "cards", "copy", "copies", "document", "documents", "doc", "docs", "file", "files",
  "pdf", "scan", "scanned", "photo", "photos", "image", "picture", "pic", "latest", "recent",
  "my", "your", "the", "a", "an", "me", "of", "send", "please", "get", "for", "and",
]);

// SAFETY GATE for PII: only send a file whose basename actually contains EVERY
// distinctive (non-generic) term from the request. This is what stops "aadhaar
// card" from delivering Shekhar_PAN_Card.pdf just because PAN shares "card" and
// sits in an "Aadhaar" folder. Deterministic + strict: when unsure it refuses
// (the caller asks the owner) rather than send the wrong sensitive document.
export function docMatchesRequest(request: string, filename: string): boolean {
  const base = filename.toLowerCase();
  const terms = request
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !DOC_GENERIC.has(t));
  if (terms.length === 0) return false; // no distinctive term → can't safely confirm the file
  // Prefix-anchored match, not raw substring: the term must START a word
  // component (after start or a non-alphanumeric separator). "pan" matches
  // "shekhar_pan_card" and "GreenCard" matches "green" — but "pan" does NOT
  // match "japan_trip" (pan is mid-word there). Trailing letters are allowed so
  // compounds like "GreenCard" still match "green".
  return terms.every((t) => {
    const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    return re.test(base);
  });
}

// A candidate file from the personal-docs search that the relay may deliver.
// `ext` is the lowercased extension ("" for a directory — the search returns
// folders too, with their name suffixed " (folder)").
export interface DocCandidate {
  path: string;
  name: string;
  ext: string;
}

// Choose the file to send for a contact's document request. Two rules the live
// PAN-card incident exposed:
//   1. NEVER pick a directory. A folder's name can match the request
//      ("PAN Card/" for "pan card") when the actual file inside has a generic
//      scanned name ("IMG_2024.pdf") that doesn't match — but a folder can't be
//      delivered: readFileSync(dir) throws EISDIR on WhatsApp AND the link
//      fallback's read throws too, so it silently "failed to send" on BOTH
//      channels. Only real files (ext !== "") are deliverable.
//   2. Among files, pick the first whose NAME matches the request (the existing
//      PII match gate); otherwise surface the closest FILE name so the owner can
//      point at the right one — never a folder breadcrumb.
export function pickDocToSend(
  candidates: DocCandidate[],
  request: string,
): { hit?: DocCandidate; closest?: string } {
  const files = candidates.filter((c) => c.path && c.ext !== "");
  const hit = files.find((c) => docMatchesRequest(request, c.name));
  if (hit) return { hit };
  return files.length > 0 ? { closest: files[0].name } : {};
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

// The search returned a file, but its name doesn't match the request — do NOT
// auto-send it (that's the wrong-PII bug). Name the closest so the owner can
// decide, but require them to point at the right file explicitly.
export function docMismatchPing(c: { contactLabel: string; request: string; closest: string }): string {
  return `📄 ${c.contactLabel} asked for your ${c.request}, but I couldn't find an exact match — the closest is "${c.closest}", which doesn't look right. I won't send the wrong document. Reply with the correct file if you want it sent.`;
}
