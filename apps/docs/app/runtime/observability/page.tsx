import Link from "next/link";
import { Diagram } from "../../_components/Diagram";

export default function RuntimeObservabilityPage() {
  return (
    <>
      <h1>Observability</h1>
      <p>
        One OTel trace per spawn, GenAI token telemetry, real-time anomaly detection — wired through standard OpenTelemetry.
      </p>

      <Diagram
        name="observability-flow"
        caption="Every signal — OTel span, metric, journal row, health probe, receipt — speaks the same identifiers, so nothing needs correlation glue."
      />

      <h2 id="trace">One trace per spawn</h2>
      <p>
        Every run opens a single OTel trace. Spans from every entry point use
        the same attribute keys, defined in{" "}
        <code>internal/middleware/span.go</code> and stamped by a single{" "}
        <code>EnrichSpan</code> helper so they never drift between HTTP and gRPC
        code paths:
      </p>
      <pre><code>{`lantern.tenant_id   # on every span, both tiers
lantern.user_id
lantern.run_id
lantern.step_id     # per-step spans in the inline executor`}</code></pre>
      <p>
        On the <strong>microVM tier</strong> the manager and harness additionally
        stamp <code>vm_id</code>, <code>isolation_class</code>, and{" "}
        <code>agent_instance_id</code> (the per-spawn Ed25519 identity — see{" "}
        <Link href="/runtime/identity">Identity &amp; secrets</Link>). A{" "}
        <Link href="/runtime/durable-execution">durable resume</Link> after a
        crash re-joins the same <code>trace_id</code> — the full lifecycle is
        one coherent timeline.
      </p>

      {/* Trace spine — simplified flat list */}
      <div style={{
        background: "#0d0d12",
        border: "1px solid #1e2235",
        borderRadius: "12px",
        padding: "1.25rem 1.5rem",
        marginBottom: "1.5rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
      }}>
        <div style={{ color: "#71717a", marginBottom: "0.85rem", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Trace spine
        </div>
        {[
          { label: "gateway.request", sub: "tenant_id", color: "#38bdf8", indent: 0 },
          { label: "control-plane: run dispatch", sub: "run_id", color: "#f59e0b", indent: 1 },
          { label: "model-router: route", sub: "step_id · model_used · tokens · cost_usd", color: "#8b5cf6", indent: 2 },
          { label: "runtime-manager: spawn", sub: "vm_id · image · isolation_class", color: "#f59e0b", indent: 3 },
          { label: "harness: step loop", sub: "step_id · tool_calls · reasoning_tokens · cache_tokens", color: "#34d399", indent: 4 },
        ].map((layer, i) => (
          <div key={i} style={{
            marginLeft: `${layer.indent * 1.1}rem`,
            marginBottom: "0.35rem",
            borderLeft: `2px solid ${layer.color}`,
            paddingLeft: "0.6rem",
            paddingTop: "0.2rem",
            paddingBottom: "0.2rem",
          }}>
            <span style={{ color: layer.color, fontWeight: 600 }}>{layer.label}</span>
            <span style={{ color: "#52525b", marginLeft: "0.5rem", fontSize: "0.65rem" }}>{layer.sub}</span>
          </div>
        ))}
        <div style={{ marginTop: "0.75rem", color: "#52525b", fontSize: "0.65rem" }}>
          W3C traceparent propagated at every boundary · durable resume re-joins the same trace_id
        </div>
      </div>

      <h2 id="enable">Enabling OTel</h2>
      <p>Export is env-gated. Set the endpoint and traces flow; leave it unset and tracing is a no-op (zero overhead):</p>
      <pre><code>{`OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
# or
LANTERN_OTEL_ENABLED=1   # uses default localhost endpoint`}</code></pre>
      <div className="callout callout-info">
        <strong>W3C traceparent is always active.</strong> Inbound trace context is forwarded correctly even without an exporter configured.
      </div>

      <h2 id="semconv">GenAI semantic conventions</h2>
      <p>
        LLM steps are annotated with OTel GenAI semantic-convention attributes — including <strong>reasoning tokens</strong> and <strong>cache tokens</strong>, not just plain input/output counts. Per-step cost attribution and model-usage breakdowns work out of the box with any OTel-compatible backend.
      </p>

      <h2 id="span-attrs">OTel span attribute contract</h2>
      <p>
        Every span emitted anywhere in the stack uses these keys, set via{" "}
        <code>internal/middleware.EnrichSpan</code>. They are no-ops when
        telemetry is disabled.
      </p>
      <table>
        <thead>
          <tr><th>Attribute</th><th>Key</th><th>Set by</th></tr>
        </thead>
        <tbody>
          <tr><td>Tenant</td><td><code>lantern.tenant_id</code></td><td>HTTP enrichment middleware + gRPC tracing interceptor</td></tr>
          <tr><td>User</td><td><code>lantern.user_id</code></td><td>Same</td></tr>
          <tr><td>Run</td><td><code>lantern.run_id</code></td><td>Same + inline executor</td></tr>
          <tr><td>Step</td><td><code>lantern.step_id</code></td><td>Inline executor per step</td></tr>
          <tr><td>Agent name</td><td><code>lantern.agent_name</code></td><td>Inline executor + model-router</td></tr>
          <tr><td>VM ID (microVM)</td><td><code>vm_id</code></td><td>Scheduler / manager spans</td></tr>
          <tr><td>Isolation class (microVM)</td><td><code>isolation_class</code></td><td>Manager spans</td></tr>
          <tr><td>Agent version (microVM)</td><td><code>agent_version</code></td><td>Manager spans</td></tr>
          <tr><td>Model used</td><td><code>model_used</code></td><td>Model-router completion span</td></tr>
          <tr><td>Cost USD</td><td><code>cost_usd</code></td><td>Model-router completion span</td></tr>
          <tr><td>Tokens in / out</td><td><code>tokens_in</code> / <code>tokens_out</code></td><td>Model-router completion span</td></tr>
        </tbody>
      </table>

      <h2 id="otel-metrics">The five <code>lantern.run.*</code> metrics</h2>
      <p>
        The inline executor emits five OTel metric instruments via the{" "}
        <code>lantern.runtime</code> meter (
        <code>internal/middleware/metrics.go</code>). They are no-ops when the
        global <code>MeterProvider</code> is unset (the default no-op provider
        is safe to import with zero overhead).
      </p>
      <table>
        <thead>
          <tr><th>Instrument</th><th>Type</th><th>Attributes</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>lantern.run.step.duration</code></td>
            <td>Histogram (ms)</td>
            <td><code>agent_name</code>, <code>node_type</code>, <code>tier</code>, <code>outcome</code></td>
            <td>Wall-clock duration of one workflow step, including all retry backoff. <code>outcome</code> is <code>ok</code>, <code>failed</code>, or <code>retried</code>.</td>
          </tr>
          <tr>
            <td><code>lantern.run.step.retries</code></td>
            <td>Counter</td>
            <td><code>agent_name</code>, <code>node_type</code>, <code>tier</code></td>
            <td>Extra attempts beyond the first. Only incremented when <code>retryCount &gt; 0</code>.</td>
          </tr>
          <tr>
            <td><code>lantern.run.replay.skips</code></td>
            <td>Counter</td>
            <td><code>agent_name</code></td>
            <td><code>CompletedStep</code> cache hits during crash-resume. Each hit means one node was skipped rather than re-executed.</td>
          </tr>
          <tr>
            <td><code>lantern.run.budget.blocks</code></td>
            <td>Counter</td>
            <td><code>agent_name</code></td>
            <td>Runs denied by the agent&apos;s hard-fail budget policy (HTTP 402).</td>
          </tr>
          <tr>
            <td><code>lantern.run.total</code></td>
            <td>Counter</td>
            <td><code>agent_name</code>, <code>tier</code>, <code>status</code></td>
            <td>Total runs dispatched through the inline executor. <code>tier</code> is <code>shared</code> or <code>microvm</code>; <code>status</code> is <code>succeeded</code> or <code>failed</code>.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="anomaly">Real-time anomaly detection</h2>
      <p>
        The runtime watches the live event stream for pathological shapes — a tool-call loop, a step retrying without progress — and surfaces them in real time. This is the early-warning layer for runaway runs.
      </p>

      <h2 id="health">Peer-service health sweep</h2>
      <p>
        A background loop in the control-plane TCP-probes its peer services
        every 60 s (<code>LANTERN_HEALTH_SWEEP_INTERVAL</code>; set{" "}
        <code>"0"</code> or <code>"off"</code> to disable). After 3 consecutive
        failures it declares a peer <strong>DOWN</strong> and sends one
        self-chat alert. It sends one more when the peer recovers. No alert
        storms — only state transitions fire notifications.
      </p>
      <p>Services probed when their address env var is set:</p>
      <ul>
        <li><code>model-router</code> — <code>LANTERN_MODEL_ROUTER_ADDR</code> (only when <code>LANTERN_USE_MODEL_ROUTER=1</code> or addr is non-default)</li>
        <li><code>runtime-scheduler</code> — <code>LANTERN_SCHEDULER_GRPC_ADDR</code></li>
        <li><code>runtime-manager</code> — <code>LANTERN_DEFAULT_MANAGER_ADDR</code></li>
        <li><code>workflow-engine</code> — <code>LANTERN_WORKFLOW_ENGINE_ADDR</code> (optional)</li>
      </ul>
      <p>Read the current snapshot:</p>
      <pre><code>{`GET /v1/system/health    # JWT-authed`}</code></pre>
      <pre><code>{`{
  "services": [
    {
      "name": "runtime-manager",
      "addr": "localhost:50054",
      "up": false,
      "consecutiveFailures": 5,
      "lastChecked": "2026-07-23T10:00:00Z",
      "lastTransition": "2026-07-23T09:57:00Z"
    }
  ]
}`}</code></pre>

      <h2 id="metrics">Metrics endpoint</h2>
      <p>Per-VM live stats for the caller&apos;s tenant:</p>
      <pre><code>{`GET /v1/runtime/metrics`}</code></pre>
      <p>
        Returns a <code>vmMetricsDTO</code> array with <code>vmId</code>, <code>state</code>, <code>node</code>, <code>az</code>, <code>isolationClass</code>, <code>promMetrics</code> (raw Prometheus text from the harness), and timestamps. Per-instance detail: <code>GET /v1/runtime/vms/{"{id}"}</code>. Live log stream: <code>GET /v1/runtime/vms/{"{id}"}/logs</code> (SSE). The <a href="http://localhost:3001/runtime" target="_blank" rel="noopener noreferrer">dashboard runtime page</a> renders all three.
      </p>

      <h2 id="data-path">Gateway and model-router traces</h2>
      <p>
        The <strong>gateway</strong> emits one span per HTTP request (<code>gateway.request</code>, tagged with <code>tenant_id</code>) via OTLP/HTTP. The <strong>model-router</strong> emits one span per routing call tagged with <code>tenant_id</code>, <code>run_id</code>, <code>step_id</code>, <code>model_used</code>, <code>tokens_in/out</code>, <code>cost_usd</code>, and <code>escalated</code> via OTLP/gRPC. Both honour inbound W3C <code>traceparent</code>, so spans join the caller&apos;s distributed trace automatically.
      </p>
      <div className="callout callout-warning">
        <strong>No Prometheus histograms yet for gateway / model-router.</strong> Latency SLOs live in your tracing backend (Tempo / Jaeger / Honeycomb). Alert rules that would cover p99 latency are parked in the <code>lantern-TODO-needs-instrumentation</code> group in <code>infra/monitoring/prometheus/alerts.yml</code> until the histogram metric ships.
      </div>

      <h2 id="alerts">Prometheus alerts, dashboards, runbooks</h2>
      <p>Production monitoring artifacts live in <code>infra/monitoring/</code>:</p>
      <table>
        <thead><tr><th>Group</th><th>Alerts</th><th>Source</th></tr></thead>
        <tbody>
          <tr>
            <td><code>lantern-scheduler</code></td>
            <td>SchedulerDown · SchedulerNoLeader · SchedulerScheduleErrorRateHigh · SchedulerQuotaRejectionSurge · SchedulerNoRegisteredNodes</td>
            <td>runtime-scheduler <code>:8085/metrics</code></td>
          </tr>
          <tr>
            <td><code>lantern-liveness</code></td>
            <td>ControlPlaneDown · ControlPlaneNotReady · GatewayDown · ModelRouterDown</td>
            <td><code>up</code> scrape + blackbox <code>/readyz</code></td>
          </tr>
          <tr>
            <td><code>lantern-postgres</code></td>
            <td>PostgresExporterDown · PostgresConnectionSaturation · DataPlaneHeartbeatStale · CronScheduleOverdue</td>
            <td>postgres_exporter + custom queries</td>
          </tr>
        </tbody>
      </table>

      <p>Eight operator runbooks cover every active alert plus the DB restore procedure, linked from each alert&apos;s <code>runbook:</code> annotation in <code>alerts.yml</code>. Grafana dashboards: <code>grafana/platform-overview.json</code> and <code>grafana/data-plane-runtime.json</code>.</p>
    </>
  );
}
