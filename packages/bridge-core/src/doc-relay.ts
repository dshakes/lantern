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
  modifiedAt?: number; // epoch ms — used to order the numbered pick newest-first
}

// The personal-docs search suffixes folder names with " (folder)". Strip it
// before matching a folder name against the request.
function folderBaseName(name: string): string {
  return name.replace(/\s*\(folder\)\s*$/i, "");
}

// Choose the file to send for a contact's document request. Three rules the
// live PAN-card incident exposed:
//   1. NEVER pick a directory. A folder's name can match the request
//      ("PAN Card/" for "pan card") when the actual file inside has a generic
//      scanned name ("IMG_2024.pdf") that doesn't match — but a folder can't be
//      delivered: readFileSync(dir) throws EISDIR on WhatsApp AND the link
//      fallback's read throws too, so it silently "failed to send" on BOTH
//      channels. Only real files (ext !== "") are deliverable.
//   2. Among files, pick the first whose NAME matches the request (the existing
//      PII match gate).
//   3. AUTO-DESCEND: if no file name matched but a FOLDER name matches the
//      request AND that folder holds exactly ONE deliverable file, send that
//      file (the scanned "PAN Card/IMG_2024.pdf" case). The owner still sees the
//      real filename in the confirm ping and approves before anything sends, so
//      this is safe. More than one file under the folder is ambiguous — never
//      guess which PII to send; fall through to surfacing the closest FILE so
//      the owner points at the right one (never a folder breadcrumb).
// A file the owner can pick from a numbered list (path + display name).
export interface DocPickCandidate {
  path: string;
  name: string;
}

export function pickDocToSend(
  candidates: DocCandidate[],
  request: string,
): { hit?: DocCandidate; closest?: string; candidates?: DocPickCandidate[] } {
  const files = candidates.filter((c) => c.path && c.ext !== "");
  const hit = files.find((c) => docMatchesRequest(request, c.name));
  if (hit) return { hit };

  const matchedFolders = candidates.filter(
    (c) => c.path && c.ext === "" && docMatchesRequest(request, folderBaseName(c.name)),
  );
  for (const folder of matchedFolders) {
    const prefix = folder.path.endsWith("/") ? folder.path : folder.path + "/";
    const inside = files.filter((f) => f.path.startsWith(prefix));
    // Exactly one file under a matched folder → auto-descend (owner still
    // confirms). Two-or-more → we have a STRONG signal the right doc is in this
    // folder but can't tell which; offer them as a numbered pick rather than
    // dead-ending or guessing a PII file.
    if (inside.length === 1) return { hit: inside[0] };
    if (inside.length > 1) {
      // Order newest-first so #1 is the latest scan (the usual "resend my PAN"
      // wants the most recent copy) and "latest" maps to the first item.
      const byNewest = [...inside].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
      return { candidates: byNewest.slice(0, 3).map((f) => ({ path: f.path, name: f.name })) };
    }
  }

  return files.length > 0 ? { closest: files[0].name } : {};
}

// Owner-facing ping for the numbered-pick fallback: the request found several
// plausible files (all in a folder that matched) and we won't guess which PII
// to send. The owner replies a number to choose.
export function buildDocPickPing(
  c: { contactLabel: string; request: string },
  candidates: DocPickCandidate[],
): string {
  const list = candidates.map((f, i) => `${i + 1}. ${f.name}${i === 0 ? " (newest)" : ""}`).join("\n");
  return `📄 ${c.contactLabel} asked for your ${c.request} — I found a few and I'm not sure which is right:\n${list}\n\nreply the number to send it (e.g. "1"), "latest" for the newest, or "no".`;
}

const WORD_TO_NUM: Record<string, number> = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3 };

// Parse the owner's reply to a numbered doc-pick ping. Returns a 0-based index
// into the candidate list, "reject", or null (unclear → the caller re-asks).
//
// STRICT on purpose — this fires a SENSITIVE file, so a selector is honored ONLY
// when the reply is essentially just that selector, or an explicit imperative
// ("send 2", "pick the first"). This is what stops a normal "one sec" / "give me
// 2 mins" / "the aadhaar too" reply after the prompt from blasting a document.
// A bare "send"/"yes" (no index) is deliberately null: we never guess which
// sensitive file the owner meant.
export function parseDocPick(text: string, count: number): number | "reject" | null {
  const t = (text || "").trim().toLowerCase();
  if (!t) return null;
  if (/^(no|nope|nah|cancel|skip|none|never\s*mind|nvm|don'?t)\b/.test(t)) return "reject";
  // Candidates are ordered newest-first, so a bare "latest"/"newest"/"most
  // recent" (the whole reply) resolves to the first item.
  if (count > 0 && /^(?:the\s+)?(?:latest|newest|most\s*recent)[.! ]*$/.test(t)) return 0;

  const sel = "(\\d+|one|two|three|first|second|third)";
  // (a) a bare selector as the ENTIRE reply: "1", "2.", "first", "the first",
  //     "option 2", "#3" — nothing else follows it.
  const bare = t.match(new RegExp(`^(?:the\\s+|number\\s+|option\\s+|#)?${sel}(?:\\s+one)?[.! ]*$`));
  // (b) an explicit imperative naming the selector: "send 2", "pick the first",
  //     "go with 1", "use option 3".
  const explicit = t.match(new RegExp(`\\b(?:send|pick|choose|use|go\\s+with|option|number)\\s+(?:the\\s+)?${sel}\\b`));
  const token = bare?.[1] ?? explicit?.[1];
  if (!token) return null;
  const n = /^\d+$/.test(token) ? parseInt(token, 10) : WORD_TO_NUM[token];
  if (n === undefined || n < 1 || n > count) return null;
  return n - 1;
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
