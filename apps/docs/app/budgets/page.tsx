import { Concept } from "../_components/Concept";

export default function BudgetsPage() {
  return (
    <>
      <h1>Budgets</h1>
      <p>
        Per-agent spend and rate limits, set as policy. With{" "}
        <code>hardFail: true</code>, a run, session message or completion gets{" "}
        <strong>HTTP 402</strong> before the model is called once the agent&apos;s
        daily cost cap or runs-per-day cap (or the tenant-wide daily cost cap) is
        already reached. With <code>false</code>, the breach is logged and the
        call proceeds. The per-run cost cap is checked by{" "}
        <code>POST /v1/runs/forecast</code>. A budget lookup error does not block
        the request.
      </p>

      <Concept>
        A buggy loop can burn a month of model spend in an afternoon. Set a cap
        per agent: dollars per day or runs per day. With hard-fail on, the
        next run is refused before it calls a model, not flagged afterward.
      </Concept>

      <h2 id="policy">Setting a budget</h2>
      <pre>
        <code>{`PUT /v1/agents/{name}/budget
Content-Type: application/json

{
  "maxCostUsdPerDay": 5.00,
  "maxCostUsdPerRun": 1.00,
  "maxTokensPerDay": 500000,
  "maxRunsPerDay": 100,
  "toolLimits": {
    "slack.post": 100,
    "github.create_issue": 25
  },
  "hardFail": true,
  "notifyAtPct": 80
}

Response: 200 OK
{ "status": "saved" }`}</code>
      </pre>

      <p>Field reference:</p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>maxCostUsdPerDay</code></td>
            <td>number</td>
            <td>Max USD spend across all runs in one calendar day</td>
          </tr>
          <tr>
            <td><code>maxCostUsdPerRun</code></td>
            <td>number</td>
            <td>Max estimated USD for a single run. Checked by <code>POST /v1/runs/forecast</code>; run creation does not estimate cost, so it does not trip this cap</td>
          </tr>
          <tr>
            <td><code>maxTokensPerDay</code></td>
            <td>integer</td>
            <td>Max total tokens (in + out) per day. Stored, not enforced yet (feeds a post-run <code>anomaly_detected</code> event only)</td>
          </tr>
          <tr>
            <td><code>maxRunsPerDay</code></td>
            <td>integer</td>
            <td>Max run count per day</td>
          </tr>
          <tr>
            <td><code>toolLimits</code></td>
            <td>object</td>
            <td>Per-tool call-count limits per day, keyed <code>connector.action</code>. Stored, not enforced yet</td>
          </tr>
          <tr>
            <td><code>hardFail</code></td>
            <td>boolean</td>
            <td>
              When <code>true</code>, a reached daily cost or runs-per-day cap
              returns HTTP 402 and blocks the run. When <code>false</code>, the
              breach is logged but the run proceeds.
            </td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-info">
        <strong>Day boundary.</strong> The daily rollup resets at local
        midnight using <code>LANTERN_DEFAULT_TIMEZONE</code> (deployment-wide
        IANA zone; defaults to UTC when unset). A schedule&apos;s own{" "}
        <code>timezone</code> affects only when its cron fires, not the budget
        day.
      </div>

      <h2 id="get">Reading a budget</h2>
      <pre>
        <code>{`GET /v1/agents/{name}/budget

Response: 200 OK
{ "agentName": "research-agent", "maxCostUsdPerDay": 5.00, "hardFail": true, ... }

GET /v1/budgets
Response: 200 OK — bare array of all tenant budgets
[{ "agentName": "...", ... }]`}</code>
      </pre>

      <h2 id="delete">Removing a budget</h2>
      <pre>
        <code>{`DELETE /v1/agents/{name}/budget

Response: 200 OK
{ "status": "removed" }`}</code>
      </pre>

      <h3>Tenant-wide cap</h3>
      <p>
        One daily cap across all agents, including agentless{" "}
        <code>/v1/completions</code> calls: <code>PUT</code>,{" "}
        <code>GET</code> and <code>DELETE</code> on{" "}
        <code>/v1/budgets/tenant</code> with{" "}
        <code>{`{ "maxCostUsdPerDay": 50, "hardFail": true }`}</code>. It is
        stored under the reserved agent name <code>*</code> and hidden from{" "}
        <code>GET /v1/budgets</code>.
      </p>

      <h2 id="forecast">Pre-run cost forecast</h2>
      <p>
        The forecast estimates tokens and cost from the agent&apos;s run
        history and checks the result against its budget. It returns{" "}
        <strong>402</strong> instead of 200 when it would breach a hard-fail
        budget. Cost checks only apply once the agent has history (the
        response carries a <code>calibrated</code> flag); the runs-per-day
        check always applies.
      </p>
      <pre>
        <code>{`POST /v1/runs/forecast
Content-Type: application/json

{
  "agentName": "research-agent",
  "input": "quantum computing"
}

Response: 200 OK
{
  "estimatedTokensIn": 800,
  "estimatedTokensOut": 2000,
  "estimatedCostUsd": 0.004,
  "confidence": 0.82,
  "wouldExceedBudget": false,
  "blockReason": ""
}

// If over budget:
{
  "estimatedCostUsd": 1.20,
  "wouldExceedBudget": true,
  "blockReason": "per-run cost $1.2000 exceeds limit $1.0000"
}   // HTTP 402 when hardFail is true`}</code>
      </pre>

      <h2 id="voice">Budget gating on voice calls</h2>
      <p>
        Voice calls count against the same <code>agent_budgets</code> as runs.
        An inbound call over a hard-fail budget is declined before any media is
        allocated (Twilio: <code>{"<Reject>"}</code>; LiveKit: HTTP 402 on the
        token request). A flat cost estimate is reserved on connect, then
        reconciled to the actual call duration when the provider status callback
        fires at <code>POST /v1/voice/calls/status/{"{provider}"}</code>.
      </p>
    </>
  );
}
