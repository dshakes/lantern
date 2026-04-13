export default function GettingStartedPage() {
  return (
    <>
      <h1>Getting Started with Lantern</h1>
      <p>
        Lantern is a <strong>serverless platform for production AI agents</strong>. It
        gives you durable workflow execution, microVM isolation, multi-LLM routing, and
        streaming-first APIs -- all packaged into an SDK, CLI, and dashboard you can
        self-host on any cloud.
      </p>

      <h2>Who is Lantern for?</h2>
      <p>
        Lantern is built for engineers who need to move AI agents from prototype to
        production. If you have ever built an agent with LangChain or the OpenAI API
        and then spent weeks adding retries, state persistence, sandboxing, and
        monitoring -- Lantern replaces all of that.
      </p>
      <ul>
        <li>
          <strong>Product engineers</strong> who want to ship an AI feature in their
          app without building agent infrastructure from scratch.
        </li>
        <li>
          <strong>Platform teams</strong> who need a secure, multi-tenant runtime for
          internal AI tools.
        </li>
        <li>
          <strong>Solo builders</strong> who want a personal AI assistant that runs
          durably across WhatsApp, Slack, email, and more.
        </li>
      </ul>

      <h2>3-minute overview</h2>
      <p>
        A Lantern agent is a function that receives input and uses <strong>durable
        steps</strong> to call LLMs, APIs, and tools. Each step is journaled -- if
        your process crashes mid-run, it resumes from the last completed step, not
        the beginning.
      </p>
      <pre>
        <code>{`import { agent, step } from "@lantern/sdk";

export default agent({
  name: "research-agent",
  model: "auto",  // routes to the best model for each task

  async run({ input, ctx }) {
    // Step 1: Plan (uses a cheap model)
    const queries = await step("plan", async () => {
      return ctx.llm.json({
        prompt: \`Research queries for: \${input.topic}\`,
        capability: "reasoning-small",
      });
    });

    // Step 2: Search in parallel (fan-out)
    const results = await step.map("search", queries, async (q) => {
      return ctx.tools.web.search(q);
    });

    // Step 3: Synthesize with a powerful model
    return step("synthesize", async () => {
      return ctx.llm.complete({
        messages: [{ role: "user", content: formatResults(results) }],
        capability: "reasoning-large",
      });
    });
  },
});`}</code>
      </pre>

      <p>
        Agents are deployed to <strong>Firecracker microVMs</strong> with 150ms warm
        starts. The <strong>model router</strong> maps capability names like{" "}
        <code>&quot;reasoning-small&quot;</code> to concrete vendor models (Claude Haiku,
        GPT-4o-mini, etc.) and fails over across providers automatically.
      </p>

      <p>
        You can drive agents from <strong>11 built-in communication surfaces</strong>:
        WhatsApp, Slack, Discord, Telegram, email, voice calls, SMS, web chat, CLI,
        REST API, and iMessage.
      </p>

      <h2>Core concepts</h2>
      <ul>
        <li>
          <strong>Agents</strong> -- units of work with instructions, a model, and
          connected tools/connectors.
        </li>
        <li>
          <strong>Steps</strong> -- durable, idempotent units inside a run. Steps
          survive crashes and replay on resume.
        </li>
        <li>
          <strong>Connectors</strong> -- integrations with external services (Gmail,
          GitHub, Slack) that agents can use as tools.
        </li>
        <li>
          <strong>Surfaces</strong> -- communication channels where users interact
          with agents (WhatsApp, web chat, etc.).
        </li>
        <li>
          <strong>Model Router</strong> -- maps capability names to concrete LLM
          models, with automatic failover and cost optimization.
        </li>
      </ul>

      <h2>What&apos;s next?</h2>
      <p>
        Head to the <a href="/quickstart">Quick Start</a> guide to get a local dev
        environment running in under 5 minutes, or jump straight to{" "}
        <a href="/agents">Agents</a> to learn how to create and configure agents.
      </p>
    </>
  );
}
