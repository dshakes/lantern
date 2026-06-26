# hello-world

> **Heads up: this example targets the Lantern SDK in-VM runtime, which is not
> runnable yet.** It uses `agent()` / `step()` with `ctx.llm`, `ctx.tools`,
> `ctx.connectors`, and/or `ctx.mem` — the in-microVM tool runtime, where
> `exec_tool` currently returns `TOOL_STATUS_UNAVAILABLE` (see the repo
> `CLAUDE.md`). It illustrates the intended SDK shape; it does **not** execute
> against the running stack today. For agents that run right now against the
> live control-plane, see [`examples/quickstart/`](../quickstart/).


A simple greeting agent that demonstrates the basics of building a Lantern agent.

## How to run

```bash
lantern run hello-world --input '{"name": "Alice"}'
```

## Example input

```json
{
  "name": "Alice"
}
```

## Example output

```json
{
  "greeting": "Hey Alice! The world just got a little brighter knowing you're here — welcome to whatever amazing thing you're about to do today!"
}
```
