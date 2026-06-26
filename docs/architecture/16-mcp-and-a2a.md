# MCP and A2A — Open Protocols for Agent Interop

> **What this is:** how Lantern speaks the two open standards that matter for agent ecosystems in 2026: **MCP** (Model Context Protocol, Anthropic) and **A2A** (Agent-to-Agent, Google). Both are first-class — not afterthoughts, not adapters.
>
> **Why it matters:** the agent ecosystem is finally converging on shared protocols. A platform that doesn't speak them is an island. A platform that speaks them fluently becomes a hub.

---

## What MCP and A2A are (and aren't)

### MCP — Model Context Protocol
Open protocol from Anthropic (2024-2025) that standardizes **how an LLM client connects to external tools, resources, and prompts**. Three primitives:

| MCP primitive | What it is | Lantern maps to |
|---|---|---|
| **Tool** | A callable function the model can invoke | Connector action, built-in tool, sub-agent |
| **Resource** | A read-only data source the model can fetch | Memory entries, files in the agent workspace, connector queries |
| **Prompt** | A reusable parameterized prompt template | Versioned prompts in `prompts/` |

MCP is **transport-agnostic** (stdio, HTTP+SSE, WebSocket) and **JSON-RPC 2.0** on the wire. The breakthrough: a single client (Claude, Cursor, Lantern) can talk to N MCP servers (filesystem, GitHub, Postgres, your custom thing) without N custom integrations.

### A2A — Agent-to-Agent Protocol
Open protocol from Google (2025) that standardizes **how an agent talks to another agent**, possibly hosted on a different platform by a different vendor. Key concepts:

| A2A concept | What it is |
|---|---|
| **Agent Card** | Public metadata describing an agent: name, capabilities, auth requirements, A2A endpoint URL |
| **Task** | A unit of work sent from one agent to another, with state machine (`submitted` → `working` → `input-required` → `completed` / `failed` / `canceled`) |
| **Artifact** | Structured outputs the receiving agent produces |
| **Message** | Conversational turn during a task (multi-modal: text, files, structured data) |

A2A is **HTTP+JSON** with optional streaming via SSE for long-running tasks. The breakthrough: a Lantern agent can hand a task to a Vertex agent (or vice versa) without bespoke glue.

**MCP and A2A are complements, not alternatives.** MCP is "how an LLM gets context and tools." A2A is "how two complete agents collaborate." Lantern is fluent in both.

---

## Lantern as MCP client

Any MCP server in the world is a tool source for Lantern agents. Users add servers in three ways:

### 1. From the dashboard / mobile app
"Add MCP server" → paste a URL or pick from a curated list (filesystem, GitHub, Postgres, Brave Search, Notion, custom). The connector framework runs it through OAuth (if needed) and registers the server's tools, resources, and prompts in the tenant's tool catalog.

### 2. In `agent.yaml`
```yaml
mcp_servers:
  - id: my-postgres
    transport: http+sse
    url: https://mcp.example.com/postgres
    auth: lantern.secret/pg_mcp_key

  - id: github
    transport: stdio
    command: ["npx", "-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: lantern.secret/github_pat

tools:
  - mcp:my-postgres/query
  - mcp:github/list_issues
  - mcp:github/create_pr
```

The runtime manager spawns stdio servers inside the agent's sandbox (so the MCP server runs in the same isolation class as the agent code). HTTP+SSE servers are called over the egress allowlist with auth handled by the framework.

### 3. From SDK code
```ts
const issues = await ctx.mcp("github").call("list_issues", { repo: "acme/web" });
const pr     = await ctx.mcp("github").call("create_pr", { ... });
const schema = await ctx.mcp("my-postgres").resource("schema://public");
```

Calls are wrapped in `step()` automatically. Tool schemas are typed via TypeScript codegen from the MCP server's `tools/list` response.

### Key behaviors

- **Tool catalog** — every connected MCP server publishes tools, resources, and prompts to a per-tenant catalog. The model router knows what's available so it can offer the right tools to the LLM.
- **Sandbox isolation** — stdio MCP servers run inside the agent sandbox, so they can't escape to other tenants. HTTP+SSE servers hit the egress allowlist.
- **Caching** — read-only MCP resources are cached by URL+ETag.
- **Observability** — every MCP call is an OTel span tagged with `mcp.server`, `mcp.method`, latency, status.
- **Security** — MCP servers cannot access the credential vault. Secrets are passed via env vars at exec time and zeroed on exit.

---

## Lantern as MCP server

The other direction is more powerful: **every Lantern agent is automatically exposed as an MCP server.**

This means an engineer using Claude Code, Cursor, or any MCP-aware client can connect to their Lantern workspace and get every agent as a tool, every memory as a resource, and every saved prompt as a prompt.

### What Lantern exposes via MCP

| MCP primitive | Lantern mapping |
|---|---|
| **Tools** | Each agent → one tool: `lantern__<agent_name>` with the agent's input schema. Calling it starts a real run and streams the result back. Sub-tools per saved entrypoint of multi-entry agents. |
| **Resources** | Tenant memory entries: `mem://core/...`, `mem://recall/...`, `mem://archival/...`. Run history: `runs://<run_id>`. Bundle artifacts: `bundles://<agent>@<version>/...`. |
| **Prompts** | Saved prompt templates from agents that ship them, parameterized. |

### Endpoint

```
https://mcp.<tenant>.lantern.run
```

Authenticated with a Lantern MCP key (separate from API keys; scoped to MCP usage so revocation doesn't break the user's automations).

### Example: connecting Claude Code to a Lantern workspace

```bash
# In ~/.claude/mcp_servers.json
{
  "lantern": {
    "transport": "http+sse",
    "url": "https://mcp.acme.lantern.run",
    "auth": { "type": "bearer", "token": "${LANTERN_MCP_KEY}" }
  }
}
```

Now inside Claude Code:
- `@lantern research-agent "compare X vs Y"` → spawns a run on Lantern, streams the result back into the Claude Code conversation
- `Read mem://archival/customer/acme` → reads from the user's archival memory
- `Use prompt lantern:summarize-pr params={...}` → renders a saved prompt

This makes Lantern a **shared brain** that every IDE and chat client can plug into.

---

## Lantern and A2A

A2A is how Lantern agents talk to **other vendors' agents** — and how other vendors' agents call Lantern.

### Lantern as A2A server

Every Lantern agent automatically gets an Agent Card published at:

```
https://a2a.<tenant>.lantern.run/.well-known/agent.json
```

Example agent card:

```json
{
  "schema": "a2a/v1",
  "name": "research-agent",
  "displayName": "Research Agent",
  "description": "Plans, searches, and synthesizes research reports.",
  "vendor": { "name": "Acme", "url": "https://acme.lantern.run" },
  "auth": [{ "scheme": "bearer", "scope": "agents:run" }],
  "endpoint": "https://a2a.acme.lantern.run/v1/agents/research-agent",
  "capabilities": {
    "streaming": true,
    "multi_turn": true,
    "files": { "input": ["text/*", "application/pdf"], "output": ["text/markdown"] },
    "modalities": ["text"]
  },
  "input_schema": { /* JSON schema */ },
  "output_schema": { /* JSON schema */ }
}
```

A2A clients (Vertex, OpenAI Agents, anyone) can discover the card, authenticate, and POST a task. The A2A server inside the surface-gateway translates the A2A task lifecycle into a Lantern run lifecycle:

| A2A state | Lantern run state |
|---|---|
| `submitted` | `queued` |
| `working` | `running` |
| `input-required` | `paused-on-question` (uses the same `ctx.ask` mechanism as Control Surfaces) |
| `completed` | `succeeded` |
| `failed` | `failed` |
| `canceled` | `cancelled` |

Streaming is implemented via SSE.

### Lantern as A2A client

Lantern agents can call A2A peers from SDK code:

```ts
const result = await ctx.a2a("https://agents.partner.com/.well-known/agent.json")
  .submit({
    input: { query: "What's the latest on Project Phoenix?" },
    timeout: "5m",
  });
```

The framework handles:
- Agent card discovery and capability matching
- Auth (the user has to pre-install credentials for a remote agent the same way they install a connector)
- Streaming
- Task lifecycle (poll if streaming isn't supported)
- Idempotency keys (an A2A call from inside a `step()` is idempotent on retry)
- OTel spans across both sides (W3C trace context is propagated in A2A headers)

### Multi-agent topologies enabled by A2A

Once Lantern speaks A2A, the architectures users can build expand significantly:

```
┌──────────────────────────┐
│ Lantern orchestrator agent │
└────┬─────────────────────┘
     │ A2A
     ▼
┌──────────────────┐    ┌────────────────────┐    ┌──────────────────┐
│ Vertex agent     │    │ OpenAI agent       │    │ Lantern sub-agent  │
│ (search Google)  │    │ (computer use)     │    │ (synthesize)     │
└──────────────────┘    └────────────────────┘    └──────────────────┘
```

The orchestrator runs in Lantern; some workers are Lantern agents, some are remote A2A peers. The user gets one observability dashboard, one billing view, and one durable execution journal across the entire topology.

---

## Discoverability and the registry

Lantern runs an **Agent Registry** at `https://registry.lantern.run` (post-launch) where users can publish their agents (with consent) and discover others'. Each registry entry includes:

- The A2A agent card
- The MCP server metadata (if exposed)
- Pricing and rate limits
- Reviews and trust signals
- A "try it" button that runs a free test

This is the network effect: **the more agents on Lantern, the more useful Lantern is to every other agent on Lantern**, because they can compose via A2A.

---

## Security model for cross-platform protocols

- **Outbound calls go through the egress allowlist.** Users approve domains before agents can call them. A2A discovery is special-cased to allow `.well-known/agent.json` fetches but not arbitrary endpoints until the user accepts the agent card.
- **Inbound MCP / A2A requires a scoped key** that's revocable independently of normal API keys.
- **Capability scopes** — an MCP key can be scoped to read-only resources, specific agents, or specific runs.
- **Audit log** entries for every cross-platform call, including the remote agent identity and the trace ID.
- **Rate limits** apply equally to MCP/A2A inbound traffic as to regular API traffic.

---

## Implementation surface

- `services/gateway/src/mcp/` — MCP server endpoints (HTTP+SSE) and stdio adapter
- `services/gateway/src/a2a/` — A2A server endpoints, agent card publisher
- `services/runtime-manager/src/mcp_client/` — spawning stdio MCP servers inside sandboxes
- `packages/sdk-ts/src/mcp.ts` and `packages/sdk-ts/src/a2a.ts` — typed client surfaces
- `packages/sdk-python/src/mcp/` and `packages/sdk-python/src/a2a/` — Python equivalents
- `services/control-plane/src/registry/` — agent registry (post-launch)

---

## What we're betting on

That **MCP wins as the tools/context standard** and **A2A wins as the agent-interop standard**, and that within 12-18 months every serious agent platform will speak both. By implementing both as first-class on day one — not as adapters or plugins — Lantern is positioned to be the **interop hub** of the agent ecosystem rather than a walled garden.

If we're wrong about either protocol, the cost is contained (each is an isolated subsystem). If we're right, the upside is enormous: Lantern becomes the platform every other platform talks to.
