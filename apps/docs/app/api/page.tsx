export default function ApiReferencePage() {
  return (
    <>
      <h1>API Reference</h1>
      <p>
        The Lantern REST API provides programmatic access to all platform
        functionality. All endpoints are served from{" "}
        <code>https://api.lantern.run/v1</code> (or your self-hosted domain).
      </p>

      <h2>Authentication</h2>
      <p>
        All API requests require a Bearer token in the{" "}
        <code>Authorization</code> header:
      </p>
      <pre>
        <code>{`Authorization: Bearer lnt_your_api_key_here`}</code>
      </pre>
      <p>
        Generate API keys from the dashboard under{" "}
        <strong>Settings &gt; API Keys</strong>. Keys can be scoped to specific
        agents or full account access.
      </p>

      <h2>Agents</h2>

      <h3>List agents</h3>
      <pre>
        <code>{`GET /v1/agents

Response:
{
  "agents": [
    {
      "name": "research-agent",
      "description": "Researches topics and writes reports",
      "model": "auto",
      "status": "active",
      "created_at": "2026-04-10T12:00:00Z",
      "updated_at": "2026-04-11T09:30:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "per_page": 20
}`}</code>
      </pre>

      <h3>Get agent</h3>
      <pre>
        <code>{`GET /v1/agents/:name

Response:
{
  "name": "research-agent",
  "description": "Researches topics and writes reports",
  "system_prompt": "You are a research assistant...",
  "model": "auto",
  "connectors": ["gmail", "web-search"],
  "surfaces": ["whatsapp", "slack"],
  "privacy_level": "standard",
  "guardrails": {
    "max_cost_per_run": 1.00,
    "block_pii": false
  },
  "schedule": {
    "cron": "0 9 * * 1-5",
    "timezone": "America/New_York"
  },
  "status": "active",
  "created_at": "2026-04-10T12:00:00Z"
}`}</code>
      </pre>

      <h3>Create agent</h3>
      <pre>
        <code>{`POST /v1/agents
Content-Type: application/json

{
  "name": "my-agent",
  "description": "Does something useful",
  "system_prompt": "You are a helpful assistant...",
  "model": "auto",
  "connectors": ["gmail"],
  "privacy_level": "standard"
}

Response: 201 Created
{
  "name": "my-agent",
  "status": "active",
  "created_at": "2026-04-12T10:00:00Z"
}`}</code>
      </pre>

      <h3>Update agent</h3>
      <pre>
        <code>{`PATCH /v1/agents/:name
Content-Type: application/json

{
  "description": "Updated description",
  "system_prompt": "Updated prompt..."
}

Response: 200 OK`}</code>
      </pre>

      <h3>Delete agent</h3>
      <pre>
        <code>{`DELETE /v1/agents/:name

Response: 204 No Content`}</code>
      </pre>

      <h2>Runs</h2>

      <h3>Create a run</h3>
      <pre>
        <code>{`POST /v1/agents/:name/runs
Content-Type: application/json

{
  "input": {
    "topic": "quantum computing"
  }
}

Response: 201 Created
{
  "run_id": "run_abc123",
  "agent": "research-agent",
  "status": "queued",
  "created_at": "2026-04-12T10:00:00Z"
}`}</code>
      </pre>

      <h3>Get run status</h3>
      <pre>
        <code>{`GET /v1/runs/:run_id

Response:
{
  "run_id": "run_abc123",
  "agent": "research-agent",
  "status": "running",
  "steps": [
    {
      "name": "plan",
      "status": "completed",
      "duration_ms": 820,
      "model_used": "claude-3-haiku",
      "tokens": { "input": 150, "output": 340 }
    },
    {
      "name": "search-0",
      "status": "running",
      "started_at": "2026-04-12T10:00:01Z"
    }
  ],
  "created_at": "2026-04-12T10:00:00Z"
}`}</code>
      </pre>

      <h3>Stream run events</h3>
      <pre>
        <code>{`GET /v1/runs/:run_id/stream
Accept: text/event-stream

Response: Server-Sent Events
data: {"type": "step.start", "step": "plan", "timestamp": "..."}
data: {"type": "token", "content": "Quantum", "timestamp": "..."}
data: {"type": "token", "content": " computing", "timestamp": "..."}
data: {"type": "step.complete", "step": "plan", "duration_ms": 820}
data: {"type": "step.start", "step": "search-0"}
...
data: {"type": "run.complete", "run_id": "run_abc123"}`}</code>
      </pre>

      <div className="callout callout-tip">
        <strong>Tip:</strong> Use the streaming endpoint for real-time UI
        updates. Tokens flow end-to-end with no buffering -- the response
        streams as the LLM generates it.
      </div>

      <h3>List runs</h3>
      <pre>
        <code>{`GET /v1/agents/:name/runs?status=completed&limit=10

Response:
{
  "runs": [...],
  "total": 42,
  "page": 1,
  "per_page": 10
}`}</code>
      </pre>

      <h3>Cancel a run</h3>
      <pre>
        <code>{`POST /v1/runs/:run_id/cancel

Response: 200 OK
{
  "run_id": "run_abc123",
  "status": "cancelled"
}`}</code>
      </pre>

      <h2>Connectors</h2>

      <h3>List connectors</h3>
      <pre>
        <code>{`GET /v1/connectors

Response:
{
  "connectors": [
    {
      "type": "gmail",
      "status": "connected",
      "account": "user@gmail.com",
      "connected_at": "2026-04-08T14:00:00Z"
    }
  ]
}`}</code>
      </pre>

      <h2>Schedules</h2>

      <h3>Create or update schedule</h3>
      <pre>
        <code>{`PUT /v1/agents/:name/schedule
Content-Type: application/json

{
  "cron": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "input": { "mode": "daily-digest" },
  "email_delivery": {
    "enabled": true,
    "recipients": ["team@company.com"],
    "subject": "[{agent_name}] Daily report - {run_date}"
  }
}

Response: 200 OK`}</code>
      </pre>

      <h3>Delete schedule</h3>
      <pre>
        <code>{`DELETE /v1/agents/:name/schedule

Response: 204 No Content`}</code>
      </pre>

      <h2>Error format</h2>
      <p>All errors follow a consistent format:</p>
      <pre>
        <code>{`{
  "error": {
    "code": "not_found",
    "message": "Agent 'my-agent' not found",
    "request_id": "req_xyz789"
  }
}`}</code>
      </pre>
      <p>Common error codes:</p>
      <ul>
        <li>
          <code>400</code> -- <code>bad_request</code> -- invalid input
        </li>
        <li>
          <code>401</code> -- <code>unauthorized</code> -- missing or invalid
          API key
        </li>
        <li>
          <code>403</code> -- <code>forbidden</code> -- insufficient
          permissions
        </li>
        <li>
          <code>404</code> -- <code>not_found</code> -- resource does not exist
        </li>
        <li>
          <code>429</code> -- <code>rate_limited</code> -- too many requests
        </li>
        <li>
          <code>500</code> -- <code>internal_error</code> -- server error
        </li>
      </ul>

      <h2>Rate limits</h2>
      <p>
        API rate limits vary by plan:
      </p>
      <ul>
        <li>
          <strong>Personal</strong> -- 60 requests/minute
        </li>
        <li>
          <strong>Team</strong> -- 300 requests/minute
        </li>
        <li>
          <strong>Enterprise</strong> -- configurable
        </li>
      </ul>
      <p>
        Rate limit headers are included in every response:{" "}
        <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>,{" "}
        <code>X-RateLimit-Reset</code>.
      </p>
    </>
  );
}
