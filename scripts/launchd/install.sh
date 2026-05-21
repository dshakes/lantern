#!/usr/bin/env bash
# Install Lantern bridges as macOS LaunchAgents so they auto-start
# at login + auto-restart on crash. This is the prod-grade pattern
# for personal-use Macs running Lantern as an always-on assistant.
#
# Usage:
#   ./scripts/launchd/install.sh                       # install both
#   ./scripts/launchd/install.sh whatsapp              # WhatsApp only
#   ./scripts/launchd/install.sh imessage              # iMessage only
#   ./scripts/launchd/install.sh --uninstall           # remove both
#
# After install:
#   - Logs land in ~/Library/Logs/Lantern/
#   - launchctl list | grep lantern  — see status
#   - launchctl unload <plist>       — stop a service
#   - launchctl load <plist>         — start it back up

set -euo pipefail

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
PLIST_SRC_DIR="$REPO_ROOT/scripts/launchd"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Lantern"

BRIDGES=( "whatsapp" "imessage" )

if [[ "${1:-}" == "--uninstall" ]]; then
  for b in "${BRIDGES[@]}"; do
    PLIST="$LAUNCH_AGENT_DIR/dev.lantern.${b}-bridge.plist"
    if [[ -f "$PLIST" ]]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "uninstalled $b bridge"
    fi
  done
  exit 0
fi

# Optional filter argument: install only the named bridge.
if [[ -n "${1:-}" ]]; then
  BRIDGES=( "$1" )
fi

mkdir -p "$LAUNCH_AGENT_DIR"
mkdir -p "$LOG_DIR"

NODE_BIN="$( command -v node )"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found in PATH. Install Node.js first." >&2
  exit 1
fi
echo "using node: $NODE_BIN"

for b in "${BRIDGES[@]}"; do
  SRC="$PLIST_SRC_DIR/dev.lantern.${b}-bridge.plist"
  DST="$LAUNCH_AGENT_DIR/dev.lantern.${b}-bridge.plist"

  if [[ ! -f "$SRC" ]]; then
    echo "skipping $b — no plist at $SRC"
    continue
  fi

  # Make sure node_modules exist — otherwise tsx won't run.
  SERVICE_DIR="$REPO_ROOT/services/${b}-bridge"
  if [[ ! -d "$SERVICE_DIR/node_modules" ]]; then
    echo "installing $b bridge deps…"
    ( cd "$SERVICE_DIR" && npm install --silent )
  fi

  # Substitute the placeholders. We use a temp file then move it
  # atomically so a partial write can't leave a broken plist.
  TMP="$(mktemp)"
  sed \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
    -e "s|__HOME__|$HOME|g" \
    "$SRC" > "$TMP"
  mv "$TMP" "$DST"

  # Unload first in case an older version is running, then load.
  launchctl unload "$DST" 2>/dev/null || true
  launchctl load "$DST"
  echo "installed + loaded $b bridge"
done

echo ""
echo "Done. Status:"
launchctl list | grep -i lantern || echo "  (nothing matching 'lantern' — try launchctl list again in a moment)"
echo ""
echo "Logs:"
echo "  tail -f $LOG_DIR/whatsapp-bridge.err.log"
echo "  tail -f $LOG_DIR/imessage-bridge.err.log"
echo ""
echo "Permissions reminder for iMessage (macOS-only):"
echo "  - System Settings → Privacy & Security → Full Disk Access → add ${NODE_BIN}"
echo "  - System Settings → Privacy & Security → Automation → ${NODE_BIN} → enable Messages"
echo "  (LaunchAgent-spawned processes need their own permission grants —"
echo "   the terminal-app grants you used for 'make run-imessage-bridge' do NOT carry over.)"
