# code-reviewer

> **Heads up: this example targets the Lantern SDK in-VM runtime, which is not
> runnable yet.** It uses `agent()` / `step()` with `ctx.llm`, `ctx.tools`,
> `ctx.connectors`, and/or `ctx.mem` — the in-microVM tool runtime, where
> `exec_tool` currently returns `TOOL_STATUS_UNAVAILABLE` (see the repo
> `CLAUDE.md`). It illustrates the intended SDK shape; it does **not** execute
> against the running stack today. For agents that run right now against the
> live control-plane, see [`examples/quickstart/`](../quickstart/).


Reviews GitHub pull requests and posts inline comments with suggestions, then submits a verdict.

## How to run

```bash
lantern run code-reviewer --input '{"repo": "acme/backend", "prNumber": 42, "focus": ["security", "performance"]}'
```

## Example input

```json
{
  "repo": "acme/backend",
  "prNumber": 42,
  "focus": ["security", "performance"]
}
```

## Input options

| Field | Type | Default | Description |
|---|---|---|---|
| `repo` | string | (required) | GitHub repository in `owner/repo` format |
| `prNumber` | number | (required) | Pull request number to review |
| `focus` | string[] | `[]` | Areas to focus on: `"security"`, `"performance"`, `"style"`, `"correctness"`, etc. |

## Example output

```json
{
  "summary": "Overall the PR is well-structured and adds a clean implementation of rate limiting. Two critical issues were found: an unbounded cache that could lead to memory exhaustion under load, and a missing authorization check on the admin endpoint. Three minor suggestions for improved error handling.",
  "verdict": "request-changes",
  "comments": [
    {
      "file": "src/middleware/rateLimit.ts",
      "line": 45,
      "severity": "critical",
      "message": "The in-memory rate limit map is never pruned. Under high traffic, this will grow without bound. Use a TTL-based cache or Redis instead."
    },
    {
      "file": "src/routes/admin.ts",
      "line": 12,
      "severity": "critical",
      "message": "This endpoint is missing the requireAdmin middleware. Any authenticated user can access admin operations."
    },
    {
      "file": "src/middleware/rateLimit.ts",
      "line": 28,
      "severity": "suggestion",
      "message": "Consider returning a Retry-After header with the 429 response so clients know when to retry."
    }
  ],
  "score": 5
}
```
