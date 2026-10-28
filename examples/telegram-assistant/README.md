# telegram-assistant

**What.** A personal assistant you message on Telegram (or WhatsApp Cloud). Each message runs a workflow that reads
your Google Calendar and answers from it, and the reply arrives in the same chat.

**Why.** It exercises the whole inbound-chat path: signed webhook -> surface-gateway -> run -> reply, with the
gateway rejecting forged webhooks before anything runs.

| File | Role |
| --- | --- |
| `agent.yaml` | The manifest `lantern deploy` reads: `system_prompt` and the `workflow` (`trigger -> google-calendar.list_events -> ai-step -> end`; the message is `{{input.text}}`) |

## Try it with fixtures (no accounts, no keys)

```bash
make dev-infra
make test-e2e-examples        # runs TestTelegram_* among the others
```

The suite starts a fake Telegram Bot API, POSTs a signed update to a real surface-gateway, and asserts the
`sendMessage` for the right chat. Wrong or missing `X-Telegram-Bot-Api-Secret-Token` is a 401 and sends nothing.
WhatsApp's `X-Hub-Signature-256` negatives: `cargo test` in `services/surface-gateway`.

## Try it with your accounts

1. Create the bot with `@BotFather`; pick a random `TELEGRAM_SECRET_TOKEN`.
2. `lantern deploy` from this directory, install the calendar (OAuth: Connectors page, "Sign in with Google"), then
   **run the agent once** (`POST /v1/runs`, or Run in the dashboard). Deploy does not give the agent the promoted
   version the gateway's gRPC `CreateRun` needs; the first REST run does, which is why this step stays.
3. Run the gateway with a public HTTPS URL:
   ```bash
   LISTEN_ADDR=0.0.0.0:8444 REDIS_URL=redis://localhost:6379 CONTROL_PLANE_ADDR=http://localhost:50051 \
   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_SECRET_TOKEN=... \
   LANTERN_TENANT_ID=<your tenant uuid> LANTERN_AGENT_NAME=telegram-assistant \
   LANTERN_GRPC_SERVICE_TOKEN=<same as the control-plane> \
   cargo run --release   # in services/surface-gateway
   ```
4. Point Telegram at it: `curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook -d url=https://<public-host>/webhooks/telegram -d secret_token=$TELEGRAM_SECRET_TOKEN`
5. Message the bot: "what's on tomorrow?"

For WhatsApp Cloud set `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_API_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID` and point the Meta webhook at `/webhooks/whatsapp`.

## Reference and limits

- The reply is plain text, sent once when the run ends (no streaming to the chat), within 3 minutes or not at all.
- The gateway only creates the run; the control-plane recovery sweep (`LANTERN_RECOVERY_INTERVAL`, default 30 s) or the
  workflow engine drives it, so a reply can take up to ~30 s on a single-process dev stack.
- The agent needs a promoted version first (see step 2) or the gateway logs `agent has no promoted version`.
- Live facts like "is it raining" need a `web_search` tool node in the `workflow` of `agent.yaml` (workflow tool nodes support it);
  it is not included because it cannot run on the fixture stack.
- One agent and one tenant per gateway (`LANTERN_AGENT_NAME`, `LANTERN_TENANT_ID`); every chat message starts a new run
  (no conversation memory).
