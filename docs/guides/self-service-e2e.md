# Self-service agent journey: develop → deploy → observe

A copy-pasteable walkthrough of the full Lantern agent lifecycle. Every command here is tested against the code; where something is optional or flag-gated, it says so.

**Prerequisites:** a running stack (`make dev` or `lantern dev`) and the `lantern` CLI installed:

```bash
( cd packages/cli && go install ./cmd/lantern )
lantern doctor   # verifies stack health, auth, LLM provider, and a live test run
```

Dashboard: `http://localhost:3001` · API: `http://localhost:8080` · Credentials: `admin@lantern.dev` / `lantern`

---

## Develop {#develop}

### 1. Create an agent

```bash
# Via the CLI (scaffolds agent.yaml interactively)
lantern init

# Or directly via REST
export TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jq -r .token)

curl -s -X POST http://localhost:8080/v1/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "triage",
    "description": "Classifies support emails by urgency and category",
    "instructions": "You classify support emails. Return JSON: {urgency: high|medium|low, category: string, summary: string}.",
    "manifest": {
      "isolation": "shared"
    }
  }'
```

`isolation` is optional — absent means `"shared"` (inline executor, lowest latency). Set `"microvm"` for agents that run user-supplied code or load untrusted packages.

### 2. Create an agent version with a workflow graph (optional)

The dashboard visual editor at `/agents/triage` saves the graph directly. Alternatively, `POST /v1/agents` accepts a `workflow` JSONB field with the React-Flow graph. See [14-visual-builder.md](../architecture/14-visual-builder.md) for the node type reference.

### 3. Attach connectors or MCP servers (optional)

```bash
# Attach a curated MCP server to the agent
curl -s -X POST http://localhost:8080/v1/agents/triage/mcp-servers \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mcp_slug": "github", "config": {}}'
```

---

## Test {#test}

### 4. Create an eval suite

```bash
curl -s -X POST http://localhost:8080/v1/eval-suites \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "agentName": "triage",
    "name": "golden",
    "cases": [
      {
        "id": "case-1",
        "input": {"email": "My invoice is wrong"},
        "expectedOutput": {"urgency": "medium"}
      },
      {
        "id": "case-2",
        "input": {"email": "Urgent: account locked, losing sales"},
        "expectedOutput": {"urgency": "high"}
      }
    ]
  }'
# → {"id": "suite-..."}
export SUITE_ID=<id from above>
```

### 5. Run the suite and pin a baseline

```bash
# Run the suite (CI usage: fails with HTTP 422 if score regresses vs. branch baseline)
lantern test --agent=triage --suite=golden

# Or via REST — record a run result
curl -s -X POST http://localhost:8080/v1/eval-runs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "suiteId": "'$SUITE_ID'",
    "agentVersion": "1",
    "commitSha": "abc123",
    "branch": "main",
    "passed": 2,
    "score": 1.0,
    "casesResult": [
      {"id": "case-1", "passed": true, "actual": {"urgency": "medium"}},
      {"id": "case-2", "passed": true, "actual": {"urgency": "high"}}
    ]
  }'
# → {"id": "run-..."}
export EVAL_RUN_ID=<id from above>

# Pin this run as the baseline for the main branch
curl -s -X POST http://localhost:8080/v1/eval-baselines \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentName": "triage", "branch": "main", "evalRunId": "'$EVAL_RUN_ID'"}'
```

Future `POST /v1/eval-runs` calls on the `main` branch now return HTTP 422 if `score` drops more than 2% below this baseline. Wire `lantern test --against=last-green` into CI to gate PRs.

### 6. Forecast cost before running

```bash
curl -s -X POST http://localhost:8080/v1/runs/forecast \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentName": "triage", "input": {"email": "my invoice is wrong again"}}'
# → {"estimatedTokensIn":350,"estimatedTokensOut":120,"estimatedCostUsd":0.0008,"confidence":0.82,"wouldExceedBudget":false}
```

---

## Deploy {#deploy}

### 7. Set a hard budget

```bash
curl -s -X PUT http://localhost:8080/v1/agents/triage/budget \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "maxCostUsdPerDay": 5.00,
    "maxCostUsdPerRun": 0.05,
    "hardFail": true
  }'
```

With `hardFail: true`, a run that would exceed the budget is blocked at `POST /v1/runs` with HTTP 402. The forecast endpoint (`/v1/runs/forecast`) returns `wouldExceedBudget: true` before the run is even created.

### 8. Set up a cron schedule (optional)

```bash
curl -s -X POST http://localhost:8080/v1/schedules \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "agentName": "triage",
    "cronExpr": "0 9 * * 1-5",
    "timezone": "America/New_York",
    "enabled": true,
    "config": {"input": {"email": "daily batch"}}
  }'
```

---

## Run {#run}

### 9. Run on the shared tier

```bash
RUN=$(curl -s -X POST http://localhost:8080/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentName": "triage", "input": {"email": "My invoice is wrong"}}')

echo $RUN | jq .id
export RUN_ID=$(echo $RUN | jq -r .id)
```

Stream the step waterfall live:

```bash
curl -s -N "http://localhost:8080/v1/runs/$RUN_ID/events" \
  -H "Authorization: Bearer $TOKEN"
# → data: {"kind":"step_started","stepId":"call_llm",...}
# → data: {"kind":"step_completed","stepId":"call_llm",...}
```

Or from the CLI:

```bash
lantern logs $RUN_ID -f
```

### 10. Flip an agent to the microVM tier

To route a new agent version to isolated execution, publish it with `isolation: "microvm"` in the manifest. The control-plane validates the field at publish time; an unknown value returns HTTP 400.

```bash
# Deploy requires the scheduler and manager to be running.
# In dev: make run-runtime-manager && make run-scheduler (separate terminals)
# Verify scheduler reachability first:
curl -s http://localhost:8080/v1/system/health \
  -H "Authorization: Bearer $TOKEN" | jq '.services[] | select(.name == "runtime-scheduler")'

# Update the agent manifest (creates a new version)
curl -s -X POST http://localhost:8080/v1/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "triage",
    "description": "Triage — microVM tier",
    "manifest": {
      "isolation": "microvm",
      "image_digest": "lantern/triage@sha256:...",
      "limits": {"vcpu": "250m", "memory": "128Mi", "timeout": "60s"},
      "egress_rules": [{"host": "api.openai.com"}],
      "idempotent": true
    }
  }'
```

You can also run a headless agent directly via the CLI:

```bash
lantern run examples/headless-agents/01-hello/agent.yaml \
  --input '{"name": "world"}'
# → vm_id: vm_01abc...
lantern vm logs vm_01abc -f
```

When the scheduler is unreachable and `isolation: "microvm"` is declared, the run fails explicitly with code `microvm_unavailable`. It never silently falls back to the shared tier.

---

## Observe {#observe}

### 11. Check peer-service health

```bash
curl -s http://localhost:8080/v1/system/health \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {"services":[{"name":"runtime-manager","addr":"localhost:50054","up":true,...}]}
```

The health sweep runs every 60s and fires a self-chat alert on the first DOWN transition after 3 consecutive failures. No alert storms — only transitions trigger notifications.

### 12. Read OTel traces

All spans carry `lantern.tenant_id`, `lantern.run_id`, `lantern.step_id`. Filter by run in your trace backend (Tempo, Jaeger, etc.) using `lantern.run_id = "<run-id>"`. W3C `traceparent` propagates from the control-plane through scheduler → manager → harness, so one trace covers the full spawn chain.

Set `LANTERN_OTEL_ENABLED=1` + `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to enable OTel export (no-op when unset).

### 13. Issue a verifiable receipt

```bash
curl -s -X POST "http://localhost:8080/v1/runs/$RUN_ID/receipt" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {"runId":"...","signature":"...","payload":{...},"issuedAt":"..."}
```

The receipt is Ed25519-signed over the SHA-256 of the run's `journal_events` stream. Verify offline:

```bash
curl -s http://localhost:8080/v1/runs/receipts/verify \
  -H 'Content-Type: application/json' \
  -d @- <<'EOF'
{"signature": "...", "payload": {...}}
EOF
# No auth required.
```

The signing key fingerprint is published at `http://localhost:8080/.well-known/lantern-receipts`.

---

## Improve {#improve}

### 14. Submit run feedback

```bash
# Score 1-5: 4-5 = thumbs up, 1-2 = thumbs down
curl -s -X POST "http://localhost:8080/v1/runs/$RUN_ID/feedback" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"score": 5, "comment": "exactly right"}'
```

Feedback feeds:

- **Rehearsals** — `POST /v1/runs/rehearse` pulls past failed or low-score runs (score ≤ 2) as synthetic test cases against a candidate version before traffic flips.
- **Confidence calibration** — when `LANTERN_CONFIDENCE_CALIBRATE=1`, the `CalibratedEstimator` lowers scores for action types where the realized regret rate (feedback ≤ 2 or failed run) is high, so those nodes are routed to human approval more aggressively over time.
- **The 👎 flywheel** (bridge-side) — `dislikes.jsonl` mines rejections into `## Style lessons (managed)` bullets in `owner-profile.md`, injected into every future reply prompt.

### 15. Update the eval baseline

After deploying a better version, re-run the suite and pin the new run:

```bash
lantern test --agent=triage --suite=golden --set-baseline
```

Or via REST: run `POST /v1/eval-runs` with the new results, then `POST /v1/eval-baselines` to pin it as the new `main` branch baseline.

---

## What to do when something goes wrong

| Symptom | Check |
|---|---|
| Run stuck in `running` forever | Recovery sweep fires every 30s; check `GET /v1/system/health` for scheduler/manager DOWN |
| `POST /v1/runs` returns 402 | Budget exceeded — check `GET /v1/agents/triage/budget` and today's usage |
| microVM run fails with `microvm_unavailable` | Scheduler unreachable — `GET /v1/system/health`, then check `LANTERN_SCHEDULER_GRPC_ADDR` |
| Eval run returns 422 | Regression against the branch baseline — compare `score` to `GET /v1/eval-baselines?agentName=triage&branch=main` |
| Receipt verify fails | `journal_events` were tampered or the signing key changed — check `/.well-known/lantern-receipts` |

---

## What is staged / flag-gated

These features exist in the code but are off by default:

| Feature | Flag | Notes |
|---|---|---|
| RLS enforcement | `LANTERN_RLS_ENFORCE=1` | Requires `lantern_app` DB role; set `LANTERN_APP_DB_PASSWORD` first |
| Model-router cutover | `LANTERN_USE_MODEL_ROUTER=1` | Enables routing completions through the model-router service |
| Confidence gate | `LANTERN_CONFIDENCE_GATE=1` | Routes low-confidence side-effecting nodes to human approval |
| Confidence calibration | `LANTERN_CONFIDENCE_CALIBRATE=1` | Wraps the estimator with regret-based score adjustment |
| Immigration sentinel | `LANTERN_IMMIGRATION_SENTINEL=1` | USCIS deadline derivation from PDFs + email |

See [CLAUDE.md](../../CLAUDE.md) for the complete env-var reference.
