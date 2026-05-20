export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  currentVersionId: string;
  createdAt: Date;
  labels: Record<string, string>;
  status: "active" | "archived";
  avatarUrl?: string;
  stylePrompt?: string;
  systemPrompt?: string;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  digest: string;
  createdAt: Date;
  promoted: boolean;
}

export interface Run {
  id: string;
  tenantId: string;
  agentId: string;
  agentName: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string; stepId?: string };
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  labels: Record<string, string>;
  triggerMeta?: unknown;
}

export interface StreamEvent {
  runId: string;
  stepId?: string;
  seq: number;
  ts: Date;
  kind:
    | "llm_delta"
    | "llm_complete"
    | "tool_call"
    | "tool_result"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "log"
    | "approval"
    | "question"
    | "end";
  data: Record<string, unknown>;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  avatarUrl?: string;
}

// --- Agents ---

export const agents: Agent[] = [
  {
    id: "ag_01hq3x9k7m",
    name: "research-agent",
    description: "Searches the web, synthesizes findings, and produces structured research reports with citations.",
    currentVersionId: "v_01hq3x9k8a",
    createdAt: new Date("2026-03-15T10:30:00Z"),
    labels: { team: "research", tier: "production" },
    status: "active",
  },
  {
    id: "ag_01hq4b2n9p",
    name: "code-reviewer",
    description: "Reviews pull requests for correctness, style, security vulnerabilities, and performance issues.",
    currentVersionId: "v_01hq4b2naa",
    createdAt: new Date("2026-03-20T14:15:00Z"),
    labels: { team: "engineering", tier: "production" },
    status: "active",
  },
  {
    id: "ag_01hq5c3p1r",
    name: "data-pipeline",
    description: "Ingests CSV/JSON data, validates schemas, transforms columns, and loads into the data warehouse.",
    currentVersionId: "v_01hq5c3p2b",
    createdAt: new Date("2026-03-28T09:45:00Z"),
    labels: { team: "data", tier: "staging" },
    status: "active",
  },
  {
    id: "ag_01hq6d4q3s",
    name: "customer-support",
    description: "Handles tier-1 support tickets by searching the knowledge base and drafting responses.",
    currentVersionId: "v_01hq6d4q4c",
    createdAt: new Date("2026-04-02T16:00:00Z"),
    labels: { team: "support", tier: "production" },
    status: "archived",
  },
];

// --- Agent Versions ---

export const agentVersions: Record<string, AgentVersion[]> = {
  "research-agent": [
    { id: "v_01hq3x9k8a", agentId: "ag_01hq3x9k7m", digest: "sha256:a1b2c3d4e5f6", createdAt: new Date("2026-04-10T11:00:00Z"), promoted: true },
    { id: "v_01hq3x9k7z", agentId: "ag_01hq3x9k7m", digest: "sha256:f6e5d4c3b2a1", createdAt: new Date("2026-04-05T08:30:00Z"), promoted: false },
    { id: "v_01hq3x9k6y", agentId: "ag_01hq3x9k7m", digest: "sha256:1a2b3c4d5e6f", createdAt: new Date("2026-03-28T15:20:00Z"), promoted: false },
  ],
  "code-reviewer": [
    { id: "v_01hq4b2naa", agentId: "ag_01hq4b2n9p", digest: "sha256:b2c3d4e5f6a7", createdAt: new Date("2026-04-08T10:00:00Z"), promoted: true },
    { id: "v_01hq4b2n9z", agentId: "ag_01hq4b2n9p", digest: "sha256:7a6f5e4d3c2b", createdAt: new Date("2026-03-25T13:45:00Z"), promoted: false },
  ],
  "data-pipeline": [
    { id: "v_01hq5c3p2b", agentId: "ag_01hq5c3p1r", digest: "sha256:c3d4e5f6a7b8", createdAt: new Date("2026-04-09T09:00:00Z"), promoted: true },
  ],
  "customer-support": [
    { id: "v_01hq6d4q4c", agentId: "ag_01hq6d4q3s", digest: "sha256:d4e5f6a7b8c9", createdAt: new Date("2026-04-02T16:00:00Z"), promoted: true },
  ],
};

// --- Runs ---

export const runs: Run[] = [
  {
    id: "run_01hqa1b2c3d4",
    tenantId: "t_acme",
    agentId: "ag_01hq3x9k7m",
    agentName: "research-agent",
    status: "succeeded",
    input: { query: "Latest advances in quantum error correction 2026", depth: "comprehensive" },
    output: { title: "Quantum Error Correction: 2026 State of the Art", sections: 5, citations: 23, wordCount: 3200 },
    costUsd: 0.0847,
    tokensIn: 12450,
    tokensOut: 8320,
    startedAt: new Date("2026-04-12T08:01:12Z"),
    finishedAt: new Date("2026-04-12T08:03:45Z"),
    createdAt: new Date("2026-04-12T08:01:10Z"),
    labels: { trigger: "api" },
  },
  {
    id: "run_01hqa2c3d4e5",
    tenantId: "t_acme",
    agentId: "ag_01hq4b2n9p",
    agentName: "code-reviewer",
    status: "running",
    input: { prUrl: "https://github.com/acme/api/pull/482", checks: ["security", "style", "correctness"] },
    costUsd: 0.0123,
    tokensIn: 4200,
    tokensOut: 1800,
    startedAt: new Date("2026-04-12T09:15:30Z"),
    createdAt: new Date("2026-04-12T09:15:28Z"),
    labels: { trigger: "webhook" },
  },
  {
    id: "run_01hqa3d4e5f6",
    tenantId: "t_acme",
    agentId: "ag_01hq3x9k7m",
    agentName: "research-agent",
    status: "failed",
    input: { query: "Compare RISC-V vs ARM for edge ML inference", depth: "brief" },
    error: { code: "STEP_TIMEOUT", message: "Step 'search-web' exceeded timeout of 30s", stepId: "step_search_web_01" },
    costUsd: 0.0034,
    tokensIn: 1560,
    tokensOut: 420,
    startedAt: new Date("2026-04-12T07:45:00Z"),
    finishedAt: new Date("2026-04-12T07:45:38Z"),
    createdAt: new Date("2026-04-12T07:44:58Z"),
    labels: { trigger: "api" },
  },
  {
    id: "run_01hqa4e5f6g7",
    tenantId: "t_acme",
    agentId: "ag_01hq5c3p1r",
    agentName: "data-pipeline",
    status: "succeeded",
    input: { source: "s3://acme-data/sales-q1-2026.csv", destination: "warehouse.sales_q1" },
    output: { rowsProcessed: 48230, rowsFailed: 12, durationMs: 8450 },
    costUsd: 0.0012,
    tokensIn: 890,
    tokensOut: 210,
    startedAt: new Date("2026-04-11T22:00:05Z"),
    finishedAt: new Date("2026-04-11T22:00:14Z"),
    createdAt: new Date("2026-04-11T22:00:01Z"),
    labels: { trigger: "schedule" },
  },
  {
    id: "run_01hqa5f6g7h8",
    tenantId: "t_acme",
    agentId: "ag_01hq6d4q3s",
    agentName: "customer-support",
    status: "succeeded",
    input: { ticketId: "TKT-9012", customerMessage: "I can't reset my password after updating my email" },
    output: { response: "Password reset instructions sent to new email address.", confidence: 0.94 },
    costUsd: 0.0056,
    tokensIn: 2340,
    tokensOut: 890,
    startedAt: new Date("2026-04-11T18:30:12Z"),
    finishedAt: new Date("2026-04-11T18:30:19Z"),
    createdAt: new Date("2026-04-11T18:30:10Z"),
    labels: { trigger: "connector" },
  },
  {
    id: "run_01hqa6g7h8i9",
    tenantId: "t_acme",
    agentId: "ag_01hq3x9k7m",
    agentName: "research-agent",
    status: "queued",
    input: { query: "Impact of EU AI Act on agent deployment in 2026", depth: "comprehensive" },
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    createdAt: new Date("2026-04-12T09:20:00Z"),
    labels: { trigger: "manual" },
  },
  {
    id: "run_01hqa7h8i9j0",
    tenantId: "t_acme",
    agentId: "ag_01hq4b2n9p",
    agentName: "code-reviewer",
    status: "succeeded",
    input: { prUrl: "https://github.com/acme/api/pull/479", checks: ["correctness"] },
    output: { verdict: "approved", comments: 2, suggestions: 1 },
    costUsd: 0.0198,
    tokensIn: 6780,
    tokensOut: 3210,
    startedAt: new Date("2026-04-11T15:10:05Z"),
    finishedAt: new Date("2026-04-11T15:11:42Z"),
    createdAt: new Date("2026-04-11T15:10:02Z"),
    labels: { trigger: "webhook" },
  },
  {
    id: "run_01hqa8i9j0k1",
    tenantId: "t_acme",
    agentId: "ag_01hq5c3p1r",
    agentName: "data-pipeline",
    status: "cancelled",
    input: { source: "s3://acme-data/logs-march.json", destination: "warehouse.logs_march" },
    costUsd: 0.0003,
    tokensIn: 240,
    tokensOut: 60,
    startedAt: new Date("2026-04-11T12:00:05Z"),
    finishedAt: new Date("2026-04-11T12:00:22Z"),
    createdAt: new Date("2026-04-11T12:00:01Z"),
    labels: { trigger: "manual" },
  },
  {
    id: "run_01hqa9j0k1l2",
    tenantId: "t_acme",
    agentId: "ag_01hq6d4q3s",
    agentName: "customer-support",
    status: "succeeded",
    input: { ticketId: "TKT-8999", customerMessage: "How do I upgrade to the enterprise plan?" },
    output: { response: "Upgrade instructions with pricing comparison attached.", confidence: 0.97 },
    costUsd: 0.0041,
    tokensIn: 1890,
    tokensOut: 670,
    startedAt: new Date("2026-04-11T10:15:08Z"),
    finishedAt: new Date("2026-04-11T10:15:14Z"),
    createdAt: new Date("2026-04-11T10:15:05Z"),
    labels: { trigger: "connector" },
  },
  {
    id: "run_01hqaak1l2m3",
    tenantId: "t_acme",
    agentId: "ag_01hq3x9k7m",
    agentName: "research-agent",
    status: "running",
    input: { query: "Benchmark comparison of Rust vs Go for gRPC microservices", depth: "brief" },
    costUsd: 0.0067,
    tokensIn: 3400,
    tokensOut: 1200,
    startedAt: new Date("2026-04-12T09:18:00Z"),
    createdAt: new Date("2026-04-12T09:17:58Z"),
    labels: { trigger: "api" },
  },
  {
    id: "run_01hqb1x2y3z4",
    tenantId: "t_acme",
    agentId: "ag_01hq4b2n9p",
    agentName: "code-reviewer",
    status: "paused",
    input: { prUrl: "https://github.com/acme/api/pull/485", checks: ["security", "correctness", "style"] },
    costUsd: 0.0145,
    tokensIn: 5200,
    tokensOut: 2100,
    startedAt: new Date("2026-04-12T09:30:00Z"),
    createdAt: new Date("2026-04-12T09:29:58Z"),
    labels: { trigger: "webhook" },
  },
];

// --- Stream events for run_01hqa1b2c3d4 (the succeeded research-agent run) ---

const baseTs = new Date("2026-04-12T08:01:12Z");
function ts(offsetMs: number): Date {
  return new Date(baseTs.getTime() + offsetMs);
}

export const sampleRunEvents: StreamEvent[] = [
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_analyze_input",
    seq: 1,
    ts: ts(0),
    kind: "step_started",
    data: { name: "analyze-input" },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_analyze_input",
    seq: 2,
    ts: ts(120),
    kind: "log",
    data: { level: "info", message: "Parsing user query and determining search strategy..." },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_analyze_input",
    seq: 3,
    ts: ts(800),
    kind: "llm_delta",
    data: { text: "The user is asking about recent advances in quantum error correction. I'll need to search for papers and articles from 2026, focusing on surface codes, logical qubit improvements, and any breakthrough results from major labs." },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_analyze_input",
    seq: 4,
    ts: ts(2200),
    kind: "llm_complete",
    data: { model: "reasoning-large", tokensIn: 340, tokensOut: 82, costUsd: 0.0021 },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_analyze_input",
    seq: 5,
    ts: ts(2400),
    kind: "step_completed",
    data: { name: "analyze-input", durationMs: 2400 },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_search_web",
    seq: 6,
    ts: ts(2500),
    kind: "step_started",
    data: { name: "search-web" },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_search_web",
    seq: 7,
    ts: ts(2600),
    kind: "tool_call",
    data: {
      name: "web.search",
      arguments: { query: "quantum error correction 2026 breakthroughs surface codes", maxResults: 10 },
    },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_search_web",
    seq: 8,
    ts: ts(5800),
    kind: "tool_result",
    data: {
      name: "web.search",
      result: [
        { title: "Google achieves 1000-qubit logical processor with real-time QEC", url: "https://arxiv.org/abs/2603.01234", snippet: "Demonstration of below-threshold error rates on a 1000-physical-qubit surface code..." },
        { title: "IBM Heron-3: Logical qubit error rates below 10^-8", url: "https://research.ibm.com/blog/heron-3", snippet: "New superconducting architecture achieves record-low logical error rates..." },
        { title: "Quantinuum breaks the fault-tolerance barrier", url: "https://quantinuum.com/ft-barrier", snippet: "Trapped-ion system demonstrates fully fault-tolerant quantum computation..." },
      ],
    },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_search_web",
    seq: 9,
    ts: ts(6200),
    kind: "tool_call",
    data: {
      name: "web.fetch",
      arguments: { url: "https://arxiv.org/abs/2603.01234" },
    },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_search_web",
    seq: 10,
    ts: ts(8400),
    kind: "tool_result",
    data: {
      name: "web.fetch",
      result: "Abstract: We report the first demonstration of a surface-code logical qubit with over 1000 physical qubits operating below the fault-tolerance threshold...",
    },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_search_web",
    seq: 11,
    ts: ts(8600),
    kind: "step_completed",
    data: { name: "search-web", durationMs: 6100 },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_synthesize",
    seq: 12,
    ts: ts(8700),
    kind: "step_started",
    data: { name: "synthesize" },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_synthesize",
    seq: 13,
    ts: ts(9000),
    kind: "llm_delta",
    data: { text: "# Quantum Error Correction: 2026 State of the Art\n\n## Executive Summary\n\n2026 has been a watershed year for quantum error correction (QEC). Three major milestones have been achieved:\n\n1. **Google's 1000-qubit logical processor** demonstrated below-threshold error rates on a surface code, marking the first time a large-scale QEC system has operated reliably enough for practical computation.\n\n2. **IBM's Heron-3 architecture** achieved logical qubit error rates below 10^-8, a two-order-of-magnitude improvement over their 2025 results.\n\n3. **Quantinuum's trapped-ion system** demonstrated fully fault-tolerant quantum computation, completing a 200-gate circuit with zero logical errors.\n\n## Key Findings\n\nThe convergence of improved physical qubit quality, better decoder algorithms (particularly the Union-Find decoder with real-time classical processing), and architectural innovations in coupling maps have collectively pushed the field past the long-anticipated fault-tolerance threshold..." },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_synthesize",
    seq: 14,
    ts: ts(14500),
    kind: "llm_complete",
    data: { model: "reasoning-large", tokensIn: 11200, tokensOut: 7800, costUsd: 0.0794 },
  },
  {
    runId: "run_01hqa1b2c3d4",
    stepId: "step_synthesize",
    seq: 15,
    ts: ts(14800),
    kind: "step_completed",
    data: { name: "synthesize", durationMs: 6100 },
  },
  {
    runId: "run_01hqa1b2c3d4",
    seq: 16,
    ts: ts(15000),
    kind: "end",
    data: { status: "succeeded", totalDurationMs: 15000, totalCostUsd: 0.0847, totalTokensIn: 12450, totalTokensOut: 8320 },
  },
];

// --- API Keys ---

export const apiKeys: ApiKey[] = [
  {
    id: "key_01",
    name: "Production API",
    prefix: "ltn_prod_a3b8",
    scopes: ["runs:create", "runs:read", "agents:read"],
    createdAt: new Date("2026-03-10T08:00:00Z"),
  },
  {
    id: "key_02",
    name: "CI/CD Pipeline",
    prefix: "ltn_ci_f2e7",
    scopes: ["agents:deploy", "runs:create", "runs:read"],
    createdAt: new Date("2026-03-22T14:30:00Z"),
  },
  {
    id: "key_03",
    name: "Dashboard Read-only",
    prefix: "ltn_ro_k9m1",
    scopes: ["runs:read", "agents:read"],
    createdAt: new Date("2026-04-01T09:15:00Z"),
  },
];

// --- Team Members ---

export const teamMembers: TeamMember[] = [
  { id: "usr_01", name: "Sarah Chen", email: "sarah@acme.dev", role: "owner" },
  { id: "usr_02", name: "Marcus Johnson", email: "marcus@acme.dev", role: "admin" },
  { id: "usr_03", name: "Priya Patel", email: "priya@acme.dev", role: "member" },
  { id: "usr_04", name: "Alex Rivera", email: "alex@acme.dev", role: "member" },
  { id: "usr_05", name: "Jordan Kim", email: "jordan@acme.dev", role: "viewer" },
];

// --- Utility functions ---

export function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

export function getAgentByName(name: string): Agent | undefined {
  return agents.find((a) => a.name === name);
}

export function getRunsForAgent(agentName: string): Run[] {
  return runs.filter((r) => r.agentName === agentName);
}

export function getRunById(id: string): Run | undefined {
  return runs.find((r) => r.id === id);
}

// --- Additional rich event streams ---

// Failed run events (for run_01hqa3d4e5f6 - research-agent STEP_TIMEOUT)
const failedBaseTs = new Date("2026-04-12T07:45:00Z");
function fts(offsetMs: number): Date {
  return new Date(failedBaseTs.getTime() + offsetMs);
}

export const failedRunEvents: StreamEvent[] = [
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_analyze_input",
    seq: 1,
    ts: fts(0),
    kind: "step_started",
    data: { name: "analyze-input" },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_analyze_input",
    seq: 2,
    ts: fts(100),
    kind: "log",
    data: { level: "info", message: "Parsing user query for RISC-V vs ARM comparison..." },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_analyze_input",
    seq: 3,
    ts: fts(600),
    kind: "llm_delta",
    data: { text: "The user wants a brief comparison of RISC-V versus ARM for edge ML inference. I need to search for recent benchmarks and architectural analyses." },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_analyze_input",
    seq: 4,
    ts: fts(1800),
    kind: "llm_complete",
    data: { model: "chat-small", tokensIn: 210, tokensOut: 48, costUsd: 0.0003 },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_analyze_input",
    seq: 5,
    ts: fts(2000),
    kind: "step_completed",
    data: { name: "analyze-input", durationMs: 2000 },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_search_web_01",
    seq: 6,
    ts: fts(2100),
    kind: "step_started",
    data: { name: "search-web" },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_search_web_01",
    seq: 7,
    ts: fts(2200),
    kind: "tool_call",
    data: {
      name: "web.search",
      arguments: { query: "RISC-V vs ARM edge ML inference benchmarks 2026", maxResults: 15 },
    },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_search_web_01",
    seq: 8,
    ts: fts(12000),
    kind: "log",
    data: { level: "warn", message: "web.search request taking longer than expected (10s elapsed)..." },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_search_web_01",
    seq: 9,
    ts: fts(22000),
    kind: "log",
    data: { level: "warn", message: "web.search request still pending (20s elapsed). Timeout threshold: 30s." },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_search_web_01",
    seq: 10,
    ts: fts(30000),
    kind: "log",
    data: { level: "error", message: "web.search exceeded 30s timeout. Aborting step." },
  },
  {
    runId: "run_01hqa3d4e5f6",
    stepId: "step_search_web_01",
    seq: 11,
    ts: fts(30200),
    kind: "step_failed",
    data: {
      name: "search-web",
      error: "STEP_TIMEOUT: Step 'search-web' exceeded timeout of 30s",
      stackTrace: `Error: STEP_TIMEOUT: Step 'search-web' exceeded timeout of 30s
    at StepRunner.execute (lantern-runtime/src/step-runner.ts:142:15)
    at WorkflowEngine.runStep (lantern-engine/src/engine.ts:89:22)
    at WorkflowEngine.executeGraph (lantern-engine/src/engine.ts:201:18)
    at RunManager.start (lantern-engine/src/run-manager.ts:67:10)`,
      durationMs: 28100,
    },
  },
  {
    runId: "run_01hqa3d4e5f6",
    seq: 12,
    ts: fts(30400),
    kind: "end",
    data: { status: "failed", totalDurationMs: 30400, totalCostUsd: 0.0034, totalTokensIn: 1560, totalTokensOut: 420 },
  },
];

// Running code-reviewer events (for run_01hqa2c3d4e5 - currently running)
const runningBaseTs = new Date("2026-04-12T09:15:30Z");
function rts(offsetMs: number): Date {
  return new Date(runningBaseTs.getTime() + offsetMs);
}

export const runningRunEvents: StreamEvent[] = [
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_fetch_pr",
    seq: 1,
    ts: rts(0),
    kind: "step_started",
    data: { name: "fetch-pr" },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_fetch_pr",
    seq: 2,
    ts: rts(80),
    kind: "log",
    data: { level: "info", message: "Fetching PR #482 from github.com/acme/api..." },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_fetch_pr",
    seq: 3,
    ts: rts(200),
    kind: "tool_call",
    data: {
      name: "github.getPullRequest",
      arguments: { owner: "acme", repo: "api", number: 482 },
    },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_fetch_pr",
    seq: 4,
    ts: rts(1800),
    kind: "tool_result",
    data: {
      name: "github.getPullRequest",
      result: {
        title: "feat: add rate limiting to /v2/agents endpoint",
        author: "priya-patel",
        changedFiles: 7,
        additions: 342,
        deletions: 18,
        baseBranch: "main",
        headBranch: "feat/rate-limiting",
      },
    },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_fetch_pr",
    seq: 5,
    ts: rts(2000),
    kind: "tool_call",
    data: {
      name: "github.getPullRequestDiff",
      arguments: { owner: "acme", repo: "api", number: 482 },
    },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_fetch_pr",
    seq: 6,
    ts: rts(3200),
    kind: "tool_result",
    data: {
      name: "github.getPullRequestDiff",
      result: "diff --git a/pkg/middleware/ratelimit.go b/pkg/middleware/ratelimit.go\nnew file mode 100644\n+package middleware\n+\n+import (\n+\t\"net/http\"\n+\t\"sync\"\n+\t\"time\"\n+\t\"golang.org/x/time/rate\"\n+)\n+\n+type RateLimiter struct {\n+\tmu       sync.RWMutex\n+\tlimiters map[string]*rate.Limiter\n+\trate     rate.Limit\n+\tburst    int\n+}",
    },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_fetch_pr",
    seq: 7,
    ts: rts(3400),
    kind: "step_completed",
    data: { name: "fetch-pr", durationMs: 3400 },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_security_review",
    seq: 8,
    ts: rts(3500),
    kind: "step_started",
    data: { name: "security-review" },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_security_review",
    seq: 9,
    ts: rts(3700),
    kind: "log",
    data: { level: "info", message: "Running security analysis on 7 changed files..." },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_security_review",
    seq: 10,
    ts: rts(4200),
    kind: "llm_delta",
    data: { text: "## Security Review\n\nAnalyzing the rate limiting implementation for potential security concerns:\n\n**1. Race condition in limiter map access** - The `RateLimiter` struct uses a `sync.RWMutex` which is correct. The `getLimiter()` method properly acquires a read lock first, then upgrades to a write lock for new entries. This follows the double-checked locking pattern correctly.\n\n**2. Memory exhaustion risk** - There is no eviction policy for the `limiters` map. An attacker could generate requests with unique identifiers to grow this map unboundedly. **Recommendation**: Add a TTL-based eviction or cap the map size with LRU eviction.\n\n**3. Key derivation** - The rate limit key is derived from `X-Tenant-ID` header, which is validated by the auth middleware upstream. This is acceptable but should be documented as a dependency.\n\n**No critical vulnerabilities found.** One medium-severity concern regarding memory exhaustion." },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_security_review",
    seq: 11,
    ts: rts(8500),
    kind: "llm_complete",
    data: { model: "reasoning-large", tokensIn: 3200, tokensOut: 1400, costUsd: 0.0089 },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_security_review",
    seq: 12,
    ts: rts(8700),
    kind: "step_completed",
    data: { name: "security-review", durationMs: 5200 },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_style_review",
    seq: 13,
    ts: rts(8800),
    kind: "step_started",
    data: { name: "style-review" },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_style_review",
    seq: 14,
    ts: rts(9200),
    kind: "llm_delta",
    data: { text: "## Style Review\n\nThe code follows Go conventions and the project's established patterns:\n\n- Naming: `RateLimiter`, `getLimiter()`, `cleanupExpired()` all follow Go naming conventions.\n- Error handling: Uses `http.Error()` consistently with appropriate status codes.\n- Package organization: Correctly placed in `pkg/middleware/`.\n- Test coverage: Tests include unit tests for the limiter logic and integration tests for the HTTP middleware.\n\n**Minor suggestions:**\n- Line 42: Consider extracting the cleanup interval (5 minutes) to a configurable constant.\n- Line 67: The error message could include the retry-after duration for better client UX." },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_style_review",
    seq: 15,
    ts: rts(12800),
    kind: "llm_complete",
    data: { model: "chat-small", tokensIn: 1000, tokensOut: 400, costUsd: 0.0034 },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_style_review",
    seq: 16,
    ts: rts(13000),
    kind: "step_completed",
    data: { name: "style-review", durationMs: 4200 },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_approval",
    seq: 17,
    ts: rts(13100),
    kind: "step_started",
    data: { name: "human-approval" },
  },
  {
    runId: "run_01hqa2c3d4e5",
    stepId: "step_approval",
    seq: 18,
    ts: rts(13200),
    kind: "approval",
    data: {
      message: "The code review found 1 medium-severity security concern (memory exhaustion in rate limiter map). Should I post the review comments to the PR?",
      options: ["Approve & Post", "Deny"],
    },
  },
];

// Approval-pending run (new mock run)
export const approvalPendingRun: Run = {
  id: "run_01hqb1x2y3z4",
  tenantId: "t_acme",
  agentId: "ag_01hq4b2n9p",
  agentName: "code-reviewer",
  status: "paused",
  input: { prUrl: "https://github.com/acme/api/pull/485", checks: ["security", "correctness", "style"] },
  costUsd: 0.0145,
  tokensIn: 5200,
  tokensOut: 2100,
  startedAt: new Date("2026-04-12T09:30:00Z"),
  createdAt: new Date("2026-04-12T09:29:58Z"),
  labels: { trigger: "webhook" },
};

// Events for the approval-pending run
const approvalBaseTs = new Date("2026-04-12T09:30:00Z");
function ats(offsetMs: number): Date {
  return new Date(approvalBaseTs.getTime() + offsetMs);
}

export const approvalPendingEvents: StreamEvent[] = [
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_fetch_pr",
    seq: 1,
    ts: ats(0),
    kind: "step_started",
    data: { name: "fetch-pr" },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_fetch_pr",
    seq: 2,
    ts: ats(150),
    kind: "tool_call",
    data: {
      name: "github.getPullRequest",
      arguments: { owner: "acme", repo: "api", number: 485 },
    },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_fetch_pr",
    seq: 3,
    ts: ats(1500),
    kind: "tool_result",
    data: {
      name: "github.getPullRequest",
      result: {
        title: "refactor: migrate auth to JWT with RS256",
        author: "marcus-johnson",
        changedFiles: 14,
        additions: 890,
        deletions: 423,
      },
    },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_fetch_pr",
    seq: 4,
    ts: ats(1700),
    kind: "step_completed",
    data: { name: "fetch-pr", durationMs: 1700 },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_review",
    seq: 5,
    ts: ats(1800),
    kind: "step_started",
    data: { name: "comprehensive-review" },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_review",
    seq: 6,
    ts: ats(2200),
    kind: "llm_delta",
    data: { text: "## Comprehensive Review: Auth Migration to JWT RS256\n\nThis is a significant security-sensitive change. The migration from session-based auth to JWT with RS256 signing affects 14 files.\n\n### Critical Findings\n\n1. **Private key storage**: The RS256 private key is loaded from an environment variable. This is acceptable for production but the fallback to a hardcoded key in `auth_test.go` should use a dedicated test key, not the example key from the JWT spec.\n\n2. **Token expiration**: Access tokens expire in 15 minutes, refresh tokens in 7 days. These are reasonable defaults but should be configurable per-tenant.\n\n3. **Revocation**: The implementation includes a Redis-based token blacklist for revocation. The TTL on blacklist entries matches the token max lifetime. This is correct.\n\n### Recommendation\n\nThis PR requires careful review due to the security implications. I recommend approval with the condition that the test key issue is fixed before merge." },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_review",
    seq: 7,
    ts: ats(8000),
    kind: "llm_complete",
    data: { model: "reasoning-large", tokensIn: 4800, tokensOut: 1900, costUsd: 0.0132 },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_review",
    seq: 8,
    ts: ats(8200),
    kind: "step_completed",
    data: { name: "comprehensive-review", durationMs: 6400 },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_post_approval",
    seq: 9,
    ts: ats(8300),
    kind: "step_started",
    data: { name: "post-approval" },
  },
  {
    runId: "run_01hqb1x2y3z4",
    stepId: "step_post_approval",
    seq: 10,
    ts: ats(8400),
    kind: "approval",
    data: {
      message: "This PR touches authentication infrastructure and has 1 critical finding (test key issue). Should I post the review and request changes?",
      options: ["Approve & Request Changes", "Approve & Approve PR", "Deny"],
    },
  },
];

// Example input templates per agent
export const agentInputExamples: Record<string, unknown> = {
  "research-agent": {
    query: "Latest advances in quantum error correction 2026",
    depth: "comprehensive",
  },
  "code-reviewer": {
    prUrl: "https://github.com/acme/api/pull/482",
    checks: ["security", "style", "correctness"],
  },
  "data-pipeline": {
    source: "s3://acme-data/sales-q1-2026.csv",
    destination: "warehouse.sales_q1",
  },
  "customer-support": {
    ticketId: "TKT-9012",
    customerMessage: "I can't reset my password after updating my email",
  },
};

// Model options for agent testing
export const modelOptions = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "reasoning-large", label: "Reasoning Large" },
  { value: "reasoning-small", label: "Reasoning Small" },
  { value: "chat-large", label: "Chat Large" },
  { value: "chat-small", label: "Chat Small" },
  { value: "code-large", label: "Code Large" },
] as const;

// Helper: get events for a given run ID
export function getEventsForRun(runId: string): StreamEvent[] {
  switch (runId) {
    case "run_01hqa1b2c3d4":
      return sampleRunEvents;
    case "run_01hqa3d4e5f6":
      return failedRunEvents;
    case "run_01hqa2c3d4e5":
      return runningRunEvents;
    case "run_01hqb1x2y3z4":
      return approvalPendingEvents;
    default:
      return [];
  }
}
