export default function AgentsPage() {
  return (
    <>
      <h1>Agents</h1>
      <p>
        Agents are the core unit of work in Lantern. An agent is a durable
        function that receives input, executes a series of steps (LLM calls,
        tool invocations, API requests), and produces output. This page covers
        how to create, configure, test, run, and schedule agents.
      </p>

      <h2>Creating an agent</h2>
      <p>
        There are three ways to create an agent from the dashboard:
      </p>

      <h3>1. AI-assisted creation</h3>
      <p>
        Describe what you want the agent to do in plain English. Lantern uses
        an LLM to generate the agent configuration, system prompt, and tool
        selection for you.
      </p>
      <p>
        Navigate to <strong>Agents &gt; New Agent</strong> and select{" "}
        <strong>AI-assisted</strong>. Enter a description like:
      </p>
      <pre>
        <code>{`Monitor my GitHub repositories for new issues labeled "bug",
triage them by severity, and post a summary to Slack every morning.`}</code>
      </pre>
      <p>
        The AI will propose a name, system prompt, model capability, connected
        tools, and a schedule. Review and adjust before creating.
      </p>
      <p>[Screenshot: AI-assisted agent creation wizard]</p>

      <h3>2. Manual creation</h3>
      <p>
        For full control, use the manual creation form. You configure each field
        yourself:
      </p>
      <ul>
        <li>
          <strong>Name</strong> -- a unique identifier (lowercase, hyphens
          allowed)
        </li>
        <li>
          <strong>Description</strong> -- what this agent does (shown in the
          dashboard)
        </li>
        <li>
          <strong>System prompt</strong> -- the instructions the LLM follows
        </li>
        <li>
          <strong>Model</strong> -- the capability to use (e.g., &quot;auto&quot;,
          &quot;reasoning-large&quot;)
        </li>
        <li>
          <strong>Connectors</strong> -- which external services the agent can
          access
        </li>
        <li>
          <strong>Privacy level</strong> -- controls data handling (standard,
          strict, paranoid)
        </li>
      </ul>

      <h3>3. From a template</h3>
      <p>
        Lantern ships with built-in templates for common use cases: research
        agent, customer support, CI/CD guardian, and more. Select a template
        and customize it.
      </p>
      <pre>
        <code>{`# From the CLI:
lantern init my-agent --template research`}</code>
      </pre>

      <h2>Configuring an agent</h2>

      <h3>Instructions and system prompt</h3>
      <p>
        The system prompt is the most important configuration. It tells the LLM
        what role to play, what tools it has access to, and how to behave. Write
        clear, specific instructions:
      </p>
      <pre>
        <code>{`You are a research assistant. When given a topic:
1. Generate 3-5 search queries
2. Search the web for each query
3. Read the top 3 results for each
4. Synthesize findings into a structured report with citations

Always cite your sources. If you cannot find reliable information,
say so rather than making things up.`}</code>
      </pre>

      <div className="callout callout-warning">
        <strong>Warning:</strong> Avoid vague instructions like &quot;be
        helpful&quot;. The more specific your system prompt, the more reliable
        your agent will be in production.
      </div>

      <h3>Model selection</h3>
      <p>
        Lantern uses <strong>capability-based routing</strong> instead of
        hardcoded model names. This means your agent code never references
        &quot;gpt-4&quot; or &quot;claude-3&quot; directly. Instead, you specify what
        kind of capability you need:
      </p>
      <ul>
        <li>
          <code>&quot;auto&quot;</code> -- Lantern picks the best model for each
          step based on complexity and cost
        </li>
        <li>
          <code>&quot;reasoning-large&quot;</code> -- a powerful reasoning model
          (maps to Opus, GPT-5, etc.)
        </li>
        <li>
          <code>&quot;reasoning-small&quot;</code> -- a fast, cheap model for
          simple tasks (maps to Haiku, GPT-4o-mini, etc.)
        </li>
        <li>
          <code>&quot;code&quot;</code> -- optimized for code generation
        </li>
        <li>
          <code>&quot;vision&quot;</code> -- models that understand images
        </li>
      </ul>
      <p>
        See <a href="/models">Models</a> for a full list of capabilities and
        how to configure providers.
      </p>

      <h2>Testing an agent</h2>
      <p>
        Every agent has a <strong>Playground</strong> tab in the dashboard. The
        playground lets you:
      </p>
      <ul>
        <li>Send test inputs and see streaming output in real time</li>
        <li>Inspect each step as it executes (timing, model used, tokens)</li>
        <li>Adjust the system prompt and re-run immediately</li>
        <li>View the full event stream and step trace</li>
      </ul>
      <p>
        You can also run agents from the CLI for scripted testing:
      </p>
      <pre>
        <code>{`lantern run my-agent \\
  --input '{"topic": "quantum computing"}' \\
  --stream`}</code>
      </pre>

      <h2>Running agents</h2>
      <p>Agents can be triggered in several ways:</p>
      <ul>
        <li>
          <strong>Dashboard playground</strong> -- manual runs for testing
        </li>
        <li>
          <strong>CLI</strong> -- <code>lantern run &lt;agent&gt;</code>
        </li>
        <li>
          <strong>REST API</strong> -- <code>POST /api/agents/:name/runs</code>
        </li>
        <li>
          <strong>Schedule</strong> -- cron-based recurring runs
        </li>
        <li>
          <strong>Surfaces</strong> -- triggered by messages on WhatsApp, Slack,
          etc.
        </li>
        <li>
          <strong>Webhooks</strong> -- triggered by external events (GitHub push,
          Stripe event, etc.)
        </li>
      </ul>

      <h2>Scheduling agents</h2>
      <p>
        You can schedule agents to run on a cron expression. See the{" "}
        <a href="/scheduling">Scheduling</a> page for details on cron syntax,
        AI-assisted scheduling, and email delivery of results.
      </p>

      <h2>Agent lifecycle</h2>
      <p>
        Each agent run goes through these states:
      </p>
      <ol>
        <li>
          <strong>Queued</strong> -- the run is waiting to be picked up
        </li>
        <li>
          <strong>Running</strong> -- steps are actively executing
        </li>
        <li>
          <strong>Completed</strong> -- all steps finished successfully
        </li>
        <li>
          <strong>Failed</strong> -- a step failed after exhausting retries
        </li>
        <li>
          <strong>Cancelled</strong> -- manually stopped by the user
        </li>
      </ol>
      <p>
        Because Lantern uses durable execution, a run that crashes mid-step
        will automatically resume from the last completed step when the
        infrastructure recovers.
      </p>

      <div className="callout callout-info">
        <strong>Note:</strong> Each step is idempotent and journaled. Side
        effects (API calls, webhooks) carry an idempotency key derived from the
        run ID, step ID, and attempt number to prevent duplicate actions.
      </div>
    </>
  );
}
