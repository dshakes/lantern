# pal-runtime (Python)

The official Python SDK for [PAL](https://github.com/dshakes/lantern) — the
open-source runtime for production AI agents with VPC deployment, pre-run cost
forecasts, policy budgets, and eval-in-CI.

Python 3.11+. Async-first (httpx + asyncio). Full parity with the TypeScript SDK's
HTTP surface.

---

## Install

Registry packages are not published yet. The distribution is named `pal-runtime`; do not
`pip install lantern-sdk` (that PyPI name belongs to an unrelated project). Install from the repo:

```bash
pip install "path/to/lantern/packages/sdk-python"          # add [deepagents] for the extra below
# or in CI:
pip install "git+https://github.com/dshakes/lantern.git#subdirectory=packages/sdk-python"
```

The import package is `pal` (`from pal import PalClient`); the CLI entry point is `pal-runner`.

**Deprecated:** the old `lantern` import package (and `lantern-runner`, `LanternClient`, `Lantern*Error`,
`LanternSandbox`) remains as a thin shim that emits a `DeprecationWarning`. It resolves to the same
objects/modules as `pal`, but new code should import from `pal` (ADR 0032).

Dependencies pulled in automatically: `httpx>=0.27`, `pydantic>=2.0`, `grpcio>=1.62`,
`protobuf>=5.0`, `opentelemetry-api>=1.20`.

Optional extras:

| Extra        | Pulls in           | For                                                        |
| ------------ | ------------------ | ---------------------------------------------------------- |
| `deepagents` | `deepagents>=0.6`  | Run a LangChain deepagents agent on a PAL microVM — see [deepagents integration](#deepagents-integration) |

---

## Quick start

```python
import asyncio
import os
from pal import PalClient

async def main():
    async with PalClient(
        api_key=os.environ["PAL_API_KEY"],
        # base_url defaults to https://api.lantern.run
        # or set PAL_API_URL for a self-hosted instance
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
PalClient(
    base_url: str | None = None,    # default: PAL_API_URL or https://api.lantern.run
    api_key: str | None = None,     # default: PAL_API_KEY
    *,
    timeout: float = 30.0,          # per-request timeout in seconds
    route_strategy: str | None = None,  # default: PAL_ROUTE_STRATEGY or "auto"
)
```

Use as a context manager (`async with PalClient(...) as client`) to ensure the
underlying httpx connection pool is closed. Call `await client.close()` manually if
not using a context manager.

---

## Env vars

| Var | Purpose |
|---|---|
| `PAL_API_URL` | Base URL of the control-plane API. Default `https://api.lantern.run`. For local dev: `http://localhost:8080` |
| `PAL_API_KEY` | Bearer token issued by `POST /auth/login` or the API-keys settings page |
| `PAL_ROUTE_STRATEGY` | One of `auto`, `cheap`, `best`, `fast`. Sent as `X-Pal-Route-Strategy` (and legacy `X-Lantern-Route-Strategy`). Default `auto` |

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
    params={"channel": "#general", "text": "Hello from PAL!"},
)

# List available actions for a connector
actions: list[dict] = await client.connectors.list_actions("slack")
```

---

## Building an agent (decorator style)

```python
from pal import agent, step, tool
from pal.types import AgentContext

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
| `await step_signal(name, *, timeout)` | Wait for an external signal. Only functional in the PAL production runtime |

In local / dev mode all step primitives execute the function directly (no
journalling). The production runtime installs a journal-aware runner via
`set_step_runtime()`.

### Built-in tools

```python
from pal.tools import tool   # singleton registry

@agent("worker", tools=[tool.web, tool.python])
async def worker(input: dict, ctx: AgentContext) -> dict:
    html = await ctx.tools.web.fetch("https://example.com")
    ...
```

Available: `tool.web`, `tool.python`, `tool.fs`, `tool.browser`. `tool.all()` returns
all four.

### Class-based pattern

```python
from pal.agent import PalAgent
from pal.types import AgentContext

class MyAgent(PalAgent):
    name = "my-agent"
    model = "auto"

    async def run(self, input: dict, ctx: AgentContext) -> dict:
        ...
```

---

## Errors

All errors inherit from `PalError`.

| Exception | Raised when |
|---|---|
| `PalApiError(status_code, body)` | HTTP response is non-2xx |
| `PalStepError(name, reason)` | Step execution fails |
| `PalLlmError` | LLM call fails (budget, provider, timeout) |
| `PalTimeoutError(name, duration)` | `step()` / `step_sleep()` timeout exceeded |
| `PalValidationError` | Invalid agent name or config |

---

## Running an agent locally

```bash
python -m pal.runtime.runner --agent hello-world --input '{"name": "World"}'
```

The `pal-runner` entry point (installed by `pip install`) does the same:

```bash
pal-runner --agent hello-world --input '{"name": "World"}'
```

---

## deepagents integration

`pip install "path/to/lantern/packages/sdk-python[deepagents]"` adds a
[deepagents](https://github.com/langchain-ai/deepagents) sandbox backend that runs
the agent's shell and filesystem inside a PAL microVM instead of on the host.
Egress allowlist, secret vending, and per-tenant quota are enforced by the runtime,
not by the prompt — untrusted agent code never touches a bare shell (invariant #5).

```python
from deepagents import create_deep_agent
from pal.integrations.deepagents_sandbox import PalSandbox

with PalSandbox.create(image_digest="sha256:...") as sandbox:
    agent = create_deep_agent(backend=sandbox)
    agent.invoke({"messages": [{"role": "user", "content": "run the tests"}]})
```

`PalSandbox` implements deepagents' `SandboxBackendProtocol`. deepagents'
`BaseSandbox` derives the full filesystem toolset (`ls`/`read`/`write`/`edit`/
`glob`/`grep`) from three primitives, so the backend is just those three mapped
onto the runtime REST surface:

| Backend method                   | PAL endpoint                          |
| -------------------------------- | ----------------------------------------- |
| `execute()`                      | `POST /v1/runtime/vms/{id}/exec`          |
| `upload_files()`/`download_files()` | base64 over the same exec channel      |
| `create()` / `close()`           | `POST /v1/runtime/schedule` / `DELETE /v1/runtime/vms/{id}` |

Constructors:

- `PalSandbox.create(image_digest=..., **spec)` — schedules a fresh microVM and
  polls until it is `running`. Extra kwargs pass through to `/v1/runtime/schedule`
  (`limits`, `egressRules`, `secrets`, `labels`, ...). Terminates the VM on exit.
- `PalSandbox.connect(vm_id)` — attaches to an already-running VM; does **not**
  terminate it on close.

Composes with deepagents' own `CompositeBackend` so state can outlive the VM —
mount a store at `/memories/` while everything else executes in the sandbox. See
[`examples/deepagents_sandbox_agent.py`](examples/deepagents_sandbox_agent.py) for a
runnable version that also wires `RubricMiddleware` for in-loop self-evaluation.

Reads `PAL_API_URL` / `PAL_API_KEY` like the main client; pass `base_url` /
`api_key` explicitly to override.

`create()` defaults the entrypoint to `sleep infinity`. A sandbox is a long-lived
exec target, so an image whose own entrypoint runs to completion (`python:3.11-slim`
just starts a REPL and exits) would be reaped by the runtime before the agent could
exec into it. Pass an explicit `command` to override.

**Verified against a real VM.** The full path — `PalSandbox` → control-plane
→ runtime-scheduler → runtime-manager → real container — is exercised end to end
on the `docker` backend, covering `execute`, binary upload/download roundtrip, and
the BaseSandbox-derived `write`/`read`/`ls`/`edit`/`grep` the agent actually calls.
The Go-side regression test is
`services/control-plane/internal/handlers/runtime_exec_e2e_test.go` (opt-in via
`PAL_RUNTIME_E2E=1`). The **Firecracker** path specifically is not verifiable
on macOS (no `/dev/kvm`) — that is covered by the `microvm · integration` CI job on
a KVM runner. Exec routing differs between them: the manager sends Firecracker VMs
to the in-guest harness and everything else through the backend.

**Known ceilings.** File transfer is base64-inline over the exec channel — fine for
agent-sized files, but a large binary should move via object storage. A microVM
image digest is required; the sandbox does not build one for you.

---

## Parity note

The Python SDK's management surface (`agents`, `runs`, `sessions`, `connectors`,
`budgets`, `evals`, `experiments`, `marketplace`, `mcp`, `receipts`, `feedback`,
`rehearsals`) is at parity with the TypeScript SDK's HTTP surface — all typed,
none require raw `client._request(...)` calls. The agent definition layer
(`@agent`, `step`, `tool`) mirrors the TypeScript surface except that `zod`
schema validation is replaced by plain Python type hints and pydantic models.
