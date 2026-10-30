// Today's Brief — the pal home's ranked "what needs you" list.
//
// Sources (all real, all tenant-scoped server-side):
//   - held replies   (/v1/whatsapp/drafts?status=pending — the commitment /
//                     grounding gates and draft-confirm park replies here)
//   - life events    (/v1/life-events?status=suggested — one-tap suggestions)
//   - commitments    (/v1/commitments?status=open)
//   - waiting threads (each bridge's LLM-ranked attention snapshot)
//
// Ranking is AI-native with a deterministic floor, mirroring the bridges'
// Attention Engine: a stable base order, then ONE control-plane LLM call that
// may only REORDER and ANNOTATE existing items. Any failure → base order.
//
// Pure module — unit-tested in brief.test.mts.

export type BriefKind = "hold" | "life_event" | "commitment" | "thread";

export interface BriefItem {
  /** Stable, unique across kinds: `${kind}:${id}`. */
  key: string;
  kind: BriefKind;
  id: string;
  title: string;
  detail: string;
  channel?: string;
  createdAt?: string;
  /** Deterministic weight; higher sorts first. */
  weight: number;
  /** LLM's one-line reason, set by applyRank. */
  why?: string;
}

export interface HoldSource {
  id: string;
  displayName: string;
  inboundText: string;
  draftText: string;
  channel: string;
  createdAt: string;
}

export interface LifeEventSource {
  id: string;
  kind: string;
  summary: string;
  urgency?: string;
  channel: string;
  createdAt: string;
}

export interface CommitmentSource {
  id: string;
  title: string;
  urgency: string;
  deadline?: string;
  sourcePreview?: string;
  createdAt: string;
}

export interface ThreadSource {
  id: string;
  label: string;
  why?: string;
  channel: string;
}

const URGENCY: Record<string, number> = { critical: 3, urgent: 3, now: 3, high: 2, soon: 2, medium: 1, normal: 1, low: 0, fyi: 0 };
const urgencyOf = (u?: string) => URGENCY[(u ?? "").toLowerCase()] ?? 1;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Merge every source into one list in the deterministic base order. */
export function buildBriefItems(src: {
  holds?: HoldSource[];
  lifeEvents?: LifeEventSource[];
  commitments?: CommitmentSource[];
  threads?: ThreadSource[];
  now?: number;
}): BriefItem[] {
  const now = src.now ?? Date.now();
  const age = (iso?: string) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? Math.max(0, now - t) / 3_600_000 : 0; // hours
  };
  const items: BriefItem[] = [];

  // A contact is waiting on a held reply: the most actionable thing there is.
  for (const h of src.holds ?? []) {
    items.push({
      key: `hold:${h.id}`, kind: "hold", id: h.id,
      title: `Reply to ${h.displayName || "a contact"}`,
      detail: clip(h.inboundText || h.draftText, 160),
      channel: h.channel, createdAt: h.createdAt,
      weight: 300 + Math.min(age(h.createdAt), 48),
    });
  }
  for (const e of src.lifeEvents ?? []) {
    items.push({
      key: `life_event:${e.id}`, kind: "life_event", id: e.id,
      title: e.summary || e.kind,
      detail: e.kind.replace(/_/g, " "),
      channel: e.channel, createdAt: e.createdAt,
      weight: 150 + urgencyOf(e.urgency) * 50,
    });
  }
  for (const c of src.commitments ?? []) {
    const due = c.deadline ? Date.parse(c.deadline) : NaN;
    const dueSoon = Number.isFinite(due) && due - now < 48 * 3_600_000 ? 60 : 0;
    items.push({
      key: `commitment:${c.id}`, kind: "commitment", id: c.id,
      title: c.title,
      detail: c.deadline ? `due ${c.deadline.slice(0, 10)}` : clip(c.sourcePreview ?? "", 120),
      createdAt: c.createdAt,
      weight: 100 + urgencyOf(c.urgency) * 30 + dueSoon,
    });
  }
  // Bridges already ranked these; keep their order with a falling weight.
  (src.threads ?? []).forEach((t, i) => {
    items.push({
      key: `thread:${t.channel}:${t.id}`, kind: "thread", id: t.id,
      title: t.label, detail: t.why ?? "waiting on you", channel: t.channel,
      weight: 120 - i,
    });
  });

  // De-dup by key (a thread can appear on both channels' snapshots).
  const seen = new Set<string>();
  return items
    .filter((it) => (seen.has(it.key) ? false : (seen.add(it.key), true)))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
}

export const RANK_SYSTEM_PROMPT = `You rank a person's "what needs you" list for today. Each line is one item: [key] kind — title — detail.
Put first what a thoughtful chief of staff would: people waiting on a reply, money, deadlines, safety (fraud), then the rest.
Output STRICT JSON ONLY: {"order":["key", ...], "why":{"key":"max 8 words"}}
- Use ONLY keys from the list. You may reorder and annotate; never add, merge, or drop items.`;

export function buildRankPrompt(items: BriefItem[]): string {
  return items.map((i) => `[${i.key}] ${i.kind} — ${clip(i.title, 100)} — ${clip(i.detail, 140)}`).join("\n");
}

/** Tolerant parse of the ranker's JSON. Unknown keys are dropped. */
export function parseRank(raw: string, items: BriefItem[]): { order: string[]; why: Record<string, string> } | null {
  const m = raw?.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  const known = new Set(items.map((i) => i.key));
  const order = Array.isArray(rec.order)
    ? [...new Set(rec.order.filter((k): k is string => typeof k === "string" && known.has(k)))]
    : [];
  const why: Record<string, string> = {};
  if (rec.why && typeof rec.why === "object") {
    for (const [k, v] of Object.entries(rec.why as Record<string, unknown>)) {
      if (known.has(k) && typeof v === "string" && v.trim()) why[k] = clip(v.trim(), 80);
    }
  }
  if (order.length === 0 && Object.keys(why).length === 0) return null;
  return { order, why };
}

/** Apply a rank: listed keys first in the model's order, the rest in base order. */
export function applyRank(items: BriefItem[], rank: { order: string[]; why: Record<string, string> } | null): BriefItem[] {
  if (!rank) return items;
  const byKey = new Map(items.map((i) => [i.key, i]));
  const placed = new Set<string>();
  const out: BriefItem[] = [];
  for (const k of rank.order) {
    const it = byKey.get(k);
    if (it) {
      out.push({ ...it, why: rank.why[k] ?? it.why });
      placed.add(k);
    }
  }
  for (const it of items) if (!placed.has(it.key)) out.push({ ...it, why: rank.why[it.key] ?? it.why });
  return out;
}

/** Cache key for a rank: the same set of items reuses the same ranking. */
export function rankCacheKey(items: BriefItem[]): string {
  return "pal-brief-rank:" + items.map((i) => i.key).sort().join("|");
}

export function greeting(hour: number): string {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
