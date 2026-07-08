// Agentic disambiguation for owner confirmations. When the owner has ONE
// pending action awaiting "send", a deterministic classifier handles it. When
// there are TWO OR MORE (e.g. a document to Bhavik AND a text to Chinna staged
// close together), a bare "send" is ambiguous — guessing risks firing the wrong
// (often sensitive) thing at the wrong contact. This module lets the LLM REASON
// about which pending the owner means from their phrasing, and — crucially —
// return "ask" when it genuinely can't tell, so the bot disambiguates instead
// of gambling. Pure prompt/parse; the LLM call + IO live in the bridges.

export interface PendingDescriptor {
  id: string; // opaque key for the pending (the map key)
  kind: "doc" | "text"; // a file/document send vs a text message
  target: string; // contact label the action goes to
  summary: string; // filename (doc) or a short text preview
}

export type PendingResolution =
  | { decision: "send"; id: string }
  | { decision: "reject"; id: string }
  | { decision: "ask"; question: string }
  | { decision: "none" };

export function buildPendingResolvePrompt(pendings: PendingDescriptor[], ownerMessage: string): string {
  const lines = pendings
    .map((p, i) => `${i + 1}. id=${p.id} — send ${p.kind === "doc" ? `the document "${p.summary}"` : `the text "${p.summary}"`} to ${p.target}`)
    .join("\n");
  return [
    `The owner has these actions staged, each awaiting a "send" confirmation (they saw a preview of each moments ago):`,
    lines,
    ``,
    `The owner just replied: "${ownerMessage}"`,
    ``,
    `Decide which staged action (if any) this reply confirms or cancels. Reply with STRICT JSON, one of:`,
    `{"decision":"send","id":"<id>"}      — fire exactly this one`,
    `{"decision":"reject","id":"<id>"}    — cancel exactly this one`,
    `{"decision":"ask","question":"..."}  — genuinely ambiguous; ask the owner a short either/or question`,
    `{"decision":"none"}                  — the reply is unrelated to any staged action`,
    ``,
    `Rules:`,
    `- If the reply names a contact ("send to Bhavik"), a document ("send the aadhaar one"), or clearly points at one ("yes the first", "the text"), pick THAT id.`,
    `- If it's a bare "send"/"yes"/"do it" and there are multiple staged actions with no way to tell which, choose "ask" with a crisp either/or naming the contacts/docs. NEVER guess when a document (PII) could go to the wrong person.`,
    `- "no"/"cancel"/"drop it" with one obvious target → reject it; if ambiguous which to cancel, "ask".`,
    `- Anything that isn't confirming/cancelling a staged action → "none".`,
  ].join("\n");
}

// Tolerant parse: extract the first JSON object, validate against the pendings.
export function parsePendingResolution(raw: string, validIds: string[]): PendingResolution {
  if (!raw) return { decision: "none" };
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { decision: "none" };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return { decision: "none" };
  }
  const decision = String(obj.decision || "").toLowerCase();
  if (decision === "ask") {
    const q = typeof obj.question === "string" && obj.question.trim() ? obj.question.trim() : "which one did you mean?";
    return { decision: "ask", question: q };
  }
  if (decision === "send" || decision === "reject") {
    const id = String(obj.id || "");
    if (validIds.includes(id)) return { decision, id };
    // model returned an unknown/blank id → don't act on the wrong thing; ask.
    return { decision: "ask", question: "which one did you mean?" };
  }
  return { decision: "none" };
}
