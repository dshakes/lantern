#!/usr/bin/env bash
#
# Stable, private remote access to the Lantern harness via Tailscale Serve.
# Fronts the control-plane API (:8080) AND the dashboard (:3001) on ONE tailnet
# HTTPS host, same-origin — no public exposure, URL survives reboots.
#
# Prereqs: Tailscale signed in on this Mac + the phone (same tailnet), and Serve
# enabled for the tailnet (the first `serve` call prints an enable link if not).
# See docs/personal/REMOTE-ACCESS.md.
#
# NOTE: --set-path STRIPS its prefix, so the target repeats the path (/v1 ->
# .../v1) to round-trip; otherwise every /v1/* call 404s.
set -euo pipefail

TS="${TAILSCALE_BIN:-}"
if [ -z "$TS" ]; then
  if command -v tailscale >/dev/null 2>&1; then TS="$(command -v tailscale)";
  elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  else echo "tailscale CLI not found (install Tailscale + sign in)"; exit 1; fi
fi

API_PORT="${LANTERN_API_PORT:-8080}"
DASH_PORT="${LANTERN_DASHBOARD_PORT:-3001}"

echo "Resetting serve config..."
"$TS" serve reset

echo "Mounting API ($API_PORT) under /v1 /auth /.well-known and dashboard ($DASH_PORT) at /..."
"$TS" serve --bg --set-path=/v1          "http://127.0.0.1:${API_PORT}/v1"
"$TS" serve --bg --set-path=/auth        "http://127.0.0.1:${API_PORT}/auth"
"$TS" serve --bg --set-path=/.well-known "http://127.0.0.1:${API_PORT}/.well-known"
"$TS" serve --bg                          "${DASH_PORT}"

echo
"$TS" serve status
echo
echo "Done. Reminder: set NEXT_PUBLIC_API_URL (dashboard) + LANTERN_SIGNAL_TOKEN (api+dashboard)"
echo "to your tailnet host, per docs/personal/REMOTE-ACCESS.md."
