> **Quick setup:** run `make bridge-setup` in the repo root — the interactive wizard handles prereq checks, creates `.env.local`, and walks you through bridge selection in ~5 minutes. Come back here for details.

# Lantern Personal — Setup guide

End-to-end walkthrough for setting up Lantern as your personal
assistant on WhatsApp + iMessage, with auto-start at every Mac boot.
~15 minutes if you're starting from scratch.

## What you get

- Auto-replies on WhatsApp DMs in your voice + style
- Auto-replies on iMessage (macOS only — native via Messages.app)
- VIPs queue drafts for your approval instead of auto-sending
- Natural-language commands ("pause for 2 hours", "status", "what's
  paused") from any thread
- Voice notes ("hey lantern, mute until tomorrow")
- Daily morning digest of overnight activity
- iOS Siri integration (separate guide: `SHORTCUTS.md`)

## Prerequisites

- macOS (any Intel/Apple Silicon Mac running Sonoma+)
- Docker Desktop, Node.js 22+, Go 1.23+
- Your phone with WhatsApp installed
- Your Apple ID signed into Messages.app on this Mac

## Step 1 — Clone + first boot

```bash
git clone https://github.com/dshakes/lantern
cd lantern
make dev-infra        # starts Postgres + Redis + MinIO via docker-compose
make run-api          # starts control-plane on :8080
make dashboard-dev    # starts dashboard on :3001 (in a separate terminal)
```

Open <http://localhost:3001> and log in with `admin@lantern.dev` / `lantern`.

## Step 2 — Configure your LLM provider

Dashboard → Settings → LLM Providers → add an Anthropic OR OpenAI key.
Without this, the assistant has no brain. Both providers also work if
you want failover.

If you have a Claude Max subscription and want $0 LLM cost in dev,
add `LANTERN_USE_CLAUDE_CODE=1` to `.env.local` — the bridge will
route through your local `claude` CLI.

## Step 3 — Set up email mirror (recommended)

Dashboard → Connectors → Gmail → Sign in with Google.

**IMPORTANT:** the OAuth scope is `gmail.modify`. If you've connected
Gmail before with the old scope, disconnect and reconnect now — the
label/skip-inbox behavior needs the new scope.

This lets the bridges email you when:
- A bot reply was attempted but WhatsApp self-chat delivery failed
- A VIP draft is queued waiting for your approval
- A bridge goes offline (proactive alert after 5 min)
- The daily morning digest fires

Add this line to `.env.local`:

```bash
LANTERN_OWNER_EMAIL=you@example.com
LANTERN_OWNER_NAME=YourFirstName   # used for group @mention detection
LANTERN_OWNER_TIMEZONE=America/Los_Angeles   # for quiet hours + digest
```

## Step 4 — Pair WhatsApp

```bash
make run-whatsapp-bridge   # starts the bridge on :3100
```

Then dashboard → Personal → WhatsApp tab → "Pair WhatsApp". Scan the
QR with your phone (WhatsApp → Settings → Linked Devices → Link a
Device).

The bridge will auto-reconnect on transient disconnects. **If
WhatsApp asks you to re-scan after a few hours/days** (Signal session
timeout — a WhatsApp protocol issue, not a Lantern bug), just hit
"Pair" again. Your monitored groups + paused contacts + VIPs are
preserved.

## Step 5 — Set up iMessage (macOS only)

```bash
make run-imessage-bridge   # starts the bridge on :3200
```

You'll need to grant **two macOS permissions** the first time. The
bridge will report `permission_required` until you grant them:

### 5a. Full Disk Access

The bridge reads your message history from
`~/Library/Messages/chat.db`, which sits under macOS's protected
storage. Apple requires explicit per-binary consent.

1. **System Settings → Privacy & Security → Full Disk Access**
2. Click `+`
3. Add **the binary that runs the bridge**:
   - If running via terminal (`make run-imessage-bridge`): add your
     **terminal app** (Terminal.app or iTerm.app — see "which terminal
     am I using" below)
   - If running via LaunchAgent (auto-start): add your **Node binary**
     at the path the installer printed (typically
     `/opt/homebrew/bin/node` on Apple Silicon, `/usr/local/bin/node`
     on Intel, or `~/.nvm/versions/node/vXX.X.X/bin/node` if you use
     nvm). Run `which node` to confirm.
4. Restart the bridge: `make run-imessage-bridge` (or
   `launchctl unload + load` if LaunchAgent)

> **Which terminal am I using?** Look at the top menu bar — it'll say
> "Terminal" or "iTerm2". Add that one specifically.

### 5b. Automation → Messages

The bridge sends replies by driving Messages.app via AppleScript.

1. **System Settings → Privacy & Security → Automation**
2. Find the same binary (Terminal/iTerm/Node) in the list
3. Expand it
4. Toggle **Messages** ON

The first time you send via the bridge, macOS pops a dialog asking
permission — click Allow. If you missed it, walk through the above.

### 5c. Verify

```bash
curl -s http://localhost:3200/session/$(printenv LANTERN_DEFAULT_TENANT_ID || echo 00000000-0000-0000-0000-000000000001)/diagnostics | python3 -m json.tool
```

Should show `"state": "ready"`. If you see `"permission_required"`,
the reason field tells you which permission is missing.

## Step 6 — Auto-start at every Mac boot

```bash
make autostart-install
```

This installs LaunchAgents for all 5 services (Docker bring-up,
control-plane API, dashboard, WhatsApp bridge, iMessage bridge).
On every reboot they all come up automatically, in the right order,
with auto-restart on crash.

```bash
make autostart-status    # see what's loaded + recent log tails
make autostart-uninstall # remove all LaunchAgents
```

> Permissions for the iMessage bridge under LaunchAgent: re-grant FDA
> + Automation to the **Node binary** specifically (LaunchAgent-
> spawned processes have a different permission identity than your
> terminal). The installer prints the exact Node path.

Also: in Docker Desktop → Settings → General → enable **"Start Docker
Desktop when you log in"** so the infra LaunchAgent has something to
talk to.

## Step 7 — Configure VIPs (recommended)

Dashboard → Personal → VIPs → add your boss / partner / parents / top
customers / lawyer.

For VIPs, the assistant **drafts but does not send** — you get the
draft on the dashboard + via email + on the other bridge (e.g.,
iMessage sends a "VIP draft from X waiting" ping if WhatsApp queued
it). One-tap approve / edit / discard.

## Step 8 — Use it

- **Type "status" in any 1-on-1 WhatsApp thread** → bot replies with
  current state (also via email + dashboard)
- **Type "pause for 2 hours" in self-chat** → mute auto-reply, auto-
  resume in 2h
- **Record voice note "lantern, status"** → same as above
- **React ⏸ to any bot reply** → pause that contact
- **Friend mentions you in a monitored group** → bot DMs you a
  summary + can auto-reply
- **/personal/activity** → live feed of everything happening
- **/personal/drafts** → approve VIP drafts

## Troubleshooting

For RCS delivery, inbound branded lane setup, and the Twilio SMS fallback from the iMessage bridge, see [`RCS-SETUP.md`](RCS-SETUP.md).

| Symptom | Likely cause | Fix |
|---|---|---|
| "Not configured" on Channels for iMessage | Old UI cache | Hard-refresh dashboard (Cmd+Shift+R) |
| iMessage bridge state=`permission_required` | macOS TCC | Re-grant FDA + Automation to the bridge binary (Step 5) |
| WhatsApp bridge state=`logged_out` | Signal session timeout | Re-pair via dashboard /personal/setup |
| Friend's DM doesn't get auto-reply | Contact may be paused (you typed in their thread within last 60min) | Dashboard → Personal → Paused → resume; or react ▶️ to last bot reply |
| Bot replies look truncated / weird | LLM TPM limit on tenant with many connectors | Already fixed via `noTools` flag on bridge calls |
| "all configured providers failed: openai TPM limit" on Run Now | Agent has 13+ tools attached, blowing the prompt | Dashboard → Agents → that agent → Connectors → remove unused ones, OR run via bridge (no tools attached) |

## Permanent shell env (one-time)

If you ever exported a `LANTERN_API_TOKEN` in your shell that's now
expired, the bridge will warn you and fall back to credential login.
To silence the warning permanently:

```bash
unset LANTERN_API_TOKEN
# also remove the export line from ~/.zshrc / ~/.bashrc if present
```

## Monitoring

Logs (all bridges + services):

```bash
tail -f ~/Library/Logs/Lantern/*.err.log
```

Dashboard banner: when any service goes `logged_out` / `conflict` /
`error` / `bridge_offline` for more than 5 minutes, you get an
**email alert** (if `LANTERN_OWNER_EMAIL` is configured) with the
reason + a deep-link to the dashboard pair page.

## Production-ish vs personal

This repo is set up for personal-Mac usage. For shipping Lantern as
a multi-tenant service, see `docs/architecture/` — control plane is
already multi-tenant; you'd swap docker-compose for managed Postgres,
add Cloudflare in front of the API, run bridges on dedicated hosts.
