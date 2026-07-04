// live-watch.ts — proactive follow-up on live, evolving situations.
//
// The gap this closes: a contact says "his flight got diverted, still in the
// air" and the bot replies "keep me posted" — then never follows up. A real
// person who cares checks FlightAware later and texts "just saw he landed".
//
// Flow (all LLM-reasoned, no keyword matching):
//   1. detectLiveWatch — after a contact reply is sent, one cheap LLM pass
//      decides whether the exchange references a live situation worth
//      tracking (flight in the air, delivery out, result pending) and, if
//      so, what to search for and what "done" looks like.
//   2. WatchStore — persists watches to <stateDir>/live-watches.jsonl
//      (mode 0600) so a bridge restart doesn't drop them.
//   3. checkLiveWatch — on the bridge's periodic tick, each due watch runs
//      a web_search-grounded LLM check ("has it landed?").
//   4. composeWatchFollowUp — when done, drafts ONE short follow-up in the
//      owner's voice; the bridge guards it with detectBotTells and sends.
//
// Caller responsibilities (the bridge): purpose-scoped session keys for
// every llmCall (`${jid}::watchdetect` etc. — NEVER the contact's live jid),
// killswitch/mute/quiet-hours gates before sending, and detectBotTells on
// the final text.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LiveWatch {
  id: string;
  jid: string;
  contactName?: string;
  /** Human description: "Sowmyadhar's Frontier flight FFT3990 diverted to Cincinnati, still in the air". */
  topic: string;
  /** Search query for the re-check: "Frontier flight 3990 status". */
  searchQuery: string;
  /** What resolves the watch: "the flight has landed". */
  doneCondition: string;
  createdTs: number;
  nextCheckTs: number;
  intervalMs: number;
  expiresTs: number;
  checks: number;
  status: "active" | "done" | "expired" | "failed";
  lastSummary?: string;
}

export type LlmCall = (prompt: string) => Promise<string>;

const FILE = "live-watches.jsonl";
const MAX_ACTIVE = 8;
const MAX_LINES = 200;
const MIN_INTERVAL_MIN = 15;
const MAX_INTERVAL_MIN = 120;
const MAX_WATCH_HOURS = 12;
const MAX_CHECKS = 20; // hard backstop against a watch that never resolves

/** Extract the first JSON object from an LLM reply (tolerates prose/fences). */
export function extractJson(text: string): Record<string, unknown> | null {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether this exchange references a LIVE situation worth tracking.
 * Returns a ready-to-store watch, or null. LLM-reasoned; fails closed.
 */
export async function detectLiveWatch(opts: {
  jid: string;
  contactName?: string;
  inbound: string;
  reply: string;
  recentTranscript?: string;
  llmCall: LlmCall;
  now?: number;
}): Promise<LiveWatch | null> {
  const now = opts.now ?? Date.now();
  const prompt = [
    `A contact just texted, and a reply was sent. Decide if this conversation references a LIVE, EVOLVING, PUBLICLY-CHECKABLE situation that a caring friend would check on later and follow up about unprompted.`,
    ``,
    `Track ONLY things the public internet can verify later: a flight in the air (status/diversion/landing), a launch, a game in progress, severe weather passing, an outage, breaking news developing. Do NOT track: private matters (someone's health, a personal call, "waiting for his call"), things already resolved, vague chit-chat, or anything with no public source to check.`,
    ``,
    opts.recentTranscript ? `Recent thread:\n${opts.recentTranscript.slice(-1500)}\n` : ``,
    `Their message: ${opts.inbound.slice(0, 500)}`,
    `Reply sent: ${opts.reply.slice(0, 300)}`,
    ``,
    `Output ONLY JSON, no prose:`,
    `{"watch": true|false, "topic": "one-line description with every identifier available (flight number, airline, names, places)", "searchQuery": "specific web search to re-check it", "doneCondition": "what resolves it, e.g. 'the flight has landed'", "checkMinutes": 15-120, "maxHours": 1-12}`,
    `If nothing qualifies: {"watch": false}`,
  ].join("\n");

  let raw = "";
  try {
    raw = await opts.llmCall(prompt);
  } catch {
    return null;
  }
  const j = extractJson(raw);
  if (!j || j.watch !== true) return null;
  const topic = typeof j.topic === "string" ? j.topic.trim() : "";
  const searchQuery = typeof j.searchQuery === "string" ? j.searchQuery.trim() : "";
  const doneCondition = typeof j.doneCondition === "string" ? j.doneCondition.trim() : "";
  if (!topic || !searchQuery || !doneCondition) return null;

  const checkMin = clamp(numberOr(j.checkMinutes, 30), MIN_INTERVAL_MIN, MAX_INTERVAL_MIN);
  const maxHours = clamp(numberOr(j.maxHours, 6), 1, MAX_WATCH_HOURS);
  const intervalMs = checkMin * 60_000;
  return {
    id: `${opts.jid}:${now}`,
    jid: opts.jid,
    contactName: opts.contactName,
    topic: topic.slice(0, 300),
    searchQuery: searchQuery.slice(0, 200),
    doneCondition: doneCondition.slice(0, 200),
    createdTs: now,
    nextCheckTs: now + intervalMs,
    intervalMs,
    expiresTs: now + maxHours * 3_600_000,
    checks: 0,
    status: "active",
  };
}

export interface WatchCheckResult {
  state: "done" | "ongoing" | "unknown";
  summary: string;
}

/**
 * Re-check one watch. llmSearchCall MUST be a web_search-capable turn
 * (respondTo with webSearch:true). Fails to "unknown" — never throws.
 */
export async function checkLiveWatch(watch: LiveWatch, llmSearchCall: LlmCall): Promise<WatchCheckResult> {
  const prompt = [
    `You are tracking a live situation: ${watch.topic}`,
    `Use the web_search tool NOW (query like: ${watch.searchQuery}) and determine: has this happened yet — ${watch.doneCondition}?`,
    ``,
    `Output ONLY JSON, no prose:`,
    `{"state": "done"|"ongoing"|"unknown", "summary": "one line of the CURRENT concrete facts you found (times, places, statuses)"}`,
    `"done" ONLY if a search result explicitly confirms it. If results are stale, conflicting, or missing: "unknown".`,
  ].join("\n");
  try {
    const raw = await llmSearchCall(prompt);
    const j = extractJson(raw);
    const state = j?.state;
    if (state === "done" || state === "ongoing" || state === "unknown") {
      return { state, summary: typeof j?.summary === "string" ? j.summary.slice(0, 400) : "" };
    }
  } catch {
    /* fall through */
  }
  return { state: "unknown", summary: "" };
}

/**
 * Draft the one-line follow-up text in the owner's voice. Returns null when
 * the LLM produced nothing usable. Caller MUST run detectBotTells before send.
 */
export async function composeWatchFollowUp(opts: {
  watch: LiveWatch;
  summary: string;
  ownerName: string;
  llmCall: LlmCall;
}): Promise<string | null> {
  const who = opts.watch.contactName ? ` to ${opts.watch.contactName}` : "";
  const prompt = [
    `You are ${opts.ownerName} texting${who} on WhatsApp. Earlier they were tracking this: ${opts.watch.topic}.`,
    `You just checked and found: ${opts.summary || opts.watch.doneCondition}.`,
    `Write ONE short casual follow-up text in ${opts.ownerName}'s voice, like you glanced at your phone and saw the news — e.g. "just saw the flight landed 🙏". Lowercase ok, under 15 words, no links, no greeting, no exclamation spam, no offer to help.`,
    `Output ONLY the message text.`,
  ].join("\n");
  try {
    const out = (await opts.llmCall(prompt))?.trim();
    if (!out || out.length > 200 || /\{|\}|NO_REPLY/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * JSONL-backed watch store. Whole-state rewrite on mutation (small N), so the
 * file is the source of truth across restarts. Best-effort I/O: failures
 * degrade to in-memory only, never throw.
 */
export class WatchStore {
  private watches: LiveWatch[] = [];
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, FILE);
    try {
      if (existsSync(this.path)) {
        this.watches = readFileSync(this.path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l) as LiveWatch;
            } catch {
              return null;
            }
          })
          .filter((w): w is LiveWatch => !!w && typeof w.jid === "string");
      }
    } catch {
      this.watches = [];
    }
  }

  /** One active watch per contact — a second live topic replaces nothing, it's skipped. */
  hasActive(jid: string, now: number = Date.now()): boolean {
    return this.watches.some((w) => w.jid === jid && w.status === "active" && w.expiresTs > now);
  }

  add(w: LiveWatch): boolean {
    const active = this.watches.filter((x) => x.status === "active").length;
    if (active >= MAX_ACTIVE || this.hasActive(w.jid, w.createdTs)) return false;
    this.watches.push(w);
    this.save();
    return true;
  }

  /** Active watches due for a check (nextCheckTs passed), expiring stale ones in place. */
  due(now: number = Date.now()): LiveWatch[] {
    let mutated = false;
    for (const w of this.watches) {
      if (w.status === "active" && (w.expiresTs <= now || w.checks >= MAX_CHECKS)) {
        w.status = "expired";
        mutated = true;
      }
    }
    if (mutated) this.save();
    return this.watches.filter((w) => w.status === "active" && w.nextCheckTs <= now);
  }

  update(w: LiveWatch): void {
    const i = this.watches.findIndex((x) => x.id === w.id);
    if (i >= 0) this.watches[i] = w;
    this.save();
  }

  all(): readonly LiveWatch[] {
    return this.watches;
  }

  private save(): void {
    try {
      // Prune terminal watches older than 48h so the file stays bounded.
      const cutoff = Date.now() - 48 * 3_600_000;
      this.watches = this.watches.filter((w) => w.status === "active" || w.createdTs > cutoff).slice(-MAX_LINES);
      writeFileSync(this.path, this.watches.map((w) => JSON.stringify(w)).join("\n") + (this.watches.length ? "\n" : ""), {
        mode: 0o600,
      });
    } catch {
      /* best-effort */
    }
  }
}

function numberOr(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
