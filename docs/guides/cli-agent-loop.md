# CLI Agent Loop

The Lantern CLI ships three commands designed to take you from a cold start to an
active agent development loop without leaving the terminal.

---

## Prerequisites

The control-plane must be reachable on `:8080`. Start it with:

```bash
lantern dev          # full stack (infra + API + dashboard + bridges)
# or
make run-api         # API only, infra already running
```

---

## `lantern onboard`

Zero-to-first-run in one command. Runs five deterministic steps — each real,
each idempotent, each loud on failure.

```
1. Health check   — GET /healthz
2. Authentication — stored token or dev seed login
3. LLM provider   — confirms ≥1 key is configured
4. Agent          — generates a custom agent from your description
5. First run      — fires the agent and streams events live
```

### Usage

```bash
lantern onboard                         # interactive
lantern onboard --yes                   # non-interactive, all defaults
lantern onboard --description "A Slack bot that summarises daily standups"
lantern onboard --provider openai --api-key sk-...   # configure provider too
```

### What step 4 does

`onboard` prompts for a one-line description, calls `POST /v1/agents/generate-spec`
to produce a name + system prompt, then calls `POST /v1/agents` to create the agent.
If `generate-spec` is unavailable the command falls back to a static
`quickstart-assistant` so onboarding never fails on a newer spec endpoint.

### Run streaming

Step 5 connects to `GET /v1/runs/{id}/events` (SSE) and renders events as they
arrive — step waterfall, confidence gates, LLM token counts. If the SSE endpoint
is unreachable it falls back to 1-second polling automatically.

---

## `lantern doctor`

Full-stack diagnosis. Runs every check and exits 1 if any critical check fails.

```bash
lantern doctor
```

Output is grouped into three sections:

```
Core
  ✓  HTTP health (:8080/healthz)  ok  llmMode=api
  ✓  authentication               stored credentials valid (admin@lantern.dev)
  ✓  LLM provider configured      openai
  ✓  end-to-end run               run abc123 succeeded

Service ports
  ✓  control-plane HTTP (:8080)
  ~  control-plane gRPC (:50051)  unreachable
  ~  workflow-engine (:50052)     unreachable
  ~  model-router (:50053)        unreachable
  ~  runtime-manager (:50054)     unreachable
  ~  runtime-scheduler (:50055)   unreachable
  ~  dashboard (:3001)            unreachable — run: make dashboard-dev

Peer services
  (shown when GET /v1/system/health is available)
```

`✓` = pass (hard checks exit 1 on fail). `~` = soft warning (gRPC/dashboard
ports are optional for the core API path). `✗` = hard failure.

**Remediation hints** are printed inline — no separate lookup required.

---

## `lantern agent dev <name>`

The build-harness inner loop. Watch a local directory, re-publish on change,
stream events, repeat.

```bash
lantern agent dev my-agent
lantern agent dev my-agent --dir ./agents/my-agent
lantern agent dev my-agent --input '{"prompt":"What can you help with?"}'
lantern agent dev my-agent --eval          # also run eval suite after each publish
```

### How it works

1. **Watch** — polls mtimes of `agent.yaml` + `*.ts / *.py / *.go / *.json /
   *.yaml` in `--dir` every second (no `fsnotify` dependency).
2. **Publish** — reads `agent.yaml` and upserts the agent config via
   `POST /v1/agents`. A 409 (already exists) is silently ignored. No
   `agent.yaml`? publish is a no-op and the run fires against the existing agent.
3. **Run** — fires `POST /v1/runs` with `--input` (default: a one-sentence smoke
   prompt).
4. **Stream** — opens `GET /v1/runs/{id}/events` SSE and renders the step
   waterfall live. Falls back to 1-second polling if SSE is unavailable.
5. **Eval** (optional, `--eval`) — lists eval suites for the agent, runs each
   test case, POSTs results to `POST /v1/eval-runs`. Prints pass/fail and flags
   regressions (HTTP 422) but never aborts the loop.

### Waterfall rendering

```
→ publishing my-agent
✓ published my-agent
→ starting smoke run
  run r-abc123 started
   → step started: llm-main (kind: ai-step)
   ✓ step completed: llm-main (450ms)
   ▸ stream ended: succeeded
✓ run r-abc123 succeeded
```

### Eval output

```
→ eval suite
  case 1/3: ✓
  case 2/3: ✓
  case 3/3: ✗
  ~ eval 2/3 cases passed (67%)
```

A `✗ eval regressed vs baseline` line means the server returned HTTP 422 —
the score dropped below the pinned baseline for this branch.

### First run

The command verifies the agent exists on startup and offers to create it if not.
Pass `--yes` to skip the confirmation prompt (useful in CI).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LANTERN_API_URL` | `localhost:50051` | gRPC address (REST is derived as `:8080`) |
| `LANTERN_API_KEY` | — | API key (falls back to `~/.lantern/credentials.json`) |

All three commands inherit the global `--api-url` / `--api-key` flags.
