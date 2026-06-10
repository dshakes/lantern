# RCS Setup — iMessage bridge + server-side branded lane

Lantern supports RCS in two independent directions, with different effort levels
to enable each. This guide walks through both, in the order you should provision
them.

---

## What you get

| Capability | What it does | Requires |
|---|---|---|
| Inbound RCS read on Mac | RCS/SMS messages that arrive on macOS are decoded and seen by the bridge — messages your contacts send to **you** | Nothing. Zero config. |
| Outbound SMS fallback from iMessage bridge | When the iMessage bridge can't deliver via iMessage (SMS/RCS-only contact), it re-delivers through Twilio so the contact still hears back | ~5 min: Twilio account + env var |
| Outbound RCS upgrade | Same fallback path now delivers **rich RCS** (instead of plain SMS) when the recipient's handset + carrier support it | Extra: Twilio Messaging Service + RCS sender (see below) |
| Inbound branded lane (server-side) | A contact texts your branded Twilio RCS number; the Go agent answers on the owner's behalf without the Mac being involved at all | Full: Google RBM brand + agent approval (days to weeks) + webhook config |

The first three build on each other. The fourth is independent and takes the most time.

---

## 1. Inbound RCS on the Mac — nothing to configure

Newer macOS versions and RCS/SMS messages leave `message.text` NULL in
`chat.db` and store the body in `attributedBody` — an `NSAttributedString`
typedstream archive. The bridge decodes these automatically via
`services/imessage-bridge/src/attributed-body.ts`, which is wired into every
poll path in `chat-db.ts`:

- `peekNewMessages` — the main polling loop
- `getMessageContext` — conversation history for LLM context
- `searchMessages` — the personal-docs search path

Decoding is dependency-free and never throws; if the blob is unrecognized, the
bridge falls back to `""` (the same as `text = NULL`). No configuration is
needed and no restart is required — it has always been active.

---

## 2. SMS fallback from the iMessage bridge (5 minutes)

When the iMessage bridge (`services/imessage-bridge/src/session.ts`,
`trySmsFallback`) fails to send via iMessage — because the contact's number is
SMS/RCS-only — it re-delivers the reply over Twilio so the contact still gets
a message.

### Prerequisites

- A Twilio account with at least one phone number purchased
- The Twilio connector installed in the dashboard

### Step 1 — Install the Twilio connector

Dashboard → Integrations → Twilio → Install.

Fill in:

| Field | Value |
|---|---|
| `accountSid` | Your Twilio Account SID (starts with `AC`) |
| `authToken` | Your Twilio Auth Token |
| `phoneNumber` | Your Twilio number in E.164 format, e.g. `+15125550100` |

### Step 2 — Set the env var

Add to `~/.lantern/env` (or the LaunchAgent plist for the iMessage bridge):

```bash
export LANTERN_TWILIO_NUMBER="+15125550100"
# Alias accepted too:
# export LANTERN_TWILIO_SMS_FROM="+15125550100"
```

Restart the iMessage bridge.

### How to verify

Send a message from the bridge to a phone number that is SMS/RCS-only (not
registered with iMessage). Watch the bridge log:

```bash
tail -f ~/Library/Logs/Lantern/imessage-bridge.out.log | grep -i "twilio\|sms fallback"
```

A successful fallback logs:

```
delivered via Twilio SMS fallback (iMessage send failed)
```

**Note:** the contact receives the text from your Twilio number, not your
personal cell. They will see an unfamiliar number unless you tell them in
advance.

---

## 3. RCS upgrade — deliver rich RCS instead of plain SMS

Once the Twilio connector is installed (Step 2 above), one additional field
upgrades every outbound send from plain SMS to **RCS with automatic SMS
fallback**: a Twilio Messaging Service with an RCS sender attached.

The sender resolution in `connector_executor.go` follows this precedence for
`send_sms` / `send_message` actions:

1. Explicit `messagingServiceSid` parameter in the call
2. `messagingServiceSid` field in the Twilio connector config
3. Plain `phoneNumber` from the connector config (SMS only)

If a Messaging Service SID is present at step 1 or 2, Twilio routes through
the Messaging Service. When that service has an RCS sender attached, Twilio
delivers RCS to capable handsets and automatically downgrades to SMS for
those that cannot receive RCS. No code change is needed — the same connector
action covers both.

### Step 1 — Create a Messaging Service

1. Twilio Console → Messaging → Services → **Create Messaging Service**
2. Give it a name (e.g. "Lantern RCS")
3. Add your Twilio phone number as a sender under **Sender Pool**

### Step 2 — Register an RCS sender (requires Google RBM approval)

This is the only step that takes real time and cannot be scripted.

1. In the Messaging Service → **Senders** → **Add Sender** → **RCS Business
   Messaging**
2. Twilio will walk you through creating an RBM brand + agent. You will need:
   - A real business name and logo
   - A publicly reachable website
   - A contact email
3. Submit for Google verification. Google reviews RBM agent registrations
   manually. **Approval typically takes several business days to a few weeks.**
   There is no way to accelerate this — it is a Google process, not a Twilio one.
4. Once Google approves, the RCS sender appears as **Active** in your Messaging
   Service's sender pool.

### Step 3 — Set `messagingServiceSid` on the Twilio connector

Dashboard → Integrations → Twilio → edit the installed connector. Add:

| Field | Value |
|---|---|
| `messagingServiceSid` | Your Messaging Service SID (starts with `MG`) |

Save. No restart required — the connector config is read per-request.

From this point, both the **iMessage bridge fallback** (Step 2) and the
**inbound branded lane** (Step 4) automatically send RCS to capable handsets
and fall back to SMS for others. No further changes needed.

### How to verify

After the RCS sender is approved and `messagingServiceSid` is set, trigger a
fallback send to an RCS-capable Android number. The Twilio Console → Messaging
→ Logs will show the message type as `rcs` rather than `sms`.

---

## 4. Inbound branded lane — contacts text your number, agent replies

This is the server-side "outside-in" channel: a contact texts your branded
Twilio RCS/SMS number directly and the Go agent (`MessagingHandler` in
`services/control-plane/internal/handlers/messaging.go`) answers on your
behalf. It is completely independent of the Mac bridges — useful when your Mac
is offline or the contact is on a carrier RCS thread that macOS cannot send to.

### Prerequisites

- RBM agent approved (Step 3 above — there is no inbound RCS without it)
- Control-plane publicly reachable (Cloudflare Tunnel, ngrok, or a real host)
- The Twilio connector installed with `messagingServiceSid` set

### Step 1 — Wire the Twilio webhook

Twilio Console → Messaging → Services → your Messaging Service →
**Integration** → **Send a webhook**:

| Field | Value |
|---|---|
| Request URL | `https://<your-public-host>/v1/messaging/twilio/inbound` |
| HTTP method | `POST` |

Save. Do not set a fallback URL unless you have another handler — leave it
blank so Twilio does not silently swallow errors.

### Step 2 — Enable the gate

The lane is **fail-closed by default**. Until you explicitly enable it, the
handler verifies every Twilio signature and then drops the message — this
prevents a misconfigured webhook from making the agent text strangers.

Once the RBM agent is approved and the webhook is wired, enable the gate:

```bash
export LANTERN_RCS_INBOUND=on
```

Add to `~/.lantern/env` or the control-plane LaunchAgent plist, then restart
the control-plane. Setting `LANTERN_RCS_INBOUND` to anything other than the
exact string `on` (case-insensitive) leaves the lane disabled.

### Step 3 — Optional: silence signature checking in local dev

```bash
export LANTERN_TWILIO_WEBHOOK_AUTH=off
```

Do **not** set this in production. Without signature verification, any HTTP
POST to the endpoint is accepted.

### Safety posture

The handler enforces multiple layers before the agent ever drafts a reply:

1. **Signature verification** — standard `X-Twilio-Signature` HMAC against your
   connector's `authToken`. Checked before the enable gate, so a forged request
   cannot even probe whether the lane is on.
2. **Sender confirmation** — confirms the inbound `To` or `MessagingServiceSid`
   matches the connector's configured `messagingServiceSid` or `phoneNumber`.
   Prevents a webhook on a different number/service in the same Twilio account
   from triggering replies.
3. **Owner bypass** — if `LANTERN_OWNER_PHONE` is set and the inbound `From`
   matches it (normalized), the message is silently dropped. The owner's private
   command channel is `sms.go`, not this handler.
4. **Rate limiting** — 30 inbound messages per rolling minute. Excess messages
   are dropped (200 OK returned so Twilio does not retry).
5. **Bot-tell suppression** — every draft passes through `shouldSendOutbound()`
   before leaving the server. Empty replies, bare no-reply tokens, AI
   self-identification, and reasoning leaks are suppressed — the lane goes silent
   rather than send.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Contact receives SMS instead of RCS | Handset or carrier not RCS-capable, or RBM agent not yet approved | Expected — this is the automatic fallback. Check Twilio Console → Logs for message type |
| `delivered via Twilio SMS fallback` in bridge log but contact gets nothing | `LANTERN_TWILIO_NUMBER` is set but Twilio connector config missing `phoneNumber` or `messagingServiceSid` | Set `phoneNumber` in the connector config to match `LANTERN_TWILIO_NUMBER` |
| Inbound webhook returns 200 but no reply is sent | `LANTERN_RCS_INBOUND` is not `on` | Set `LANTERN_RCS_INBOUND=on` and restart the control-plane |
| Inbound webhook returns empty body with no log entry | Signature verification failed | Check that `authToken` in the Twilio connector config matches the account auth token Twilio is signing with |
| Webhook 200 + signature ok + `LANTERN_RCS_INBOUND=on` but still no reply | Sender confirmation failed — inbound `To` does not match connector `phoneNumber` or `MessagingServiceSid` | Set `messagingServiceSid` (preferred) or `phoneNumber` in the connector config |
| Bot replies to its own sent messages | Echo loop — `LANTERN_OWNER_PHONE` not set | Set `LANTERN_OWNER_PHONE` to the same E.164 number the RCS sender delivers from |
| Rate-limit drop visible in logs | >30 inbound messages/minute | Investigate flood source; limit is hardcoded at 30/min in the handler |
