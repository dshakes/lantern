#!/usr/bin/env bash
#
# Generate the full set of signed iPhone "signal" Shortcuts from the
# self-contained template (_signal-template.shortcut). Each output is a single
# "Get Contents of URL" POST of a fixed {kind, detail} to /v1/signals — no input
# variable (that plumbing is what broke the earlier reusable shortcut), so they
# import and run reliably and can be attached to a Personal Automation trigger.
#
# The signed .shortcut files are written to ~/Desktop and AirDropped/opened on
# the iPhone. They embed the signal token, so they are NEVER committed.
#
# Usage:
#   LANTERN_SIGNAL_TOKEN=... scripts/iphone/app-context/generate-signals.sh
# Token resolution order: $LANTERN_SIGNAL_TOKEN, else the value baked into the
# control-plane LaunchAgent plist.
#
# Each line below is:  <ShortcutName>|<kind>|<detail>
# kind/detail are chosen so the bridge summarizer actually RENDERS them
# (renderable kinds: location, focus, device, health, now_playing, app_open)
# and so the availability concierge can parse presence from focus/device.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$HERE/_signal-template.shortcut"
OUT_DIR="${LANTERN_SHORTCUT_OUT:-$HOME/Desktop}"
PLIST="$HOME/Library/LaunchAgents/dev.lantern.api.plist"

# --- resolve token ---------------------------------------------------------
TOKEN="${LANTERN_SIGNAL_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$PLIST" ]; then
  TOKEN="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:LANTERN_SIGNAL_TOKEN' "$PLIST" 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "ERROR: no LANTERN_SIGNAL_TOKEN (env or plist). Set it and retry." >&2
  exit 1
fi
[ -f "$TEMPLATE" ] || { echo "ERROR: template not found: $TEMPLATE" >&2; exit 1; }
command -v shortcuts >/dev/null 2>&1 || { echo "ERROR: 'shortcuts' CLI not found (macOS Monterey+)." >&2; exit 1; }
mkdir -p "$OUT_DIR"

# --- the signal set --------------------------------------------------------
# Presence / status (Action Button, NFC tag, or home-screen tap):
SIGNALS=(
  "Lantern-Status-Busy|focus|Busy"
  "Lantern-Status-Available|focus|Available"
  "Lantern-Status-DND|focus|DND"
  "Lantern-Status-Desk|focus|Desk"
  "Lantern-Driving|device|driving"
  # Automation-driven presence:
  "Lantern-Sleep|focus|Sleep"
  "Lantern-Wake|focus|Available"
  "Lantern-LowBattery|device|low_battery"
  # Geofence presence (attach to Arrive/Leave automations):
  "Lantern-Location-Home|location|Home"
  "Lantern-Location-Office|location|Office"
  "Lantern-Location-Gym|location|Gym"
  "Lantern-Location-Airport|location|Airport"
  "Lantern-Traveling|location|Traveling"
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SIGNED=0

for entry in "${SIGNALS[@]}"; do
  IFS='|' read -r NAME KIND DETAIL <<< "$entry"
  UNSIGNED="$TMP/$NAME.shortcut"   # signer requires a .shortcut input extension
  # Substitute placeholders. Detail/kind are simple [A-Za-z_] tokens; token is
  # opaque. Use a Python one-liner for safe literal replacement (no sed escaping).
  KIND="$KIND" DETAIL="$DETAIL" TOKEN="$TOKEN" TEMPLATE="$TEMPLATE" \
    python3 - "$UNSIGNED" <<'PY'
import os, sys
out = sys.argv[1]
s = open(os.environ["TEMPLATE"], "r", encoding="utf-8").read()
s = (s.replace("__KIND__", os.environ["KIND"])
      .replace("__DETAIL__", os.environ["DETAIL"])
      .replace("__SIGNAL_TOKEN__", os.environ["TOKEN"]))
open(out, "w", encoding="utf-8").write(s)
PY
  shortcuts sign --mode anyone --input "$UNSIGNED" --output "$OUT_DIR/$NAME.shortcut"
  echo "  ✓ $NAME  ({kind:$KIND, detail:$DETAIL})"
  SIGNED=$((SIGNED+1))
done

echo
echo "Signed $SIGNED shortcuts → $OUT_DIR"
echo "AirDrop them to the iPhone (or open in Shortcuts), then attach each to its"
echo "Personal Automation trigger per scripts/iphone/app-context/RICH-SIGNALS.md."
