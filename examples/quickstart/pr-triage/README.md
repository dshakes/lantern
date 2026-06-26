# pr-triage — structured PR review + a hard-fail budget

A code-review triage agent that takes a PR title + diff summary and returns a
**structured JSON review** (`risk`, `security_notes`, `suggested_tests`,
`blocking`). It also demonstrates **policy-as-code budgets**: a hard-fail
budget that blocks runs once the agent's daily spend ceiling is reached.

**This runs today** against the live control-plane via the inline executor
(`POST /v1/runs`). No in-VM SDK runtime required — see
[`examples/quickstart/`](../) for the set of examples that run against the
running stack.

## What it proves

- A plain agent (just a `systemPrompt`) produces reliable **structured JSON**
  output on the live inline-executor path.
- **Budgets are real:** a `hardFail` budget returns HTTP **402** and consumes
  no compute once the limit is hit.

## Files

- `spec.json` — the `POST /v1/agents` body (name + systemPrompt).
- `run.json` — a sample `POST /v1/runs` body (a risky password-reset PR).

## Run it

First get a token (documented dev credentials):

```bash
export TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@lantern.dev","password":"lantern"}' | jq -r .token)
```

### 1. Create the agent

```bash
curl -s -X POST http://localhost:8080/v1/agents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @spec.json
```

### 2. Attach a hard-fail budget

```bash
curl -s -X PUT http://localhost:8080/v1/agents/pr-triage/budget \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"maxCostUsdPerRun":0.05,"maxCostUsdPerDay":0.50,"hardFail":true}'
# -> {"status":"saved"}
```

### 3. Run it

```bash
curl -s -X POST http://localhost:8080/v1/runs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @run.json
# returns {"id": "<run-id>", "status": "queued", ...}
```

Then poll `GET /v1/runs/<run-id>` until `status` is `succeeded`; the structured
review is in `output.result`.

### lantern CLI equivalent

The CLI creates the run over gRPC (it does not set `systemPrompt`, so create
the agent with the curl above first):

```bash
cd packages/cli && go run ./cmd/lantern runs create \
  --agent pr-triage \
  --input '{"title":"Allow password reset tokens to be reused within 24h","diff_summary":"auth/reset.go: removed the single-use check on reset tokens; tokens now valid until expiry. Added a 24h TTL. No new tests."}' \
  --stream
```

## Real captured output

Run id `9719fef1-10ff-45a8-82ac-7ce650ac56e7` on the live stack —
`status: succeeded`, `costUsd: 0.1176`, `tokensIn: 5890`, `tokensOut: 390`,
provider `anthropic/claude-opus-4-8`. `output.result` (verbatim, pretty-printed):

```json
{
  "risk": "high",
  "summary": "Removes the single-use restriction on password-reset tokens, making them reusable for a 24h window.",
  "security_notes": [
    "Reusable reset tokens widen the attack window: a leaked or intercepted token (logs, browser history, email forwarding, referrer headers) can be replayed multiple times within 24h to repeatedly take over an account",
    "Removes defense against race conditions and token-replay; an attacker who observes one valid token can reset the password again after a victim regains access",
    "24h TTL is long for a high-value credential-reset token; combined with reuse it materially increases exposure",
    "No token invalidation on successful password change means old tokens remain live after the account is already reset"
  ],
  "suggested_tests": [
    "Verify a reset token is rejected after first successful use (if single-use is restored) or, if reuse is intended, that it is invalidated immediately upon a successful password change",
    "Verify a token is rejected after the 24h TTL expires",
    "Verify a token issued for one user cannot reset another user's password",
    "Verify issuing a new reset token invalidates any prior outstanding tokens for that account",
    "Verify expired/used tokens are purged or marked invalid in the tokens table"
  ],
  "blocking": true
}
```

## Budget hard-fail (real 402)

Tighten the daily budget below today's already-accrued spend and the next run
is rejected before any compute runs:

```bash
curl -s -X PUT http://localhost:8080/v1/agents/pr-triage/budget \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"maxCostUsdPerDay":0.05,"hardFail":true}'

curl -s -X POST http://localhost:8080/v1/runs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data @run.json -w '\n[%{http_code}]\n'
```

Real captured response (HTTP **402**):

```json
{"error":"agent budget limit reached: daily spend would reach $0.1106 exceeding limit $0.0500","reason":"daily spend would reach $0.1106 exceeding limit $0.0500"}
```

> Note: the per-run estimate is `$0` at dispatch (actual cost is unknown until
> the run finishes), so `maxCostUsdPerRun` alone does not block the first run —
> the **daily** ceiling is what enforces the cap once spend accrues. Restore a
> sane budget (`maxCostUsdPerDay: 0.50`) afterward to keep running.
