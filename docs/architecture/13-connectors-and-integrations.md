# Connector Framework — Integrate the Apps People Already Use

> **What this is:** the Zapier-shaped subsystem inside Lantern. A framework for building connectors to third-party SaaS apps, plus a library of 30+ prebuilt connectors at launch.
>
> **Why it matters:** for non-technical users (and most technical ones), the most valuable workflows are not "build an AI agent from scratch" — they are "when X happens in App A, have an AI do Y, then do Z in App B." Without first-class connectors, Lantern is a developer toy. With them, it's a personal automation platform that happens to be powered by agents.

---

## Goals

1. **OAuth-first.** A user installs a connector by clicking "Connect" and going through the vendor's OAuth flow. No API keys to copy-paste, no developer accounts to register on the user's behalf.
2. **Triggers and actions, both first-class.** Connectors expose **triggers** (events that start workflows) and **actions** (operations the workflow can call).
3. **Webhook OR polling, transparent.** Some vendors offer webhooks; some don't. The framework hides the difference.
4. **Typed inputs and outputs.** Every action has a JSON schema for input and output, so the visual builder and SDK both have full IntelliSense.
5. **Rate-limit aware.** The framework knows each vendor's rate limit and queues calls accordingly without surfacing 429s to the user.
6. **Secure by default.** Tokens are stored in the per-user vault, encrypted with per-user KMS-wrapped keys, and only decrypted inside the runtime manager at exec time.
7. **Easy to add a new connector.** Implementing a new connector should be < 200 lines of TypeScript or Go for the typical SaaS API.

---

## Connector spec

Every connector is described by a `connector.yaml` plus implementation files. The minimum:

```yaml
lantern_connector: 1
id: gmail                       # globally unique
name: Gmail
description: Send and read email through Gmail.
icon: ./icon.svg
publisher:
  name: Lantern
  verified: true

auth:
  kind: oauth2
  authorization_url: https://accounts.google.com/o/oauth2/v2/auth
  token_url: https://oauth2.googleapis.com/token
  refresh_url: https://oauth2.googleapis.com/token
  scopes:
    - https://www.googleapis.com/auth/gmail.modify
    - https://www.googleapis.com/auth/gmail.send
  pkce: true

rate_limits:
  - per_user: 250/min
  - per_user: 1_000_000/day

triggers:
  - id: new_email
    name: New email received
    description: Fires when a new email arrives in the inbox.
    delivery: webhook                      # or 'polling'
    schema:
      input:
        type: object
        properties:
          label_ids: { type: array, items: { type: string } }
          query:    { type: string, description: "Gmail search query" }
      output:
        type: object
        properties:
          message_id: { type: string }
          thread_id:  { type: string }
          from:       { type: string }
          to:         { type: array, items: { type: string } }
          subject:    { type: string }
          body_text:  { type: string }
          body_html:  { type: string }
          attachments:
            type: array
            items: { $ref: "#/definitions/Attachment" }

actions:
  - id: send_email
    name: Send email
    schema:
      input:
        type: object
        required: [to, subject, body]
        properties:
          to:         { type: array, items: { type: string, format: email } }
          cc:         { type: array, items: { type: string, format: email } }
          subject:    { type: string }
          body:       { type: string }
          html:       { type: boolean, default: false }
          attachments:
            type: array
            items: { $ref: "#/definitions/Attachment" }
      output:
        type: object
        properties:
          message_id: { type: string }
          thread_id:  { type: string }

  - id: read_email
    name: Read email
    schema:
      input:  { $ref: "./schemas/read_email.input.json" }
      output: { $ref: "./schemas/read_email.output.json" }
```

The implementation file (Go example):

```go
package gmail

import (
    "context"
    "github.com/lantern/connector-sdk-go/connector"
)

type Gmail struct{}

func (g *Gmail) Manifest() connector.Manifest { return manifestEmbed }

func (g *Gmail) Invoke(ctx context.Context, action string, in any) (any, error) {
    switch action {
    case "send_email":
        var req SendEmailInput
        if err := connector.UnmarshalInput(in, &req); err != nil { return nil, err }
        return g.sendEmail(ctx, req)
    case "read_email":
        var req ReadEmailInput
        if err := connector.UnmarshalInput(in, &req); err != nil { return nil, err }
        return g.readEmail(ctx, req)
    }
    return nil, connector.ErrUnknownAction
}

func (g *Gmail) IngestWebhook(ctx context.Context, raw []byte) ([]connector.TriggerEvent, error) {
    // Verify Gmail Push Notification (Pub/Sub) signature, decode, return events.
    return decodeGmailPush(raw)
}
```

The connector author writes only the vendor-specific logic. The framework handles auth, retries, rate limits, schema validation, and observability.

---

## Architecture

```
                        User clicks "Connect Gmail" in dashboard
                                        │
                                        ▼
                              control-plane: /v1/connectors/install
                                        │
                                        ▼
                              connector-hub: build OAuth URL → redirect
                                        │
                                        ▼
                              Google OAuth consent screen
                                        │
                                        ▼
                              connector-hub OAuth callback
                                        │
                                        ▼
                       vault: store encrypted tokens (per-user KMS)
                                        │
                                        ▼
                  scheduler: register webhook subscription or polling cursor
                                        │
                                        ▼
                              ✓ connector installed

  RUNTIME (when an action is called):

  agent code: ctx.connectors.gmail.send_email({to, subject, body})
                          │
                          ▼
                  runtime-manager → connector-hub gRPC: Invoke
                          │
                          ▼
                  connector-hub: load connector, vault.WrapForRuntime → token
                          │
                          ▼
                  Gmail.Invoke(ctx, "send_email", input)
                          │
                          ▼
                  Google API call (HTTPS, retry, rate-limit aware)
                          │
                          ▼
                  return typed Output → agent code
```

---

## Triggers: webhook vs polling

- **Webhook triggers** are preferred. The connector registers a webhook subscription with the vendor at install time; events arrive at `connector-hub` over HTTPS, are signature-verified, normalized into `TriggerEvent`s, and dispatched to the scheduler which starts the corresponding agent run.
- **Polling triggers** are used for vendors without webhooks (or where the user doesn't have permission to register webhooks, e.g. some IMAP setups). The scheduler polls on a cadence (default 1 min, configurable per connector) and persists a cursor (`last_seen_id`, `last_modified_at`) to avoid duplicates.
- Some connectors support both — the connector chooses. Some support **hybrid** (webhook for low-latency events + polling for backfill / failure recovery).

Idempotency: every trigger event carries a vendor-supplied `event_id` that's deduplicated for 24h. If we get the same event twice, we drop the second.

---

## Action invocation

When an agent calls a connector action, the workflow engine wraps the call in a `step()` automatically — connector calls are durable side-effects with idempotency.

```ts
// Inside the SDK — typed by the connector spec
const result = await ctx.connectors.gmail.send_email({
  to: ["customer@example.com"],
  subject: "Your weekly report",
  body: report.markdown,
  html: false,
});
```

The framework injects:
- Idempotency key derived from `(run_id, step_id, attempt)`
- OTel span around the call
- Retry with exponential backoff on retryable errors
- Rate-limit awareness — if we know we're at 240/250 calls/min for this user, we hold the call for the next bucket
- Token refresh if the access token is within 5 minutes of expiry
- Structured error wrapping that preserves the vendor's error message

---

## Connector library at launch

| Category | Connectors |
|---|---|
| **Communication** | Slack, Discord, Microsoft Teams, Telegram, WhatsApp Business, Twilio (SMS / Voice / WhatsApp) |
| **Email & Calendar** | Gmail, Google Calendar, Outlook, Microsoft 365 Calendar, Exchange, IMAP/SMTP, Fastmail |
| **Docs & Storage** | Google Drive, Google Sheets, Google Docs, Notion, Dropbox, OneDrive, Box, Confluence, Coda |
| **Dev tools** | GitHub, GitLab, Bitbucket, Linear, Jira, Sentry, Vercel, Netlify, CircleCI, PagerDuty |
| **CRM & Sales** | HubSpot, Salesforce, Pipedrive, Intercom, Zendesk, Freshdesk, Front |
| **Productivity** | Airtable, Trello, Asana, Monday, ClickUp, Basecamp |
| **Commerce** | Stripe, Shopify, PayPal, Square, Lemon Squeezy |
| **Marketing** | Mailchimp, Resend, SendGrid, ConvertKit, Substack |
| **Social** | Twitter/X, LinkedIn, Reddit, Bluesky, Mastodon, Threads |
| **Storage / DB** | Postgres, MySQL, MongoDB, Snowflake, BigQuery, Supabase, Firebase |
| **AI / ML** | OpenAI, Anthropic, Replicate, Hugging Face, ElevenLabs, AssemblyAI |

Each connector ships with:
- A README with a quickstart and example workflows
- Schemas published to the docs site
- 5+ ready-to-fork templates that use it

---

## Custom connectors (BYO)

Users on team and enterprise tiers can build their own connectors using the `connector-sdk-ts` or `connector-sdk-go`. They publish into a private connector registry scoped to the tenant. Custom connectors go through the same framework — auth flow, vault, rate limits, observability — for free.

```bash
$ lantern connector init my-internal-api
$ lantern connector dev          # local hot-reload
$ lantern connector publish      # to your tenant's private registry
```

---

## Marketplace (post-launch)

A public marketplace for community-contributed connectors and templates. Templates are downloadable agent bundles that pin to specific connector versions. Lantern-verified connectors get a checkmark; community connectors are clearly labeled.

---

## Rate-limit + retry semantics

Per connector, the framework knows:
- Rate limit (per minute, per day, sometimes per endpoint)
- Backoff policy on 429 (`Retry-After` if provided; exponential otherwise)
- Which errors are retryable (5xx, 429, network errors) vs terminal (4xx)
- Burst allowance

The framework builds a per-user-per-connector token bucket. Calls that would exceed the bucket are queued in Redis for up to 30s, then either fired or returned as a structured `RateLimited` error to the agent (which can decide to retry, defer, or fail).

---

## Observability

Every connector call emits:
- An OTel span with `connector.id`, `action.id`, `tenant_id`, `user_id`, `run_id`, `step_id`, status, latency, retries, response size
- A structured log entry on failure with the vendor's error code/message
- A usage event (`connector_call_count`) for billing

The dashboard shows per-connector health (success rate, latency p50/p99, error codes) so users can spot a degraded vendor before it ruins their workflow.

---

## Security

- **Tokens never leave the vault except into a runtime sandbox.** They're injected at exec time via tmpfs and zeroed on container exit.
- **Token refresh happens in the vault** — the control plane never sees a plaintext refresh token.
- **Webhook payloads are signature-verified** before any processing.
- **Per-user scoping** — a user's Gmail token cannot be used by another user in the same tenant unless explicitly shared.
- **Audit log** of every connector install, uninstall, and sensitive action (e.g. send email, post to Slack, charge a card).

See [`10-security.md`](10-security.md).
