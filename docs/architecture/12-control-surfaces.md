# Control Surfaces — Mobile, Chat, Voice, Email

> **What this is:** the subsystem that lets a user drive an agent from anywhere — phone, Slack, Discord, Telegram, WhatsApp, iMessage, voice call, email, web push — without ever opening the dashboard or writing code.
>
> **Why it matters:** the dashboard is for power users. Most people live in a chat app or on their phone. If your agent platform requires opening a tab to start, monitor, or approve a run, you've lost.

---

## Goals

1. **Any surface, same agent.** A run started in iMessage looks identical (in the journal, in observability, in billing) to one started by the SDK. The surface is just an entrypoint.
2. **Two-way conversation with a running agent.** An agent can `await ctx.ask(user, "Should I send the email?")` and the user replies from whichever surface they're on.
3. **Approval gates as interactive cards.** When an agent calls `ctx.approval.request({...})`, the user gets an interactive Slack message / iOS push / SMS / email with Approve and Deny buttons. The agent suspends durably until the user responds (or the timeout fires).
4. **Live screen-share for computer-use agents.** When a `computer-use` agent runs, the user can watch it on their phone in real time, take over with a tap, or kill it.
5. **End-to-end encrypted chat-to-agent.** Messages between a user and their agent are E2E encrypted; the platform sees only ciphertext for personal-mode workflows.
6. **Pluggable surfaces.** Adding a new chat platform should be a single connector implementation, not a core change.

---

## Surfaces shipped at launch

| Surface               | Type                                   | Inbound                                    | Outbound                                     | E2E?                       |
| --------------------- | -------------------------------------- | ------------------------------------------ | -------------------------------------------- | -------------------------- |
| **iOS app**           | Native (Swift) + PWA fallback          | Tap to start, voice, photo upload          | Push, in-app stream                          | Yes                        |
| **Android app**       | Native (Kotlin) + PWA fallback         | Tap to start, voice, photo upload          | Push, in-app stream                          | Yes                        |
| **Slack**             | Bot + slash commands + Block Kit cards | `/lantern run ...`, mention, message in DM | Card replies, status updates                 | Per workspace policy       |
| **Discord**           | Bot + slash commands + components      | `/lantern run ...`, mention, DM            | Components, embeds                           | No (Discord constraint)    |
| **Telegram**          | Bot                                    | `/start`, message, voice, photo            | Inline buttons, message edits                | Yes (Telegram E2E channel) |
| **WhatsApp Business** | Cloud API                              | Message, voice, photo                      | Buttons, list messages                       | Per WhatsApp policy        |
| **iMessage**          | Apple Business Chat                    | Message                                    | Rich messages, list pickers                  | Yes                        |
| **SMS**               | Twilio                                 | Inbound message                            | Outbound message                             | No                         |
| **Voice**             | Twilio (TwiML) or LiveKit (realtime)   | Inbound call                               | TwiML speech, or LiveKit Agents barge-in     | No                         |
| **Email**             | Per-tenant `<id>.lantern.email`        | Reply to thread                            | New thread or reply, with attachments        | Optional PGP               |
| **Web Push**          | VAPID                                  | n/a                                        | Notification → opens dashboard or mobile app | n/a                        |

---

## Architecture

```
   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
   │ iOS / And. │  │   Slack    │  │  Telegram  │  │   Twilio   │  │    Email   │
   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
         │ MQTT/HTTPS    │ HTTPS         │ HTTPS         │ HTTPS         │ IMAP/SMTP
         │  +Push        │ webhooks      │ webhooks      │ webhooks      │
         ▼               ▼               ▼               ▼               ▼
   ╔══════════════════════════════════════════════════════════════════════════╗
   ║                    surface-gateway (Rust, Axum + Tonic)                  ║
   ║                                                                          ║
   ║  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ║
   ║  │  Adapter    │  │   Inbox      │  │  Approvals   │  │  Screen      │  ║
   ║  │  registry   │  │  normalizer  │  │  state mgr   │  │  share relay │  ║
   ║  └─────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  ║
   ║        │                 │                 │                 │           ║
   ║        └─────────────────┴─────────────────┴─────────────────┘           ║
   ║                                  │                                       ║
   ║                                  ▼                                       ║
   ║                          presence (Redis)                                ║
   ╚══════════════════════════════════════════════════════════════════════════╝
                                       │ gRPC
                                       ▼
                              workflow-engine ◀───► runtime-manager
                                       │                  │
                                       ▼                  ▼
                                  notifier         live frame stream (computer-use)
```

### Adapter registry

Each surface is implemented as an **adapter** with this Rust trait:

```rust
#[async_trait]
pub trait SurfaceAdapter: Send + Sync {
    fn id(&self) -> SurfaceId;

    async fn ingest(&self, raw: IngestPayload) -> Result<Vec<SurfaceEvent>>;

    async fn send(&self, session: &SessionRef, msg: SurfaceMessage) -> Result<DeliveryReceipt>;

    async fn render_approval(&self, gate: &ApprovalGate) -> Result<SurfaceMessage>;

    async fn open_screen_share(&self, session: &SessionRef, stream: FrameStream)
        -> Result<()>;
}
```

Implementations live in `services/surface-gateway/adapters/{slack,discord,telegram,whatsapp,imessage,twilio,email,push}`. Adding a new surface is a single `impl SurfaceAdapter` plus a config entry.

### Inbox model

Every surface session — a Slack DM thread, an email thread, an iOS conversation, a phone call — is normalized into:

```sql
CREATE TABLE surface_sessions (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  user_id         UUID NOT NULL,
  surface         TEXT NOT NULL,                    -- 'slack', 'imessage', ...
  external_id     TEXT NOT NULL,                    -- channel id, thread id, etc.
  active_run_id   UUID REFERENCES runs(id),
  presence        JSONB,                            -- last seen, typing, ...
  e2e_pubkey      BYTEA,                            -- if encrypted surface
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, surface, external_id)
);
```

A session can have at most one **active run** at a time. Messages while no run is active are routed to a **router agent** (default: a small LLM that classifies "is this a new task?" and starts the right agent, or "is this idle chat?" and replies briefly). Per-tenant configurable.

### Two-way conversation: `ctx.ask`

In agent code:

```ts
const decision = await ctx.ask({
  surface: "auto", // or pin to "slack"
  message: "Should I send the offer to the customer?",
  options: ["Send", "Edit and send", "Cancel"],
  timeout: "30m",
});
```

Under the hood:

1. The workflow engine writes a `WaitingForUser` journal entry with the question payload.
2. It tells the surface-gateway: "for session X, deliver this question."
3. The adapter renders it natively (Slack interactive card, iMessage list picker, SMS numbered options, voice call IVR menu, email with reply tags).
4. The user responds. The surface-gateway POSTs to the engine: `signal({ name: "ask:<step_id>", value: "Edit and send" })`.
5. The engine completes the step and the workflow resumes.
6. If no response by `timeout`, the engine raises a `Timeout` and the workflow handles it.

This entire exchange is durable. If the engine crashes between (1) and (4), it replays (1), recognizes the journal entry, and waits again — the user's reply is still routed correctly because the signal is keyed to `(run_id, step_id)`.

### Approval gates

A first-class subset of `ctx.ask`:

```ts
await ctx.approval.request({
  reason: `About to spend $${cost} on synthesis`,
  policy: "spend_over_usd > 1.00",
  expiresAt: "10m",
});
```

Renders as a high-priority interactive card with **Approve / Deny / Modify** buttons. Approvals are a separate state machine in the surface-gateway because they have audit and notification implications (notify multiple approvers, escalation, etc.).

### Screen-share for computer-use agents

When the runtime manager starts a `computer-use` agent (a sandbox running a browser or full desktop), it streams compressed frames (VP9 or H.264, 5-10 FPS, downscaled to 720p) to the surface-gateway. The mobile apps and dashboard can subscribe to a session's live frames over WebSocket. The user can:

- **Watch** their agent in real time
- **Tap to take over** — the surface-gateway forwards mouse/keyboard events back to the runtime
- **Pause / resume / kill** with one tap

Mobile push notifications fire when the agent enters states like "needs help," "captcha encountered," "credential required."

### Voice surface

Voice is **provider-pluggable** via the `VoiceProvider` interface in
`services/control-plane/internal/handlers/voice.go`. The control-plane owns the
number→agent mapping, per-call state, webhook authentication, and (for LiveKit)
access-token minting. The realtime audio loop runs in a separately-deployed
media worker — this is the last mile.

**Two shipped providers:**

- **Twilio** (`provider: twilio`) — inbound calls hit
  `POST /v1/voice/webhook/twilio`; we verify `X-Twilio-Signature` and reply
  with TwiML. One-shot speech (`<Say>`/`<Gather>`) works today; full
  bidirectional streaming requires Twilio Media Streams (the last mile).

- **LiveKit** (`provider: livekit`) — the recommended path for low-latency
  conversational voice. The control-plane mints LiveKit access tokens
  (`POST /v1/voice/token`) and verifies LiveKit's signed webhooks. Inbound
  PSTN reaches a room through a LiveKit SIP trunk + dispatch rule; a LiveKit
  Agents worker joins the room and runs the realtime STT→LLM→TTS loop:

```
phone caller ──► Twilio SIP / LiveKit SIP ──► LiveKit room
                                                  │
        control-plane mints join token  ─────────►│
                                                  ▼
                              LiveKit Agents worker (deployed by operator)
                                  Whisper/Deepgram ASR → LLM → ElevenLabs TTS
                                  barge-in + VAD turn-taking
```

The worker authenticates with a token minted by `/v1/voice/token`, which is
the real handoff between the control-plane (token authority) and the media
worker. Barge-in and VAD turn-taking are properties of the LiveKit Agents
worker, not the control-plane. Voice is a first-class surface — voice will be
how most non-technical users interact with their agents.

### End-to-end encryption (personal mode)

For surfaces and tenants that opt in:

- The user's mobile app generates an X25519 keypair on first launch; the public key is registered to their account.
- Messages from the user to the agent are encrypted client-side with the agent's session key (derived per-session via X3DH-like handshake).
- The agent runs inside a Firecracker microVM with the session key injected via the secrets channel; decryption happens only inside the sandbox.
- Replies from the agent are encrypted to the user's pubkey before leaving the sandbox.
- The platform sees only ciphertext for the body of every message in personal-mode E2E sessions. Metadata (timestamps, sizes, sender) is still visible.

This means **even Lantern operators can't read the contents of a personal user's chats with their agent.** This is a hard requirement for the personal workspace tier.

### Push notifications

Web Push (VAPID), APNs, and FCM, all routed through the notifier. Notification types:

- Run completed
- Run failed (with error summary)
- Approval required
- Question waiting from agent
- Budget warning (75%, 90%, 100%)
- Long-running run progress milestone

---

## SDK surface for surfaces

```ts
// Inside an agent
await ctx.ask({
  surface: "auto", // or "slack" / "imessage" / etc
  message: "What's your preferred meeting time?",
  options: ["Tue 2pm", "Wed 10am", "Thu 4pm"],
  timeout: "1d",
});

await ctx.approval.request({
  reason: "About to send to 1,500 customers",
  approvers: ["user:owner", "role:marketing-lead"],
  quorum: 1,
  expiresAt: "2h",
});

await ctx.notify({
  channel: "slack",
  message: "Run finished. Output attached.",
  attachments: [output],
});

await ctx.screen.share({
  fps: 10,
  region: "browser",
  allowTakeover: true,
});
```

---

## Mobile apps

`apps/mobile-ios` (Swift, SwiftUI, MQTT for live updates) and `apps/mobile-android` (Kotlin, Jetpack Compose) — both thin shells over the surface-gateway. PWA fallback at `app.lantern.run` for first-time users on platforms without native installs.

Features at launch:

- Inbox of all conversations across surfaces
- Tap to start runs from a curated template list
- Live agent screen-share with takeover
- Voice mode (push-to-talk + always-on)
- Approval queue with biometric auth
- Push notifications

Post-launch:

- Apple Watch / Wear OS complications for "approvals waiting"
- Shortcuts / Quick actions to start agents from anywhere

---

## Security model summary

- All inbound webhooks signature-verified (HMAC where vendors provide it).
- All outbound messages rate-limited per-vendor to avoid hitting their abuse thresholds.
- E2E surfaces never decrypt outside the sandbox.
- Bot tokens stored in the vault with per-tenant KMS keys, never logged.
- Cross-surface session lookup only by `(tenant_id, surface, external_id)`; no cross-tenant joins ever.

See [`10-security.md`](10-security.md) for the threat model.

---

## What's intentionally NOT here

- We don't build our own chat client. We're not Discord; we're an entrypoint to _your_ agents from the apps you already use.
- We don't store chat history beyond what's needed to resume a session. The chat platform (Slack, etc.) is the long-term store.
- We don't build a video conferencing platform. Voice is enough; video means computer-use screen-share, which is one-way.
