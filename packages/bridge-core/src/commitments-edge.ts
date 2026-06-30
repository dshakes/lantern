// commitments-edge.ts — Concierge bridge edge: capture tasks into Lantern
// commitments, render 1-click nudges to the owner, execute owner replies.
//
// Design rules (mirrors life-events-emit.ts):
//   * PURE-ISH: detectTaskCapture / renderNudge / resolveReply have no I/O.
//     CommitmentsClient wraps the API via an injected fetch function.
//   * HIGH-PRECISION capture: false captures spam the owner — prefer misses.
//   * OWNER-ONLY: never surfaces a commitment to a contact; caller must gate.
//   * DEFAULT OFF: whole edge is gated by LANTERN_CONCIERGE=on in session.ts.

// ── API types (mirrors /v1/commitments contract) ──────────────────────────────

export interface CommitmentStep {
  title: string;
  detail?: string;
  link?: string;
  deadline?: string;
  oneClick?: string;
}

export interface CommitmentActionPlan {
  summary: string;
  steps: CommitmentStep[];
  sources?: Array<{ title: string; url: string }>;
}

export interface Commitment {
  id: string;
  title: string;
  assignedBy?: string;
  status: string;
  kind?: string;
  tier?: string;
  urgency?: string;
  deadline?: string;
  next_nudge_at?: string;
  action_plan?: CommitmentActionPlan;
  source_preview?: string;
}

// ── detectTaskCapture ─────────────────────────────────────────────────────────

/** Context from the inbound handler. Passed through but not used in rules. */
export interface TaskCaptureCtx {
  /** Relationship label of the sender (e.g. "wife", "brother"). Informational. */
  relationship?: string;
}

/** Detected task from an inbound message. */
export interface CapturedTask {
  /** Cleaned title / description of the task. */
  title: string;
  /** Best-effort urgency derived from the text. */
  urgency?: "now" | "soon" | "normal" | "fyi";
}

// Second-person imperative triggers. Each regex captures the task body in group 1.
// Ordered most-specific first. Min 5 chars, max 150 chars for the body.
const TASK_TRIGGERS: RegExp[] = [
  /\bdon'?t\s+forget\s+to\s+(.{5,150})/i,
  /\bremember\s+to\s+(.{5,150})/i,
  /\bmake\s+sure\s+(?:to\s+)?(.{5,150})/i,
  /\byou\s+(?:need|have|got)\s+to\s+(.{5,150})/i,
  /\bi\s+need\s+you\s+to\s+(.{5,150})/i,
  /\b(?:can|could)\s+you\s+(?:please\s+)?(.{5,150})/i,
  /\bplease\s+(?:do\s+|go\s+ahead\s+and\s+)?(.{5,150})/i,
  /\byou\s+should\s+(?:really\s+)?(.{5,150})/i,
];

// Patterns that look like triggers but are actually questions/social phrases.
// If the captured body matches any of these, suppress the capture.
const NOISE_BODY_RE =
  /^(?:tell\s+me|explain|let\s+me\s+know\s+(?:if|when|what|how|whether)|show\s+me|understand|believe|imagine|call\s+me\s+(?:back\s+)?(?:on\s+my|at|when)|know\s+(?:if|what|when|how))\b/i;

// Single-word or very-short bodies ("can you please?", "could you?", "r u?").
// A real task needs at least 2 words to be meaningful ("call doctor", "file taxes").
const TOO_SHORT_BODY_RE = /^\S{0,4}$|^\S+[?.!,;]?\s*$/; // 0 spaces → single word

// Urgency keywords in the full text.
const URGENCY_NOW_RE = /\b(?:urgent|asap|right\s+now|immediately|emergency)\b/i;
const URGENCY_SOON_RE = /\b(?:today|tonight|this\s+morning|this\s+afternoon|by\s+(?:end\s+of\s+)?today|soon|as\s+soon\s+as\s+possible)\b/i;

/**
 * HIGH-PRECISION detection of an assignment/task in an inbound message.
 * Returns null on no match. Prefer misses over false-positives — a false
 * capture spams the owner with a commitment they didn't assign.
 */
export function detectTaskCapture(text: string, _ctx?: TaskCaptureCtx): CapturedTask | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length < 8) return null;

  for (const re of TASK_TRIGGERS) {
    const m = t.match(re);
    if (!m) continue;
    const body = m[1].replace(/[?.!,;]+$/, "").trim();
    if (!body || TOO_SHORT_BODY_RE.test(body)) continue;
    if (NOISE_BODY_RE.test(body)) continue;

    // Clean up the title: trim trailing filler.
    const title = body.replace(/\s+(?:ok|ok\?|please|right\?|yeah\?)$/i, "").trim();
    if (title.length < 5) continue;

    const urgency: CapturedTask["urgency"] = URGENCY_NOW_RE.test(t)
      ? "now"
      : URGENCY_SOON_RE.test(t)
        ? "soon"
        : "normal";

    return { title, urgency };
  }
  return null;
}

/**
 * Intelligent task capture: the high-precision regex is the fast, free path
 * (returned verbatim when it hits — preserves the conservative no-false-positive
 * behavior). When it MISSES but the message plausibly asks the owner to do
 * something ("would be great if you grabbed milk", "mind picking up the dry
 * cleaning?" — phrasings no template matches), an injected LLM is the real
 * extractor: it decides whether a task was actually assigned, and returns a
 * clean title + urgency. The cheap pre-filter keeps the LLM off non-requests.
 * Returns null when nothing was assigned.
 */
export async function captureTaskWithLlm(
  text: string,
  ctx: TaskCaptureCtx | undefined,
  llmCall?: (prompt: string) => Promise<string>,
): Promise<CapturedTask | null> {
  const regexHit = detectTaskCapture(text, ctx);
  if (regexHit) return regexHit; // precise + free — no LLM needed
  if (!llmCall) return null;

  const t = (text || "").replace(/\s+/g, " ").trim();
  // Pre-filter: cheaply skip the LLM on text that can't be a request. A real
  // assignment either addresses the owner, uses a request/imperative cue, or is
  // a question — but never trivially short/long. Deliberately generous (this
  // only runs on known-relationship contacts) so it doesn't DROP a real task;
  // the LLM makes the final call.
  if (t.length < 12 || t.length > 400) return null;
  const requestCue =
    /\b(you|u|ya|your|pls|plz|please|mind|chance|appreciate|need|want|pick|grab|drop|bring|remember|forget|get|send|call|text|book|order|return|handle|sort)\b/i;
  if (!requestCue.test(t) && !t.includes("?")) return null;

  const prompt =
    `A message arrived from ${ctx?.relationship ? `the owner's ${ctx.relationship}` : "a known contact"}. ` +
    `Decide if it ASKS THE OWNER to do a concrete task/errand/to-do (something the owner should DO). ` +
    `A polite request phrased as a question still counts ("mind picking up X?", "any chance you could grab Y?", "would you call Z?"). ` +
    `An INFORMATIONAL question ("do you think…?", "what time…?"), an FYI, banter, or a plan with no action assigned is NOT a task. ` +
    `Return STRICT minified JSON, nothing else: {"isTask":boolean,"title":"<imperative, owner's to-do, <=80 chars>","urgency":"now"|"soon"|"normal"}. ` +
    `title is verb-first ("pick up the dry cleaning"), no "you"; urgency 'now' only if explicitly urgent.\n` +
    `Message:\n"""${t}"""\nJSON:`;

  let raw: string;
  try {
    raw = await llmCall(prompt);
  } catch {
    return null;
  }
  const m = raw && raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: { isTask?: unknown; title?: unknown; urgency?: unknown };
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (obj.isTask !== true || typeof obj.title !== "string") return null;
  const title = obj.title.replace(/[?.!,;]+$/, "").trim();
  if (title.length < 5 || title.length > 150) return null;
  const urgency: CapturedTask["urgency"] =
    obj.urgency === "now" || obj.urgency === "soon" || obj.urgency === "normal" ? obj.urgency : "normal";
  return { title, urgency };
}

// ── detectOutboundPromise ─────────────────────────────────────────────────────

/** A promise the bot made in the owner's name on a contact thread
 *  ("I'll send you the deck tonight") that nothing yet tracks. */
export interface OutboundPromise {
  /** The commitment body, verb-first ("send you the deck tonight"). */
  title: string;
  urgency?: "now" | "soon" | "normal";
}

// First-person future marker ("I'll" / "I will" / "I'm going to" / "I'm gonna").
const PROMISE_FUTURE = String.raw`i(?:'?ll|\s+will|'?m\s+gonna|\s+gonna|'?m\s+going\s+to|\s+am\s+going\s+to)`;
// Concrete action verbs — mirrors verifiable-claims.ts (send/email/forward/add/
// book/call/…) plus a few delivery/follow-up verbs. Conservative on purpose:
// a hedge ("I'll try", "I'll see", "I'll be there") has no whitelisted verb and
// is therefore NOT captured — a false promise spams the owner with a nudge they
// never made.
const PROMISE_VERB = String.raw`(?:send|email|e-?mail|forward|share|add|book|reserve|call|ring|text|message|ping|bring|drop|check|confirm|schedule|sort|handle|remind|get\s+back|pick\s+up|set\s+up|follow\s+up|let\s+you\s+know|make\s+sure|find\s+out|look\s+into)`;
const PROMISE_RE = new RegExp(`\\b${PROMISE_FUTURE}\\s+(${PROMISE_VERB}\\b[^.!?\\n]{0,120})`, "i");

/**
 * Detect a promise the bot just made in an OUTBOUND reply. High-precision:
 * requires a first-person future marker + a concrete action verb. Returns null
 * on no match (the common case). The caller records the hit as an owner
 * commitment so the anticipation engine can later nudge "still on your plate: …".
 */
export function detectOutboundPromise(text: string): OutboundPromise | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m = t.match(PROMISE_RE);
  if (!m) return null;
  const title = m[1].replace(/[?.!,;]+$/, "").trim();
  if (title.length < 5) return null;
  const urgency: OutboundPromise["urgency"] = URGENCY_NOW_RE.test(t)
    ? "now"
    : URGENCY_SOON_RE.test(t)
      ? "soon"
      : "normal";
  return { title, urgency };
}

// ── renderNudge ───────────────────────────────────────────────────────────────

/**
 * Render a commitment as an owner-facing 1-click line, mirroring the
 * life-events UX. If an action_plan is present, includes its summary
 * and up to 3 step oneClick hints.
 *
 * Example (no plan):
 *   📌 Apply for naturalization (from Manu) — reply: research · snooze · done
 *
 * Example (with plan):
 *   📌 Apply for naturalization (from Manu) — reply: research · snooze · done
 *   → Check USCIS website, gather documents, schedule appointment
 *   • Check USCIS N-400 form on uscis.gov
 */
export function renderNudge(c: Commitment): string {
  const from = c.assignedBy ? ` (from ${c.assignedBy})` : "";
  let out = `📌 ${c.title}${from} — reply: research · snooze · done`;

  if (c.action_plan) {
    out += `\n→ ${c.action_plan.summary}`;
    const oneClicks = c.action_plan.steps
      .slice(0, 3)
      .map((s) => s.oneClick)
      .filter((s): s is string => !!s);
    if (oneClicks.length > 0) {
      out += "\n• " + oneClicks.join("\n• ");
    }
  }

  return out;
}

// ── resolveReply ──────────────────────────────────────────────────────────────

/** A pending 1-click nudge the owner can resolve via self-chat. */
export interface PendingCommitmentNudge {
  id: string;
  title: string;
  assignedBy?: string;
  issuedAt: number;
}

/** An action resolved from the owner's 1-click reply. */
export interface CommitmentAction {
  type: "research" | "snooze" | "done" | "dismiss";
  /** ISO string for snooze end (only present when type="snooze"). */
  snoozeUntil?: string;
}

/**
 * Map an owner's self-chat reply to a commitment action, or return null.
 * Pure: `now` is injectable so callers and tests can control the clock.
 *
 * Recognized tokens (case-insensitive, trimmed):
 *   research | r         → {type: "research"}
 *   done     | ✅        → {type: "done"}
 *   dismiss  | skip | d  → {type: "dismiss"}
 *   snooze [spec]        → {type: "snooze", snoozeUntil: <ISO>}
 *     spec forms: "2h" "30m" "1d" "tomorrow" (default: 3h)
 */
export function resolveReply(
  text: string,
  _pending: PendingCommitmentNudge,
  now: number = Date.now(),
): CommitmentAction | null {
  const t = (text || "").trim().toLowerCase();
  if (!t) return null;

  if (t === "research" || t === "r") return { type: "research" };
  if (t === "done" || t === "✅" || t === "complete" || t === "finished") return { type: "done" };
  if (t === "dismiss" || t === "skip" || t === "d" || t === "ignore") return { type: "dismiss" };

  // "snooze" or "snooze <spec>"
  const snoozeM = t.match(/^snooze(?:\s+(.+))?$/);
  if (snoozeM) {
    return { type: "snooze", snoozeUntil: computeSnoozeUntil(snoozeM[1]?.trim(), now) };
  }

  return null;
}

function computeSnoozeUntil(spec: string | undefined, now: number): string {
  if (!spec) return new Date(now + 3 * 60 * 60_000).toISOString(); // default 3h

  const s = spec.toLowerCase();

  if (s === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  // "Xm" / "X min" / "X minutes"
  const m = s.match(/^(\d+)\s*(?:m(?:in(?:utes?)?)?)?$/);
  if (m && s.match(/m/)) return new Date(now + parseInt(m[1], 10) * 60_000).toISOString();

  // "Xh" / "X hr" / "X hours"
  const h = s.match(/^(\d+)\s*(?:h(?:rs?|ours?)?)?$/);
  if (h && s.match(/h/)) return new Date(now + parseInt(h[1], 10) * 60 * 60_000).toISOString();

  // "Xd" / "X days"
  const d = s.match(/^(\d+)\s*(?:d(?:ays?)?)?$/);
  if (d && s.match(/d/)) return new Date(now + parseInt(d[1], 10) * 24 * 60 * 60_000).toISOString();

  return new Date(now + 3 * 60 * 60_000).toISOString(); // unrecognized → 3h
}

// ── CommitmentsClient ─────────────────────────────────────────────────────────

/** Minimal fetch signature — matches authedFetch and test mocks. */
export type CommitmentsFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Wraps /v1/commitments API calls. All methods are best-effort (never throw). */
export class CommitmentsClient {
  constructor(private readonly fetchFn: CommitmentsFetch) {}

  /** POST /v1/commitments → {id}. Returns null on any failure. */
  async create(req: {
    title: string;
    source: string;
    assignedBy?: string;
    urgency?: string;
    idempotencyKey?: string;
    sourcePreview?: string;
    kind?: string;
  }): Promise<{ id: string } | null> {
    try {
      const res = await this.fetchFn("/v1/commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { id?: string };
      return data.id ? { id: data.id } : null;
    } catch {
      return null;
    }
  }

  /** GET /v1/commitments → Commitment[]. Returns [] on any failure. */
  async list(params?: { status?: string; limit?: number }): Promise<Commitment[]> {
    try {
      const parts: string[] = [];
      if (params?.status) parts.push(`status=${encodeURIComponent(params.status)}`);
      if (params?.limit != null) parts.push(`limit=${encodeURIComponent(String(params.limit))}`);
      const q = parts.join("&");
      const res = await this.fetchFn(`/v1/commitments${q ? "?" + q : ""}`);
      if (!res.ok) return [];
      return (await res.json()) as Commitment[];
    } catch {
      return [];
    }
  }

  /**
   * POST /v1/commitments/{id}/research → ActionPlan. Returns null on failure.
   * Sets the commitment's status to 'suggested' server-side.
   */
  async research(id: string): Promise<CommitmentActionPlan | null> {
    try {
      const res = await this.fetchFn(`/v1/commitments/${encodeURIComponent(id)}/research`, {
        method: "POST",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Partial<CommitmentActionPlan>;
      if (!data.summary) return null;
      return { summary: data.summary, steps: data.steps ?? [], sources: data.sources };
    } catch {
      return null;
    }
  }

  /** POST /v1/commitments/{id}/snooze {until: ISO}. */
  async snooze(id: string, until: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(`/v1/commitments/${encodeURIComponent(id)}/snooze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ until }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** POST /v1/commitments/{id}/done. */
  async done(id: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(`/v1/commitments/${encodeURIComponent(id)}/done`, { method: "POST" });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** POST /v1/commitments/{id}/dismiss. */
  async dismiss(id: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(`/v1/commitments/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// Self-chat prefixes this module emits — re-exported so bot-self.ts
// stays in sync and the bridge never replies to its own concierge messages.
export const CONCIERGE_SELF_PREFIXES: string[] = [
  "📝 tracking:", // task-capture ack
  "📌 ",          // commitment nudge
];
