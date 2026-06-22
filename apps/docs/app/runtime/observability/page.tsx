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
      <p>
        Alternatively, set <code>LANTERN_OTEL_ENABLED=1</code> to activate
        export with the default localhost endpoint.
      </p>
      <div className="callout callout-info">
        <strong>Note:</strong> When neither var is set the exporter is a no-op
        — the service runs identically, it just doesn&apos;t ship spans. W3C{" "}
        <code>traceparent</code> propagation is always installed so inbound
        trace context is forwarded correctly even without an exporter.
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
        Per-VM live stats for the caller&apos;s tenant are returned as a JSON
        array by:
      </p>
      <pre><code>{`GET /v1/runtime/metrics`}</code></pre>
      <p>
        Each element is a <code>vmMetricsDTO</code> object with fields:{" "}
        <code>vmId</code>, <code>state</code>, <code>node</code>,{" "}
        <code>az</code>, <code>isolationClass</code>, <code>createdAt</code>,{" "}
        <code>terminatedAt</code>, <code>lastAuditAction</code>,{" "}
        <code>lastAuditAt</code>, <code>promMetrics</code> (raw Prometheus
        exposition text forwarded by the harness, empty until received), and{" "}
        <code>promReceivedAt</code>. Per-instance detail and recent audit events
        are at <code>GET /v1/runtime/vms/&#123;id&#125;</code>, and the live log
        stream is <code>GET /v1/runtime/vms/&#123;id&#125;/logs</code> (SSE).
        The{" "}
        <a href="http://localhost:3001/runtime" target="_blank" rel="noopener noreferrer">dashboard runtime page</a>{" "}
        renders all three.
      </p>

      <h2 id="data-path">Data-path tracing: gateway and model-router</h2>
      <p>
        In addition to the per-spawn runtime traces, the <strong>gateway</strong>{" "}
        and <strong>model-router</strong> now emit their own OTLP traces that
        cover the API hot path — request auth, rate limiting, and model dispatch
        — and join inbound distributed traces automatically.
      </p>

      <h3>Gateway (<code>lantern-gateway</code>)</h3>
      <ul>
        <li>
          One span per HTTP request (<code>gateway.request</code>) tagged with{" "}
          <code>tenant_id</code> (populated after auth).
        </li>
        <li>
          Honours inbound W3C <code>traceparent</code> headers — the gateway
          span becomes a child of the upstream span, so SDK requests,
          dashboard calls, and browser clients all join the same distributed
          trace.
        </li>
        <li>
          Exporter: <strong>OTLP/HTTP</strong>. Endpoint:{" "}
          <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> (default{" "}
          <code>http://localhost:4318</code> when <code>LANTERN_OTEL_ENABLED=1</code>).
        </li>
      </ul>

      <h3>Model-router (<code>lantern-model-router</code>)</h3>
      <ul>
        <li>
          One span per routing call tagged with <code>tenant_id</code>,{" "}
          <code>run_id</code>, <code>step_id</code>, plus outcome attributes:{" "}
          <code>model_used</code>, <code>tokens_in</code>,{" "}
          <code>tokens_out</code>, <code>cost_usd</code>, <code>escalated</code>.
        </li>
        <li>
          Honours inbound gRPC <code>traceparent</code> metadata — model-router
          spans are children of the control-plane call, keeping the full
          call graph in one trace.
        </li>
        <li>
          Exporter: <strong>OTLP/gRPC</strong>. Endpoint:{" "}
          <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> (default{" "}
          <code>http://localhost:4317</code> when <code>LANTERN_OTEL_ENABLED=1</code>).
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>No Prometheus histograms yet.</strong> Gateway and model-router
        emit OTel <em>traces</em> only. Latency SLOs for these services live in
        your tracing backend (Tempo / Jaeger / Honeycomb), not in Prometheus.
        The alert rules that would cover p99 latency are parked in the{" "}
        <code>lantern-TODO-needs-instrumentation</code> group in{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/infra/monitoring/prometheus/alerts.yml">
          <code>infra/monitoring/prometheus/alerts.yml</code>
        </a>{" "}
        until the histogram metric ships.
      </div>

      <h2 id="alerts">Prometheus alerts, Grafana dashboards, and runbooks</h2>
      <p>
        Production monitoring artifacts live in{" "}
        <code>infra/monitoring/</code>:
      </p>
      <ul>
        <li>
          <a href="https://github.com/dshakes/lantern/blob/master/infra/monitoring/prometheus/alerts.yml">
            <code>infra/monitoring/prometheus/alerts.yml</code>
          </a>{" "}
          — 13 alert rules in 3 groups. Drop into a{" "}
          <code>PrometheusRule</code> CR (add the <code>spec:</code> envelope)
          or load via Prometheus <code>rule_files:</code>.
        </li>
        <li>
          <a href="https://github.com/dshakes/lantern/blob/master/infra/monitoring/grafana/platform-overview.json">
            <code>infra/monitoring/grafana/platform-overview.json</code>
          </a>{" "}
          — platform-level dashboard.
        </li>
        <li>
          <a href="https://github.com/dshakes/lantern/blob/master/infra/monitoring/grafana/data-plane-runtime.json">
            <code>infra/monitoring/grafana/data-plane-runtime.json</code>
          </a>{" "}
          — data-plane and runtime dashboard.
        </li>
      </ul>

      <h3>Alert groups</h3>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th>Alerts (active)</th>
              <th>Signal source</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>lantern-scheduler</code></td>
              <td>SchedulerDown · SchedulerNoLeader · SchedulerScheduleErrorRateHigh · SchedulerQuotaRejectionSurge · SchedulerNoRegisteredNodes</td>
              <td>runtime-scheduler <code>:8085/metrics</code> (real counters/gauges)</td>
            </tr>
            <tr>
              <td><code>lantern-liveness</code></td>
              <td>ControlPlaneDown · ControlPlaneNotReady · GatewayDown · ModelRouterDown</td>
              <td><code>up</code> scrape + blackbox <code>/readyz</code> probe</td>
            </tr>
            <tr>
              <td><code>lantern-postgres</code></td>
              <td>PostgresExporterDown · PostgresConnectionSaturation · DataPlaneHeartbeatStale · CronScheduleOverdue</td>
              <td>postgres_exporter standard metrics + custom queries (<code>infra/monitoring/prometheus/postgres-exporter-queries.yaml</code>)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="callout callout-warning">
        <strong>Several SLO alerts are not yet active.</strong> Rules for
        control-plane 5xx rate, run failure rate, API budget 402 surge, and
        gateway/model-router p99 latency are commented out in{" "}
        <code>alerts.yml</code> (group{" "}
        <code>lantern-TODO-needs-instrumentation</code>) because the backing
        metrics are not emitted yet. Do not uncomment them until the metric
        ships — a rule over a non-existent series is silently always-green.
        Each commented rule names the metric to add and the file that should
        emit it.
      </div>

      <h3>Operator runbooks</h3>
      <p>
        Each alert&apos;s <code>runbook:</code> annotation links to a file in{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/README.md">
          <code>docs/runbooks/</code>
        </a>
        . Eight runbooks cover every active alert plus the DB restore
        (DR) procedure:
      </p>
      <ul>
        <li><a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/control-plane-5xx.md"><code>control-plane-5xx.md</code></a> — control-plane down / not-ready</li>
        <li><a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/run-failure-spike.md"><code>run-failure-spike.md</code></a> — spike in failed runs</li>
        <li><a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/budget-402-surge.md"><code>budget-402-surge.md</code></a> — budget / runtime-quota 402 surge</li>
        <li><a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/data-plane-disconnected.md"><code>data-plane-disconnected.md</code></a> — data-plane heartbeat stale / no registered nodes</li>
        <li><a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/db-saturation.md"><code>db-saturation.md</code></a> — Postgres connection saturation</li>
        <li><a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/scheduler-not-firing.md"><code>scheduler-not-firing.md</code></a> — runtime placement + cron stalled</li>
        <li><a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/gateway-latency.md"><code>gateway-latency.md</code></a> — gateway / model-router down or slow</li>
        <li><a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/db-restore.md"><code>db-restore.md</code></a> — Postgres backup &amp; restore (PITR / logical dump)</li>
      </ul>

      <h2 id="takeaway">What you get</h2>
      <ul>
        <li><strong>One trace per spawn</strong>, correlated by tenant / run / step / instance / trace id.</li>
        <li><strong>GenAI token + cost telemetry</strong>, including reasoning and cache tokens.</li>
        <li><strong>Real-time anomaly signals</strong> for loops and stalled retries.</li>
        <li><strong>Data-path traces</strong> from gateway (<code>tenant_id</code>) and model-router (<code>tenant_id / run_id / step_id / model_used</code>), joining the same distributed trace.</li>
        <li><strong>Standard OTLP export</strong>, env-gated to a no-op when unconfigured. W3C <code>traceparent</code> propagation always active.</li>
        <li><strong>13 Prometheus alert rules</strong>, 2 Grafana dashboards, and 8 operator runbooks in <code>infra/monitoring/</code> and <code>docs/runbooks/</code>.</li>
      </ul>
    </>
  );
}
