# Dedicated Bot Accounts — iMessage + WhatsApp

This guide gets Lantern off your **personal** self-chat and onto its own
"Lantern" contact in both iMessage and WhatsApp. You DM the bot like a
friend; the bot reads your Mac, runs OCR, executes calendar/note/mail
actions, and replies — same features as self-chat mode, cleaner UX.

The bridge supports **both** topologies simultaneously. If `LANTERN_IMESSAGE_OWNER_HANDLE` or `LANTERN_WA_OWNER_JID` is set, owner-DMs-bot mode is active; otherwise it falls back to self-chat. You can switch any time by toggling the env var.

---

## 1. iMessage — dedicated bot account

### One-time setup

1. **Create a second Apple ID** (only if you don't already have a spare):
   - Visit [appleid.apple.com](https://appleid.apple.com/account) → **Create Your Apple ID**
   - Use an email you control (e.g. `lantern.yourname@icloud.com` — iCloud will generate one for free if you don't have a spare)
   - **No phone number required** — iMessage works with email-only Apple IDs
   - Verify the email
2. **Add the bot Apple ID to Messages.app on this Mac**:
   - Messages → Settings → iMessage → Accounts → **+** → Sign in with the bot's Apple ID
   - Enable "Enable Messages in iCloud" so messages persist across reboots
   - **Recommended**: in the same panel, set the bot ID as the *default* outgoing address — replies will come FROM the bot, not your primary
3. **Sign out of your primary Apple ID on this Mac (optional but cleanest)** — leave only the bot ID signed in. Otherwise, both accounts share `chat.db` and you'll see the bot's replies echo to your primary account via iCloud sync (the bridge dedupes this, but the cleanest UX is bot-only on this Mac).
4. **From your phone**, open Messages, create a new chat with the bot's email/number, send "hi". You'll see the bot pick it up on the Mac.

### Wiring the bridge

Add to your shell env (or `~/.lantern/env`):

```bash
export LANTERN_IMESSAGE_OWNER_HANDLE="+15125551234"   # your primary phone
# OR an email if your primary Apple ID uses one:
# export LANTERN_IMESSAGE_OWNER_HANDLE="shekhar@icloud.com"
```

Restart the bridge: `make run-imessage-bridge`.

### Test

From your phone, DM the bot: **"when does my passport expire"** — you should see the same `📁 one sec…` ack and OCR-backed answer.

### Notes

- **Normalization**: phone numbers are matched after stripping spaces, dashes, parens, dots. `+1 (512) 555-1234` and `+15125551234` both match.
- **Backward compatibility**: if you also self-chat (the old way), that still works as a fallback path.
- **Security**: only messages whose `row.handle` matches `LANTERN_IMESSAGE_OWNER_HANDLE` trigger personal-docs / commands / actions. A random contact who messages the bot gets the normal auto-reply (or nothing if you mute), never doc access.

---

## 2. WhatsApp — dedicated bot account

### One-time setup

1. **Get a second phone number** (pick cheapest that fits):
   - **Google Voice** (free, US-only): [voice.google.com](https://voice.google.com) — instant, $0
   - **Twilio** (~$1/mo): [twilio.com/console/phone-numbers](https://www.twilio.com/console/phone-numbers/search) — programmable, US + intl
   - **Prepaid SIM** (~$10/mo): any local carrier; needs a spare device or eSIM slot
2. **Register the number with WhatsApp**:
   - Install WhatsApp on any phone (or eSIM-capable spare iPhone) and complete onboarding with the new number. Verify via SMS.
   - For Google Voice: WhatsApp will SMS the verification code to your GV number → forwarded to your inbox/main phone. Enter it in WhatsApp.
   - Once verified, you can uninstall WhatsApp from the spare device — the registration sticks.
3. **From your primary WhatsApp**, save the bot number as a contact (e.g. "Lantern") and send a "hi" to initialize the chat.

### Pair the bridge to the bot number

```bash
# Stop any existing whatsapp-bridge:
lsof -i :3100 -sTCP:LISTEN -t | xargs -r kill -9

# Clear the old auth state (it's paired to your primary number):
rm -rf services/whatsapp-bridge/auth_sessions/<tenant>/

# Restart and re-pair to the bot number:
make run-whatsapp-bridge
```

Visit [http://localhost:3000/personal/whatsapp](http://localhost:3000/personal/whatsapp) (or wherever your dashboard exposes the pairing UI), scan the QR / enter the pairing code **on the bot's WhatsApp**.

### Wiring the env

```bash
export LANTERN_WA_OWNER_JID="15125551234@s.whatsapp.net"
# OR just the digits — the bridge appends "@s.whatsapp.net" automatically:
# export LANTERN_WA_OWNER_JID="15125551234"
```

Restart the bridge: `make run-whatsapp-bridge`.

### Test

From your primary WhatsApp, DM the bot: **"status"** → should reply with the bridge status block. Then **"when does my passport expire"** → ack + OCR answer.

### Notes

- **JID format**: WhatsApp uses two JID forms. Phone-format `<digits>@s.whatsapp.net` is what you typically set. Newer privacy IDs (`@lid`) also work; the bridge normalizes both.
- **Group support**: the bot can be added to family groups. Group auto-reply still requires explicit @mention or the existing `/bot monitor on` opt-in.
- **Backward compatibility**: if `LANTERN_WA_OWNER_JID` is unset, self-chat mode remains the gate.

---

## 3. Quick verify

After setup, send each of these to your bot in iMessage / WhatsApp:

| Message | Expected |
|---|---|
| `status` | Bridge state block (uptime, paused count, docs toggle, killswitch) |
| `help` | Command list |
| `when does my passport expire` | `📁 one sec…` → answer with date → offer to add calendar reminder |
| `yes` (after the offer) | `📅 added to calendar — "Passport renewal" → Home · …` |
| `kill switch on` | `🚨 KILL SWITCH ENGAGED` → bot ignores everything until release |
| `kill switch off` | `✅ kill switch RELEASED` |

If `status` doesn't reply, the env var likely doesn't match what the bot sees. Check the bridge log:

```bash
tail -f /tmp/lantern-imessage-bridge.log     # iMessage
tail -f /tmp/lantern-whatsapp-bridge.log     # WhatsApp
```

Look for inbound rows showing the sender's handle/JID — set your env to that exact value (after normalization).

---

## 4. Switching back to self-chat

Just `unset LANTERN_IMESSAGE_OWNER_HANDLE` / `unset LANTERN_WA_OWNER_JID` and restart the bridge. Self-chat mode resumes immediately. No data loss; OCR cache and bot-state files survive the switch.

---

## 5. Owner profile

Create `~/.lantern/owner-profile.md` to give the bot your voice, world, and ground-truth facts. The bridge hot-reloads it on every mtime change (no restart needed).

```markdown
# Owner profile

## About me
I'm Shekhar — founder building Lantern. Currently heads-down on launch.

## How I text
- lowercase, short, dry
- no periods at the end of lines
- "yeah"/"lol"/"for sure" — never "certainly" or "sounds good"

## My world
- Austin, TX / IST overlap
- two young kids, always context-switching

## Facts
- married: yes
- spouse: Maya
- kids: Aarav, Anaya
- wedding anniversary: 2017-06-03

## Relationships
- Shiva: brother
- Sujith: college friend | address as: Sujith | never: bava
- +15125551234: my manager
```

**`## Facts`** — ground truth the bot will NEVER deny (marriage, spouse, kids, key dates). Dates must be `YYYY-MM-DD`.

**`## Relationships`** — per-contact labels + optional pipe-delimited addressing rules:
- `address as: X` — what to call this contact
- `never: a, b` — kinship/nickname terms the owner doesn't use with them

**Auto-teaching.** Self-chat a fact ("Raju moved to MD", "remember: anniversary is June 3 2017", "don't call Sujith bava") and the bridge learns it automatically — bot acks with "📝 noted — …".

**`## Style lessons (managed)`** — written by the 👎 flywheel; do not hand-edit the `<!-- id:... -->` tags. Delete a bullet to retire a rule.

**Profile path override:** `export LANTERN_OWNER_PROFILE=/path/to/profile.md`

---

## 6. New env vars (personal-assistant features)

Add these to your `~/.lantern/env` or LaunchAgent plist alongside the existing vars:

| Var | Purpose | Default |
|---|---|---|
| `LANTERN_OWNER_TIMEZONE` | IANA TZ for quiet hours + digest scheduling | process TZ |
| `LANTERN_QUIET_START` | Quiet-hours start, 24h int — no auto-reply, messages queued | `1` (1 AM) |
| `LANTERN_QUIET_END` | Quiet-hours end, 24h int | `6` (6 AM) |
| `LANTERN_QUIET_QUEUE_MAX` | Max overnight queued messages per bridge | `200` |
| `LANTERN_PROACTIVE_NUDGES` | Set `0` to disable anticipation nudges (overdue replies, upcoming dates, open commitments) | on |
| `LANTERN_DRAFT_CONFIRM` | Set `0`/`off` to revert LOW-confidence replies from draft-to-owner back to 5s-hold-then-send | on |
| `LANTERN_DISLIKE_LLM_CLUSTER` | Set `1` to enable LLM fuzzy clustering in the 👎 flywheel (costs tokens) | off |

### Verifying quiet-hours + nudges

```bash
# Check that the quiet-hours window is what you expect (should print nothing in a quiet hour):
curl -s http://localhost:3100/health | jq .quietHours

# Tail the bridge log for nudge fires:
tail -f ~/Library/Logs/Lantern/whatsapp-bridge.out.log | grep "nudge\|anticipation"
```

For Twilio SMS fallback and RCS upgrade (so the iMessage bridge can reach SMS/RCS-only contacts), see [`RCS-SETUP.md`](RCS-SETUP.md).

---

## 7. Voice clone for outbound calls (ElevenLabs) — OFF by default

By default, outbound calls (voicemails + agent-task calls) are spoken in a
generic Polly TTS voice. Optionally the bot can speak in **your own cloned
voice** via ElevenLabs. This is **deepfake-class** and therefore **OFF by
default**; you must opt in explicitly.

> The two-party-consent announcement ("this call may be saved for …'s
> records") is **unaffected** — it still plays on calls to all-party-consent
> states whether you use Polly or your clone. Voice-clone changes the *voice*,
> not the consent posture.

### Setup

1. In [elevenlabs.io](https://elevenlabs.io) → **Voices** → create an
   **Instant Voice Clone** of your own voice (upload a minute or two of clean
   audio of yourself). Copy its **Voice ID**.
2. Copy your ElevenLabs **API key** (Profile → API Keys).
3. Stand up a publicly-reachable host for the generated MP3s — Twilio fetches
   them when it dials. The bridge serves `/voice-cache/<sha>.mp3`; expose it
   via Cloudflare Tunnel or ngrok and set `LANTERN_VOICE_CACHE_PUBLIC_URL` to
   that public base URL.
4. Add to `~/.lantern/env` (or the LaunchAgent plist):

   ```bash
   export LANTERN_VOICE_CLONE=1                       # master opt-in (off by default)
   export LANTERN_ELEVENLABS_API_KEY="sk-..."         # never logged
   export LANTERN_ELEVENLABS_VOICE_ID="your-voice-id"
   export LANTERN_VOICE_CACHE_PUBLIC_URL="https://<your-tunnel-host>"
   ```

Restart the bridge. If **any** of the three voice-clone vars (or the public
URL) is missing, the bridge falls back **cleanly** to the Polly voice — no
behavior change, the call still goes out. On any ElevenLabs/hosting error
mid-call, it also falls back to Polly: voice-clone never fails a call.

| Var | Purpose | Default |
|---|---|---|
| `LANTERN_VOICE_CLONE` | Master opt-in (`1`/`true`/`on`). Deepfake-class — keep off unless intended | off |
| `LANTERN_ELEVENLABS_API_KEY` | ElevenLabs API key (legacy alias `LANTERN_ELEVENLABS_KEY`) | — |
| `LANTERN_ELEVENLABS_VOICE_ID` | The cloned voice to speak in | — |
| `LANTERN_VOICE_CACHE_PUBLIC_URL` | Public base URL the bridge serves `/voice-cache/<sha>.mp3` from | — |
