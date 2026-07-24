export default function BudgetsPage() {
  return (
    <>
      <h1>Budgets</h1>
      <p>
        Budgets are policy-as-code per-agent limits. When a run would exceed a
        hard-fail limit, Lantern returns <strong>HTTP 402</strong> before
        execution begins. Soft budgets log and continue. Use{" "}
        <code>POST /v1/runs/forecast</code> to check whether a run would exceed
        budget before submitting it.
      </p>

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
    "gmail.send": 10,
    "github.createIssue": 5
  },
  "hardFail": true
}

Response: 200 OK
{ "agentName": "research-agent", "maxCostUsdPerDay": 5.00, ... }`}</code>
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
            <td>Max USD spend for a single run</td>
          </tr>
          <tr>
            <td><code>maxTokensPerDay</code></td>
            <td>integer</td>
            <td>Max total tokens (in + out) per day</td>
          </tr>
          <tr>
            <td><code>maxRunsPerDay</code></td>
            <td>integer</td>
            <td>Max run count per day</td>
          </tr>
          <tr>
            <td><code>toolLimits</code></td>
            <td>object</td>
            <td>Per-tool call-count limits per day (key = connector action)</td>
          </tr>
          <tr>
            <td><code>hardFail</code></td>
            <td>boolean</td>
            <td>
              When <code>true</code>, a limit breach returns HTTP 402 and blocks
              the run. When <code>false</code>, the breach is logged but the run
              proceeds.
            </td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-info">
        <strong>Day boundary.</strong> The daily rollup resets at local
        midnight using <code>LANTERN_DEFAULT_TIMEZONE</code> (deployment-wide
        IANA zone; defaults to UTC when unset). A schedule with{" "}
        <code>timezone: "America/New_York"</code> rolls at New York midnight, not
        UTC.
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

Response: 204 No Content`}</code>
      </pre>

      <h2 id="forecast">Pre-run cost forecast</h2>
      <p>
        Before submitting a run, call the forecast endpoint to estimate cost and
        check whether it would breach a budget:
      </p>
      <pre>
        <code>{`POST /v1/runs/forecast
Content-Type: application/json

{
  "agentName": "research-agent",
  "input": { "topic": "quantum computing" }
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
  "blockReason": "would exceed maxCostUsdPerRun (1.00)"
}`}</code>
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
