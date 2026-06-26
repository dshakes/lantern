# research-agent

> **Heads up: this example targets the Lantern SDK in-VM runtime, which is not
> runnable yet.** It uses `agent()` / `step()` with `ctx.llm`, `ctx.tools`,
> `ctx.connectors`, and/or `ctx.mem` — the in-microVM tool runtime, where
> `exec_tool` currently returns `TOOL_STATUS_UNAVAILABLE` (see the repo
> `CLAUDE.md`). It illustrates the intended SDK shape; it does **not** execute
> against the running stack today. For agents that run right now against the
> live control-plane, see [`examples/quickstart/`](../quickstart/).


Researches a topic using web search and produces a structured report with sources, key findings, and follow-up questions.

## How to run

```bash
lantern run research-agent --input '{"topic": "advances in solid-state batteries 2026", "depth": "medium", "maxSources": 5}'
```

## Example input

```json
{
  "topic": "advances in solid-state batteries 2026",
  "depth": "medium",
  "maxSources": 5
}
```

## Input options

| Field | Type | Default | Description |
|---|---|---|---|
| `topic` | string | (required) | The research topic |
| `depth` | `"shallow"` \| `"medium"` \| `"deep"` | `"medium"` | Controls how many search queries are generated (2/4/6) |
| `maxSources` | number | `5` | Maximum number of sources to fetch and analyze |

## Example output

```json
{
  "topic": "advances in solid-state batteries 2026",
  "summary": "Solid-state battery technology has seen significant progress in 2026, with several manufacturers announcing production-ready cells. Energy density improvements of 30-50% over conventional lithium-ion have been demonstrated at scale...",
  "keyFindings": [
    "Toyota announced mass production of solid-state EV batteries beginning Q3 2026",
    "QuantumScape reported cycle life exceeding 1000 charges at 95% capacity retention",
    "Manufacturing costs have dropped 40% year-over-year due to dry electrode processing",
    "Samsung SDI demonstrated a solid-state cell achieving 900 Wh/L energy density"
  ],
  "sources": [
    {
      "title": "Solid-State Battery Breakthroughs in 2026",
      "url": "https://example.com/article-1",
      "snippet": "A comprehensive overview of the latest advances..."
    }
  ],
  "followUpQuestions": [
    "What are the remaining cost barriers to solid-state battery mass adoption?",
    "How do solid-state batteries compare to sodium-ion for grid storage?",
    "Which vehicle manufacturers have committed to solid-state timelines?"
  ]
}
```
