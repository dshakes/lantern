# Observability

Every agent spawn produces **one correlated trace** that crosses the full stack:
control-plane → scheduler → manager → in-VM harness. Every span carries the same
correlation tuple so you can query by any dimension.

## The correlation tuple

```text
(tenant_id, run_id, step_id, agent_instance_id, trace_id)
```

Every span, log line, journal event, and audit row carries this tuple. To find
everything about a run: query your trace backend by `run_id`. To find all runs for
a tenant in a time window: filter by `tenant_id` + timestamp.

## Enabling OTel

Set `OTEL_EXPORTER_OTLP_ENDPOINT` before starting the control-plane:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # Jaeger / Tempo / Honeycomb
make run-api-runtime
```

When the env var is unset, all OTel calls are **no-ops** — no collector dependency
in dev, no latency cost in production unless you opt in.

The Rust services (runtime-manager, harness) follow the same pattern: they extract
the `traceparent` W3C header from inbound gRPC metadata and inject it downstream
(manager → harness via the VM env, harness → report payload). This is how one
trace spans all four hops.

## Span names and key attributes

### Control-plane: `runtime.schedule`

Emitted when `POST /v1/runtime/schedule` is processed.

| Attribute | Value |
|---|---|
| `tenant_id` | caller's tenant |
| `run_id` | the run being scheduled |
| `agent_version_id` | version of the agent bundle |
| `agent_instance_id` | per-instance ID minted at this spawn |
| `isolation_class` | `trusted` / `standard` / `untrusted` / `hostile` / ... |
| `vm_id` | the `runtime_vms` row ID |

### LLM path: GenAI semconv spans

Every LLM call through the model router emits a span following [OTel GenAI semantic
conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

| Attribute | Value |
|---|---|
| `gen_ai.system` | `openai` / `anthropic` / `google` / ... |
| `gen_ai.request.model` | resolved model name (after capability routing) |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.usage.input_tokens` | prompt tokens |
| `gen_ai.usage.output_tokens` | completion tokens |
| `gen_ai.usage.input_tokens_cache_read` | Anthropic cache-read tokens |
| `gen_ai.usage.input_tokens_cache_creation` | Anthropic cache-write tokens |
| `gen_ai.usage.reasoning_tokens` | OpenAI o-series reasoning tokens |
| `lantern.cost_usd` | estimated cost for this call |

Reasoning tokens and cache tokens are also persisted in the `journal_events` step
payload so they appear in the run waterfall and roll up into `agent_usage_daily`.

### Loop and retry anomaly events

When the engine detects a looping or excessively-retrying agent, it emits an
`anomaly_detected` journal event mid-run (not just at run end). These events:

- Are deduped per `(run_id, anomaly_kind)` so the same anomaly fires once.
- Appear in the dashboard run waterfall as a warning marker.
- Are queryable via `GET /v1/runs/<id>/events` (SSE stream) as they land.

Anomaly kinds: `loop_detected` (same step started more than N times in a window),
`retry_storm` (per-step retry count exceeds threshold).

## `GET /v1/runtime/metrics`

Returns per-VM and per-tenant runtime metrics for the dashboard's Live cockpit mode:

```bash
curl http://localhost:8080/v1/runtime/metrics \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

Response shape (abridged):

```json
{
  "active_vms": 3,
  "scheduled_today": 47,
  "quota_used_pct": 62,
  "vms": [
    {
      "vm_id": "vm_01abc",
      "state": "running",
      "isolation_class": "standard",
      "cpu_pct": 12.4,
      "mem_mib": 38,
      "elapsed_secs": 14
    }
  ]
}
```

## Querying a run by trace

In Jaeger:

```text
service=lantern-control-plane run_id=<run_id>
```

In Grafana Tempo (TraceQL):

```text
{ .run_id = "<run_id>" }
```

In Honeycomb:

```text
WHERE run_id = "<run_id>"
GROUP BY name
ORDER BY timestamp ASC
```

## Logs

The harness streams per-VM log lines to the manager via the `Report` RPC. The
manager forwards them to `POST /v1/runtime/report` on the control-plane (shared
token, cert-bound, fail-closed). Logs land in `runtime_vm_logs` with retention
sweeping and are immediately available via:

```bash
lantern logs --vm=<vm_id> -f
# or
curl -N http://localhost:8080/v1/runtime/vms/<vm_id>/logs \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

## Audit events

Every runtime action — spawn, terminate, secret vend, egress deny, RBAC 403 —
is appended to `runtime_audit_events` with `(tenant_id, vm_id, agent_instance_id,
action, outcome, timestamp)`. Query via:

```bash
curl "http://localhost:8080/v1/runtime/audit?limit=50" \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

Audit events are also present in the OTel trace as span events so your existing
SIEM / trace aggregation captures them without a separate pipeline.
