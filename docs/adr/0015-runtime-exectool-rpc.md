# ADR 0015 — `RuntimeManager.ExecTool` RPC for single-tool workflow dispatch

- **Status:** Accepted
- **Date:** 2026-06-23
- **Deciders:** Lantern runtime, workflow-engine
- **Tags:** runtime, workflow-engine, proto, tool-execution

> **Status note (2026-07):** the in-guest tool runner named below as the follow-up
> has **since shipped** (`services/harness/src/tool_runner.rs`). For the
> **Firecracker** backend `exec_tool` now forwards the call to the harness over a
> JSON-over-`Exec` channel (magic command `__lantern_tool_call__`, port 50056) and
> maps the harness result: `ok:true` → `TOOL_STATUS_OK` + result, `ok:false` →
> `TOOL_STATUS_ERROR`, harness unreachable → `TOOL_STATUS_UNAVAILABLE`. Built-in
> tools today are `shell_exec` and `http_fetch` (the latter routed through the
> egress proxy). `TOOL_STATUS_UNAVAILABLE` now means only "no reachable harness" or
> "non-Firecracker backend" — see the corrected sections below.

## Context

The workflow engine executes `tool_call` steps (`services/workflow-engine/internal/engine/step_executor.go`).
Architectural invariant #5 requires every tool to run inside a microVM, so the
engine must dispatch tool calls to the runtime, not run them in-process.

The `lantern.v1.RuntimeManager` service exposed `Spawn / Stop / Logs / Exec /
Stats / Snapshot` — but no clean way to invoke a *single named tool* against a
run's workload and get a structured result back. `Exec` is a raw, bidirectional
streaming shell channel (stdin/stdout/stderr bytes, exit codes); it is the wrong
shape for "call tool `web_search` with `{query: …}` and give me the JSON
result".

P2-B3 left `executeToolCall` returning a typed `ErrToolDispatchUnavailable`
rather than fabricating a success — honest, but a dead end. This ADR adds the
RPC that fills the gap.

## Decision

Add a unary `ExecTool` RPC to `RuntimeManager` in
`packages/proto/lantern/v1/runtime.proto`:

```proto
rpc ExecTool (ExecToolRequest) returns (ExecToolResponse);

enum ToolStatus {
  TOOL_STATUS_UNSPECIFIED = 0;
  TOOL_STATUS_OK          = 1;   // tool ran; result is populated
  TOOL_STATUS_ERROR       = 2;   // tool ran but failed; error is populated
  TOOL_STATUS_UNAVAILABLE = 3;   // tool execution not wired (no harness/backend support yet)
}

message ExecToolRequest {
  string vm_id                   = 1;  // scheduler-issued wire id (optional)
  string run_id                  = 2;  // run identity (resolves the workload)
  string step_id                 = 3;
  string tool_name               = 4;  // tool to invoke
  google.protobuf.Struct args    = 5;  // structured tool arguments
  google.protobuf.Duration timeout = 6;
  string idempotency_key         = 7;  // (run_id, step_id, attempt) — invariant #8
}

message ExecToolResponse {
  ToolStatus status              = 1;
  google.protobuf.Struct result  = 2;  // populated on OK
  string error                   = 3;  // populated on ERROR / UNAVAILABLE
}
```

### Why unary + Struct, not a reuse of `Exec`

- `Exec` is streaming bytes for an interactive shell; a tool call is a single
  request/response with structured args and a structured result. Modeling it on
  `Exec` would force the engine to frame/parse a byte protocol it does not need.
- `google.protobuf.Struct` carries the SDK's arbitrary JSON tool-args and
  tool-result object losslessly without a bespoke schema per tool, matching the
  `Struct` already used for `AgentVersion.manifest` and `ExecuteRunRequest.input`.

### Typed `ToolStatus`, never a fabricated success

The manager always sets one of three statuses so the caller distinguishes "ran
and succeeded" / "ran and failed" / "tool execution is not wired in this
build/backend" without string-matching error text. The engine maps:

- `OK` → step output `{tool_name, result}`.
- `ERROR` → step failure carrying the manager's detail.
- `UNAVAILABLE` → step failure wrapping the typed `ErrRuntimeManagerUnavailable`
  so the gap stays visible and is not retried as a transient error.

### Idempotency

The engine derives `idempotency_key = run_id:step_id:attempt` (invariant #8) and
forwards it so the manager can de-duplicate a retried tool side-effect.

### Honest server-side status

*As originally written (P2-B3), there was no in-VM tool dispatch path and the
handler returned `TOOL_STATUS_UNAVAILABLE` — never a fabricated `OK`. That
follow-up has since shipped.* The Rust handler
(`services/runtime-manager/src/service.rs::exec_tool`) today:

1. validates the request (`tool_name` required; `vm_id` or `run_id` required);
2. `NOT_FOUND`s an explicit `vm_id` that is not in the registry;
3. for a **Firecracker** VM with a connected harness, forwards the call to the
   in-guest tool runner (`services/harness/src/tool_runner.rs`) and maps its
   outcome: `ok:true` → `TOOL_STATUS_OK` + `result`, `ok:false` →
   `TOOL_STATUS_ERROR`;
4. for a **non-Firecracker** backend or an **unreachable** harness, returns
   `TOOL_STATUS_UNAVAILABLE` with a clear reason — **not** a fabricated `OK`.

The wire contract and the engine wiring are unchanged from the original design;
only step 3's placeholder was swapped for the real harness forward.

## Code generation

`gen/go` stubs are hand-maintained but generated by the repo's pinned toolchain
(`protoc v6.33.4`, `protoc-gen-go v1.36.11`, `protoc-gen-go-grpc v1.5.1` — the
exact versions embedded in the existing `runtime.pb.go` header). Only
`runtime.proto` was regenerated; the diff is confined to
`gen/go/lantern/v1/runtime.pb.go` and `runtime_grpc.pb.go`. The Rust
runtime-manager regenerates from the same `.proto` via `build.rs` (tonic-prost)
at compile time.

## Consequences

### Positive

1. `tool_call` steps have a real, structured dispatch path instead of a dead
   typed error.
2. The typed `ToolStatus` keeps the "not wired yet" state honest and
   machine-detectable; no fabricated tool output ever enters run state.
3. Idempotency-keyed so retries are safe once the side-effect is real.

### Negative

1. `ExecTool` is wired end-to-end for the Firecracker backend (the in-guest tool
   runner has shipped). It still returns a visible `UNAVAILABLE` — never a
   fabricated success — for non-Firecracker backends or an unreachable harness, so
   `tool_call` steps on those paths fail visibly by design, not silently.
2. One more RPC on `RuntimeManager` to maintain across the Go stubs and the
   Rust server.

## Alternatives considered

### Reuse `Exec` with a JSON-over-stdin convention

Send the tool name + args as a JSON line on stdin and parse stdout. Rejected:
overloads a shell channel with an ad-hoc framing protocol, loses the typed
status, and couples the engine to a byte protocol instead of a typed RPC.

### Route tool calls through the model router

Rejected: tools are not model completions; they execute code/side-effects in the
sandbox (invariant #5), which is the runtime-manager's job, not the router's.

## References

- [`packages/proto/lantern/v1/runtime.proto`](../../packages/proto/lantern/v1/runtime.proto) — `ExecTool`, `ExecToolRequest`, `ExecToolResponse`, `ToolStatus`
- [`services/workflow-engine/internal/engine/step_executor.go`](../../services/workflow-engine/internal/engine/step_executor.go) — `executeToolCall`
- [`services/runtime-manager/src/service.rs`](../../services/runtime-manager/src/service.rs) — `exec_tool` handler
- [`docs/adr/0014-control-plane-model-router-cutover.md`](0014-control-plane-model-router-cutover.md) — the model-router client-injection pattern this mirrors
