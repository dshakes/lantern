# @lantern/sdk

The official TypeScript SDK for [Lantern](https://github.com/dshakes/lantern) — the open-source runtime for production AI agents with VPC deployment, pre-run cost forecasts, policy budgets, and eval-in-CI.

```bash
npm install @lantern/sdk
```

## Quick start

```ts
import { LanternClient } from "@lantern/sdk";

const lantern = new LanternClient({
  apiKey: process.env.LANTERN_API_KEY,
  baseURL: process.env.LANTERN_API_URL, // defaults to https://api.lantern.run
});

// 1. Create an agent
await lantern.agents.create({
  name: "triage",
  description: "Classifies support emails",
});

// 2. Hard-cap spend
await lantern.budgets.upsert("triage", {
  maxCostUsdPerDay: 25,
  maxCostUsdPerRun: 0.10,
  hardFail: true, // returns HTTP 402 on over-budget
});

// 3. Forecast before dispatch
const forecast = await lantern.runs.forecast({
  agentName: "triage",
  input: "invoice is wrong",
});
// { estimatedCostUsd: 0.018, confidence: 0.86, wouldExceedBudget: false, ... }

// 4. Run
const run = await lantern.runs.create({
  agentName: "triage",
  input: { email: "..." },
});
```

## The wedge

| | |
|---|---|
| `lantern.runs.forecast(...)` | Pre-run cost + confidence. HTTP 402 if a hard-fail budget would be exceeded. |
| `lantern.budgets.upsert(...)` | Policy-as-code: per-day cost, per-run cost, tokens/day, per-tool rate limits. |
| `lantern.evalSuites.upsert(...)` + `lantern.evalRuns.record(...)` | Declarative eval suites. Record returns `{ regressed: true }` when the score drops below branch baseline. Pairs with `lantern test --against=last-green` in CI. |
| `lantern.experiments.create(...)` | Deterministic A/B splits. Auto-promote on >2% lift. |
| `lantern.marketplace.*` | Publish / fork / star agents across tenants. |

## Surfaces

- **`@lantern/sdk`** — HTTP client (this package)
- **`@lantern/sdk/runtime`** — in-process agent runtime (run an agent locally, or inside a microVM)
- **`@lantern/sdk/runner`** — CLI entrypoint used by the runtime manager to execute bundled agents
- **`@lantern/sdk/connectors`** — typed wrappers for the 17 first-party API connectors (Gmail, Slack, Linear, Stripe, …)

## Building an agent

```ts
import { agent, step, tool } from "@lantern/sdk";
import { z } from "zod";

const classify = tool({
  name: "classify",
  description: "Classify an email",
  input: z.object({ subject: z.string(), body: z.string() }),
  async run({ subject, body }) {
    return { label: "billing" }; // your logic
  },
});

export default agent({
  name: "triage",
  model: "auto", // capability alias, resolved by the model router
  tools: [classify],
  async handle({ input, ctx }) {
    const label = await step("classify", () =>
      classify.run(input),
    );
    return { ...label };
  },
});
```

Every `step()` is durable — retried on failure, replayed on resume, metered for cost attribution.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `LANTERN_API_URL` | `https://api.lantern.run` | Control-plane base URL |
| `LANTERN_API_KEY` | — | API key (required) |
| `LANTERN_TENANT_ID` | — | Optional tenant override (enterprise multi-tenant) |

## License

Apache 2.0.
