export default function MarketplacePage() {
  return (
    <>
      <h1>Marketplace &amp; A2A</h1>
      <p>
        The Lantern Marketplace is a registry of public agents and MCP servers
        that you can discover, preview, and deploy to your own tenant. Combined
        with A2A Agent Cards, it enables cross-platform agent discovery and
        interop.
      </p>

      <h2 id="what">What is the Marketplace</h2>
      <p>
        The Marketplace is accessible from the dashboard sidebar under{" "}
        <strong>Marketplace</strong>. It contains two sections:
      </p>
      <ul>
        <li>
          <strong>Agent Marketplace</strong> -- community-published agents that
          you can preview, fork, and customize. Each listing shows the
          agent&apos;s description, connectors, model requirements, and average
          cost per run.
        </li>
        <li>
          <strong>MCP Marketplace</strong> -- a registry of Model Context
          Protocol servers you can add as connectors. Browse by category
          (search, data, code, productivity) and install with a single click.
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> Marketplace content is tenant-isolated. When you
        fork an agent, a private copy is created in your tenant. The original
        author cannot see your data or runs.
      </div>

      <h2 id="a2a">How A2A Agent Cards work</h2>
      <p>
        Lantern implements the{" "}
        <strong>Agent-to-Agent (A2A) protocol</strong> for cross-platform agent
        discovery. Every deployed agent can expose an <strong>Agent Card</strong>{" "}
        -- a machine-readable JSON document describing its capabilities,
        inputs, outputs, and endpoint.
      </p>

      <h3>Agent Card endpoints</h3>
      <ul>
        <li>
          <code>GET /v1/agents/&#123;name&#125;/card</code> -- returns the A2A
          card for a specific agent
        </li>
        <li>
          <code>GET /.well-known/agent.json</code> -- well-known discovery
          endpoint that returns the default agent card for the tenant
        </li>
      </ul>

      <h3>Card structure</h3>
      <pre>
        <code>{`{
  "name": "my-research-agent",
  "description": "Researches topics and produces summaries",
  "version": "1.2.0",
  "capabilities": ["text-generation", "web-search", "summarization"],
  "inputs": [{ "name": "query", "type": "string", "required": true }],
  "outputs": [{ "name": "summary", "type": "string" }],
  "endpoint": "https://my-agent.lantern.cloud/v1/run",
  "auth": { "type": "bearer" }
}`}</code>
      </pre>

      <p>
        External platforms can fetch this card to understand what your agent
        does and how to invoke it, enabling seamless composition across
        different agent frameworks.
      </p>

      <h2 id="publishing">Publishing your agent</h2>
      <p>
        To publish an agent to the Marketplace:
      </p>
      <ol>
        <li>
          Navigate to your agent&apos;s detail page in the dashboard.
        </li>
        <li>
          Click <strong>Publish to Marketplace</strong> in the agent settings.
        </li>
        <li>
          Fill in the listing metadata: category, tags, example inputs, and a
          README describing what the agent does.
        </li>
        <li>
          Choose a visibility level: <strong>Public</strong> (anyone can see
          and fork) or <strong>Unlisted</strong> (only accessible via direct
          link).
        </li>
        <li>
          Submit for review. Published agents appear in the Marketplace within
          minutes.
        </li>
      </ol>

      <div className="callout callout-warning">
        <strong>Warning:</strong> Publishing an agent makes its configuration,
        system prompt, and instructions visible to other users. Secrets and API
        keys are never included -- they are resolved at runtime from each
        tenant&apos;s own secret store.
      </div>

      <h2 id="discovering">Discovering and forking agents</h2>
      <p>
        From the Marketplace page, you can:
      </p>
      <ul>
        <li>
          <strong>Browse</strong> agents by category (research, automation,
          customer support, coding, data analysis)
        </li>
        <li>
          <strong>Search</strong> by name, description, or tags
        </li>
        <li>
          <strong>Preview</strong> an agent&apos;s configuration, connectors,
          and sample outputs before forking
        </li>
        <li>
          <strong>Fork</strong> an agent to create a private copy in your
          tenant that you can customize
        </li>
      </ul>
      <p>
        Forked agents are fully independent. You can modify instructions,
        swap models, add connectors, and redeploy without affecting the
        original.
      </p>

      <h2 id="interop">Cross-platform interop</h2>
      <p>
        A2A Agent Cards enable interoperability beyond the Lantern ecosystem:
      </p>
      <ul>
        <li>
          <strong>Inbound</strong> -- external platforms can discover your
          Lantern agent via its <code>/.well-known/agent.json</code> endpoint
          and invoke it using the standard A2A protocol.
        </li>
        <li>
          <strong>Outbound</strong> -- Lantern agents can call external A2A
          agents using the <code>ctx.subagent()</code> API with a remote
          agent URL. The runtime fetches the remote card, validates
          compatibility, and routes the request.
        </li>
        <li>
          <strong>Composition</strong> -- build multi-agent workflows that
          span platforms. A Lantern orchestrator agent can delegate tasks to
          agents running on other frameworks, and vice versa.
        </li>
      </ul>

      <div className="callout callout-tip">
        <strong>Tip:</strong> Use the <code>lantern agent card</code> CLI
        command to inspect any agent&apos;s A2A card locally before deploying.
      </div>
    </>
  );
}
