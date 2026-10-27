import Link from "next/link";
import { Concept } from "../_components/Concept";

export default function QuickStartPage() {
  return (
    <>
      <h1>Get started</h1>
      <p>
        Describe what you want your agent to do in plain language. Lantern&apos;s onboarding agent designs it,
        checks your model key with a real call, creates it, and runs it so you see real output. This takes
        about five minutes.
      </p>

      <Concept>
        Three words you&apos;ll see everywhere in Lantern. An <em>agent</em> is an AI worker with a name and
        instructions. A <em>run</em> is one execution of that agent: you give it input, it works, it returns
        output. The <em>event stream</em> is the live play-by-play of a run, so you can watch each step as it
        happens.
      </Concept>

      <h2 id="prerequisites">Before you start</h2>
      <ul>
        <li>
          A running stack: <code>lantern dev</code> (or <code>make dev-infra</code> + <code>make run-api</code> +{" "}
          <code>make dashboard-dev</code>). See <Link href="/installation">Installation</Link>.
        </li>
        <li>An OpenAI or Anthropic API key. You can add it during onboarding.</li>
        <li>
          The CLI, if you want the terminal path: <code>( cd packages/cli &amp;&amp; go install ./cmd/lantern )</code>.
          Run <code>lantern doctor</code> to check the stack, including whether the sandbox runtime is wired.
        </li>
      </ul>

      <h2 id="dashboard">In the dashboard</h2>
      <p>
        Open <a href="http://localhost:3001/onboarding" target="_blank" rel="noopener noreferrer">localhost:3001/onboarding</a>{" "}
        and sign in (dev: <code>admin@lantern.dev</code> / <code>lantern</code>). The page is a conversation on
        the right and a progress rail on the left. Each step moves on only after the platform confirms it
        actually worked.
      </p>
      <div className="steps">
        <div className="step" id="step1">
          <h3>Describe the goal</h3>
          <p>
            Write a sentence or two, for example <em>&quot;Turn my rough meeting notes into a short summary with action
            items.&quot;</em>
          </p>
        </div>
        <div className="step" id="step2">
          <h3>Review the design</h3>
          <p>
            The onboarding agent proposes a name, instructions, steps, a capability-addressed model (
            <code>auto</code>, never a vendor model name), and a first task, and explains why it chose them. Edit
            anything, then approve. If the design call fails, you can start from a basic one-step design instead;
            the page labels it as the basic design.
          </p>
        </div>
        <div className="step" id="step3">
          <h3>Check the model key</h3>
          <p>
            Lantern makes a real test call to your provider. A saved key that the provider rejects stops the flow
            here, showing the provider&apos;s actual error and a <strong>Replace the key</strong> button, instead of
            failing later in your first run.
          </p>
        </div>
        <div className="step" id="step4">
          <h3>Create and run</h3>
          <p>
            The agent is created with the instructions you approved. The first run streams live: each step appears as
            it starts and finishes. The output is then shown, with a short explanation of what the agent did and what
            to try next.
          </p>
        </div>
        <div className="step" id="step5">
          <h3>Optional: run it in a sandbox</h3>
          <p>
            Starts a microVM, runs one command inside it, and shuts it down. On a stack without a runtime scheduler
            this step says <strong>Sandbox unavailable</strong> and nothing runs. <code>lantern doctor</code> tells you
            which piece is missing.
          </p>
        </div>
      </div>
      <p>
        Your progress is saved on the server, so a reload or another browser picks up where you left off.
        <strong> Start over</strong> clears that progress. Agents you already created stay in your workspace.
      </p>
      <p>When something fails, the page says what went wrong and gives the one action most likely to fix it:</p>
      <table>
        <thead>
          <tr>
            <th>What you see</th>
            <th>One-click fix</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>No model key configured</td>
            <td>Add a model key (then the design is retried)</td>
          </tr>
          <tr>
            <td>Provider rejected the key (401, revoked, no credit)</td>
            <td>Replace the key</td>
          </tr>
          <tr>
            <td>Design came back unusable</td>
            <td>Rephrase the goal, or use the basic design</td>
          </tr>
          <tr>
            <td>An agent with that name exists</td>
            <td>Rename the agent</td>
          </tr>
          <tr>
            <td>Budget or quota blocked the run</td>
            <td>Open budgets</td>
          </tr>
        </tbody>
      </table>

      <h2 id="cli">In the terminal</h2>
      <pre><code>{`lantern onboard`}</code></pre>
      <p>
        It checks health, signs in (stored credentials or the dev seed), and test-calls your provider key, asking
        for one if needed. Then it asks <em>&quot;What do you want your agent to do?&quot;</em>, shows the proposed
        agent, creates it when you confirm, and streams the first run using the design&apos;s own first task.
      </p>
      <p>For CI, use the non-interactive mode. It never prompts and fails loudly at the first broken step:</p>
      <pre><code>{`lantern onboard --yes \\
  --provider anthropic --api-key "$ANTHROPIC_API_KEY" \\
  --description "Summarize support tickets into one-line triage notes"`}</code></pre>

      <h2 id="api">Under the hood: the REST calls</h2>
      <p>Both paths use the same public endpoints, so you can script them yourself:</p>
      <pre><code>{`export LANTERN_TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jq -r .token)
H="Authorization: Bearer $LANTERN_TOKEN"

# 1. Provider key + a real test call
curl -s -X POST localhost:8080/v1/settings/llm-providers -H "$H" \\
  -d '{"provider":"anthropic","apiKey":"sk-ant-..."}'
curl -s -X POST localhost:8080/v1/settings/llm-providers/anthropic/test -H "$H"

# 2. Design an agent from a goal (returns the spec: name, systemPrompt, firstInput, rationale, steps)
curl -s -X POST localhost:8080/v1/agents/generate-spec -H "$H" \\
  -d '{"description":"Turn meeting notes into action items"}' | tee spec.json

# 3. Create it (the instruction field is systemPrompt)
jq '{name, description, systemPrompt, model}' spec.json | \\
  curl -s -X POST localhost:8080/v1/agents -H "$H" -d @-

# 4. Run it with the suggested first task, then stream events (named SSE events)
RUN_ID=$(jq --argjson i "$(jq .firstInput spec.json)" -n \\
  "{agentName: \\"$(jq -r .name spec.json)\\", input: \\$i}" | \\
  curl -s -X POST localhost:8080/v1/runs -H "$H" -d @- | jq -r .id)
curl -N localhost:8080/v1/runs/$RUN_ID/events -H "$H" -H "Accept: text/event-stream"`}</code></pre>
      <p>
        generate-spec returns <code>400</code> with <code>&quot;code&quot;:&quot;no_provider&quot;</code> when no key
        is configured, and <code>502</code> with <code>bad_spec</code> or <code>llm_failed</code> when the model call
        fails. The stream closes when the run reaches <code>succeeded</code>, <code>failed</code> or{" "}
        <code>cancelled</code>. Read the final output from <code>GET /v1/runs/{"{id}"}</code>. Onboarding progress
        is stored at <code>GET/PUT/DELETE /v1/onboarding</code>.
      </p>

      <h2 id="next">What&apos;s next</h2>
      <div className="card-grid">
        <Link href="/surfaces" className="card">
          <div className="card-title">Connect a channel</div>
          <div className="card-desc">Slack, WhatsApp, Telegram, web chat.</div>
        </Link>
        <Link href="/budgets" className="card">
          <div className="card-title">Set a budget</div>
          <div className="card-desc">Per-run and per-day caps before real traffic.</div>
        </Link>
        <Link href="/evaluations" className="card">
          <div className="card-title">Add an eval</div>
          <div className="card-desc">Pin expected answers; CI fails on regressions.</div>
        </Link>
        <Link href="/runtime" className="card">
          <div className="card-title">Runtime</div>
          <div className="card-desc">MicroVM isolation, durable execution, receipts.</div>
        </Link>
      </div>
    </>
  );
}
