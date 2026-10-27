import type { Src, Tone } from "./types";

// The architecture explorer's content. Every fact cites the line that backs it
// (origin/master, or the egress-broker commit for `ref: "broker"`).

export type Box = { x: number; y: number; w: number; h: number };

/** "store" = data-stores layer; "broker" / "guest" = only in that egress mode. */
export type Layer = "store" | "broker" | "guest";

export type ArchNode = {
  id: string;
  title: string;
  sub: string;
  tone: Tone;
  box: Box;
  plane?: "cp" | "dp" | "vm" | "outside";
  layer?: Layer;
  /** Short name of the credential this node demands from callers (trust overlay). */
  gate?: string;
  lang: string;
  ports?: string;
  role: string;
  boundary: string;
  invariants: string[];
  src: Src[];
  docs?: { href: string; label: string };
  zoom?: "manager" | "harness";
  /** Sub-components only: the node this one stands in for when you zoom back out. */
  external?: boolean;
};

export type ArchEdge = {
  from: string;
  to: string;
  label: string;
  layer?: Layer;
  via?: [number, number][];
  /** Where the label sits, as a fraction along the drawn path. */
  at?: number;
  bidi?: boolean;
};

export type Frame = { label: string; box: Box; kind: "cp" | "dp" | "wall" | "host" | "stores"; layer?: Layer };

export type ArchView = {
  id: "system" | "manager" | "harness";
  title: string;
  lede: string;
  vb: [number, number];
  frames: Frame[];
  nodes: ArchNode[];
  edges: ArchEdge[];
};

const B = (p: string, l?: number): Src => ({ p, l, ref: "broker" });
const M = (p: string, l?: number): Src => ({ p, l });

const CP = "services/control-plane";
const RM = "services/runtime-manager/src";
const HN = "services/harness/src";
const RS = "services/runtime-scheduler";
const WE = "services/workflow-engine";
const PROTO = "packages/proto/lantern/v1";

// ---------------------------------------------------------------------------
// System view
// ---------------------------------------------------------------------------

const systemNodes: ArchNode[] = [
  {
    id: "sdk", title: "SDKs", sub: "TypeScript · Python · Go", tone: "client",
    box: { x: 40, y: 24, w: 170, h: 56 }, plane: "outside",
    lang: "TypeScript, Python 3.11+, Go",
    role: "Typed clients for the REST API. Each one reads its base URL from LANTERN_API_URL.",
    boundary: "Untrusted caller. Every request carries a Bearer JWT or API key that the control plane validates.",
    invariants: ["Models are addressed by capability (\"auto\", \"reasoning-large\"), never by vendor name."],
    src: [M("packages/sdk-ts/src/client.ts", 83), M("packages/sdk-python/lantern/client.py", 64), M("packages/sdk-go/client.go", 53)],
    docs: { href: "/sdk", label: "SDK reference" },
  },
  {
    id: "cli", title: "lantern CLI", sub: "Go · Cobra", tone: "client",
    box: { x: 240, y: 24, w: 170, h: 56 }, plane: "outside",
    lang: "Go (Cobra)",
    role: "Static binary that wraps the same REST API: runs, sandboxes (lantern vm …), onboarding.",
    boundary: "Untrusted caller; authenticates like the SDKs.",
    invariants: [],
    src: [M("packages/cli")],
    docs: { href: "/cli", label: "CLI reference" },
  },
  {
    id: "dashboard", title: "Dashboard", sub: "Next.js · :3001", tone: "client",
    box: { x: 440, y: 24, w: 170, h: 56 }, plane: "outside",
    lang: "TypeScript (Next.js)", ports: ":3001 (dev)",
    role: "Operator UI over the same REST endpoints: agents, runs and their journal waterfall, sandboxes, budgets.",
    boundary: "Browser session; JWT-authenticated like any other caller.",
    invariants: [],
    src: [M("apps/web")],
  },
  {
    id: "llm", title: "LLM providers", sub: "Anthropic · OpenAI", tone: "plain",
    box: { x: 780, y: 24, w: 200, h: 56 }, plane: "outside",
    lang: "External HTTPS APIs",
    role: "Where completions come from. Reached directly by the control plane's failover chain (the default) or through the model router.",
    boundary: "External. Calls carry an Idempotency-Key so a retry or crash-replay is deduplicated at the provider.",
    invariants: ["Tenant provider keys are AES-256-GCM encrypted at rest and never logged."],
    src: [M(`${CP}/internal/handlers/llm_proxy.go`, 3591), M(`${CP}/internal/handlers/llm_idempotency.go`, 40), M("services/model-router/src/providers/anthropic.rs"), M("services/model-router/src/providers/openai.rs")],
    docs: { href: "/models", label: "Models" },
  },
  {
    id: "gateway", title: "Gateway", sub: "Rust · :8443 TLS", tone: "plain",
    box: { x: 40, y: 150, w: 170, h: 64 }, plane: "cp",
    lang: "Rust (Axum)", ports: ":8443 (TLS)",
    role: "Edge ingress. Terminates TLS, validates API keys by asking the control plane (cached 60 s by key hash), and calls the control plane over gRPC.",
    boundary: "Public edge. Sends x-lantern-service-token on its gRPC calls; refuses API-key auth when introspection is not configured.",
    invariants: ["Without LANTERN_TLS_CERT/KEY it serves plaintext and warns: never in production."],
    src: [M("services/gateway/src/config.rs", 26), M("services/gateway/src/config.rs", 31), M("services/gateway/src/introspect.rs", 128), M("services/gateway/src/tls.rs", 51)],
  },
  {
    id: "cp", title: "Control plane", sub: "Go · :8080 REST · :50051 gRPC", tone: "plain",
    box: { x: 290, y: 146, w: 260, h: 72 }, plane: "cp", gate: "service token",
    lang: "Go", ports: ":8080 HTTP (REST + SSE) · :50051 gRPC",
    role: "Owns agents, runs, budgets and tenants. Gates every run (auth, budget, isolation), runs shared-tier agents inline, and journals every step to Postgres.",
    boundary: "Trust boundary on :50051: only callers presenting x-lantern-service-token may set a tenant_id. Refuses to start in prod without the token.",
    invariants: [
      "Hard-fail budgets block a run with HTTP 402 before any compute or tokens are spent.",
      "Every tenant-scoped query runs through WithTenant so Postgres RLS can enforce it.",
      "A crashed run is re-driven from its journal by a 30 s recovery sweep.",
    ],
    src: [M(`${CP}/cmd/server/main.go`, 851), M(`${CP}/cmd/server/main.go`, 1123), M(`${CP}/cmd/server/main.go`, 217), M(`${CP}/internal/handlers/rest.go`, 579), M(`${CP}/internal/handlers/recovery.go`, 476)],
    docs: { href: "/runtime/durable-execution", label: "Durable execution" },
  },
  {
    id: "router", title: "Model router", sub: "Rust · :50053", tone: "plain",
    box: { x: 640, y: 150, w: 200, h: 64 }, plane: "outside", gate: "service token",
    lang: "Rust", ports: ":50053 gRPC",
    role: "ModelService: Complete, CompleteStream, Embed, Tokenize. Maps a capability to a concrete provider model, with caching.",
    boundary: "Service-token gate on :50053. It carries tenant provider keys, so it refuses to start in prod without the token.",
    invariants: [
      "The control plane uses it only when LANTERN_USE_MODEL_ROUTER is on (default off); any router error falls through to the direct provider chain.",
      "Workflow-engine llm_call steps always go through it.",
    ],
    src: [M(`${PROTO}/models.proto`, 13), M("services/model-router/src/config.rs", 15), M("services/model-router/src/auth.rs", 1), M(`${CP}/internal/handlers/llm_proxy_router.go`, 73)],
    docs: { href: "/models", label: "Models" },
  },
  {
    id: "postgres", title: "Postgres", sub: "pgvector · pg16", tone: "store",
    box: { x: 970, y: 150, w: 170, h: 58 }, layer: "store",
    lang: "PostgreSQL 16 + pgvector", ports: ":5432",
    role: "System of record: tenants, agents, runs, the journal_events log, run_locks, budgets and usage rollups.",
    boundary: "Every tenant table has a tenant_isolation RLS policy, enforced when LANTERN_RLS_ENFORCE=1.",
    invariants: ["journal_events is append-only: step_started → step_completed / step_failed, keyed (run_id, seq)."],
    src: [M(`${CP}/internal/db/migrate.go`), M(`${CP}/internal/handlers/durable_replay.go`, 227)],
    docs: { href: "/stack#data", label: "Data stores" },
  },
  {
    id: "redis", title: "Redis", sub: "cache · pub/sub", tone: "store",
    box: { x: 970, y: 240, w: 170, h: 58 }, layer: "store",
    lang: "Redis", ports: ":6379",
    role: "Caching, rate limiting and session event pub/sub for SSE.",
    boundary: "Internal only.",
    invariants: [],
    src: [M(`${CP}/cmd/server/main.go`, 1122)],
    docs: { href: "/stack#data", label: "Data stores" },
  },
  {
    id: "s3", title: "S3 / MinIO", sub: "bundles · snapshots", tone: "store",
    box: { x: 970, y: 330, w: 170, h: 58 }, layer: "store",
    lang: "S3 API", ports: ":9000",
    role: "Agent bundles, attachments, and the optional second tier of microVM snapshots.",
    boundary: "Snapshot uploads are best-effort: the local copy on the node is authoritative.",
    invariants: [],
    src: [M(`${RM}/snapshot_store.rs`, 11)],
  },
  {
    id: "dpagent", title: "Data-plane agent", sub: "Go · dials out", tone: "plain",
    box: { x: 40, y: 330, w: 180, h: 64 }, plane: "dp",
    lang: "Go",
    role: "Runs in your VPC. Opens a RunStream to the control plane, receives run assignments, and drives each one on the local workflow engine.",
    boundary: "Dials out: the control plane never connects into your network. Each plane is bound to one tenant.",
    invariants: ["If no plane is connected for a tenant, the run executes inline in the control plane instead."],
    src: [M("services/data-plane-agent/internal/dispatcher/dispatcher.go", 131), M("services/data-plane-agent/cmd/agent/main.go", 153), M(`${CP}/internal/handlers/dataplane.go`, 697)],
    docs: { href: "/deployment", label: "Deployment" },
  },
  {
    id: "engine", title: "Workflow engine", sub: "Go · :50052", tone: "plain",
    box: { x: 290, y: 330, w: 200, h: 64 }, plane: "dp", gate: "service token",
    lang: "Go", ports: ":50052 gRPC",
    role: "Durable step executor: llm_call via the model router, tool_call via the runtime-manager, child_run in-engine. Each attempt is replay-checked before it runs.",
    boundary: "Service-token gate on :50052; Cancel/Resume/Signal also filter by the verified tenant_id and return NotFound on mismatch.",
    invariants: [
      "Idempotency key for every side effect: run_id:step_id:attempt.",
      "Missing router or manager address fails the step with a typed error, never a fabricated result.",
    ],
    src: [M(`${WE}/cmd/server/main.go`, 334), M(`${WE}/internal/engine/step_executor.go`, 135), M(`${WE}/internal/engine/step_executor.go`, 241), M(`${WE}/internal/journal/journal.go`, 28)],
    docs: { href: "/runtime/durable-execution", label: "Durable execution" },
  },
  {
    id: "scheduler", title: "Runtime scheduler", sub: "Go · :50055 · :8085", tone: "plain",
    box: { x: 600, y: 330, w: 220, h: 64 }, plane: "dp", gate: "service token",
    lang: "Go", ports: ":50055 gRPC · :8085 REST",
    role: "Places sandboxes on nodes (warm pool, capacity, fair share) and owns their lifecycle: pause, resume, fork, and the idle-suspend sweeper.",
    boundary: "Service-token gate on :50055. Tenant quota is reserved atomically (all-or-nothing for forks).",
    invariants: [
      "A PAUSED VM holds no concurrent-VM slot.",
      "Lifecycle mutations on one VM are serialized by a per-VM lock; only the leader replica mutates.",
    ],
    src: [M(`${RS}/cmd/scheduler/main.go`, 356), M(`${RS}/internal/placement/placement.go`, 1), M(`${RS}/internal/handlers/lifecycle.go`, 125), M(`${RS}/internal/handlers/idle_sweeper.go`, 34), M(`${RS}/internal/middleware/grpcauth.go`, 1)],
    docs: { href: "/runtime/sandbox-lifecycle", label: "Sandbox lifecycle" },
  },
  {
    id: "manager", title: "Runtime manager", sub: "Rust · :50054 · per node", tone: "host",
    box: { x: 290, y: 470, w: 260, h: 72 }, plane: "dp", gate: "token, no VM certs", zoom: "manager",
    lang: "Rust (tonic)", ports: ":50054 gRPC (mTLS)",
    role: "The only thing that touches microVMs: spawn, stop, snapshot/restore, exec, ExecTool. Serves RuntimeHarness for the guests on its node.",
    boundary: "Refuses any peer presenting a per-VM cert (OU=lantern-vm) on RuntimeManager methods and requires the service token from everyone else.",
    invariants: [
      "A VM owned by another tenant is indistinguishable from an absent one (NOT_FOUND).",
      "Untrusted code runs in Firecracker or Kata, never a bare pod.",
    ],
    src: [M(`${RM}/config.rs`, 81), M(`${RM}/authz.rs`, 1), M(`${RM}/service.rs`, 1752), M(`${PROTO}/runtime.proto`, 379)],
    docs: { href: "/runtime/isolation", label: "Isolation" },
  },
  {
    id: "broker", title: "Host egress broker", sub: "opt-in · in the manager", tone: "host",
    box: { x: 640, y: 470, w: 200, h: 64 }, plane: "dp", layer: "broker", gate: "allowlist",
    lang: "Rust (inside runtime-manager)",
    role: "Per-VM proxy on the host end of vsock port 3128. Applies the allowlist, dials upstream from the host, and injects credentials into requests to hosts whose rule says so.",
    boundary: "New trust boundary: host code parsing guest bytes. Heads capped at 64 KiB; error strings returned to the guest are static.",
    invariants: [
      "Opt-in: LANTERN_EGRESS_MODE=broker on the manager, Firecracker only. Default is guest mode.",
      "HTTPS is terminated only for hosts whose rule injects a credential; every other host is an opaque tunnel.",
      "The credential never enters the VM.",
    ],
    src: [B(`${RM}/egress_broker.rs`, 3), B(`${RM}/egress_broker.rs`, 713), B("docs/adr/0026-host-egress-broker.md", 25)],
    docs: { href: "/runtime/egress", label: "Egress" },
  },
  {
    id: "harness", title: "Harness", sub: "Rust · PID 1", tone: "host",
    box: { x: 310, y: 630, w: 230, h: 70 }, plane: "vm", gate: "SO_PEERCRED", zoom: "harness",
    lang: "Rust (musl, static)", ports: ":50056 exec (in guest)",
    role: "Init process inside every microVM: supervises the workload, serves exec and tool calls, vends short-TTL secrets, and enforces egress.",
    boundary: "The last in-VM boundary. The secrets socket only answers the workload uid (kernel-attested via SO_PEERCRED); the workload runs as its own uid with LANTERN_* env withheld.",
    invariants: ["Security audits are logged locally before forwarding and survive a manager outage."],
    src: [M(`${HN}/main.rs`, 1), M(`${HN}/supervisor.rs`, 1), M(`${HN}/secrets.rs`, 64), M(`${HN}/exec.rs`, 41)],
    docs: { href: "/runtime/identity", label: "Identity & secrets" },
  },
  {
    id: "workload", title: "Untrusted code", sub: "your agent's workload", tone: "guest",
    box: { x: 590, y: 630, w: 230, h: 70 }, plane: "vm",
    lang: "Anything: Python, Node, shell",
    role: "Code the agent wrote or downloaded. It sees /workspace, the proxy env, and nothing that identifies the control plane.",
    boundary: "Untrusted. Contained by the microVM wall (glass) and, in broker mode, has no network device at all.",
    invariants: ["Tool file operations are confined to /workspace with openat2 RESOLVE_BENEATH, as the workload's own uid."],
    src: [M(`${HN}/tool_runner.rs`, 33), M(`${HN}/supervisor.rs`, 102)],
    docs: { href: "/runtime/isolation", label: "Isolation" },
  },
  {
    id: "upstream", title: "Internet", sub: "allowlisted hosts only", tone: "plain",
    box: { x: 970, y: 630, w: 170, h: 70 }, plane: "outside",
    lang: "External",
    role: "Whatever the sandbox's egress rules allow. Everything else is denied and audited.",
    boundary: "Deny by default. Private and metadata ranges (incl. 169.254.169.254) are refused even when a hostname resolves to them.",
    invariants: [],
    src: [M(`${HN}/egress.rs`, 1), B(`${RM}/egress_broker.rs`, 145)],
    docs: { href: "/runtime/egress", label: "Egress" },
  },
];

const BUS = 945; // vertical bus that carries store edges into the stores column

const systemEdges: ArchEdge[] = [
  { from: "sdk", to: "gateway", label: "HTTPS :8443" },
  { from: "sdk", to: "cp", label: "REST /v1", at: 0.62 },
  { from: "cli", to: "cp", label: "" },
  { from: "dashboard", to: "cp", label: "" },
  { from: "gateway", to: "cp", label: "gRPC :50051" },
  { from: "cp", to: "router", label: "Complete (flag)" },
  { from: "cp", to: "llm", label: "direct (default)", at: 0.55 },
  { from: "router", to: "llm", label: "provider call", at: 0.5 },
  { from: "dpagent", to: "cp", label: "RunStream, dials out", at: 0.45 },
  { from: "dpagent", to: "engine", label: "ExecuteRun" },
  { from: "engine", to: "router", label: "llm_call", at: 0.78 },
  { from: "engine", to: "manager", label: "ExecTool", at: 0.55 },
  { from: "cp", to: "scheduler", label: "Schedule · Pause · Resume · Fork", at: 0.5 },
  { from: "cp", to: "manager", label: "exec · files", via: [[570, 250], [570, 470]], at: 0.5 },
  { from: "scheduler", to: "manager", label: "Spawn · Stop · Snapshot", at: 0.45 },
  { from: "manager", to: "cp", label: "report · secret relay", via: [[255, 506], [255, 250]], at: 0.22 },
  { from: "harness", to: "manager", label: "Heartbeat · Report ↑  Exec :50056 ↓", bidi: true, at: 0.42 },
  { from: "workload", to: "harness", label: ":3128" },
  { from: "harness", to: "upstream", label: "in-guest proxy → TAP", layer: "guest", via: [[425, 760], [1055, 760]], at: 0.6 },
  { from: "harness", to: "broker", label: "vsock 3128", layer: "broker", at: 0.4 },
  { from: "broker", to: "upstream", label: "allow · inject", layer: "broker", at: 0.5 },
  { from: "cp", to: "postgres", label: "SQL (RLS)", layer: "store", via: [[420, 118], [BUS, 118], [BUS, 179]], at: 0.55 },
  { from: "cp", to: "redis", label: "", layer: "store", via: [[420, 118], [BUS, 118], [BUS, 269]] },
  { from: "cp", to: "s3", label: "", layer: "store", via: [[420, 118], [BUS, 118], [BUS, 359]] },
  { from: "engine", to: "postgres", label: "journal", layer: "store", via: [[390, 432], [BUS, 432], [BUS, 179]], at: 0.6 },
  { from: "scheduler", to: "postgres", label: "", layer: "store", via: [[710, 432], [BUS, 432], [BUS, 179]] },
  { from: "manager", to: "s3", label: "snapshots (optional)", layer: "store", via: [[420, 562], [BUS, 562], [BUS, 359]], at: 0.62 },
];

const system: ArchView = {
  id: "system",
  title: "System",
  lede: "Click a component for what it does, its port, the trust boundary it enforces, and the code. Runtime manager and harness open into component views.",
  vb: [1160, 790],
  frames: [
    { label: "Control plane", box: { x: 20, y: 110, w: 570, h: 150 }, kind: "cp" },
    { label: "Data stores", box: { x: 955, y: 128, w: 200, h: 278 }, kind: "stores", layer: "store" },
    { label: "Data plane · your VPC", box: { x: 20, y: 296, w: 900, h: 480 }, kind: "dp" },
    { label: "microVM (Firecracker)", box: { x: 290, y: 596, w: 560, h: 128 }, kind: "wall" },
  ],
  nodes: systemNodes,
  edges: systemEdges,
};

// ---------------------------------------------------------------------------
// Runtime-manager component view
// ---------------------------------------------------------------------------

const managerNodes: ArchNode[] = [
  {
    id: "m-callers", title: "gRPC callers", sub: "scheduler · engine · CP", tone: "plain", external: true,
    box: { x: 20, y: 90, w: 170, h: 60 },
    lang: "Go", role: "Callers of RuntimeManager: the scheduler (Spawn/Stop/Snapshot), the workflow engine (ExecTool) and the control plane (Exec, ExecTool for the file API).",
    boundary: "Must present x-lantern-service-token.", invariants: [],
    src: [M(`${RS}/internal/dialer/manager.go`, 128), M(`${WE}/internal/engine/step_executor.go`, 417)],
  },
  {
    id: "m-authz", title: "Authz interceptor", sub: "authz.rs", tone: "host",
    box: { x: 230, y: 90, w: 190, h: 60 }, gate: "token, no VM certs",
    lang: "Rust", role: "Per-call authorization for RuntimeManager (ADR 0025). The TLS handshake alone cannot tell a guest from the scheduler, because every per-VM cert is signed by the trusted CA.",
    boundary: "A peer presenting OU=lantern-vm is refused outright; everyone else needs the service token (constant-time compare).",
    invariants: ["Token unset: prod refuses to start, dev warns and allows."],
    src: [M(`${RM}/authz.rs`, 1), M(`${RM}/authz.rs`, 7)],
  },
  {
    id: "m-svc", title: "RuntimeManager service", sub: "Spawn · Stop · Exec · ExecTool", tone: "host",
    box: { x: 450, y: 90, w: 220, h: 60 },
    lang: "Rust (tonic)", ports: ":50054",
    role: "Spawn (fresh or restore_snapshot_id), Stop, Logs, Exec (bidi stream), ExecTool, Stats, Snapshot.",
    boundary: "ExecTool resolves the VM by vm_id or run_id; a tenant mismatch returns NOT_FOUND.",
    invariants: ["Tool output buffered in manager memory is capped at 1 MiB; tool timeout defaults to 30 s, capped at 900 s."],
    src: [M(`${PROTO}/runtime.proto`, 379), M(`${RM}/service.rs`, 1306), M(`${RM}/service.rs`, 1752), M(`${RM}/service.rs`, 971)],
  },
  {
    id: "m-hsvc", title: "RuntimeHarness service", sub: "Heartbeat · VendSecret · Report", tone: "host",
    box: { x: 720, y: 90, w: 220, h: 60 }, gate: "per-VM mTLS",
    lang: "Rust (tonic)",
    role: "What guests call: a 5 s heartbeat stream (also how the manager learns the guest's dial-back address), secret vending, and the report stream.",
    boundary: "Methods bind the cert CN/SAN to the request's vm_id per message, pinned to this incarnation's cert.",
    invariants: ["VendSecret only resolves URIs declared in the VM's own spawn record."],
    src: [M(`${PROTO}/runtime.proto`, 507), M(`${RM}/service.rs`, 2168), M(`${RM}/service.rs`, 2314), M(`${RM}/handle_registry.rs`, 20)],
  },
  {
    id: "m-registry", title: "Handle registry", sub: "handle_registry.rs", tone: "plain",
    box: { x: 450, y: 210, w: 220, h: 60 },
    lang: "Rust", role: "Every live sandbox on the node: tenant, backend, declared secrets, the incarnation's cert pin and exec token.",
    boundary: "The source of truth for VM ownership checks.", invariants: [],
    src: [M(`${RM}/handle_registry.rs`, 9), M(`${RM}/handle_registry.rs`, 40)],
  },
  {
    id: "m-backends", title: "Isolation backends", sub: "5 RuntimeBackend impls", tone: "host",
    box: { x: 230, y: 330, w: 190, h: 60 },
    lang: "Rust", role: "One RuntimeBackend trait (schedule, cancel, snapshot, restore, exec) with Firecracker, Kata, Kubernetes, Wasmtime and Docker implementations.",
    boundary: "Fail-closed: an isolation class the backend cannot satisfy is refused, never downgraded.",
    invariants: ["Only Firecracker VMs run the in-guest tool registry; ExecTool on other backends returns TOOL_STATUS_UNAVAILABLE."],
    src: [M(`${RM}/backend.rs`, 70), M(`${RM}/backends/firecracker.rs`, 1), M(`${RM}/backends/kata.rs`, 1), M(`${RM}/backends/wasm.rs`, 1), M(`${RM}/service.rs`, 1800)],
    docs: { href: "/runtime/isolation", label: "Isolation" },
  },
  {
    id: "m-pool", title: "Warm pool", sub: "pool.rs", tone: "plain",
    box: { x: 230, y: 210, w: 190, h: 60 },
    lang: "Rust", role: "Pre-booted handles keyed by (isolation class, bundle digest, tenant), published to the scheduler for warm-start scoring.",
    boundary: "The tenant is part of the key: a warm handle booted with one tenant's env and cert is never handed to another.",
    invariants: [], src: [M(`${RM}/pool.rs`, 28)],
  },
  {
    id: "m-snap", title: "Snapshot store", sub: "local + optional S3", tone: "plain",
    box: { x: 450, y: 330, w: 220, h: 60 },
    lang: "Rust", role: "vmstate + mem files under SNAPSHOT_DIR, mirrored to S3 when configured. The mem file is made read-only so forks can hard-link it.",
    boundary: "S3 upload failures are warn-logged, never fatal; the local copy is authoritative.",
    invariants: ["Forks share mem pages through the host page cache (MAP_PRIVATE copy-on-write) until a guest writes."],
    src: [M(`${RM}/snapshot_store.rs`, 1), M(`${RM}/backends/firecracker.rs`, 2230)],
    docs: { href: "/runtime/sandbox-lifecycle", label: "Sandbox lifecycle" },
  },
  {
    id: "m-reaper", title: "Reaper", sub: "reaper.rs", tone: "plain",
    box: { x: 230, y: 450, w: 190, h: 60 },
    lang: "Rust", role: "Polls backend liveness and deregisters workloads that exited on their own, so finished VMs stop counting against quota.",
    boundary: "Only reaps on an affirmative \"not running\"; an error keeps the handle.", invariants: [],
    src: [M(`${RM}/reaper.rs`, 1)],
  },
  {
    id: "m-nodehb", title: "Scheduler heartbeat", sub: "every 30 s", tone: "plain",
    box: { x: 450, y: 450, w: 220, h: 60 },
    lang: "Rust", role: "Posts node capacity and warm-pool inventory to the scheduler's REST gateway (:8085) every 30 s.",
    boundary: "", invariants: [],
    src: [M(`${RM}/scheduler_heartbeat.rs`, 1), M(`${RM}/scheduler_heartbeat.rs`, 20)],
  },
  {
    id: "m-secrets", title: "Secret resolver", sub: "relay or env", tone: "plain",
    box: { x: 720, y: 330, w: 170, h: 60 },
    lang: "Rust", role: "Resolves lantern.secret/… URIs at request time through the control-plane relay (POST /v1/runtime/secrets/resolve), or env in dev.",
    boundary: "The relay authenticates with X-Lantern-Runtime-Token; the control plane fails closed without it.",
    invariants: ["Secrets never appear in logs, traces or run state."],
    src: [M(`${RM}/secret_resolver.rs`, 1), M(`${CP}/cmd/server/main.go`, 809)],
    docs: { href: "/runtime/identity", label: "Identity & secrets" },
  },
  {
    id: "m-report", title: "Report forwarder", sub: "report_forwarder.rs", tone: "plain",
    box: { x: 720, y: 210, w: 170, h: 60 },
    lang: "Rust", role: "Forwards each harness report (logs, OTLP traces, metrics, audit events) to POST /v1/runtime/report.",
    boundary: "A forward failure never crashes the workload; failed audit forwards are logged at ERROR.",
    invariants: [], src: [M(`${RM}/report_forwarder.rs`, 1)],
  },
  {
    id: "m-broker", title: "Egress broker", sub: "opt-in · broker mode", tone: "host", layer: "broker",
    box: { x: 720, y: 450, w: 170, h: 60 }, gate: "allowlist",
    lang: "Rust", role: "Per-VM listener on the Firecracker vsock UDS for guest port 3128: allowlist, upstream dial from the host, credential injection.",
    boundary: "At most 128 concurrent connections per VM; 10 s limits on head read, TLS, DNS and connect; 300 s idle close.",
    invariants: ["LANTERN_EGRESS_MODE=broker, Firecracker only. Production refuses broker mode without the relay resolver."],
    src: [B(`${RM}/egress_broker.rs`, 44), B(`${RM}/egress_broker.rs`, 65), B(`${RM}/egress_broker.rs`, 1204)],
    docs: { href: "/runtime/egress", label: "Egress" },
  },
  {
    id: "m-guest", title: "Harness (guest)", sub: "inside each microVM", tone: "guest", external: true,
    box: { x: 980, y: 90, w: 160, h: 60 },
    lang: "Rust", role: "The in-VM side. Open the harness component view for its parts.",
    boundary: "", invariants: [], src: [M(`${HN}/main.rs`, 1)], zoom: "harness",
  },
  {
    id: "m-cp", title: "Control plane", sub: "report · secrets relay", tone: "plain", external: true,
    box: { x: 980, y: 270, w: 160, h: 60 },
    lang: "Go", role: "Receives reports and resolves secret refs for the tenant that owns the VM.",
    boundary: "", invariants: [], src: [M(`${CP}/cmd/server/main.go`, 821)],
  },
  {
    id: "m-up", title: "Upstream", sub: "allowlisted hosts", tone: "plain", external: true, layer: "broker",
    box: { x: 980, y: 450, w: 160, h: 60 },
    lang: "External", role: "Reached from the host in broker mode.", boundary: "", invariants: [], src: [B(`${RM}/egress_broker.rs`, 1025)],
  },
  {
    id: "m-s3", title: "S3 / MinIO", sub: "snapshot tier 2", tone: "store", external: true,
    box: { x: 20, y: 330, w: 170, h: 60 },
    lang: "S3 API", role: "Optional second snapshot tier.", boundary: "", invariants: [], src: [M(`${RM}/snapshot_store.rs`, 11)],
  },
];

const managerEdges: ArchEdge[] = [
  { from: "m-callers", to: "m-authz", label: "token" },
  { from: "m-authz", to: "m-svc", label: "admit" },
  { from: "m-guest", to: "m-hsvc", label: "mTLS" },
  { from: "m-svc", to: "m-guest", label: "Exec :50056 dial-back", via: [[560, 64], [1060, 64]], at: 0.62 },
  { from: "m-svc", to: "m-registry", label: "" },
  { from: "m-svc", to: "m-backends", label: "schedule · restore · cancel", via: [[500, 180], [435, 180], [435, 360]], at: 0.12 },
  { from: "m-svc", to: "m-snap", label: "", via: [[695, 120], [695, 360]] },
  { from: "m-backends", to: "m-pool", label: "warm" },
  { from: "m-snap", to: "m-s3", label: "tier 2", via: [[560, 418], [105, 418]], at: 0.75 },
  { from: "m-hsvc", to: "m-report", label: "Report" },
  { from: "m-hsvc", to: "m-secrets", label: "VendSecret", via: [[920, 120], [920, 360]], at: 0.5 },
  { from: "m-report", to: "m-cp", label: "report" },
  { from: "m-secrets", to: "m-cp", label: "resolve" },
  { from: "m-nodehb", to: "m-callers", label: "node heartbeat :8085", via: [[440, 480], [440, 540], [210, 540], [210, 180], [105, 180]], at: 0.33 },
  { from: "m-guest", to: "m-broker", label: "vsock 3128", layer: "broker", via: [[1160, 120], [1160, 535], [805, 535]], at: 0.8 },
  { from: "m-broker", to: "m-secrets", label: "resolve_scoped", layer: "broker" },
  { from: "m-broker", to: "m-up", label: "dial", layer: "broker" },
];

const manager: ArchView = {
  id: "manager",
  title: "Runtime manager",
  lede: "One per node, the only process that touches microVMs. Callers cross the authz interceptor; guests reach only RuntimeHarness.",
  vb: [1180, 560],
  frames: [{ label: "runtime-manager · :50054 · trusted host", box: { x: 215, y: 40, w: 745, h: 486 }, kind: "host" }],
  nodes: managerNodes,
  edges: managerEdges,
};

// ---------------------------------------------------------------------------
// Harness component view
// ---------------------------------------------------------------------------

const harnessNodes: ArchNode[] = [
  {
    id: "h-manager", title: "Runtime manager", sub: "host side", tone: "host", external: true, zoom: "manager",
    box: { x: 20, y: 200, w: 160, h: 60 },
    lang: "Rust", role: "The host side of every channel below. Open its component view.", boundary: "", invariants: [], src: [M(`${RM}/service.rs`, 1752)],
  },
  {
    id: "h-boot", title: "Init + boot env", sub: "spawn.json", tone: "host",
    box: { x: 240, y: 90, w: 200, h: 60 },
    lang: "Rust", role: "Mounts /run/lantern, sets rlimits, reads spawn.json (workload command, env, egress rules, workload uid/gid) from the read-only cert drive.",
    boundary: "Unknown spawn.json versions are rejected; in prod the harness refuses to start without a workload uid.",
    invariants: [], src: [M(`${HN}/bootenv.rs`, 42), M(`${HN}/init.rs`), M(`${RM}/backends/firecracker.rs`, 65)],
  },
  {
    id: "h-sup", title: "Supervisor", sub: "workload child", tone: "host",
    box: { x: 480, y: 90, w: 200, h: 60 },
    lang: "Rust", role: "Spawns the workload as the workload uid, tails stdio, restarts on crash up to N times, injects the proxy env.",
    boundary: "Every LANTERN_* key is withheld from the child except a short allowlist of non-secret identifiers.",
    invariants: [], src: [M(`${HN}/supervisor.rs`, 1), M(`${HN}/supervisor.rs`, 102)],
  },
  {
    id: "h-signals", title: "Signals · reaper", sub: "PID 1 duties", tone: "host",
    box: { x: 720, y: 90, w: 200, h: 60 },
    lang: "Rust", role: "Reaps orphaned zombies (PID 1's job), drains on SIGTERM, prepares for snapshots on SIGUSR1.",
    boundary: "", invariants: [], src: [M(`${HN}/signals.rs`, 1)],
  },
  {
    id: "h-hb", title: "Heartbeat", sub: "every 5 s", tone: "host",
    box: { x: 240, y: 200, w: 200, h: 60 },
    lang: "Rust", role: "Bidi stream to the manager with resource usage, has_active_exec and last_activity_unix_ms; the scheduler's idle sweeper reads the last two.",
    boundary: "mTLS with this incarnation's per-VM cert.", invariants: [],
    src: [M(`${HN}/heartbeat.rs`, 29), M(`${HN}/heartbeat.rs`, 105)],
  },
  {
    id: "h-activity", title: "Activity tracker", sub: "activity.rs", tone: "plain",
    box: { x: 480, y: 200, w: 200, h: 60 },
    lang: "Rust", role: "Atomic count of running workload and exec children, plus the time the last one exited.",
    boundary: "", invariants: ["Idle means no child alive: the basis for idle-suspend."],
    src: [M(`${HN}/activity.rs`, 1)],
    docs: { href: "/runtime/sandbox-lifecycle", label: "Sandbox lifecycle" },
  },
  {
    id: "h-report", title: "Report stream", sub: "logs · traces · audit", tone: "host",
    box: { x: 720, y: 200, w: 200, h: 60 },
    lang: "Rust", role: "Client-streaming RuntimeHarness.Report to the manager, with reconnect.",
    boundary: "Security audits (secret_vend, egress deny, secret_access_denied, egress_preflight) are logged locally first and never dropped on a full buffer.",
    invariants: [], src: [M(`${HN}/report.rs`, 1)],
  },
  {
    id: "h-exec", title: "Exec server", sub: ":50056 · Bearer token", tone: "host",
    box: { x: 240, y: 310, w: 200, h: 60 }, gate: "exec token",
    lang: "Rust (tonic)", ports: ":50056 (guest)",
    role: "Serves RuntimeHarness.Exec: one-shot or TTY commands, and the __lantern_tool_call__ envelope for tool calls.",
    boundary: "Rejects calls without this incarnation's bearer token, so a token frozen into a snapshot is refused after restore.",
    invariants: [], src: [M(`${HN}/exec.rs`, 1), M(`${HN}/exec.rs`, 455)],
  },
  {
    id: "h-tools", title: "Tool runner", sub: "5 built-in tools", tone: "host",
    box: { x: 480, y: 310, w: 200, h: 60 },
    lang: "Rust", role: "shell_exec, http_fetch (through the egress proxy), read_file, write_file, list_dir.",
    boundary: "File tools are confined to the fixed /workspace root via openat2 RESOLVE_BENEATH, running under the workload's fsuid.",
    invariants: ["Every captured output is capped at 1 MiB and marked truncated."],
    src: [M(`${HN}/tool_runner.rs`, 1), M(`${HN}/tool_runner.rs`, 216), M(`${HN}/tool_runner.rs`, 252), M(`${HN}/tool_runner.rs`, 657)],
  },
  {
    id: "h-secrets", title: "Secrets socket", sub: "/run/lantern/secrets.sock", tone: "host",
    box: { x: 720, y: 420, w: 200, h: 60 }, gate: "SO_PEERCRED",
    lang: "Rust", role: "Vends short-TTL secret values to the workload over a Unix socket, fetched from the manager's VendSecret.",
    boundary: "Peer uid comes from the kernel (SO_PEERCRED) and must be the workload uid; denials emit secret_access_denied.",
    invariants: [], src: [M(`${HN}/secrets.rs`, 55), M(`${HN}/secrets.rs`, 89)],
    docs: { href: "/runtime/identity", label: "Identity & secrets" },
  },
  {
    id: "h-egress", title: "Egress proxy", sub: "127.0.0.1:3128 · guest mode", tone: "host", layer: "guest", gate: "allowlist",
    box: { x: 240, y: 420, w: 200, h: 60 },
    lang: "Rust", role: "In-guest CONNECT allowlist proxy. Enforcing only with the image's iptables REDIRECT rule, which the harness checks at boot.",
    boundary: "Prod is always fail-closed when rules are declared and REDIRECT is missing; the workload is not started.",
    invariants: [], src: [M(`${HN}/egress.rs`, 1), M(`${HN}/egress.rs`, 442)],
    docs: { href: "/runtime/egress", label: "Egress" },
  },
  {
    id: "h-fwd", title: "Egress forwarder", sub: "127.0.0.1:3128 · broker mode", tone: "host", layer: "broker",
    box: { x: 480, y: 420, w: 200, h: 60 },
    lang: "Rust", role: "Bridges each proxy connection byte for byte to vsock CID 2 port 3128. Nothing in the guest enforces or terminates anything.",
    boundary: "The VM has no NIC; the broker on the host is the enforcement point.",
    invariants: [], src: [B(`${HN}/egress_forwarder.rs`, 1), B(`${HN}/vsock.rs`, 10)],
    docs: { href: "/runtime/egress", label: "Egress" },
  },
  {
    id: "h-reid", title: "Re-identify", sub: "after restore / fork", tone: "host",
    box: { x: 720, y: 310, w: 200, h: 60 },
    lang: "Rust", role: "A restored guest wakes up believing it is the source VM. This mints the new incarnation's vm_id, cert and agent identity before anything else runs.",
    boundary: "", invariants: [], src: [M(`${HN}/reidentify.rs`, 1)],
  },
  {
    id: "h-workload", title: "Untrusted code", sub: "workload uid", tone: "guest",
    box: { x: 480, y: 540, w: 200, h: 56 },
    lang: "Any", role: "The agent's code. Talks to the harness only through the proxy port, the secrets socket, and its own stdio.",
    boundary: "Untrusted.", invariants: [], src: [M(`${HN}/supervisor.rs`, 1)],
  },
  {
    id: "h-out", title: "Network", sub: "TAP or vsock", tone: "plain", external: true,
    box: { x: 990, y: 420, w: 150, h: 60 },
    lang: "", role: "Guest mode: the TAP device, filtered in-guest. Broker mode: vsock to the host broker, no NIC.", boundary: "", invariants: [], src: [B("docs/adr/0026-host-egress-broker.md", 28)],
  },
];

const harnessEdges: ArchEdge[] = [
  { from: "h-boot", to: "h-sup", label: "start" },
  { from: "h-sup", to: "h-activity", label: "" },
  { from: "h-exec", to: "h-activity", label: "" },
  { from: "h-activity", to: "h-hb", label: "idle" },
  { from: "h-hb", to: "h-manager", label: "Heartbeat" },
  { from: "h-manager", to: "h-exec", label: "Exec + token", via: [[100, 340]], at: 0.7 },
  { from: "h-report", to: "h-manager", label: "Report", via: [[820, 178], [140, 178]], at: 0.12 },
  { from: "h-exec", to: "h-tools", label: "" },
  { from: "h-tools", to: "h-workload", label: "/workspace", via: [[700, 340], [700, 580]], at: 0.88 },
  { from: "h-sup", to: "h-workload", label: "spawn as uid", via: [[950, 120], [950, 556]], at: 0.55 },
  { from: "h-workload", to: "h-secrets", label: "socket" },
  { from: "h-secrets", to: "h-manager", label: "VendSecret", via: [[820, 395], [210, 395], [210, 250]], at: 0.14 },
  { from: "h-workload", to: "h-egress", label: "HTTPS_PROXY", layer: "guest" },
  { from: "h-egress", to: "h-out", label: "TAP", layer: "guest", via: [[340, 515], [1065, 515]], at: 0.8 },
  { from: "h-workload", to: "h-fwd", label: "HTTPS_PROXY", layer: "broker" },
  { from: "h-fwd", to: "h-out", label: "vsock 3128", layer: "broker", via: [[640, 515], [1065, 515]], at: 0.75 },
];

const harness: ArchView = {
  id: "harness",
  title: "Harness",
  lede: "PID 1 inside every microVM. Everything inside the glass is reachable by untrusted code; the harness is what stands between it and secrets, the network and the manager.",
  vb: [1150, 630],
  frames: [
    { label: "microVM wall", box: { x: 222, y: 40, w: 744, h: 576 }, kind: "wall" },
    { label: "harness · PID 1", box: { x: 230, y: 58, w: 704, h: 436 }, kind: "host" },
  ],
  nodes: harnessNodes,
  edges: harnessEdges,
};

export const VIEWS: Record<ArchView["id"], ArchView> = { system, manager, harness };
