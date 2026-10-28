# Data analyst in a sandbox (example X5)

Upload a CSV, run pandas in an isolated VM, get JSON plus a chart back, and let an
agent explain the result. The code that touches the data never runs in the control
plane (invariant #5), and egress is deny-by-default.

| File | Purpose |
| --- | --- |
| `Dockerfile` | Sandbox image: pandas + matplotlib, long-lived (`sleep infinity`) |
| `analyze.py` | The analysis: which region's revenue dropped most; prints JSON, writes `chart.png` |
| `agent.yaml` | Sandbox `AgentSpec` (isolation, limits, egress allowlist) |
| `spec.json` | The explaining agent (`POST /v1/agents`) |
| `sales.csv` | Sample data; EMEA drops 1000 -> 640 |
| `replay-rules.json` | Fixture-LLM rules (`cmd/llm-replay -rules`) for the CI tier |

## Flow

```bash
BASE=http://localhost:8080
VM=$(curl -s -XPOST $BASE/v1/runtime/schedule -H "Authorization: Bearer $T" \
  -d '{"imageDigest":"lantern/examples/data-analyst@sha256:...05","isolation":"untrusted","network":"allowlist_domain"}' | jq -r .vmId)
curl -XPUT "$BASE/v1/runtime/vms/$VM/files/content?path=sales.csv" -H "Authorization: Bearer $T" --data-binary @sales.csv
curl -XPOST $BASE/v1/runtime/vms/$VM/exec -H "Authorization: Bearer $T" \
  -d '{"command":"python","argv":["/opt/analyze.py","/workspace/sales.csv"]}'
```

## Two test tiers (`e2e/examples/data_analyst_test.go`)

| Tier | Backend | What it proves | What it cannot |
| --- | --- | --- | --- |
| `docker` (default, CI) | runtime-manager `RUNTIME_BACKEND=docker`, `network: none` | schedule, CSV in, pandas exec, JSON + PNG out, no egress, fixture-LLM explanation | The files API and `ExecTool` are Firecracker-only (the docker backend returns 503), so the CSV goes in via exec; no egress audit events (no harness) |
| `firecracker` (nightly, KVM) | Firecracker + harness, `LANTERN_E2E_ANALYST_TIER=firecracker` | files API upload, `egress` deny audited for a non-allowlisted host | needs `/dev/kvm` |

Run the docker tier against your own stack (never the :8080 one):

```bash
docker build -t lantern-analyst:dev examples/data-analyst
# manager: RUNTIME_BACKEND=docker AGENT_IMAGE=lantern-analyst:dev (+ scheduler, control-plane,
#   llm-replay -rules examples/data-analyst/replay-rules.json,
#   LANTERN_LLM_BASEURL_OPENAI=http://127.0.0.1:<replay port>, an openai provider key seeded)
cd e2e/examples && LANTERN_E2E_API_URL=http://127.0.0.1:28080 go test -tags e2e -count=1 -v ./...
```

The workflow `tool` node (W1-B) dispatches to the same `ExecTool` path, so an agent
can drive the sandbox itself on the Firecracker tier.
