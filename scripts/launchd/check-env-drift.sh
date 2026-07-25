#!/usr/bin/env bash
# Fail if a LaunchAgent plist and the shared dev defaults disagree, or if a
# service is missing wiring it cannot run without.
#
# The bug this catches: dev.lantern.runtime-manager.plist had no SCHEDULER_URL,
# so under launchd the manager never self-registered — the scheduler marked the
# node draining and every placement failed, while the manager process itself
# stayed healthy and logged nothing alarming. Nothing in CI or at boot noticed,
# because a missing env var is not an error to anyone.
#
# Run standalone or via `make check-launchd-env`.

set -euo pipefail

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
AGENTS="$REPO_ROOT/scripts/launchd"
fail=0

note() { printf "  %-34s %s\n" "$1" "$2"; }

# Read one EnvironmentVariables entry out of a plist. Empty if absent.
plist_env() {
  /usr/bin/python3 - "$1" "$2" <<'PY' 2>/dev/null || true
import plistlib, sys
try:
    d = plistlib.load(open(sys.argv[1], "rb"))
except Exception:
    sys.exit(0)
print(d.get("EnvironmentVariables", {}).get(sys.argv[2], ""))
PY
}

# --- 1. Required wiring must be present -----------------------------------
# A service that silently degrades when a var is missing belongs here.
echo "checking required LaunchAgent wiring…"
while IFS='|' read -r svc var why; do
  [ -z "$svc" ] && continue
  f="$AGENTS/dev.lantern.$svc.plist"
  [ -f "$f" ] || { note "$svc" "SKIP (no plist)"; continue; }
  val="$(plist_env "$f" "$var")"
  if [ -z "$val" ]; then
    note "$svc.$var" "MISSING — $why"
    fail=1
  else
    note "$svc.$var" "ok ($val)"
  fi
done <<'REQUIRED'
runtime-manager|SCHEDULER_URL|without it the node never self-registers and every placement fails
runtime-manager|NODE_NAME|without it the node id is the hostname, which can register a duplicate node
runtime-scheduler|LANTERN_DEFAULT_MANAGER_ADDR|without it the scheduler cannot dial the node it placed onto
REQUIRED

# --- 2. Where both define a value, they must agree ------------------------
echo "checking plist values against scripts/launchd/service-env.sh…"
# shellcheck source=./service-env.sh
. "$AGENTS/service-env.sh"

while IFS='|' read -r svc var expected; do
  [ -z "$svc" ] && continue
  f="$AGENTS/dev.lantern.$svc.plist"
  [ -f "$f" ] || continue
  val="$(plist_env "$f" "$var")"
  [ -z "$val" ] && continue   # absent is fine; the shared defaults fill it
  if [ "$val" != "$expected" ]; then
    note "$svc.$var" "DRIFT — plist='$val' shared='$expected'"
    fail=1
  else
    note "$svc.$var" "agrees ($val)"
  fi
done <<REQUIRED
runtime-manager|SCHEDULER_URL|$SCHEDULER_URL
runtime-manager|NODE_NAME|$NODE_NAME
runtime-manager|NODE_ADVERTISE_ADDR|$NODE_ADVERTISE_ADDR
runtime-scheduler|LANTERN_DEFAULT_MANAGER_ADDR|$LANTERN_DEFAULT_MANAGER_ADDR
REQUIRED

if [ "$fail" -ne 0 ]; then
  echo
  echo "✗ LaunchAgent env check failed."
  echo "  Fix the plist under scripts/launchd/, or update the shared defaults in"
  echo "  scripts/launchd/service-env.sh, then reinstall: bash scripts/launchd/install.sh"
  exit 1
fi

echo "✓ LaunchAgent env is consistent"
