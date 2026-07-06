// action-plan.ts — multi-action "plan-preview-confirm" for owner self-chat.
//
// The owner says one sentence bundling several actions ("tell Madhu I'll call
// tonight, snooze the lease thing, add fireworks Saturday 9pm"). The LLM
// decomposes it into a PLAN of discrete typed steps; the bridge shows ONE
// compact numbered preview; the owner confirms ONCE ("do it"), and the bridge
// executes each step through the EXISTING executors (calendar via mac-actions,
// reply drafts via the drafts rail, snooze via the attention/command path).
//
// This module is PURE: prompt / tolerant parse / preview / reply grammar /
// step-drop. All side effects (LLM call, execution, staging) live in the
// bridges. Every parse is best-effort and NEVER throws — a bad plan falls
// through to normal single-action handling.

/** 10-minute TTL on a staged (previewed, unconfirmed) plan. */
export const PLAN_TTL_MS = 10 * 60 * 1000;

export type PlanStep =
  | { kind: "message"; contact: string; body: string; summary?: string }
  | { kind: "calendar"; title: string; start: string; end?: string; notes?: string; summary?: string }
  | { kind: "note"; title: string; body?: string; summary?: string }
  | { kind: "snooze"; target: string; summary?: string };

export interface ActionPlan {
  steps: PlanStep[];
}

// ── Request detection (conservative heuristic — the LLM does the real work) ──
//
// This gate ONLY decides WHETHER to attempt an LLM plan. False negatives (a
// multi-action request slips to normal handling) are fine; false positives
// that hijack an ordinary message are NOT — so we require at least TWO
// action-verb-led clauses joined by a conjunction/comma.

const ACTION_VERB =
  "tell|text|message|msg|remind|remember|add|schedule|book|snooze|skip|defer|note|jot|email|mail|call|ring|send|ping|draft|cancel|move|reschedule|reply|nudge|let";
const VERB_LED = new RegExp(`^(?:${ACTION_VERB})\\b`, "i");
const CLAUSE_SPLIT = /\s*(?:,|;|\band\b|\bthen\b|\balso\b|&)\s*/i;

/** True when the text looks like ≥2 imperative action clauses bundled together. */
export function matchPlanRequest(text: string): boolean {
  const t = text.trim();
  if (t.length < 12 || t.length > 600) return false;
  // Must join clauses — a bare conjunction/comma somewhere in the middle.
  if (!/(?:,|;|\band\b|\bthen\b|\balso\b|&)/i.test(t)) return false;
  const clauses = t.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
  if (clauses.length < 2) return false;
  const verbLed = clauses.filter((c) => VERB_LED.test(c)).length;
  return verbLed >= 2;
}

// ── Plan decomposition (LLM) ────────────────────────────────────────────────

export interface PlanContext {
  now: Date;
  timezone?: string;
  /** Known contact names, to help the model bind "Madhu" to a real thread. */
  contacts?: string[];
}

export function buildPlanPrompt(request: string, ctx: PlanContext): string {
  const contacts = (ctx.contacts ?? []).filter(Boolean).slice(0, 40);
  return [
    "Decompose this owner request into a PLAN of discrete assistant actions. Each action is one of a small fixed set of step types. Do not invent actions the owner didn't ask for; do not merge two asks into one step.",
    `Owner request: "${request}"`,
    `Current time: ${ctx.now.toString()}${ctx.timezone ? ` (${ctx.timezone})` : ""}`,
    contacts.length ? `Known contacts: ${contacts.join(", ")}` : "",
    "",
    "Reply with STRICT JSON only:",
    '{"steps":[',
    '  {"kind":"message","contact":"<name or handle>","body":"<the gist to tell them, ≤200 chars>","summary":"text Madhu about the call"},',
    '  {"kind":"calendar","title":"<event title>","start":"YYYY-MM-DDTHH:MM:SS","end":"YYYY-MM-DDTHH:MM:SS (optional)","notes":"(optional)","summary":"add Fireworks Sat 9pm"},',
    '  {"kind":"note","title":"<note title>","body":"(optional)","summary":"note the lease terms"},',
    '  {"kind":"snooze","target":"<the attention item / thing to defer>","summary":"snooze the lease thing"}',
    "]}",
    "Rules: start/end are LOCAL wall-clock ISO (no timezone suffix). Resolve relative times (tonight, Saturday 9pm) against the current time above. 'summary' is ≤60 chars, owner-facing, lowercase. Only emit steps the request actually asks for. If NOTHING maps to a step, reply {\"steps\":[]}. Never invent facts about the owner.",
  ]
    .filter(Boolean)
    .join("\n");
}

const clampStr = (v: unknown, n: number): string => (typeof v === "string" ? v.trim().slice(0, n) : "");

function parseStep(raw: unknown): PlanStep | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const kind = typeof p.kind === "string" ? p.kind.trim().toLowerCase() : "";
  const summary = clampStr(p.summary, 60) || undefined;
  switch (kind) {
    case "message": {
      const contact = clampStr(p.contact, 100);
      const body = clampStr(p.body, 200);
      if (!contact || !body) return null;
      return { kind: "message", contact, body, summary };
    }
    case "calendar": {
      const title = clampStr(p.title, 140);
      const start = clampStr(p.start, 40);
      if (!title || !start) return null;
      const end = clampStr(p.end, 40) || undefined;
      const notes = clampStr(p.notes, 500) || undefined;
      return { kind: "calendar", title, start, end, notes, summary };
    }
    case "note": {
      const title = clampStr(p.title, 140);
      if (!title) return null;
      const body = clampStr(p.body, 1000) || undefined;
      return { kind: "note", title, body, summary };
    }
    case "snooze":
    case "skip": {
      const target = clampStr(p.target, 140);
      if (!target) return null;
      return { kind: "snooze", target, summary };
    }
    default:
      return null;
  }
}

/** Tolerant parse: extracts the JSON object, drops invalid steps, never
 *  throws. Returns null when unparseable or no valid step survives. */
export function parseActionPlan(raw: string): ActionPlan | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const arr = Array.isArray(obj.steps) ? obj.steps : [];
    const steps = arr.map(parseStep).filter((s): s is PlanStep => s !== null).slice(0, 12);
    if (steps.length === 0) return null;
    return { steps };
  } catch {
    return null;
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

function stepLine(s: PlanStep): string {
  if (s.summary) return s.summary;
  switch (s.kind) {
    case "message":
      return `text ${s.contact}: ${s.body}`;
    case "calendar":
      return `add "${s.title}" ${s.start.replace("T", " ")}`;
    case "note":
      return `note "${s.title}"`;
    case "snooze":
      return `snooze ${s.target}`;
  }
}

/** One compact numbered preview the owner confirms once. */
export function formatPlanPreview(plan: ActionPlan): string {
  const lines = plan.steps.map((s, i) => `${i + 1}. ${stepLine(s)}`);
  return [
    "🗂 here's the plan:",
    ...lines,
    `reply 'do it' to run all · '2 skip' to drop one · 'cancel' to scrap it`,
  ].join("\n");
}

// ── Owner reply grammar (confirm / drop-a-step / cancel) ──────────────────────

export type PlanReply = { confirm: true } | { drop: number } | { cancel: true } | null;

const CONFIRM_RE = /^(?:do it|yes+|yep|yeah|go|go ahead|send|send it|confirm|ok(?:ay)?|👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)$/i;
const CANCEL_RE = /^(?:cancel|nvm|nevermind|never mind|no|nope|scrap it|forget it|stop)$/i;
const DROP_RE = /^(?:(\d{1,2})\s*(?:skip|drop|x)|(?:skip|drop)\s*(\d{1,2}))$/i;

/** Parse an owner reply against a staged plan. Returns null (fall through)
 *  when it isn't a plan command. */
export function parsePlanReply(text: string): PlanReply {
  const t = text.trim();
  if (CONFIRM_RE.test(t)) return { confirm: true };
  if (CANCEL_RE.test(t)) return { cancel: true };
  const m = t.match(DROP_RE);
  if (m) {
    const n = parseInt(m[1] ?? m[2], 10);
    if (Number.isInteger(n) && n >= 1) return { drop: n };
  }
  return null;
}

/** Remove step `n` (1-based). Returns a new plan; unchanged if out of range. */
export function dropStep(plan: ActionPlan, n: number): ActionPlan {
  if (n < 1 || n > plan.steps.length) return plan;
  return { steps: plan.steps.filter((_, i) => i !== n - 1) };
}
