# iOS Shortcuts + Siri integration

Run your Lantern assistant by voice. "Hey Siri, pause Lantern" → bot
pauses. "Hey Siri, Lantern status" → Siri reads the bot's current
state aloud.

The control-plane exposes a few single-purpose HTTP endpoints under
`/v1/shortcuts/*` designed for one-tap calling from Apple's
Shortcuts.app. Each Shortcut adds an "URL" + "Get Contents of URL"
action and ties it to a Siri phrase.

## Setup (5 minutes, once)

### 1. Get an API key

Open the dashboard → Settings → API keys → create one named "iOS
Shortcuts". Copy the key (starts with `lnt_`).

### 2. Make Lantern reachable from your phone

If you're running Lantern on your home Mac, your iPhone needs to
reach it. Options:

- **Same Wi-Fi**: use your Mac's local IP (e.g. `http://192.168.1.42:8080`).
- **Tailscale**: install on both, use the magic DNS (`http://lantern.tail-XXXX.ts.net:8080`).
- **Cloudflare Tunnel**: free, exposes localhost to the public web with TLS.
- **Production deploy**: just use your real URL.

### 3. Install the Shortcuts

Open Shortcuts.app on iPhone → `+` → add these. For each:

- **Action**: `Get Contents of URL`
- **URL**: `<your-lantern-url>/v1/shortcuts/<action>`
- **Method**: matches the table below
- **Headers**: `Authorization: Bearer <your-api-key>`
- **Show When Run**: ON (so you see the response)
- Then `Settings → Add to Siri` and record the phrase you want.

| Shortcut | URL path | Method | Suggested Siri phrase |
|---|---|---|---|
| Pause Lantern | `/v1/shortcuts/pause` | POST | "Hey Siri, pause Lantern" |
| Pause for 2 hours | `/v1/shortcuts/pause?duration=2h` | POST | "Hey Siri, pause Lantern for two hours" |
| Resume Lantern | `/v1/shortcuts/resume` | POST | "Hey Siri, resume Lantern" |
| Lantern status | `/v1/shortcuts/status` | GET | "Hey Siri, Lantern status" |
| Note to Lantern | `/v1/shortcuts/say` (body: `{"message": "..."}`) | POST | "Hey Siri, tell Lantern ..." |

Optional per-channel: append `?channel=whatsapp` or `?channel=imessage`
if you want a Shortcut to only affect one. Default is both.

### 4. Speak the response

For the status Shortcut, add a "Speak Text" action after "Get
Contents of URL" pointing to the URL response. Siri will say the
result aloud — "Lantern: WhatsApp is connected, bot on, 0 paused;
iMessage is ready, bot on, 1 paused."

## Programmatic test (before wiring Siri)

```bash
TOKEN="lnt_xxx..."  # your API key
LANTERN_URL="https://your.lantern.url"

# Status
curl -X GET "$LANTERN_URL/v1/shortcuts/status" \
  -H "Authorization: Bearer $TOKEN"

# Pause both channels
curl -X POST "$LANTERN_URL/v1/shortcuts/pause" \
  -H "Authorization: Bearer $TOKEN"

# Resume
curl -X POST "$LANTERN_URL/v1/shortcuts/resume" \
  -H "Authorization: Bearer $TOKEN"

# Post a self-chat note (handy for "hey siri, tell lantern I'm at lunch")
curl -X POST "$LANTERN_URL/v1/shortcuts/say" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "📝 at lunch — back at 1pm"}'
```

## Tips

- **Lock-screen access**: Shortcuts can be added to the iOS lock
  screen widgets so one tap (no Siri) triggers them.
- **Apple Watch**: Shortcuts surface on watchOS too — pause from your
  wrist while you're heads-down.
- **HomePod**: Siri Shortcuts work on HomePod too — "Hey Siri, Lantern
  status" while you're cooking.
- **Privacy**: API keys are revocable from the dashboard. Each Shortcut
  has its own header so you can rotate one without breaking the others.
