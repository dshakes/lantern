// working-memory.ts — the bot's short-term memory of what the OWNER just did
// and what just changed, so a reply can SYNTHESIZE across recent actions + live
// signals instead of answering each turn statelessly.
//
// This is the fix for the "where did I go?" → "I can't tell" failure: the bot
// had just built a grocery list AND knew the owner was driving, but answered
// statelessly. CoALA/Letta call this the working-memory tier — a small,
// always-in-context record of recent decision cycles. Here it's owner-only and
// local: ~/.lantern/working-memory.jsonl (mode 0600), rolling ~6h window,
// capped. Pure-ish (fs only); path + now are injectable for tests.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";

export type ActionKind =
  | "status_set"      // owner away/status set
  | "list_made"       // built a list / saved structured items
  | "note_saved"      // saved an Apple note
  | "calendar_added"  // booked a calendar event
  | "call_placed"     // placed an outbound call
  | "message_sent"    // sent a reply to a contact on the owner's behalf
  | "presence"        // a notable presence/location transition
  | "custom";

export interface WorkingAction {
  ts: number;
  kind: ActionKind;
  summary: string; // human one-liner, e.g. "built grocery list from Manasa", "status set: driving"
}

const DEFAULT_PATH = join(homedir(), ".lantern", "working-memory.jsonl");
const WINDOW_MS = 6 * 3_600_000; // surface only the last 6h
const MAX_LINES = 200; // hard cap so the file can't grow unbounded
const MAX_SHOWN = 12;

export interface WMOpts {
  path?: string;
  nowMs?: number;
}

/** Record one owner action / observed transition. Best-effort: never throws
 *  into the reply path. Call this at the side-effect sites that already exist
 *  (marker exec, note save, status set, outbound send). */
export function recordAction(a: { kind: ActionKind; summary: string; ts?: number }, opts: WMOpts = {}): void {
  const path = opts.path ?? DEFAULT_PATH;
  const ts = a.ts ?? opts.nowMs ?? Date.now();
  const summary = (a.summary || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!summary) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts, kind: a.kind, summary } satisfies WorkingAction) + "\n", { mode: 0o600 });
    trim(path);
  } catch {
    /* best-effort — working memory must never break a reply */
  }
}

function trim(path: string): void {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) {
      writeFileSync(path, lines.slice(-MAX_LINES).join("\n") + "\n", { mode: 0o600 });
    }
  } catch {
    /* ignore */
  }
}

/** Recent actions inside the window, newest-first. */
export function recentActions(opts: WMOpts = {}): WorkingAction[] {
  const path = opts.path ?? DEFAULT_PATH;
  const now = opts.nowMs ?? Date.now();
  if (!existsSync(path)) return [];
  const out: WorkingAction[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const a = JSON.parse(t) as WorkingAction;
        if (a && a.summary && typeof a.ts === "number" && a.ts >= now - WINDOW_MS) out.push(a);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, MAX_SHOWN);
}

const KIND_ICON: Record<ActionKind, string> = {
  status_set: "📍", list_made: "🛒", note_saved: "🗒", calendar_added: "📅",
  call_placed: "📞", message_sent: "✉️", presence: "📡", custom: "•",
};

/** The prompt block injected into the owner self-chat context. The directive is
 *  the load-bearing part — it MANDATES synthesis so the bot stops answering
 *  "I can't tell" when recent actions + live signals support a reasonable
 *  inference. Empty string when there's nothing recent. */
export function workingMemoryBlock(opts: WMOpts = {}): string {
  const now = opts.nowMs ?? Date.now();
  const acts = recentActions(opts);
  if (!acts.length) return "";
  const ago = (ts: number): string => {
    const m = Math.max(0, Math.round((now - ts) / 60000));
    return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };
  const lines = [
    '## What just happened (last few hours)',
    'SYNTHESIZE these recent actions with the live signals above. For a where/what/who question, if they support a reasonable inference, give it confidently (say what you\'re inferring from) — do NOT default to "I can\'t tell" when this context is right here.',
  ];
  for (const a of acts) lines.push(`- ${KIND_ICON[a.kind] ?? "•"} ${a.summary} (${ago(a.ts)})`);
  return lines.join("\n");
}
