#!/usr/bin/env bash
# Run the Lantern dashboard as an always-on PRODUCTION service under launchd.
#
# Why production, not `next dev`: dev mode compiles on demand, grows memory over
# days of uptime, and corrupts `.next` when the process is killed mid-write —
# every one of which has taken the always-on dashboard down with a 500. A
# `next build` + `next start` serves a stable prebuilt app that restarts fast and
# cannot 500 on a stale dev cache.
#
# For ACTIVE dashboard development (hot reload), run `make dashboard-dev` in a
# terminal instead — don't rely on this always-on instance.
#
# Note: no `set -e` — the build fallback ladder below must be allowed to run.
set -uo pipefail
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
cd "$REPO_ROOT/apps/web"

# Wait up to 60s for the API so we don't flash "API offline" during boot.
for i in {1..30}; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/healthz | grep -q 200; then
    echo "[$(date +%T)] api reachable (after ${i}x2s)"
    break
  fi
  sleep 2
done

# node_modules might not exist on a freshly-cloned repo.
if [[ ! -d node_modules ]]; then
  echo "[$(date +%T)] installing dashboard deps…"
  npm install --silent
fi

# apps/web builds with `output: "standalone"`, which `next start` does NOT serve
# correctly. The standalone bundle omits static + public assets, so copy them in
# and run its own server (reads PORT from the launchd env; bind all interfaces
# so it's reachable over Tailscale too).
start_standalone() {
  rm -rf .next/standalone/.next/static .next/standalone/public
  cp -r .next/static .next/standalone/.next/static 2>/dev/null || true
  [[ -d public ]] && cp -r public .next/standalone/public
  echo "[$(date +%T)] starting standalone server on :${PORT:-3001}"
  exec env HOSTNAME=0.0.0.0 node .next/standalone/server.js
}

# Build ONLY when there is no standalone bundle yet (first run, or after a clean).
# A crash-restart then re-serves the existing build in seconds instead of doing a
# slow type-checked rebuild — that fast recovery is the whole point of "always up".
# To deploy new dashboard code, rebuild explicitly and restart:
#   (cd apps/web && rm -rf .next && npm run build)
#   launchctl kickstart -k gui/$(id -u)/dev.lantern.dashboard
if [[ ! -f .next/standalone/server.js ]]; then
  echo "[$(date +%T)] no standalone build present — building (one-time)…"
  if ! npm run build; then
    echo "[$(date +%T)] ⚠ build FAILED and no prior build — falling back to dev mode"
    exec npm run dev
  fi
fi
start_standalone
