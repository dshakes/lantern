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

      <h2 id="a2a">A2A Agent Cards and visibility</h2>
      <p>
        Lantern implements the{" "}
        <strong>Agent-to-Agent (A2A) protocol</strong> for cross-platform agent
        discovery. Agents are <strong>private by default</strong> (
        <code>agents.is_public = false</code>). The card, the well-known
        directory, and A2A invoke only expose an agent to a non-owner when it
        is explicitly made public.
      </p>

      <h3>Visibility rules</h3>
      <ul>
        <li>
          An authenticated caller always sees and can invoke their{" "}
          <strong>own</strong> agents regardless of visibility.
        </li>
        <li>
          A card or invoke for another tenant&apos;s agent returns{" "}
          <strong>404</strong> (not 403) when the agent is not public — to
          avoid leaking that the agent exists.
        </li>
        <li>
          <code>GET /.well-known/agent.json</code> lists only{" "}
          <code>is_public = true</code> agents.
        </li>
      </ul>

      <h3>Agent Card endpoints</h3>
      <pre>
        <code>{`GET /v1/agents/{name}/card          — own agent or is_public; else 404
GET /.well-known/agent.json          — lists only public agents`}</code>
      </pre>

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

      <h2 id="commerce">Cross-tenant invocation (commerce)</h2>
      <p>
        Buyers can invoke a published marketplace agent without forking it.
        The run executes on the <strong>seller&apos;s</strong> tenant (their LLM
        keys, their budgets); the buyer receives the output plus an HMAC-signed
        receipt verifiable via the same <code>/proof</code> endpoint as run
        receipts.
      </p>
      <pre>
        <code>{`POST /v1/marketplace/{slug}/invoke
{ "input": { "topic": "..." } }

Response:
{
  "output": { "summary": "..." },
  "receipt": { "signature": "...", "payload": {...} }
}

GET /v1/marketplace/invocations?role=buyer   — buyer-side history
GET /v1/marketplace/invocations?role=seller  — seller-side history`}</code>
      </pre>

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
        <strong>Tip:</strong> The <code>/.well-known/agent.json</code> endpoint
        is compatible with any A2A-aware platform. External orchestrators can
        discover and invoke your public Lantern agents without a Lantern account.
      </div>
    </>
  );
}
