# deploy-guardian

> **Heads up: this example targets the Lantern SDK in-VM runtime, which is not
> runnable yet.** It uses `agent()` / `step()` with `ctx.llm`, `ctx.tools`,
> `ctx.connectors`, and/or `ctx.mem` — the in-microVM tool runtime, where
> `exec_tool` currently returns `TOOL_STATUS_UNAVAILABLE` (see the repo
> `CLAUDE.md`). It illustrates the intended SDK shape; it does **not** execute
> against the running stack today. For agents that run right now against the
> live control-plane, see [`examples/quickstart/`](../quickstart/).


CI/CD guardian agent that analyzes code changes, checks operational signals, assesses deploy risk, gates high-risk releases with approval, and monitors production health post-deploy.

## How to run

Normally triggered by a GitHub webhook (push to main or PR merge). To test manually:

```bash
lantern run deploy-guardian --input '{
  "action": "push",
  "ref": "refs/heads/main",
  "repository": { "full_name": "acme/backend", "default_branch": "main" },
  "head_commit": { "id": "abc123def456", "message": "feat: add rate limiting to API gateway", "author": { "name": "Alice", "email": "alice@acme.co" } },
  "sender": { "login": "alice" }
}'
```

## Example input

```json
{
  "action": "push",
  "ref": "refs/heads/main",
  "repository": {
    "full_name": "acme/backend",
    "default_branch": "main"
  },
  "head_commit": {
    "id": "abc123def456",
    "message": "feat: add rate limiting to API gateway",
    "author": { "name": "Alice", "email": "alice@acme.co" }
  },
  "sender": { "login": "alice" }
}
```

## Example output

```json
{
  "repo": "acme/backend",
  "commitSha": "abc123def456",
  "riskScore": 6,
  "decision": "deploy",
  "rationale": "Medium-risk deploy. The rate limiting middleware is well-tested and behind a feature flag, but it touches the critical API gateway path. All CI checks pass and no active incidents. Recommend 10-minute monitoring window.",
  "signals": [
    { "source": "GitHub Actions", "status": "healthy", "details": "All 12 checks passed" },
    { "source": "Sentry", "status": "healthy", "details": "Normal error rate: 0.3/min" },
    { "source": "Datadog", "status": "healthy", "details": "CPU: 34%, P99 latency: 120ms, Error rate: 0.1/s" },
    { "source": "PagerDuty", "status": "healthy", "details": "No active incidents" }
  ],
  "codeAnalysis": {
    "riskLevel": "medium",
    "changedFiles": 8,
    "riskFactors": [
      "Modifies request processing middleware in the hot path",
      "Adds Redis dependency for rate limit storage"
    ],
    "safetyFactors": [
      "Feature flag controls rollout percentage",
      "Comprehensive unit and integration tests added",
      "Graceful degradation if Redis is unavailable"
    ]
  },
  "requiresApproval": false,
  "postDeployStatus": "healthy"
}
```

## Agent workflow

1. **Analyze code** -- Fetches the commit diff and uses `code-large` to identify risk factors (migrations, auth changes, infra changes, etc.)
2. **Check signals** -- Queries GitHub Actions, Sentry, Datadog, and PagerDuty in parallel via `step.map`
3. **Assess risk** -- Uses `reasoning-large` to synthesize all signals into a 1-10 risk score and deploy/block decision
4. **Approval gate** -- If risk > 7, durably suspends until an on-call engineer approves
5. **Execute** -- Triggers Vercel deploy (or blocks with GitHub commit status)
6. **Monitor** -- Uses `step.sleep` for a configurable monitoring window, then checks error rates and latency
7. **Rollback** -- If post-deploy metrics are anomalous, automatically triggers a rollback and notifies Slack

## Lantern features demonstrated

- **Webhook triggers**: Fires automatically on GitHub push events -- no polling or external orchestration
- **Parallel signal checking**: `step.map` queries 4 monitoring systems concurrently
- **Multi-LLM routing**: `code-large` for diff analysis, `reasoning-large` for risk assessment and post-deploy analysis
- **Durable approval gates**: High-risk deploys pause until an on-call engineer approves -- survives process restarts
- **Durable sleep**: Post-deploy monitoring uses `step.sleep` to wait 5-15 minutes, then resumes to check health -- the VM can be recycled during the sleep
- **Connector ecosystem**: Integrates with GitHub, Sentry, Datadog, PagerDuty, Vercel, and Slack
- **Automated rollback**: If post-deploy metrics show anomalies, the agent rolls back and notifies the team without human intervention
