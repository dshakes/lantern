// attention.ts — the Attention Engine: turns the Brief from a statically
// sorted list into an LLM-REASONED ranking of what genuinely needs the owner,
// and surfaces "waiting on you" threads (contacts left unanswered) that the
// hybrid nudge gate holds back from real-time pings.
//
// Pure module: prompt building + parsing + merge only. The bridge makes the
// LLM call (session key `${owner}::attention` — NEVER a contact's live
// session, see bridge-respondto-session-pollution) and falls back to the
// deterministic Brief order on ANY failure. The LLM can only reorder and
// annotate items that already exist — it cannot invent, drop, or rewrite
// them, so a bad completion degrades to cosmetics, never to wrong facts.

import type { BriefInput } from "./command-center.ts";

/** A conversation waiting on the owner (they wrote last, owner never replied). */
export interface WaitingThread {
  /** Channel-native handle (iMessage handle / WhatsApp JID). */
  contactKey: string;
  displayName: string;
  channel: "imessage" | "whatsapp";
  daysWaiting: number;
  /** Preview of their last inbound message, if available. */
  lastInbound?: string;
  vip?: boolean;
}

export interface AttentionRanking {
  /** Unified order of refIds, most-important first. Items absent keep their deterministic order after the ranked ones. */
  order: string[];
  /** refId -> one short reason (≤ ~8 words), owner-voice, no fluff. */
  whys: Record<string, string>;
}

/** Stable id joining kind+id so drafts/commitments/threads rank in ONE list. */
export function refId(kind: "draft" | "commitment" | "thread", id: string): string {
  return `${kind}:${id}`;
}

const MAX_WHY_CHARS = 60;

/**
 * Build the strict-JSON ranking prompt. Candidates are labeled with their
 * refIds; the model ranks across kinds (a 3-day-unanswered VIP can outrank a
 * routine draft — that judgment is exactly what a static sort can't make).
 */
export function buildAttentionPrompt(
  input: Pick<BriefInput, "commitments" | "drafts">,
  waiting: WaitingThread[],
  now: Date,
): string {
  const lines: string[] = [];
  lines.push("You rank what most needs a busy person's attention RIGHT NOW.");
  lines.push(`Current time: ${now.toString()}`);
  lines.push("");
  lines.push("Candidates (id | kind | detail):");
  for (const d of input.drafts) {
    lines.push(`${refId("draft", d.id)} | reply draft waiting approval | to ${d.to}: "${d.preview}"`);
  }
  for (const c of input.commitments) {
    const from = c.assignedBy ? ` (for ${c.assignedBy})` : "";
    lines.push(`${refId("commitment", c.id)} | open commitment${from} | ${c.title}${c.urgency ? ` [urgency: ${c.urgency}]` : ""}`);
  }
  for (const w of waiting) {
    const vip = w.vip ? " [VIP]" : "";
    const last = w.lastInbound ? ` — last said: "${w.lastInbound}"` : "";
    lines.push(`${refId("thread", w.contactKey)} | ${w.displayName}${vip} waiting ${w.daysWaiting}d for a reply on ${w.channel}${last}`);
  }
  lines.push("");
  lines.push(
    "Rank ALL candidate ids most-important-first. Weigh: hard deadlines and money first; people waiting on a reply age badly (a VIP or family member waiting days beats routine tasks); urgency labels are hints, not orders.",
  );
  lines.push('For each id also write "why" — one blunt reason, max 8 words, lowercase, no punctuation at the end. Never invent details not shown above.');
  lines.push('Reply with STRICT JSON only, no prose: {"order":["id",...],"why":{"id":"reason",...}}');
  return lines.join("\n");
}

/**
 * Tolerant parse of the model's ranking. Unknown ids are dropped, whys are
 * clamped, and anything unparseable returns null (caller keeps deterministic
 * order). Never throws.
 */
export function parseAttentionRanking(raw: string, validIds: Set<string>): AttentionRanking | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { order?: unknown; why?: unknown };
    if (!Array.isArray(parsed.order)) return null;
    const seen = new Set<string>();
    const order: string[] = [];
    for (const id of parsed.order) {
      if (typeof id === "string" && validIds.has(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    if (order.length === 0) return null;
    const whys: Record<string, string> = {};
    if (parsed.why && typeof parsed.why === "object" && !Array.isArray(parsed.why)) {
      for (const [id, why] of Object.entries(parsed.why as Record<string, unknown>)) {
        if (typeof why === "string" && validIds.has(id) && why.trim()) {
          whys[id] = why.trim().slice(0, MAX_WHY_CHARS);
        }
      }
    }
    return { order, whys };
  } catch {
    return null;
  }
}

/** All refIds a Brief's candidates can produce (the parser's allowlist). */
export function candidateIds(
  input: Pick<BriefInput, "commitments" | "drafts">,
  waiting: WaitingThread[],
): Set<string> {
  const ids = new Set<string>();
  for (const d of input.drafts) ids.add(refId("draft", d.id));
  for (const c of input.commitments) ids.add(refId("commitment", c.id));
  for (const w of waiting) ids.add(refId("thread", w.contactKey));
  return ids;
}
