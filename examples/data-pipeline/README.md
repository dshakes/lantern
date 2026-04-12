# data-pipeline

Scheduled weekly data pipeline that pulls from HubSpot, Stripe, and Google Analytics, analyzes trends and anomalies, then distributes a formatted report to Slack, email, Google Sheets, and Notion.

## How to run

Normally triggered automatically every Monday at 9am. To run manually:

```bash
lantern run data-pipeline
```

With a custom date range:

```bash
lantern run data-pipeline --input '{"dateRange": {"start": "2026-03-30", "end": "2026-04-06"}}'
```

Dry run without distribution:

```bash
lantern run data-pipeline --input '{"skipDistribution": true}'
```

## Example input

```json
{
  "dateRange": {
    "start": "2026-04-06",
    "end": "2026-04-12"
  }
}
```

## Input options

| Field | Type | Default | Description |
|---|---|---|---|
| `dateRange` | `{start, end}` | Previous 7 days | Custom date range to report on |
| `skipDistribution` | boolean | `false` | If true, generate report but don't send anywhere |

## Example output

```json
{
  "report": "# Weekly Business Report — 2026-04-06 to 2026-04-12\n\n## Executive Summary\nMRR grew 3.2% to $847K driven by...",
  "sources": [
    { "name": "HubSpot CRM", "recordCount": 142, "fetchDurationMs": 1230 },
    { "name": "Stripe Billing", "recordCount": 89, "fetchDurationMs": 870 },
    { "name": "Google Analytics", "recordCount": 2100, "fetchDurationMs": 1540 }
  ],
  "trends": [
    {
      "metric": "MRR",
      "direction": "up",
      "changePercent": 3.2,
      "insight": "Driven by 12 new mid-market subscriptions from the Q1 outbound campaign"
    },
    {
      "metric": "Activation Rate",
      "direction": "down",
      "changePercent": -5.1,
      "insight": "New onboarding flow may be creating friction — drop concentrated in mobile signups"
    }
  ],
  "anomalies": [
    {
      "metric": "Failed Payments",
      "expected": "< 2%",
      "actual": "4.7%",
      "severity": "high",
      "possibleCause": "Stripe webhook processing delay on April 9th caused retry storms"
    }
  ],
  "costBreakdown": {
    "totalUsd": 0.42,
    "byStep": {
      "fetch-sources": 0.0,
      "transform": 0.03,
      "analyze-trends": 0.31,
      "generate-report": 0.05,
      "distribute": 0.03
    }
  },
  "distributedTo": [
    "slack:#weekly-metrics",
    "email:leadership@company.com",
    "google-sheets:weekly-metrics-tracker",
    "notion:weekly-reports-db"
  ]
}
```

## Lantern features demonstrated

- **Scheduled triggers**: Runs automatically every Monday at 9am via cron — no external scheduler needed
- **Parallel data fetching**: `step.map` fetches from HubSpot, Stripe, and Google Analytics concurrently
- **Cost-aware model selection**: Uses `chat-small` with `optimize: "cheap"` for data transformation and report formatting; reserves `reasoning-large` only for trend analysis where strong reasoning matters
- **Cost tracking**: `ctx.cost.estimateUsd()` tracks spend at each step, included in the output for budget monitoring
- **Connector ecosystem**: Integrates with 6 services (HubSpot, Stripe, Google Analytics, Gmail, Google Sheets, Notion) using built-in connectors
- **Durable execution**: Each step is checkpointed — if the pipeline fails at step 4, it resumes from step 4 on retry, not from scratch
- **Multi-channel distribution**: Single agent distributes to Slack, email, spreadsheet, and wiki simultaneously
