export default function SdkReferencePage() {
  return (
    <>
      <h1>SDK Reference</h1>
      <p>
        Lantern provides official SDKs for TypeScript and Python. The SDKs give
        you type-safe access to agent creation, durable steps, LLM calls, and
        streaming -- all with built-in retry logic and error handling.
      </p>

      <h2 id="typescript">TypeScript SDK</h2>

      <h3>Installation</h3>
      <pre>
        <code>{`npm install @lantern/sdk`}</code>
      </pre>

      <h3>Creating an agent</h3>
      <pre>
        <code>{`import { agent, step } from "@lantern/sdk";

export default agent({
  name: "my-agent",
  model: "auto",

  async run({ input, ctx }) {
    // Durable step -- survives crashes
    const data = await step("fetch-data", async () => {
      return ctx.tools.web.search(input.query);
    });

    // LLM call with capability routing
    const summary = await step("summarize", async () => {
      return ctx.llm.complete({
        messages: [{ role: "user", content: \`Summarize: \${data}\` }],
        capability: "reasoning-small",
      });
    });

    return { summary };
  },
});`}</code>
      </pre>

      <h3>Durable steps</h3>
      <p>
        Steps are the core primitive. Each step is journaled, idempotent, and
        resumable:
      </p>
      <pre>
        <code>{`// Simple step
const result = await step("step-name", async () => {
  return someExpensiveOperation();
});

// Parallel fan-out
const results = await step.map("search", queries, async (query) => {
  return ctx.tools.web.search(query);
});

// Conditional step
const approved = await step("check-approval", async () => {
  return ctx.human.requestApproval({
    message: "Send this email?",
    timeout: "24h",
  });
});`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>Note:</strong> Steps must be deterministic in their scheduling.
        The same run with the same input must produce the same sequence of step
        names. Do not use random values or timestamps in step names.
      </div>

      <h3>LLM calls</h3>
      <pre>
        <code>{`// Text completion
const text = await ctx.llm.complete({
  messages: [{ role: "user", content: "Explain quantum computing" }],
  capability: "reasoning-large",
});

// Structured JSON output
const data = await ctx.llm.json({
  prompt: "Extract entities from this text: ...",
  schema: {
    type: "object",
    properties: {
      people: { type: "array", items: { type: "string" } },
      places: { type: "array", items: { type: "string" } },
    },
  },
  capability: "reasoning-small",
});

// Streaming
const stream = await ctx.llm.stream({
  messages: [{ role: "user", content: "Write a poem" }],
  capability: "reasoning-small",
});

for await (const token of stream) {
  process.stdout.write(token);
}`}</code>
      </pre>

      <h3>Tool usage</h3>
      <pre>
        <code>{`// Connectors are available as typed tools
const emails = await ctx.tools.gmail.search({
  query: "from:boss@company.com is:unread",
});

const issue = await ctx.tools.github.createIssue({
  repo: "org/repo",
  title: "Bug report",
  body: "Details...",
});

// Web tools
const results = await ctx.tools.web.search("lantern ai platform");
const page = await ctx.tools.web.scrape("https://example.com");`}</code>
      </pre>

      <h3>Human-in-the-loop</h3>
      <pre>
        <code>{`// Request approval before a sensitive action
const approved = await ctx.human.requestApproval({
  message: "About to send email to 500 users. Proceed?",
  timeout: "1h",  // auto-reject if no response
  channel: "slack", // where to send the approval request
});

if (!approved) {
  return { status: "cancelled", reason: "Human rejected" };
}`}</code>
      </pre>

      <h3>Client usage</h3>
      <pre>
        <code>{`import { LanternClient } from "@lantern/sdk";

const client = new LanternClient({
  apiKey: process.env.LANTERN_API_KEY,
  baseUrl: "https://api.lantern.run", // optional, defaults to this
});

// Create a run
const run = await client.agents.run("research-agent", {
  input: { topic: "quantum computing" },
});

// Stream events
for await (const event of run.stream()) {
  if (event.type === "token") {
    process.stdout.write(event.content);
  } else if (event.type === "step.complete") {
    console.log(\`Step \${event.step} completed in \${event.duration_ms}ms\`);
  }
}

// Get final result
const result = await run.result();`}</code>
      </pre>

      <h2 id="python">Python SDK</h2>

      <div className="callout callout-warning">
        <strong>Status:</strong> The Python SDK covers the full management surface
        (agents, runs, sessions, connectors, budgets, evals, experiments, marketplace,
        MCP, receipts, feedback, rehearsals) at parity with the TypeScript SDK.
        The agent runtime context (<code>AgentContext</code>, durable <code>step()</code>,
        and <code>ctx.llm</code>) is not yet implemented -- those raise
        <code>NotImplementedError</code>. The package is installed from the repository;
        it is not yet published to PyPI.
      </div>

      <h3>Installation</h3>
      <pre>
        <code>{`# Install from the repository (not yet on PyPI)
pip install ./packages/sdk-python`}</code>
      </pre>

      <h3>Creating an agent</h3>
      <pre>
        <code>{`from lantern import agent, step

@agent(name="my-agent", model="auto")
async def my_agent(input, ctx):
    # Durable step
    data = await step("fetch-data", lambda: ctx.tools.web.search(input["query"]))

    # LLM call
    summary = await step("summarize", lambda: ctx.llm.complete(
        messages=[{"role": "user", "content": f"Summarize: {data}"}],
        capability="reasoning-small",
    ))

    return {"summary": summary}`}</code>
      </pre>

      <h3>Client usage</h3>
      <pre>
        <code>{`from lantern import LanternClient

client = LanternClient(api_key="lnt_your_key")

# Create and stream a run
run = client.agents.run("research-agent", input={"topic": "quantum computing"})

for event in run.stream():
    if event.type == "token":
        print(event.content, end="", flush=True)
    elif event.type == "step.complete":
        print(f"\\nStep {event.step} completed in {event.duration_ms}ms")

# Get the final result
result = run.result()
print(result)`}</code>
      </pre>

      <h3>Async support</h3>
      <pre>
        <code>{`import asyncio
from lantern import AsyncLanternClient

async def main():
    client = AsyncLanternClient(api_key="lnt_your_key")

    run = await client.agents.run("research-agent", input={"topic": "AI safety"})

    async for event in run.stream():
        if event.type == "token":
            print(event.content, end="", flush=True)

asyncio.run(main())`}</code>
      </pre>

      <div className="callout callout-tip">
        <strong>Tip:</strong> Both SDKs handle retries, streaming reconnection,
        and error handling automatically. You do not need to implement retry
        logic -- use the built-in <code>@lantern/retry</code> (TS) or the
        SDK&apos;s built-in retry behavior.
      </div>

      <h2>Configuration</h2>
      <p>
        Both SDKs can be configured via environment variables:
      </p>
      <pre>
        <code>{`LANTERN_API_KEY=lnt_your_key        # Required
LANTERN_BASE_URL=https://api.lantern.run  # Optional, for self-hosted
LANTERN_TIMEOUT=30000               # Request timeout in ms (default: 30s)
LANTERN_MAX_RETRIES=3               # Max retries on failure (default: 3)`}</code>
      </pre>

      <h2>Error handling</h2>
      <pre>
        <code>{`// TypeScript
import { LanternError, RateLimitError } from "@lantern/sdk";

try {
  const run = await client.agents.run("my-agent", { input: {} });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(\`Rate limited. Retry after \${error.retryAfter}s\`);
  } else if (error instanceof LanternError) {
    console.log(\`API error: \${error.code} - \${error.message}\`);
  }
}`}</code>
      </pre>

      <pre>
        <code>{`# Python
from lantern.errors import LanternError, RateLimitError

try:
    run = client.agents.run("my-agent", input={})
except RateLimitError as e:
    print(f"Rate limited. Retry after {e.retry_after}s")
except LanternError as e:
    print(f"API error: {e.code} - {e.message}")`}</code>
      </pre>
    </>
  );
}
