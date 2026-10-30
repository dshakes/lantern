// Ask PAL — the dashboard's natural-language command layer (⌘K, the home
// command bars, AI-suggested next steps).
//
// Flow: the browser sends the command plus a COMPACT, real context (names,
// counts, ids the dashboard already loaded) to the control-plane's
// /v1/completions with model "auto" — the control-plane routes it
// (capability-addressed, metered, budgeted). The browser never talks to a
// provider. The model returns ONE strict-JSON action; this module validates it
// against the context so the model cannot invent a run id, a VM id, or a route.
//
// Mutations are never executed from the model's word alone: `requiresConfirm`
// marks them and the UI shows exactly what will happen before anything runs.
//
// Pure module (no React, no fetch) — unit-tested in assistant.test.mts.

export interface AssistContext {
  mode: "pal" | "runtime";
  agentNames: string[];
  runCountsByStatus: Record<string, number>;
  /** Recent failed runs the model may reference by id. */
  failedRuns: Array<{ id: string; agentName: string }>;
  /** Running microVMs the model may reference by id; idle minutes when known. */
  runningVms: Array<{ id: string; idleMinutes: number | null; upMinutes?: number | null }>;
  /** Counts for the personal layer, when loaded. */
  pal?: { heldReplies?: number; openCommitments?: number };
}

export type RuntimeOp = "pause" | "resume" | "terminate";

export type AssistAction =
  | { kind: "navigate"; path: string; summary: string }
  | { kind: "answer"; answer: string; summary: string }
  | { kind: "create_agent"; description: string; summary: string }
  | { kind: "explain_run"; runId: string; summary: string }
  | { kind: "vm_action"; op: RuntimeOp; vmIds: string[]; summary: string };

/** Dashboard routes the model may navigate to (prefix match). */
export const ROUTE_ALLOWLIST = [
  "/brief", "/personal", "/automations", "/voice",
  "/overview", "/agents", "/runs", "/inbox", "/runtime", "/deployments", "/eval-suites",
  "/evaluations", "/experiments", "/budgets", "/connectors", "/surfaces", "/marketplace",
  "/settings", "/onboarding",
] as const;

export function isAllowedRoute(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  const bare = path.split(/[?#]/)[0];
  return ROUTE_ALLOWLIST.some((r) => bare === r || bare.startsWith(r + "/"));
}

/** Idle threshold for "pause idle VMs" when the model asks for idle ones. */
export const IDLE_MINUTES = 15;

export const ASSIST_SYSTEM_PROMPT = `You are PAL's command interpreter inside a dashboard command bar. The user types a natural-language request; you reason over the compact, real workspace context and return ONE action.

Output STRICT JSON ONLY (no markdown, no prose) matching exactly one of:
{"kind":"navigate","path":"/runs","summary":"..."}
{"kind":"answer","answer":"...","summary":"..."}
{"kind":"create_agent","description":"what the agent should do, in the user's words","summary":"..."}
{"kind":"explain_run","runId":"<an id from Failed runs>","summary":"..."}
{"kind":"vm_action","op":"pause|resume|terminate","vmIds":["<ids from Running VMs>"],"summary":"..."}

Rules:
- "create_agent" when the user asks to create/build/make an agent or bot.
- "explain_run" when the user asks why a run failed; runId MUST be copied from the context. If they name no run, use the most recent failed run. If there are no failed runs, answer that instead.
- "vm_action" for pausing/resuming/stopping sandboxes or VMs. vmIds MUST come from Running VMs. For "idle" VMs pick those idle for ${IDLE_MINUTES}+ minutes; when idle time is "unknown", propose every running VM and say in the summary that activity is unknown — the user picks in a confirm step. If there are no running VMs, answer that instead.
- "answer" only for questions the context answers. Never invent agents, ids, counts, or facts.
- "navigate" otherwise; path MUST be one of: ${ROUTE_ALLOWLIST.join(", ")} (agents: /agents/<name>, runs: /runs/<id>, runs search: /runs?q=<text>).
- "summary": one calm line describing what will happen. "answer": at most two sentences.`;

export function formatAssistContext(ctx: AssistContext): string {
  const lines: string[] = [`Mode: ${ctx.mode}`];
  const names = ctx.agentNames.slice(0, 30);
  lines.push(names.length ? `Agents (${ctx.agentNames.length}): ${names.join(", ")}${ctx.agentNames.length > names.length ? ", …" : ""}` : "Agents: none");
  const runs = Object.entries(ctx.runCountsByStatus);
  lines.push(runs.length ? `Recent runs by status: ${runs.map(([s, n]) => `${s}=${n}`).join(", ")}` : "Recent runs: none");
  lines.push(
    ctx.failedRuns.length
      ? `Failed runs (newest first): ${ctx.failedRuns.slice(0, 8).map((r) => `${r.id} (${r.agentName})`).join("; ")}`
      : "Failed runs: none",
  );
  lines.push(
    ctx.runningVms.length
      ? `Running VMs: ${ctx.runningVms.slice(0, 20).map((v) => `${v.id} (idle ${v.idleMinutes == null ? "unknown" : `${v.idleMinutes}m`}${v.upMinutes != null ? `, up ${v.upMinutes}m` : ""})`).join("; ")}`
      : "Running VMs: none",
  );
  if (ctx.pal) {
    lines.push(`Personal: held replies=${ctx.pal.heldReplies ?? "unknown"}, open commitments=${ctx.pal.openCommitments ?? "unknown"}`);
  }
  return lines.join("\n");
}

function extractJSON(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const match = raw.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const v: unknown = JSON.parse(match[0]);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Parse + validate the model's action against the context it was given.
 * Anything malformed, off-allowlist, or referencing an id not in the context
 * returns null (the caller degrades to plain search — never a dead end).
 */
export function parseAssistAction(raw: string, ctx: AssistContext): AssistAction | null {
  const o = extractJSON(raw);
  if (!o) return null;
  const summary = str(o.summary);
  switch (o.kind) {
    case "navigate": {
      const path = str(o.path);
      return isAllowedRoute(path) ? { kind: "navigate", path, summary: summary || "Open page" } : null;
    }
    case "answer": {
      const answer = str(o.answer);
      return answer ? { kind: "answer", answer, summary: summary || "Answer" } : null;
    }
    case "create_agent": {
      const description = str(o.description).slice(0, 2000);
      return description.length >= 4 ? { kind: "create_agent", description, summary: summary || "Design a new agent" } : null;
    }
    case "explain_run": {
      const runId = str(o.runId);
      return ctx.failedRuns.some((r) => r.id === runId)
        ? { kind: "explain_run", runId, summary: summary || "Explain this run" }
        : null;
    }
    case "vm_action": {
      const op = str(o.op) as RuntimeOp;
      if (op !== "pause" && op !== "resume" && op !== "terminate") return null;
      const known = new Set(ctx.runningVms.map((v) => v.id));
      const ids = Array.isArray(o.vmIds) ? [...new Set(o.vmIds.map(str))] : [];
      if (ids.length === 0 || ids.some((id) => !known.has(id))) return null;
      return { kind: "vm_action", op, vmIds: ids, summary: summary || `${op} ${ids.length} VM(s)` };
    }
    default:
      return null;
  }
}

/** Actions that change state (or spend real money creating things). */
export function requiresConfirm(a: AssistAction): boolean {
  return a.kind === "create_agent" || a.kind === "vm_action";
}

export function vmActionLabel(op: RuntimeOp, n: number): string {
  const verb = op === "pause" ? "Pause" : op === "resume" ? "Resume" : "Terminate";
  return `${verb} ${n} VM${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// AI-suggested next steps (empty states, home pages)
// ---------------------------------------------------------------------------

export interface SuggestedStep {
  label: string;
  href: string;
}

export const SUGGEST_SYSTEM_PROMPT = `You suggest the next useful steps for a user looking at a dashboard page. Reason over the page and the compact workspace context.

Output STRICT JSON ONLY: {"steps":[{"label":"short imperative, max 7 words","href":"/route"}]}
- 1 to 3 steps, most useful first, specific to what the context shows (e.g. no provider key → add one; failing runs → review them).
- href MUST be one of: ${ROUTE_ALLOWLIST.join(", ")} (subpaths allowed). Never invent features.`;

export function parseSuggestions(raw: string): SuggestedStep[] | null {
  const o = extractJSON(raw);
  if (!o || !Array.isArray(o.steps)) return null;
  const out: SuggestedStep[] = [];
  for (const s of o.steps) {
    if (!s || typeof s !== "object") continue;
    const label = str((s as Record<string, unknown>).label).slice(0, 60);
    const href = str((s as Record<string, unknown>).href);
    if (label && isAllowedRoute(href)) out.push({ label, href });
  }
  return out.length ? out.slice(0, 3) : null;
}
