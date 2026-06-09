#!/usr/bin/env bash
# One-shot post-reboot health check for the Lantern dev stack.
# Armed via dev.lantern.post-reboot-check.plist (RunAtLoad). After it writes
# its report it disarms itself so it only runs on the first login after arming.
set -uo pipefail

REPORT="$HOME/Library/Logs/Lantern/post-reboot-check.log"
mkdir -p "$(dirname "$REPORT")"
PLIST="$HOME/Library/LaunchAgents/dev.lantern.post-reboot-check.plist"
UID_NUM="$(id -u)"

{
  echo "================================================================"
  echo "Lantern post-reboot check — started $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "uptime: $(uptime)"
  echo "================================================================"

  # Wait up to 5 min for Docker to be reachable (proves launch-at-login worked).
  docker_ok=no
  for i in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then docker_ok=yes; echo "[docker] reachable after $((i*5))s"; break; fi
    sleep 5
  done
  [ "$docker_ok" = no ] && echo "[docker] NEVER became reachable after 300s"

  # Wait up to 3 more min for the API to answer (infra->api chain).
  api_ok=no
  for i in $(seq 1 36); do
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://localhost:8080/healthz 2>/dev/null)
    if [ "$code" = "200" ]; then api_ok=yes; echo "[api] /healthz 200 after $((i*5))s"; break; fi
    sleep 5
  done
  [ "$api_ok" = no ] && echo "[api] /healthz never returned 200 after 180s"

  echo
  echo "--- infra containers ---"
  docker ps --format '{{.Names}}  {{.Status}}' 2>&1 | grep -E 'docker-(postgres|redis|minio)' || echo "(none found)"

  echo
  echo "--- endpoints ---"
  printf "api  /healthz   -> %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 4 http://localhost:8080/healthz)"
  printf "api  /readyz    -> %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 4 http://localhost:8080/readyz)"
  printf "dashboard :3001 -> %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 4 http://localhost:3001)"
  printf "wa-bridge /health -> %s\n" "$(curl -s -m 4 http://localhost:3100/health 2>/dev/null)"
  printf "wa pairing      -> %s\n" "$(curl -s -m 4 http://localhost:3100/session/00000000-0000-0000-0000-000000000001/has-creds 2>/dev/null)"

  echo
  echo "--- launchd agents ---"
  for s in infra api dashboard whatsapp-bridge imessage-bridge tunnel tunnel-watcher a2p-watcher; do
    printf "%-22s " "$s"
    launchctl print gui/$UID_NUM/dev.lantern.$s 2>/dev/null | grep -E 'pid =|last exit code' | tr '\n' ' '
    echo
  done

  echo
  echo "--- imessage-bridge log freshness ---"
  IMLOG="$HOME/Library/Logs/Lantern/imessage-bridge.out.log"
  [ -f "$IMLOG" ] && echo "mtime: $(stat -f '%Sm' "$IMLOG")" || echo "(log not found)"

  echo
  echo "post-reboot check — finished $(date '+%Y-%m-%d %H:%M:%S %Z')"
} > "$REPORT" 2>&1

# Disarm: this is a one-shot. Remove the plist and bootout so it won't run on
# every future login.
launchctl bootout gui/$UID_NUM/dev.lantern.post-reboot-check 2>/dev/null
rm -f "$PLIST" 2>/dev/null
exit 0
