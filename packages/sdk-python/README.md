# lantern-sdk (Python)

The official Python SDK for [Lantern](https://github.com/dshakes/lantern) — the
open-source runtime for production AI agents with VPC deployment, pre-run cost
forecasts, policy budgets, and eval-in-CI.

Python 3.11+. Async-first (httpx + asyncio). Full parity with the TypeScript SDK's
HTTP surface.

---

## Install

The package is pre-release. Install from the repo:

```bash
pip install -e "path/to/lantern/packages/sdk-python"
# or in CI:
pip install "git+https://github.com/dshakes/lantern.git#subdirectory=packages/sdk-python"
```

Dependencies pulled in automatically: `httpx>=0.27`, `pydantic>=2.0`, `grpcio>=1.62`,
`protobuf>=5.0`, `opentelemetry-api>=1.20`.

---

## Quick start

```python
import asyncio
import os
from lantern import LanternClient

async def main():
    async with LanternClient(
        api_key=os.environ["LANTERN_API_KEY"],
        # base_url defaults to https://api.lantern.run
        # or set LANTERN_API_URL for a self-hosted instance
    ) as client:

        # 1. Create an agent
        agent = await client.agents.create(name="triage", description="Classifies support emails")

        # 2. Run it
        run = await client.runs.create(agent="triage", input={"email": "my invoice is wrong"})
        print(run.status, run.output)

        # 3. Stream events in real time
        async for event in client.runs.events(run.id):
            print(event.kind, event.data)

asyncio.run(main())
```

---

## Client constructor

```python
LanternClient(
    base_url: str | None = None,    # default: LANTERN_API_URL or https://api.lantern.run
    api_key: str | None = None,     # default: LANTERN_API_KEY
    *,
    timeout: float = 30.0,          # per-request timeout in seconds
    route_strategy: str | None = None,  # default: LANTERN_ROUTE_STRATEGY or "auto"
)
```

Use as a context manager (`async with LanternClient(...) as client`) to ensure the
underlying httpx connection pool is closed. Call `await client.close()` manually if
not using a context manager.

---

## Env vars

| Var | Purpose |
|---|---|
| `LANTERN_API_URL` | Base URL of the control-plane API. Default `https://api.lantern.run`. For local dev: `http://localhost:8080` |
| `LANTERN_API_KEY` | Bearer token issued by `POST /auth/login` or the API-keys settings page |
| `LANTERN_ROUTE_STRATEGY` | One of `auto`, `cheap`, `best`, `fast`. Sent as `X-Lantern-Route-Strategy`. Default `auto` |

---

## API reference

### Agents — `client.agents`

```python
# Create
agent: AgentInfo = await client.agents.create(name="my-agent", description="...", labels={})

# Get
agent: AgentInfo = await client.agents.get("my-agent")

# List
resp: AgentListResponse = await client.agents.list(page_size=50, page_token=None)
# resp.agents: list[AgentInfo]
# resp.next_page_token: str | None

# Delete
await client.agents.delete("my-agent")
```

### Runs — `client.runs`

```python
# Create (returns Run)
run: Run = await client.runs.create(
    agent="triage",
    input={"email": "..."},
    labels={},
    idempotency_key=None,   # optional; derived from (run_id, step_id, attempt) in the engine
)

# Create with streaming (returns async iterator of StreamEvent)
stream = await client.runs.create(agent="triage", input={...}, stream=True)
async for event in stream:
    print(event.kind, event.data)

# Get, list, cancel
run: Run = await client.runs.get(run_id)
resp: RunListResponse = await client.runs.list(agent="triage", status="completed", page_size=50)
run: Run = await client.runs.cancel(run_id, reason="user cancelled")

# Stream events from a completed or live run
async for event in client.runs.events(run_id, from_seq=0, live=True):
    print(event.kind, event.data)

# Send a signal to a paused run (workflow approval / step_signal)
await client.runs.signal(run_id, name="approved", value={"comment": "lgtm"})
```

### Sessions — `client.sessions`

```python
# Create an interactive multi-turn session
session: Session = await client.sessions.create(agent="my-agent", metadata={})

# Send a message and get the synchronous response
msg: SessionMessage = await client.sessions.send_message(session_id, content="hello", role="user")

# Stream session events (SSE)
async for event in client.sessions.stream_events(session_id, from_seq=0):
    print(event)

# Get, list, close
session = await client.sessions.get(session_id)
resp: SessionListResponse = await client.sessions.list(agent="my-agent", status="active")
await client.sessions.close(session_id)
```

### Connectors — `client.connectors`

```python
# List installed connectors
resp: ConnectorListResponse = await client.connectors.list()

# Execute a connector action (e.g. send a Slack message)
result: ConnectorResult = await client.connectors.execute(
    "slack",
    "send_message",
    params={"channel": "#general", "text": "Hello from Lantern!"},
)

# List available actions for a connector
actions: list[dict] = await client.connectors.list_actions("slack")
```

---

## Building an agent (decorator style)

```python
from lantern import agent, step, tool
from lantern.types import AgentContext

@agent("researcher", model="reasoning-large", description="Deep research agent")
async def researcher(input: dict, ctx: AgentContext) -> dict:
    # step() is durable: result is journalled and replayed on restart
    results = await step(
        "search",
        lambda: ctx.tools.web.search(input["query"]),
    )
    # parallel fan-out
    summaries = await step_map(
        "summarize",
        results[:5],
        lambda item, i: ctx.llm.complete(prompt=f"Summarize: {item}"),
        concurrency=3,
    )
    return {"summaries": summaries}
```

### Step primitives

| Function | Behaviour |
|---|---|
| `await step(name, fn, *, retry, timeout)` | Single durable step. `fn` is an async callable. |
| `await step_map(name, items, fn, *, concurrency, retry, timeout)` | Fan-out over a list; each item gets its own journal entry `name[i]` |
| `await step_race(name, fns, *, retry, timeout)` | Run multiple callables concurrently; return the first result, cancel the rest |
| `await step_sleep(name, duration)` | Durable sleep. Duration strings: `"30s"`, `"5m"`, `"2h"` |
| `await step_signal(name, *, timeout)` | Wait for an external signal. Only functional in the Lantern production runtime |

In local / dev mode all step primitives execute the function directly (no
journalling). The production runtime installs a journal-aware runner via
`set_step_runtime()`.

### Built-in tools

```python
from lantern.tools import tool   # singleton registry

@agent("worker", tools=[tool.web, tool.python])
async def worker(input: dict, ctx: AgentContext) -> dict:
    html = await ctx.tools.web.fetch("https://example.com")
    ...
```

Available: `tool.web`, `tool.python`, `tool.fs`, `tool.browser`. `tool.all()` returns
all four.

### Class-based pattern

```python
from lantern.agent import LanternAgent
from lantern.types import AgentContext

class MyAgent(LanternAgent):
    name = "my-agent"
    model = "auto"

    async def run(self, input: dict, ctx: AgentContext) -> dict:
        ...
```

---

## Errors

All errors inherit from `LanternError`.

| Exception | Raised when |
|---|---|
| `LanternApiError(status_code, body)` | HTTP response is non-2xx |
| `LanternStepError(name, reason)` | Step execution fails |
| `LanternLlmError` | LLM call fails (budget, provider, timeout) |
| `LanternTimeoutError(name, duration)` | `step()` / `step_sleep()` timeout exceeded |
| `LanternValidationError` | Invalid agent name or config |

---

## Running an agent locally

```bash
python -m lantern.runtime.runner --agent hello-world --input '{"name": "World"}'
```

The `lantern-runner` entry point (installed by `pip install`) does the same:

```bash
lantern-runner --agent hello-world --input '{"name": "World"}'
```

---

## Parity note

The Python SDK covers agents, runs, sessions, and connectors — the same HTTP surface
as the TypeScript SDK. The TypeScript SDK additionally exposes `budgets`, `evalSuites`,
`evalRuns`, `experiments`, and `marketplace` namespaces. Those endpoints are callable
today via raw `client._request(...)` calls; typed helper classes are planned for a
follow-up release. The agent definition layer (`@agent`, `step`, `tool`) mirrors the
TypeScript surface except that `zod` schema validation is replaced by plain Python
type hints and pydantic models.
