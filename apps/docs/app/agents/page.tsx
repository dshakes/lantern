import Link from "next/link";
import { Concept } from "../_components/Concept";

export default function AgentsPage() {
  return (
    <>
      <h1>Agents</h1>
      <p>
        An agent takes input, works through steps (LLM calls, tool calls, API
        requests) and returns output. Every step is journaled, so a crashed
        run resumes where it stopped. This page covers creating, configuring,
        testing, running and scheduling agents.
      </p>

      <Concept>
        An agent is a job description for an AI: who it is, what it may use,
        how it behaves. Run it on demand, on a schedule, or from a chat
        message. Lantern records every step. If the process dies mid-task, the
        run resumes from the journal instead of starting over.
      </Concept>

      <h2 id="create">Creating an agent</h2>
      <p>
        Three ways to create an agent in the dashboard:
      </p>

      <h3>1. AI-assisted creation</h3>
      <p>
        Describe what you want the agent to do in plain English. Lantern
        drafts the configuration, system prompt and tool selection for you.
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
        You review and edit the draft before anything is created.
      </p>

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
          <strong>Privacy level</strong> -- <code>standard</code> (encrypted at
          rest), <code>private</code> (end-to-end encrypted) or{" "}
          <code>audit</code> (full audit trail)
        </li>
      </ul>

      <h3>3. From a template</h3>
      <p>
        Pick a template in the dashboard and edit it. The CLI scaffolds from
        seven starters: <code>basic</code>, <code>research</code>,{" "}
        <code>tool-use</code>, <code>connector</code>, <code>personal</code>,{" "}
        <code>scheduled</code> and <code>approval</code>.
      </p>
      <pre>
        <code>{`lantern init my-agent --template research`}</code>
      </pre>

      <h2>Configuring an agent</h2>

      <h3 id="instructions">Instructions and system prompt</h3>
      <p>
        The system prompt does most of the work. State the role, the steps and
        the failure behavior:
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
        <strong>Warning:</strong> &quot;Be helpful&quot; is not an instruction.
        Specific steps and explicit failure behavior make agents reliable.
      </div>

      <h3>Model selection</h3>
      <p>
        Agents ask for a <strong>capability</strong>, not a vendor model. The
        model router maps it to a concrete model at call time:
      </p>
      <ul>
        <li>
          <code>&quot;auto&quot;</code> -- Lantern picks the best model for each
          step based on complexity and cost
        </li>
        <li>
          <code>&quot;reasoning-large&quot;</code> -- a large reasoning model
        </li>
        <li>
          <code>&quot;reasoning-small&quot;</code> -- a small, cheaper reasoning
          model
        </li>
        <li>
          <code>&quot;code-large&quot;</code> / <code>&quot;code-small&quot;</code> -- optimized
          for code generation
        </li>
        <li>
          <code>&quot;vision-large&quot;</code> / <code>&quot;vision-small&quot;</code> -- models
          that understand images
        </li>
      </ul>
      <p>
        See <Link href="/models">Models</Link> for a full list of capabilities and
        how to configure providers.
      </p>

      <h2 id="testing">Testing an agent</h2>
      <p>
        Every agent has a <strong>Chat</strong> tab in the dashboard (next to
        Build, Runs, Schedule and Settings). It lets you:
      </p>
      <ul>
        <li>Send test inputs and see streaming output in real time</li>
        <li>Inspect each step as it executes (timing, model used, tokens)</li>
        <li>View the full event stream and step trace on the Runs tab</li>
      </ul>
      <p>
        From the CLI:
      </p>
      <pre>
        <code>{`lantern runs create --agent my-agent \\
  --input '{"topic": "quantum computing"}' \\
  --stream`}</code>
      </pre>

      <h2 id="chat">Running agents</h2>
      <p>Agents can be triggered in several ways:</p>
      <ul>
        <li>
          <strong>Dashboard</strong> -- manual runs for testing
        </li>
        <li>
          <strong>CLI</strong> -- <code>lantern runs create --agent &lt;name&gt;</code>
        </li>
        <li>
          <strong>REST API</strong> -- <code>POST /v1/runs</code> (with <code>agentName</code> in the body)
        </li>
        <li>
          <strong>Schedule</strong> -- cron-based recurring runs
        </li>
        <li>
          <strong>Surfaces</strong> -- triggered by messages on WhatsApp,
          Slack, Telegram or webchat
        </li>
      </ul>

      <h2 id="visual">Scheduling agents</h2>
      <p>
        Run an agent on a cron expression. See{" "}
        <Link href="/scheduling">Scheduling</Link>.
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
          <strong>Succeeded</strong> -- all steps finished successfully
        </li>
        <li>
          <strong>Failed</strong> -- a step failed after exhausting retries
        </li>
        <li>
          <strong>Cancelled</strong> -- manually stopped by the user
        </li>
      </ol>
      <p>
        A run that crashes mid-step is picked up by the recovery sweep (every
        30 s by default, <code>LANTERN_RECOVERY_INTERVAL</code>). Workflow
        steps that already completed are skipped, not re-run.
      </p>

      <div className="callout callout-info">
        <strong>Note:</strong> Each step is idempotent and journaled. Side
        effects (API calls, webhooks) carry an idempotency key derived from the
        run ID, step ID, and attempt number to prevent duplicate actions.
      </div>
    </>
  );
}
