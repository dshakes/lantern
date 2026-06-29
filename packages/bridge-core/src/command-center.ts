// command-center.ts — the owner's chat command-center UX (shared by both bridges).
//
// Both iMessage and WhatsApp are TEXT-ONLY (no buttons/lists), so "interactive"
// means a single, consistent NUMBERED action grammar + a scannable Brief. This
// module is PURE: composers take already-fetched data and return {text, items};
// the bridge owns fetching, the per-chat numbered-state, and executing actions.
//
// Surfaces (all reply with the SAME grammar):
//   • Brief        — the home view (observe + report + act). `?` / `today` / `brief`.
//   • plate        — all open commitments + drafts waiting.
//   • agents       — what each agent ran / next run / outcomes (observability).
//   • <domain>     — per-domain drill-down (health/vehicle/money/home/career).
//   • did          — auto-actions in the last 24h, each with one-tap undo.
//
// Unified action grammar (parseActionReply): `<n>` = default action;
//   `<n> send|done|skip|snooze [dur]|review|edit <text>|undo` = explicit;
//   `<n> <free text>` = custom (e.g. the owner's own version of a draft).

import type { Commitment } from "./commitments-edge.ts";

// ── Action grammar ──────────────────────────────────────────────────────────

export type ActionKind =
  | "act" // default: do the obvious thing for this item
  | "send" // send a waiting draft as-is
  | "done" // mark a commitment done
  | "skip" // dismiss / snooze-to-oblivion
  | "snooze" // defer (optional duration in arg)
  | "review" // show details / open the item
  | "edit" // replace a draft with the owner's text (arg)
  | "undo" // revert an auto-action
  | "save" // save the item to the readlist / todo
  | "custom"; // free-text the owner typed after the number

export type RefKind = "commitment" | "draft" | "life_event" | "auto_action" | "news_item";

/** One numbered, actionable line shown to the owner. The bridge maps `id`+`ref`
 *  back to the right rail (commitment resolve / draft send / cross-app execute /
 *  undo / save-to-readlist) when an action reply arrives. */
export interface BriefItem {
  n: number;
  ref: RefKind;
  id: string;
  icon: string;
  label: string;
  /** What a bare `<n>` does. */
  defaultAction: ActionKind;
  /** Actions offered in the hint text, in display order. */
  actions: ActionKind[];
  /** For news_item: the article URL (saved to the readlist). */
  url?: string;
}

export interface ParsedAction {
  item: BriefItem;
  action: ActionKind;
  /** snooze duration text, edit/custom body, etc. */
  arg?: string;
}

const CONFIRM_RE = /^(send|yes|y|ok|okay|go|do\s*it|approve|sure|yep|yup|👍|✅)$/i;
const DONE_RE = /^(done|complete|completed|resolve|resolved|finished?)$/i;
const SKIP_RE = /^(skip|no|n|nope|nah|dismiss|drop|ignore|👎)$/i;
const REVIEW_RE = /^(review|open|show|details?|view|info|more)$/i;
const UNDO_RE = /^(undo|revert|cancel\s*that)$/i;
const SAVE_RE = /^(save|read\s*later|readlist|bookmark|keep)$/i;
const SNOOZE_RE = /^(snooze|later|defer|remind|hold)\b\s*(.*)$/i;
const EDIT_RE = /^(edit|change|rewrite|reword)\b\s*(.*)$/i;

/**
 * Parse an owner reply against the last shown numbered list. Returns null when
 * the text isn't an action reply (so the caller falls through to normal chat).
 * The grammar is identical across every surface — that's the whole point.
 */
export function parseActionReply(text: string, items: BriefItem[]): ParsedAction | null {
  if (!items.length) return null;
  const t = text.trim();
  // Verb-first save: "save 3" / "bookmark 3" / "read later 3".
  const sv = t.match(/^(?:save|bookmark|keep|read\s*later)\s+(\d{1,2})\b/i);
  if (sv) {
    const it = items.find((i) => i.n === parseInt(sv[1], 10));
    if (it) return { item: it, action: "save" };
  }
  // Must start with the item number (1–99). Anything else is normal chat.
  const m = t.match(/^(\d{1,2})\b[.):]?\s*(.*)$/s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const item = items.find((i) => i.n === n);
  if (!item) return null;
  const rest = m[2].trim();

  if (rest === "") return { item, action: item.defaultAction };
  if (CONFIRM_RE.test(rest)) {
    // "send" confirms a draft; for a commitment it means "done".
    return { item, action: item.ref === "draft" ? "send" : "done" };
  }
  if (DONE_RE.test(rest)) return { item, action: "done" };
  if (SKIP_RE.test(rest)) return { item, action: "skip" };
  if (REVIEW_RE.test(rest)) return { item, action: "review" };
  if (UNDO_RE.test(rest)) return { item, action: "undo" };
  if (SAVE_RE.test(rest)) return { item, action: "save" };
  const sn = rest.match(SNOOZE_RE);
  if (sn) return { item, action: "snooze", arg: sn[2]?.trim() || undefined };
  const ed = rest.match(EDIT_RE);
  if (ed) return { item, action: "edit", arg: ed[2]?.trim() || undefined };
  // Any other free text after the number = the owner's own version / instruction.
  return { item, action: "custom", arg: rest };
}

// ── Command recognition (which surface to render) ───────────────────────────

export type NewsWindow = "today" | "week" | "month";
export interface NewsQuery {
  window?: NewsWindow;
  category?: string;
}
export type CenterCommand = "brief" | "plate" | "agents" | "did" | "readlist" | { news: NewsQuery } | { domain: string };

const NEWS_CATEGORIES = ["labs", "people", "coding-tools", "aggregators", "podcasts"];

const DOMAINS = ["health", "vehicle", "car", "money", "finance", "home", "household", "career", "work", "travel"];
const DOMAIN_ALIAS: Record<string, string> = {
  car: "vehicle",
  finance: "money",
  household: "home",
  work: "career",
};

/**
 * Recognise a command-center query in owner self-chat. Returns null when the
 * text isn't one (caller falls through to the assistant). Kept deliberately
 * small — `?` and `today` are the canonical "show me everything" entry points.
 */
export function parseCenterCommand(text: string): CenterCommand | null {
  const raw = text.trim().toLowerCase();
  // Strip trailing punctuation, but never empty out a bare "?" (the help entry).
  const t = raw.replace(/[.!?]+$/, "") || raw;
  if (t === "?" || t === "brief" || t === "today" || t === "home" || t === "summary" || t === "what's up" || t === "whats up") {
    return "brief";
  }
  if (t === "plate" || t === "pending" || t === "todo" || t === "to-do" || t === "what's pending" || t === "on my plate" || t === "what's on my plate") {
    return "plate";
  }
  if (t === "agents" || t === "agent status" || t === "harness" || t === "agents health" || t === "status agents") {
    return "agents";
  }
  if (t === "did" || t === "recap" || t === "what did you do" || t === "what did you do today" || t === "auto" || t === "auto-actions") {
    return "did";
  }
  if (t === "readlist" || t === "reading list" || t === "saved" || t === "bookmarks" || t === "read later") {
    return "readlist";
  }
  // news / radar [today|week|month|<category>]
  const nm = t.match(/^(?:news|radar)\s+(.+)$/);
  if (nm) {
    const mod = nm[1].trim();
    const q: NewsQuery = {};
    if (mod === "today" || mod === "day") q.window = "today";
    else if (mod === "week" || mod === "this week") q.window = "week";
    else if (mod === "month" || mod === "this month") q.window = "month";
    else if (NEWS_CATEGORIES.includes(mod)) q.category = mod;
    // unknown modifier → treat as a plain news pull
    return { news: q };
  }
  if (t === "news" || t === "radar" || t === "ai news" || t === "ai radar" || t === "ai" || t === "latest" || t === "what's new" || t === "whats new") {
    return { news: {} };
  }
  if (DOMAINS.includes(t)) return { domain: DOMAIN_ALIAS[t] ?? t };
  // "health?" / "show health" / "status health"
  const dm = t.match(/^(?:show|status|how(?:'s| is)?|my)\s+(\w+)$/);
  if (dm && DOMAINS.includes(dm[1])) return { domain: DOMAIN_ALIAS[dm[1]] ?? dm[1] };
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clip(s: string, n: number): string {
  s = (s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** ☀️ morning · 🌤 day · 🌙 night, from the local hour. */
function dayGlyph(d: Date): string {
  const h = d.getHours();
  if (h >= 5 && h < 12) return "☀️";
  if (h >= 12 && h < 18) return "🌤";
  return "🌙";
}

function fmtClock(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")}${ap}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function iconFor(c: Commitment): string {
  // Lightweight icon by title/urgency keyword.
  const t = c.title.toLowerCase();
  if (/bill|charge|\$|subscription|netflix|renew|price/.test(t)) return "💳";
  if (/appt|appointment|doctor|refill|prescription|health/.test(t)) return "🩺";
  if (/draft|reply|email|message/.test(t)) return "📨";
  if (/car|tesla|odyssey|service|vehicle|registration/.test(t)) return "🚗";
  if (/flight|trip|travel|hotel/.test(t)) return "✈️";
  if (c.urgency === "now") return "🔴";
  return "•";
}

// ── The Brief (home view) ───────────────────────────────────────────────────

export interface DraftWaiting {
  id: string;
  to: string;
  preview: string;
}

export interface LifeEventLite {
  id: string;
  kind: string;
  summary: string;
  status?: string;
  urgency?: string;
}

export interface BriefInput {
  now: Date;
  /** Short agent-activity lines for the last 24h, e.g. ["25 emails triaged", "3 bills scanned", "0 escalations"]. */
  agentActivity: string[];
  /** Open/suggested commitments that need the owner. */
  commitments: Commitment[];
  /** Drafts waiting for approval (VIP / low-confidence). */
  drafts: DraftWaiting[];
  /** Informational life-events (no decision needed). */
  fyi: LifeEventLite[];
  /** Max actionable items to number (keeps the Brief scannable). */
  maxItems?: number;
}

export interface CenterView {
  text: string;
  items: BriefItem[];
}

/** Compose the Brief: agent report + numbered "needs you" + fyi. Pure. */
export function buildBrief(input: BriefInput): CenterView {
  const { now } = input;
  const max = input.maxItems ?? 6;
  const items: BriefItem[] = [];
  const lines: string[] = [];

  lines.push(`${dayGlyph(now)} Your day · ${DAYS[now.getDay()]} ${fmtClock(now)}`);
  if (input.agentActivity.length) {
    lines.push(`agents (24h): ${input.agentActivity.join(" · ")}`);
  }

  // Needs-you: drafts first (time-sensitive), then commitments by urgency.
  let n = 1;
  const needs: string[] = [];
  for (const d of input.drafts) {
    if (n > max) break;
    const it: BriefItem = {
      n,
      ref: "draft",
      id: d.id,
      icon: "📨",
      label: `draft to ${clip(d.to, 24)} — “${clip(d.preview, 40)}”`,
      defaultAction: "review",
      actions: ["send", "edit", "skip"],
    };
    items.push(it);
    needs.push(` ${n} ${it.icon} ${it.label}  → "${n} send" / "${n} edit"`);
    n++;
  }
  const ranked = [...input.commitments].sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency));
  for (const c of ranked) {
    if (n > max) break;
    const draftable = c.status === "suggested" && !!c.action_plan; // researched → one-tap
    const it: BriefItem = {
      n,
      ref: "commitment",
      id: c.id,
      icon: iconFor(c),
      label: clip(c.title, 46) + (c.assignedBy ? ` (from ${clip(c.assignedBy, 14)})` : ""),
      defaultAction: draftable ? "review" : "done",
      actions: draftable ? ["act", "done", "snooze"] : ["done", "snooze", "skip"],
    };
    items.push(it);
    const hint = draftable ? `"${n}" to handle` : `"${n} done" / "${n} snooze"`;
    needs.push(` ${n} ${it.icon} ${it.label}  → ${hint}`);
    n++;
  }

  if (needs.length) {
    lines.push("");
    lines.push(`needs you (${needs.length})`);
    lines.push(...needs);
  } else {
    lines.push("");
    lines.push("needs you: nothing — you're clear ✨");
  }

  if (input.fyi.length) {
    const fyiTxt = input.fyi.slice(0, 4).map((e) => clip(e.summary, 38)).join(" · ");
    lines.push("");
    lines.push(`fyi: ${fyiTxt}`);
  }

  lines.push("");
  lines.push(`reply a number · "plate" · "agents" · "mute 2h"`);
  return { text: lines.join("\n"), items };
}

function urgencyRank(u?: string): number {
  switch (u) {
    case "now":
      return 0;
    case "soon":
      return 1;
    case "normal":
      return 2;
    default:
      return 3;
  }
}

// ── plate: all open commitments + drafts ────────────────────────────────────

export function buildPlate(commitments: Commitment[], drafts: DraftWaiting[]): CenterView {
  const items: BriefItem[] = [];
  const lines: string[] = [`🗂 on your plate (${commitments.length + drafts.length})`];
  let n = 1;
  for (const d of drafts) {
    items.push({ n, ref: "draft", id: d.id, icon: "📨", label: `draft to ${clip(d.to, 24)}`, defaultAction: "review", actions: ["send", "edit", "skip"] });
    lines.push(` ${n} 📨 draft to ${clip(d.to, 24)} — “${clip(d.preview, 36)}”  → "${n} send"`);
    n++;
  }
  const ranked = [...commitments].sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency));
  for (const c of ranked) {
    items.push({ n, ref: "commitment", id: c.id, icon: iconFor(c), label: clip(c.title, 46), defaultAction: "done", actions: ["done", "snooze", "skip"] });
    lines.push(` ${n} ${iconFor(c)} ${clip(c.title, 46)}${c.assignedBy ? ` (from ${clip(c.assignedBy, 12)})` : ""}  → "${n} done"`);
    n++;
  }
  if (n === 1) lines.push("nothing open — you're all clear ✨");
  else lines.push(`\nreply a number · "<n> done" / "<n> snooze 2h"`);
  return { text: lines.join("\n"), items };
}

// ── agents: harness observability ───────────────────────────────────────────

export interface AgentStat {
  name: string;
  /** "running" | "idle" | "failed" | "never" */
  health: string;
  lastRunAgo?: string; // "2m ago"
  lastOutcome?: string; // "3 fyi" / "12 records"
  nextRun?: string; // "6p" / "Mon 9a" / "on signal"
}

export function buildAgents(stats: AgentStat[]): string {
  const ok = stats.filter((s) => s.health === "running" || s.health === "idle").length;
  const failed = stats.filter((s) => s.health === "failed").length;
  const lines: string[] = [`🤖 agents — ${ok} healthy${failed ? ` · ⚠️ ${failed} failed` : ""} · ${stats.length} total`];
  for (const s of stats) {
    const dot = s.health === "failed" ? "🔴" : s.health === "never" ? "⚪" : "🟢";
    const bits = [s.name];
    if (s.lastRunAgo) bits.push(`ran ${s.lastRunAgo}`);
    if (s.lastOutcome) bits.push(`(${s.lastOutcome})`);
    if (s.nextRun) bits.push(`· next ${s.nextRun}`);
    lines.push(` ${dot} ${bits.join(" ")}`);
  }
  lines.push(`\nask a domain: "health" · "vehicle" · "money"`);
  return lines.join("\n");
}

// ── <domain> drill-down ─────────────────────────────────────────────────────

export interface DomainView {
  domain: string;
  recordCount: number;
  /** Next obligation/appointment, if any. */
  next?: string;
  /** Recent record headlines. */
  recent: string[];
  /** Open obligations in this domain. */
  obligations: string[];
}

const DOMAIN_ICON: Record<string, string> = {
  health: "🩺",
  vehicle: "🚗",
  money: "💳",
  home: "🏠",
  career: "💼",
  travel: "✈️",
};

export function buildDomain(v: DomainView): string {
  const icon = DOMAIN_ICON[v.domain] ?? "📂";
  const lines: string[] = [`${icon} ${v.domain} — ${v.recordCount} record${v.recordCount === 1 ? "" : "s"} tracked`];
  if (v.next) lines.push(`next: ${clip(v.next, 60)}`);
  if (v.obligations.length) {
    lines.push("");
    lines.push("open:");
    for (const o of v.obligations.slice(0, 5)) lines.push(` • ${clip(o, 56)}`);
  }
  if (v.recent.length) {
    lines.push("");
    lines.push("recent:");
    for (const r of v.recent.slice(0, 4)) lines.push(` • ${clip(r, 56)}`);
  }
  if (!v.next && !v.obligations.length && !v.recent.length) {
    lines.push("nothing tracked yet — I'll surface things as they come in.");
  }
  return lines.join("\n");
}

// ── did: auto-action recap with undo ────────────────────────────────────────

export interface AutoAction {
  id: string;
  label: string; // 'added "standup" to calendar'
  undoable: boolean;
}

export function buildDid(actions: AutoAction[]): CenterView {
  const items: BriefItem[] = [];
  if (!actions.length) return { text: "🤖 nothing auto-handled in the last 24h.", items };
  const lines: string[] = [`🤖 auto-handled today (${actions.length})`];
  let n = 1;
  for (const a of actions) {
    if (a.undoable) {
      items.push({ n, ref: "auto_action", id: a.id, icon: "↩️", label: a.label, defaultAction: "undo", actions: ["undo"] });
      lines.push(` ${n} ✓ ${clip(a.label, 54)}  → "${n} undo"`);
      n++;
    } else {
      lines.push(` • ✓ ${clip(a.label, 54)}`);
    }
  }
  if (items.length) lines.push(`\nreply "<n> undo" to revert any of these`);
  return { text: lines.join("\n"), items };
}

// ── news / radar: AI Radar feed (links included) ────────────────────────────

export interface NewsItemLite {
  source: string;
  category?: string;
  title: string;
  url: string;
  summary?: string;
  score?: number;
}

const NEWS_CAT_ICON: Record<string, string> = {
  labs: "🧪",
  people: "✍️",
  "coding-tools": "🛠",
  aggregators: "📰",
  podcasts: "🎙",
};

/** Render the AI Radar feed — ranked by score, grouped lightly, links included
 *  (the owner taps them in the message). Pure. */
const NEWS_WINDOW_LABEL: Record<NewsWindow, string> = {
  today: "today",
  week: "this week",
  month: "this month",
};

export function buildNews(items: NewsItemLite[], q?: NewsQuery): CenterView {
  const win = q?.window ? ` · ${NEWS_WINDOW_LABEL[q.window]} · top by popularity` : " · ≤5-min fresh";
  const cat = q?.category ? ` (${q.category})` : "";
  if (!items.length) {
    return { text: `📡 AI Radar${cat}${win} — nothing yet. Try "news week" or a category like "news coding-tools".`, items: [] };
  }
  // When a window is set the server already ranks by popularity; otherwise sort by score here.
  const ranked = q?.window ? items.slice(0, 12) : [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 12);
  const out: BriefItem[] = [];
  const lines: string[] = [`📡 AI Radar${cat} · ${items.length}${win}`, ""];
  let n = 1;
  for (const it of ranked) {
    const icon = (it.category && NEWS_CAT_ICON[it.category]) || "•";
    out.push({ n, ref: "news_item", id: it.url, icon, label: clip(it.title, 120), url: it.url, defaultAction: "save", actions: ["save"] });
    lines.push(` ${n} ${icon} ${clip(it.title, 70)} — ${clip(it.source, 22)}`);
    if (it.url) lines.push(`    ${it.url}`);
    n++;
  }
  lines.push("");
  lines.push(`"save 2" to keep · "readlist" to see saved · "news week"/"news labs" to filter`);
  return { text: lines.join("\n"), items: out };
}

// ── readlist: items the owner saved with "save <n>" ─────────────────────────

export interface ReadlistEntry {
  id: string;
  title: string;
  url?: string;
}

export function buildReadlist(entries: ReadlistEntry[]): CenterView {
  const items: BriefItem[] = [];
  if (!entries.length) {
    return { text: '📚 Readlist is empty — reply "save <n>" on any news item to keep it here.', items: [] };
  }
  const lines: string[] = [`📚 Readlist · ${entries.length} saved`, ""];
  let n = 1;
  for (const e of entries.slice(0, 20)) {
    items.push({ n, ref: "commitment", id: e.id, icon: "🔖", label: clip(e.title, 70), url: e.url, defaultAction: "done", actions: ["done"] });
    lines.push(` ${n} 🔖 ${clip(e.title, 70)}`);
    if (e.url) lines.push(`    ${e.url}`);
    n++;
  }
  lines.push("");
  lines.push(`"<n> done" to clear a saved item`);
  return { text: lines.join("\n"), items };
}
