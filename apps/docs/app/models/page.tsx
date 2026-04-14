export default function ModelsPage() {
  return (
    <>
      <h1>Models</h1>
      <p>
        Lantern uses <strong>capability-based routing</strong> to map abstract
        capability names to concrete LLM models. This means your agent code
        never hardcodes a vendor model name -- it specifies what kind of
        intelligence it needs, and the model router picks the best option at
        runtime.
      </p>

      <h2 id="providers">Supported providers</h2>
      <p>
        Lantern supports the following LLM providers out of the box:
      </p>
      <ul>
        <li>
          <strong>Anthropic</strong> -- Claude Opus, Sonnet, Haiku
        </li>
        <li>
          <strong>OpenAI</strong> -- GPT-5, GPT-4o, GPT-4o-mini
        </li>
        <li>
          <strong>Google</strong> -- Gemini Ultra, Gemini Pro, Gemini Flash
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> Additional providers (Mistral, Cohere, open-source
        models via vLLM) are on the roadmap. You can also add custom providers
        via the SDK.
      </div>

      <h2 id="routing">Capability routing</h2>
      <p>
        Instead of specifying <code>&quot;gpt-4&quot;</code> or{" "}
        <code>&quot;claude-3-opus&quot;</code>, you specify a capability:
      </p>

      <pre>
        <code>{`| Capability          | Description                              | Example models                    |
|---------------------|------------------------------------------|-----------------------------------|
| "auto"              | Best model for each step (cost+quality)  | Varies per step                   |
| "reasoning-large"   | Maximum reasoning capability             | Opus, GPT-5                       |
| "reasoning-small"   | Fast, cheap reasoning                    | Haiku, GPT-4o-mini, Gemini Flash  |
| "code"              | Optimized for code generation            | Sonnet, GPT-4o                    |
| "vision"            | Image understanding                      | Opus, GPT-4o, Gemini Ultra        |
| "embedding"         | Text embeddings                          | text-embedding-3, embed-v4        |`}</code>
      </pre>

      <h3 id="auto">How &quot;auto&quot; works</h3>
      <p>
        When you set <code>model: &quot;auto&quot;</code>, the smart router
        scores every available model and picks the best one. The scoring considers:
      </p>
      <ul>
        <li><strong>Quality</strong> (40%) — how capable the model is for complex reasoning</li>
        <li><strong>Speed</strong> (30%) — response latency</li>
        <li><strong>Cost efficiency</strong> (30%) — inverse of token pricing</li>
      </ul>

      <h3>Model scoring table</h3>
      <table>
        <thead>
          <tr><th>Model</th><th>Provider</th><th>Quality</th><th>Speed</th><th>Cost (in/out per 1M)</th><th>Balanced Score</th></tr>
        </thead>
        <tbody>
          <tr><td>Claude Opus 4</td><td>Anthropic</td><td>10</td><td>4</td><td>$15 / $75</td><td>53.4</td></tr>
          <tr><td><strong>Claude Sonnet 4</strong></td><td>Anthropic</td><td>9</td><td>7</td><td>$3 / $15</td><td>62.7</td></tr>
          <tr><td>Claude Haiku 4</td><td>Anthropic</td><td>6</td><td>10</td><td>$0.25 / $1.25</td><td>94.5</td></tr>
          <tr><td><strong>GPT-4o</strong></td><td>OpenAI</td><td>8</td><td>8</td><td>$2.50 / $10</td><td>63.9</td></tr>
          <tr><td>GPT-4o Mini</td><td>OpenAI</td><td>5</td><td>10</td><td>$0.15 / $0.60</td><td>155.3</td></tr>
        </tbody>
      </table>

      <div className="callout callout-info">
        <strong>Note:</strong> The router only considers models whose provider API key you have configured. If you only have an Anthropic key, it picks from Claude models only.
      </div>

      <h3>Routing strategies</h3>
      <p>
        You can control the routing strategy via environment variable:
      </p>
      <pre><code>{`# Default — best balance of quality, speed, and cost
LANTERN_ROUTE_STRATEGY=balanced make run-api

# Cheapest available model (Haiku or GPT-4o-mini)
LANTERN_ROUTE_STRATEGY=cheap make run-api

# Highest quality regardless of cost (Opus 4 or GPT-4o)
LANTERN_ROUTE_STRATEGY=quality make run-api

# Fastest response time (Haiku or GPT-4o-mini)
LANTERN_ROUTE_STRATEGY=fast make run-api`}</code></pre>

      <table>
        <thead>
          <tr><th>Strategy</th><th>Formula</th><th>Best for</th></tr>
        </thead>
        <tbody>
          <tr><td><code>balanced</code></td><td>Quality×4 + Speed×3 + CostEfficiency×3</td><td>Production workloads</td></tr>
          <tr><td><code>cheap</code></td><td>100 / (costIn + costOut + 1)</td><td>High-volume, cost-sensitive</td></tr>
          <tr><td><code>quality</code></td><td>Quality × 10</td><td>Complex analysis, reasoning</td></tr>
          <tr><td><code>fast</code></td><td>Speed × 10</td><td>Real-time chat, low latency</td></tr>
        </tbody>
      </table>

      <div className="callout callout-tip">
        <strong>Tip:</strong> In practice, &quot;auto&quot; with balanced routing saves
        40-60% on LLM costs compared to always using the most powerful model.
        Most agent steps are simple enough for a smaller, faster model.
      </div>

      <h2 id="keys">Adding API keys</h2>
      <p>
        To use a provider, add your API key in the dashboard:
      </p>
      <ol>
        <li>
          Navigate to <strong>Settings &gt; Models</strong>
        </li>
        <li>Click the provider you want to configure</li>
        <li>Enter your API key</li>
        <li>
          Click <strong>Save</strong> -- the key is encrypted at rest
        </li>
      </ol>
      <p>[Screenshot: Model provider settings with API key input]</p>

      <div className="callout callout-warning">
        <strong>Warning:</strong> API keys are stored encrypted and never
        appear in logs, traces, or run state. They are resolved at execution
        time inside the microVM using the{" "}
        <code>lantern.secret/...</code> reference form.
      </div>

      <h3>Multiple keys per provider</h3>
      <p>
        You can add multiple API keys for the same provider. The router will
        distribute requests across keys to avoid rate limits. You can also
        set a primary and fallback key.
      </p>

      <h2>Failover behavior</h2>
      <p>
        The model router handles provider failures automatically:
      </p>
      <ul>
        <li>
          <strong>Latency spike</strong> -- if a provider&apos;s response time
          exceeds the P95 threshold, subsequent requests route to an
          alternative
        </li>
        <li>
          <strong>5xx errors</strong> -- immediate retry on an alternative
          provider
        </li>
        <li>
          <strong>Rate limits (429)</strong> -- exponential backoff with
          automatic rotation to another key or provider
        </li>
        <li>
          <strong>Timeout</strong> -- configurable per-step timeout with
          failover
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> Failover is transparent to the agent. The step
        receives the response regardless of which provider actually served it.
        The run trace shows which provider was used for observability.
      </div>

      <h2>Cost tracking</h2>
      <p>
        Every LLM call is metered and tracked. You can view per-agent and
        per-run cost breakdowns in the dashboard under{" "}
        <strong>Usage &gt; Model costs</strong>. The router also provides
        recommendations for switching capabilities to save costs.
      </p>

      <h2>Overriding the router</h2>
      <p>
        If you need a specific model for a step (e.g., for compliance reasons),
        you can override the router in the SDK:
      </p>
      <pre>
        <code>{`const result = await step("analyze", async () => {
  return ctx.llm.complete({
    messages: [...],
    capability: "reasoning-large",
    provider: "anthropic",  // Force Anthropic
    model: "claude-opus-4", // Force a specific model
  });
});`}</code>
      </pre>

      <div className="callout callout-warning">
        <strong>Warning:</strong> Overriding the router bypasses failover and
        cost optimization. Use this only when you have a specific reason (e.g.,
        regulatory requirements for a particular provider).
      </div>
    </>
  );
}
