import Link from "next/link";
import { Concept } from "../_components/Concept";

export default function BudgetsPage() {
  return (
    <>
      <h1>Budgets</h1>
      <p>
        Per-agent spend and rate limits, set as policy. With{" "}
        <code>hardFail: true</code>, a call that would start while a limit is
        already reached is refused <strong>before the model is called</strong>:
        HTTP 402 on the REST paths, a failed step inside workflows. With{" "}
        <code>false</code>, the breach is logged and the call proceeds. If the
        budget cannot be read, hard-fail budgets fail closed.
      </p>

      <Concept>
        A buggy loop can burn a month of model spend in an afternoon. Set a cap
        per agent: dollars per day, runs per day, tokens per day. With
        hard-fail on, the next call is refused before it reaches a model, not
        flagged afterward.
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
    "web_search": 50,
    "slack.post_message": 100
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
            <td>Max USD spend across all runs in one budget day. Blocks once the day&apos;s recorded spend exceeds it</td>
          </tr>
          <tr>
            <td><code>maxCostUsdPerRun</code></td>
            <td>number</td>
            <td>Max USD for one run. Enforced <strong>mid-run for workflow runs only</strong> (see <a href="#matrix">the matrix</a>). Elsewhere it is checked only by the opt-in <a href="#forecast"><code>POST /v1/runs/forecast</code></a> and reported after the fact as an <code>anomaly_detected</code> event</td>
          </tr>
          <tr>
            <td><code>maxTokensPerDay</code></td>
            <td>integer</td>
            <td>Max total tokens (in + out) per day. Blocks once the day&apos;s recorded tokens reach it</td>
          </tr>
          <tr>
            <td><code>maxRunsPerDay</code></td>
            <td>integer</td>
            <td>Max runs per day. Blocks once the day&apos;s run count reaches it. Spend inside a run (workflow ai-steps, votes, tools) does not add to the count. A workflow run counts once, when it succeeds, like a plain run. <strong>Failed runs are not counted</strong></td>
          </tr>
          <tr>
            <td><code>toolLimits</code></td>
            <td>object</td>
            <td>Per-tool call-count limits per day. Keys are a tool name (<code>web_search</code>) or <code>connector.action</code> for connector nodes. Enforced for workflow <code>tool</code> and <code>connector</code> nodes only</td>
          </tr>
          <tr>
            <td><code>hardFail</code></td>
            <td>boolean</td>
            <td>
              <code>true</code>: a reached limit blocks the call.{" "}
              <code>false</code>: the breach is logged and the call proceeds
            </td>
          </tr>
          <tr>
            <td><code>notifyAtPct</code></td>
            <td>integer</td>
            <td>Stored; defaults to 80 when omitted or outside 1-100. No alert is sent on it today</td>
          </tr>
        </tbody>
      </table>

      <p>
        <strong>Day boundary.</strong> The daily rollup resets at local
        midnight using <code>LANTERN_DEFAULT_TIMEZONE</code> (deployment-wide
        IANA zone; defaults to UTC when unset). A schedule&apos;s own{" "}
        <code>timezone</code> affects only when its cron fires, not the budget
        day.
      </p>

      <h2 id="matrix">What is enforced where</h2>
      <p>
        Each cell is checked <em>before</em> the model or tool call. &quot;Yes&quot;
        means a hard-fail budget blocks; a soft budget logs and proceeds.
        Tenant = the tenant-wide daily cost cap (<a href="#tenant">below</a>).
      </p>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Cost/day</th>
            <th>Tokens/day</th>
            <th>Runs/day</th>
            <th>Tenant cap</th>
            <th>Per-run cap</th>
            <th>Per-tool</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Run create (<code>POST /v1/runs</code>)</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>No</td>
            <td>No</td>
          </tr>
          <tr>
            <td>Session message</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>No</td>
            <td>No</td>
          </tr>
          <tr>
            <td><code>/v1/completions</code> with <code>agentName</code></td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>No</td>
            <td>No</td>
          </tr>
          <tr>
            <td><code>/v1/completions</code> without <code>agentName</code></td>
            <td>n/a</td>
            <td>n/a</td>
            <td>n/a</td>
            <td>Yes</td>
            <td>n/a</td>
            <td>n/a</td>
          </tr>
          <tr>
            <td>Workflow <code>ai-step</code> (and confidence votes)</td>
            <td>Yes, every call</td>
            <td>Yes, every call</td>
            <td>No (run already admitted)</td>
            <td>Yes, every call</td>
            <td>Yes, against spend accrued so far</td>
            <td>n/a</td>
          </tr>
          <tr>
            <td>Workflow <code>tool</code> node: <code>web_search</code></td>
            <td>Yes</td>
            <td>Yes</td>
            <td>No (run already admitted)</td>
            <td>Yes</td>
            <td>Yes, against spend accrued so far</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td>Workflow <code>tool</code> node: sandbox tools</td>
            <td>No</td>
            <td>No</td>
            <td>No</td>
            <td>No</td>
            <td>No</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td>Workflow <code>connector</code> node</td>
            <td>No</td>
            <td>No</td>
            <td>No</td>
            <td>No</td>
            <td>No</td>
            <td>Yes (<code>connector.action</code>)</td>
          </tr>
          <tr>
            <td><code>web_search</code> inside a session turn</td>
            <td colSpan={6}>Covered by the session-message check at the start of the turn; its spend is recorded after</td>
          </tr>
          <tr>
            <td>Voice (Twilio inbound, LiveKit token)</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Yes</td>
            <td>Flat estimate only</td>
            <td>No</td>
          </tr>
        </tbody>
      </table>
      <p>
        Marketplace invokes check the <em>seller</em> agent&apos;s budget and
        return 402 with <code>seller agent budget limit reached: &lt;reason&gt;</code>.
      </p>

      <h2 id="responses">What a blocked call looks like</h2>
      <p>
        <code>POST /v1/runs</code>, hard-fail budget reached. The{" "}
        <code>reason</code> text names the limit that tripped:
      </p>
      <pre>
        <code>{`HTTP 402
{
  "error": "agent budget limit reached: daily run limit reached (100/100)",
  "reason": "daily run limit reached (100/100)"
}`}</code>
      </pre>
      <p>
        Other <code>reason</code> strings:{" "}
        <code>daily spend would reach $5.0123 exceeding limit $5.0000</code>,{" "}
        <code>daily token limit reached (500000/500000)</code>,{" "}
        <code>tenant-wide daily spend would reach $50.0100 exceeding tenant limit $50.0000</code>,{" "}
        <code>run spend $1.0042 reached per-run limit $1.0000</code>,{" "}
        <code>tool &quot;web_search&quot; budget exhausted (50/50 today)</code>.
      </p>
      <p>
        <code>POST /v1/completions</code> (agent-scoped or agentless) uses a
        shorter body:
      </p>
      <pre>
        <code>{`HTTP 402
{ "error": "budget limit exceeded", "reason": "<reason>" }`}</code>
      </pre>
      <p>
        <strong>Session messages</strong> have no HTTP error: the session
        replies with{" "}
        <code>sorry — this agent has reached its usage limit for today</code>{" "}
        and goes idle. <strong>Workflow steps</strong> fail with{" "}
        <code>budget limit exceeded: &lt;reason&gt;</code>. <strong>Voice</strong>{" "}
        returns Twilio <code>{"<Reject reason=\"busy\"/>"}</code> or, for other
        providers, 402 <code>agent voice budget exhausted</code>; the LiveKit
        token route returns 402{" "}
        <code>{"{ \"error\": \"agent voice budget exhausted: <reason>\" }"}</code>.
      </p>

      <h2 id="fail-closed">When the budget cannot be read</h2>
      <p>
        A database error while reading a budget is not the same as &quot;no
        budget configured&quot; (that allows the call). The check fails closed
        when the budget is hard-fail, or when the row itself could not be read
        (its policy is unknown, so it is treated as hard-fail). The error text
        is logged, never returned.
      </p>
      <pre>
        <code>{`POST /v1/runs  ->  HTTP 503
{
  "error": "budget check unavailable; retry shortly",
  "reason": "budget check unavailable"
}`}</code>
      </pre>
      <ul>
        <li>
          <strong>503 is returned by run create only.</strong>{" "}
          <code>/v1/completions</code> answers 402 with reason{" "}
          <code>budget check unavailable</code>; voice declines as for a budget
          block (Twilio <code>{"<Reject>"}</code>, other providers a plain-text
          402, the LiveKit token route 402{" "}
          <code>agent voice budget exhausted: budget check unavailable</code>); sessions reply{" "}
          <code>sorry — I can&apos;t check this agent&apos;s usage limit right now, try again shortly</code>;
          workflow steps fail with <code>budget limit exceeded: budget check unavailable</code>.
        </li>
        <li>
          <strong>Soft budgets:</strong> if the budget row was read (and says{" "}
          <code>hardFail: false</code>) but the usage lookup then errors, the
          call proceeds. If the row itself cannot be read, the call is blocked
          whatever the policy.
        </li>
        <li>
          Every failed-closed lookup increments{" "}
          <code>lantern.budget.check.errors</code> (see{" "}
          <a href="#metrics">metrics</a>).
        </li>
      </ul>

      <h2 id="mid-run">Per-run cap inside a workflow</h2>
      <p>
        Workflow runs record each model call&apos;s tokens and cost onto the
        run as they happen. Before every <code>ai-step</code>, every
        self-consistency confidence vote and every <code>web_search</code>{" "}
        tool node, the interpreter re-checks: tenant
        cap, the agent&apos;s daily cost and token caps, and{" "}
        <code>maxCostUsdPerRun</code> against what this run has spent so far.
        Hard-fail stops the run at that step with no further provider spend;{" "}
        <code>maxRunsPerDay</code> is skipped so other runs finishing do not
        stop a run that was already admitted. A single call can still overshoot
        the cap, since the check happens before the call and the cost is added
        after.
      </p>

      <h2 id="tool-limits">Per-tool limits in workflows</h2>
      <p>
        <code>toolLimits</code> is checked before a workflow{" "}
        <code>tool</code> or <code>connector</code> node dispatches, and one
        use is counted after dispatch. Hard-fail blocks the step; soft logs and
        proceeds. A tool that was never dispatched (runtime not wired) is not
        counted. See{" "}
        <Link href="/agents#tool-nodes">workflow tool nodes</Link>.
      </p>

      <h2 id="tenant">Tenant-wide cap</h2>
      <p>
        One daily cap across all agents, including agentless{" "}
        <code>/v1/completions</code> calls: <code>PUT</code>,{" "}
        <code>GET</code> and <code>DELETE</code> on{" "}
        <code>/v1/budgets/tenant</code> with{" "}
        <code>{`{ "maxCostUsdPerDay": 50, "hardFail": true }`}</code> (must be
        greater than 0). It is stored under the reserved agent name{" "}
        <code>*</code>, hidden from <code>GET /v1/budgets</code>, and the
        per-agent routes reject <code>*</code> as a name. A soft tenant cap
        never masks an agent&apos;s own hard-fail limit.
      </p>

      <h2 id="reading">Reading and removing</h2>
      <pre>
        <code>{`GET /v1/agents/{name}/budget
Response: 200 OK
{ "agentName": "research-agent", "maxCostUsdPerDay": 5.00, "hardFail": true, ... }
404 {"error":"no budget configured"} when none is set

GET /v1/budgets
Response: 200 OK, bare array of per-agent budgets

DELETE /v1/agents/{name}/budget
Response: 200 OK
{ "status": "removed" }`}</code>
      </pre>

      <h2 id="try-it">Try it</h2>
      <pre>
        <code>{`TOKEN=$(curl -s localhost:8080/auth/login -H 'Content-Type: application/json' \\
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jq -r .token)

# Cap an agent at 1 run per day, hard-fail
curl -s -X PUT localhost:8080/v1/agents/demo/budget \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxRunsPerDay":1,"hardFail":true}'

# Create two runs; the second returns HTTP 402 once the first is recorded
curl -s -i -X POST localhost:8080/v1/runs \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"agentName":"demo","input":{"q":"hi"}}'`}</code>
      </pre>
      <p>
        Usage is recorded when a run finishes, so create the second run after
        the first completes.
      </p>

      <h2 id="forecast">Pre-run cost forecast</h2>
      <p>
        <code>POST /v1/runs/forecast</code> estimates tokens and cost from the
        agent&apos;s <code>succeeded</code> runs over the last 30 days (average
        tokens per run, plus about one token per four characters of input) and
        checks the estimate against the agent&apos;s budget. It answers{" "}
        <code>402</code> instead of <code>200</code> when a hard-fail budget
        would be breached. Forecasting is opt-in: run creation does not call it.
      </p>
      <ul>
        <li>
          <strong>With history</strong> the response is{" "}
          <code>calibrated: true</code> and the per-run cap and daily cost cap
          are checked against the estimate.
        </li>
        <li>
          <strong>With no succeeded runs</strong> the estimates are omitted,{" "}
          <code>calibrated</code> is false, <code>confidence</code> is 0, and
          only <code>maxRunsPerDay</code> can block. An unknown cost never
          auto-blocks.
        </li>
        <li>
          <code>confidence</code> grows with sample size:{" "}
          <code>min(0.95, 0.3 + 0.03 × √runs)</code>.
        </li>
      </ul>
      <pre>
        <code>{`POST /v1/runs/forecast
Content-Type: application/json

{ "agentName": "research-agent", "input": "quantum computing" }

Response: 200 OK   (values illustrative)
{
  "agentName": "research-agent",
  "model": "...",
  "provider": "...",
  "estimatedTokensIn": 800,
  "estimatedTokensOut": 2000,
  "estimatedCostUsd": 0.004,
  "confidence": 0.45,
  "calibrated": true,
  "reasoning": { "historical_runs": 25, "input_token_estimate": 5, ... },
  "budget": { "maxCostUsdPerRun": 1, "spentTodayUsd": 0.12, "runsToday": 4,
              "maxRunsPerDay": 100, "hardFail": true, ... },
  "wouldExceedBudget": false
}

// Over budget (HTTP 402 when hardFail is true). Several reasons join with "; ":
{
  ...,
  "estimatedCostUsd": 1.2,
  "wouldExceedBudget": true,
  "blockReason": "per-run cost $1.2000 exceeds limit $1.0000"
}`}</code>
      </pre>
      <p>
        Other <code>blockReason</code> strings:{" "}
        <code>daily cost would hit $5.0400 exceeding $5.0000</code>,{" "}
        <code>daily run limit reached (100/100)</code>.{" "}
        <code>blockReason</code> is omitted when nothing would block.
      </p>

      <h2 id="voice">Voice calls</h2>
      <p>
        Voice calls count against the same <code>agent_budgets</code> as runs.
        An inbound call over a hard-fail budget is declined before any media is
        allocated (Twilio: <code>{"<Reject reason=\"busy\"/>"}</code>; LiveKit:
        HTTP 402 on the token request). A flat cost estimate is reserved on
        connect, then reconciled to the actual call duration when the provider
        status callback fires at{" "}
        <code>POST /v1/voice/calls/status/{"{provider}"}</code>.
      </p>

      <h2 id="not-enforced">Not enforced yet</h2>
      <ul>
        <li>
          <strong>Per-run cap mid-run on single-call paths.</strong> A plain
          (non-workflow) run, a session turn and a completion make one model
          call, so there is no point to stop at. <code>maxCostUsdPerRun</code>{" "}
          is not checked at run create (the estimate there is 0). Overshoot is
          reported after the run as an <code>anomaly_detected</code> journal
          event, which does not block anything.
        </li>
        <li>
          <strong>Pre-run cost estimates at run creation.</strong> Run create
          checks recorded spend, not projected spend, so the run that crosses a
          daily cap is allowed; the next one is blocked. Use{" "}
          <a href="#forecast"><code>POST /v1/runs/forecast</code></a> to
          estimate ahead of time.
        </li>
        <li>
          <strong>Failed runs toward runs/day.</strong> Only runs that succeed
          are counted toward <code>maxRunsPerDay</code> (a workflow run counts
          once on success), so an agent that keeps failing never trips the
          cap. Its spend still counts toward the cost and token caps.
        </li>
        <li>
          <strong>Per-tool limits outside workflows.</strong> Session tool
          loops, <code>POST /v1/connectors/&#123;id&#125;/execute</code> and
          other callers do not consult <code>toolLimits</code>.
        </li>
        <li>
          <strong>Daily cost and token caps on sandbox tool and connector
          nodes.</strong> Those nodes check only <code>toolLimits</code>;
          their ai-step neighbours carry the model spend and are checked.
        </li>
        <li>
          <strong>No reservation.</strong> Checks read recorded usage and
          spend is recorded after the call, so concurrent calls can together
          overshoot a cap.
        </li>
        <li>
          <strong><code>notifyAtPct</code> alerts.</strong> The value is
          stored; nothing fires on it yet.
        </li>
      </ul>

      <h2 id="metrics">Metrics</h2>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Attributes</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>lantern.run.budget.blocks</code></td>
            <td><code>lantern.agent_name</code></td>
            <td>Runs refused by a hard-fail budget at <code>POST /v1/runs</code> (HTTP 402)</td>
          </tr>
          <tr>
            <td><code>lantern.budget.check.errors</code></td>
            <td><code>lantern.budget_check</code> (<code>tenant</code>, <code>agent</code>, <code>run</code>, <code>tool</code>), <code>lantern.agent_name</code></td>
            <td>Budget lookups that errored and failed closed</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
