export default function RuntimeObservabilityPage() {
  return (
    <>
      <h1>Observability</h1>
      <p>
        A headless agent you can&apos;t see is a headless agent you can&apos;t
        operate. The runtime emits <strong>one OTel trace per spawn</strong>,
        with GenAI semantic-convention attributes for token and cost telemetry,
        plus aggregate counters at a metrics endpoint. Observability is wired
        through standard OpenTelemetry, so it lands in whatever collector you
        already run.
      </p>

      <h2 id="trace">One trace per spawn</h2>
      <p>
        Each spawn opens a single trace and correlates every span, log line, and
        audit event under one tuple:
      </p>
      <pre><code>{`(tenant_id, run_id, step_id, agent_instance_id, trace_id)`}</code></pre>
      <p>
        <code>agent_instance_id</code> is the per-spawn identity (see{" "}
        <a href="/runtime/identity">Identity &amp; secrets</a>), so two runs of
        the same agent never collide in your traces. A{" "}
        <a href="/runtime/durable-execution">durable resume</a> after a crash is
        correlated back to the same run, so the full lifecycle is one coherent
        timeline.
      </p>

      <h2 id="enable">Enabling OTel</h2>
      <p>
        Export is <strong>env-gated</strong>. Set the standard OTLP endpoint and
        traces flow; leave it unset and tracing is a no-op (zero overhead, no
        dropped-export errors):
      </p>
      <pre><code>{`OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317`}</code></pre>
      <div className="callout callout-info">
        <strong>Note:</strong> When <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> is
        unset the exporter is a no-op — the service runs identically, it just
        doesn&apos;t ship spans. Point it at any OTLP-compatible collector
        (Tempo, Honeycomb, Datadog, the OTel Collector) to start receiving
        traces.
      </div>

      <h2 id="semconv">GenAI semantic conventions</h2>
      <p>
        LLM steps are annotated with OpenTelemetry GenAI semantic-convention
        attributes, so token and cost data is queryable with standard tooling —
        including <strong>reasoning tokens</strong> and{" "}
        <strong>cache tokens</strong>, not just the plain input/output counts.
        That makes per-step cost attribution and model-usage breakdowns work out
        of the box.
      </p>

      <h2 id="anomaly">Real-time loop &amp; retry anomaly detection</h2>
      <p>
        The runtime watches the live event stream for pathological shapes — an
        agent stuck in a tool-call loop, or a step retrying without making
        progress — and surfaces them in real time rather than after the bill
        arrives. This is the early-warning layer for runaway runs.
      </p>

      <h2 id="metrics">Metrics endpoint</h2>
      <p>
        Aggregate runtime counters (spawns, states, durations, cost rollups) are
        exposed for scraping:
      </p>
      <pre><code>{`GET /v1/runtime/metrics`}</code></pre>
      <p>
        Per-instance detail and recent audit events are at{" "}
        <code>GET /v1/runtime/vms/&#123;id&#125;</code>, and the live log stream
        is <code>GET /v1/runtime/vms/&#123;id&#125;/logs</code> (SSE). The{" "}
        <a href="http://localhost:3001/runtime" target="_blank" rel="noopener noreferrer">dashboard runtime page</a>{" "}
        renders all three.
      </p>

      <h2 id="takeaway">What you get</h2>
      <ul>
        <li><strong>One trace per spawn</strong>, correlated by tenant / run / step / instance / trace id.</li>
        <li><strong>GenAI token + cost telemetry</strong>, including reasoning and cache tokens.</li>
        <li><strong>Real-time anomaly signals</strong> for loops and stalled retries.</li>
        <li><strong>Standard OTLP export</strong>, env-gated to a no-op when unconfigured.</li>
      </ul>
    </>
  );
}
