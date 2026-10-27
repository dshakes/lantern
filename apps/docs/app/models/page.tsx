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
        via the API below. Routing only considers providers you have keyed.
      </p>

      <h2 id="capabilities">Capability names</h2>
      <p>
        Use these strings in <code>model</code> fields or <code>capability</code>{" "}
        arguments. The first column is the vocabulary; the third is what the
        control plane resolves today.
      </p>
      <table>
        <thead>
          <tr>
            <th>Capability</th>
            <th>Intent</th>
            <th>Resolves to (control-plane path)</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>auto</code></td><td>Router picks per call</td><td>Best-scoring model among keyed providers</td></tr>
          <tr><td><code>reasoning-frontier</code></td><td>Highest-capability reasoning</td><td>Opus</td></tr>
          <tr><td><code>reasoning-large</code></td><td>Large reasoning model</td><td>Sonnet</td></tr>
          <tr><td><code>reasoning-small</code></td><td>Fast, cheap reasoning</td><td>Haiku</td></tr>
          <tr><td><code>chat-large</code></td><td>Conversational, large context</td><td>gpt-4o</td></tr>
          <tr><td><code>chat-small</code></td><td>Lightweight chat</td><td>gpt-4o-mini</td></tr>
          <tr><td><code>code-large</code></td><td>Code generation and analysis</td><td>Sonnet</td></tr>
          <tr><td><code>vision-large</code></td><td>Image understanding</td><td>gpt-4o</td></tr>
          <tr><td><code>chat-edge</code>, <code>vision-small</code>, <code>code-small</code>, <code>embed-large</code>, <code>embed-small</code>, <code>rerank</code>, <code>transcribe</code>, <code>tts</code></td><td>Accepted by the SDK type</td><td>No dedicated mapping on this path; falls back to gpt-4o</td></tr>
        </tbody>
      </table>

      <h3 id="auto">How <code>auto</code> works</h3>
      <p>
        <code>auto</code> scores each model from a built-in catalog on quality,
        speed and cost, and picks the top scorer among providers you have
        keyed. <code>LANTERN_ROUTE_STRATEGY</code> changes the weighting.
      </p>

      <h3>Routing strategies</h3>
      <pre>
        <code>{`# Default — best balance of quality, speed, and cost
LANTERN_ROUTE_STRATEGY=balanced

# Cheapest available
LANTERN_ROUTE_STRATEGY=cheap

# Highest quality regardless of cost
LANTERN_ROUTE_STRATEGY=quality

# Fastest response time
LANTERN_ROUTE_STRATEGY=fast`}</code>
      </pre>

      <h2 id="failover">Failover</h2>
      <p>
        The control plane fails over across providers (not across models of
        one provider):
      </p>
      <ul>
        <li>
          <strong>429, 402 and 5xx</strong> — move to the next candidate
          provider; a rate limit adds a backoff first
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
    </>
  );
}
