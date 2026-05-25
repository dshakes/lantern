#!/usr/bin/env bash
# Install ALL Lantern services as macOS LaunchAgents so they auto-start
# at login + auto-restart on crash. Prod-grade pattern for a Mac that
# runs Lantern 24/7.
#
# Usage:
#   ./scripts/launchd/install.sh                # install everything
#   ./scripts/launchd/install.sh api dashboard  # install only some
#   ./scripts/launchd/install.sh whatsapp imessage
#   ./scripts/launchd/install.sh --uninstall    # remove ALL Lantern agents
#
# After install:
#   - launchctl list | grep lantern  — see status
#   - Logs in ~/Library/Logs/Lantern/
#   - launchctl unload <plist>       — stop a service
#   - launchctl load <plist>         — start it back up

set -euo pipefail

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
PLIST_SRC_DIR="$REPO_ROOT/scripts/launchd"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Lantern"

# Order matters — infra brings up docker, api waits for postgres,
# dashboard waits for api. LaunchAgents run in parallel but each
# wrapper waits for its upstream dependency before launching.
ALL_SERVICES=( "infra" "api" "dashboard" "whatsapp-bridge" "imessage-bridge" )

if [[ "${1:-}" == "--uninstall" ]]; then
  for s in "${ALL_SERVICES[@]}"; do
    PLIST="$LAUNCH_AGENT_DIR/dev.lantern.${s}.plist"
    if [[ -f "$PLIST" ]]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "✓ uninstalled $s"
    fi
  done
  echo ""
  echo "Note: existing service processes were stopped. Docker containers"
  echo "are still running — run 'make dev-down' or stop them in Docker"
  echo "Desktop if you want them gone too."
  exit 0
fi

# Optional filter — install only the named services.
if [[ -n "${1:-}" ]]; then
  ALL_SERVICES=( "$@" )
fi

mkdir -p "$LAUNCH_AGENT_DIR"
mkdir -p "$LOG_DIR"

NODE_BIN="$( command -v node )"
GO_BIN="$( command -v go )"
DOCKER_BIN="$( command -v docker )"

if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH. Install Node.js (e.g. via nvm)." >&2
  exit 1
fi
if [[ -z "$GO_BIN" ]]; then
  echo "WARNING: go not found in PATH. API service may fail to start." >&2
fi
if [[ -z "$DOCKER_BIN" ]]; then
  echo "WARNING: docker not found in PATH. Infra service will fail." >&2
fi

echo "Detected:"
echo "  node:   $NODE_BIN"
echo "  go:     ${GO_BIN:-(missing)}"
echo "  docker: ${DOCKER_BIN:-(missing)}"
echo ""

# Make the wrapper scripts executable (chmod +x on first install).
chmod +x "$PLIST_SRC_DIR"/*.sh 2>/dev/null || true

for s in "${ALL_SERVICES[@]}"; do
  SRC="$PLIST_SRC_DIR/dev.lantern.${s}.plist"
  DST="$LAUNCH_AGENT_DIR/dev.lantern.${s}.plist"

  if [[ ! -f "$SRC" ]]; then
    echo "✗ skipping $s — no plist at $SRC"
    continue
  fi

  # Ensure node_modules for Node-based services.
  case "$s" in
    whatsapp-bridge|imessage-bridge|dashboard)
      DIR=""
      case "$s" in
        whatsapp-bridge)  DIR="$REPO_ROOT/services/whatsapp-bridge" ;;
        imessage-bridge)  DIR="$REPO_ROOT/services/imessage-bridge" ;;
        dashboard)        DIR="$REPO_ROOT/apps/web" ;;
      esac
      if [[ -d "$DIR" && ! -d "$DIR/node_modules" ]]; then
        echo "  installing $s deps…"
        ( cd "$DIR" && npm install --silent )
      fi
      ;;
  esac

  # Substitute placeholders + write atomically.
  TMP="$(mktemp)"
  sed \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
    -e "s|__HOME__|$HOME|g" \
    "$SRC" > "$TMP"
  mv "$TMP" "$DST"

  # Unload then load (replaces any existing version).
  launchctl unload "$DST" 2>/dev/null || true
  launchctl load "$DST"
  echo "✓ installed $s"
done

echo ""
echo "Loaded LaunchAgents:"
launchctl list | grep -i lantern || echo "  (none yet — check 'launchctl list' again in a moment)"
echo ""
echo "Logs:"
for s in "${ALL_SERVICES[@]}"; do
  echo "  tail -f $LOG_DIR/${s}.err.log"
done
echo ""
echo "Permission reminders (macOS-only):"
echo ""
echo "  Docker Desktop:"
echo "    Settings → General → enable 'Start Docker Desktop when you log in'"
echo "    (without this, the infra plist will wait 60s for Docker then fail)"
echo ""
echo "  iMessage bridge (requires two macOS permissions):"
echo "    System Settings → Privacy & Security → Full Disk Access"
echo "      → add: $NODE_BIN"
echo "    System Settings → Privacy & Security → Automation"
echo "      → expand $NODE_BIN → enable Messages"
echo ""
echo "  WhatsApp bridge: no extra permissions needed (uses Baileys)."
echo ""
echo "Next steps:"
echo "  1. Open http://localhost:3001 (dashboard) — should be live after ~30s"
echo "  2. Pair WhatsApp: dashboard → /personal → WhatsApp → Pair"
echo "  3. iMessage works automatically once the bridge has Full Disk + Automation"
