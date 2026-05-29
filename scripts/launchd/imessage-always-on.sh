#!/usr/bin/env bash
# Make the iMessage bridge truly always-on under launchd.
#
# WHY THIS NEEDS A MANUAL STEP: the iMessage bridge reads ~/Library/
# Messages/chat.db, which macOS guards with Full Disk Access (FDA). FDA
# is granted per-binary and CANNOT be enabled programmatically — Apple
# requires you to toggle it in System Settings. A Terminal you launched
# the bridge from already has FDA (inherited), which is why
# `make run-imessage-bridge` works. launchd does NOT inherit it, so the
# launchd-managed bridge fails with "unable to open database file" until
# the node binary itself is granted FDA.
#
# ONE-TIME SETUP (≈60s):
#   1. System Settings → Privacy & Security → Full Disk Access
#   2. Click +, press Cmd+Shift+G, paste this path, add it, toggle ON:
#        /Users/shakes/.nvm/versions/node/v22.18.0/bin/node
#      (run `command -v node` if your version differs)
#   3. Also add Automation permission for Messages is requested on first
#      send — approve it.
#   4. Re-run this script. It verifies FDA, then loads the LaunchAgent so
#      the bridge auto-starts at login and auto-restarts on crash.
#
# After that: the iMessage bridge is UP unless you `launchctl bootout` it
# or the machine is off — same guarantee as the WhatsApp bridge.

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/dev.lantern.imessage-bridge.plist"
LABEL="dev.lantern.imessage-bridge"
CHATDB="$HOME/Library/Messages/chat.db"
NODE_BIN="$(command -v node || true)"

echo "→ iMessage always-on setup"
echo "  node binary: ${NODE_BIN:-NOT FOUND}"
echo "  chat.db:     $CHATDB"
echo

# FDA probe: can THIS process read chat.db? (Run from a Terminal with FDA
# this passes; from a context without FDA it fails — same gate launchd hits.)
if ! sqlite3 "$CHATDB" "SELECT 1 LIMIT 1;" >/dev/null 2>&1; then
  # sqlite3 may be missing; fall back to a raw read test.
  if ! head -c 16 "$CHATDB" >/dev/null 2>&1; then
    echo "✗ Cannot read chat.db from this context (Full Disk Access not granted)."
    echo "  Grant FDA to the node binary (see header of this script), then re-run."
    echo "  Path to add:  ${NODE_BIN:-<your node path>}"
    exit 1
  fi
fi
echo "✓ chat.db is readable here."
echo
echo "NOTE: launchd runs as a different responsible process. If the bridge"
echo "      still shows 'permission_required' after loading, FDA must be"
echo "      granted to the node binary above (not just your Terminal)."
echo

# Stop any unmanaged (nohup/Terminal) instance so we don't double-run.
pkill -f "imessage-bridge/src/index.ts" 2>/dev/null || true
pkill -f "imessage-bridge/node_modules/.bin/tsx" 2>/dev/null || true
sleep 2

LOG="$HOME/Library/Logs/Lantern/imessage-bridge.out.log"
# Truncate the log so our verify reads ONLY this attempt (avoids a stale
# "opened chat.db" from a prior Terminal run masking a fresh failure, or
# a stale "permission_required" masking a fresh success).
: > "$LOG" 2>/dev/null || true

# (Re)load under launchd. bootstrap alone sometimes doesn't fire
# RunAtLoad promptly, so we ALSO kickstart to force a start now.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Poll up to 20s for a definitive signal in the fresh log.
ok=""
for _ in $(seq 1 10); do
  sleep 2
  if grep -q "opened chat.db" "$LOG" 2>/dev/null; then ok=1; break; fi
  if grep -q "permission_required\|unable to open" "$LOG" 2>/dev/null; then ok=""; break; fi
done

if [ -n "$ok" ]; then
  echo "✓ iMessage bridge is now launchd-managed and reading chat.db."
  echo "  It will auto-start at login and auto-restart on crash."
  echo "  To stop it intentionally:  launchctl bootout gui/$(id -u)/$LABEL"
else
  echo "✗ Launched, but chat.db still not accessible under launchd."
  echo "  → Full Disk Access for this binary isn't taking effect:"
  echo "       ${NODE_BIN:-<your node path>}"
  echo "  Try: remove the node entry in System Settings → Full Disk Access,"
  echo "       re-add it via Cmd+Shift+G with the path above, toggle ON,"
  echo "       then re-run this script. A reboot clears stubborn TCC caches."
  echo "  Meanwhile, a Terminal run keeps it up:  make run-imessage-bridge"
  exit 1
fi
