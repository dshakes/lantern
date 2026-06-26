# incident-summarizer — useful task + a verifiable receipt

Takes a raw blob of log lines / alert text and produces a crisp incident
summary (severity, timeline, probable root cause, next actions). Then the
walkthrough **issues a cryptographically verifiable receipt** for the run and
verifies it with the no-auth public verifier — the trust differentiator on a
genuinely useful task.

**This runs today** against the live control-plane via the inline executor
(`POST /v1/runs`). No in-VM SDK runtime required — see
[`examples/quickstart/`](../) for the examples that run against the running
stack.

## What it proves

- A plain agent turns messy operational text into a structured, faithful
  incident summary on the live path.
- **Receipts are real:** every completed run can be issued an Ed25519/HMAC
  receipt that embeds the SHA-256 of the run's `journal_events` stream, and the
  receipt verifies through the **public, no-auth** `/v1/runs/receipts/verify`
  endpoint (same proof surface as the dashboard `/proof` verifier).

## Files

- `spec.json` — the `POST /v1/agents` body (name + systemPrompt).
- `run.json` — a sample `POST /v1/runs` body (a DB connection-pool-exhaustion
  incident).

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
  --agent incident-summarizer \
  --input "$(cat run.json | jq .input)" \
  --stream
```

## Real captured output

Run id `8d02a4a0-0cfa-442e-bbfb-b9f315965fc5` on the live stack —
`status: succeeded`, `costUsd: 0.135915`, `tokensIn: 6111`, `tokensOut: 590`,
provider `anthropic/claude-opus-4-8`. `output.result` (verbatim):

```markdown
## Severity
SEV1 — User-facing checkout outage: payment charges failed at a 41% error rate, well above the 5% threshold.

## Timeline
- 12:01:14 — api-gateway p99 latency normal at 220ms
- 12:03:02 — checkout-svc DB pool at 95% (190/200)
- 12:03:51 — checkout-svc: "remaining connection slots are reserved"
- 12:04:10 — Failed to charge order o_8821 (context deadline exceeded)
- 12:04:12 — PagerDuty alert: checkout error rate 41% (threshold 5%)
- 12:05:30 — Failed to charge order o_8830 (context deadline exceeded)
- 12:08:00 — DBA killed long-running analytics query holding 60 connections
- 12:08:40 — DB pool recovered to 30% (60/200)
- 12:09:10 — Checkout error rate down to 2%, recovering

## Probable root cause
Database connection-pool exhaustion. A long-running analytics query held ~60 connections, driving the checkout-svc pool to 95% and exhausting reserved slots. New charge requests couldn't acquire connections, timing out ("context deadline exceeded") and spiking the error rate. Killing the analytics query freed connections and restored service.

## Next actions
1. Confirm full recovery and reconcile/retry failed orders (o_8821, o_8830, and any others in the window).
2. Add safeguards against runaway analytics queries: statement timeouts and a separate connection pool/replica for analytics.
3. Add alerting on DB pool utilization (e.g. >80%) to catch this before checkout fails.
4. Review pool sizing and per-service connection limits for checkout-svc.
```

## Issue + verify the receipt

### Issue (auth required)

```bash
curl -s -X POST http://localhost:8080/v1/runs/<run-id>/receipt \
  -H "Authorization: Bearer $TOKEN" > receipt.json
```

Real captured receipt:

```json
{
  "payload": {
    "agentName": "incident-summarizer",
    "agentVersion": "f1183a482d0e8bfc1056f0de0d73ad05",
    "costUsd": 0.135915,
    "issuedAt": "2026-06-26T18:06:42.050873Z",
    "journalHash": "2824637258e7370b3b73609899af52f51b2c544a6c2359438cd8c56f602466fa",
    "runId": "8d02a4a0-0cfa-442e-bbfb-b9f315965fc5",
    "status": "succeeded",
    "tenantId": "00000000-0000-0000-0000-000000000001",
    "tokensIn": 6111,
    "tokensOut": 590,
    "version": 1
  },
  "signature": "a92131605c84484091098cef817ee4c1d24f43fc652ebf99310718e0098557c0",
  "algorithm": "HMAC-SHA256"
}
```

> `algorithm` is `HMAC-SHA256` here because this dev stack has no
> `LANTERN_RECEIPT_ED25519_SEED` set; set the seed and receipts are signed with
> Ed25519 and verifiable fully offline against the public key at
> `/.well-known/lantern-receipts`.

### Verify (NO auth — publicly verifiable)

```bash
curl -s -X POST http://localhost:8080/v1/runs/receipts/verify \
  -H 'Content-Type: application/json' --data @receipt.json
```

Real captured response:

```json
{"valid":true,"runId":"8d02a4a0-0cfa-442e-bbfb-b9f315965fc5","issuedAt":"2026-06-26T18:06:42.050873Z","tenantId":"00000000-0000-0000-0000-000000000001"}
```

Tamper with the signature and verification fails (real captured response):

```json
{"valid":false,"reason":"signature mismatch"}
```

The same receipt JSON can be pasted into the dashboard's public **`/proof`**
verifier (no login) to get the same result. External tooling can verify
entirely offline by fetching the algorithm + key fingerprint from
`GET /.well-known/lantern-receipts`:

```json
{"algorithm":"HMAC-SHA256","docs":"https://docs.lantern.dev/receipts","keyFingerprint":"8bdbb2dacd05280b"}
```
