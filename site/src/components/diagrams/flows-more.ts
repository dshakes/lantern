import type { FlowDef } from "./FlowDiagram";
import type { Src } from "./types";

// More PAL Runtime diagrams for the shared FlowDiagram kit: triggers, cron,
// connectors, tracing, receipts, streaming, sessions, knowledge, identity,
// isolation, invocation and onboarding. Every claim is from the matching docs
// page or a source line checked while writing; no numbers beyond those.

const M = (p: string, l?: number): Src => ({ p, l });
const CP = "services/control-plane";
const H = `${CP}/internal/handlers`;

// ---------------------------------------------------------------------------
export const WEBHOOK_TRIGGERS: FlowDef = {
  id: "webhook-triggers",
  title: "Webhook triggers",
  caption: "A signed public URL per agent: the signature is the only credential, a duplicate delivery starts one run. Pick a scenario.",
  vb: [980, 250],
  nodes: [
    { id: "sender", label: "Sender", sub: "GitHub · Sentry · any", tone: "client", x: 30, y: 30, detail: "Any service that can sign a request with HMAC-SHA256. It never holds a PAL token." },
    { id: "hook", label: "POST /v1/hooks/id", sub: "public URL", tone: "rt", x: 220, y: 30, detail: "One URL per trigger, bound to one agent. An unknown, malformed or disabled id gets an identical 404 before any signature check.", src: [M(`${H}/triggers.go`, 42)] },
    { id: "verify", label: "Verify HMAC", sub: "provider format", tone: "rt", x: 410, y: 30, detail: "Checks the signature in the provider's format. Any failure is a 401 that never says which part failed.", src: [M(`${H}/triggers.go`, 450), M(`${H}/triggers.go`, 681)] },
    { id: "rate", label: "Rate limit", sub: "per trigger", tone: "rt", x: 600, y: 30, detail: "A per-trigger delivery limit, applied after the signature passes (per replica).", src: [M(`${H}/triggers.go`, 684)] },
    { id: "dedupe", label: "Dedupe", sub: "delivery id + hash", tone: "rt", x: 790, y: 30, detail: "Two keys per trigger: the provider's delivery id and a SHA-256 of the signed bytes. A match on either starts no run.", src: [M(`${H}/triggers.go`, 716)] },
    { id: "secret", label: "Signing secret", sub: "stored encrypted", tone: "store", x: 410, y: 150, detail: "The trigger's secret is stored encrypted and read only to verify a delivery.", src: [M(`${H}/triggers.go`, 157)] },
    { id: "run", label: "Run", sub: "same path as /v1/runs", tone: "rt", x: 600, y: 150, detail: "Created through the same handler as POST /v1/runs, so the agent's budget and the tenant spawn limit apply unchanged." },
    { id: "seen", label: "Deliveries", sub: "agent_trigger_deliveries", tone: "store", x: 790, y: 150, detail: "Each accepted delivery is recorded and later linked to its run id.", src: [M(`${H}/triggers.go`, 758)] },
  ],
  edges: [
    { from: "sender", to: "hook" },
    { from: "hook", to: "verify" },
    { from: "secret", to: "verify", kind: "store" },
    { from: "verify", to: "rate" },
    { from: "rate", to: "dedupe" },
    { from: "dedupe", to: "seen", kind: "store" },
    { from: "dedupe", to: "run" },
  ],
  scenarios: [
    {
      id: "accepted", label: "Delivery accepted",
      steps: [
        { title: "A signed POST arrives", note: "The sender posts the event body with an HMAC-SHA256 signature to the agent's public URL.", edges: ["sender>hook"] },
        { title: "Signature verified", note: "The stored secret recomputes the signature in the provider's format; it matches.", edges: ["hook>verify", "secret>verify"] },
        { title: "Under the rate limit", note: "The per-trigger limit is checked only after the signature has passed.", edges: ["verify>rate"] },
        { title: "First time seen", note: "Neither the delivery id nor the hash of the signed bytes has been recorded for this trigger, so it is stored.", edges: ["rate>dedupe", "dedupe>seen"] },
        { title: "A run starts", note: "The run is created like POST /v1/runs, and the sender gets 202 with the run id.", edges: ["dedupe>run"] },
      ],
    },
    {
      id: "rejected", label: "Rejected",
      steps: [
        { title: "Unknown or disabled hook", note: "A non-UUID id, a missing trigger and a disabled trigger all return the same 404 body, before any signature check.", edges: ["sender>hook"], deny: true },
        { title: "Wrong or missing signature", note: "The signature is the only credential, so a bad or malformed one gets 401 with no hint about which part failed.", edges: ["hook>verify", "secret>verify"], deny: true },
        { title: "Stale timestamp", note: "A generic-provider timestamp outside the five-minute window also returns 401.", nodes: ["verify"], deny: true },
      ],
    },
    {
      id: "duplicate", label: "Duplicate deduped",
      steps: [
        { title: "The same event arrives again", note: "A provider retry or a replay carries the same signed bytes and delivery id.", edges: ["sender>hook", "hook>verify"] },
        { title: "Signature still valid", note: "A duplicate is a genuine delivery, so it passes verification and the rate check.", edges: ["secret>verify", "verify>rate"] },
        { title: "Dedupe hit", note: "A match on the delivery id or the SHA-256 returns 200 with duplicate true.", edges: ["rate>dedupe", "dedupe>seen"] },
        { title: "No second run", note: "The run is never created, so one event can start one run no matter how often it is delivered.", nodes: ["run"], deny: true },
      ],
    },
    {
      id: "budget", label: "Budget reached",
      steps: [
        { title: "A valid, new delivery", note: "Signature and dedupe pass as in the first scenario.", edges: ["sender>hook", "hook>verify", "verify>rate", "rate>dedupe"] },
        { title: "Run creation refused", note: "The agent's hard-fail budget is already reached, so the delivery gets 402 and no run starts.", edges: ["dedupe>run"], deny: true },
        { title: "Delivery id released", note: "On 402, 429 or 500 the delivery id is released, so the provider's own retry can succeed once the cap resets.", edges: ["dedupe>seen"] },
      ],
    },
  ],
  legend: [["client", "Outside PAL"], ["rt", "Control plane"], ["store", "Data stores"]],
};

// ---------------------------------------------------------------------------
export const CRON_SCHEDULES: FlowDef = {
  id: "cron-schedules",
  title: "Cron schedules and timezones",
  caption: "A schedule resolves a timezone, computes its next fire time, and the scheduler claims and fires it when due.",
  vb: [980, 410],
  nodes: [
    { id: "create", label: "POST /v1/schedules", sub: "cronExpr · timezone?", tone: "client", x: 30, y: 110, detail: "Create or update a schedule. An invalid IANA timezone is a 400.", src: [M(`${H}/schedules.go`, 58)] },
    { id: "tzs", label: "Schedule timezone", sub: "if set", x: 220, y: 20, detail: "A per-schedule IANA zone such as America/New_York wins when present." },
    { id: "tze", label: "PAL_DEFAULT_TIMEZONE", sub: "deployment default", x: 220, y: 110, w: 170, detail: "A deployment-wide IANA zone, used when the schedule has none. An invalid value logs a warning and falls through.", src: [M(`${CP}/internal/scheduler/tz.go`, 11)] },
    { id: "utc", label: "UTC", sub: "last resort", x: 220, y: 200, detail: "With neither set, everything stays UTC, so 0 9 * * * fires at 09:00 UTC." },
    { id: "resolve", label: "ResolveLocation", sub: "first match wins", tone: "rt", x: 430, y: 110, detail: "Priority: schedule timezone, then the env default, then UTC.", src: [M(`${CP}/internal/scheduler/tz.go`, 14)] },
    { id: "next", label: "NextCronTime", sub: "in that zone", tone: "rt", x: 610, y: 110, detail: "Computes the next fire instant from the cron expression in the resolved zone.", src: [M(`${CP}/internal/scheduler/cron.go`, 16), M(`${H}/schedules.go`, 59)] },
    { id: "table", label: "schedules", sub: "next_fire_at", tone: "store", x: 790, y: 110, detail: "Each row stores its cron expression, timezone and next_fire_at." },
    { id: "poll", label: "Scheduler poll", sub: "every 60 s", tone: "rt", x: 790, y: 330, detail: "A ticker wakes the scheduler once a minute, so a due schedule fires within a minute.", src: [M(`${CP}/internal/scheduler/scheduler.go`, 57)] },
    { id: "claim", label: "Claim due rows", sub: "FOR UPDATE SKIP LOCKED", tone: "rt", x: 790, y: 220, w: 160, detail: "Due rows are claimed in a transaction with SKIP LOCKED, so two schedulers never fire the same row.", src: [M(`${CP}/internal/scheduler/scheduler.go`, 21), M(`${CP}/internal/scheduler/scheduler.go`, 135)] },
    { id: "budget", label: "Budget check", sub: "hard-fail caps", x: 610, y: 220, detail: "An agent over its hard-fail budget does not fire at all." },
    { id: "run", label: "Run", sub: "shows in the console", tone: "rt", x: 430, y: 220, detail: "A scheduled run appears like any other run." },
  ],
  edges: [
    { from: "create", to: "tzs" },
    { from: "tzs", to: "tze", label: "unset", dashed: true },
    { from: "tze", to: "utc", label: "unset", dashed: true },
    { from: "tzs", to: "resolve" },
    { from: "tze", to: "resolve" },
    { from: "utc", to: "resolve" },
    { from: "resolve", to: "next" },
    { from: "next", to: "table", kind: "store" },
    { from: "poll", to: "claim" },
    { from: "claim", to: "table", kind: "store" },
    { from: "claim", to: "budget" },
    { from: "budget", to: "run" },
    { from: "claim", to: "next", label: "advance", dashed: true },
  ],
  scenarios: [
    {
      id: "own-tz", label: "Schedule has a timezone",
      steps: [
        { title: "Created with a zone", note: "The request carries a timezone such as America/New_York next to the cron expression.", edges: ["create>tzs"] },
        { title: "The schedule's zone wins", note: "A per-schedule zone is the first level in the priority order, so the other two are never consulted.", edges: ["tzs>resolve"] },
        { title: "Next fire computed locally", note: "0 9 * * * now means 9am in that zone, not 09:00 UTC.", edges: ["resolve>next"] },
        { title: "Stored on the row", note: "next_fire_at is saved on the schedule for the poller to find.", edges: ["next>table"] },
      ],
    },
    {
      id: "env-default", label: "Falls to the env default",
      steps: [
        { title: "No timezone on the schedule", note: "The request leaves timezone empty.", edges: ["create>tzs"] },
        { title: "Next level: the deployment default", note: "PAL_DEFAULT_TIMEZONE, an IANA name set for the whole deployment, is used instead.", edges: ["tzs>tze"] },
        { title: "Resolved and computed", note: "The env zone drives NextCronTime exactly as a per-schedule zone would.", edges: ["tze>resolve", "resolve>next"] },
      ],
    },
    {
      id: "utc", label: "Nothing set: UTC",
      steps: [
        { title: "No schedule zone", note: "The request carries no timezone.", edges: ["create>tzs"] },
        { title: "No env default either", note: "With PAL_DEFAULT_TIMEZONE unset the lookup falls through again.", edges: ["tzs>tze", "tze>utc"] },
        { title: "UTC is used", note: "This is the behavior from before timezones existed, so existing schedules are unchanged.", edges: ["utc>resolve", "resolve>next"] },
      ],
    },
    {
      id: "fire", label: "A due schedule fires",
      steps: [
        { title: "The poller wakes", note: "The scheduler ticks every 60 seconds.", edges: ["poll>claim"] },
        { title: "Due rows are claimed", note: "Rows whose next_fire_at has passed are locked with SKIP LOCKED inside one transaction.", edges: ["claim>table"] },
        { title: "Budget is checked first", note: "An agent over a hard-fail budget does not fire, so an unattended schedule cannot overspend.", edges: ["claim>budget"] },
        { title: "The run starts", note: "The run takes the same path as any other.", edges: ["budget>run"] },
        { title: "The next time is advanced", note: "NextCronTime runs again in the schedule's own zone to set the following next_fire_at.", edges: ["claim>next"], src: [M(`${CP}/internal/scheduler/scheduler.go`, 188)] },
      ],
    },
  ],
  legend: [["client", "API call"], ["rt", "Control plane"], ["store", "Data stores"]],
};

// ---------------------------------------------------------------------------
export const CONNECTOR_ACTIONS: FlowDef = {
  id: "connector-actions",
  title: "Connector actions",
  caption: "How a tool call or REST call reaches an external API with a stored credential, and what happens when nothing is installed.",
  vb: [980, 250],
  nodes: [
    { id: "caller", label: "Agent or REST", sub: "tool call · curl", tone: "client", x: 30, y: 30, detail: "A connector assigned to an agent reaches the model as a tool. You can also call an action directly over REST. An agent can only use connectors explicitly assigned to it." },
    { id: "exec", label: "POST …/execute", sub: "?action=name", tone: "rt", x: 220, y: 30, detail: "The control plane's execute endpoint. The connector must be installed and connected first.", src: [M(`${H}/connector_executor.go`, 236)] },
    { id: "inst", label: "connector_installs", sub: "AES-256-GCM at rest", tone: "store", x: 410, y: 30, detail: "Per-tenant install state and credentials, encrypted at rest when PAL_CREDENTIAL_KEY is set.", src: [M(`${H}/connectors.go`, 88)] },
    { id: "executor", label: "Connector executor", sub: "18 connectors", tone: "rt", x: 600, y: 30, detail: "Resolves the credential at call time and runs the action. Credentials never appear in logs, traces or run state.", src: [M(`${H}/connector_executor.go`, 349)] },
    { id: "vendor", label: "External API", sub: "Slack · GitHub · …", tone: "client", x: 790, y: 30, detail: "The vendor's HTTPS API." },
    { id: "replay", label: "Fixture server", sub: "recorded responses", x: 790, y: 150, detail: "cmd/connector-replay serves recorded responses for Slack, GitHub, Sentry, PagerDuty and Google Calendar. Dev and test only." },
  ],
  edges: [
    { from: "caller", to: "exec" },
    { from: "exec", to: "inst", kind: "store" },
    { from: "inst", to: "executor", kind: "inject" },
    { from: "executor", to: "vendor" },
    { from: "executor", to: "replay", dashed: true },
  ],
  scenarios: [
    {
      id: "ok", label: "Action succeeds",
      steps: [
        { title: "An action is requested", note: "The model calls an assigned connector tool, or a client posts to the execute endpoint with params.", edges: ["caller>exec"] },
        { title: "The install is read", note: "The tenant's install row is read inside a tenant-scoped transaction.", edges: ["exec>inst"] },
        { title: "Credential resolved at call time", note: "The stored token is decrypted only for this call and handed to the executor.", edges: ["inst>executor"] },
        { title: "The vendor is called", note: "The executor sends the request to the external API and returns the action's data to the caller.", edges: ["executor>vendor"] },
      ],
    },
    {
      id: "missing", label: "Not installed",
      steps: [
        { title: "An action is requested", note: "The call names a connector this tenant has not installed or connected.", edges: ["caller>exec"] },
        { title: "No install row", note: "The lookup finds nothing usable for the connector.", edges: ["exec>inst"], deny: true },
        { title: "404, nothing is sent", note: "The control plane answers not found and no request leaves for the vendor.", nodes: ["exec"], deny: true, src: [M(`${H}/connector_executor.go`, 187)] },
      ],
    },
    {
      id: "test", label: "Recorded test mode",
      steps: [
        { title: "Point a vendor at the fixture server", note: "Set PAL_CONNECTOR_BASEURL_SLACK (or GITHUB, SENTRY, GOOGLE, PAGERDUTY) to the local fixture server before starting.", nodes: ["replay"] },
        { title: "Only the host is replaced", note: "Scheme and host are swapped and the vendor path is kept, so recorded real paths such as chat.postMessage match.", edges: ["executor>replay"] },
        { title: "Refused in production", note: "With PAL_ENV set to prod, production or staging the control plane exits at startup if an override is set, so tenant tokens cannot be redirected.", edges: ["executor>vendor"], deny: true },
      ],
    },
  ],
  legend: [["client", "Outside PAL"], ["rt", "Control plane"], ["store", "Data stores"]],
};

// ---------------------------------------------------------------------------
export const TRACE_PROPAGATION: FlowDef = {
  id: "trace-propagation",
  title: "Trace propagation",
  caption: "One trace per spawn: both entry points stamp the same attributes, and the trace context follows the run into the microVM.",
  vb: [980, 310],
  nodes: [
    { id: "gw", label: "Gateway", sub: "gateway.request", tone: "rt", x: 30, y: 20, detail: "One span per HTTP request, tagged with tenant_id, honoring an inbound W3C traceparent." },
    { id: "http", label: "otelhttp handler", sub: "span per route", tone: "rt", x: 220, y: 20, detail: "HTTP requests are wrapped by otelhttp, named by the low-cardinality route template.", src: [M(`${CP}/cmd/server/main.go`, 914)] },
    { id: "grpc", label: "gRPC interceptors", sub: "unary + stream", tone: "rt", x: 220, y: 200, detail: "gRPC methods get spans from the tracing interceptors.", src: [M(`${CP}/cmd/server/main.go`, 255)] },
    { id: "enrich", label: "EnrichSpan", sub: "lantern.* attributes", tone: "rt", x: 410, y: 110, detail: "One helper stamps lantern.tenant_id, user_id, run_id and step_id, so HTTP, gRPC and step spans filter by the same keys.", src: [M(`${CP}/internal/middleware/span.go`, 32)] },
    { id: "step", label: "Step spans", sub: "run_id · step_id", tone: "rt", x: 600, y: 110, detail: "The executor enriches each workflow step span with its run and step id.", src: [M(`${CP}/cmd/server/main.go`, 1405)] },
    { id: "mr", label: "Model router", sub: "model_used · tokens", tone: "rt", x: 410, y: 200, detail: "One span per routing call with tenant_id, run_id, step_id, model_used, tokens and cost_usd." },
    { id: "rm", label: "Runtime manager", sub: "traceparent", tone: "host", x: 600, y: 200, detail: "The scheduler and manager carry tenant_id and vm_id and pass the trace context on." },
    { id: "harness", label: "Harness", sub: "inside the microVM", tone: "guest", x: 790, y: 200, detail: "The in-VM harness joins the spawn's trace through the propagated traceparent.", src: [M("services/harness/src/main.rs", 168)] },
    { id: "otlp", label: "OTLP collector", sub: "your tracing backend", tone: "store", x: 790, y: 20, detail: "Spans export only when OTEL_EXPORTER_OTLP_ENDPOINT or PAL_OTEL_ENABLED is set." },
  ],
  edges: [
    { from: "gw", to: "http" },
    { from: "http", to: "enrich" },
    { from: "grpc", to: "enrich" },
    { from: "enrich", to: "step" },
    { from: "step", to: "mr" },
    { from: "step", to: "rm" },
    { from: "rm", to: "harness" },
    { from: "step", to: "otlp", kind: "store" },
  ],
  scenarios: [
    {
      id: "http", label: "An HTTP request",
      steps: [
        { title: "The gateway opens the first span", note: "gateway.request is tagged with tenant_id and joins any inbound W3C traceparent.", nodes: ["gw"] },
        { title: "The control plane wraps it", note: "otelhttp names the span after the route template, for example GET /v1/runs/{id}/events.", edges: ["gw>http"] },
        { title: "Identifiers are stamped", note: "EnrichSpan adds tenant and user, and the run id when the path carries one.", edges: ["http>enrich"] },
        { title: "Each step adds its own", note: "The executor adds lantern.step_id on every workflow step span.", edges: ["enrich>step"] },
        { title: "Exported to the collector", note: "The spans leave over OTLP to your backend; a run is then one query on lantern.run_id.", edges: ["step>otlp"] },
      ],
    },
    {
      id: "grpc", label: "A gRPC call",
      steps: [
        { title: "The interceptor opens a span", note: "The unary and stream tracing interceptors create the span for a gRPC method.", nodes: ["grpc"] },
        { title: "Same helper, same keys", note: "It funnels through EnrichSpan, so gRPC spans carry exactly the attributes HTTP spans do.", edges: ["grpc>enrich"] },
        { title: "Same step spans", note: "From here the run looks identical in the trace whichever door it came through.", edges: ["enrich>step"] },
      ],
    },
    {
      id: "vm", label: "Into the microVM",
      steps: [
        { title: "A step needs a sandbox", note: "The step span is the parent of the work that follows.", nodes: ["step"] },
        { title: "Scheduler and manager continue it", note: "They tag tenant_id and vm_id and pass W3C traceparent along.", edges: ["step>rm"] },
        { title: "The harness joins the trace", note: "The in-VM harness carries the spawn's trace context, so one trace spans from gateway to VM.", edges: ["rm>harness"] },
        { title: "Model calls join too", note: "The router emits a span with model, tokens and cost on the same trace.", edges: ["step>mr"] },
      ],
    },
    {
      id: "off", label: "Exporter unset",
      steps: [
        { title: "No endpoint configured", note: "With neither OTEL_EXPORTER_OTLP_ENDPOINT nor PAL_OTEL_ENABLED set, tracing is a no-op with zero overhead.", nodes: ["otlp"], deny: true },
        { title: "Context is still forwarded", note: "W3C traceparent is always propagated, so a downstream collector still sees a connected trace.", edges: ["step>rm", "rm>harness"] },
      ],
    },
  ],
  legend: [["rt", "PAL Runtime services"], ["host", "Trusted host code"], ["guest", "Inside the VM"], ["store", "Collector"]],
};

// ---------------------------------------------------------------------------
export const SIGNED_RECEIPTS: FlowDef = {
  id: "signed-receipts",
  title: "Signed receipts",
  caption: "A receipt signs the hash of the run's journal, so anyone can check what ran and that the record was not edited.",
  vb: [980, 250],
  nodes: [
    { id: "run", label: "Completed run", sub: "POST …/receipt", tone: "rt", x: 30, y: 30, detail: "Issuing is a request on a finished run. A non-terminal run is not refused; the receipt records its status at issuance.", src: [M(`${H}/receipts.go`, 182)] },
    { id: "journal", label: "journal_events", sub: "ordered event log", tone: "store", x: 220, y: 30, detail: "The event-sourced record of every step that executed." },
    { id: "hash", label: "SHA-256", sub: "of the journal", tone: "rt", x: 410, y: 30, detail: "The ordered journal_events rows are hashed into journalHash.", src: [M(`${H}/receipts.go`, 506)] },
    { id: "sign", label: "Ed25519 sign", sub: "canonical JSON", tone: "rt", x: 600, y: 30, detail: "The payload (run, agent, cost, tokens, journalHash) is signed. Without PAL_RECEIPT_ED25519_SEED it falls back to HMAC-SHA256 for dev.", src: [M(`${H}/receipts.go`, 388)] },
    { id: "store", label: "run_receipts", sub: "stored with the run", tone: "store", x: 790, y: 30, detail: "Persisted so the receipt can be retrieved and re-verified later.", src: [M(`${H}/receipts.go`, 536)] },
    { id: "export", label: "Journal export", sub: "the run's event log", tone: "store", x: 220, y: 150, detail: "Checking that nothing changed after the fact needs the run's actual journal." },
    { id: "auditor", label: "Verifier", sub: "auditor · customer", tone: "client", x: 410, y: 150, detail: "Anyone holding a receipt. The public /proof page needs no sign-in." },
    { id: "verify", label: "…/receipts/verify", sub: "no auth required", tone: "rt", x: 600, y: 150, detail: "Checks a receipt signature.", src: [M(`${H}/receipts.go`, 237)] },
    { id: "wk", label: "/.well-known/", sub: "lantern-receipts", tone: "rt", x: 790, y: 150, detail: "Publishes the signing algorithm, key fingerprint and, for Ed25519, the public key, so verification works without trusting your control plane." },
  ],
  edges: [
    { from: "run", to: "journal" },
    { from: "journal", to: "hash" },
    { from: "hash", to: "sign" },
    { from: "sign", to: "store", kind: "store" },
    { from: "journal", to: "export", kind: "store" },
    { from: "export", to: "auditor" },
    { from: "auditor", to: "verify" },
    { from: "wk", to: "verify", kind: "inject" },
  ],
  scenarios: [
    {
      id: "issue", label: "Issue a receipt",
      steps: [
        { title: "A run has finished", note: "A receipt is requested for the run, scoped to the caller's tenant.", edges: ["run>journal"] },
        { title: "The journal is hashed", note: "The ordered event rows are reduced to one SHA-256, so the receipt covers the exact sequence of steps that ran.", edges: ["journal>hash"] },
        { title: "The payload is signed", note: "Canonical JSON with sorted keys and the journal hash is signed with Ed25519.", edges: ["hash>sign"] },
        { title: "Stored with the run", note: "The signed receipt is persisted so it can be fetched and re-verified later.", edges: ["sign>store"] },
      ],
    },
    {
      id: "verify", label: "Verify offline",
      steps: [
        { title: "A verifier gets the receipt", note: "An auditor or customer holds the receipt; no account is needed.", nodes: ["auditor"] },
        { title: "The public key is published", note: "The well-known endpoint serves the algorithm, fingerprint and Ed25519 public key.", edges: ["wk>verify"] },
        { title: "The signature checks out", note: "The verify endpoint, or the public /proof page, confirms the deployment's key signed it.", edges: ["auditor>verify"] },
      ],
    },
    {
      id: "tamper", label: "Tampered journal fails",
      steps: [
        { title: "One event is edited afterward", note: "Someone changes a single journal row after the receipt was issued.", nodes: ["journal"], deny: true },
        { title: "The verifier re-hashes the export", note: "Hashing the run's exported journal now gives a different SHA-256.", edges: ["journal>export", "export>auditor"] },
        { title: "The hash no longer matches", note: "It differs from the journalHash the signature covers, so verification fails.", edges: ["auditor>verify"], deny: true },
      ],
    },
  ],
  legend: [["rt", "Control plane"], ["client", "Outside PAL"], ["store", "Data stores"]],
};

// ---------------------------------------------------------------------------
export const TOKEN_STREAMING: FlowDef = {
  id: "token-streaming",
  title: "Token streaming",
  caption: "Session replies flow provider to client with no buffering, except tool-using turns, which return one finished message.",
  vb: [980, 250],
  nodes: [
    { id: "prov", label: "Model provider", sub: "streaming mode", tone: "client", x: 30, y: 30, detail: "The control plane calls the provider in streaming mode and sets an Idempotency-Key so a crash-retry dedups at the provider." },
    { id: "cp", label: "Control plane", sub: "streamWithFailover", tone: "rt", x: 220, y: 30, detail: "Each provider chunk triggers an onDelta callback. If the primary fails before any delta, the chain retries the next provider.", src: [M(`${H}/llm_proxy.go`, 1384), M(`${H}/sessions.go`, 669)] },
    { id: "redis", label: "Redis pub/sub", sub: "session channel", tone: "store", x: 410, y: 30, detail: "Deltas are published to the session channel for fan-out." },
    { id: "sse", label: "GET …/events", sub: "named SSE events", tone: "rt", x: 600, y: 30, detail: "Subscribers get message_delta, message_completed and message_error on one long-lived connection." },
    { id: "gw", label: "Gateway", sub: "SSE proxy", tone: "rt", x: 790, y: 30, detail: "TLS and auth at the edge, proxying the stream through." },
    { id: "tools", label: "Tool-use loop", sub: "non-streaming", tone: "rt", x: 220, y: 150, detail: "When tools are attached the turn runs a non-streaming tool loop of up to 5 rounds." },
    { id: "sdk", label: "SDK iterator", sub: "streamMessage()", tone: "client", x: 600, y: 150, detail: "Reorders by seq, ignores unknown events and throws MessageStreamError on message_error." },
    { id: "dash", label: "Console · widget", sub: "renders tokens", tone: "client", x: 790, y: 150, detail: "The dashboard chat and the embedded webchat render each delta, then flip to the final text on message_completed." },
  ],
  edges: [
    { from: "prov", to: "cp" },
    { from: "cp", to: "redis", kind: "store" },
    { from: "redis", to: "sse" },
    { from: "sse", to: "gw" },
    { from: "gw", to: "sdk" },
    { from: "gw", to: "dash" },
    { from: "cp", to: "tools" },
    { from: "tools", to: "redis", kind: "store" },
  ],
  scenarios: [
    {
      id: "stream", label: "Tool-free turn",
      steps: [
        { title: "The provider streams", note: "Tokens arrive from the provider as the model writes them.", edges: ["prov>cp"] },
        { title: "Each chunk is published", note: "Every chunk becomes a message_delta with a per-turn seq starting at 1.", edges: ["cp>redis"] },
        { title: "Fanned out over SSE", note: "The events endpoint relays each delta to connected clients.", edges: ["redis>sse", "sse>gw"] },
        { title: "Rendered as it arrives", note: "The SDK iterator and the dashboard show each fragment immediately.", edges: ["gw>sdk", "gw>dash"] },
        { title: "One completed event closes the turn", note: "message_completed carries the full text and usage, exactly once per turn.", nodes: ["sse"] },
      ],
    },
    {
      id: "tools", label: "Tool-using turn",
      steps: [
        { title: "Tools are attached", note: "The session has tools, so the turn does not take the streaming path.", edges: ["cp>tools"] },
        { title: "The loop runs to the end", note: "Up to 5 rounds of tool calls run without any message_delta being emitted.", nodes: ["tools"] },
        { title: "One completed message", note: "The client receives a single message_completed with the whole answer and no preceding deltas.", edges: ["tools>redis", "redis>sse", "sse>gw"] },
      ],
    },
    {
      id: "error", label: "Provider fails mid-stream",
      steps: [
        { title: "Failure before any delta", note: "The failover chain retries the next configured provider and the client sees nothing.", edges: ["prov>cp"] },
        { title: "Failure after a delta", note: "The partial reply cannot be un-sent, so the primary failing now ends the turn.", edges: ["prov>cp"], deny: true },
        { title: "message_error is emitted", note: "It carries the same turnId, telling clients to discard what they accumulated.", edges: ["cp>redis", "redis>sse", "sse>gw"], deny: true },
        { title: "The SDK throws", note: "The iterator raises a typed MessageStreamError instead of yielding a half answer.", edges: ["gw>sdk"], deny: true },
      ],
    },
  ],
  legend: [["client", "Outside PAL"], ["rt", "PAL Runtime services"], ["store", "Data stores"]],
};

// ---------------------------------------------------------------------------
export const SESSIONS_MEMORY: FlowDef = {
  id: "sessions-memory",
  title: "Sessions and memory",
  caption: "A session turn calls the provider chain directly with the full history; memory distillation runs separately, off by default.",
  vb: [980, 340],
  nodes: [
    { id: "caller", label: "Caller", sub: "POST …/messages", tone: "client", x: 30, y: 30, detail: "Create a session, then send messages. Stop ends the session and its microVM; delete removes it." },
    { id: "handler", label: "Session handler", sub: "control plane", tone: "rt", x: 220, y: 30, detail: "A turn does not create a run row; the full history is passed as context each time." },
    { id: "llm", label: "Provider chain", sub: "failover", tone: "rt", x: 410, y: 30, detail: "Streaming without tools, otherwise a non-streaming tool loop of up to 5 rounds." },
    { id: "sse", label: "GET …/events", sub: "SSE", tone: "rt", x: 600, y: 30, detail: "Replies and events stream here." },
    { id: "sub", label: "Subscriber", sub: "SDK · console", tone: "client", x: 790, y: 30, detail: "Whatever is reading the session's events." },
    { id: "store", label: "sessions.messages", sub: "JSONB history", tone: "store", x: 220, y: 150, detail: "The session's transcript, kept on the sessions table." },
    { id: "events", label: "Timeline events", sub: "per person", tone: "store", x: 410, y: 150, detail: "Raw events stored by the memory ingest and identity endpoints." },
    { id: "people", label: "Person graph", sub: "/v1/people", x: 790, y: 150, detail: "A canonical person row per handle, so events from different channels land on the same person." },
    { id: "distill", label: "Distillation", sub: "PAL_MEMORY_DISTILL", tone: "rt", x: 600, y: 150, detail: "Flag-gated, default off. An LLM pass, every 6 hours by default, extracts durable facts.", src: [M(`${H}/memory_distill.go`, 11)] },
    { id: "facts", label: "memory_distillates", sub: "topic · person · fact", tone: "store", x: 600, y: 260, w: 170, detail: "One compact row per topic and person, kept only when confidence is at least 0.60. RLS-enforced." },
  ],
  edges: [
    { from: "caller", to: "handler" },
    { from: "handler", to: "llm" },
    { from: "llm", to: "sse" },
    { from: "sse", to: "sub" },
    { from: "handler", to: "store", kind: "store", bidi: true },
    { from: "people", to: "distill", dashed: true },
    { from: "events", to: "distill", kind: "store" },
    { from: "store", to: "distill", kind: "store", via: [[295, 120], [675, 120]] },
    { from: "distill", to: "facts", kind: "store" },
  ],
  scenarios: [
    {
      id: "turn", label: "A session turn",
      steps: [
        { title: "A message is posted", note: "The caller sends content to the session.", edges: ["caller>handler"] },
        { title: "History is loaded and saved", note: "The full messages array is read as context and the new turn appended.", edges: ["handler>store"] },
        { title: "The provider chain answers", note: "No run row is created; the turn goes straight to the provider-failover chain.", edges: ["handler>llm"] },
        { title: "Events stream out", note: "The reply streams on the session's events endpoint to whoever is subscribed.", edges: ["llm>sse", "sse>sub"] },
      ],
    },
    {
      id: "memory", label: "Memory distillation",
      steps: [
        { title: "Signal accumulates", note: "Session transcripts and timeline events build up over time, tied to people through the person graph.", edges: ["people>distill", "events>distill", "store>distill"] },
        { title: "An LLM extracts durable facts", note: "Off unless PAL_MEMORY_DISTILL is on; the pass runs every 6 hours by default and goes through the provider chain, never a hardcoded vendor.", nodes: ["distill"] },
        { title: "Only confident facts persist", note: "Items need confidence of at least 0.60 plus a topic and content; any error writes nothing.", edges: ["distill>facts"] },
        { title: "Facts return in future sessions", note: "The stored distillates are re-injected into later conversations so memory outlives any one session.", nodes: ["facts", "handler"] },
      ],
    },
    {
      id: "crash", label: "Crash mid-turn",
      steps: [
        { title: "A turn is in flight", note: "The provider call is running inside the control plane.", edges: ["handler>llm"] },
        { title: "The control plane crashes", note: "Session turns are not journaled, so that turn is lost.", nodes: ["handler"], deny: true },
        { title: "Resend the message", note: "Provider requests still carry a body-derived Idempotency-Key; for journal crash-resume, use a run instead.", edges: ["caller>handler"] },
      ],
    },
  ],
  legend: [["client", "Outside PAL"], ["rt", "Control plane"], ["store", "Data stores"]],
};

// ---------------------------------------------------------------------------
export const KNOWLEDGE_HANDOFF: FlowDef = {
  id: "knowledge-handoff",
  title: "Knowledge base and human handoff",
  caption: "Documents become cited answers; an agent labelled for handoff can pass a chat to a person with a Slack ping.",
  vb: [980, 250],
  nodes: [
    { id: "upload", label: "Upload document", sub: "POST …/documents", tone: "client", x: 30, y: 30, detail: "Up to 1 MiB of text and 120 chunks. A caller-supplied id makes the upload idempotent." },
    { id: "chunk", label: "Chunk + embed", sub: "text-embedding-3-small", tone: "rt", x: 220, y: 30, w: 160, detail: "Chunks are embedded with the tenant's OpenAI key, 1536 dimensions. With no key they are stored without a vector.", src: [M(`${H}/knowledge.go`, 12)] },
    { id: "kb", label: "Postgres", sub: "pgvector chunks", tone: "store", x: 410, y: 30, detail: "Chunks and vectors, matched by cosine distance. Without vectors, search falls back to Postgres full-text." },
    { id: "tool", label: "handoff_to_human", sub: "the agent's one tool", tone: "rt", x: 600, y: 30, detail: "An agent labelled handoff=human has exactly this tool and no connector tools. The session moves to status handoff.", src: [M(`${H}/session_handoff.go`, 37)] },
    { id: "slack", label: "Slack channel", sub: "via your connector", tone: "client", x: 790, y: 30, detail: "A message is posted once per handoff through the installed Slack connector." },
    { id: "msg", label: "Session message", sub: "a customer asks", tone: "client", x: 30, y: 150, detail: "On every session message the best chunks are added to the agent's context." },
    { id: "retr", label: "Retrieve", sub: "above score floor", tone: "rt", x: 220, y: 150, detail: "Hits below the minimum score (default 0.2) are dropped. Excerpts are fenced as reference data, not instructions.", src: [M(`${H}/knowledge.go`, 360)] },
    { id: "reply", label: "Agent reply", sub: "grounded in chunks", tone: "rt", x: 410, y: 150, detail: "An agent with no documents makes no embedding call." },
    { id: "chat", label: "Customer chat", sub: "reply · sources", tone: "client", x: 600, y: 150, detail: "message_completed includes sources with the id and title of the documents used; the widget shows them." },
    { id: "operator", label: "Operator", sub: "a person", tone: "client", x: 790, y: 150, detail: "Replies through the operator-messages endpoint while the session is in handoff, then resolves to hand the chat back." },
  ],
  edges: [
    { from: "upload", to: "chunk" },
    { from: "chunk", to: "kb", kind: "store" },
    { from: "msg", to: "retr" },
    { from: "kb", to: "retr", kind: "store" },
    { from: "retr", to: "reply" },
    { from: "reply", to: "chat" },
    { from: "reply", to: "tool", dashed: true },
    { from: "tool", to: "slack" },
    { from: "slack", to: "operator" },
    { from: "operator", to: "chat" },
  ],
  scenarios: [
    {
      id: "upload", label: "Upload a document",
      steps: [
        { title: "A document is uploaded", note: "Title, content and optional source go to the agent's documents endpoint.", edges: ["upload>chunk"] },
        { title: "Split and embedded", note: "Each chunk is embedded and stored with its vector in Postgres.", edges: ["chunk>kb"] },
        { title: "No OpenAI key", note: "Chunks are still stored, without a vector, and search degrades to full-text rather than failing.", nodes: ["chunk", "kb"] },
      ],
    },
    {
      id: "cited", label: "Cited answer",
      steps: [
        { title: "A customer asks", note: "A message arrives on a session for an agent that has documents.", edges: ["msg>retr"] },
        { title: "The best chunks are found", note: "Chunks above the score floor join the agent's context.", edges: ["kb>retr"] },
        { title: "The model answers from them", note: "The excerpts are labelled as reference data, so text inside a document cannot give orders.", edges: ["retr>reply"] },
        { title: "The reply carries its sources", note: "message_completed lists the documents used, shown under the reply.", edges: ["reply>chat"] },
      ],
    },
    {
      id: "handoff", label: "Hand to a human",
      steps: [
        { title: "The model cannot answer", note: "It calls handoff_to_human, its only tool, or a caller forces a handoff.", edges: ["reply>tool"] },
        { title: "Session enters handoff", note: "Status becomes handoff and the stream emits session.handoff; further customer messages are saved but the model stays silent.", nodes: ["tool", "chat"] },
        { title: "Slack is pinged once", note: "A message goes to the configured channel through your Slack connector.", edges: ["tool>slack"] },
        { title: "A person takes over", note: "The operator replies through the operator-messages endpoint, which needs the coarse write scope on purpose.", edges: ["slack>operator", "operator>chat"] },
        { title: "Resolve hands it back", note: "Resolving returns the chat to the agent and emits session.resolved.", nodes: ["reply", "chat"] },
      ],
    },
  ],
  legend: [["client", "People and clients"], ["rt", "Control plane"], ["store", "Data stores"]],
};

// ---------------------------------------------------------------------------
export const IDENTITY_SECRETS: FlowDef = {
  id: "identity-secrets",
  title: "Identity and secret vending",
  caption: "The spec holds a reference, never a value. A secret is vended at the last moment to a peer the kernel has authenticated.",
  vb: [980, 250],
  nodes: [
    { id: "spec", label: "Agent spec", sub: "lantern.secret/ ref", tone: "client", x: 30, y: 30, detail: "Declares a name such as lantern.secret://__tenant__/key/scraper-user-agent. The raw value never appears in the image, logs, traces or run state." },
    { id: "mgr", label: "Runtime manager", sub: "binds vm_id to cert", tone: "host", x: 220, y: 30, detail: "Injects the workload uid at spawn and binds the vm_id on a vend request to the mTLS peer certificate, so a workload cannot claim to be another VM." },
    { id: "sock", label: "secrets.sock", sub: "harness, SO_PEERCRED", tone: "guest", x: 410, y: 30, detail: "A Unix socket in the VM. The kernel attests the connecting peer's uid and pid; there is nothing the workload can forge.", src: [M("services/harness/src/secrets.rs", 94), M("services/harness/src/secrets.rs", 146)] },
    { id: "work", label: "Workload", sub: "agent code", tone: "guest", x: 600, y: 30, detail: "Runs as the workload uid and asks for the secret when it needs it." },
    { id: "cp", label: "Control plane", sub: "relay endpoint", tone: "rt", x: 220, y: 150, detail: "Resolves the reference over POST /v1/runtime/secrets/resolve using PAL_CREDENTIAL_KEY, which lives only here. The manager never holds the decryption key.", src: [M(`${H}/runtime_secrets.go`, 730)] },
    { id: "other", label: "Other process", sub: "any other uid", tone: "guest", x: 600, y: 150, detail: "Anything else in the VM that tries to connect." },
  ],
  edges: [
    { from: "spec", to: "mgr" },
    { from: "work", to: "sock", bidi: true },
    { from: "sock", to: "mgr", bidi: true },
    { from: "mgr", to: "cp", bidi: true },
    { from: "other", to: "sock", kind: "deny" },
  ],
  scenarios: [
    {
      id: "vend", label: "Vend a secret",
      steps: [
        { title: "A reference is declared", note: "The spec names the secret; the manager carries only the reference into the spawn.", edges: ["spec>mgr"] },
        { title: "The workload asks", note: "At the moment it needs the value, the workload connects to the harness's secrets socket.", edges: ["work>sock"] },
        { title: "The peer is authenticated", note: "The harness reads the kernel-attested uid and vends only to the workload uid the manager injected.", nodes: ["sock"] },
        { title: "Resolved by the control plane", note: "The request goes to the manager and over the relay, where the reference is decrypted.", edges: ["sock>mgr", "mgr>cp"] },
        { title: "A short-lived value returns", note: "The value comes back with a 300-second TTL, so a leaked copy has a small blast radius.", edges: ["cp>mgr", "mgr>sock"] },
      ],
    },
    {
      id: "denied", label: "Denied peer",
      steps: [
        { title: "Another process connects", note: "A process running as a different uid reaches for the same socket.", edges: ["other>sock"], deny: true },
        { title: "SO_PEERCRED says no", note: "Its uid is neither the workload's nor the harness's, so nothing is vended.", nodes: ["sock"], deny: true },
        { title: "The attempt is audited", note: "A secret_access_denied audit event is logged locally before any forward attempt and forwarded to the manager.", edges: ["sock>mgr"] },
      ],
    },
    {
      id: "relay", label: "Relay not configured",
      steps: [
        { title: "A valid peer asks", note: "The workload is authenticated as usual.", edges: ["work>sock", "sock>mgr"] },
        { title: "The relay needs a token", note: "The manager authenticates with X-Lantern-Runtime-Token, set through PAL_RUNTIME_SECRET_TOKEN on both sides.", edges: ["mgr>cp"] },
        { title: "Unset means 403", note: "With the token unset on the control plane the endpoint fails closed with 403 and nothing is vended.", nodes: ["cp"], deny: true },
      ],
    },
  ],
  legend: [["client", "Config"], ["host", "Trusted host code"], ["guest", "Inside the VM"], ["rt", "Control plane"]],
};

// ---------------------------------------------------------------------------
export const ISOLATION_CLASSES: FlowDef = {
  id: "isolation-classes",
  title: "Isolation classes",
  caption: "The spec declares a class; the manager only runs it on a node that can provide it, and refuses rather than weakening it.",
  vb: [980, 350],
  nodes: [
    { id: "spec", label: "agent.yaml", sub: "isolation: class", tone: "client", x: 30, y: 148, detail: "Every headless agent declares a class. Unset resolves to standard." },
    { id: "sched", label: "Scheduler", sub: "places the spawn", tone: "rt", x: 220, y: 148, detail: "Picks a node and hands the spawn to that node's manager." },
    { id: "mgr", label: "Runtime manager", sub: "checks the class", tone: "host", x: 410, y: 148, detail: "Refuses the spawn when the required RuntimeClass is not configured.", src: [M("services/runtime-manager/src/runtimeclass_preflight.rs", 70)] },
    { id: "trusted", label: "trusted", sub: "runc", x: 600, y: 20, detail: "Signed first-party code only, on shared nodes." },
    { id: "standard", label: "standard", sub: "gVisor (default)", x: 600, y: 104, detail: "Your own code on shared, gVisor-isolated nodes." },
    { id: "untrusted", label: "untrusted", sub: "gVisor + egress-deny", x: 600, y: 188, detail: "Internet packages, browsers or LLM-generated code. Adds an egress allowlist and the RuntimeDefault seccomp profile." },
    { id: "hostile", label: "hostile", sub: "Kata microVM", x: 600, y: 272, detail: "Adversarial workloads in a full-kernel microVM on a dedicated node pool." },
    { id: "runs", label: "Workload runs", sub: "inside its class", tone: "guest", x: 790, y: 104, detail: "Spawned behind the declared boundary." },
    { id: "refused", label: "Spawn refused", sub: "never downgraded", x: 790, y: 272, detail: "A node without the hardened RuntimeClass fails closed. The run is never downgraded to runc." },
  ],
  edges: [
    { from: "spec", to: "sched" },
    { from: "sched", to: "mgr" },
    { from: "mgr", to: "trusted" },
    { from: "mgr", to: "standard" },
    { from: "mgr", to: "untrusted" },
    { from: "mgr", to: "hostile" },
    { from: "trusted", to: "runs" },
    { from: "standard", to: "runs" },
    { from: "untrusted", to: "runs" },
    { from: "hostile", to: "refused", kind: "deny" },
  ],
  scenarios: [
    {
      id: "default", label: "Default class",
      steps: [
        { title: "No class declared", note: "The spec leaves isolation unset, which resolves to standard.", edges: ["spec>sched"] },
        { title: "Placed on a node", note: "The scheduler picks a node and the manager takes the spawn.", edges: ["sched>mgr"] },
        { title: "gVisor runs it", note: "Standard maps to the gvisor RuntimeClass on shared nodes.", edges: ["mgr>standard", "standard>runs"] },
      ],
    },
    {
      id: "untrusted", label: "Package loader",
      steps: [
        { title: "Untrusted declared", note: "The agent pulls third-party packages, so its spec says untrusted with an egress allowlist.", edges: ["spec>sched", "sched>mgr"] },
        { title: "The node must advertise gVisor", note: "Only a node with the gvisor RuntimeClass may satisfy untrusted, enforced by the manager and a pod nodeSelector.", edges: ["mgr>untrusted"] },
        { title: "Runs behind two fences", note: "The host NetworkPolicy and the in-VM harness allowlist enforce egress independently.", edges: ["untrusted>runs"] },
      ],
    },
    {
      id: "refused", label: "Hardened runtime missing",
      steps: [
        { title: "Hostile declared", note: "The input is adversarial, so the spec asks for a Kata microVM.", edges: ["spec>sched", "sched>mgr"] },
        { title: "No Kata on the node", note: "The node lacks the kata-qemu or kata-fc RuntimeClass the class requires.", edges: ["mgr>hostile"], deny: true },
        { title: "Refused, not downgraded", note: "The run is rejected; it is never quietly started under runc or a bare pod.", edges: ["hostile>refused"], deny: true },
        { title: "Operationally visible", note: "The data-plane installer provisions the RuntimeClasses and a preflight surfaces the gap before traffic.", nodes: ["mgr"] },
      ],
    },
  ],
  legend: [["client", "Config"], ["rt", "Scheduler"], ["host", "Trusted host code"], ["guest", "Untrusted code"]],
};

// ---------------------------------------------------------------------------
export const INVOCATION_MODES: FlowDef = {
  id: "invocation-modes",
  title: "Invocation modes",
  caption: "Five ways to start the same run. They differ only in how the caller waits; the run itself is identical.",
  vb: [980, 290],
  nodes: [
    { id: "caller", label: "Caller", sub: "SDK · curl · agent", tone: "client", x: 30, y: 20, detail: "An app or another agent holding an API key." },
    { id: "cron", label: "Schedule", sub: "cron expression", tone: "client", x: 30, y: 110, detail: "A schedule starts a run in an IANA timezone." },
    { id: "sender", label: "Signed sender", sub: "HMAC", tone: "client", x: 30, y: 200, detail: "GitHub, Sentry, PagerDuty or any HMAC sender." },
    { id: "a2a", label: "A2A invoke", sub: "waits up to 60 s", tone: "rt", x: 250, y: 20, detail: "Creates the run, waits and returns the output. After 60 s a run that has not succeeded answers 502 with its runId." },
    { id: "create", label: "Create run", sub: "POST /v1/runs", tone: "rt", x: 250, y: 110, detail: "Returns as soon as the run is queued." },
    { id: "hooks", label: "Webhook URL", sub: "/v1/hooks/id", tone: "rt", x: 250, y: 200, detail: "The sender's signature is the only credential; a delivery sent twice starts one run." },
    { id: "run", label: "Run", sub: "budget · journal · tier", tone: "rt", x: 470, y: 110, detail: "Every mode passes the same budget check (402 when a hard cap is reached), the journal, the isolation tier from the manifest, and can have a receipt." },
    { id: "events", label: "GET …/events", sub: "SSE, from event 1", tone: "client", x: 700, y: 20, w: 170, detail: "Replays the journal from the first event and closes when the run is succeeded, failed or cancelled." },
    { id: "poll", label: "GET /v1/runs/id", sub: "poll for status", tone: "client", x: 700, y: 110, w: 170, detail: "Check status and output later." },
    { id: "receipt", label: "Receipt", sub: "signed proof", tone: "client", x: 700, y: 200, w: 170, detail: "Verifiable afterward, whichever mode started the run." },
  ],
  edges: [
    { from: "caller", to: "a2a" },
    { from: "caller", to: "create" },
    { from: "cron", to: "create" },
    { from: "sender", to: "hooks" },
    { from: "a2a", to: "run" },
    { from: "create", to: "run" },
    { from: "hooks", to: "run" },
    { from: "run", to: "events" },
    { from: "run", to: "poll" },
    { from: "run", to: "receipt" },
  ],
  scenarios: [
    {
      id: "sync", label: "Sync",
      steps: [
        { title: "Invoke and wait", note: "The caller posts to the A2A invoke endpoint, which needs the runs:execute scope.", edges: ["caller>a2a"] },
        { title: "The run executes", note: "The same run path as every other mode.", edges: ["a2a>run"] },
        { title: "The output is the response", note: "On success the response carries the output. Past 60 s it answers 502 with the runId so you can keep following it.", nodes: ["a2a"] },
      ],
    },
    {
      id: "stream", label: "Stream",
      steps: [
        { title: "Create the run", note: "POST /v1/runs queues it and returns an id.", edges: ["caller>create", "create>run"] },
        { title: "Subscribe to its events", note: "The SSE stream replays the journal from the first event, so a late subscriber misses nothing.", edges: ["run>events"] },
        { title: "The stream ends with the run", note: "It closes on succeeded, failed or cancelled.", nodes: ["events"] },
      ],
    },
    {
      id: "async", label: "Async",
      steps: [
        { title: "Fire and get an id", note: "The call returns as soon as the run is queued.", edges: ["caller>create", "create>run"] },
        { title: "Check later", note: "Poll the run, or subscribe to events when convenient.", edges: ["run>poll"] },
        { title: "A restart loses nothing", note: "The recovery sweep re-drives it every 30 seconds from its journal, skipping steps already completed.", nodes: ["run"] },
      ],
    },
    {
      id: "cron", label: "Cron",
      steps: [
        { title: "A schedule comes due", note: "The caller does nothing; the scheduler starts the run on the cron expression.", edges: ["cron>create"] },
        { title: "The same run path", note: "Scheduled runs appear in the console like any other run.", edges: ["create>run"] },
        { title: "Over budget: no fire", note: "An agent past its hard-fail budget does not fire.", nodes: ["run"], deny: true },
      ],
    },
    {
      id: "webhook", label: "Webhook",
      steps: [
        { title: "A signed event arrives", note: "The sender posts to the agent's public URL; its signature is the only credential.", edges: ["sender>hooks"] },
        { title: "A run starts", note: "A verified, non-duplicate delivery creates a run and the sender gets 202 with the run id.", edges: ["hooks>run"] },
        { title: "Receipt afterward", note: "Whatever started it, a receipt can be issued for the run.", edges: ["run>receipt"] },
      ],
    },
  ],
  legend: [["client", "Callers and outputs"], ["rt", "Control plane"]],
};

// ---------------------------------------------------------------------------
export const ONBOARDING_FLOW: FlowDef = {
  id: "onboarding-flow",
  title: "Agentic onboarding",
  caption: "The console /onboarding page and pal onboard share one flow; every step advances only on a real 2xx or a terminal status.",
  vb: [980, 250],
  nodes: [
    { id: "goal", label: "Goal", sub: "in your words", tone: "client", x: 30, y: 30, detail: "You describe what the agent should do." },
    { id: "spec", label: "generate-spec", sub: "LLM designs it", tone: "rt", x: 220, y: 30, detail: "Returns the parsed spec object through the failover and router seam with model auto. Typed errors: 400 no_provider, 502 bad_spec or llm_failed.", src: [M(`${H}/llm_proxy.go`, 2696)] },
    { id: "approve", label: "Approve or edit", sub: "you decide", tone: "client", x: 410, y: 30, detail: "Nothing is created until you accept the design." },
    { id: "test", label: "Provider test", sub: "real test call", tone: "rt", x: 600, y: 30, detail: "A live call to the provider with your key; the flow does not move on without a 2xx.", src: [M(`${CP}/cmd/server/main.go`, 609)] },
    { id: "create", label: "Create agent", sub: "POST /v1/agents", tone: "rt", x: 790, y: 30, detail: "The agent is created from the approved spec." },
    { id: "state", label: "Resume state", sub: "tenant settings", tone: "store", x: 30, y: 150, detail: "Progress is stored server-side per tenant as a whitelisted struct, so a key can never be persisted.", src: [M(`${H}/onboarding.go`, 49)] },
    { id: "next", label: "Next steps", sub: "what to try", tone: "client", x: 410, y: 150, detail: "Where to go from a working agent." },
    { id: "sandbox", label: "Sandbox run", sub: "optional", tone: "guest", x: 600, y: 150, detail: "Schedules a microVM and execs in it. Reported as unavailable when only the stub scheduler is present." },
    { id: "run", label: "First run", sub: "streamed over SSE", tone: "rt", x: 790, y: 150, detail: "The first run is streamed live until it reaches a terminal status." },
  ],
  edges: [
    { from: "goal", to: "spec" },
    { from: "spec", to: "approve" },
    { from: "approve", to: "test" },
    { from: "test", to: "create" },
    { from: "create", to: "run" },
    { from: "run", to: "sandbox" },
    { from: "sandbox", to: "next" },
    { from: "goal", to: "state", kind: "store" },
    { from: "state", to: "approve", dashed: true },
  ],
  scenarios: [
    {
      id: "happy", label: "Happy path",
      steps: [
        { title: "State the goal", note: "A sentence about what the agent should do is enough to start.", edges: ["goal>spec"] },
        { title: "A spec is designed", note: "The LLM returns a name, system prompt, first input and rationale, with grounded defaults.", nodes: ["spec"] },
        { title: "You approve or edit", note: "The design is shown for review before anything is created.", edges: ["spec>approve"] },
        { title: "The provider key is tested", note: "A real call proves the key works before the agent is created.", edges: ["approve>test"] },
        { title: "Agent created, first run streamed", note: "The run's events stream over SSE until a terminal status.", edges: ["test>create", "create>run"] },
        { title: "Optional sandbox run", note: "A sandbox run follows, then next steps.", edges: ["run>sandbox", "sandbox>next"] },
      ],
    },
    {
      id: "badkey", label: "Provider test fails",
      steps: [
        { title: "The design is approved", note: "Everything up to here worked.", edges: ["approve>test"] },
        { title: "The test call fails", note: "A bad or missing key is not a 2xx, so the flow stops here instead of creating a broken agent.", nodes: ["test"], deny: true },
        { title: "An error maps to a fix", note: "A pure error-to-fix mapping tells you what to change, such as adding a provider key.", nodes: ["test", "approve"] },
      ],
    },
    {
      id: "sandbox", label: "Sandbox unavailable",
      steps: [
        { title: "The first run finishes", note: "It reached a terminal status.", edges: ["create>run"] },
        { title: "The sandbox step is attempted", note: "It schedules a microVM and runs a command in it.", edges: ["run>sandbox"] },
        { title: "Reported honestly", note: "On the stub scheduler it is reported as unavailable, never faked, and onboarding carries on.", nodes: ["sandbox"], deny: true },
        { title: "Next steps", note: "The flow ends with suggestions for what to do next.", edges: ["sandbox>next"] },
      ],
    },
    {
      id: "resume", label: "Resume later",
      steps: [
        { title: "Progress is saved", note: "Each milestone is written to server-side state for your tenant.", edges: ["goal>state"] },
        { title: "You come back", note: "The page derives the step to resume from recorded facts rather than trusting a stored pointer.", edges: ["state>approve"] },
        { title: "The provider is re-verified", note: "The key is tested again every session before you continue.", nodes: ["test"] },
      ],
    },
  ],
  legend: [["client", "You"], ["rt", "Control plane"], ["guest", "Sandbox"], ["store", "Data stores"]],
};
