import Link from "next/link";

export default function RuntimeObservabilityPage() {
  return (
    <>
      <h1>Observability</h1>
      <p>
        One OTel trace per spawn, GenAI token telemetry, real-time anomaly detection — wired through standard OpenTelemetry.
      </p>

      <h2 id="trace">One trace per spawn</h2>
      <p>
        Every spawn opens a single trace correlated under:
      </p>
      <pre><code>{`(tenant_id, run_id, step_id, agent_instance_id, trace_id)`}</code></pre>
      <p>
        <code>agent_instance_id</code> is the per-spawn identity (see <Link href="/runtime/identity">Identity &amp; secrets</Link>), so two runs of the same agent never collide. A <Link href="/runtime/durable-execution">durable resume</Link> after a crash re-joins the same <code>trace_id</code> — the full lifecycle is one coherent timeline.
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

      <h2 id="anomaly">Real-time anomaly detection</h2>
      <p>
        The runtime watches the live event stream for pathological shapes — a tool-call loop, a step retrying without progress — and surfaces them in real time. This is the early-warning layer for runaway runs.
      </p>

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
