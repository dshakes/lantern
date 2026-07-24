import { Concept } from "../_components/Concept";

export default function SdkReferencePage() {
  return (
    <>
      <h1>SDK Reference</h1>
      <p>
        Lantern ships a TypeScript SDK (<code>@lantern/sdk</code>) and a Python
        SDK (<code>lantern</code>). Both cover the full management surface —
        agents, runs, sessions, connectors, budgets, evals, experiments,
        marketplace, MCP, receipts, feedback, and rehearsals.
      </p>

      <Concept>
        The SDK is the same Lantern API you&apos;ve seen in these docs, wrapped
        in a typed library so you call <code>client.runs.create(...)</code>{" "}
        from your own code instead of hand-writing HTTP requests. Everything
        the dashboard can do, the SDK can do — use it to trigger agents from
        your app, wire runs into your backend, or script bulk operations.
      </Concept>

      <h2 id="typescript">TypeScript SDK</h2>

      <h3>Installation</h3>
      <pre>
        <code>{`npm install @lantern/sdk`}</code>
      </pre>

      <h3>Client setup</h3>
      <pre>
        <code>{`import { LanternClient } from "@lantern/sdk";

const client = new LanternClient({
  apiKey: process.env.LANTERN_API_KEY,   // hlx_live_...
  baseUrl: process.env.LANTERN_API_URL,  // http://localhost:8080 for self-hosted
});`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>Environment variables.</strong> The SDK reads{" "}
        <code>LANTERN_API_KEY</code> and <code>LANTERN_API_URL</code>{" "}
        automatically when no options are passed to the constructor.{" "}
        <code>LANTERN_RUNTIME</code> selects the runtime tier for runs. There
        is no <code>LANTERN_BASE_URL</code>.
      </div>

      <h3>Creating and streaming a run</h3>
      <pre>
        <code>{`// Create a run
const run = await client.runs.create({
  agentName: "research-agent",
  input: { topic: "quantum computing" },
});

console.log(run.id, run.status); // queued

// Stream events for the run
for await (const event of client.runs.stream(run.id)) {
  console.log(event.kind, event.stepId, event.payload);
  // kinds: step_started, step_completed, step_failed, step_retrying, step_waiting
}

// Fetch final result
const finished = await client.runs.get(run.id);
console.log(finished.status, finished.output);`}</code>
      </pre>

      <h3>Interactive sessions</h3>
      <pre>
        <code>{`// Create a session
const session = await client.sessions.create({ agent: "my-agent" });

// Stream a message turn
for await (const chunk of client.sessions.streamMessage(session.id, {
  content: "What is the capital of France?",
})) {
  // chunk has: kind ("message_delta" | "message_completed" | "message_error")
  if (chunk.kind === "message_delta") process.stdout.write(chunk.delta);
  if (chunk.kind === "message_completed") console.log("\nDone:", chunk.usage);
}

// Non-streaming send
const reply = await client.sessions.sendMessage(session.id, {
  content: "Follow-up question",
});

// Cleanup
await client.sessions.delete(session.id);`}</code>
      </pre>

      <h3>All namespaces</h3>
      <pre>
        <code>{`client.agents          // create, get, list, delete, generateSpec, generateCode
client.runs            // create, get, list, stream, forecast
client.sessions        // create, get, list, sendMessage, streamMessage, stop, delete
client.connectors      // install, list, execute, test, uninstall
client.budgets         // upsert, get, list, delete
client.experiments     // create, get, list, record, conclude
client.evals           // createSuite, getSuite, listSuites, createRun, listRuns, setBaseline
client.marketplace     // list, get, publish, fork, star, unstar
client.mcp             // listServers, getServer, attach, listAttachments, detach
client.receipts        // issue, verify
client.feedback        // submit, list, summary
client.rehearsals      // create`}</code>
      </pre>

      <h3>Error handling</h3>
      <pre>
        <code>{`import { LanternError, MessageStreamError } from "@lantern/sdk";

try {
  const run = await client.runs.create({ agentName: "my-agent", input: {} });
} catch (err) {
  if (err instanceof LanternError) {
    console.error(err.status, err.message);
  }
}

// Errors during a session stream
try {
  for await (const chunk of client.sessions.streamMessage(id, { content: "hi" })) {
    // ...
  }
} catch (err) {
  if (err instanceof MessageStreamError) {
    console.error("stream error:", err.message);
  }
}`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>No <code>@lantern/retry</code> package yet.</strong> The SDK
        handles HTTP 429 / 503 retries internally with bounded exponential
        backoff (<code>LANTERN_BRIDGE_RETRY_ATTEMPTS</code> /
        <code>LANTERN_BRIDGE_RETRY_MAX_MS</code>). A standalone{" "}
        <code>@lantern/retry</code> package is planned but does not exist — do
        not import it.
      </div>

      <h2 id="python">Python SDK</h2>

      <div className="callout callout-warning">
        <strong>Status.</strong> The Python SDK covers the full management
        surface at parity with the TypeScript SDK. The agent runtime context (
        <code>AgentContext</code>, durable <code>step()</code>, and{" "}
        <code>ctx.llm</code>) raises <code>NotImplementedError</code>—that
        wiring is a separate effort. Not yet published to PyPI; install from
        the repo.
      </div>

      <h3>Installation</h3>
      <pre>
        <code>{`pip install ./packages/sdk-python`}</code>
      </pre>

      <h3>Client setup</h3>
      <pre>
        <code>{`from lantern import LanternClient

client = LanternClient(
    api_key="hlx_live_your_key",   # or LANTERN_API_KEY env var
    base_url="http://localhost:8080",  # or LANTERN_API_URL env var
)`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>Sync only.</strong> There is no <code>AsyncLanternClient</code>{" "}
        — the Python SDK is synchronous. Use threads or a process pool if you
        need concurrency.
      </div>

      <h3>Creating a run</h3>
      <pre>
        <code>{`run = client.runs.create(agent_name="research-agent", input={"topic": "AI safety"})
print(run.id, run.status)  # queued`}</code>
      </pre>

      <h3>All namespaces</h3>
      <pre>
        <code>{`client.agents          # create, get, list, delete
client.runs            # create, get, list, forecast
client.sessions        # create, get, list, send_message, stop, delete
client.connectors      # install, list, execute, test, uninstall
client.budgets         # upsert, get, list, delete
client.evals           # create_suite, list_suites, create_run, set_baseline
client.experiments     # create, record, conclude
client.marketplace     # list, get, publish, fork, star
client.mcp             # list_servers, attach, list_attachments, detach
client.receipts        # issue, verify
client.feedback        # submit, list, summary
client.rehearsals      # create`}</code>
      </pre>

      <h3>Example: list agents</h3>
      <pre>
        <code>{`agents = client.agents.list()
for agent in agents:
    print(agent.name, agent.current_version_id)`}</code>
      </pre>

      <h2 id="agent-runtime">Agent runtime (TypeScript)</h2>
      <p>
        Inside an agent bundle, the runtime context gives you durable steps,
        LLM calls, connector access, and more:
      </p>
      <pre>
        <code>{`import { agent, step } from "@lantern/sdk";

export default agent({
  name: "my-agent",
  model: "auto",

  async run({ input, ctx }) {
    // Durable step — journaled, idempotent, resumable on crash
    const data = await step("fetch-data", async () => {
      return ctx.tools.web.search(input.query);
    });

    // LLM call — routed by capability, never hardcoded to a vendor
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

      <div className="callout callout-info">
        <strong>Model capability strings.</strong> Use capability names like{" "}
        <code>auto</code>, <code>reasoning-large</code>,{" "}
        <code>chat-small</code>, <code>vision-large</code> — never a specific
        model like <code>gpt-4o</code> or <code>claude-3-opus</code>. The model
        router resolves the best available model at runtime. See the{" "}
        <a href="/models">Models</a> page for the full capability list.
      </div>

      <h3>Parallel fan-out</h3>
      <pre>
        <code>{`const results = await step.map("search", queries, async (query) => {
  return ctx.tools.web.search(query);
});`}</code>
      </pre>

      <h3>Human approval</h3>
      <pre>
        <code>{`const approved = await ctx.human.requestApproval({
  message: "Send this email to 500 users?",
  timeout: "30m",  // goroutine is released while waiting — no compute cost
});

if (!approved) return { status: "cancelled" };`}</code>
      </pre>
    </>
  );
}
