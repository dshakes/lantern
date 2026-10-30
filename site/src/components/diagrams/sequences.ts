import type { Src, Tone } from "./types";

// Steppable sequence diagrams. Each step is one message (or a self-step) with a
// one-line explanation and the code that does it.

export type Lifeline = { id: string; label: string; sub?: string; tone: Tone };
export type StepKind = "call" | "return" | "deny" | "inject";
export type Step = { from: string; to: string; label: string; note: string; kind?: StepKind; src?: Src[] };
export type Scenario = { id: string; label: string; steps: Step[] };
export type SequenceDef = {
  id: string;
  title: string;
  caption: string;
  /** Shown above the diagram, e.g. for opt-in modes. */
  badge?: string;
  lifelines: Lifeline[];
  scenarios: Scenario[];
};

const M = (p: string, l?: number): Src => ({ p, l });
const B = (p: string, l?: number): Src => ({ p, l, ref: "broker" });

const H = "services/control-plane/internal/handlers";
const MAIN = "services/control-plane/cmd/server/main.go";
const STEP = "services/workflow-engine/internal/engine/step_executor.go";
const SVC = "services/runtime-manager/src/service.rs";
const TR = "services/harness/src/tool_runner.rs";
const EB = "services/runtime-manager/src/egress_broker.rs";
const LC = "services/runtime-scheduler/internal/handlers/lifecycle.go";
const IS = "services/runtime-scheduler/internal/handlers/idle_sweeper.go";
const RL = `${H}/runtime_lifecycle.go`;
const PROTO = "packages/proto/pal/v1/runtime.proto";
const DLP = "docs/adr/0030-egress-dlp.md";
const RT = `${H}/runtime.go`;

// ---------------------------------------------------------------------------
// (a) A run
// ---------------------------------------------------------------------------

const post: Step = {
  from: "sdk", to: "cp", label: "POST /v1/runs", note: "The SDK sends { agentName, input }. The route requires the runs:execute scope.",
  src: [M(MAIN, 430), M(`${H}/rest.go`, 579)],
};
const budget: Step = {
  from: "cp", to: "pg", label: "CheckBudget(tenant, agent, 0)",
  note: "Before anything is created: daily cost, run-count and token limits from prior runs, read from the usage rollup.",
  src: [M(`${H}/rest.go`, 618), M(`${H}/budgets.go`, 338)],
};

export const RUN_SEQUENCE: SequenceDef = {
  id: "run",
  title: "A run, end to end",
  caption: "From POST /v1/runs to a journaled result, including the budget gate, the optional model router, and what happens when the process dies mid-step.",
  lifelines: [
    { id: "sdk", label: "SDK", tone: "client" },
    { id: "cp", label: "Control plane", sub: ":8080", tone: "plain" },
    { id: "pg", label: "Postgres", sub: "runs · journal", tone: "store" },
    { id: "dp", label: "Data-plane agent", sub: "your VPC", tone: "plain" },
    { id: "we", label: "Workflow engine", sub: ":50052", tone: "plain" },
    { id: "mr", label: "Model router", sub: ":50053", tone: "plain" },
    { id: "llm", label: "LLM provider", tone: "plain" },
  ],
  scenarios: [
    {
      id: "inline",
      label: "Managed (inline)",
      steps: [
        post,
        budget,
        { from: "cp", to: "pg", label: "CreateRun → runs row", note: "The run is created queued. No data plane is connected for this tenant, so it will execute inline.", src: [M(`${H}/rest.go`, 649), M(`${H}/rest.go`, 741)] },
        { from: "cp", to: "sdk", label: "201 Created { run }", kind: "return", note: "The caller gets the run id immediately; execution continues on a background goroutine.", src: [M(`${H}/rest.go`, 749)] },
        { from: "cp", to: "pg", label: "status = running", note: "executeRunInline marks the run running.", src: [M(`${H}/rest.go`, 1066), M(`${H}/rest.go`, 1296)] },
        { from: "cp", to: "pg", label: "checkCachedLLMStep → miss", note: "Is there already a step_completed for this LLM step? On a first attempt, no.", src: [M(`${H}/rest.go`, 1499), M(`${H}/durable_replay.go`, 181)] },
        { from: "cp", to: "pg", label: "journal step_started", note: "Written before the call so the waterfall shows the step in flight and recovery knows it began.", src: [M(`${H}/rest.go`, 1517)] },
        { from: "cp", to: "mr", label: "ModelService.Complete", note: "Only when PAL_USE_MODEL_ROUTER is on (default off). Otherwise the control plane calls the provider directly, and any router error falls through to that direct chain.", src: [M(`${H}/llm_proxy_router.go`, 178), M(`${H}/llm_proxy.go`, 3628)] },
        { from: "mr", to: "llm", label: "provider request", note: "The request carries an Idempotency-Key derived from the run, so a retry or crash-replay is deduplicated by the provider.", src: [M(`${H}/llm_idempotency.go`, 40)] },
        { from: "llm", to: "cp", label: "completion + usage", kind: "return", note: "Text, model used, tokens in and out.", src: [M(`${H}/rest.go`, 1698)] },
        { from: "cp", to: "pg", label: "journal step_completed", note: "The full output payload is persisted: this row is what makes replay skip the call next time.", src: [M(`${H}/rest.go`, 1728)] },
        { from: "cp", to: "pg", label: "status = succeeded, cost", note: "Output, tokens and cost_usd on the run row.", src: [M(`${H}/rest.go`, 1750)] },
        { from: "cp", to: "pg", label: "RecordUsage", note: "Daily rollup for the budget gate, recorded exactly once per run.", src: [M(`${H}/rest.go`, 1767), M(`${H}/budgets.go`, 489)] },
        { from: "sdk", to: "cp", label: "GET /v1/runs/{id}/events", note: "SSE: replays journal_events in seq order, then tails until the run is terminal.", src: [M(`${H}/run_events.go`, 56), M(`${H}/run_events.go`, 258)] },
      ],
    },
    {
      id: "budget",
      label: "Budget exhausted",
      steps: [
        post,
        { ...budget, label: "CheckBudget → hard-fail", kind: "deny", note: "A hard-fail limit for this agent is already exceeded." },
        { from: "cp", to: "sdk", label: "402 Payment Required", kind: "deny", note: "{ error: \"agent budget limit reached — …\", reason }. No run row, no compute, no tokens.", src: [M(`${H}/rest.go`, 624)] },
      ],
    },
    {
      id: "crash",
      label: "Crash and re-drive",
      steps: [
        { from: "cp", to: "pg", label: "journal step_started", note: "A run is mid-step: the LLM step has started.", src: [M(`${H}/rest.go`, 1517)] },
        { from: "cp", to: "cp", label: "process dies", kind: "deny", note: "Restart, deploy or crash before step_completed is written. The run row still says running.", src: [] },
        { from: "cp", to: "pg", label: "find orphaned runs", note: "Every PAL_RECOVERY_INTERVAL (default 30 s): runs in running/queued whose run_locks row is absent or expired.", src: [M(`${H}/recovery.go`, 476), M(`${H}/recovery.go`, 292), M(`${H}/recovery.go`, 163)] },
        { from: "cp", to: "pg", label: "acquireRecoveryLock", note: "An UPSERT on run_locks that only steals an expired lock, so two replicas never re-drive the same run.", src: [M(`${H}/recovery.go`, 188)] },
        { from: "cp", to: "cp", label: "redriveRun", note: "Re-enters the executor (or the workflow interpreter) for that run.", src: [M(`${H}/recovery.go`, 228)] },
        { from: "cp", to: "pg", label: "checkCachedLLMStep", note: "A step_completed row means reuse the stored output with no LLM call. Workflow nodes do the same via journalCompletedStep.", src: [M(`${H}/durable_replay.go`, 181), M(`${H}/rest.go`, 2264)] },
        { from: "cp", to: "llm", label: "call only if not cached", note: "If the crash came before step_completed, the call is made again under the same idempotency key derivation, so the provider can dedup it.", src: [M(`${H}/durable_replay.go`, 249), M(`${H}/llm_idempotency.go`, 40)] },
        { from: "cp", to: "pg", label: "journal step_completed", note: "The run resumes from the first incomplete step; it does not restart.", src: [M(`${H}/rest.go`, 1728)] },
      ],
    },
    {
      id: "engine",
      label: "Data plane (engine)",
      steps: [
        post,
        { from: "cp", to: "dp", label: "RouteRun → assignment", note: "A data plane is connected for this tenant: the assignment goes down the RunStream that the agent opened outbound.", src: [M(`${H}/rest.go`, 728), M(`${H}/dataplane.go`, 697)] },
        { from: "dp", to: "we", label: "ExecuteRun", note: "The agent drives the run on the local workflow engine and streams its events back.", src: [M("services/data-plane-agent/internal/dispatcher/dispatcher.go", 153)] },
        { from: "we", to: "we", label: "replay check", note: "executeAttempt first looks for a cached result keyed stepID:attempt; a completed step is never re-dispatched.", src: [M(STEP, 135)] },
        { from: "we", to: "mr", label: "Complete { idempotency_key }", note: "llm_call always goes through the model router, capability-addressed, keyed run_id:step_id:attempt.", src: [M(STEP, 241), M(STEP, 323)] },
        { from: "mr", to: "llm", label: "provider request", note: "The router maps the capability to a concrete vendor model." },
        { from: "llm", to: "we", label: "completion", kind: "return", note: "model_used, tokens and cost map into the step result.", src: [M(STEP, 323)] },
        { from: "we", to: "pg", label: "journal.Append", note: "The engine is the only thing that mutates run state; the journal write and status update share a transaction.", src: [M("services/workflow-engine/internal/journal/journal.go", 28)] },
        { from: "we", to: "dp", label: "StreamEvent …", kind: "return", note: "Events stream back to the agent, which reports status to the control plane.", src: [M("services/data-plane-agent/internal/dispatcher/dispatcher.go", 131)] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// (b) A tool call into a microVM
// ---------------------------------------------------------------------------

const execTool: Step = {
  from: "we", to: "rm", label: "ExecTool", note: "tool_name, args (Struct), run_id, step_id, vm_id, timeout, idempotency_key run_id:step_id:attempt, tenant_id.",
  src: [M(STEP, 405), M(STEP, 417), M(PROTO, 469)],
};
const authz: Step = {
  from: "rm", to: "rm", label: "authz interceptor", note: "Service token required; any peer presenting a per-VM cert (OU=pal-vm) is refused.",
  src: [M("services/runtime-manager/src/authz.rs", 1)],
};

export const TOOL_SEQUENCE: SequenceDef = {
  id: "tool",
  title: "A tool call into a microVM",
  caption: "The workflow engine never runs tools itself: it asks the runtime-manager, which hands a JSON envelope to the harness inside the guest.",
  lifelines: [
    { id: "we", label: "Workflow engine", sub: "tool_call step", tone: "plain" },
    { id: "rm", label: "Runtime manager", sub: ":50054", tone: "host" },
    { id: "h", label: "Harness exec", sub: ":50056 in guest", tone: "host" },
    { id: "tr", label: "Tool runner", sub: "in harness", tone: "host" },
    { id: "ws", label: "Workload space", sub: "/workspace, uid", tone: "guest" },
  ],
  scenarios: [
    {
      id: "ok",
      label: "Succeeds",
      steps: [
        execTool,
        authz,
        { from: "rm", to: "rm", label: "resolve VM + tenant", note: "By vm_id, or by scanning for run_id. The owning tenant must match.", src: [M(SVC, 1767)] },
        { from: "rm", to: "h", label: "Exec __pal_tool_call__", note: "Envelope { tool, args, idempotency_key, timeout_sec } in argv[0], with this incarnation's Bearer exec token. On broker VMs the same gRPC rides host-initiated vsock.", src: [M(SVC, 953), M(SVC, 978), B("docs/adr/0026-host-egress-broker.md", 90)] },
        { from: "h", to: "tr", label: "run_tool_call", note: "The exec server intercepts the sentinel before its generic exec audit (args are never logged).", src: [M("services/harness/src/exec.rs", 455), M(TR, 112)] },
        { from: "tr", to: "ws", label: "read_file under /workspace", note: "openat2 with RESOLVE_BENEATH as the workload's fsuid: no .. or symlink escape. shell_exec runs /bin/sh -c as the workload uid.", src: [M(TR, 657), M(TR, 22)] },
        { from: "ws", to: "tr", label: "bytes (≤ 1 MiB)", kind: "return", note: "Every captured output is capped and flagged truncated.", src: [M(TR, 252)] },
        { from: "tr", to: "rm", label: "{ ok: true, result }", kind: "return", note: "Written to stdout before the done frame.", src: [M(TR, 1)] },
        { from: "rm", to: "we", label: "TOOL_STATUS_OK + result", kind: "return", note: "Typed status, no string matching. The manager audits tool name, duration and status, never args.", src: [M(PROTO, 464), M(SVC, 1752)] },
      ],
    },
    {
      id: "err",
      label: "Tool fails",
      steps: [
        execTool,
        { from: "rm", to: "h", label: "Exec __pal_tool_call__", note: "Dispatched as above.", src: [M(SVC, 953)] },
        { from: "h", to: "tr", label: "run_tool_call", note: "E.g. read_file on a path outside /workspace.", src: [M(TR, 112)] },
        { from: "tr", to: "rm", label: "{ ok: false, error }", kind: "deny", note: "The tool ran and failed, or the name is unknown.", src: [M(TR, 1)] },
        { from: "rm", to: "we", label: "TOOL_STATUS_ERROR", kind: "deny", note: "The step fails with the manager's detail.", src: [M(PROTO, 465)] },
      ],
    },
    {
      id: "unavail",
      label: "No harness",
      steps: [
        execTool,
        { from: "rm", to: "rm", label: "not Firecracker, or no heartbeat yet", kind: "deny", note: "Only Firecracker guests run the tool registry, and the guest address comes from its heartbeat.", src: [M(SVC, 1800), M(SVC, 1820)] },
        { from: "rm", to: "we", label: "TOOL_STATUS_UNAVAILABLE", kind: "deny", note: "Never a fabricated success. The engine fails the step wrapping ErrRuntimeManagerUnavailable.", src: [M(PROTO, 466)] },
      ],
    },
    {
      id: "tenant",
      label: "Wrong tenant",
      steps: [
        { ...execTool, note: "A caller asks for a VM that belongs to another tenant." },
        { from: "rm", to: "rm", label: "tenant mismatch", kind: "deny", note: "Audited under pal_audit as exec_tool DENIED.", src: [M(SVC, 1767)] },
        { from: "rm", to: "we", label: "NOT_FOUND", kind: "deny", note: "Indistinguishable from a VM that does not exist: no existence leak (ADR 0025).", src: [M(SVC, 1792)] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// (c) Egress in broker mode
// ---------------------------------------------------------------------------

const connect = (host: string): Step => ({
  from: "wl", to: "fw", label: `CONNECT ${host}:443`, note: "The workload uses HTTPS_PROXY=http://127.0.0.1:3128 as usual.", src: [B("services/harness/src/egress_forwarder.rs", 3)],
});
const vsock: Step = {
  from: "fw", to: "br", label: "bytes over vsock :3128", note: "The VM has no network device. The forwarder splices each connection to vsock CID 2 (the host), port 3128.",
  src: [B("services/harness/src/vsock.rs", 10), B(EB, 44), B("docs/adr/0026-host-egress-broker.md", 54)],
};
const head: Step = {
  from: "br", to: "br", label: "read head (≤ 64 KiB, 10 s)", note: "A slow or silent guest is dropped; CONNECT goes to handle_connect, anything else to handle_plain.",
  src: [B(EB, 54), B(EB, 713)],
};

export const EGRESS_SEQUENCE: SequenceDef = {
  id: "egress",
  title: "Egress in broker mode",
  badge: "Opt-in: PAL_EGRESS_MODE=broker · Firecracker only · ADR 0026",
  caption: "The workload's request leaves the VM over vsock; the host broker decides, dials, and adds the credential. The VM never holds it.",
  lifelines: [
    { id: "wl", label: "Workload", sub: "untrusted", tone: "guest" },
    { id: "fw", label: "Forwarder", sub: "127.0.0.1:3128", tone: "host" },
    { id: "br", label: "Host broker", sub: "runtime-manager", tone: "host" },
    { id: "sr", label: "Secret relay", sub: "control plane", tone: "plain" },
    { id: "up", label: "Upstream", sub: "allowlisted host", tone: "plain" },
  ],
  scenarios: [
    {
      id: "inject",
      label: "Allowed, credential injected",
      steps: [
        connect("api.github.com"),
        vsock,
        head,
        { from: "br", to: "br", label: "Policy.evaluate", note: "Port in PAL_EGRESS_ALLOWED_PORTS (default 443), not a private/metadata IP literal, first matching rule.", src: [B(EB, 206), B(EB, 217)] },
        { from: "br", to: "wl", label: "200 Connection Established", kind: "return", note: "This rule injects, so the broker terminates TLS with a leaf from the per-VM ephemeral CA. Nothing is dialled yet.", src: [B(EB, 753), B(EB, 768)] },
        { from: "wl", to: "br", label: "GET /user (inside TLS)", note: "The workload's real request, with a placeholder or no Authorization header." },
        { from: "br", to: "br", label: "preflight: method + Host", note: "Not TRACE or CONNECT; the target and exactly one Host: header must name api.github.com.", src: [B(EB, 822), B(EB, 343), B(EB, 375)] },
        { from: "br", to: "sr", label: "resolve pal.secret/…", note: "Resolved on the host at request time, scoped to the VM's tenant. The ref comes from the manager's spawn record, not the guest.", src: [B(EB, 989), B("docs/adr/0026-host-egress-broker.md", 108)] },
        { from: "sr", to: "br", label: "secret value", kind: "return", note: "Held for one header write, then dropped. Never logged, traced or audited." },
        { from: "br", to: "up", label: "TLS + header injected", kind: "inject", note: "DNS checked against private ranges, upstream verified against native roots, same-named header replaced, Connection: close.", src: [B(EB, 1025), B(EB, 840), B(EB, 415)] },
        { from: "br", to: "br", label: "audit egress_inject", note: "Header names only, logged locally first, then the report path.", src: [B(EB, 854), B(EB, 1053)] },
        { from: "up", to: "wl", label: "response (spliced)", kind: "return", note: "Rate-limited by the rule's rate_bps; idle connections close after 300 s.", src: [B(EB, 855), B(EB, 62)] },
      ],
    },
    {
      id: "pass",
      label: "Allowed, no injection",
      steps: [
        connect("pypi.org"),
        vsock,
        head,
        { from: "br", to: "br", label: "Policy.evaluate → rule", note: "The rule has no inject list, so TLS is not terminated.", src: [B(EB, 217), B(EB, 253)] },
        { from: "br", to: "up", label: "dial from host", note: "Resolve once, refuse private/metadata answers, dial the checked address.", src: [B(EB, 774), B(EB, 1025)] },
        { from: "br", to: "wl", label: "200 Connection Established", kind: "return", note: "Audited as passthrough.", src: [B(EB, 782)] },
        { from: "wl", to: "up", label: "opaque TLS tunnel", note: "End-to-end TLS between the workload and the upstream; the broker only splices bytes.", src: [B(EB, 786)] },
      ],
    },
    {
      id: "deny",
      label: "Not allowlisted",
      steps: [
        connect("paste.example"),
        vsock,
        head,
        { from: "br", to: "br", label: "no matching allowlist rule", kind: "deny", note: "Policy.evaluate returns the deny reason.", src: [B(EB, 217)] },
        { from: "br", to: "br", label: "audit egress deny", kind: "deny", note: "Always logged locally. Into the shared audit channel at a burst of 20, then 5 per second per VM.", src: [B(EB, 748), B(EB, 71), B(EB, 1053)] },
        { from: "br", to: "wl", label: "403 Forbidden", kind: "deny", note: "X-Pal-Reason carries the static reason. Nothing was dialled.", src: [B(EB, 749), B(EB, 445)] },
      ],
    },
    {
      id: "plain",
      label: "Plain HTTP + credential",
      steps: [
        { from: "wl", to: "fw", label: "GET http://api.internal.example/", note: "A plain-HTTP proxy request to a host whose rule injects a credential (port 80 opened in the allowlist)." },
        vsock,
        { from: "br", to: "br", label: "handle_plain", note: "Allowed by policy, and the rule injects.", src: [B(EB, 879)] },
        { from: "br", to: "wl", label: "403 plain-HTTP injection refused", kind: "deny", note: "A credential would cross the network in cleartext. Only PAL_EGRESS_PLAIN_INJECT=1 allows it, and only to port 80.", src: [B(EB, 916), B(EB, 75)] },
      ],
    },
    {
      id: "host",
      label: "Host mismatch",
      steps: [
        connect("api.github.com"),
        vsock,
        { from: "br", to: "wl", label: "200 + TLS terminated", kind: "return", note: "As in the injection path.", src: [B(EB, 768)] },
        { from: "wl", to: "br", label: "GET / · Host: evil.example", note: "Inside an approved tunnel, the request names a different vhost." },
        { from: "br", to: "br", label: "Host not bound to approved host", kind: "deny", note: "Checked before any secret is resolved or anything dialled; audited as an egress_inject deny.", src: [B(EB, 822), B(EB, 369)] },
        { from: "br", to: "wl", label: "403 Forbidden", kind: "deny", note: "The credential never rides a request addressed elsewhere.", src: [B(EB, 823)] },
      ],
    },
    {
      id: "dlp",
      label: "DLP block",
      steps: [
        connect("api.github.com"),
        vsock,
        { from: "br", to: "wl", label: "200 + TLS terminated", kind: "return", note: "DLP inspects only paths the broker can read: TLS-terminated injecting hosts and plain HTTP. Opaque CONNECT tunnels are never inspected.", src: [M(DLP, 25)] },
        { from: "wl", to: "br", label: "POST /gists · body has a card number", note: "The workload tries to send sensitive data through an allowlisted host." },
        { from: "br", to: "br", label: "read body before dialling", note: "Up to max_inspect_bytes (64 KiB default, 1 MiB ceiling), de-chunked so chunk sizes cannot split a value. Ambiguous framing is a 400.", src: [M(DLP, 89), M(DLP, 96)] },
        { from: "br", to: "br", label: "detector card_number → block", kind: "deny", note: "Luhn and an issuer prefix. Detectors: card_number, secret_key, email, phone, custom_regex. Block beats audit.", src: [M(DLP, 65), M(DLP, 83)] },
        { from: "br", to: "wl", label: "403 · X-Pal-Reason: dlp-block", kind: "deny", note: "Audited as dlp, decision=block. Nothing was dialled and no secret was resolved. DLP is a guard rail and an audit trail; the allowlist stays the boundary.", src: [M(DLP, 87), M(DLP, 62)] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// (d) Sandbox lifecycle
// ---------------------------------------------------------------------------

export const LIFECYCLE_SEQUENCE: SequenceDef = {
  id: "lifecycle",
  title: "Sandbox lifecycle",
  caption: "Schedule, idle-suspend with transparent resume, explicit pause and resume, and copy-on-write forks.",
  lifelines: [
    { id: "c", label: "Client", sub: "SDK · CLI", tone: "client" },
    { id: "cp", label: "Control plane", sub: ":8080", tone: "plain" },
    { id: "rs", label: "Scheduler", sub: ":50055", tone: "plain" },
    { id: "rm", label: "Runtime manager", sub: ":50054", tone: "host" },
    { id: "vm", label: "microVM", sub: "harness + workload", tone: "guest" },
  ],
  scenarios: [
    {
      id: "schedule",
      label: "Schedule",
      steps: [
        { from: "c", to: "cp", label: "POST /v1/runtime/schedule", note: "AgentSpec: image, isolation, limits, egress, secrets, and optional idleTimeoutSecs.", src: [M(MAIN, 787), M(`${H}/runtime.go`, 1730), M(`${H}/runtime.go`, 754)] },
        { from: "cp", to: "rs", label: "RuntimeScheduler.Schedule", note: "Over the tenant's quota, the control plane answers HTTP 402.", src: [M("services/runtime-scheduler/internal/handlers/scheduler_grpc.go", 114), M(`${H}/runtime.go`, 1814)] },
        { from: "rs", to: "rs", label: "place → PENDING → SPAWNING", note: "Warm pool, region, fair share, cost and health pick the node.", src: [M("services/runtime-scheduler/internal/placement/placement.go", 1), M(PROTO, 42)] },
        { from: "rs", to: "rm", label: "Spawn { spec, handle }", note: "The manager writes spawn.json to the read-only cert drive and boots the VM.", src: [M("services/runtime-scheduler/internal/handlers/scheduler_grpc.go", 601), M("services/runtime-manager/src/backends/firecracker.rs", 65)] },
        { from: "vm", to: "rm", label: "Heartbeat every 5 s", note: "Harness PID 1 is up: RUNNING. Each beat carries has_active_exec and last_activity_unix_ms.", src: [M("services/harness/src/heartbeat.rs", 29), M(PROTO, 44)] },
        { from: "cp", to: "c", label: "{ vm_id }", kind: "return", note: "The sandbox is addressable by vm_id from here on." },
      ],
    },
    {
      id: "idle",
      label: "Idle suspend + auto-resume",
      steps: [
        { from: "vm", to: "rm", label: "has_active_exec = false", note: "No workload or exec child alive; the tracker stamps when the last one exited.", src: [M("services/harness/src/activity.rs", 1), M("services/harness/src/heartbeat.rs", 105)] },
        { from: "rs", to: "rs", label: "idle sweeper tick (10 s)", note: "Leader only. Eligible: RUNNING, idle_timeout_secs > 0, idle longer than the timeout.", src: [M(IS, 34), M(IS, 63)] },
        { from: "rs", to: "rm", label: "Snapshot { vm_id }", note: "Same crash-safe path as an operator pause, marked scheduler:idle-pausing.", src: [M(IS, 173)] },
        { from: "rs", to: "rm", label: "Stop", note: "The VM is gone from the node; its snapshot stays.", src: [M(IS, 208)] },
        { from: "rs", to: "rs", label: "PAUSED · slot freed", note: "Reason \"auto-suspended (idle timeout)\". Snapshot storage is still kept.", src: [M(IS, 228), M(LC, 10)] },
        { from: "c", to: "cp", label: "POST …/vms/{id}/exec", note: "The client does not know or care that the VM is suspended.", src: [M(`${H}/runtime.go`, 2287)] },
        { from: "cp", to: "rs", label: "ensureVMRunning → Resume", note: "idle_timeout_secs > 0, so ask the scheduler to resume. FailedPrecondition means already running.", src: [M(RL, 250), M(RL, 293)] },
        { from: "rs", to: "rm", label: "Spawn { restore_snapshot_id }", note: "Quota reserved first (402 if over); same vm_id, restored from its snapshot.", src: [M(LC, 223), M(LC, 436)] },
        { from: "cp", to: "rm", label: "Exec", note: "The original exec proceeds; the control plane audits auto_resume.", src: [M(RL, 312)] },
      ],
    },
    {
      id: "pause",
      label: "Pause and resume",
      steps: [
        { from: "c", to: "cp", label: "POST …/vms/{id}/pause", note: "Manual pause. Exec on a manually paused VM returns 409, never auto-resumes.", src: [M(RL, 317), M(RL, 266)] },
        { from: "cp", to: "rs", label: "Pause", note: "Under the per-VM lock; only a RUNNING VM can be paused.", src: [M(LC, 127), M(LC, 136)] },
        { from: "rs", to: "rm", label: "Snapshot", note: "The snapshot id is persisted before Stop, then the VM is marked DRAINING (scheduler:pausing).", src: [M(LC, 155), M(LC, 172)] },
        { from: "rs", to: "rm", label: "Stop { reason: paused }", note: "If Stop fails the VM goes back to RUNNING and keeps its slot.", src: [M(LC, 174), M(LC, 176)] },
        { from: "rs", to: "cp", label: "PAUSED + snapshot_id", kind: "return", note: "Exactly one of the RPC or reconciliation releases the quota slot.", src: [M(LC, 183)] },
        { from: "c", to: "cp", label: "POST …/vms/{id}/resume", note: "Later.", src: [M(RL, 333)] },
        { from: "cp", to: "rs", label: "Resume", note: "TryReserveTenantVMs, then SPAWNING (scheduler:resuming).", src: [M(LC, 200), M(LC, 223), M(LC, 230)] },
        { from: "rs", to: "rm", label: "Spawn from snapshot", note: "Same vm_id. A failed spawn leaves the VM PAUSED and resumable again.", src: [M(LC, 232), M(LC, 233)] },
        { from: "vm", to: "vm", label: "re-identify", note: "The restored guest takes a new incarnation's cert and exec token, so the snapshot's frozen credentials are refused.", src: [M("services/harness/src/reidentify.rs", 1)] },
      ],
    },
    {
      id: "fork",
      label: "Fork ×N",
      steps: [
        { from: "c", to: "cp", label: "POST …/vms/{id}/fork { count }", note: "count 1..PAL_MAX_FORK_COUNT (default 100, ceiling 1000).", src: [M(RL, 353), M(RL, 368)] },
        { from: "cp", to: "rs", label: "Fork + one identity per child", note: "Each child gets its own agent identity; inheriting the source's would let N sandboxes act as one.", src: [M(LC, 267), M(LC, 282)] },
        { from: "rs", to: "rs", label: "reserve N slots", note: "All-or-nothing, before any snapshot I/O.", src: [M(LC, 313)] },
        { from: "rs", to: "rm", label: "Snapshot { keep_running }", note: "A RUNNING source keeps running; a PAUSED source forks from its pause snapshot.", src: [M(LC, 319)] },
        { from: "rs", to: "rm", label: "Spawn ×N (new vm_ids)", note: "Bounded concurrency; a child that fails is reported and its slot released.", src: [M(LC, 342), M(LC, 379)] },
        { from: "rm", to: "vm", label: "hard-link read-only mem", note: "MAP_PRIVATE copy-on-write via the host page cache. Lima nested-virt, indicative: fork spawns took 131, 145 and 160 ms.", src: [M("services/runtime-manager/src/backends/firecracker.rs", 2230), M("docs/benchmarks/runtime-latency.md", 90)] },
        { from: "rs", to: "cp", label: "forks [{ vmId, state }]", kind: "return", note: "Each child RUNNING or FAILED with its error.", src: [M(LC, 401)] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// (e) A run on the microVM tier (gap analysis 3c)
// ---------------------------------------------------------------------------

const SEC = `${H}/runtime_secrets.go`;

export const MICROVM_RUN_SEQUENCE: SequenceDef = {
  id: "microvm-run",
  title: "A run on the microVM tier",
  caption: "From a scheduled AgentSpec to streamed output: quota, placement, boot, secrets, egress, model calls and the journal.",
  lifelines: [
    { id: "c", label: "CLI / SDK", tone: "client" },
    { id: "gw", label: "Gateway", sub: ":8443", tone: "plain" },
    { id: "cp", label: "Control plane", sub: ":8080 · :50051", tone: "plain" },
    { id: "sc", label: "Scheduler", sub: ":50055", tone: "plain" },
    { id: "rm", label: "Runtime manager", sub: ":50054", tone: "host" },
    { id: "vm", label: "microVM", sub: "harness PID 1", tone: "guest" },
    { id: "eb", label: "Egress broker", sub: "host", tone: "host" },
    { id: "mr", label: "Model router", sub: ":50053", tone: "plain" },
  ],
  scenarios: [
    {
      id: "happy",
      label: "Scheduled run",
      steps: [
        { from: "c", to: "gw", label: "POST /v1/runtime/schedule", note: "An AgentSpec: image, isolation, limits, egress rules, secret refs, idleTimeoutSecs." },
        { from: "gw", to: "cp", label: "authenticated", note: "TLS plus a JWT or an API key. The tenant comes from the credential, never the body." },
        { from: "cp", to: "cp", label: "quota gate", note: "Resolves the agent version and stamps tenant_id and run_id. Over the tenant's concurrent-VM quota the answer is HTTP 402 and nothing is placed.", src: [M(RT, 1814)] },
        { from: "cp", to: "sc", label: "RuntimeScheduler.Schedule", note: "Carries x-pal-service-token; the scheduler's port refuses callers without it (fail-closed in prod).", src: [M(PROTO, 215)] },
        { from: "sc", to: "sc", label: "placement", note: "Warm pool, region, fair share, cost and health pick a node." },
        { from: "sc", to: "rm", label: "RuntimeManager.Spawn", note: "Service token plus client TLS. The manager refuses any per-VM certificate on its RuntimeManager methods." },
        { from: "rm", to: "vm", label: "boot or restore snapshot", note: "spawn.json on a read-only image gives the harness its command, env, egress rules and workload uid." },
        { from: "vm", to: "rm", label: "Heartbeat (every 5 s)", note: "Over vsock. A VM silent for 30 s is treated as stale." },
        { from: "vm", to: "rm", label: "VendSecret", note: "The workload asks the harness over a peer-authenticated socket; the harness asks the manager." },
        { from: "rm", to: "cp", label: "POST /v1/runtime/secrets/resolve", note: "The manager relays; only the control plane holds the decryption key. Short-TTL value back.", src: [M(SEC, 116)] },
        { from: "vm", to: "eb", label: "egress → vsock (broker mode)", note: "No NIC in the guest. The host broker applies the allowlist and injects credentials; the secret never enters the VM." },
        { from: "vm", to: "mr", label: "ctx.llm.* (capability)", note: "Models are addressed by capability, never by vendor name. The router picks, caches and fails over." },
        { from: "vm", to: "rm", label: "Report stream", note: "stdout, OTLP spans and metrics, and security audits (logged locally first, never silently dropped)." },
        { from: "cp", to: "c", label: "SSE text/event-stream", kind: "return", note: "Flushed per event; no service buffers the whole response." },
        { from: "cp", to: "cp", label: "journal + billing", note: "The terminal event is journaled; usage feeds the daily rollup." },
      ],
    },
    {
      id: "quota",
      label: "Over quota",
      steps: [
        { from: "c", to: "gw", label: "POST /v1/runtime/schedule", note: "Same request." },
        { from: "gw", to: "cp", label: "authenticated", note: "Tenant from the credential." },
        { from: "cp", to: "cp", label: "quota gate → over", kind: "deny", note: "The tenant is at its concurrent-VM cap.", src: [M(RT, 1814)] },
        { from: "cp", to: "c", label: "402 Payment Required", kind: "deny", note: "Nothing is placed, no VM boots, nothing is billed." },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// (f) Checkpoint and crash-resume (gap analysis 3f)
// ---------------------------------------------------------------------------

const DR = `${H}/durable_replay.go`;
const REC = `${H}/recovery.go`;

export const CHECKPOINT_SEQUENCE: SequenceDef = {
  id: "checkpoint",
  title: "Checkpoint and crash-resume",
  caption: "Every step is journaled before and after. A crash between the two is reclaimed by the recovery sweep and resumed, not restarted.",
  lifelines: [
    { id: "w1", label: "Worker 1", sub: "executor", tone: "plain" },
    { id: "l", label: "run_locks", sub: "lease", tone: "store" },
    { id: "j", label: "journal_events", sub: "Postgres", tone: "store" },
    { id: "rec", label: "Recovery sweep", sub: "every 30 s", tone: "host" },
    { id: "w2", label: "Worker 2", sub: "re-drive", tone: "plain" },
  ],
  scenarios: [
    {
      id: "resume",
      label: "Crash mid-step",
      steps: [
        { from: "w1", to: "l", label: "acquireRunLease(run_id)", note: "A lease with an expiry: one worker owns a run at a time.", src: [M(DR, 93)] },
        { from: "w1", to: "j", label: "step 1: step_started", note: "Written before the side effect, so recovery knows the step began." },
        { from: "w1", to: "j", label: "step 1: step_completed + output", note: "The full output is persisted: this row is the checkpoint." },
        { from: "w1", to: "j", label: "step 2: step_started", note: "The next step is in flight." },
        { from: "w1", to: "w1", label: "process dies", kind: "deny", note: "Deploy, restart or crash before step 2 completes. The lease stops being renewed." },
        { from: "rec", to: "l", label: "find runs with expired locks", note: "Runs in running or queued whose run_locks row is absent or expired (PAL_RECOVERY_INTERVAL, default 30 s).", src: [M(REC, 163)] },
        { from: "rec", to: "l", label: "acquireRecoveryLock", note: "An UPSERT that only steals an expired lock: two replicas never re-drive the same run.", src: [M(REC, 188)] },
        { from: "rec", to: "w2", label: "redriveRun", note: "Re-enters the executor or the workflow interpreter.", src: [M(REC, 228)] },
        { from: "w2", to: "j", label: "CompletedStep(step 1)?", note: "Walks the graph from the trigger; for every side-effecting node it asks the journal first.", src: [M("services/control-plane/internal/workflow/interpreter.go", 213), M(`${H}/rest.go`, 2372)] },
        { from: "j", to: "w2", label: "cached output → skip", kind: "return", note: "Step 1 is not re-executed; its stored output is reused." },
        { from: "w2", to: "j", label: "claimSideEffect(run:step:attempt)", note: "Before any external delivery, so a re-drive cannot send twice. LLM calls carry the same key as Idempotency-Key.", src: [M(DR, 258)] },
        { from: "w2", to: "j", label: "step 2: step_completed → RunCompleted", note: "The run resumes at the first incomplete step and finishes." },
      ],
    },
  ],
};
