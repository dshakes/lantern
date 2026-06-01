# Streaming conversational voice (Jarvis) — runbook

This is the credential-gated last mile for true real-time voice. **Most of
it already ships.** This doc scopes the remaining audio-transport swap so
it's a clean drop-in when you have the creds.

## What already works today

- **The brain is done and memory-aware.** `askOwnerAgent` (in
  `services/control-plane/internal/handlers/sms.go`) answers as your
  private agent and injects your upcoming calendar + the memories most
  relevant to what you asked (vector recall over the unified timeline).
- **Turn-based voice works now.** Call your Twilio number →
  `VoiceWebhook`/`VoiceTurn` greet, `<Gather>` your speech, transcribe,
  run the agent, `<Say>` the reply, loop. PIN-gated (DTMF) for spoof
  resistance.

The only thing "streaming" adds is **low-latency, barge-in-capable audio
transport** in place of the request/response `<Gather>` loop. The brain
and auth are unchanged.

## Recommended approach: Twilio ConversationRelay

ConversationRelay is the lowest-effort path because **Twilio does STT and
TTS** and exchanges plain **text** with you over a WebSocket. You never
touch raw audio — you receive transcribed prompts and send back text,
which Twilio speaks (optionally with an ElevenLabs voice). This means the
existing `askOwnerAgent` plugs straight in.

(The alternative, Twilio **Media Streams**, sends raw μ-law audio frames
and requires you to run STT (Deepgram/Whisper) + TTS yourself. More
control, much more work. Prefer ConversationRelay unless you need it.)

### 1. TwiML (already a small, gated branch to add)

In `VoiceWebhook` (after owner + PIN verification), when
`LANTERN_VOICE_STREAMING=on`, return this instead of the `<Gather>` flow:

```xml
<Response>
  <Connect>
    <ConversationRelay url="wss://<LANTERN_PUBLIC_BASE_URL host>/v1/voice/relay"
                       welcomeGreeting="Hey, what's up?"
                       voice="<elevenlabs-or-polly-voice-id>" />
  </Connect>
</Response>
```

### 2. WebSocket handler `/v1/voice/relay` (the part needing a dep)

Add a WebSocket route. ConversationRelay sends/receives JSON text frames:

- `{"type":"setup", ...}` — call started; stash CallSid.
- `{"type":"prompt","voicePrompt":"<transcribed speech>"}` — the caller
  spoke. **Wire this straight to the memory-aware brain:**
  `reply, _ := smsHandler.askOwnerAgent(ctx, voicePrompt)` then send
  `{"type":"text","token":reply,"last":true}` back — Twilio speaks it.
- `{"type":"interrupt", ...}` — caller barged in; stop the current reply.

Owner-auth: ConversationRelay can't do DTMF PIN entry the same way, so
gate by verified caller window (reuse `SMSHandler.isVerified()`), or keep
a spoken passphrase check on the first `prompt`.

### 3. Dependencies + creds (the actual boundary)

- **WebSocket library** — not currently in `go.mod`. Add
  `github.com/coder/websocket` (or `gorilla/websocket`) and run
  `govulncheck` before committing (per repo policy).
- **Public `wss://`** — ConversationRelay dials your tunnel; reuse
  `LANTERN_PUBLIC_BASE_URL` (the Cloudflare tunnel) with the `wss` scheme.
- **Twilio ConversationRelay** must be enabled on the account (beta).
- **ElevenLabs voice** (optional) — set the `voice` attribute; you already
  have `LANTERN_ELEVENLABS_KEY` / `LANTERN_ELEVENLABS_VOICE_ID`.

### 4. Env

| Var | Purpose |
|---|---|
| `LANTERN_VOICE_STREAMING` | `on` → emit ConversationRelay TwiML instead of the `<Gather>` loop |
| `LANTERN_VOICE_RELAY_URL` | Optional explicit `wss://…/v1/voice/relay` (else derived from `LANTERN_PUBLIC_BASE_URL`) |

### 5. Testing

1. `LANTERN_VOICE_STREAMING=on`, restart control-plane.
2. Call your Twilio number; confirm the WS `setup` then `prompt` frames
   arrive in the logs.
3. Confirm the spoken reply reflects your memory (ask "what's on my
   calendar" — it should pull from the unified timeline).
4. Test barge-in (interrupt mid-reply) and the verified-window auth gate.

## Fallback

When `LANTERN_VOICE_STREAMING` is unset/`off`, the existing turn-based
`<Gather>` voice loop is used unchanged — so this is purely additive and
safe to ship dark.
