// Pure helpers + wire types for the agent Security tab (ADR 0055).
// No I/O and no React so the diff / equality / parse logic is unit-testable.

export interface AgentPolicy {
  mode: "enforce" | "legacy_permissive";
  tools: string[];
  connectors: Record<string, string[]>;
  mcpServers: string[];
  egressHosts: string[];
  a2aTargets: string[];
  a2aInbound: string[];
  secrets: string[];
  budget: { maxToolCallsPerRun: number; maxA2AInboundPerMinute: number };
  version: number;
}

export interface AgentPolicyDocument {
  agentName: string;
  agentId: string;
  policy: AgentPolicy;
  updatedAt: string;
  updatedBy: string;
  warnings: string[];
}

export interface AgentPolicyProposal {
  proposal: AgentPolicy;
  rationale: Array<{ field: string; reason: string }>;
  sources: string[];
  unresolved: string[];
}

export interface AgentIdentity {
  agentId: string;
  spiffeId: string;
  keyGeneration: number;
  status: "active" | "revoked";
  publicKeyJwk: Record<string, unknown>;
  jwksUri: string;
  tokenTtlSeconds: number;
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface AgentAuditEvent {
  id: number;
  event: string;
  actionKind: string;
  target: string;
  decision: "allow" | "deny" | "";
  reason: string;
  runId: string;
  stepId: string;
  agentVersionId: string;
  jti: string;
  principal: string;
  createdAt: string;
}

export interface AgentAuditLog {
  events: AgentAuditEvent[];
  chainValid: boolean;
}

export type ListField =
  | "tools"
  | "mcpServers"
  | "egressHosts"
  | "a2aTargets"
  | "a2aInbound"
  | "secrets";

export const LIST_FIELDS: ReadonlyArray<{ key: ListField; label: string; hint: string }> = [
  { key: "tools", label: "Tools", hint: "Built-in and runtime tool names, e.g. web_search. '*' globs allowed." },
  { key: "mcpServers", label: "MCP servers", hint: "Attached MCP server slugs." },
  { key: "egressHosts", label: "Egress hosts", hint: "e.g. api.github.com or *.example.org" },
  { key: "a2aTargets", label: "A2A targets (outbound)", hint: "Agent names, SPIFFE IDs, or marketplace:<slug>." },
  { key: "a2aInbound", label: "A2A callers (inbound)", hint: "tenant:self, tenant:<uuid>, SPIFFE IDs, or *." },
  { key: "secrets", label: "Secrets", hint: "Secret ref patterns, e.g. pal.secret/llm/*" },
];

export function emptyPolicy(): AgentPolicy {
  return {
    mode: "enforce",
    tools: [],
    connectors: {},
    mcpServers: [],
    egressHosts: [],
    a2aTargets: [],
    a2aInbound: [],
    secrets: [],
    budget: { maxToolCallsPerRun: 0, maxA2AInboundPerMinute: 0 },
    version: 0,
  };
}

/** The server may omit empty collections (null/undefined); normalize them. */
export function normalizePolicy(p: Partial<AgentPolicy> | null | undefined): AgentPolicy {
  const base = emptyPolicy();
  if (!p) return base;
  const connectors: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(p.connectors ?? {})) connectors[k] = [...(v ?? [])];
  return {
    mode: p.mode === "legacy_permissive" ? "legacy_permissive" : "enforce",
    tools: [...(p.tools ?? [])],
    connectors,
    mcpServers: [...(p.mcpServers ?? [])],
    egressHosts: [...(p.egressHosts ?? [])],
    a2aTargets: [...(p.a2aTargets ?? [])],
    a2aInbound: [...(p.a2aInbound ?? [])],
    secrets: [...(p.secrets ?? [])],
    budget: {
      maxToolCallsPerRun: p.budget?.maxToolCallsPerRun ?? 0,
      maxA2AInboundPerMinute: p.budget?.maxA2AInboundPerMinute ?? 0,
    },
    version: p.version ?? 0,
  };
}

const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

/** Canonical form for comparison: sorted/deduped lists, version dropped. */
function canonical(p: AgentPolicy): unknown {
  const n = normalizePolicy(p);
  const connectors: Record<string, string[]> = {};
  for (const k of Object.keys(n.connectors).sort()) connectors[k] = uniqSorted(n.connectors[k]);
  return {
    mode: n.mode,
    tools: uniqSorted(n.tools),
    connectors,
    mcpServers: uniqSorted(n.mcpServers),
    egressHosts: uniqSorted(n.egressHosts),
    a2aTargets: uniqSorted(n.a2aTargets),
    a2aInbound: uniqSorted(n.a2aInbound),
    secrets: uniqSorted(n.secrets),
    budget: n.budget,
  };
}

/** Deep equality of two policies, ignoring `version` and list ordering. */
export function policiesEqual(a: AgentPolicy, b: AgentPolicy): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export interface DiffEntry {
  field: string;
  added: string[];
  removed: string[];
}

function flattenConnectors(c: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [id, actions] of Object.entries(c)) {
    if (actions.length === 0) out.push(`${id} → (no actions)`);
    for (const a of actions) out.push(`${id} → ${a}`);
  }
  return out;
}

function setDiff(field: string, before: string[], after: string[]): DiffEntry | null {
  const b = new Set(before);
  const a = new Set(after);
  const added = [...a].filter((x) => !b.has(x)).sort();
  const removed = [...b].filter((x) => !a.has(x)).sort();
  return added.length || removed.length ? { field, added, removed } : null;
}

/** Added/removed entries going from `current` to `next`. Empty array = no change. */
export function diffPolicy(current: AgentPolicy, next: AgentPolicy): DiffEntry[] {
  const c = normalizePolicy(current);
  const n = normalizePolicy(next);
  const out: DiffEntry[] = [];
  if (c.mode !== n.mode) {
    out.push({ field: "mode", added: [n.mode], removed: [c.mode] });
  }
  const push = (e: DiffEntry | null) => {
    if (e) out.push(e);
  };
  push(setDiff("tools", c.tools, n.tools));
  push(setDiff("connectors", flattenConnectors(c.connectors), flattenConnectors(n.connectors)));
  push(setDiff("mcpServers", c.mcpServers, n.mcpServers));
  push(setDiff("egressHosts", c.egressHosts, n.egressHosts));
  push(setDiff("a2aTargets", c.a2aTargets, n.a2aTargets));
  push(setDiff("a2aInbound", c.a2aInbound, n.a2aInbound));
  push(setDiff("secrets", c.secrets, n.secrets));
  const budgetKeys = ["maxToolCallsPerRun", "maxA2AInboundPerMinute"] as const;
  for (const k of budgetKeys) {
    if (c.budget[k] !== n.budget[k]) {
      out.push({ field: `budget.${k}`, added: [String(n.budget[k])], removed: [String(c.budget[k])] });
    }
  }
  return out;
}

// -- text <-> list editing ---------------------------------------------------

/** One entry per line (commas also split); trims, drops blanks and duplicates. */
export function parseLines(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** `connector: action1, action2` per line. Returns an error for malformed lines. */
export function parseConnectors(
  text: string,
): { ok: true; value: Record<string, string[]> } | { ok: false; error: string } {
  const value: Record<string, string[]> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) return { ok: false, error: `Expected "connector: action, action" but got "${line}"` };
    const id = line.slice(0, idx).trim();
    const actions = parseLines(line.slice(idx + 1));
    if (actions.length === 0) return { ok: false, error: `Connector "${id}" needs at least one action (or "*")` };
    value[id] = uniqSorted([...(value[id] ?? []), ...actions]);
  }
  return { ok: true, value };
}

export function formatConnectors(c: Record<string, string[]>): string {
  return Object.keys(c)
    .sort()
    .map((id) => `${id}: ${c[id].join(", ")}`)
    .join("\n");
}

// -- error parsing -----------------------------------------------------------

export interface ParsedApiError {
  status: number | null;
  code?: string;
  field?: string;
  message: string;
}

/** lib/api.ts throws `Error("API <status>: <body>")`; recover the structure. */
export function parseApiError(err: unknown): ParsedApiError {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^API (\d{3}):\s*([\s\S]*)$/.exec(raw);
  if (!m) return { status: null, message: raw };
  const status = Number(m[1]);
  const body = m[2];
  try {
    const j: unknown = JSON.parse(body);
    if (typeof j === "object" && j !== null) {
      const o = j as Record<string, unknown>;
      return {
        status,
        code: typeof o.code === "string" ? o.code : undefined,
        field: typeof o.field === "string" ? o.field : undefined,
        message: typeof o.error === "string" ? o.error : body,
      };
    }
  } catch {
    // body was not JSON; fall through
  }
  return { status, message: body || `HTTP ${status}` };
}
