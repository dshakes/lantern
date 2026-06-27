#!/usr/bin/env bash
#
# Proactive signal-pipeline watchdog. Verifies the control-plane on :8080 actually
# ACCEPTS the signal token (a GET probe — read-only, no log pollution) and
# self-heals when it doesn't. Run by launchd every few minutes
# (dev.lantern.signal-watchdog.plist).
#
# Why this exists: a silent 401 (e.g. a stray API without LANTERN_SIGNAL_TOKEN
# taking the port, or the API crashed) breaks every phone signal with no visible
# error — the bot just says "no location." This catches that and fixes the
# common cases automatically; the rest it logs with the exact one-liner.
set -uo pipefail

LOG="$HOME/Library/Logs/Lantern/signal-watchdog.log"
PLIST="$HOME/Library/LaunchAgents/dev.lantern.api.plist"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

TOK=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:LANTERN_SIGNAL_TOKEN" "$PLIST" 2>/dev/null)
probe() { curl -s -m5 -o /dev/null -w "%{http_code}" "http://localhost:8080/v1/signals?limit=1" -H "x-lantern-signal-token: $TOK" 2>/dev/null; }

code=$(probe)
[ "$code" = "200" ] && exit 0   # healthy — stay quiet

health=$(curl -s -m4 -o /dev/null -w "%{http_code}" http://localhost:8080/healthz 2>/dev/null)
holder=$(lsof -nP -iTCP:8080 -sTCP:LISTEN 2>/dev/null | tail -1 | awk '{print $1" pid "$2}')
log "UNHEALTHY: GET /v1/signals → HTTP ${code:-down} | :8080 = ${holder:-none} | healthz=${health:-down}"

if [ "$health" != "200" ]; then
  # API is down/crashed → restart the real one. ponytail: kickstart heals a crash;
  # it cannot steal a port a foreign process holds (handled below).
  log "  → API not healthy; kickstarting dev.lantern.api"
  launchctl kickstart -k "gui/$(id -u)/dev.lantern.api" >> "$LOG" 2>&1
  sleep 8
  log "  after restart: GET /v1/signals → HTTP $(probe)"
  exit 0
fi

# Healthz OK but the signal token is rejected → a DIFFERENT control-plane (one
# without LANTERN_SIGNAL_TOKEN) is on the port. Do NOT auto-kill it — log the fix.
log "  → :8080 is up but rejects the signal token: a control-plane WITHOUT LANTERN_SIGNAL_TOKEN holds the port."
log "    Fix: kill the process above, then  launchctl kickstart -k gui/$(id -u)/dev.lantern.api"
