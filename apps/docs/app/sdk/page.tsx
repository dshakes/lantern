import Link from "next/link";
import { Concept } from "../_components/Concept";

export default function SdkReferencePage() {
  return (
    <>
      <h1>SDK Reference</h1>
      <p>
        Three SDKs: TypeScript (<code>@lantern/sdk</code>), Python (
        <code>lantern-sdk</code>, imported as <code>lantern</code>) and Go (
        <code>github.com/dshakes/lantern/packages/sdk-go</code>). They cover
        agents, runs, sessions, connectors, budgets, evals, experiments,
        marketplace, MCP, receipts, feedback, rehearsals and sandbox VMs. The
        TypeScript client has the most surface; the tables below list what each
        one really exposes.
      </p>

      <Concept>
        The SDKs wrap the <Link href="/api">REST API</Link> in typed methods, so
        you call <code>client.runs.create(...)</code> instead of writing HTTP.
        Use them to trigger agents from your app, wire runs into your backend,
        or script bulk operations.
      </Concept>

      <h2 id="typescript">TypeScript SDK</h2>

      <h3>Installation</h3>
      <div className="callout callout-warning">
        <strong>Registry packages are not published yet.</strong> <code>@lantern/sdk</code>{" "}
        is not on npm, so <code>npm install @lantern/sdk</code> fails. Install from a checkout.
      </div>
      <pre>
        <code>{`# in your checkout of github.com/dshakes/lantern
( cd packages/sdk-ts && npm install && npm run build )

# in your project: a file path, not the registry
npm install /path/to/lantern/packages/sdk-ts`}</code>
      </pre>
      <p>
        After that, <code>import &#123; LanternClient &#125; from &quot;@lantern/sdk&quot;</code> resolves to
        the built <code>dist/</code>. Rebuild after pulling changes.
      </p>

      <h3>Client setup</h3>
      <pre>
        <code>{`import { LanternClient } from "@lantern/sdk";

const client = new LanternClient({
  apiKey: process.env.LANTERN_API_KEY,   // hlx_live_...
  baseUrl: process.env.LANTERN_API_URL,  // e.g. http://localhost:8080
});`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>Environment variables.</strong> With no constructor options the
        SDK reads <code>LANTERN_API_KEY</code> and <code>LANTERN_API_URL</code>.
        If <code>LANTERN_API_URL</code> is unset, the base URL defaults to{" "}
        <code>https://api.lantern.run</code>, so set it for a self-hosted
        control plane. (<code>LANTERN_RUNTIME=true</code> is a different
        switch: the platform sets it inside a running agent to enable the
        production sidecar.)
      </div>

      <h3>Creating and streaming a run</h3>
      <pre>
        <code>{`import type { Run } from "@lantern/sdk";

// Create a run (create() returns an event stream instead when you pass stream: true)
const run = (await client.runs.create({
  agent: "research-agent",
  input: { topic: "quantum computing" },
})) as Run;

console.log(run.id, run.status); // queued

// Stream events for the run
for await (const event of client.runs.events(run.id)) {
  console.log(event.kind, event.stepId, event.data);
  // kinds include step_started, step_completed, step_failed, tool_call, tool_result, llm_delta, log, approval, end
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
  // chunk.type is "delta" | "completed"; a server-side message_error throws MessageStreamError
  if (chunk.type === "delta") process.stdout.write(chunk.delta);
  if (chunk.type === "completed") console.log("\nDone:", chunk.usage);
}

// Non-streaming send: returns immediately; the reply arrives on sessions.events()
await client.sessions.sendMessage(session.id, {
  content: "Follow-up question",
});

// Cleanup
await client.sessions.delete(session.id);`}</code>
      </pre>

      <h3>All namespaces</h3>
      <pre>
        <code>{`client.agents          // create, get, list, delete
client.runs            // create, get, list, cancel, events, signal, forecast
client.sessions        // create, get, list, sendMessage, streamMessage, events, stop, delete, close
client.connectors      // list, get, execute, test, uninstall
client.budgets         // upsert, get, list, delete
client.evalSuites      // upsert, list, get, delete
client.evalRuns        // record, list
client.evalBaselines   // set, get
client.experiments     // create, list, get, recordOutcome, conclude
client.marketplace     // list, get, publish, fork, star, unstar
client.mcp             // listServers, getServer, attach, listAttachments, detach
client.receipts        // issue, verify
client.feedback        // submit, listForRun, summaryForAgent
client.rehearsals      // pull
client.runtime         // schedule, list, get, terminate, exec, execStream, pause, resume, fork, listFiles, readFile, writeFile`}</code>
      </pre>

      <h3>Error handling</h3>
      <pre>
        <code>{`import { LanternApiError, MessageStreamError } from "@lantern/sdk";

try {
  await client.runs.create({ agent: "my-agent", input: {} });
} catch (err) {
  if (err instanceof LanternApiError) {
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
        <strong>Retries are built in.</strong> The TypeScript client retries HTTP
        429, 503 and network errors up to 3 attempts with full-jitter backoff
        (500 ms base, 4 s cap). It never retries other 4xx or 5xx. There is no
        separate <code>@lantern/retry</code> package.
      </div>

      <p>
        Sandbox VMs live under <code>client.runtime</code> in TypeScript and
        Python; Go has <code>ScheduleVM</code>, <code>PauseVM</code>,{" "}
        <code>ResumeVM</code>, <code>ForkVM</code>, <code>ListFiles</code>,{" "}
        <code>ReadFile</code> and <code>WriteFile</code>. See{" "}
        <Link href="/runtime/sandbox-lifecycle">Sandbox Lifecycle</Link>.
      </p>

      <h2 id="python">Python SDK</h2>

      <div className="callout callout-warning">
        <strong>Status.</strong> The Python management client is usable today.
        The in-agent runtime context (<code>ctx.llm</code>, <code>ctx.tools</code>,{" "}
        <code>ctx.mem</code> and the rest) raises <code>NotImplementedError</code>;
        write agent logic in TypeScript for now. Install from the repo: the{" "}
        <code>lantern-sdk</code> name on PyPI belongs to an unrelated project, so{" "}
        <code>pip install lantern-sdk</code> installs the wrong package.
      </div>

      <h3>Installation</h3>
      <pre>
        <code>{`# from the root of your checkout
pip install ./packages/sdk-python

# optional: LangChain deepagents sandbox backend (lantern.integrations.deepagents_sandbox)
pip install "./packages/sdk-python[deepagents]"`}</code>
      </pre>

      <h3>Client setup</h3>
      <pre>
        <code>{`from lantern import LanternClient

client = LanternClient(
    api_key="hlx_live_your_key",   # or LANTERN_API_KEY env var
    base_url="http://localhost:8080",  # or LANTERN_API_URL env var
)

# Request methods are coroutines: call from async code, or asyncio.run(main())`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>Async.</strong> <code>LanternClient</code> is built on{" "}
        <code>httpx.AsyncClient</code>: every request method is{" "}
        <code>async def</code>; <code>runs.events</code>,{" "}
        <code>sessions.stream_events</code> and{" "}
        <code>runtime.exec_stream</code> return async iterators (
        <code>async for</code>).
        Use <code>async with LanternClient(...) as client</code> or call{" "}
        <code>await client.close()</code>.
      </div>

      <h3>Creating a run</h3>
      <pre>
        <code>{`run = await client.runs.create(agent="research-agent", input={"topic": "AI safety"})
print(run.id, run.status)  # queued`}</code>
      </pre>

      <h3>All namespaces</h3>
      <pre>
        <code>{`client.agents          # create, get, list, delete
client.runs            # create, get, list, cancel, events, signal, forecast
client.sessions        # create, get, list, send_message, stream_events, stop, delete, close
client.connectors      # list, get, execute, list_actions
client.budgets         # upsert, get, delete, list_all
client.evals           # upsert_suite, list_suites, get_suite, delete_suite, record_run, list_runs, set_baseline, get_baseline
client.experiments     # create, list, get, record_outcome, conclude
client.marketplace     # list, get, publish, fork, star, unstar
client.mcp             # list_servers, get_server, attach, detach, list_attachments
client.receipts        # issue, verify
client.feedback        # submit, list_for_run, summary_for_agent
client.rehearsals      # pull
client.runtime         # schedule, list, get, terminate, exec, exec_stream, pause, resume, fork, list_files, read_file, write_file`}</code>
      </pre>

      <h3>Example: list agents</h3>
      <pre>
        <code>{`resp = await client.agents.list()
for agent in resp.agents:
    print(agent.name, agent.current_version_id)`}</code>
      </pre>

      <h2 id="agent-runtime">Agent runtime (TypeScript)</h2>
      <p>
        Inside an agent bundle, <code>ctx</code> gives you durable steps, LLM
        calls, tools, memory and connectors. Each <code>step</code> is
        journaled, so a crashed run resumes instead of restarting:
      </p>
      <pre>
        <code>{`import { agent, step } from "@lantern/sdk";

export default agent<{ query: string }>({
  name: "my-agent",
  model: "auto",

  async run({ input, ctx }) {
    // Durable step — journaled, idempotent, resumable on crash
    const data = await step("fetch-data", async () => {
      return ctx.tools.web.search(input.query);
    });

    // LLM call — addressed by capability; the model router picks the vendor model
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
        <code>chat-small</code>, <code>vision-large</code>. Don&apos;t hardcode
        a vendor model. The model router maps the capability to a concrete
        model at call time. See <Link href="/models">Models</Link> for the full list.
      </div>

      <h3>Parallel fan-out</h3>
      <pre>
        <code>{`const results = await step.map("search", queries, async (query) => {
  return ctx.tools.web.search(query);
});`}</code>
      </pre>

      <h3>Human approval</h3>
      <pre>
        <code>{`// Blocks until a human grants or denies.
await ctx.approval.request({
  reason: "Send this email to 500 users?",
  expiresAt: "2026-12-01T00:00:00Z",
});
// Reaching this line means it was granted. Denial or timeout throws LanternError.`}</code>
      </pre>
    </>
  );
}
