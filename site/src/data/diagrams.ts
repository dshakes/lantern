// Data for the static HTML diagrams (SysDiagram.astro, LayerStack.astro), ported
// from the former docs app's SystemDiagram, RuntimeDiagram, RuntimeArchitectureMap
// and PersonalHarnessArchitecture components. hrefs are docs paths relative to
// <base>/docs/ ('' = no link). Tones: rt / pal / host / guest / wall / deny / violet.
export type Cell = { name: string; sub?: string; href?: string };
export type SysBlock =
  | { kind: 'actors'; items: (Cell & { tone?: string })[] }
  | { kind: 'conn'; label: string }
  | { kind: 'tunnel'; label: string }
  | { kind: 'boundary'; plane: 'cp' | 'dp'; tag: string; items: Cell[]; note?: string };

// System context: who calls PAL Runtime, what runs where, what it calls out to.
export const SYSTEM: SysBlock[] = [
  { kind: 'actors', items: [
    { name: 'Developers', sub: 'SDK · CLI · REST · dashboard', href: 'start/quickstart', tone: 'rt' },
    { name: 'End users', sub: 'WhatsApp · Slack · Telegram · Web · Voice', href: 'pal/surfaces', tone: 'pal' },
  ] },
  { kind: 'conn', label: 'requests' },
  { kind: 'boundary', plane: 'cp', tag: 'Control plane · run it anywhere', note: 'Multi-tenant. Never touches your code.', items: [
    { name: 'Gateway & Auth', sub: 'TLS · JWT / API key · streaming', href: 'runtime/security' },
    { name: 'API & RBAC', sub: 'agents · runs · sessions', href: 'reference/api' },
    { name: 'Model Router', sub: 'capability routing · cache', href: 'build/models' },
    { name: 'Workflow Engine', sub: 'durable steps · replay', href: 'runtime/durable-execution' },
    { name: 'Scheduler', sub: 'cron · fair-share · retries', href: 'build/scheduling' },
    { name: 'Evals & Budgets', sub: '402 / 422 CI gates', href: 'build/evaluations' },
    { name: 'Marketplace & MCP', sub: 'agents · tools · A2A', href: 'build/marketplace' },
    { name: 'Observability', sub: 'OTel traces · metrics', href: 'runtime/observability' },
  ] },
  { kind: 'tunnel', label: '↑ outbound-only connection from your VPC · no inbound ports ↑' },
  { kind: 'boundary', plane: 'dp', tag: 'Your VPC · data plane', note: 'Code, prompts and data stay in your network.', items: [
    { name: 'Runtime Manager', sub: 'spawns sandboxes · isolation tier', href: 'runtime/' },
    { name: 'Agent microVMs', sub: 'Firecracker · Kata · K8s', href: 'runtime/isolation' },
    { name: 'Harness', sub: 'egress allowlist · secret vending', href: 'runtime/identity' },
    { name: 'Data stores', sub: 'Postgres · Redis · S3', href: 'operate/deployment' },
  ] },
  { kind: 'conn', label: 'calls out' },
  { kind: 'actors', items: [
    { name: 'LLM providers', sub: 'OpenAI · Anthropic · local', href: 'build/models', tone: 'host' },
    { name: 'Your APIs and data', sub: '18 connectors · in your network', href: 'build/connectors', tone: 'guest' },
  ] },
];

// The headless-runtime execution path: one spec, two trust boundaries.
export const RUN_PATH: SysBlock[] = [
  { kind: 'actors', items: [{ name: 'lantern run agent.yaml', sub: 'submit the spec: image · isolation · limits · egress · secrets', href: 'runtime/quickstart', tone: 'rt' }] },
  { kind: 'conn', label: 'schedules' },
  { kind: 'boundary', plane: 'cp', tag: 'Control plane', note: 'Schedules the spec onto a node; never runs your workload itself.', items: [
    { name: 'control-plane', sub: 'RBAC + quota gate · 402 over quota', href: 'runtime/' },
    { name: 'runtime-scheduler', sub: 'warm pool · region · cost · health', href: 'runtime/isolation' },
  ] },
  { kind: 'tunnel', label: '↓ gRPC · authenticated tenant ↓' },
  { kind: 'boundary', plane: 'dp', tag: 'Your VPC · data plane', note: 'The manager sets the isolation tier; the harness streams logs and traces and vends short-lived secrets.', items: [
    { name: 'runtime-manager', sub: 'builds the sandbox · sets RuntimeClass', href: 'runtime/' },
    { name: 'Sandbox · RuntimeClass', sub: 'runc · gVisor · Kata · Firecracker, by tier', href: 'runtime/isolation' },
    { name: 'harness (PID 1)', sub: 'egress allowlist · secret vending · logs', href: 'runtime/identity' },
  ] },
];

export type Layer = { tone: string; num: string; title: string; tagline: string; items: Cell[]; pill?: string; substrate?: string };
export type Stack = {
  edge: { label: string; cells: Cell[] };
  layers: Layer[];
  rail: { title: string; sub: string; items: string[]; href?: string };
  base: { label: string; cells: Cell[] };
};

// PAL Runtime as five layers: gate, execute, survive, observe, prove.
export const RUNTIME_MAP: Stack = {
  edge: { label: 'Entry points · every one becomes the same kind of run', cells: [
    { name: 'POST /v1/runs', href: 'reference/api' }, { name: 'Sessions', href: 'runtime/sessions-and-memory' },
    { name: 'Schedules', href: 'build/scheduling' }, { name: 'Channels', href: 'pal/surfaces' }, { name: 'A2A', href: 'build/marketplace' },
  ] },
  layers: [
    { tone: 'wall', num: '1 · Gate', title: 'Before a single token is spent', tagline: 'auth, money and trust, checked up front', items: [
      { name: 'Auth & tenancy', sub: 'JWT / API key · every row tenant-fenced', href: 'runtime/security' },
      { name: 'Budget gate', sub: 'hard caps → HTTP 402, run never starts', href: 'build/budgets' },
      { name: 'Isolation gate', sub: 'manifest declares the sandbox; the caller can’t override', href: 'runtime/isolation' },
    ] },
    { tone: 'violet', num: '2 · Execute', title: 'Two tiers, one contract', tagline: 'trusted code runs fast · untrusted runs in a microVM', items: [
      { name: 'Shared tier', sub: 'inline executor: LLM loop + workflow graphs', href: 'runtime/' },
      { name: 'MicroVM tier', sub: 'scheduler → manager → Firecracker / Kata', href: 'runtime/' },
      { name: 'Model router', sub: 'capability-addressed, never a hardcoded vendor', href: 'build/models' },
      { name: 'In-guest harness', sub: 'PID 1 · egress allowlist · tool runner', href: 'runtime/identity' },
    ] },
    { tone: 'guest', pill: 'the durability spine', num: '3 · Survive', title: 'The journal: every step written down first', tagline: 'crash mid-run? resume, don’t restart', substrate: 'Substrate: one Postgres journal_events log. Both tiers, the waterfall, receipts and replay all read it.', items: [
      { name: 'Event-sourced journal', sub: 'step_started → step_completed, always', href: 'runtime/durable-execution' },
      { name: 'Crash recovery', sub: '30 s sweep re-drives from the last checkpoint', href: 'runtime/durable-execution' },
      { name: 'Replay cache', sub: 'finished steps skipped, no re-spent tokens', href: 'runtime/durable-execution' },
      { name: 'Idempotency keys', sub: 'side effects fire once, even on retry', href: 'runtime/durable-execution' },
    ] },
    { tone: 'host', num: '4 · Observe', title: 'Watch it live', tagline: 'what is it doing right now?', items: [
      { name: 'Token streaming', sub: 'SSE deltas the moment they arrive', href: 'runtime/streaming' },
      { name: 'OTel traces', sub: 'tenant · run · step on every span', href: 'runtime/observability' },
      { name: 'Run waterfall', sub: 'per-step timing + cost in the dashboard', href: 'runtime/observability' },
      { name: 'Health sweep', sub: 'peer probes · alerts on transition', href: 'runtime/' },
    ] },
    { tone: 'rt', num: '5 · Prove', title: 'Evidence, not vibes', tagline: 'what did it do, and can you prove it?', items: [
      { name: 'Signed receipts', sub: 'Ed25519 over the journal, verify offline', href: 'runtime/receipts' },
      { name: 'Cost attribution', sub: 'tokens + USD per run, per day', href: 'build/budgets' },
      { name: 'Evals & rehearsals', sub: 'regressions blocked in CI (HTTP 422)', href: 'build/evaluations' },
    ] },
  ],
  rail: { title: 'Fail-closed by design', sub: 'when a guarantee can’t be met, the run fails loudly; it never downgrades silently', href: 'runtime/security',
    items: ['Never a bare pod', 'Deny-default egress', 'Secrets vended, never baked in', 'VM reports bound to their own run', 'microvm_unavailable, not a quiet fallback'] },
  base: { label: 'Data plane · your VPC', cells: [
    { name: 'runtime-scheduler', sub: ':50055 · placement', href: 'runtime/' }, { name: 'runtime-manager', sub: ':50054 · spawn', href: 'runtime/' },
    { name: 'harness', sub: 'in-VM · PID 1', href: 'runtime/identity' }, { name: 'agent.yaml', sub: 'your spec', href: 'runtime/quickstart' },
    { name: 'Helm / Terraform', sub: 'deploy it', href: 'operate/deployment' },
  ] },
};

// pal as five layers: sense, remember, reason, sound like you, act.
export const PAL_MAP: Stack = {
  edge: { label: 'Surfaces · where pal listens and replies', cells: [
    { name: 'iMessage', href: 'pal/surfaces' }, { name: 'WhatsApp', href: 'pal/surfaces' }, { name: 'Voice', href: 'pal/surfaces' },
    { name: 'Email', href: 'pal/surfaces' }, { name: 'Webchat', href: 'pal/surfaces' },
  ] },
  layers: [
    { tone: 'wall', num: 'L1 · Sense', title: 'Signals and ingestion', tagline: 'what’s actually happening', items: [
      { name: 'Device signals', sub: 'location · focus · driving · health · media' }, { name: 'Screen and app usage', sub: 'on-device · owner-only · off by default' },
      { name: 'Inbox ingestion', sub: 'email → life events' }, { name: 'Inbound messages', sub: 'every channel, every turn' },
    ] },
    { tone: 'violet', pill: 'cross-app memory', num: 'L2 · Remember', title: 'Memory and identity', tagline: 'one self across every channel', substrate: 'Substrate: local 0600 files on your Mac (the most personal ones encrypted) + control-plane Postgres with row-level security.', items: [
      { name: 'Person graph', sub: 'one identity per person across apps' }, { name: 'Episodic memory', sub: '14 days: date · topic · outcome' },
      { name: 'Topic index', sub: '7-day cross-thread recall' }, { name: 'Owner profile', sub: 'facts · relationships · style lessons' },
      { name: 'Presence', sub: 'live availability, never a place' }, { name: 'Life-events ledger', sub: 'bills · deliveries · travel · fraud alerts' },
    ] },
    { tone: 'guest', num: 'L3 · Reason', title: 'Deciding what to do', tagline: 'judgment, not keyword rules', items: [
      { name: 'Life-event engine', sub: 'classify + extract' }, { name: 'Auto-act ladder', sub: 'auto · ask · off, per kind' },
      { name: 'World model', sub: 'refreshed from mail + calendar' }, { name: 'Anticipation', sub: 'proactive nudges' }, { name: 'Scheduling', sub: 'propose · hold · confirm' },
    ] },
    { tone: 'pal', num: 'L4 · Sound like you', title: 'Persona and authenticity', tagline: 'reads like you wrote it', items: [
      { name: 'Owner voice', sub: 'learned from messages you really sent' }, { name: 'Language and dialect', sub: 'your languages, never invented words' },
      { name: 'Bot-tell guards', sub: 'suppress + regenerate' }, { name: 'Pacing', sub: 'your real reply speed, per person' }, { name: 'Claim checks', sub: 'never says it did what it didn’t' },
    ] },
    { tone: 'host', num: 'L5 · Act', title: 'Actions and delivery', tagline: 'follow through, for real', items: [
      { name: 'Replies', sub: 'paced · per channel' }, { name: 'Mac actions', sub: 'Calendar · Notes · Mail' },
      { name: 'Connectors', sub: 'Gmail · Calendar · …' }, { name: 'Voice calls', sub: 'Twilio · LiveKit' },
    ] },
  ],
  rail: { title: 'Holds, privacy and safety', sub: 'applies across every layer, enforced in code before every send', href: 'pal/human-in-the-loop',
    items: ['Money and promises held for your yes', 'Unverifiable claims held', 'Owner-only commands', 'Location never shared', 'Kill switch', 'Secrets never logged'] },
  base: { label: 'Runs on PAL Runtime', cells: [
    { name: 'Model router', sub: 'capability-routed LLM', href: 'build/models' }, { name: '/v1/people', sub: 'person graph' },
    { name: '/v1/memory', sub: 'cross-channel recall' }, { name: '/v1/signals', sub: 'device signals' }, { name: '/v1/life-events', sub: 'automations feed' },
  ] },
};
