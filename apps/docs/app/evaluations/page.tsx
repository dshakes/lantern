export default function EvaluationsPage() {
  return (
    <>
      <h1>Evaluations &amp; Observability</h1>
      <p>
        The Evaluations dashboard gives you a complete picture of how your
        agents are performing in production. Track success rates, cost
        attribution, latency, and model usage -- all from a single page in the
        dashboard.
      </p>

      <h2 id="metrics">Agent performance metrics</h2>
      <p>
        The Evaluations page (accessible from the dashboard sidebar under{" "}
        <strong>Evaluations</strong>) displays key metrics for each agent:
      </p>
      <ul>
        <li>
          <strong>Success rate</strong> -- percentage of runs that completed
          without errors, tracked over time with trend indicators
        </li>
        <li>
          <strong>Latency percentiles</strong> -- p50, p95, and p99 response
          times for agent runs, broken down by step type (LLM call, tool
          execution, connector request)
        </li>
        <li>
          <strong>Throughput</strong> -- runs per hour/day/week with historical
          comparison
        </li>
        <li>
          <strong>Error breakdown</strong> -- categorized failure reasons
          (model timeout, connector failure, guardrail block, user abort)
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> Metrics are computed from the{" "}
        <code>runs</code> and <code>journal_events</code> tables. Every run
        automatically records cost, token counts, and timing -- no extra
        instrumentation required.
      </div>

      <h2 id="cost">Cost attribution</h2>
      <p>
        Lantern tracks cost at every level of granularity:
      </p>
      <ul>
        <li>
          <strong>Per-run cost</strong> -- total USD spent on LLM tokens,
          connector API calls, and compute for each run
        </li>
        <li>
          <strong>Per-agent cost</strong> -- aggregated spend across all runs
          for an agent, with daily/weekly/monthly rollups
        </li>
        <li>
          <strong>Per-model cost</strong> -- breakdown of spend by model
          provider and model tier (e.g., how much went to Claude Opus vs.
          GPT-4o-mini)
        </li>
        <li>
          <strong>Per-tenant cost</strong> -- total platform spend for billing
          and chargeback
        </li>
      </ul>
      <p>
        Cost data flows from the model router (which records token counts and
        pricing) and the billing service (which aggregates and attributes).
      </p>

      <h2 id="model-usage">Model usage tracking</h2>
      <p>
        The model usage panel shows which models your agents are actually
        using after routing:
      </p>
      <ul>
        <li>
          <strong>Model distribution</strong> -- pie chart of requests by
          concrete model (Claude 3.5 Sonnet, GPT-4o, Gemini Pro, etc.)
        </li>
        <li>
          <strong>Routing decisions</strong> -- how the model router resolved
          capability requests (e.g., <code>reasoning-large</code> mapped to
          Claude Opus 72% of the time and GPT-4o 28% of the time)
        </li>
        <li>
          <strong>Token consumption</strong> -- input and output tokens per
          model, per agent, per time period
        </li>
        <li>
          <strong>Strategy effectiveness</strong> -- compare outcomes across
          the four routing strategies (<code>balanced</code>,{" "}
          <code>cheap</code>, <code>quality</code>, <code>fast</code>) to
          find the optimal setting for each agent
        </li>
      </ul>

      <h2 id="quality">Quality signals</h2>
      <p>
        Beyond raw metrics, Lantern surfaces quality signals that help you
        understand whether your agents are doing the right thing:
      </p>
      <ul>
        <li>
          <strong>Session satisfaction</strong> -- for interactive sessions,
          track whether users continue the conversation (engaged) or abandon
          it (dissatisfied)
        </li>
        <li>
          <strong>Guardrail triggers</strong> -- how often guardrails fire,
          which rules trigger most, and whether blocked outputs indicate a
          prompt issue
        </li>
        <li>
          <strong>Retry rate</strong> -- how often steps need to be retried
          due to transient failures, and which connectors or models are least
          reliable
        </li>
        <li>
          <strong>Version comparison</strong> -- compare metrics between
          agent versions to validate that changes improve (or at least do
          not degrade) performance
        </li>
      </ul>

      <div className="callout callout-tip">
        <strong>Tip:</strong> Use version comparison before promoting a new
        agent version to production. Deploy the new version to a staging
        environment, run a batch of test inputs, and compare the evaluation
        metrics side by side.
      </div>

      <h2 id="alerts">Setting up alerts (future)</h2>
      <p>
        Alert configuration is on the roadmap. Planned capabilities include:
      </p>
      <ul>
        <li>
          <strong>Success rate threshold</strong> -- alert when an
          agent&apos;s success rate drops below a configurable percentage
        </li>
        <li>
          <strong>Cost spike</strong> -- alert when per-run or per-day cost
          exceeds a threshold
        </li>
        <li>
          <strong>Latency degradation</strong> -- alert when p95 latency
          exceeds a target for a sustained period
        </li>
        <li>
          <strong>Delivery channels</strong> -- email, Slack, PagerDuty, and
          webhook
        </li>
      </ul>

      <div className="callout callout-warning">
        <strong>Coming soon:</strong> Alerts are not yet available in the
        current release. Use the evaluations dashboard for manual monitoring,
        or export metrics to your existing observability stack via the OTel
        exporter.
      </div>

      <h2>OTel integration</h2>
      <p>
        Every service in Lantern emits OpenTelemetry traces with standard
        attributes: <code>tenant_id</code>, <code>run_id</code>,{" "}
        <code>step_id</code>, and <code>agent_version</code>. You can export
        these to any OTel-compatible backend (Jaeger, Datadog, Grafana Tempo,
        Honeycomb) for deep-dive debugging alongside the built-in evaluations
        dashboard.
      </p>
    </>
  );
}
