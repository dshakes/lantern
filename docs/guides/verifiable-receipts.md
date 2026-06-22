# Verifiable Receipts

Every completed Lantern run can produce an **Ed25519-signed receipt** that proves,
without trusting Lantern, that a specific sequence of events occurred — and that
no event was added, removed, or modified after the receipt was issued.

## What a receipt covers

The receipt signs over the **SHA-256 hash of the run's `journal_events` stream**
(in sequence order). Any post-hoc tampering with the journal — adding, removing, or
modifying an event — changes the hash and invalidates the signature.

The receipt payload includes:

- `run_id`
- `tenant_id`
- `issued_at`
- `journal_hash` — SHA-256 of the ordered journal events
- `signature` — Ed25519 signature over the payload

The public key is published at `/.well-known/lantern-receipts` so any external
party can verify without contacting Lantern.

## Issuing a receipt

```bash
curl -X POST http://localhost:8080/v1/runs/<run_id>/receipt \
  -H "Authorization: Bearer $LANTERN_API_TOKEN"
```

The receipt is persisted in `run_receipts` and returned in the response:

```json
{
  "run_id": "run_01abc",
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "issued_at": "2026-06-21T10:00:00Z",
  "journal_hash": "sha256:e3b0c44298fc...",
  "signature": "base64url:<ed25519-sig>",
  "algorithm": "EdDSA"
}
```

Only completed runs (status `succeeded` or `failed`) can have receipts issued.
A run that is still in flight returns `HTTP 409`.

## Verifying a receipt offline

### Fetch the public key

```bash
curl https://your-lantern/.well-known/lantern-receipts
```

Response:

```json
{
  "algorithm": "EdDSA",
  "curve": "Ed25519",
  "public_key_b64": "<base64-encoded public key>",
  "key_fingerprint": "SHA256:<fingerprint>"
}
```

Self-hosted deployments expose their own key here. The fingerprint lets you
pin the key out-of-band.

### Verify via the API (no auth required)

```bash
curl -X POST http://localhost:8080/v1/runs/receipts/verify \
  -H "Content-Type: application/json" \
  -d '{
    "run_id": "run_01abc",
    "journal_hash": "sha256:e3b0c44...",
    "signature": "base64url:<sig>",
    "issued_at": "2026-06-21T10:00:00Z"
  }'
# → {"valid": true}  or  {"valid": false, "reason": "signature mismatch"}
```

This endpoint requires no JWT — it is designed for external auditors and the
public receipt verifier at `/proof`.

### Verify entirely offline

```bash
# 1. Recompute the journal hash
curl http://localhost:8080/v1/runs/<run_id>/events \
  -H "Authorization: Bearer $LANTERN_API_TOKEN" \
  | sha256sum

# 2. Verify the Ed25519 signature (openssl example)
echo -n '<canonical payload bytes>' | \
  openssl pkeyutl -verify \
    -pubin -inkey public.pem \
    -sigfile sig.bin \
    -pkeyopt digest:sha256
```

The canonical payload bytes are the JSON-encoded receipt fields (excluding
`signature`) sorted by key, serialized without whitespace.

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

Before Ed25519 receipts landed (PR #40), receipts used HMAC-SHA256 (shared-secret).
Existing `run_receipts` rows with the `hmac` algorithm field are still verifiable
via the `/verify` endpoint, which supports both. New receipts always use Ed25519.
