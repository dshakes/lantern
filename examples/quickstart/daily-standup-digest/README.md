# daily-standup-digest — pasted updates → standup digest (cron-ready)

Turns a blob of pasted team status updates into a crisp standup digest
(Shipped / In progress / Blockers / Needs attention). Runnable today with
pasted input; the README also shows how to put it on a cron as an optional next
step.

**This runs today** against the live control-plane via the inline executor
(`POST /v1/runs`). No in-VM SDK runtime required — see
[`examples/quickstart/`](../) for the examples that run against the running
stack.

## What it proves

- A plain agent reliably synthesizes structured team updates into an
  actionable digest, faithful to the input (no invented work).
- The same agent drops straight onto Lantern's **cron scheduler** with no code
  change.

## Files

- `spec.json` — the `POST /v1/agents` body (name + systemPrompt).
- `run.json` — a sample `POST /v1/runs` body (four pasted updates).

## Run it

```bash
export TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jq -r .token)

# 1. create the agent
curl -s -X POST http://localhost:8080/v1/agents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @spec.json

# 2. run it
curl -s -X POST http://localhost:8080/v1/runs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @run.json
# -> {"id":"<run-id>","status":"queued",...}; poll GET /v1/runs/<run-id>
```

### lantern CLI equivalent

```bash
cd packages/cli && go run ./cmd/lantern runs create \
  --agent daily-standup-digest \
  --input "$(cat run.json | jq .input)" \
  --stream
```

## Real captured output

Run id `6bf1d5ec-016f-4cee-af78-877f87180718` on the live stack —
`status: succeeded`, `costUsd: 0.10806`, `tokensIn: 5999`, `tokensOut: 241`,
provider `anthropic/claude-opus-4-8`. `output.result` (verbatim):

```markdown
## Shipped
- Priya: merged the rate-limiter PR (now in staging)
- Maya: finished new pricing page design, handed off to eng

## In progress
- Priya: OAuth token refresh bug
- Dan: debugging flaky checkout e2e test (fails in CI only, not locally)
- Maya: onboarding emails
- Leo: deploy pipeline migration (80% done)

## Blockers
- Dan: needs CI log access from infra to debug the flaky checkout test
- Leo: needs a decision on whether to keep the old blue/green path during cutover

## Needs attention
- Unblock Dan: chase infra for CI log access
- Decision needed on Leo's blue/green cutover path
```

## Optional next step: put it on a cron

To run the digest automatically on weekday mornings, register a schedule.
This `POST /v1/schedules` call was run against the live stack and returns a
real `nextFireAt` (the schedule was then deleted to keep the dev DB tidy):

```bash
curl -s -X POST http://localhost:8080/v1/schedules \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "agentName": "daily-standup-digest",
        "cronExpr": "0 9 * * 1-5",
        "inputTemplate": {"updates": "<your pasted team updates>"},
        "enabled": true
      }'
```

Real captured response:

```json
{
  "id": "586d2feb-6e08-4735-88a2-1690552dc9be",
  "agentName": "daily-standup-digest",
  "cronExpr": "0 9 * * 1-5",
  "inputTemplate": {"updates": "<pasted team updates>"},
  "enabled": true,
  "nextFireAt": "2026-06-29T09:00:00-04:00",
  "tenantId": "00000000-0000-0000-0000-000000000001"
}
```

> The schedule row + its `nextFireAt` are real (the scheduler polls every 60s).
> This walkthrough verifies the schedule is **created** and its next fire time
> is computed; it does not claim to have observed the cron actually fire (that
> needs `inputTemplate` to carry real updates and a wait until the next window).
> Manage schedules with `GET/PUT/DELETE /v1/schedules`.
