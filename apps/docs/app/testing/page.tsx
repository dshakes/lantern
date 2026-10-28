import { Concept } from "../_components/Concept";

export default function TestingPage() {
  return (
    <>
      <h1>End-to-end tests</h1>
      <p>
        <code>make test-e2e</code> runs Go suites against a live local stack over HTTP: real JWT login, real Postgres
        rows, no mocks. Because some tests call a real LLM, a spend policy is enforced in code.
      </p>

      <Concept>
        The tests get a small, fixed set of named test agents, each with a hard daily cost cap. If a cap is hit the
        test fails on purpose: it proves the guard works, and it stops a bad loop from running up a bill.
      </Concept>

      <h2 id="run">Run it</h2>
      <pre><code>{`make dev-infra   # Postgres + Redis + MinIO (once)
make run-api     # control-plane on :8080 (terminal 1)

export LANTERN_E2E_API_URL=http://localhost:8080
make test-e2e    # terminal 2`}</code></pre>
      <p>
        The target runs <code>make e2e-lint</code>, then the <code>e2e/runtime</code> and <code>e2e/quickstart</code>{" "}
        suites (Go, build tag <code>e2e</code>, standalone modules, so plain <code>go test ./...</code> never runs
        them). <code>make test-e2e-llm</code> is an alias. It targets the single-tier topology (stub scheduler, no
        KVM needed). Quickstart needs an LLM provider configured for the dev tenant.
      </p>
      <p>
        On a two-tier stack (<code>LANTERN_SCHEDULER_GRPC_ADDR</code> plus a Docker-backend runtime-manager) set{" "}
        <code>LANTERN_E2E_IMAGE_DIGEST</code> to a locally pullable image; with the placeholder default, schedule
        returns 500.
      </p>

      <h2 id="suites">Suites</h2>
      <table>
        <thead>
          <tr><th>Dir</th><th>Covers</th></tr>
        </thead>
        <tbody>
          <tr><td><code>e2e/runtime</code></td><td><code>/v1/runtime/*</code> control path: auth gates, schedule (201 + vm_id), tenant-scoped list, detail and audit, logs SSE, terminate, quota 402.</td></tr>
          <tr><td><code>e2e/quickstart</code></td><td>The <code>examples/quickstart/</code> agents: create from <code>spec.json</code>, post <code>run.json</code>, poll to <code>succeeded</code>, assert an output shape; incident-summarizer also issues and verifies a receipt. Real LLM calls.</td></tr>
        </tbody>
      </table>

      <h2 id="spend-policy">Spend policy</h2>
      <p>Enforced by <code>e2e/internal/e2ekit</code>, which is the only way a suite creates agents or posts runs:</p>
      <ul>
        <li>Agent names must be one of 8 reserved names: <code>e2e-quickstart</code>, <code>e2e-support</code>, <code>e2e-pr-triage</code>, <code>e2e-incident</code>, <code>e2e-digest</code>, <code>e2e-analyst</code>, <code>e2e-assistant</code>, <code>e2e-voice</code>. At most 8 <code>e2e-*</code> agents exist at once.</li>
        <li>Each agent gets a hard-fail budget before any run: <code>maxCostUsdPerDay</code> 0.50, <code>maxRunsPerDay</code> 15, <code>hardFail</code> true. The kit reads it back and fails the test if it is absent.</li>
        <li>Model is pinned to the cheapest tier: <code>reasoning-small</code> if Anthropic is configured, else <code>chat-small</code>, else <code>fast</code> (env-configured keys). Never a large model.</li>
        <li><code>web_search</code> is stripped from every spec except <code>e2e-assistant</code>.</li>
        <li>A <code>402</code> on <code>POST /v1/runs</code> fails the test with <code>e2e daily budget exhausted for &lt;name&gt; (cap working; rerun after local midnight)</code>.</li>
        <li><code>make e2e-lint</code> fails the build if anything under <code>e2e/</code> references <code>/v1/budgets/tenant</code>; the tests never touch the tenant-wide cap.</li>
      </ul>
      <p>
        The quickstart suite posts 3 runs per invocation against one slot, and the cap is 15 runs/day, so expect about
        5 full runs per day. The pinned model is advisory until the run executor honors the agent&apos;s{" "}
        <code>model</code> field; the budget is what actually bounds spend.
      </p>

      <h2 id="env">Environment variables</h2>
      <table>
        <thead>
          <tr><th>Variable</th><th>Default</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr><td><code>LANTERN_E2E_API_URL</code></td><td><code>http://localhost:8080</code></td><td>Target API. Canonical; always set it explicitly.</td></tr>
          <tr><td><code>LANTERN_API_URL</code></td><td>unset</td><td>Alias, used only when the canonical var is unset</td></tr>
          <tr><td><code>LANTERN_E2E_EMAIL</code></td><td><code>admin@lantern.dev</code></td><td>Login email (seeded dev user)</td></tr>
          <tr><td><code>LANTERN_E2E_PASSWORD</code></td><td><code>lantern</code></td><td>Login password</td></tr>
          <tr><td><code>LANTERN_E2E_IMAGE_DIGEST</code></td><td>placeholder digest</td><td>Image to schedule in the runtime suite; needed on two-tier stacks</td></tr>
          <tr><td><code>E2E_ALLOW_SKIP</code></td><td>unset</td><td><code>1</code> turns a down stack into a skip</td></tr>
        </tbody>
      </table>
      <p>The runtime suite prints the resolved target URL at the start of a run.</p>

      <h3 id="allow-skip">E2E_ALLOW_SKIP</h3>
      <p>
        Every test probes <code>GET /healthz</code> first. If the stack is unreachable the test <strong>fails</strong>,
        so <code>make test-e2e</code> exits non-zero and you know nothing ran. With <code>E2E_ALLOW_SKIP=1</code> it
        skips and exits 0. A reachable API with wrong credentials is always a failure.
      </p>
      <pre><code>{`E2E_ALLOW_SKIP=1 make test-e2e   # exits 0 when the stack is down`}</code></pre>

      <h2 id="resources">What it creates</h2>
      <ul>
        <li>Agents named from the reserved <code>e2e-*</code> set above, each with a budget.</li>
        <li>Runs on those agents (quickstart), and scheduled VMs plus a temporary quota row (runtime).</li>
      </ul>
      <p>
        Tests delete their agents via <code>t.Cleanup</code>, and the runtime suite terminates its VMs and restores the
        quota row even when assertions fail. The quickstart suite also sweeps leftover <code>e2e-*</code> agents in{" "}
        <code>TestMain</code> before running.
      </p>

      <h2 id="clean">make e2e-clean</h2>
      <p>
        Manual recovery after an interrupted run. It runs <code>go run ./cmd/sweep</code> in{" "}
        <code>e2e/internal/e2ekit</code>, logs in with the same URL and credentials variables, lists{" "}
        <code>GET /v1/agents</code>, and issues <code>DELETE /v1/agents/&#123;name&#125;</code> for every agent whose
        name starts with <code>e2e-</code>. Nothing else is deleted; failures are printed, never fatal. Use it when the
        kit refuses to create an agent because 8 <code>e2e-*</code> agents already exist.
      </p>
      <pre><code>{`LANTERN_E2E_API_URL=http://localhost:8080 make e2e-clean`}</code></pre>

      <h2 id="browser">Browser tier (Playwright)</h2>
      <p>
        <code>apps/web/e2e</code> drives the real dashboard in headless Chromium: sign-up, forgot/reset password
        (the reset link is read from the log mailer), onboarding (template gallery and the free-text path through the
        fixture LLM to a succeeded first run), the settings danger zone, and the light/dark theme.
      </p>
      <pre><code>{`cd apps/web
npm ci && npx playwright install chromium
npm run test:e2e`}</code></pre>
      <p>
        It boots its own stack on spare ports (web 3411, API 8411, llm-replay 9412): a throwaway Postgres database, a
        private Redis db index, the control-plane (with <code>LANTERN_CORS_ORIGINS</code> set to the dashboard origin),
        llm-replay and <code>next dev</code>. It never touches :8080, :3001 or the shared <code>lantern</code> database,
        and tears everything down afterwards. Needs Go, <code>psql</code>, and Postgres and Redis reachable (the{" "}
        <code>make dev-infra</code> defaults work; override with <code>E2E_PG_ADMIN_URL</code>,{" "}
        <code>E2E_REDIS_*</code>). Details and kiosk-spec hooks: <code>apps/web/e2e/README.md</code>.
      </p>

      <h2 id="ci">CI</h2>
      <p>
        No workflow under <code>.github/workflows</code> runs <code>make test-e2e</code> today. A pipeline without a
        live stack should set <code>E2E_ALLOW_SKIP=1</code>, otherwise the run fails by design. Never point the suites
        at a stack with real tenant data: they delete every agent named <code>e2e-*</code> in the logged-in tenant.
      </p>

      <h2 id="fixture-llm">Fixture LLM tier</h2>
      <p>
        <strong>What.</strong> <code>llm-replay</code> is a small stdlib server that speaks the OpenAI
        chat-completions and Anthropic messages wire formats (JSON and SSE streaming, text and tool calls). Setting{" "}
        <code>LANTERN_LLM_BASEURL_OPENAI</code> and/or <code>LANTERN_LLM_BASEURL_ANTHROPIC</code> sends every
        control-plane provider call there instead of the real API.
      </p>
      <p>
        <strong>Why.</strong> CI and kiosk mode need the same answer every time and must not need a provider key or
        spend money. Token usage is still reported, so budgets and cost metering run for real.
      </p>
      <p><strong>How.</strong> The default reply is <code>fixture: </code> plus the first 60 characters of the last user message. A rules file scripts the rest; the first rule whose <code>match</code> is a substring of the system prompt or the last user message wins (this is how the demo kiosk tells its agents apart). <code>GET /healthz</code> returns 200.</p>
      <pre><code>{`[
  {"match": "refund", "reply": "Refund issued."},
  {"match": "weather", "tool": {"name": "get_weather", "args": {"city": "Austin"}}}
]`}</code></pre>
      <p>
        A <code>tool</code> rule fires only when the request declares tools. When the next request carries the tool
        result, the reply is <code>fixture: tool result: &lt;first 60 chars&gt;</code>, so a scripted tool loop always
        ends. Usage is about one token per 4 characters of the request body and the reply.
      </p>

      <h3 id="fixture-try">Try it</h3>
      <pre><code>{`cd services/control-plane
go run ./cmd/llm-replay -rules rules.json      # 127.0.0.1:9192

LANTERN_LLM_BASEURL_OPENAI=http://127.0.0.1:9192 \
LANTERN_LLM_BASEURL_ANTHROPIC=http://127.0.0.1:9192 \
OPENAI_API_KEY=dummy make run-api

curl -s localhost:8080/v1/completions -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'   # "fixture: hello"
curl -s 127.0.0.1:9192/__requests                         # what the control-plane sent`}</code></pre>

      <h3 id="fixture-limits">Limits</h3>
      <ul>
        <li>Dev and test only. The control-plane refuses to start with either variable set when <code>LANTERN_ENV</code> is prod, production or staging, and ignores them at request time.</li>
        <li>A provider key must still exist (database or <code>OPENAI_API_KEY</code>/<code>ANTHROPIC_API_KEY</code>); any dummy value works.</li>
        <li>Only <code>/v1/chat/completions</code> and <code>/v1/messages</code> are served. Other provider endpoints (embeddings, speech, transcription) return 404.</li>
        <li>No model quality: it echoes and follows rules. It cannot validate prompts.</li>
      </ul>

      <h2 id="limits">Not covered</h2>
      <ul>
        <li>True cross-tenant isolation (a second tenant probing the first) needs a second seeded tenant.</li>
        <li><code>PUT /v1/runtime/quota</code> clamps non-positive ceilings, so the 402 test pins <code>maxConcurrentVms</code> to the current live-VM count instead.</li>
      </ul>
    </>
  );
}
