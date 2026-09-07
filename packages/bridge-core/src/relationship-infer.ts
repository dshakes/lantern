// Reasoned relationship inference (ADR 0024 W1.4).
//
// A contact with no line in "## Relationships" was treated as a stranger:
// no register, no addressing rule, the cold-contact draft path. Yet the
// thread usually says who they are ("anna", "bava", "our PM", "the plumber").
// One purpose-keyed judgment reads the real transcript and proposes a label
// with a confidence and the evidence line. The label is INFERRED and
// UNCONFIRMED: it feeds the persona only. It never widens a security gate —
// isInnerCircle, location, `## Now`, contact sharing all keep using the
// owner-declared relationship — and the owner is told once so a one-line
// teaching ("Ravi: cousin") can confirm it. Cached on disk (0600), refreshed
// after 7 days or when the thread has grown by 20 inbounds.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface InferredRelationship {
  label: string;
  confidence: number;
  evidence: string;
  ts: number;
  inboundCount: number;
}

export const INFER_TTL_MS = 7 * 24 * 3_600_000;
export const INFER_MIN_LINES = 6;
export const INFER_MIN_CONFIDENCE = 0.7;

export function relationshipInferPrompt(args: { ownerName: string; contactName?: string; transcript: string; knownLabels: string[] }): string {
  const who = args.contactName ? `"${args.contactName}"` : "this contact";
  const examples = args.knownLabels.length ? `Labels the owner already uses for other people (match their style): ${args.knownLabels.slice(0, 12).join(", ")}.` : "";
  return [
    `From this real message thread between ${args.ownerName} ("You") and ${who} ("They"), infer how ${who} is related to ${args.ownerName}.`,
    'Return STRICT JSON only: {"relationship":"<short label like brother-in-law / cousin / college friend / coworker / neighbour / vendor / unknown>","confidence":0..1,"evidence":"<the ONE line that shows it>"}',
    "Kinship words in Telugu/Hindi count (anna = elder brother, bava = brother-in-law, mama = uncle, akka = elder sister, vadina = sister-in-law). If the thread does not show it, answer unknown with low confidence. Never guess from a name alone.",
    examples,
    "",
    "Thread (oldest first):",
    args.transcript.slice(-2500),
    "",
    "JSON:",
  ].filter(Boolean).join("\n");
}

export function parseRelationshipInference(raw: string | null | undefined): { label: string; confidence: number; evidence: string } | null {
  const m = (raw ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { relationship?: unknown; confidence?: unknown; evidence?: unknown };
    const label = typeof j.relationship === "string" ? j.relationship.trim().toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, "").slice(0, 40) : "";
    if (!label || label === "unknown") return null;
    const confidence = typeof j.confidence === "number" && Number.isFinite(j.confidence) ? Math.max(0, Math.min(1, j.confidence)) : 0;
    const evidence = typeof j.evidence === "string" ? j.evidence.trim().slice(0, 160) : "";
    return { label, confidence, evidence };
  } catch {
    return null;
  }
}

/** Should the bridge ask (again)? Enough thread, and either no cached answer
 *  or a stale one. Deterministic. */
export function shouldInferRelationship(cached: InferredRelationship | undefined, transcriptLines: number, inboundCount: number, now = Date.now()): boolean {
  if (transcriptLines < INFER_MIN_LINES) return false;
  if (!cached) return true;
  return now - cached.ts > INFER_TTL_MS || inboundCount - cached.inboundCount >= 20;
}

/** Tiny 0600 JSON cache keyed by handle. Never throws. */
export class InferredRelationshipStore {
  private map = new Map<string, InferredRelationship>();
  constructor(private path: string) {
    try {
      if (existsSync(path)) {
        const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, InferredRelationship>;
        for (const [k, v] of Object.entries(j)) if (v && typeof v.label === "string") this.map.set(k, v);
      }
    } catch { /* corrupt cache → start empty */ }
  }
  get(handle: string): InferredRelationship | undefined { return this.map.get(handle); }
  set(handle: string, v: InferredRelationship): void {
    this.map.set(handle, v);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
    } catch { /* best-effort */ }
  }
}

/** The persona-facing label: explicit about its status so the model never
 *  asserts it to the contact as fact. */
export function inferredRelationshipLabel(r: InferredRelationship | undefined): string | undefined {
  if (!r || r.confidence < INFER_MIN_CONFIDENCE) return undefined;
  return `${r.label} (inferred from the thread, unconfirmed — do not state it to them)`;
}

export function inferredRelationshipFyi(contactName: string, r: InferredRelationship): string {
  return `🧭 I think ${contactName} is your ${r.label} (from the thread: "${r.evidence || "…"}"). Reply "${contactName}: ${r.label}" to confirm, or correct me.`;
}
