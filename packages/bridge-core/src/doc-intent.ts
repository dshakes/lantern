// Doc-intent backstop classifier.
//
// WHY THIS EXISTS (a real GA incident, twice): document delivery is gated on the
// persona LLM emitting a marker mid-conversation — [DOCREQ:…] when a contact asks
// for the owner's document, [SENDDOC:…] when the owner asks to send one. The
// persona is also trained to deflect ("that's still on his list", "one sec"), so
// when it writes the deflection but FORGETS the marker, the relay silently
// no-ops and the contact gets a text with no file while the owner is told it
// went. Markers are a fast path; they are not reliable enough to be the ONLY
// path for a critical feature.
//
// This module is the reliable path: a focused, isolated reasoning call over the
// ACTUAL message (not buried in a persona reply) that decides whether the
// message is a request to deliver one of the owner's personal documents, and
// which document. Its output deterministically drives the relay regardless of
// what the persona did or didn't emit. Pure functions here (gate / prompt /
// parse); the LLM call + relay wiring live in each bridge.
//
// Fail-safe by construction: any ambiguity or parse failure yields
// isDocRequest=false, so the backstop can only ADD a correct relay, never fire a
// wrong send. The owner still confirms every relay before a file leaves.

export interface DocIntent {
  isDocRequest: boolean;
  document: string; // the requested doc, e.g. "PAN card" ("" when not a request)
}

const EMPTY: DocIntent = { isDocRequest: false, document: "" };

// COST GATE ONLY — not the decision. Broad on purpose: a false positive costs
// one cheap classification call; a false negative is the silent non-delivery bug
// we are fixing, so we bias hard toward calling the classifier. The LLM in
// buildDocIntentPrompt makes the actual isDocRequest decision. Keep this generous
// and dumb; do not turn it into the classifier.
// ponytail: regex is a cost gate, not a classifier — the LLM decides. Widen it, don't sharpen it.
const DOC_HINT =
  /\b(pan|aadhaar|aadhar|passport|licen[cs]e|licence|visa|ssn|itin|ead|green\s?card|i-?\d{2,4}|insurance|policy|receipt|invoice|statement|voter|birth\s?cert|marriage\s?cert|degree|diploma|transcript|r[eé]sum[eé]|\bcv\b|document|\bdoc\b|scan|copy|card|certificate|form|photo\s?id|id\s?proof)\b/i;
const MOVE_HINT =
  /\b(send|share|forward|attach|upload|email|text|dm|whatsapp|drop|need|want|get|give|show|resend|re-?send|send\s?me|send\s?over)\b/i;

/**
 * Cheap pre-filter: should we spend an LLM classification call on this message?
 * Returns true when the text plausibly references moving a personal document.
 * This ONLY decides whether to invoke the classifier — it never decides that a
 * message IS a doc request. Bias toward true.
 */
export function maybeDocRequest(text: string): boolean {
  if (!text) return false;
  const t = text.slice(0, 2000);
  return DOC_HINT.test(t) && MOVE_HINT.test(t);
}

/**
 * Build the classifier prompt. `direction` disambiguates who is asking:
 *  - "inbound": a CONTACT messaged the owner. isDocRequest=true means the contact
 *    is asking the owner to SEND them one of the owner's documents.
 *  - "owner": the OWNER messaged self-chat. isDocRequest=true means the owner is
 *    asking the assistant to SEND one of their documents to someone.
 * Output is strict JSON so parseDocIntent can consume it deterministically.
 */
export function buildDocIntentPrompt(
  text: string,
  ownerName: string,
  direction: "inbound" | "owner",
): string {
  const who =
    direction === "inbound"
      ? `A contact just messaged ${ownerName}. Decide whether the contact is asking ${ownerName} to SEND them one of ${ownerName}'s own personal documents/files (an ID, card, passport, licence, certificate, receipt, statement, form, scan, photo of a document, etc.).`
      : `${ownerName} just messaged their own assistant. Decide whether ${ownerName} is asking the assistant to SEND one of ${ownerName}'s own personal documents/files to someone.`;
  return [
    who,
    "",
    "Reply with STRICT JSON only, no prose, no code fences:",
    `{"isDocRequest": true|false, "document": "<the document in 1-4 words, e.g. PAN card, passport, driver licence; empty string if not a doc request>"}`,
    "",
    "Rules:",
    "- isDocRequest is TRUE only when the message is a request to DELIVER a document now.",
    "- FALSE when they are merely confirming receipt (\"did you get my pan card?\"), discussing a document without asking for it, or asking a question about it.",
    "- FALSE for anything that is not about sending/receiving a concrete personal document.",
    "- \"document\" must name WHICH document as specifically as the message allows; do not invent one.",
    "- When unsure, return false. A wrong true sends the wrong sensitive file.",
    "",
    "Message:",
    text.slice(0, 2000),
  ].join("\n");
}

/**
 * Tolerant, fail-safe parse of the classifier output. Accepts raw JSON, JSON in
 * ```fences```, or JSON embedded in prose. ANY failure → {isDocRequest:false} so
 * the backstop can never fire a wrong send.
 */
export function parseDocIntent(raw: string | null | undefined): DocIntent {
  if (!raw) return EMPTY;
  const m = raw.match(/\{[\s\S]*\}/); // first {...} block, spanning newlines
  if (!m) return EMPTY;
  try {
    const o = JSON.parse(m[0]) as { isDocRequest?: unknown; document?: unknown };
    const isDocRequest = o.isDocRequest === true;
    const document = typeof o.document === "string" ? o.document.trim() : "";
    // A true with no document is unusable (nothing to search for) → fail safe.
    if (isDocRequest && document) return { isDocRequest: true, document };
    return EMPTY;
  } catch {
    return EMPTY;
  }
}
