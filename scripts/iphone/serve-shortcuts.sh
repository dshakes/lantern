#!/usr/bin/env bash
#
# Serve the signed signal Shortcuts over the PRIVATE Tailscale tailnet so the
# iPhone can install them without the Mac nearby (no AirDrop). Generates an
# index page (tap each → "Add Shortcut") and mounts it at /shortcuts.
#
# The .shortcut files embed the signal token, so they're served ONLY on the
# private tailnet (never Funnel/public) and copied to a local dir OUTSIDE git.
#
# Usage:  scripts/iphone/serve-shortcuts.sh
# Then on the iPhone (signed into the same tailnet) open:
#   https://<your-mac>.<tailnet>.ts.net/shortcuts/
set -euo pipefail

WEB="${LANTERN_SHORTCUT_WEB:-$HOME/.lantern/shortcuts-web}"
SRC="${LANTERN_SHORTCUT_SRC:-$HOME/Desktop}"
TS="${TAILSCALE_BIN:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
command -v "$TS" >/dev/null 2>&1 || TS="$(command -v tailscale || true)"
[ -n "$TS" ] || { echo "tailscale CLI not found" >&2; exit 1; }

mkdir -p "$WEB"
/bin/rm -f "$WEB"/*.shortcut 2>/dev/null || true
count=$(/bin/ls -1 "$SRC"/Lantern-*.shortcut 2>/dev/null | wc -l | tr -d ' ')
[ "$count" -gt 0 ] || { echo "No Lantern-*.shortcut in $SRC — run generate-signals.sh first." >&2; exit 1; }
/bin/cp "$SRC"/Lantern-*.shortcut "$WEB"/
chmod 600 "$WEB"/*.shortcut

# Build a simple, phone-friendly index linking each shortcut.
{
  echo '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
  echo '<title>Lantern signal shortcuts</title>'
  echo '<style>body{font:17px/1.5 -apple-system,system-ui;margin:0;background:#0b0b0f;color:#ededf0;padding:20px}'
  echo 'h1{font-size:20px}a.s{display:block;background:#15151c;border:1px solid #2a2a30;border-radius:12px;padding:14px 16px;margin:10px 0;color:#fcd34d;text-decoration:none;font-weight:600}'
  echo 'a.s small{display:block;color:#8b93a1;font-weight:400;margin-top:3px}p{color:#8b93a1;font-size:14px}</style>'
  echo '<h1>🔦 Lantern signal shortcuts</h1>'
  echo '<p>Tap each → <b>Add Shortcut</b>. Then attach its automation trigger (Shortcuts → Automation tab) per RICH-SIGNALS.md.</p>'
  for f in "$WEB"/Lantern-*.shortcut; do
    n=$(basename "$f")
    echo "<a class=\"s\" href=\"./$n\">$n<small>tap to add</small></a>"
  done
} > "$WEB/index.html"

# The Mac App Store Tailscale is sandboxed and CANNOT serve a static path, but it
# CAN proxy to a local port. So run a tiny local file server and proxy /shortcuts
# to it. (--set-path strips the prefix, so the file server serving at root lines
# up: /shortcuts/Foo.shortcut → 127.0.0.1:PORT/Foo.shortcut.)
PORT="${LANTERN_SHORTCUT_PORT:-8899}"
# Restart any previous instance of our server on this port.
pkill -f "http.server $PORT" 2>/dev/null || true
nohup python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WEB" >/dev/null 2>&1 &
sleep 1
"$TS" serve --bg --set-path=/shortcuts "http://127.0.0.1:${PORT}"
HOST="$("$TS" status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo "<your-mac>.<tailnet>.ts.net")"
echo "Served $count shortcuts (local file server on :$PORT, proxied at /shortcuts)."
echo "On the iPhone (same tailnet) open:  https://$HOST/shortcuts/"
echo "Tap each → Add Shortcut. (Signed --mode anyone, so no 'Allow Untrusted' toggle needed.)"
echo "Note: the file server runs until reboot or 'pkill -f \"http.server $PORT\"'."
