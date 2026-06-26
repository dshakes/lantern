// GMAIL INGESTION for the personal harness.
//
// Feeds the OWNER's email into the SAME channel-agnostic life-event engine that
// iMessage/WhatsApp use, so a bill / delivery / travel / fraud notice arriving by
// EMAIL gets the exact same proactive surface + auto-act path as one arriving by
// text. The bridge owns the always-on loop + the surfacing (surfaceLifeEvent);
// this module is the pure-ish poller:
//
//   * It does NOT do OAuth. The Gmail token lives (encrypted) in the
//     control-plane's connector_installs, so we call the control-plane connector
//     `gmail:list_recent` via an INJECTED execute fn (the bridge passes its
//     authedFetch-backed ConnectorClient). No secrets touch this module.
//   * It is OWNER-ONLY by construction: it reads the OWNER's own mailbox (the
//     mailbox behind the tenant's Gmail connector) and the bridge routes every
//     surface to owner self-chat.
//   * State (last-seen high-water mark + a bounded dedup set of message ids) is
//     persisted to ~/.lantern/gmail-poll-state.json (mode 0600) so a restart
//     never re-processes — and never double-surfaces — an email.
//   * It NEVER mutates the mailbox. list_recent is read-only.
//
// Design mirrors the other bridge-core modules: deterministic, dependency-light,
// I/O isolated behind injected hooks so unit tests run with a mock connector and
// a tmp state file (no live Gmail).

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// One normalized email message, flattened from the connector's `list_recent`
// response. `id` is the Gmail message id (dedup key); `internalDate` is the
// epoch-millis string Gmail returns (high-water mark).
export interface GmailIngestMessage {
  id: string;
  internalDate?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  date?: string;
}

// The injected connector call. Returns the raw connector JSON (or null on a
// transport error). The bridge supplies one backed by authedFetch so the Gmail
// OAuth token never leaves the control-plane. Mirrors ConnectorClient.execute.
export type GmailConnectorExecute = (
  connectorId: string,
  action: string,
  params: Record<string, string | number>,
) => Promise<unknown>;

// Persisted poller state. `seenIds` is an ordered (oldest-first) bounded set of
// Gmail message ids already processed; `lastInternalDate` is the max
// internalDate seen so far (used to build the `after:` query next tick).
export interface GmailPollState {
  lastInternalDate?: string; // epoch millis as string, Gmail's internalDate
  seenIds: string[];
}

const SEEN_CAP = 1000;

export function gmailPollStatePath(): string {
  return process.env.LANTERN_GMAIL_POLL_STATE || join(homedir(), ".lantern", "gmail-poll-state.json");
}

export function loadPollState(path = gmailPollStatePath()): GmailPollState {
  try {
    if (!existsSync(path)) return { seenIds: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GmailPollState>;
    return {
      lastInternalDate: typeof parsed.lastInternalDate === "string" ? parsed.lastInternalDate : undefined,
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds.filter((k) => typeof k === "string") : [],
    };
  } catch {
    return { seenIds: [] };
  }
}

export function savePollState(state: GmailPollState, path = gmailPollStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Bound the dedup set so the file never grows without limit.
    const seen = state.seenIds.length > SEEN_CAP ? state.seenIds.slice(state.seenIds.length - SEEN_CAP) : state.seenIds;
    writeFileSync(path, JSON.stringify({ lastInternalDate: state.lastInternalDate, seenIds: seen }, null, 0), { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort on filesystems w/o mode */ }
  } catch {
    /* persistence is best-effort — never throw into the bridge */
  }
}

// Build the Gmail search query for this tick. On the FIRST run (no high-water
// mark) we cap the lookback so a fresh install doesn't replay weeks of mail.
// After that we use `after:<epoch-seconds>` anchored just below the last-seen
// internalDate (Gmail's `after:` is second-granularity and inclusive, so we
// subtract 1s and rely on id-dedup to drop the boundary message).
export function buildPollQuery(state: GmailPollState, firstRunWindow = "newer_than:1d"): string {
  if (!state.lastInternalDate) return firstRunWindow;
  const ms = parseInt(state.lastInternalDate, 10);
  if (!Number.isFinite(ms) || ms <= 0) return firstRunWindow;
  const afterSec = Math.floor(ms / 1000) - 1;
  return `after:${afterSec}`;
}

// Normalize a connector message object into a GmailIngestMessage. Tolerant of
// the flattened `list_recent` shape AND, defensively, raw Gmail-API objects.
export function normalizeMessage(raw: unknown): GmailIngestMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : "";
  if (!id) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    id,
    internalDate: str(m.internalDate),
    from: str(m.from),
    subject: str(m.subject),
    snippet: str(m.snippet),
    date: str(m.date),
  };
}

// Render an email into the plain-text shape the life-event classifier expects —
// the same "From: …\nSubject: …\n<snippet>" form a transactional text would
// take. The classifier's regexes key off subject/snippet content.
export function emailToLifeEventText(msg: GmailIngestMessage): string {
  const lines: string[] = [];
  if (msg.from) lines.push(`From: ${msg.from}`);
  if (msg.subject) lines.push(`Subject: ${msg.subject}`);
  if (msg.snippet) lines.push(msg.snippet);
  return lines.join("\n").trim();
}

// Outcome of one poll: the NEW (previously-unseen) emails normalized into the
// ingest shape + classifier-ready text, plus the updated state to persist and a
// status the bridge logs on. `authExpired` flags the 401 / re-auth-needed path
// so the bridge can emit a single clear warning + back off (not spam).
export interface PollOutcome {
  status: "ok" | "auth_expired" | "error" | "disabled";
  newMessages: Array<{ message: GmailIngestMessage; text: string }>;
  nextState: GmailPollState;
  error?: string;
}

// Detect the expired/invalid-token signal in a connector error string. The
// control-plane surfaces the upstream Gmail "Gmail API error 401: …" verbatim;
// a missing OAuth token also returns a 401-class message.
export function isAuthExpiredError(err: string): boolean {
  const s = (err || "").toLowerCase();
  return (
    s.includes("401") ||
    s.includes("invalid credentials") ||
    s.includes("invalid_grant") ||
    s.includes("unauthorized") ||
    s.includes("requires an oauth access token") ||
    s.includes("re-auth")
  );
}

export interface PollOnceOpts {
  connectorId?: string;     // default "gmail"
  limit?: number;           // max messages to pull per tick (default 25)
  firstRunWindow?: string;  // default "newer_than:1d"
  state?: GmailPollState;   // injectable for tests; defaults to loadPollState()
  statePath?: string;       // where to persist (defaults to env/home)
  persist?: boolean;        // write state to disk (default true)
}

// Run ONE poll cycle. PURE w.r.t. the network (the connector call is injected)
// and side-effects only the state file (and only when `persist` is true). The
// bridge calls this on an interval and feeds each returned `text` into
// surfaceLifeEvent with channel:"email".
//
// Dedup contract: a message id present in state.seenIds is NEVER returned again.
// The high-water mark advances to the max internalDate observed this tick. The
// returned nextState already folds in the new ids (bounded) + the new mark.
export async function pollGmailOnce(
  execute: GmailConnectorExecute,
  opts: PollOnceOpts = {},
): Promise<PollOutcome> {
  const connectorId = opts.connectorId || "gmail";
  const limit = opts.limit ?? 25;
  const statePath = opts.statePath;
  const state = opts.state ?? loadPollState(statePath);
  const persist = opts.persist !== false;

  const query = buildPollQuery(state, opts.firstRunWindow);

  let result: unknown;
  try {
    result = await execute(connectorId, "list_recent", { query, limit });
  } catch (err) {
    return { status: "error", newMessages: [], nextState: state, error: String(err) };
  }

  // A null/falsey result is the ConnectorClient's transport-error signal.
  if (result == null) {
    return { status: "error", newMessages: [], nextState: state, error: "connector returned null" };
  }

  // The control-plane returns 4xx/5xx as a JSON { error: "..." }. Detect the
  // expired-token case so the bridge can warn-once + back off.
  const errStr = extractErrorString(result);
  if (errStr) {
    if (isAuthExpiredError(errStr)) {
      return { status: "auth_expired", newMessages: [], nextState: state, error: errStr };
    }
    return { status: "error", newMessages: [], nextState: state, error: errStr };
  }

  const rawMessages = extractMessages(result);
  const seen = new Set(state.seenIds);
  const newMessages: PollOutcome["newMessages"] = [];
  const newIds: string[] = [];
  let maxInternal = state.lastInternalDate ? parseInt(state.lastInternalDate, 10) : 0;
  if (!Number.isFinite(maxInternal)) maxInternal = 0;

  for (const raw of rawMessages) {
    const msg = normalizeMessage(raw);
    if (!msg) continue;
    if (seen.has(msg.id)) continue; // dedup — never process twice
    seen.add(msg.id);
    newIds.push(msg.id);
    if (msg.internalDate) {
      const d = parseInt(msg.internalDate, 10);
      if (Number.isFinite(d) && d > maxInternal) maxInternal = d;
    }
    const text = emailToLifeEventText(msg);
    if (text.length >= 4) newMessages.push({ message: msg, text });
  }

  const nextState: GmailPollState = {
    lastInternalDate: maxInternal > 0 ? String(maxInternal) : state.lastInternalDate,
    seenIds: [...state.seenIds, ...newIds],
  };

  if (persist && newIds.length > 0) savePollState(nextState, statePath);

  return { status: "ok", newMessages, nextState };
}

// ── response-shape helpers ──────────────────────────────────────────────────

function extractErrorString(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string" && r.error) return r.error;
  return undefined;
}

function extractMessages(result: unknown): unknown[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  return Array.isArray(r.messages) ? r.messages : [];
}
