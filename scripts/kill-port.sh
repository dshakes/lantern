#!/usr/bin/env bash
# kill-port.sh <port> [<port> ...] — terminate any process listening on
# the given TCP port(s). Used by Makefile run-* targets so re-running
# them after a prior instance doesn't EADDRINUSE.
#
# Safe properties:
#   - Always exits 0 (failing to kill is fine if nothing was bound).
#   - Skips if no process found (no spurious "killed PID -1" logs).
#   - Tries SIGTERM, sleeps 1s, then SIGKILL stragglers.
#   - Reports the PID it killed for visibility.

set +e

if [[ $# -eq 0 ]]; then
  echo "usage: kill-port.sh <port> [<port> ...]"
  exit 0
fi

for port in "$@"; do
  pids=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)
  if [[ -z "$pids" ]]; then
    continue
  fi
  echo "kill-port: terminating PID(s) $pids on :$port"
  echo "$pids" | xargs -r kill 2>/dev/null
  sleep 1
  # Force-kill anything still alive
  echo "$pids" | xargs -r -I{} sh -c 'kill -0 {} 2>/dev/null && kill -9 {} 2>/dev/null' >/dev/null 2>&1
done

# Tiny pause so the OS releases the socket before the caller binds again.
sleep 0.3
exit 0
