# @pal-runtime/sdk

The official TypeScript SDK for [PAL Runtime](https://github.com/dshakes/pal) (Personal Agentic Layer) — the open-source runtime for production AI agents with VPC deployment, pre-run cost forecasts, policy budgets, and eval-in-CI.

Registry packages are not published yet: `npm install @pal-runtime/sdk` fails. Install from a checkout of the repo:

```bash
( cd packages/sdk-ts && npm install && npm run build )
npm install /path/to/pal/packages/sdk-ts      # in your project
```

> **Renamed (ADR 0032).** This package was `@pal/sdk`. `PalClient`, `PalApiError`, `PalRuntime` and every `PAL*Error` remain as **deprecated aliases** of the `Pal*` names (same class objects, so `instanceof` works across both). The `pal-run` bin is kept next to `pal-run`. `PAL_*` env vars are still read as a fallback when the `PAL_*` name is unset.

## Quick start

```ts
import { PalClient } from "@pal-runtime/sdk";

const pal = new PalClient({
  apiKey: process.env.PAL_API_KEY,
  baseURL: process.env.PAL_API_URL, // defaults to https://api.pal.run
});

// 1. Create an agent
await pal.agents.create({
  name: "triage",
  description: "Classifies support emails",
});

// 2. Hard-cap spend
await pal.budgets.upsert("triage", {
  maxCostUsdPerDay: 25,
  maxCostUsdPerRun: 0.10,
  hardFail: true, // returns HTTP 402 on over-budget
});

// 3. Forecast before dispatch
const forecast = await pal.runs.forecast({
  agentName: "triage",
  input: "invoice is wrong",
});
// { estimatedCostUsd: 0.018, confidence: 0.86, wouldExceedBudget: false, ... }

// 4. Run
const run = await pal.runs.create({
  agent: "triage",
  input: { email: "..." },
});
```

## The wedge

| | |
|---|---|
| `pal.runs.forecast(...)` | Pre-run cost + confidence. HTTP 402 if a hard-fail budget would be exceeded. |
| `pal.budgets.upsert(...)` | Policy-as-code: per-day cost, per-run cost, tokens/day, per-tool rate limits. |
| `pal.evalSuites.upsert(...)` + `pal.evalRuns.record(...)` | Declarative eval suites. Record returns `{ regressed: true }` when the score drops below branch baseline. Pairs with `pal test --against=last-green` in CI. |
| `pal.experiments.create(...)` | Deterministic A/B splits. Auto-promote on >2% lift. |
| `pal.marketplace.*` | Publish / fork / star agents across tenants. |
| `pal.sessions.*` | Interactive multi-turn agent sessions (create, send message, SSE events). |
| `pal.connectors.*` | Install, execute, and test first-party connector actions. |
| `pal.mcp.*` | Browse the curated MCP server registry and attach servers to an agent. |
| `pal.receipts.*` | Issue and verify Ed25519-signed proof-of-execution receipts. |
| `pal.feedback.*` | Submit and aggregate per-run RLHF reactions (1-5 score). |
| `pal.rehearsals.pull(...)` | Replay past failed/low-score runs as synthetic test cases before a merge. |

## Surfaces

- **`@pal-runtime/sdk`** — HTTP client (this package)
- **`@pal-runtime/sdk/runtime`** — in-process agent runtime (run an agent locally, or inside a microVM)
- **`@pal-runtime/sdk/runner`** — CLI entrypoint used by the runtime manager to execute bundled agents

## Building an agent

```ts
import { agent, step, tool } from "@pal-runtime/sdk";
import { z } from "zod";

export default agent({
  name: "triage",
  model: "auto", // capability alias, resolved by the model router
  tools: [tool.web], // built-in web search/fetch — see src/tools.ts for the full set
  async run({ input, ctx }) {
    // step() makes this call durable — retried on failure, replayed on
    // resume, metered for cost attribution.
    return step("classify", () =>
      ctx.llm.json({
        prompt: `Classify this support email: ${JSON.stringify(input)}`,
        schema: z.object({ label: z.string() }),
      }),
    );
  },
});
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PAL_API_URL` | `https://api.pal.run` | Control-plane base URL |
| `PAL_API_KEY` | — | API key (required) |
| `PAL_TENANT_ID` | — | Optional tenant override (enterprise multi-tenant) |

Each `PAL_*` variable falls back to its legacy `PAL_*` name.

## License

Apache 2.0.
