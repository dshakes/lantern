// command-center-executor.ts — shared helpers for the command-center UX wired into both bridges.
//
// Responsibilities:
//   - Per-chat numbered-state (Map + TTL) so numbered replies (`1 done`, `2 send`)
//     map back to the right item after a Brief/plate/did render.
//   - Hybrid proactive gate: which nudge kinds fire in real-time vs. deferred to Brief.
//   - Data-fetching helper for buildBrief (life-events from /v1/life-events).
//   - Snooze duration parser shared between both bridges.
//
// Pure types + best-effort network helpers. NEVER throws.
// The bridge owns: CommitmentsClient, draft send rails, auto-action undo.

import type { BriefItem, BriefInput, LifeEventLite, DraftWaiting } from "./command-center.ts";
import type { Commitment } from "./commitments-edge.ts";

// ── Per-chat numbered state (TTL: 15 min) ───────────────────────────────────

export const CENTER_STATE_TTL_MS = 15 * 60 * 1000; // 15 min

export interface CenterStateEntry {
  items: BriefItem[];
  expiresAt: number;
}

/**
 * Return the current items for `chatId` if they're still within TTL, else null.
 * The caller falls through to normal chat when null.
 */
export function getCenterItems(
  map: Map<string, CenterStateEntry>,
  chatId: string,
  now = Date.now(),
): BriefItem[] | null {
  const e = map.get(chatId);
  if (!e || now > e.expiresAt) return null;
  return e.items;
}

/** Store items for `chatId` with a fresh 15-min TTL. */
export function setCenterItems(
  map: Map<string, CenterStateEntry>,
  chatId: string,
  items: BriefItem[],
  now = Date.now(),
): void {
  map.set(chatId, { items, expiresAt: now + CENTER_STATE_TTL_MS });
}

// ── Hybrid proactive gate ────────────────────────────────────────────────────

/**
 * Returns true when a proactive nudge should fire in real-time.
 * Others are deferred — the owner finds them in "?" / "brief" / "plate" on demand.
 *
 * Gate: pre-meeting always; commitment only if it's a bill/price-hike.
 * VIP-draft-ready is a future nudge kind — today VIP drafts send via B5 /
 * pendingDraftEdits (not through the nudge tick), so it's not gated here.
 *
 * ponytail: three-case gate; expand when nudge taxonomy grows.
 */
export function isRealTimeNudge(nudge: {
  kind: string;
  text: string;
  urgency?: "now" | "soon" | "normal";
  commitmentKind?: string;
}): boolean {
  if (nudge.kind === "pre-meeting") return true;
  if (nudge.kind === "commitment") {
    // Prefer the STRUCTURED fields — classifying importance by regex-matching a
    // nudge's own rendered text is fragile (a "$5 coupon review" would wrongly
    // fire real-time). Fall back to the text heuristic only when neither field
    // is present (older callers that don't pass them yet).
    if (nudge.urgency) return nudge.urgency === "now" || nudge.urgency === "soon";
    if (nudge.commitmentKind) return /finance|bill|money|payment/i.test(nudge.commitmentKind);
    return /bill|charge|\$|subscription|price\s*hike|renew/i.test(nudge.text);
  }
  return false;
}

// ── Snooze duration parser ───────────────────────────────────────────────────

/**
 * Convert a snooze argument string ("2h", "30m", "tomorrow", "3d") to milliseconds.
 * Defaults to 3 hours when arg is absent or unrecognized.
 * ponytail: inline; replace with commitments-edge computeSnoozeUntil if it gets exported.
 */
export function parseSnoozeMs(arg?: string): number {
  if (!arg) return 3 * 60 * 60 * 1000;
  const m = arg.match(/^(\d+)m$/i);
  if (m) return parseInt(m[1], 10) * 60 * 1000;
  const h = arg.match(/^(\d+)h$/i);
  if (h) return parseInt(h[1], 10) * 60 * 60 * 1000;
  const d = arg.match(/^(\d+)d$/i);
  if (d) return parseInt(d[1], 10) * 24 * 60 * 60 * 1000;
  if (/^tomorrow$/i.test(arg)) return 24 * 60 * 60 * 1000;
  return 3 * 60 * 60 * 1000;
}

// ── Brief data fetching ──────────────────────────────────────────────────────

/** Fetch the fyi section from /v1/life-events. Best-effort — returns [] on any failure. */
async function fetchFyi(
  fetchFn: (path: string, opts?: RequestInit) => Promise<Response>,
): Promise<LifeEventLite[]> {
  try {
    const r = await fetchFn("/v1/life-events?limit=8");
    if (!r.ok) return [];
    const data = (await r.json()) as {
      events?: Array<{ id: string; kind: string; summary: string; status?: string; urgency?: string }>;
    };
    return (data.events ?? []).map((e) => ({
      id: e.id,
      kind: e.kind,
      summary: e.summary,
      status: e.status,
      urgency: e.urgency,
    }));
  } catch {
    return [];
  }
}

/**
 * Gather data for buildBrief. Never throws.
 * The bridge supplies: commitments, drafts, agentActivity (all already in memory).
 * This function adds: fyi from /v1/life-events.
 * Note: /v1/news is skipped (endpoint may 404 until AI-radar PR lands; no slot in BriefInput).
 */
export async function fetchBriefInput(
  fetchFn: (path: string, opts?: RequestInit) => Promise<Response>,
  openCommitments: Commitment[],
  drafts: DraftWaiting[] = [],
  agentActivity: string[] = [],
): Promise<BriefInput> {
  const fyi = await fetchFyi(fetchFn);
  return { now: new Date(), agentActivity, commitments: openCommitments, drafts, fyi };
}
