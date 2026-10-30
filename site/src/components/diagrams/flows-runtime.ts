import type { FlowDef } from "./FlowDiagram";
import type { Src } from "./types";

// PAL Runtime diagrams for the shared FlowDiagram kit. Service names, ports,
// RPCs and numbers come from the runtime gap analysis (Mermaid sources) and
// CLAUDE.md; every number is on the verified fact sheet.

const M = (p: string, l?: number): Src => ({ p, l });
const H = "services/control-plane/internal/handlers";

// ---------------------------------------------------------------------------
export const SYSTEM_CONTEXT: FlowDef = {
  id: "system-context",
  title: "PAL Runtime: system context",
  caption: "Who calls PAL, the control plane that decides, and the data plane in your VPC that runs the work. Step through a call, or hover any box.",
  vb: [980, 600],
  frames: [
    { label: "Control plane · managed or self-hosted", x: 20, y: 105, w: 940, h: 195, kind: "cp" },
    { label: "Data plane · your VPC (EKS · GKE · AKS)", x: 20, y: 335, w: 940, h: 250, kind: "dp" },
  ],
  nodes: [
    { id: "dev", label: "Developer", sub: "CLI · SDKs", tone: "client", x: 40, y: 22, detail: "The CLI and the TypeScript, Python and Go SDKs. Everything goes through the gateway." },
    { id: "user", label: "Callers", sub: "REST · SSE · A2A", tone: "client", x: 230, y: 22, detail: "Apps and other agents calling runs, sessions and A2A cards." },
    { id: "prov", label: "Model providers", sub: "OpenAI · Anthropic · …", x: 600, y: 22, detail: "External HTTPS. Reached by capability through the router or the control plane's failover chain." },
    { id: "owner", label: "pal surfaces", sub: "iMessage · WhatsApp", tone: "pal", x: 790, y: 22, detail: "The owner's personal channels, bridged into PAL." },
    { id: "console", label: "Console", sub: "Next.js :3001", x: 40, y: 140, detail: "The dashboard. It talks to the same API as the SDKs." },
    { id: "gw", label: "Gateway", sub: "Rust :8443", tone: "rt", x: 230, y: 140, detail: "TLS, JWT or API-key auth (keys introspected and cached 60 s, fail-closed), rate limits, SSE and WebSocket proxying." },
    { id: "cps", label: "Control plane", sub: "Go :8080 · gRPC :50051", tone: "rt", x: 420, y: 140, detail: "REST and gRPC API, auth, budgets, agents, runs, sessions. Never touches user code." },
    { id: "mr", label: "Model router", sub: "Rust :50053", tone: "rt", x: 610, y: 140, detail: "Capability addressing, 4 strategies (cheap, fast, best, balanced), prompt and semantic cache, failover." },
    { id: "sg", label: "Surface gateway", sub: ":8444 webhooks", x: 790, y: 140, detail: "Inbound webhooks for Slack, WhatsApp, Telegram, voice and webchat." },
    { id: "sched", label: "Scheduler · billing", sub: "Go", x: 230, y: 228, detail: "Cron triggers, usage metering and budgets." },
    { id: "dpa", label: "Data-plane agent", sub: "outbound tunnel", x: 40, y: 375, detail: "Dials out to the control plane over mTLS. No inbound ports in your VPC." },
    { id: "we", label: "Workflow engine", sub: "Go :50052", x: 230, y: 375, detail: "Event-sourced durable steps. The only thing that mutates run state." },
    { id: "rs", label: "Runtime scheduler", sub: "Go :50055", x: 420, y: 375, detail: "Placement (warm pool, region, fair share, cost, health) and leader election." },
    { id: "rm", label: "Runtime manager", sub: "Rust :50054", tone: "host", x: 610, y: 375, detail: "Spawns, snapshots, forks and stops VMs on its node: Firecracker, Kata, K8s Job, Wasmtime." },
    { id: "fc", label: "microVMs", sub: "Firecracker + harness", tone: "guest", x: 790, y: 375, detail: "Untrusted code runs here, never in a bare pod. The harness is PID 1." },
    { id: "pg", label: "Postgres", sub: "pgvector · RLS", tone: "store", x: 230, y: 495, detail: "Runs, journal_events, every tenant table under row-level security." },
    { id: "rd", label: "Redis", sub: "cache · pub/sub · locks", tone: "store", x: 420, y: 495, detail: "Caching, rate limits, SSE fan-out, queues." },
    { id: "s3", label: "S3 / MinIO", sub: "bundles · snapshots", tone: "store", x: 790, y: 495, detail: "Agent bundles, VM snapshots and large attachments." },
  ],
  edges: [
    { from: "dev", to: "gw" },
    { from: "user", to: "gw" },
    { from: "console", to: "gw" },
    { from: "owner", to: "sg" },
    { from: "gw", to: "cps" },
    { from: "gw", to: "mr", via: [[305, 120], [685, 120]] },
    { from: "mr", to: "prov" },
    { from: "cps", to: "sched" },
    { from: "dpa", to: "cps", label: "outbound mTLS tunnel", dashed: true, via: [[115, 318], [495, 318]], at: 0.55 },
    { from: "dpa", to: "we" },
    { from: "we", to: "rs" },
    { from: "rs", to: "rm" },
    { from: "rm", to: "fc" },
    { from: "we", to: "pg", kind: "store" },
    { from: "we", to: "rd", kind: "store" },
    { from: "fc", to: "s3", kind: "store" },
  ],
  scenarios: [
    {
      id: "call",
      label: "A call, end to end",
      steps: [
        { title: "A call arrives at the gateway", note: "From the CLI, an SDK, the console or another agent. TLS and authentication happen here, once.", edges: ["dev>gw", "user>gw"] },
        { title: "The control plane decides", note: "Tenant from the credential, budget and quota checks, the agent version resolved. It never runs user code.", edges: ["gw>cps"] },
        { title: "Down the tunnel to your VPC", note: "The data-plane agent opened this connection outbound, so your network needs no inbound ports.", edges: ["dpa>cps", "dpa>we"] },
        { title: "A sandbox is placed and booted", note: "The engine asks for a VM; the scheduler picks a node; the manager boots or restores a Firecracker microVM.", edges: ["we>rs", "rs>rm", "rm>fc"] },
        { title: "Models by capability", note: "The agent asks for a capability such as reasoning-large; the router maps it to a vendor model.", edges: ["gw>mr", "mr>prov"] },
        { title: "State is durable", note: "Every step is journaled in Postgres; bundles and snapshots live in object storage.", edges: ["we>pg", "we>rd", "fc>s3"] },
        { title: "pal's channels come in the side door", note: "Messages from personal surfaces enter through the surface gateway's webhooks.", edges: ["owner>sg"] },
      ],
    },
  ],
  legend: [["rt", "PAL Runtime services"], ["host", "Trusted host code"], ["guest", "Untrusted code"], ["store", "Data stores"], ["client", "Outside PAL"]],
};

// ---------------------------------------------------------------------------
export const CONTAINER_VIEW: FlowDef = {
  id: "containers",
  title: "PAL Runtime: containers",
  caption: "Every deployable service, grouped by tier. Hover or tap a box for what it owns.",
  vb: [980, 552],
  frames: [
    { label: "Edge", x: 15, y: 30, w: 180, h: 110, kind: "zone" },
    { label: "Control plane · Go", x: 205, y: 30, w: 190, h: 400, kind: "cp" },
    { label: "Routing · Rust", x: 410, y: 30, w: 555, h: 110, kind: "zone" },
    { label: "Data plane", x: 410, y: 160, w: 555, h: 270, kind: "dp" },
    { label: "Stores", x: 410, y: 445, w: 555, h: 102, kind: "zone" },
  ],
  nodes: [
    { id: "gw", label: "Gateway", sub: ":8443 · Rust/Axum", tone: "rt", x: 30, y: 65, detail: "TLS, JWT and API-key auth, rate limits, SSE/WebSocket proxy." },
    { id: "cps", label: "control-plane", sub: "REST :8080 · gRPC :50051", tone: "rt", x: 225, y: 65, w: 160, detail: "The API. Agents, runs, sessions, connectors, budgets, evals, marketplace." },
    { id: "not", label: "notifier", x: 225, y: 175, w: 160, detail: "Webhook, email, Slack, Discord and SMS deliveries, at-least-once with idempotency keys." },
    { id: "bil", label: "billing", x: 225, y: 265, w: 160, detail: "Usage metering: tokens, CPU, memory, sandbox hours; daily rollups for budgets." },
    { id: "sch", label: "scheduler", sub: "cron", x: 225, y: 355, w: 160, detail: "Timezone-aware cron and one-shot triggers." },
    { id: "mr", label: "model-router", sub: ":50053", tone: "rt", x: 430, y: 65, detail: "Capability addressing, cost/latency/quality strategies, cache, failover." },
    { id: "prov", label: "Providers", tone: "client", x: 800, y: 65, detail: "OpenAI, Anthropic and others, over HTTPS." },
    { id: "dpa", label: "data-plane-agent", sub: "outbound tunnel", x: 430, y: 195, detail: "Holds the tunnel to the control plane and dispatches runs to the engine." },
    { id: "we", label: "workflow-engine", sub: ":50052", x: 615, y: 195, detail: "Event-sourced durable steps; llm_call via the router, tool_call via the manager." },
    { id: "rs", label: "runtime-scheduler", sub: ":50055", x: 800, y: 195, detail: "Placement across nodes; Postgres advisory-lock leader election." },
    { id: "rm", label: "runtime-manager", sub: ":50054", tone: "host", x: 800, y: 335, detail: "Per-node VM lifecycle; egress broker in broker mode." },
    { id: "h", label: "harness", sub: "PID 1 in the VM", tone: "guest", x: 615, y: 335, detail: "Rust. Heartbeats, secrets socket, egress enforcement, tool runner." },
    { id: "pg", label: "Postgres", sub: "runs · journal · RLS", tone: "store", x: 430, y: 467 },
    { id: "red", label: "Redis", sub: "cache · pub/sub · locks", tone: "store", x: 615, y: 467 },
    { id: "obj", label: "S3 / MinIO", sub: "bundles · snapshots", tone: "store", x: 800, y: 467 },
  ],
  edges: [
    { from: "gw", to: "cps" },
    { from: "gw", to: "mr", via: [[105, 48], [505, 48]] },
    { from: "mr", to: "prov" },
    { from: "cps", to: "not", via: [[215, 92], [215, 202]] },
    { from: "cps", to: "bil", via: [[215, 92], [215, 292]] },
    { from: "cps", to: "sch", via: [[215, 92], [215, 382]] },
    { from: "cps", to: "dpa" },
    { from: "dpa", to: "we" },
    { from: "we", to: "rs" },
    { from: "rs", to: "rm" },
    { from: "rm", to: "h" },
    { from: "cps", to: "pg", kind: "store", via: [[400, 92], [400, 494]] },
    { from: "we", to: "red", kind: "store", via: [[600, 222], [600, 440], [690, 440]] },
    { from: "rm", to: "obj", kind: "store" },
  ],
  legend: [["rt", "Hot path or API"], ["host", "Host"], ["guest", "Inside the VM"], ["store", "Store"]],
};

// ---------------------------------------------------------------------------
export const TRUST_BOUNDARIES: FlowDef = {
  id: "trust-boundaries",
  title: "Security trust boundaries",
  caption: "What a caller must present at each hop, from the internet to code inside a microVM. Step through the boundaries in order.",
  vb: [1000, 650],
  frames: [
    { label: "microVM wall", x: 440, y: 478, w: 548, h: 150, kind: "wall" },
  ],
  nodes: [
    { id: "ext", label: "External caller", sub: "untrusted", tone: "client", x: 40, y: 30 },
    { id: "gw", label: "Gateway", sub: ":8443", tone: "rt", x: 40, y: 140 },
    { id: "cp", label: "Control plane", sub: ":50051", tone: "rt", x: 330, y: 140, detail: "Holds the credential key. Stamps tenant_id from the verified credential." },
    { id: "mr", label: "Model router", sub: ":50053", x: 620, y: 40, detail: "Carries tenant provider keys per call; never logged or traced." },
    { id: "rls", label: "Postgres RLS", sub: "tenant_isolation", tone: "store", x: 40, y: 270, detail: "USING and WITH CHECK on every tenant table; tenant work runs on a non-superuser app role." },
    { id: "we", label: "Workflow engine", sub: ":50052", x: 230, y: 270 },
    { id: "sc", label: "Scheduler", sub: ":50055", x: 480, y: 270 },
    { id: "relay", label: "Secret relay", sub: "/v1/runtime/secrets/resolve", x: 760, y: 270, w: 200, detail: "The manager asks; the control plane decrypts. The manager never holds the key. Fail-closed 403 without the runtime token." },
    { id: "rm", label: "Runtime manager", sub: ":50054", tone: "host", x: 480, y: 390 },
    { id: "eb", label: "Egress broker", sub: "host", tone: "host", x: 680, y: 390, detail: "Allowlist, credential injection, DLP. The secret is resolved on the host and never enters the VM." },
    { id: "net", label: "Internet", tone: "client", x: 860, y: 390, w: 120 },
    { id: "h", label: "Harness", sub: "PID 1", x: 465, y: 520, detail: "Seccomp, dropped capabilities, read-only rootfs; the workload runs under a dropped uid." },
    { id: "w", label: "Workload", sub: "user code", tone: "guest", x: 645, y: 520 },
    { id: "sec", label: "Secrets socket", sub: "SO_PEERCRED", x: 825, y: 520, w: 145, detail: "Vends only to the workload uid the manager injected." },
  ],
  edges: [
    { from: "ext", to: "gw", label: "TLS + JWT / API key" },
    { from: "gw", to: "cp", label: "tenant stamped" },
    { from: "cp", to: "we", label: "service token" },
    { from: "cp", to: "sc", label: "service token" },
    { from: "cp", to: "mr", label: "service token" },
    { from: "sc", to: "rm", label: "token + client TLS" },
    { from: "cp", to: "rls", label: "WithTenant GUC", at: 0.4 },
    { from: "we", to: "rls" },
    { from: "rm", to: "h", label: "vsock only", at: 0.3 },
    { from: "h", to: "rm", label: "per-VM cert refused", kind: "deny", via: [[650, 462]], at: 0.8 },
    { from: "h", to: "w", label: "drop uid" },
    { from: "h", to: "sec", via: [[540, 606], [897, 606]] },
    { from: "w", to: "eb", label: "egress via vsock", kind: "guest" },
    { from: "eb", to: "net", label: "allowlist" },
    { from: "rm", to: "relay" },
    { from: "relay", to: "cp" },
  ],
  scenarios: [
    {
      id: "walk",
      label: "Boundary by boundary",
      steps: [
        { title: "The edge", note: "TLS plus a JWT or an API key. API keys are introspected by the control plane and cached for 60 s keyed by a SHA-256 of the key; any error fails closed.", edges: ["ext>gw"] },
        { title: "Tenant from the credential", note: "The tenant is taken from the verified token, never from a body or a path.", edges: ["gw>cp"] },
        { title: "Every internal gRPC port is a trust boundary", note: "x-lantern-service-token, checked in constant time before tenant extraction. Without it a caller cannot set tenant_id. Fail-closed in production.", edges: ["cp>we", "cp>sc", "cp>mr"] },
        { title: "The manager trusts only the scheduler and control plane", note: "Service token plus client TLS.", edges: ["sc>rm"] },
        { title: "Row-level security underneath", note: "WithTenant sets app.tenant_id; the policies filter every read and check every write. Cross-tenant returns nothing, and handlers answer 404 rather than leak existence.", edges: ["cp>rls", "we>rls"] },
        { title: "The VM wall", note: "Host and guest talk over vsock only. A per-VM certificate is refused on every RuntimeManager method: a guest reaches only the harness RPCs.", edges: ["rm>h", "h>rm"] },
        { title: "Privilege drop inside the VM", note: "The workload runs as its own uid with a filtered environment; PAL_* secrets are withheld.", edges: ["h>w"] },
        { title: "Secrets by peer credential", note: "The secrets socket checks SO_PEERCRED and vends only to the injected workload uid; denials are audited.", edges: ["h>sec"] },
        { title: "Egress through the host", note: "In broker mode the VM has no NIC. The host broker applies the allowlist and injects credentials on the way out.", edges: ["w>eb", "eb>net"] },
        { title: "Secrets resolve in one place", note: "The manager relays secret refs to the control plane, which alone holds the decryption key.", edges: ["rm>relay", "relay>cp"] },
      ],
    },
  ],
  legend: [["client", "Untrusted"], ["guest", "Untrusted code"], ["host", "Trusted host"], ["wall", "microVM wall"], ["deny", "Refused"]],
};

// ---------------------------------------------------------------------------
export const MODEL_ROUTING: FlowDef = {
  id: "model-routing",
  title: "Model routing and failover",
  caption: "Agents ask for a capability, not a model. Pick a scenario to see the default direct path, the router path, and how errors fall through.",
  vb: [980, 400],
  nodes: [
    { id: "caller", label: "Agent or app", sub: "model: \"auto\"", tone: "client", x: 30, y: 175, detail: "ctx.llm or POST /v1/completions with a capability such as auto or reasoning-large." },
    { id: "budget", label: "CheckBudget", sub: "agent + tenant caps", x: 220, y: 175, detail: "Per-agent and tenant-wide daily caps. A hard-fail limit returns 402 before any provider is called." },
    { id: "cp", label: "Control plane", sub: "callLLMWithFailover", tone: "rt", x: 410, y: 175, detail: "The seam. Router off (default): calls providers directly with a failover chain." },
    { id: "mr", label: "Model router", sub: ":50053", tone: "rt", x: 600, y: 40, detail: "4 strategies: cheap, fast, best, balanced. Opt-in with PAL_USE_MODEL_ROUTER." },
    { id: "cache", label: "Cache", sub: "prompt + semantic", tone: "store", x: 800, y: 40 },
    { id: "anth", label: "Provider A", sub: "e.g. Anthropic", tone: "client", x: 800, y: 170 },
    { id: "oai", label: "Provider B", sub: "e.g. OpenAI", tone: "client", x: 800, y: 310 },
    { id: "usage", label: "RecordUsage", sub: "agent_usage_daily", tone: "store", x: 410, y: 310, detail: "Runs on whatever tuple came back, whichever path served it." },
  ],
  edges: [
    { from: "caller", to: "budget" },
    { from: "budget", to: "cp" },
    { from: "cp", to: "mr", label: "ModelService.Complete" },
    { from: "mr", to: "cache" },
    { from: "mr", to: "anth" },
    { from: "cp", to: "anth", label: "Idempotency-Key", at: 0.45 },
    { from: "cp", to: "oai", label: "failover", at: 0.55 },
    { from: "cp", to: "usage" },
  ],
  scenarios: [
    {
      id: "direct", label: "Direct (default)",
      steps: [
        { title: "Ask by capability", note: "Service code never names a vendor model.", edges: ["caller>budget"] },
        { title: "Budget first", note: "Under every cap, so the call proceeds.", edges: ["budget>cp"], src: [M(`${H}/budgets.go`, 338)] },
        { title: "Direct to a provider", note: "Every request carries an Idempotency-Key derived from the run, step and attempt, so a retry or a crash-replay is deduplicated by the provider.", edges: ["cp>anth"], src: [M(`${H}/llm_idempotency.go`, 40)] },
        { title: "Usage recorded", note: "Tokens and cost into the daily rollup that the next budget check reads.", edges: ["cp>usage"] },
      ],
    },
    {
      id: "router", label: "Router on",
      steps: [
        { title: "Same entry", note: "Capability in, budget checked.", edges: ["caller>budget", "budget>cp"] },
        { title: "Offloaded to the router", note: "Plain completions only. The tenant's key ships per call in provider_credentials and is never logged.", edges: ["cp>mr"], src: [M(`${H}/llm_proxy_router.go`, 178)] },
        { title: "Cache, then route", note: "A cache hit answers without a provider call; otherwise the strategy picks a model.", edges: ["mr>cache", "mr>anth"] },
        { title: "Usage recorded", note: "Same accounting as the direct path.", edges: ["cp>usage"] },
      ],
    },
    {
      id: "fallback", label: "Router error",
      steps: [
        { title: "Router unreachable", note: "A dial error, timeout, non-OK or empty body.", edges: ["caller>budget", "budget>cp", "cp>mr"], deny: true },
        { title: "Falls through, silently", note: "Any router error falls through to the direct provider chain; the caller never sees it.", edges: ["cp>anth"] },
        { title: "Usage recorded", note: "On the tuple that actually came back.", edges: ["cp>usage"] },
      ],
    },
    {
      id: "failover", label: "Provider failover",
      steps: [
        { title: "Provider A is rate-limited", note: "A 429 or 5xx from the first provider.", edges: ["budget>cp", "cp>anth"], deny: true },
        { title: "Next in the chain", note: "The failover target gets its own provider-suffixed idempotency key.", edges: ["cp>oai"] },
        { title: "Usage recorded", note: "Once, for the call that succeeded.", edges: ["cp>usage"] },
      ],
    },
    {
      id: "over", label: "Over budget",
      steps: [
        { title: "Ask by capability", note: "As before.", edges: ["caller>budget"] },
        { title: "402, no provider call", note: "A hard-fail cap is reached: the request is refused before it costs anything.", nodes: ["caller", "budget"], edges: ["caller>budget"], deny: true },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
export const BUDGET_EVAL_GATE: FlowDef = {
  id: "budget-eval",
  title: "Budgets, forecasts and the eval gate",
  caption: "Two gates keep agents safe to ship: spend is checked before a run starts, and quality is checked before a change merges.",
  vb: [980, 430],
  frames: [
    { label: "Spend · before every run", x: 15, y: 10, w: 950, h: 205, kind: "zone" },
    { label: "Quality · before every merge", x: 15, y: 230, w: 950, h: 190, kind: "zone" },
  ],
  nodes: [
    { id: "req", label: "Run request", tone: "client", x: 30, y: 85 },
    { id: "fc", label: "Forecast", sub: "/v1/runs/forecast", x: 215, y: 85, detail: "Estimated tokens, cost and confidence, plus wouldExceedBudget and the block reason." },
    { id: "budget", label: "CheckBudget", sub: "agent_budgets", tone: "rt", x: 400, y: 85, detail: "Cost per day and per run, tokens per day, runs per day, per-tool limits, and a tenant-wide cap (agent_name '*')." },
    { id: "d402", label: "HTTP 402", sub: "no compute, no tokens", tone: "deny", x: 610, y: 35 },
    { id: "run", label: "Run executes", tone: "ok", x: 610, y: 140 },
    { id: "usage", label: "Usage rollup", sub: "agent_usage_daily", tone: "store", x: 800, y: 140, detail: "Workflow LLM steps and web search accrue cost without inflating the runs-per-day count." },
    { id: "ci", label: "CI", sub: "commit · branch", tone: "client", x: 30, y: 300 },
    { id: "er", label: "Eval run", sub: "POST /v1/eval-runs", x: 215, y: 300 },
    { id: "base", label: "Branch baseline", sub: "eval_baselines", tone: "store", x: 400, y: 300, detail: "A pinned eval run per (agent, branch). Rehearsals add past failures as cases." },
    { id: "d422", label: "HTTP 422", sub: "regressed", tone: "deny", x: 610, y: 255 },
    { id: "ship", label: "Merge · deploy", tone: "ok", x: 610, y: 350 },
    { id: "exp", label: "A/B experiment", sub: "auto-promote > 2% lift", x: 800, y: 350, detail: "Deterministic FNV-1a traffic split; promotes the winner once both arms have enough runs." },
  ],
  edges: [
    { from: "req", to: "fc" },
    { from: "fc", to: "budget" },
    { from: "budget", to: "d402", kind: "deny" },
    { from: "budget", to: "run" },
    { from: "run", to: "usage" },
    { from: "usage", to: "budget", label: "read by the next check", dashed: true, via: [[875, 200], [475, 200]], at: 0.5 },
    { from: "ci", to: "er" },
    { from: "er", to: "base", label: "compare" },
    { from: "base", to: "d422", kind: "deny" },
    { from: "base", to: "ship" },
    { from: "ship", to: "exp" },
  ],
  scenarios: [
    {
      id: "under", label: "Under budget",
      steps: [
        { title: "Forecast", note: "Optional, and cheap: what will this run cost, and would it break a budget?", edges: ["req>fc"] },
        { title: "Checked before anything is created", note: "Limits read from the daily rollup of earlier runs.", edges: ["fc>budget"] },
        { title: "Run executes", note: "Under every cap.", edges: ["budget>run"] },
        { title: "Spend recorded", note: "The rollup the next check reads; a day rolls at the deployment's local midnight.", edges: ["run>usage", "usage>budget"] },
      ],
    },
    {
      id: "over", label: "Over budget",
      steps: [
        { title: "Forecast says it would exceed", note: "wouldExceedBudget is true, with the reason.", edges: ["req>fc"] },
        { title: "Hard-fail: 402", note: "No run row, no compute, no tokens. Voice calls are declined the same way.", edges: ["fc>budget", "budget>d402"], deny: true },
      ],
    },
    {
      id: "pass", label: "Eval passes",
      steps: [
        { title: "CI records the suite's results", note: "Per case, with agent version, commit and branch.", edges: ["ci>er"] },
        { title: "Compared with the branch baseline", note: "Not worse than the pinned run.", edges: ["er>base"] },
        { title: "Safe to merge", note: "Then traffic can shift gradually through an experiment.", edges: ["base>ship", "ship>exp"] },
      ],
    },
    {
      id: "regress", label: "Regression",
      steps: [
        { title: "CI records the suite's results", note: "As before.", edges: ["ci>er"] },
        { title: "Worse than baseline: 422", note: "The CI step fails, so the change does not merge.", edges: ["er>base", "base>d422"], deny: true },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
export const DEPLOY_TOPOLOGY: FlowDef = {
  id: "topology",
  title: "Design time on a laptop, the same bundle in the cloud",
  caption: "One immutable agent bundle moves from a laptop stack to a data plane in your VPC. Pick local or cloud and step through.",
  vb: [980, 570],
  frames: [
    { label: "Local design time · laptop", x: 20, y: 30, w: 450, h: 440, kind: "zone" },
    { label: "Cloud · control plane", x: 490, y: 40, w: 470, h: 110, kind: "cp" },
    { label: "Cloud · data plane in your VPC", x: 490, y: 170, w: 470, h: 300, kind: "dp" },
  ],
  nodes: [
    { id: "cli", label: "lantern dev", sub: "· agent dev · doctor", tone: "client", x: 40, y: 60, detail: "One command boots Postgres, Redis, MinIO, the API and the console. agent dev hot-reloads, re-publishes and smoke-runs." },
    { id: "lcon", label: "Console", sub: ":3001", x: 250, y: 60 },
    { id: "lcp", label: "Control plane", sub: ":8080", tone: "rt", x: 40, y: 170 },
    { id: "lpg", label: "Postgres", tone: "store", x: 40, y: 280, w: 120 },
    { id: "lrd", label: "Redis", tone: "store", x: 175, y: 280, w: 120 },
    { id: "lmin", label: "MinIO", tone: "store", x: 310, y: 280, w: 120 },
    { id: "lima", label: "Lima guest", sub: "real Firecracker", tone: "guest", x: 40, y: 390, detail: "Apple Silicon M3 or later, macOS 15+: a Linux guest with nested KVM runs real Firecracker and the jailer." },
    { id: "stub", label: "Stub scheduler", sub: "no KVM", x: 250, y: 390, detail: "Without a scheduler address the dev control plane fabricates VM ids and spawns nothing. Refused in production." },
    { id: "bundle", label: "agent_version", sub: "immutable digest", tone: "rt", x: 300, y: 495, w: 180 },
    { id: "ccp", label: "Control plane", tone: "rt", x: 515, y: 75, w: 130 },
    { id: "ccon", label: "Console", x: 665, y: 75, w: 130 },
    { id: "cmr", label: "Model router", x: 815, y: 75, w: 130 },
    { id: "cdpa", label: "Data-plane agent", sub: "outbound", x: 515, y: 205, w: 130 },
    { id: "cwe", label: "Workflow engine", x: 665, y: 205, w: 130 },
    { id: "crs", label: "Scheduler", sub: "leader-elected", x: 815, y: 205, w: 130 },
    { id: "cpg", label: "Postgres", tone: "store", x: 515, y: 320, w: 130 },
    { id: "cfc", label: "microVMs", sub: "KVM nodes", tone: "guest", x: 665, y: 320, w: 130 },
    { id: "crm", label: "Runtime manager", tone: "host", x: 815, y: 320, w: 130 },
  ],
  edges: [
    { from: "cli", to: "lcp" },
    { from: "lcon", to: "lcp" },
    { from: "lcp", to: "lpg", kind: "store" },
    { from: "lcp", to: "lrd", kind: "store" },
    { from: "lcp", to: "lmin", kind: "store" },
    { from: "lcp", to: "lima", dashed: true, via: [[30, 197], [30, 417]], at: 0.5 },
    { from: "lcp", to: "stub", dashed: true, via: [[450, 197], [450, 417]], at: 0.5 },
    { from: "cli", to: "bundle", label: "publish", via: [[10, 87], [10, 522]], at: 0.9 },
    { from: "bundle", to: "cdpa", label: "same artifact", via: [[505, 522], [505, 232]], at: 0.15 },
    { from: "cdpa", to: "ccp", label: "mTLS tunnel", dashed: true },
    { from: "cdpa", to: "cwe" },
    { from: "cwe", to: "crs" },
    { from: "crs", to: "crm" },
    { from: "crm", to: "cfc" },
    { from: "cwe", to: "cpg", kind: "store" },
  ],
  scenarios: [
    {
      id: "local", label: "Design time (local)",
      steps: [
        { title: "One command", note: "lantern dev boots the whole stack; lantern doctor reports what is missing.", edges: ["cli>lcp", "lcon>lcp"] },
        { title: "Same stores as production", note: "Postgres, Redis and MinIO in containers.", edges: ["lcp>lpg", "lcp>lrd", "lcp>lmin"] },
        { title: "Real sandboxes via Lima", note: "With a scheduler address set, runs reach real Firecracker in a Lima guest.", edges: ["lcp>lima"] },
        { title: "Or an honest stub", note: "Without KVM the stub fabricates VM ids so the console and API still work. Production refuses to start with it.", edges: ["lcp>stub"] },
      ],
    },
    {
      id: "cloud", label: "Ship to cloud",
      steps: [
        { title: "Publish a bundle", note: "An immutable agent_version: digest, bundle URI, manifest.", edges: ["cli>bundle"] },
        { title: "The same artifact runs in your VPC", note: "The data plane pulls the bundle; nothing is rebuilt.", edges: ["bundle>cdpa"] },
        { title: "Outbound-only tunnel", note: "The data-plane agent dials the control plane over mTLS. No inbound ports.", edges: ["cdpa>ccp"] },
        { title: "Placed on KVM nodes", note: "Engine, leader-elected scheduler, manager, microVMs.", edges: ["cdpa>cwe", "cwe>crs", "crs>crm", "crm>cfc"] },
        { title: "Durable state in your account", note: "Run data stays in the data plane's Postgres.", edges: ["cwe>cpg"] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
export const AGENT_NETWORK: FlowDef = {
  id: "agent-network",
  title: "MCP, A2A and the marketplace",
  caption: "How an agent gets tools, how other agents find and call it, and how a published agent is bought and settled.",
  vb: [1000, 500],
  nodes: [
    { id: "mcp", label: "MCP registry", sub: "mcp_servers", tone: "store", x: 30, y: 40, detail: "A curated catalog of MCP servers, browsable by category." },
    { id: "att", label: "Attachment", sub: "agent_mcp_attachments", x: 230, y: 40, w: 170, detail: "POST /v1/agents/{name}/mcp-servers attaches a server, with config, to one agent." },
    { id: "agent", label: "Your agent", sub: "private by default", tone: "rt", x: 450, y: 180, w: 170, detail: "agents.is_public defaults to false." },
    { id: "caller", label: "Another agent", sub: "any tenant", tone: "client", x: 30, y: 300 },
    { id: "wk", label: "Directory", sub: "/.well-known/agent.json", x: 220, y: 240, w: 180, detail: "Lists only is_public agents." },
    { id: "card", label: "A2A card", sub: "/v1/agents/{name}/card", x: 220, y: 345, w: 180, detail: "Your own agent, or a public one. Anything else is 404, not 403, so a private agent's existence never leaks." },
    { id: "mkt", label: "Marketplace", sub: "/v1/marketplace", x: 660, y: 40, detail: "Publish, fork, star." },
    { id: "fork", label: "Fork", sub: "into your tenant", x: 850, y: 40, w: 130 },
    { id: "inv", label: "Invoke", sub: "cross-tenant, by slug", x: 660, y: 300, w: 170, detail: "The run executes on the seller's tenant, with the seller's keys and budgets." },
    { id: "buyer", label: "Buyer tenant", tone: "client", x: 850, y: 300, w: 130 },
    { id: "rcpt", label: "Signed receipt", sub: "verify at /proof", tone: "ok", x: 850, y: 410, w: 130, detail: "HMAC-signed settlement receipt, verifiable through the same endpoint as run receipts." },
  ],
  edges: [
    { from: "mcp", to: "att", label: "attach" },
    { from: "att", to: "agent" },
    { from: "caller", to: "wk", label: "discover" },
    { from: "caller", to: "card" },
    { from: "wk", to: "agent", label: "is_public only" },
    { from: "card", to: "agent" },
    { from: "agent", to: "mkt", label: "publish" },
    { from: "mkt", to: "fork" },
    { from: "buyer", to: "inv" },
    { from: "inv", to: "agent", label: "runs on seller tenant" },
    { from: "agent", to: "rcpt", via: [[535, 437]] },
    { from: "rcpt", to: "buyer" },
  ],
  scenarios: [
    {
      id: "mcp", label: "Attach MCP tools",
      steps: [
        { title: "Pick a server", note: "From the curated registry.", nodes: ["mcp"] },
        { title: "Attach it to one agent", note: "Per-agent, with its own config.", edges: ["mcp>att", "att>agent"] },
      ],
    },
    {
      id: "a2a", label: "A2A discovery",
      steps: [
        { title: "Discover", note: "The well-known directory lists only public agents.", edges: ["caller>wk", "wk>agent"] },
        { title: "Read the card", note: "Capabilities and how to call it. A caller always sees its own agents, scoped by its own credential.", edges: ["caller>card", "card>agent"] },
      ],
    },
    {
      id: "private", label: "Private agent",
      steps: [
        { title: "Card for someone else's private agent", note: "Neither public nor owned by the caller.", edges: ["caller>card"] },
        { title: "404, not 403", note: "The same answer as an agent that does not exist, so nothing leaks.", nodes: ["caller", "card"], edges: ["caller>card"], deny: true },
      ],
    },
    {
      id: "buy", label: "Marketplace invoke",
      steps: [
        { title: "Publish", note: "A tenant-local agent becomes a marketplace entry; others can fork or star it.", edges: ["agent>mkt", "mkt>fork"] },
        { title: "A buyer invokes it", note: "Cross-tenant, by slug.", edges: ["buyer>inv"] },
        { title: "Runs on the seller's tenant", note: "The seller's LLM keys and budgets; the buyer never sees them.", edges: ["inv>agent"] },
        { title: "Output plus a signed receipt", note: "Settlement the buyer can verify independently.", edges: ["agent>rcpt", "rcpt>buyer"] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
export const TENANCY_RLS: FlowDef = {
  id: "tenancy",
  title: "Multi-tenancy and row-level security",
  caption: "The tenant comes from a verified credential, travels in a database setting, and every tenant table filters on it.",
  vb: [980, 380],
  nodes: [
    { id: "req", label: "Request", sub: "JWT or API key", tone: "client", x: 30, y: 60 },
    { id: "auth", label: "Auth", sub: "tenant from token", tone: "rt", x: 215, y: 60, detail: "Never from a body, a path, or a header the caller controls." },
    { id: "wt", label: "WithTenant", sub: "SET app.tenant_id", tone: "rt", x: 400, y: 60, detail: "Server.WithTenant(ctx, fn) sets the GUC for the transaction." },
    { id: "app", label: "App pool", sub: "non-superuser role", x: 590, y: 60, detail: "A superuser bypasses RLS whatever the GUC says, so tenant work runs on the restricted role." },
    { id: "pg", label: "RLS policy", sub: "USING + WITH CHECK", tone: "store", x: 790, y: 60, detail: "tenant_id::text = current_setting('app.tenant_id'). A permanent catalog test fails the build if a new tenant table has no policy." },
    { id: "ra", label: "Tenant A rows", tone: "ok", x: 790, y: 180 },
    { id: "rb", label: "Tenant B rows", tone: "store", x: 790, y: 290 },
    { id: "svc", label: "Internal caller", sub: "gRPC", tone: "client", x: 30, y: 230 },
    { id: "tok", label: "Service-token check", sub: ":50051 · :50052 · :50055", x: 215, y: 230, w: 175, detail: "Runs before tenant extraction; constant-time compare; fail-closed in production." },
  ],
  edges: [
    { from: "req", to: "auth" },
    { from: "auth", to: "wt" },
    { from: "wt", to: "app" },
    { from: "app", to: "pg" },
    { from: "pg", to: "ra" },
    { from: "pg", to: "rb", via: [[760, 87], [760, 317]] },
    { from: "svc", to: "tok" },
    { from: "tok", to: "wt", label: "tenant_id in metadata" },
  ],
  scenarios: [
    {
      id: "same", label: "Same tenant",
      steps: [
        { title: "Authenticate", note: "The credential names the tenant.", edges: ["req>auth"] },
        { title: "Scope the transaction", note: "app.tenant_id is set for this transaction only.", edges: ["auth>wt", "wt>app"] },
        { title: "Policy admits the rows", note: "Reads see tenant A's rows; writes must carry tenant A's id.", edges: ["app>pg", "pg>ra"] },
      ],
    },
    {
      id: "cross", label: "Cross-tenant",
      steps: [
        { title: "Ask for tenant B's run by id", note: "Tenant A's credential, tenant B's run id.", edges: ["req>auth", "auth>wt", "wt>app", "app>pg"] },
        { title: "Zero rows, then 404", note: "The policy filters B's rows out; the handler answers NotFound so nothing about B leaks. No cross-tenant joins, ever.", edges: ["pg>rb"], deny: true },
      ],
    },
    {
      id: "spoof", label: "Spoofed gRPC tenant",
      steps: [
        { title: "A caller sets tenant_id in metadata", note: "Reachable to an internal port, but without the service token.", edges: ["svc>tok"] },
        { title: "Refused before tenant extraction", note: "No token, no tenant. Run-mutating engine RPCs also filter by the verified tenant and return NotFound on mismatch.", nodes: ["svc", "tok"], edges: ["svc>tok"], deny: true },
      ],
    },
  ],
};
