# Personal Workflows — Lantern for One

> **What this is:** the personal-tier mode of Lantern where an individual user runs their own day-to-day automations securely against their own apps and accounts.
>
> **Why it matters:** the most underserved persona in agent platforms today is the *individual*. Every other platform is built for teams or enterprises. Lantern has a first-class personal mode where one user can run real workflows against their real Gmail, Drive, Slack, and Calendar without ever talking to a salesperson.

---

## What "personal" means here

A **personal workspace** is a Lantern tenant with these properties:

- **One user is the owner and the only member.** No collaborators (yet).
- **The credential vault is end-to-end encrypted with a key derived from the user's passphrase.** Even Lantern operators cannot read the user's connector tokens or workflow secrets.
- **The default surface is mobile + chat**, not the dashboard. Onboarding is from the iOS/Android app; the dashboard is a power-user view.
- **Free or low-cost tier with hard caps.** Personal users get a generous free monthly allowance; overages bill on a credit-card on file with hard cutoffs.
- **Templates are front and center.** A first-time personal user is dropped into a curated template gallery, not a blank canvas.
- **Privacy is the default.** Personal runs are not used for any product analytics, eval, or training. Data export and account deletion are one-tap and complete.

---

## Personal vs Team vs Enterprise tiers

| | **Personal** | **Team** | **Enterprise** |
|---|---|---|---|
| Members | 1 | up to 25 | unlimited + SSO/SCIM |
| Default surface | Mobile + chat | Dashboard | Dashboard + SSO |
| Credential vault | E2E encrypted (user key) | KMS-encrypted (tenant key) | Customer-managed KMS / BYOK / HSM |
| Workflow visibility | Owner only | Tenant members per RBAC | Tenant members + audit log |
| Templates | Personal gallery | Team gallery | Custom catalog + private connectors |
| Custom connectors | No | Yes | Yes + private registry |
| SSO | n/a | Google / GitHub | SAML / OIDC / SCIM |
| Audit log | 30 days | 1 year | Indefinite + SIEM export |
| SLA | best-effort | 99.9% | 99.95% + support |
| Pricing | Free + usage | Per-seat + usage | Custom |

The same code, the same runtimes, the same workflow engine — only the policies differ.

---

## Onboarding flow

```
1. User downloads the app (iOS / Android / web PWA)
2. Sign up with Apple / Google / email + magic link
3. Generate device keypair (X25519); upload public key
4. Create a passphrase → derive vault root key (Argon2id, high cost)
5. Land on the template gallery
6. Tap a template → "Connect Gmail" → OAuth → "Connect Slack" → OAuth
7. "Test it" → live test run on the canvas with real data
8. "Turn it on" → workflow goes live; first run is free
```

Total time to first running workflow target: **< 3 minutes**, including OAuth.

---

## End-to-end encryption details

The personal vault is **client-side encrypted** with a key the user controls. Lantern never sees the plaintext.

```
User passphrase
      │
      ▼
Argon2id (memory: 256 MiB, time: 4, parallelism: 2)
      │
      ▼
Vault Root Key (256-bit)
      │
      ├──► Wraps Per-Connector Data Keys
      │         │
      │         └──► Encrypts OAuth tokens (XChaCha20-Poly1305)
      │
      └──► Wraps Workflow Secret Keys
                │
                └──► Encrypts user-provided secrets in workflows
```

When a workflow runs:
1. The user must have unlocked the vault on a device in the last `unlock_window` (default 24h, configurable down to "every run" or up to "30 days").
2. On unlock, the device computes the Vault Root Key in-memory and wraps it under an **ephemeral session key** known only to that device + the runtime sandbox the agent is about to run in (X3DH handshake).
3. The session key is sent to the runtime manager over mTLS; it lives only inside that one sandbox for the duration of the run.
4. The runtime manager loads the encrypted credential blob from the vault, hands it to the sandbox, and the sandbox decrypts using the session key.
5. After the run finishes, the session key is destroyed and the sandbox is torn down.

This means:
- **Lantern operators cannot decrypt the user's tokens** without the user's passphrase, which we never see.
- **A breach of the Lantern database does not expose tokens** — they're encrypted at rest with keys we don't hold.
- **Token use is tied to live device unlock** — a stolen vault is useless without the passphrase + an unlocked device.

The trade-off: if the user forgets their passphrase, **we cannot recover their workflows** (we can recover their account metadata, runs history, and dashboard, but not their credentials). The mobile app encourages users to print or save a recovery phrase at signup.

For users who want a less paranoid mode, there's an "easy mode" that uses a Lantern-managed KMS key instead of a user passphrase. Same key separation, but Lantern can in principle decrypt — used by users who care more about not losing access than maximum privacy.

---

## What personal users actually do

Real personal use cases we've designed for (and templated):

### Email triage
- Read unread emails every morning
- Classify urgent / important / unsubscribe / read-later
- Draft replies for "important" emails
- Send drafts to user via iMessage for one-tap approval and send

### Calendar prep
- 15 min before each meeting, search Notion + Drive for relevant docs
- Build a 1-page brief; deliver via push notification

### Personal CRM
- When someone emails you for the first time, look them up on LinkedIn
- Add to a Notion database with notes
- Remind you to follow up in 7 days if no reply

### Newsletter digest
- Read all newsletters in your "Newsletters" Gmail label
- Summarize the top 5 stories of the week into one document
- Email it to yourself every Sunday morning

### Receipts & expenses
- Watch Gmail for receipts
- Extract amount, vendor, date, category
- Add to a Google Sheet
- Forward to your accountant once a month

### Calendar negotiation bot
- When someone emails asking for a meeting time
- Read your free/busy from Google Calendar
- Reply with three options
- When they pick one, create the event and confirm

### Voice journaling
- Call a phone number, talk for 5 minutes
- Whisper transcribes
- Agent summarizes themes, extracts action items
- Posts to Notion daily journal page

### "What did I miss?" briefing
- Every morning at 7am
- Read overnight Slack DMs, Linear issue updates, GitHub notifications, calendar
- Summarize into a 60-second brief
- Push to phone

Every one of these is a template in the gallery.

---

## Why this works on the same architecture

The personal mode is not a separate product. It's a *policy configuration* on top of the same engine:

- The workflow engine is the same.
- The runtime manager is the same.
- The model router is the same.
- The connector framework is the same.
- The control surfaces are the same.

What's different:
- The vault is in **user-key mode** instead of tenant-key mode.
- The default surface routing is mobile-first, not dashboard-first.
- The billing tier has personal limits and a free allowance.
- The template gallery is the personal one, not the team one.
- Privacy policies are stricter (no data used for any analytics or training).
- The onboarding wizard is mobile-app-led, not dashboard-led.

This is the leverage: **a single platform that runs the same way for individuals and enterprises**, with the differences being configuration and surfaces.

---

## What we will NOT do for personal users

- **No exposing personal workflows to other tenants.** Even with explicit consent, no marketplace sharing of workflows that contain user data.
- **No "share my agent" social features at launch.** Sharing is a Team-tier capability.
- **No telemetry on personal run contents.** We collect crash reports and usage metrics, never run inputs or outputs.
- **No automatic upgrades from personal to team without consent.** Inviting a collaborator triggers a clear migration prompt with privacy implications spelled out.

---

## Pricing model (sketch — not final)

| Tier | Monthly | Includes | Overages |
|---|---|---|---|
| **Personal Free** | $0 | 100 runs / month, 50k tokens / month, 5 connectors, mobile app, 30-day history | Hard cap; runs paused at limit |
| **Personal Plus** | $20 | 5,000 runs, 5M tokens, unlimited connectors, voice surface, 1-year history | $0.005/run, $0.30/M tokens after included pool |
| **Team** | $25/seat | All Personal Plus + collaborators + custom connectors + dashboard | Same overages, billed to tenant |
| **Enterprise** | Custom | All Team + SSO/SCIM + BYOK + SLA + support | Custom |

Personal Plus is priced to be cheaper than Zapier's $30/mo plan for 2,000 tasks while giving more tasks and AI included.

---

## Implementation surface

- `apps/web/personal/` — personal-mode dashboard (mobile-first responsive)
- `apps/mobile-ios/` and `apps/mobile-android/` — native shells
- `services/vault/` — supports both user-key and tenant-key modes
- `services/control-plane/personal/` — personal tier policies
- `packages/templates-personal/` — the launch template gallery
