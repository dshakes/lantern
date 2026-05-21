# Lantern bridges as macOS LaunchAgents

Prod-grade always-on setup so the WhatsApp + iMessage bridges
auto-start at login and auto-restart if they crash. Use this when
you want Lantern running 24/7 on your Mac without typing
`make run-*` each time.

## Install

```bash
# Both bridges:
./scripts/launchd/install.sh

# Just one:
./scripts/launchd/install.sh whatsapp
./scripts/launchd/install.sh imessage
```

The installer:

1. Reads the template plists in this directory.
2. Substitutes `__NODE__`, `__REPO_ROOT__`, `__HOME__` with real paths.
3. Writes them to `~/Library/LaunchAgents/`.
4. Loads them via `launchctl load`.

Logs land in `~/Library/Logs/Lantern/<bridge>.{out,err}.log`. Tail with:

```bash
tail -f ~/Library/Logs/Lantern/imessage-bridge.err.log
tail -f ~/Library/Logs/Lantern/whatsapp-bridge.err.log
```

## macOS permissions (iMessage bridge)

LaunchAgent-spawned processes get their own permission identity — the
grants you gave your terminal app DO NOT carry over. Re-grant for the
new launchd process:

1. **Full Disk Access** — needed to read `~/Library/Messages/chat.db`.
   - System Settings → Privacy & Security → Full Disk Access
   - Click `+`, navigate to your Node binary (typically
     `/opt/homebrew/bin/node` on Apple Silicon, `/usr/local/bin/node`
     on Intel — the installer prints the exact path).
2. **Automation** — needed to send via Messages.app.
   - System Settings → Privacy & Security → Automation
   - First send will trigger the prompt. Allow.

## Status / stop / start

```bash
launchctl list | grep lantern      # see what's loaded
launchctl unload ~/Library/LaunchAgents/dev.lantern.imessage-bridge.plist  # stop
launchctl load ~/Library/LaunchAgents/dev.lantern.imessage-bridge.plist    # start
```

## Uninstall

```bash
./scripts/launchd/install.sh --uninstall
```

Removes both plists from `~/Library/LaunchAgents` and unloads them.

## Editing config (e.g., changing API URL or ports)

The installer copies the plist with substitutions baked in — editing the
template here does NOT update the installed version. To change config:

1. Edit the template plist in this directory.
2. Re-run the installer: `./scripts/launchd/install.sh`.

OR edit the installed plist directly at
`~/Library/LaunchAgents/dev.lantern.<bridge>-bridge.plist`, then:

```bash
launchctl unload ~/Library/LaunchAgents/dev.lantern.imessage-bridge.plist
launchctl load   ~/Library/LaunchAgents/dev.lantern.imessage-bridge.plist
```

## Troubleshooting

**Bridge not responding on its port**: check the err log.

```bash
tail -20 ~/Library/Logs/Lantern/imessage-bridge.err.log
```

Common causes:
- Node binary moved (homebrew upgrade reshuffled paths). Re-run installer.
- Repo path changed. Re-run installer.
- Permission denied reading chat.db. Re-grant Full Disk Access to the
  exact Node binary path from `which node`.

**Bridge crash-loops**: KeepAlive only respawns on crash, not clean exit.
ThrottleInterval=10s prevents tight loops. If you see repeat crashes
in the err log, check that:
- Postgres is running (`make dev-infra`)
- Control-plane is running (`make run-api`)
- `LANTERN_API_URL` in the plist matches your control-plane host
