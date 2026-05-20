#!/usr/bin/env bash
# whatsapp-nuclear-reset.sh — full WhatsApp pairing recovery.
#
# Use this when the bridge is stuck with stale Signal protocol session
# keys (symptoms: 'Waiting for this message' indicators on every command,
# 'SessionError: No matching sessions found' in the bridge log, the
# bridge log shows the user's JID has multiple generations of
# session-*.json files like .0, .20, .26).
#
# What this does (in order):
#   1. Stops the bridge process.
#   2. Wipes the on-disk auth_sessions/ directory for the dev tenant
#      so the bridge has no cached keys.
#   3. Restarts the bridge into a fully idle state.
#
# What this DOES NOT do (you must do these manually on your phone
# BEFORE running this script — read the warning below):
#   - Log out OTHER Linked Devices from your WhatsApp app.
#   - Wait the 60s for WhatsApp's servers to flush your pre-key bundle.
#
# Skipping the phone-side step is why repeated re-pairs keep failing.
# WhatsApp caches your pre-key bundle server-side; the bundle is keyed
# to the linked-device identity, and until you explicitly log out the
# OLD devices on your phone, new pairings will receive corrupted keys
# that don't match what your phone uses to encrypt messages.

set -e

TENANT_ID="00000000-0000-0000-0000-000000000001"
AUTH_DIR="services/whatsapp-bridge/auth_sessions/${TENANT_ID}"

# Colors
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; YLW=$'\033[0;33m'; GRN=$'\033[0;32m'
  BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  RED=''; YLW=''; GRN=''; BLD=''; DIM=''; RST=''
fi

cat <<EOF
${BLD}WhatsApp nuclear reset${RST}

This will wipe the bridge's stored credentials and restart it. Before
continuing, you ${RED}MUST${RST} do this on your phone:

  1. Open WhatsApp on your phone
  2. Tap Settings → ${BLD}Linked Devices${RST}
  3. Tap ${BLD}every device${RST} listed and log it out
     (Lantern bridge, web.whatsapp.com, any others)
  4. Wait ${YLW}60 seconds${RST} for WhatsApp to clear server-side pre-key caches

${DIM}Why: stale pre-keys on WhatsApp's servers are what cause the 'Waiting
for this message' loop. Wiping only the bridge's side leaves the phone
encrypting new messages with cached keys that no longer match.${RST}

EOF

read -r -p "Have you done all 4 steps above? [y/N] " ack
if [[ ! "$ack" =~ ^[Yy]$ ]]; then
  echo "Aborted. Run again once you've logged out all devices on your phone."
  exit 1
fi

cd "$(dirname "$0")/.."

echo
echo "${BLD}1. Stopping bridge${RST}"
PID=$(lsof -nP -tiTCP:3100 -sTCP:LISTEN 2>/dev/null | head -1 || true)
if [[ -n "$PID" ]]; then
  kill "$PID" 2>/dev/null || true
  sleep 1
  # Force-kill stragglers
  lsof -nP -tiTCP:3100 -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  sleep 1
  echo "   ${GRN}✓${RST} stopped (was pid $PID)"
else
  echo "   ${DIM}(bridge wasn't running)${RST}"
fi

echo
echo "${BLD}2. Wiping auth credentials${RST}"
if [[ -d "$AUTH_DIR" ]]; then
  COUNT=$(find "$AUTH_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
  rm -rf "$AUTH_DIR"
  echo "   ${GRN}✓${RST} removed ${COUNT} files from ${AUTH_DIR}"
else
  echo "   ${DIM}(no auth dir to wipe — clean slate)${RST}"
fi

echo
echo "${BLD}3. Starting bridge${RST}"
nohup make run-whatsapp-bridge > /tmp/lantern-whatsapp-bridge.log 2>&1 &
disown
for i in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:3100/health -m 2 2>/dev/null || echo "")
  if [[ "$code" == "200" ]]; then
    echo "   ${GRN}✓${RST} bridge ready in ${i}s"
    break
  fi
  sleep 1
done

echo
echo "${BLD}4. Verifying clean state${RST}"
DIAG=$(curl -sS "http://localhost:3100/session/${TENANT_ID}/diagnostics" -m 2 2>/dev/null || echo '{}')
echo "   ${DIM}${DIAG}${RST}"

echo
echo "${GRN}✓ Nuclear reset complete.${RST}"
echo
echo "Next steps:"
echo "  1. Open the dashboard: ${BLD}http://localhost:3001/surfaces${RST}"
echo "  2. Click ${BLD}Pair${RST} on the WhatsApp card"
echo "  3. Scan the fresh QR with your phone"
echo "  4. Watch for ${BLD}🟢 Lantern is connected${RST} in your self-chat"
echo "     — this confirms encryption is bootstrapped"
echo "  5. Try ${BLD}/lantern ping${RST} — should reply with 🏓 instantly"
