# iOS Shortcut → Hey Lantern (Siri-callable Jarvis)

Trigger your Jarvis from anywhere on your iPhone — Siri ("Hey Siri,
Lantern"), the Action button, a Lock Screen widget, or the Shortcuts
home-screen icon. Voice input → answer spoken back.

## What you get

- Say "Hey Siri, Lantern" → Siri prompts "What's up?" → you speak →
  the bridge runs the full Jarvis pipeline (profile + tools + all
  the language/dialect rules) → answer is spoken back via the
  iPhone's voice.
- Works over your local wifi OR via tunnel from anywhere.
- No app to install. Built entirely with Apple's Shortcuts app.

## Prereqs

1. **WhatsApp bridge is running on your Mac** and reachable from your
   iPhone. Three options:
   - **Local wifi (simplest)**: iPhone + Mac on the same wifi network.
     Use your Mac's local IP (System Settings → Network → your active
     interface). The bridge binds 127.0.0.1 by default; flip to LAN by
     setting `LANTERN_BRIDGE_BIND=0.0.0.0` and restart.
   - **Cloudflare Tunnel (recommended for "anywhere" access)**:
     `brew install cloudflared` → `cloudflared tunnel --url http://localhost:3100`
     → it prints a `https://xxx.trycloudflare.com` URL. Use that.
   - **Tailscale (recommended for security)**: install Tailscale on
     Mac + iPhone, connect both to your tailnet, use the Mac's
     `100.x.x.x` Tailscale IP.

2. **A bridge token** (REQUIRED for non-loopback access):
   ```bash
   export LANTERN_BRIDGE_TOKEN="$(openssl rand -hex 32)"
   ```
   Add it to your `~/.lantern/whatsapp.env` so it survives restarts.
   Save the token — the shortcut needs it.

3. **The default tenant ID** (you almost certainly want this):
   ```
   00000000-0000-0000-0000-000000000001
   ```

## Build the shortcut

Open the **Shortcuts** app on your iPhone → tap **+** → name it
`Lantern`.

### Step 1 — Dictate the question

- Action: **Dictate Text**
- Language: English (or your preferred — Telugu works if you've
  enabled it in iOS dictation Settings).
- Stop Listening: **After Pause** (or "On Tap" if you want manual
  control).

### Step 2 — POST to the bridge

- Action: **Get Contents of URL**
- URL: `https://YOUR-TUNNEL-OR-IP:3100/session/00000000-0000-0000-0000-000000000001/jarvis/ask`
- Method: **POST**
- Headers (tap "Show More"):
  - `Authorization`: `Bearer YOUR-TOKEN-FROM-STEP-2`
  - `Content-Type`: `application/json`
- Request Body: **JSON**
  - Add Field: `text` → value: tap the variable picker → **Dictated Text**

### Step 3 — Extract the reply field

- Action: **Get Dictionary Value**
- Get: **Value for** `reply`
- In: tap the variable picker → **Contents of URL**

### Step 4 — Speak it back

- Action: **Speak Text**
- Text: tap the variable picker → **Dictionary Value**
- Rate: Default (0.5), Pitch: Default (1.0). Tweak to taste.
- Wait Until Finished: **On** (so the next action waits for speech
  to complete — only matters if you chain more actions).

### Step 5 (optional) — Siri trigger

- Tap the shortcut's **(i)** info icon → **Add to Siri** → record
  "Hey Lantern" or any phrase you want.
- Optionally: pin to Lock Screen, add to Action Button (Settings →
  Action Button → Shortcut → Lantern), or add a widget.

## Test it

1. Tap the shortcut → it prompts → say *"who is my son"* → it
   should speak *"your son is Ved Mudarapu."* within ~3s.
2. Try a tool query — *"when does my license expire"* → bot calls
   `search_personal_files` + `read_personal_file` + speaks the
   expiry date.
3. Try Telugu — *"monna japan ki evaru poindru"* → bot replies in
   Telangana Telugu, spoken in Apple's Telugu voice if you've
   enabled it.

## Troubleshooting

- **"Could not connect to server"** → bridge isn't reachable. Verify
  with `curl https://YOUR-URL/session/00000000-0000-0000-0000-000000000001/jarvis/ask -X POST -H "Authorization: Bearer YOUR-TOKEN" -H "Content-Type: application/json" -d '{"text":"hi"}'` from your Mac/iPhone Safari.
- **"unauthorized"** → token wrong. The bridge logs the failure;
  check `~/Library/Logs/Lantern/whatsapp-bridge.err.log`.
- **Empty reply** → run is hitting the agent's 180s SSE timeout.
  Re-ask with a simpler query; check bridge logs for the actual
  failure mode (model unavailable, tool error, etc.).
- **Speak Text mispronounces names** → iOS pronunciation cache. Add
  a phonetic override under Settings → Accessibility → Spoken
  Content → Pronunciations.

## Privacy note

- The shortcut runs **entirely on your Mac**. Your dictated text
  goes to your bridge → control-plane on your machine → LLM provider
  (Anthropic/OpenAI) per your tenant's configured key. Nothing
  Lantern-side is logged remotely.
- Apple's Dictation can be set to on-device only (Settings →
  General → Keyboard → Enable Dictation → "On-Device Mode") so even
  the speech-to-text never leaves your phone.
- The Cloudflare Tunnel route is encrypted end-to-end but the
  tunnel provider sees connection metadata. Tailscale is the
  most-private alternative — pure peer-to-peer over your tailnet.
