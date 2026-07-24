import Link from "next/link";
import { Concept } from "../_components/Concept";

export default function ApiReferencePage() {
  return (
    <>
      <h1>API Reference</h1>
      <p>
        The Lantern REST API is served on <code>:8080</code> (default for both
        managed cloud and self-hosted). All endpoints under <code>/v1/</code>{" "}
        require a Bearer API key. Auth and internal endpoints use separate
        mechanisms described below.
      </p>

      <Concept>
        Everything in Lantern — the dashboard, the CLI, the SDKs — talks to
        this one HTTP API. This page is the raw reference for when you want to
        call it directly with <code>curl</code> or your own code. If you&apos;d
        rather not hand-write requests, the <Link href="/sdk">SDKs</Link> wrap
        all of these endpoints in typed methods.
      </Concept>

      <h2 id="auth">Authentication</h2>
      <p>
        Pass your API key in the <code>Authorization</code> header on every
        request:
      </p>
      <pre>
        <code>{`Authorization: Bearer hlx_live_your_api_key_here`}</code>
      </pre>
      <p>
        Keys are created under <strong>Settings &gt; API Keys</strong> in the
        dashboard and carry optional scopes (
        <code>agents:read</code>, <code>runs:execute</code>, etc.). Keys begin
        with the prefix <code>hlx_live_</code>.
      </p>

      <div className="callout callout-info">
        <strong>Self-hosted base URL:</strong> By default the control-plane
        binds to <code>http://localhost:8080</code>. There is no managed cloud
        endpoint—you deploy the control-plane yourself.
      </div>

      <h2 id="agents">Agents</h2>

      <h3>List agents</h3>
      <pre>
        <code>{`GET /v1/agents

Response: 200 OK — bare array
[
  {
    "name": "research-agent",
    "currentVersionId": "v1",
    "labels": {},
    "createdAt": "2026-04-10T12:00:00Z"
  }
]`}</code>
      </pre>

      <h3>Get agent</h3>
      <pre>
        <code>{`GET /v1/agents/{name}

Response: 200 OK
{
  "name": "research-agent",
  "currentVersionId": "v1",
  "manifest": {
    "systemPrompt": "You are a research assistant...",
    "model": "auto"
  },
  "labels": {},
  "createdAt": "2026-04-10T12:00:00Z"
}`}</code>
      </pre>

      <h3>Create agent</h3>
      <pre>
        <code>{`POST /v1/agents
Content-Type: application/json

{
  "name": "my-agent",
  "manifest": {
    "systemPrompt": "You are a helpful assistant...",
    "model": "auto"
  }
}

Response: 201 Created
{ "name": "my-agent" }`}</code>
      </pre>

      <h3>Delete agent</h3>
      <pre>
        <code>{`DELETE /v1/agents/{name}

Response: 204 No Content`}</code>
      </pre>

      <h2 id="runs">Runs</h2>

      <h3>Create a run</h3>
      <pre>
        <code>{`POST /v1/runs
Content-Type: application/json

{
  "agentName": "research-agent",
  "input": { "topic": "quantum computing" }
}

Response: 201 Created
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "research-agent",
  "status": "queued",
  "input": { "topic": "quantum computing" },
  "createdAt": "2026-04-12T10:00:00Z"
}`}</code>
      </pre>

      <h3>Get run</h3>
      <pre>
        <code>{`GET /v1/runs/{id}

Response: 200 OK
{
  "id": "550e8400-...",
  "agentName": "research-agent",
  "status": "succeeded",
  "input": { "topic": "quantum computing" },
  "output": { "summary": "..." },
  "tokensIn": 820,
  "tokensOut": 2100,
  "costUsd": 0.0042,
  "createdAt": "2026-04-12T10:00:00Z",
  "updatedAt": "2026-04-12T10:00:08Z"
}`}</code>
      </pre>

      <p>
        Run <code>status</code> values:{" "}
        <code>queued</code>, <code>running</code>, <code>succeeded</code>,{" "}
        <code>failed</code>, <code>waiting</code>, <code>cancelled</code>.
      </p>

      <h3>List runs</h3>
      <pre>
        <code>{`GET /v1/runs?limit=20&agentName=research-agent

Response: 200 OK — bare array
[
  { "id": "...", "agentName": "...", "status": "succeeded", ... }
]`}</code>
      </pre>

      <h3>Stream run events (SSE)</h3>
      <pre>
        <code>{`GET /v1/runs/{id}/events
Accept: text/event-stream

Response: Server-Sent Events
The event name is the journal kind; data is JSON.

event: step_started
data: {"seq":1,"kind":"step_started","stepId":"plan","runId":"550e...","at":"2026-04-12T10:00:01Z","payload":{}}

event: step_completed
data: {"seq":2,"kind":"step_completed","stepId":"plan","runId":"550e...","at":"2026-04-12T10:00:03Z","payload":{"output":"..."}}

event: step_started
data: {"seq":3,"kind":"step_started","stepId":"search-0","runId":"550e...","at":"2026-04-12T10:00:03Z","payload":{}}

event: step_completed
data: {"seq":4,"kind":"step_completed","stepId":"search-0","runId":"550e...","at":"2026-04-12T10:00:06Z","payload":{"output":"..."}}

: heartbeat`}</code>
      </pre>

      <p>Possible event kinds on a run stream:</p>
      <ul>
        <li>
          <code>step_started</code> — a step began executing
        </li>
        <li>
          <code>step_completed</code> — a step finished with output
        </li>
        <li>
          <code>step_failed</code> — a step errored; payload has{" "}
          <code>error</code>
        </li>
        <li>
          <code>step_retrying</code> — transient failure, will retry
        </li>
        <li>
          <code>step_waiting</code> — waiting for human approval
        </li>
        <li>
          <code>confidence_evaluated</code> — confidence gate scored a step
        </li>
        <li>
          <code>anomaly_detected</code> — runtime anomaly reported by the
          harness
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>No <code>run_completed</code> or <code>token</code> events.</strong>{" "}
        The stream ends when the run reaches a terminal status (
        <code>succeeded</code>, <code>failed</code>, or <code>cancelled</code>).
        The final run state is on <code>GET /v1/runs/{"{id}"}</code>.
      </div>

      <h3>Forecast cost before running</h3>
      <pre>
        <code>{`POST /v1/runs/forecast
Content-Type: application/json

{ "agentName": "research-agent", "input": { "topic": "..." } }

Response: 200 OK
{
  "estimatedTokensIn": 800,
  "estimatedTokensOut": 2000,
  "estimatedCostUsd": 0.004,
  "confidence": 0.82,
  "wouldExceedBudget": false
}`}</code>
      </pre>

      <h2 id="sessions">Sessions</h2>
      <p>
        Sessions are interactive multi-turn conversations. Each session can run
        in a dedicated microVM (warm-path ~150 ms).
      </p>

      <h3>Create session</h3>
      <pre>
        <code>{`POST /v1/sessions
Content-Type: application/json

{ "agentName": "my-agent" }

Response: 201 Created
{ "id": "sess-uuid", "agentName": "my-agent", "status": "active", "createdAt": "..." }`}</code>
      </pre>

      <h3>Send a message</h3>
      <pre>
        <code>{`POST /v1/sessions/{id}/messages
Content-Type: application/json

{ "content": "What is the capital of France?" }

Response: 200 OK
{ "turnId": "turn-uuid", "text": "Paris.", "tokensIn": 12, "tokensOut": 4, "costUsd": 0.00001 }`}</code>
      </pre>

      <h3>Stream session events</h3>
      <pre>
        <code>{`GET /v1/sessions/{id}/events
Accept: text/event-stream

event: message_delta
data: {"sessionId":"...","turnId":"...","seq":1,"delta":"Par"}

event: message_delta
data: {"sessionId":"...","turnId":"...","seq":2,"delta":"is."}

event: message_completed
data: {"turnId":"...","text":"Paris.","usage":{"tokensIn":12,"tokensOut":4,"costUsd":0.00001}}`}</code>
      </pre>

      <h3>Other session endpoints</h3>
      <pre>
        <code>{`GET    /v1/sessions         — list (bare array)
GET    /v1/sessions/{id}    — get
POST   /v1/sessions/{id}/stop  — stop a running session
DELETE /v1/sessions/{id}   — delete session`}</code>
      </pre>

      <h2 id="connectors">Connectors</h2>

      <h3>Install a connector</h3>
      <pre>
        <code>{`POST /v1/connectors/install
Content-Type: application/json

{
  "connectorId": "gmail",
  "config": { "userEmail": "you@example.com" }
}

Response: 201 Created
{ "connectorId": "gmail", "status": "installed" }`}</code>
      </pre>

      <h3>List connectors</h3>
      <pre>
        <code>{`GET /v1/connectors

Response: 200 OK — bare array
[
  { "connectorId": "gmail", "status": "installed", "installedAt": "..." }
]`}</code>
      </pre>

      <h3>Execute a connector action</h3>
      <pre>
        <code>{`POST /v1/connectors/{connectorId}/execute?action=send_email
Content-Type: application/json

{ "to": "friend@example.com", "subject": "Hello", "body": "..." }

Response: 200 OK
{ "result": { "messageId": "..." } }`}</code>
      </pre>

      <h3>Other connector endpoints</h3>
      <pre>
        <code>{`POST   /v1/connectors/{id}/test    — test connection
DELETE /v1/connectors/{id}         — uninstall`}</code>
      </pre>

      <h2 id="schedules">Schedules</h2>
      <p>
        Schedules trigger agent runs on a cron expression. They are a separate
        resource from agents—one agent can have multiple schedules.
      </p>

      <h3>Create schedule</h3>
      <pre>
        <code>{`POST /v1/schedules
Content-Type: application/json

{
  "agentName": "research-agent",
  "cronExpr": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "config": { "input": { "mode": "daily-digest" } },
  "enabled": true
}

Response: 201 Created
{ "id": "sched-uuid", "agentName": "research-agent", "cronExpr": "0 9 * * 1-5", ... }`}</code>
      </pre>

      <h3>Other schedule endpoints</h3>
      <pre>
        <code>{`GET    /v1/schedules             — list (bare array)
PUT    /v1/schedules/{id}        — update
DELETE /v1/schedules/{id}        — delete`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>Timezone.</strong> <code>cronExpr</code> fires in the
        schedule&apos;s <code>timezone</code> (IANA, e.g.{" "}
        <code>America/New_York</code>). Omit for UTC. The deployment-wide
        default is <code>LANTERN_DEFAULT_TIMEZONE</code>; per-schedule timezone
        overrides it.
      </div>

      <h2 id="settings">LLM providers</h2>
      <pre>
        <code>{`POST /v1/settings/llm-providers
Content-Type: application/json

{ "provider": "anthropic", "apiKey": "sk-ant-..." }

Response: 200 OK
{ "provider": "anthropic", "configured": true }

GET  /v1/settings/llm-providers           — list configured providers (bare array)
POST /v1/settings/llm-providers/{provider}/test  — test the key`}</code>
      </pre>

      <h2 id="errors">Errors</h2>
      <p>Errors use a flat JSON body:</p>
      <pre>
        <code>{`// Most errors
{ "error": "agent 'my-agent' not found" }

// Validation errors (may include field detail)
{ "error": "missing required field: agentName" }`}</code>
      </pre>
      <p>Common HTTP status codes:</p>
      <ul>
        <li>
          <code>400</code> — bad request / validation failure
        </li>
        <li>
          <code>401</code> — missing or invalid API key
        </li>
        <li>
          <code>403</code> — insufficient scope or cross-tenant access
        </li>
        <li>
          <code>404</code> — resource not found
        </li>
        <li>
          <code>402</code> — budget exceeded (hard-fail policy)
        </li>
        <li>
          <code>500</code> — internal error
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>No rate-limit plans or X-RateLimit headers.</strong> Budget
        enforcement (cost/day, cost/run, tokens/day, runs/day) is handled per
        agent via the{" "}
        <a href="/budgets">Budgets</a> API—not by tier-based rate limits.
      </div>
    </>
  );
}
