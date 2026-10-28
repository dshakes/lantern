import { Concept } from "../_components/Concept";

export default function ModelsPage() {
  return (
    <>
      <h1>Models</h1>
      <p>
        Agents ask for a <strong>capability</strong> such as{" "}
        <code>reasoning-large</code>. Lantern maps it to a concrete model from
        the providers you have keyed. Vendor model names stay out of agent
        code.
      </p>

      <Concept>
        Say what the task needs (deep reasoning, quick chat, vision, code), not
        which model. When you swap a model or a provider is down, agents keep
        running with no code change.
      </Concept>

      <h2 id="providers">Supported providers</h2>
      <p>
        Two LLM providers today:
      </p>
      <ul>
        <li>
          <strong>Anthropic</strong> — Opus, Sonnet and Haiku (defaults{" "}
          <code>claude-opus-4-8</code>, <code>claude-sonnet-4-6</code>,{" "}
          <code>claude-haiku-4-5-20251001</code>; override with{" "}
          <code>LANTERN_OPUS_MODEL</code>, <code>LANTERN_SONNET_MODEL</code>,{" "}
          <code>LANTERN_HAIKU_MODEL</code>)
        </li>
        <li>
          <strong>OpenAI</strong> — <code>gpt-4o</code> and <code>gpt-4o-mini</code>
        </li>
      </ul>
      <p>
        Add a provider key under <strong>Settings</strong> (LLM providers) or
        via the API below. Scored picks (<code>auto</code>, <code>cheap</code>, <code>best</code>) only consider providers you have keyed.
      </p>

      <h2 id="capabilities">Capability names</h2>
      <p>
        Use these strings in <code>model</code> fields or <code>capability</code>{" "}
        arguments. Resolution happens in the control plane
        (<code>llm_proxy.go</code>); the table shows what each name resolves
        to per provider. Fixed names are pinned to one provider; the rest pick by
        which providers are keyed.
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Anthropic keyed</th>
            <th>OpenAI only</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>reasoning-frontier</code></td><td>capability</td><td colSpan={2}>Opus (<code>LANTERN_OPUS_MODEL</code>), always Anthropic</td></tr>
          <tr><td><code>reasoning-large</code></td><td>capability</td><td colSpan={2}>Sonnet, always Anthropic</td></tr>
          <tr><td><code>reasoning-small</code></td><td>capability</td><td colSpan={2}>Haiku, always Anthropic</td></tr>
          <tr><td><code>code-large</code></td><td>capability</td><td colSpan={2}>Sonnet, always Anthropic</td></tr>
          <tr><td><code>chat-large</code></td><td>capability</td><td colSpan={2}><code>gpt-4o</code>, always OpenAI</td></tr>
          <tr><td><code>vision-large</code></td><td>capability</td><td colSpan={2}><code>gpt-4o</code>, always OpenAI</td></tr>
          <tr><td><code>chat-small</code></td><td>capability</td><td colSpan={2}><code>gpt-4o-mini</code>, always OpenAI</td></tr>
          <tr><td><code>vision-small</code></td><td>capability</td><td colSpan={2}><code>gpt-4o-mini</code>, always OpenAI</td></tr>
          <tr><td><code>chat-edge</code>, <code>code-small</code></td><td>capability</td><td>Haiku</td><td><code>gpt-4o-mini</code></td></tr>
          <tr><td><code>cheap</code>, <code>fast</code></td><td>optimize target</td><td>Haiku</td><td><code>gpt-4o-mini</code></td></tr>
          <tr><td><code>best</code></td><td>optimize target</td><td>Opus</td><td><code>gpt-4o</code></td></tr>
          <tr><td><code>auto</code>, <code>balanced</code>, empty string</td><td>capability / optimize target</td><td colSpan={2}>Scored pick among keyed providers (see <a href="#auto">How auto works</a>)</td></tr>
          <tr><td><code>embed-large</code>, <code>embed-small</code>, <code>rerank</code>, <code>transcribe</code>, <code>tts</code></td><td>capability</td><td colSpan={2}>Not servable by text completion; routed to the same scored pick as <code>auto</code></td></tr>
        </tbody>
      </table>
      <p>
        &quot;Anthropic keyed&quot; means the tenant has an active Anthropic
        key (Settings) or the process has <code>ANTHROPIC_API_KEY</code>; the
        cheap tier prefers Anthropic whenever it is keyed. The always-pinned
        names do not check which providers you keyed, so a pinned name whose
        provider has no key is left to <a href="#failover">failover</a>.
      </p>

      <h3 id="resolution-rules">Resolution rules</h3>
      <ul>
        <li>
          <strong>Unknown names</strong> (anything not in the table and not a
          vendor model name) route to the balanced default, same as{" "}
          <code>auto</code>. The control plane logs one WARN per distinct name
          (capped at 256 names) and never routes unknowns to a hardcoded model.
        </li>
        <li>
          <strong><code>fast</code> and <code>cheap</code></strong> both map to
          the cheap tier (Haiku, else <code>gpt-4o-mini</code>). Neither
          optimizes for latency here; use{" "}
          <code>LANTERN_ROUTE_STRATEGY=fast</code> for that.
        </li>
        <li>
          <strong>Literal vendor model names</strong> pass through unchanged:
          a name starting with <code>gpt</code>, <code>o1</code> or{" "}
          <code>o3</code> goes to OpenAI, one starting with{" "}
          <code>claude</code> goes to Anthropic. The match is a plain prefix
          and the name is not checked against any list; a wrong id fails at
          the provider. Prefer a capability (invariant: models are addressed
          by capability).
        </li>
        <li>
          <strong>Precedence</strong>, first match wins: (1){" "}
          <code>auto</code> / <code>balanced</code> / empty, (2){" "}
          <code>fast</code> / <code>cheap</code> / <code>chat-edge</code> /{" "}
          <code>code-small</code>, (3) <code>best</code>, (4) the
          non-completion names, (5) the fixed-tier capabilities and vendor
          model names, (6) anything else is unknown.
        </li>
        <li>
          <strong>Which callers</strong>: workflow <code>ai-step</code> nodes
          resolve a capability string with this table. Session turns use
          complexity routing by default (each turn classified trivial,
          balanced or hard); set <code>LANTERN_COMPLEXITY_ROUTING=0</code> (or{" "}
          <code>off</code>/<code>false</code>) for plain <code>auto</code>{" "}
          scoring. Neither uses this table.
        </li>
      </ul>

      <h3 id="auto">How <code>auto</code> works</h3>
      <p>
        <code>auto</code> scores each model in a built-in catalog (Opus,
        Sonnet, Haiku, <code>gpt-4o</code>, <code>gpt-4o-mini</code>) on
        quality, speed and cost, and picks the top scorer among providers
        you have keyed. With neither provider keyed it returns{" "}
        <code>gpt-4o</code> and the call fails with a missing-key error.{" "}
        <code>LANTERN_ROUTE_STRATEGY</code> changes the weighting and applies
        to every name that resolves to the scored pick (<code>auto</code>,{" "}
        <code>balanced</code>, unknown names, the non-completion names).
      </p>
      <p>
        The default <code>balanced</code> strategy scores quality first, speed
        second, and subtracts a real price penalty (<code>balancedScore</code>{" "}
        in <code>llm_proxy.go</code>). It picks Sonnet when Anthropic is keyed
        and <code>gpt-4o</code> when only OpenAI is; Opus scores lower because
        of its price, and the mini tier lower because of quality. Pin{" "}
        <code>reasoning-frontier</code> or <code>best</code> if you want Opus.
      </p>

      <h3>Routing strategies</h3>
      <pre>
        <code>{`# Default — quality first, price as a real penalty (Sonnet, else gpt-4o)
LANTERN_ROUTE_STRATEGY=balanced

# Cheapest available (Haiku or gpt-4o-mini)
LANTERN_ROUTE_STRATEGY=cheap

# Highest quality regardless of cost (Opus, else gpt-4o)
LANTERN_ROUTE_STRATEGY=quality

# Fastest response time (Haiku, else gpt-4o-mini)
LANTERN_ROUTE_STRATEGY=fast`}</code>
      </pre>

      <h2 id="agent-model">Per-agent model</h2>
      <p>
        Each agent can carry a <code>model</code>: a capability (
        <code>fast</code>, <code>cheap</code>, <code>reasoning-small</code>,{" "}
        <code>reasoning-large</code>, …) or a vendor model id (
        <code>gpt-*</code>, <code>o1*</code>, <code>o3*</code>,{" "}
        <code>claude-*</code>). Runs, sessions and workflow{" "}
        <code>ai-step</code> nodes with no capability of their own try that
        model first. Use it to pin a cheap model on a high-volume agent, or a
        stronger one on an agent that needs it.
      </p>
      <pre>
        <code>{`# Set on create
POST /v1/agents
{ "name": "triage", "model": "fast" }

# Change later ("" or "auto" goes back to the default chain)
PATCH /v1/agents/triage
{ "model": "reasoning-large" }

# Read it back
GET /v1/agents/triage   →  { ..., "model": "reasoning-large" }`}</code>
      </pre>
      <ul>
        <li>
          <strong>Unset or <code>auto</code></strong> — exactly the{" "}
          <a href="#auto">auto</a> chain, unchanged.
        </li>
        <li>
          <strong>Validation</strong> — anything else returns 400. Embedding,
          rerank and speech capabilities are rejected because agents run text
          completions. The error never echoes the value.
        </li>
        <li>
          <strong>Provider not keyed</strong> — if the model&apos;s provider has
          no key for your tenant, the agent uses the default chain.
        </li>
        <li>
          <strong>Workflow nodes</strong> — an <code>ai-step</code> with an
          explicit capability keeps it; only <code>auto</code> nodes take the
          agent&apos;s model.
        </li>
        <li>
          <strong>Recorded</strong> — the model that answered is on the
          run&apos;s <code>llm:main</code> step in the run timeline.
        </li>
      </ul>

      <h2 id="failover">Failover</h2>
      <p>
        The control plane fails over through a ranked chain: each keyed
        provider&apos;s top model, then that provider&apos;s cheaper tier
        (Haiku / <code>gpt-4o-mini</code>, a separate quota tier), then the
        next provider:
      </p>
      <ul>
        <li>
          <strong>429, 402 and 5xx</strong> — move to the next candidate
          in the chain; a rate limit adds a backoff first
        </li>
        <li>
          <strong>Agent models go first</strong> — an agent&apos;s{" "}
          <a href="#agent-model">model</a> heads the chain and the default
          chain follows it. A cheap-tier agent (Haiku / <code>*-mini</code>)
          fails over only to the other provider&apos;s cheap tier — never to a
          Sonnet, gpt-4o or Opus class model; if both cheap tiers fail, the
          call fails instead of escalating the bill
        </li>
        <li>
          <strong>No mid-sentence swap</strong> — in streaming, failover only happens
          while zero tokens have been emitted. After the first token an error
          surfaces as <code>message_error</code>, never a splice
        </li>
      </ul>

      <h2 id="idempotency">LLM idempotency</h2>
      <p>
        OpenAI and Anthropic calls carry an <code>Idempotency-Key</code>{" "}
        header, so a backoff retry or a crash replay dedups at the provider
        instead of double-billing. The key is a one-way hash of the run,
        step and attempt, plus a hash of the request body, with a
        per-provider suffix on failover targets. Ad-hoc{" "}
        <code>/v1/completions</code> calls without a run use a hash of
        provider, model and messages. See{" "}
        <code>llm_idempotency.go</code>.
      </p>

      <h2 id="keys">Adding API keys</h2>
      <p>
        Add a provider key in the dashboard settings, or via the API:
      </p>
      <pre>
        <code>{`POST /v1/settings/llm-providers
{ "provider": "anthropic", "apiKey": "sk-ant-..." }

POST /v1/settings/llm-providers
{ "provider": "openai", "apiKey": "sk-..." }`}</code>
      </pre>
      <p>
        Keys are AES-256-GCM encrypted at rest when{" "}
        <code>LANTERN_CREDENTIAL_KEY</code> is set (plaintext otherwise, so set
        it outside dev). They never appear in logs, traces or run state. The
        control plane resolves them per tenant at call time.
      </p>

      <h2 id="router">Model-router service</h2>
      <p>
        A separate Rust model-router service exists (gRPC <code>:50053</code>,
        Anthropic and OpenAI providers). The control plane only routes plain
        completions through it when <code>LANTERN_USE_MODEL_ROUTER=1</code>; it
        is <strong>off by default</strong>, and any router error falls back to
        the direct path. Enable it on a non-critical tenant first.
      </p>
      <p>
        The router has its own, separate mapping. The control plane resolves
        a model first using the table above, converts it back to a router
        capability (Opus to <code>reasoning-frontier</code>, Sonnet to{" "}
        <code>reasoning-large</code>, Haiku to <code>reasoning-small</code>,{" "}
        <code>gpt-4o</code> to <code>chat-large</code>, <code>-mini</code> to{" "}
        <code>chat-small</code>, anything else to <code>auto</code>), and the
        router then picks the concrete model for that capability. Each
        provider supports a capability only if it lists it exactly:
      </p>
      <table>
        <thead>
          <tr><th>Router capability</th><th>Anthropic</th><th>OpenAI</th></tr>
        </thead>
        <tbody>
          <tr><td><code>reasoning-frontier</code></td><td><code>claude-opus-4-6</code></td><td>not supported</td></tr>
          <tr><td><code>reasoning-large</code></td><td><code>claude-sonnet-4-6</code></td><td><code>o3</code></td></tr>
          <tr><td><code>reasoning-small</code></td><td><code>claude-haiku-4-5</code></td><td>not supported</td></tr>
          <tr><td><code>code-large</code></td><td><code>claude-sonnet-4-6</code></td><td><code>gpt-4o</code></td></tr>
          <tr><td><code>chat-large</code></td><td>not supported</td><td><code>gpt-4o</code></td></tr>
          <tr><td><code>chat-small</code></td><td>not supported</td><td><code>gpt-4o-mini</code></td></tr>
          <tr><td><code>embed-large</code>, <code>embed-small</code></td><td>not supported</td><td><code>text-embedding-3-large</code>, <code>text-embedding-3-small</code></td></tr>
        </tbody>
      </table>
      <p>
        <code>auto</code> and unspecified become <code>chat-large</code>.
        Router model ids are fixed in the service (not overridable by{" "}
        <code>LANTERN_OPUS_MODEL</code> and friends), so with the router on
        the Opus tier is <code>claude-opus-4-6</code>, not the control-plane
        default <code>claude-opus-4-8</code>. Among providers that support the
        capability, the optimize target orders them: cheap by price, fast by
        p50 latency, best by quality score, balanced by a fixed provider
        preference.
      </p>
    </>
  );
}
