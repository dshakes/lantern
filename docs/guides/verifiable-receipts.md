# Verifiable Receipts

**What:** an Ed25519-signed receipt over the SHA-256 of a run's `journal_events`.
**Why:** anyone can check, without trusting Lantern, that no event was added, removed or altered after issuance.
**Try it:** `curl -X POST localhost:8080/v1/runs/<run_id>/receipt -H "Authorization: Bearer $LANTERN_API_TOKEN"`, then paste the result into the dashboard `/proof` page.

## What a receipt covers

The receipt signs over the **SHA-256 hash of the run's `journal_events` stream**
(in sequence order). Any post-hoc tampering with the journal — adding, removing, or
modifying an event — changes the hash and invalidates the signature.

### Receipt payload fields

The signed payload (`receiptPayload`) contains these fields, all of which appear in the
canonical JSON that is signed:

| Field | Type | Notes |
|---|---|---|
| `agentName` | string | Always present |
| `agentVersion` | string | Omitted when blank |
| `costUsd` | number | Accumulated cost for the run |
| `issuedAt` | RFC3339 | When the receipt was issued |
| `journalHash` | string | SHA-256 of the ordered `journal_events` rows |
| `model` | string | Omitted when blank |
| `provider` | string | Omitted when blank |
| `runId` | string | Always present |
| `status` | string | `succeeded` or `failed` |
| `tenantId` | string | Always present |
| `tokensIn` | integer | Prompt tokens consumed |
| `tokensOut` | integer | Completion tokens produced |
| `version` | integer | Schema version (currently `1`) |

The public key is published at `/.well-known/lantern-receipts` so any external
party can verify without contacting Lantern.

### Canonical JSON

The bytes that are signed are produced by `canonicalJSON(payload)`:

1. Marshal the `receiptPayload` struct to JSON.
2. Unmarshal the result into a `map[string]any` to discard struct-level ordering.
3. Re-marshal the map — Go's `encoding/json` sorts map keys alphabetically.

The result is compact JSON (no whitespace) with keys in alphabetical order. To
reproduce offline, apply the same three-step round-trip to the `payload` object
from the receipt response.

## Issuing a receipt

```bash
curl -X POST http://localhost:8080/v1/runs/<run_id>/receipt \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

The receipt is persisted in `run_receipts` and returned as `{payload, signature, algorithm}`:

```json
{
  "payload": { "runId": "run_01abc", "tenantId": "...", "journalHash": "...", "issuedAt": "2026-06-21T10:00:00Z", "...": "see fields above" },
  "signature": "<base64 (std) ed25519 signature>",
  "algorithm": "Ed25519"
}
```

An unknown run id returns `404`. `algorithm` is `HMAC-SHA256` when `LANTERN_RECEIPT_ED25519_SEED` is unset (legacy/dev fallback).

## Verifying a receipt offline

### Fetch the public key

```bash
curl https://your-lantern/.well-known/lantern-receipts
```

Response (Ed25519 mode; in HMAC mode only `algorithm` and `keyFingerprint` are returned):

```json
{
  "algorithm": "Ed25519",
  "publicKey": "<base64 public key>",
  "keyFingerprint": "<hex>",
  "docs": "https://docs.lantern.dev/receipts"
}
```

Self-hosted deployments expose their own key here. The fingerprint lets you
pin the key out-of-band.

### Verify via the API (no auth required)

```bash
curl -X POST http://localhost:8080/v1/runs/receipts/verify \
  -H "Content-Type: application/json" \
  -d "$RECEIPT"        # the full {payload, signature, algorithm} object from issuance
# -> {"valid": true, ...}  or  {"valid": false, "reason": "signature mismatch"}
```

If the run exists, the server compares against the signature it persisted (constant time); otherwise it recomputes over the canonical JSON.

This endpoint requires no JWT — it is designed for external auditors and the
public receipt verifier at `/proof`.

### Verify entirely offline

```bash
# 1. Fetch the signed receipt
RECEIPT=$(curl -s -X POST http://localhost:8080/v1/runs/<run_id>/receipt \
  -H "Authorization: Bearer $LANTERN_API_TOKEN")

# 2. Extract and base64-decode the signature
echo "$RECEIPT" | jq -r '.signature' | base64 -d > sig.bin   # std base64

# 3. Reproduce canonical JSON of the payload
#    Sort the payload keys alphabetically, marshal without whitespace.
#    Example using jq (which sorts keys by default):
echo "$RECEIPT" | jq -c '.payload | to_entries | sort_by(.key) | from_entries' > canonical.json

# 4. Verify Ed25519 (openssl ≥ 3.x)
openssl pkeyutl -verify \
  -pubin -inkey public.pem \
  -rawin -in canonical.json \
  -sigfile sig.bin
```

The canonical payload bytes are the alphabetically-sorted, compact-JSON
representation of the `payload` object — produced by Go's three-step
`canonicalJSON`: `json.Marshal` → `json.Unmarshal` into `map[string]any` →
`json.Marshal` (Go sorts map keys alphabetically on marshal).

## Tamper evidence

The receipt is bound to the journal in both directions:

- **Forward:** the journal hash in the receipt matches the hash of the events at
  issue time. Adding or deleting events after issuance changes the hash.
- **Backward:** the journal events reference the `run_id` and `tenant_id` in every
  row. Replacing events wholesale requires the new events to still hash to the
  original receipt hash — computationally infeasible with SHA-256 pre-image resistance.

A signed receipt does not prove the agent *behaved* correctly — only that a specific
sequence of events was recorded and not subsequently modified. The event log contents
(what the agent said, what tools it called) remain auditable by reading the journal.

## The `/proof` page

The dashboard exposes `http://localhost:3001/proof` as a public receipt verifier —
no login required. Paste a receipt JSON object and it checks the Ed25519 signature
against the published public key and reports valid/invalid + the journal hash.

## HMAC back-compat

Receipts use HMAC-SHA256 (shared-secret) when `LANTERN_RECEIPT_ED25519_SEED` is unset. The `/verify` endpoint accepts both `HMAC-SHA256` and `Ed25519`; set the seed for any deployment where outside parties verify.
