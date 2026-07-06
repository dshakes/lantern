// time-travel.ts — "what happened while I was out" narrative recap.
//
// The owner asks (`what did I miss`, `what happened while I was gone`) and the
// bridge synthesizes a SHORT narrative across everything that landed since a
// cutoff — inbound messages, life-events (bills/deliveries/OTP/fraud), and the
// autonomous actions the assistant took (skills fired, auto-replies, bookings).
// Not a list — a story, with the 1-2 things that actually matter surfaced.
//
// PURE module: gathering is the bridge's job (it owns chat.db / life-events /
// working-memory); this owns the request grammar, the synthesis prompt, and a
// tolerant parse. The LLM writes the narrative — nothing here is templated
// beyond a deterministic fallback so a compose failure still says something
// true.

/** One thing that happened in the window, already resolved to a display line
 *  by the bridge. `weight` lets the caller pre-rank; the LLM still decides the
 *  final emphasis. */
export interface RecapItem {
  kind: "message" | "life_event" | "auto_action" | "commitment" | "nudge";
  /** Who/what it's about (contact name, merchant, skill name). */
  subject: string;
  /** One-line detail — already privacy-safe (bridge redacts). */
  detail: string;
  at: number;
  /** 0..3 — higher = more likely to matter (fraud alert > promo). */
  weight?: number;
}

export interface RecapRequest {
  /** Milliseconds; the owner's "while I was out" start. */
  since: number;
  now: number;
  items: RecapItem[];
}

const RECAP_RE =
  /^(?:what(?:'s| is| did| ha(?:ppened|ve i missed))?\s*(?:i\s+)?miss(?:ed)?|what happened|catch me up(?: on everything)?|what'?d i miss|recap|while i was (?:out|gone|away|heads?-?down))\b.*$/i;

/** True when the owner is asking for a time-travel recap (self-chat only). */
export function looksLikeRecapRequest(text: string): boolean {
  const t = text.trim();
  if (t.length > 80) return false; // a recap ask is short; longer = a real message
  return RECAP_RE.test(t);
}

/** Optional explicit window: "what did I miss in the last 3 hours / today".
 *  Returns a cutoff ms, or null to use the caller's default (e.g. last-seen). */
export function parseRecapWindow(text: string, now: number): number | null {
  const t = text.toLowerCase();
  const m = t.match(/last\s+(\d{1,2})\s*(min(?:ute)?s?|h(?:our)?s?|days?)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2][0] === "m" ? 60_000 : m[2][0] === "h" ? 3_600_000 : 86_400_000;
    return now - n * unit;
  }
  if (/\btoday\b/.test(t)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (/\bovernight\b|\bwhile i (?:was )?(?:asleep|slept)\b/.test(t)) return now - 9 * 3_600_000;
  return null;
}

function humanGap(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return "the last hour";
  if (h < 24) return `the last ${h}h`;
  const d = Math.round(h / 24);
  return `the last ${d}d`;
}

/** Build the narrative-synthesis prompt. The model gets the raw items and is
 *  told to write a SHORT recap that leads with what matters, not enumerate. */
export function buildRecapPrompt(req: RecapRequest): string {
  const window = humanGap(req.now - req.since);
  const lines = req.items
    .slice()
    .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || a.at - b.at)
    .map((it) => `- [${it.kind}] ${it.subject}: ${it.detail}`);
  return [
    `Write the owner a quick recap of what happened in ${window}. You are their assistant catching them up — talk like a person, not a report.`,
    "",
    "What landed:",
    ...lines,
    "",
    "Rules: lead with the 1-2 things that actually need them (money, someone waiting, anything time-sensitive); compress the rest into a sentence; if nothing matters say so plainly. 3-5 short lines max. Never invent anything not listed. No headers, no bullet dump.",
  ].join("\n");
}

/** Deterministic fallback recap — used when the LLM call fails. Truthful,
 *  never invents; just terse. */
export function buildRecapFallback(req: RecapRequest): string {
  if (req.items.length === 0) return `nothing while you were out — all quiet.`;
  const ranked = req.items.slice().sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || a.at - b.at);
  const top = ranked.slice(0, 4).map((it) => `• ${it.subject}: ${it.detail}`);
  const more = ranked.length > 4 ? `\n(+${ranked.length - 4} more)` : "";
  return `while you were out (${humanGap(req.now - req.since)}):\n${top.join("\n")}${more}`;
}

/** Trim/clean an LLM recap; falls back to deterministic when empty. */
export function finalizeRecap(raw: string | null | undefined, req: RecapRequest): string {
  const t = (raw ?? "").trim();
  if (!t) return buildRecapFallback(req);
  return t;
}
