export default function ModelsPage() {
  return (
    <>
      <h1>Models</h1>
      <p>
        Lantern uses <strong>capability-based routing</strong> — your agent
        code asks for a capability (e.g. <code>reasoning-large</code>), and the
        model router maps it to the best concrete model from your configured
        providers at runtime. You never hardcode a vendor model name in agent
        code.
      </p>

      <h2 id="providers">Supported providers</h2>
      <p>
        Lantern currently supports two LLM providers:
      </p>
      <ul>
        <li>
          <strong>Anthropic</strong> — Claude models (Opus, Sonnet, Haiku)
        </li>
        <li>
          <strong>OpenAI</strong> — GPT models (GPT-4o, GPT-4o-mini, etc.)
        </li>
      </ul>
      <p>
        Both are supported equally in the model router and in LLM idempotency
        key derivation. Add a provider key under{" "}
        <strong>Settings &gt; Models</strong> — the router only considers
        providers whose key you have configured.
      </p>

      <h2 id="capabilities">Capability names</h2>
      <p>
        Use these capability strings in <code>model</code> fields or{" "}
        <code>capability</code> arguments:
      </p>
      <table>
        <thead>
          <tr>
            <th>Capability</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>auto</code></td>
            <td>Router picks the best model for each step (cost + quality)</td>
          </tr>
          <tr>
            <td><code>reasoning-frontier</code></td>
            <td>Highest-capability reasoning (Opus, GPT-o1)</td>
          </tr>
          <tr>
            <td><code>reasoning-large</code></td>
            <td>Large reasoning model (Sonnet, GPT-4o)</td>
          </tr>
          <tr>
            <td><code>reasoning-small</code></td>
            <td>Fast, cheap reasoning (Haiku, GPT-4o-mini)</td>
          </tr>
          <tr>
            <td><code>chat-large</code></td>
            <td>Conversational, large context</td>
          </tr>
          <tr>
            <td><code>chat-small</code></td>
            <td>Lightweight chat, low latency</td>
          </tr>
          <tr>
            <td><code>chat-edge</code></td>
            <td>Smallest footprint for edge/embedded use</td>
          </tr>
          <tr>
            <td><code>vision-large</code></td>
            <td>Image understanding, large context</td>
          </tr>
          <tr>
            <td><code>vision-small</code></td>
            <td>Lightweight vision</td>
          </tr>
          <tr>
            <td><code>code-large</code></td>
            <td>Code generation and analysis, large</td>
          </tr>
          <tr>
            <td><code>code-small</code></td>
            <td>Code generation, lightweight</td>
          </tr>
          <tr>
            <td><code>embed-large</code></td>
            <td>High-dimensional text embeddings</td>
          </tr>
          <tr>
            <td><code>embed-small</code></td>
            <td>Fast, lower-dimensional embeddings</td>
          </tr>
        </tbody>
      </table>

      <h3 id="auto">How <code>auto</code> works</h3>
      <p>
        With <code>auto</code>, the router scores every available model using
        a balanced formula (quality, speed, cost efficiency) and picks the
        winner at call time. It only considers models whose provider API key
        you have configured, and it respects your{" "}
        <code>LANTERN_ROUTE_STRATEGY</code> setting.
      </p>

      <h3>Routing strategies</h3>
      <pre>
        <code>{`# Default — best balance of quality, speed, and cost
LANTERN_ROUTE_STRATEGY=balanced

# Cheapest available (e.g., GPT-4o-mini, Haiku)
LANTERN_ROUTE_STRATEGY=cheap

# Highest quality regardless of cost
LANTERN_ROUTE_STRATEGY=quality

# Fastest response time
LANTERN_ROUTE_STRATEGY=fast`}</code>
      </pre>

      <h2 id="failover">Failover</h2>
      <p>
        The model router handles provider failures automatically:
      </p>
      <ul>
        <li>
          <strong>5xx errors</strong> — immediate retry on the next provider
          in the failover chain
        </li>
        <li>
          <strong>Rate limits (429)</strong> — exponential backoff with
          automatic rotation to an alternative provider
        </li>
        <li>
          <strong>No mid-sentence swap</strong> — failover only happens before
          the first token; once streaming begins an error is a clean{" "}
          <code>message_error</code>, never a splice
        </li>
      </ul>

      <h2 id="idempotency">LLM idempotency</h2>
      <p>
        Every LLM provider call carries an idempotency key so that a
        rate-limit backoff retry or crash-replay does not double-bill. The key
        is derived from <code>sha256("runID|stepID|attempt")</code> and sent
        as the <code>Idempotency-Key</code> request header. Failover targets
        get a per-provider-suffixed variant so the same logical call to two
        different providers is always distinguishable.
      </p>

      <h2 id="keys">Adding API keys</h2>
      <p>
        Add your provider API key from the dashboard under{" "}
        <strong>Settings &gt; Models</strong>, or via the API:
      </p>
      <pre>
        <code>{`POST /v1/settings/llm-providers
{ "provider": "anthropic", "apiKey": "sk-ant-..." }

POST /v1/settings/llm-providers
{ "provider": "openai", "apiKey": "sk-..." }`}</code>
      </pre>
      <p>
        Keys are AES-256-GCM encrypted at rest and never appear in logs,
        traces, or run state. They are resolved inside the microVM at execution
        time.
      </p>
    </>
  );
}
