import { Concept } from "../_components/Concept";

export default function MarketplacePage() {
  return (
    <>
      <h1>Marketplace &amp; A2A</h1>
      <p>
        Publish an agent, fork someone else&apos;s into your tenant, or call a
        published agent without forking it. A2A agent cards make public agents
        discoverable by other platforms.
      </p>

      <Concept>
        Browse published agents and fork one into your workspace. The fork is
        your private copy. A2A (Agent-to-Agent) is an open protocol for agents
        to find and call each other; an agent card is the public description an
        agent publishes.
      </Concept>

      <h2 id="what">What is the Marketplace</h2>
      <p>
        In the dashboard, <strong>Marketplace</strong> sits under the
        Workspace section. Two registries sit behind it:
      </p>
      <ul>
        <li>
          <strong>Agent Marketplace</strong> -- published agents
          (<code>/v1/marketplace</code>). Filter by category or search text;
          star, fork, or unpublish your own. Listings carry a description,
          tags, README, star and fork counts.
        </li>
        <li>
          <strong>MCP Marketplace</strong> -- a curated registry of Model
          Context Protocol servers (<code>/v1/mcp/servers</code>). Attach one
          to an agent with{" "}
          <code>POST /v1/agents/&#123;name&#125;/mcp-servers</code>.
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> A fork is a copy in your tenant. The original
        author does not see your data or runs.
      </div>

      <h2 id="a2a">A2A Agent Cards and visibility</h2>
      <p>
        Lantern implements the{" "}
        <strong>Agent-to-Agent (A2A) protocol</strong> for cross-platform agent
        discovery. Agents are <strong>private by default</strong> (
        <code>agents.is_public = false</code>). The card, the well-known
        directory, and A2A invoke only expose an agent to a non-owner when it
        is marked public. No REST endpoint sets the flag yet; today it is a
        column on <code>agents</code> that an operator flips.
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
        Publishing copies the agent&apos;s manifest into the public registry
        under a slug. There is no review queue and no unlisted mode; a listing
        is live as soon as the call returns.
      </p>
      <pre>
        <code>{`POST /v1/marketplace/publish
{
  "agentName": "research-agent",
  "description": "Cited research reports",
  "category": "research",
  "tags": ["research", "web"],
  "readme": "..."
}

DELETE /v1/marketplace/{slug}     # unpublish`}</code>
      </pre>

      <div className="callout callout-warning">
        <strong>Warning:</strong> Anyone can read a published agent&apos;s
        manifest, including its system prompt. Do not put secrets in a
        manifest. Use <code>lantern.secret/...</code> refs, which each
        tenant resolves from its own store at run time.
      </div>

      <h2 id="discovering">Discovering and forking agents</h2>
      <pre>
        <code>{`GET  /v1/marketplace?category=research&q=citations
GET  /v1/marketplace/{slug}                 # manifest, card, README
POST /v1/marketplace/{slug}/fork            { "newName": "my-copy" }
POST /v1/marketplace/{slug}/star`}</code>
      </pre>
      <p>
        A fork is a normal agent in your tenant. Edit its prompt, swap models,
        add connectors; the original is unaffected.
      </p>

      <h2 id="commerce">Cross-tenant invocation (commerce)</h2>
      <p>
        A buyer can invoke a published agent without forking it. The run
        executes in the <strong>seller&apos;s</strong> tenant, with their LLM
        keys and budgets. The seller&apos;s hard-fail budget applies (HTTP
        402), and the buyer&apos;s input is validated against the manifest&apos;s{" "}
        <code>inputSchema</code> when one exists. The buyer gets the output and
        an HMAC-SHA256 signed receipt.
      </p>
      <pre>
        <code>{`POST /v1/marketplace/{slug}/invoke
{ "input": { "topic": "..." } }

Receipt fields: invocationId, buyerTenant, sellerTenant, marketplace,
  agentName, runId, costUsd, issuedAt, signature, algorithm

GET /v1/marketplace/invocations?role=buyer    # buyer-side history
GET /v1/marketplace/invocations?role=seller   # seller-side history`}</code>
      </pre>

      <h2 id="interop">Cross-platform interop</h2>
      <ul>
        <li>
          <strong>Discovery</strong> -- other platforms read{" "}
          <code>/.well-known/agent.json</code> and{" "}
          <code>/v1/agents/&#123;name&#125;/card</code>. Both are limited to
          public agents (plus your own, when authenticated).
        </li>
        <li>
          <strong>Inbound call</strong> --{" "}
          <code>POST /v1/agents/&#123;name&#125;/a2a/invoke</code> requires an
          authenticated caller; it returns 401 without credentials.
        </li>
        <li>
          <strong>Outbound call</strong> -- inside a running agent,{" "}
          <code>ctx.a2a(agentCardUrl).submit(&#123; input &#125;)</code> calls a
          remote A2A agent through the runtime sidecar (production runtime
          only). <code>ctx.subagent(name, input)</code> calls another Lantern
          agent by name.
        </li>
      </ul>
    </>
  );
}
