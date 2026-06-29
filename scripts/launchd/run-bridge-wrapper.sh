#!/bin/bash
# Launchd wrapper for the macOS bridges (whatsapp/imessage).
#
# WHY THIS EXISTS: the bridge node_modules has been corrupted before (a missing
# node_modules/.bin/tsx — caused by git-worktree create/remove operations that
# shared/symlinked the bridge node_modules). The plist used to run tsx directly,
# so a missing runner crashed the bot on boot with NO recovery. This wrapper
# self-heals: if the tsx runner is missing or broken, it runs `npm install`
# before booting, so a restart can never fail on a missing runner.
#
# Usage (from the plist): run-bridge-wrapper.sh <absolute-bridge-dir>
set -uo pipefail

BRIDGE_DIR="${1:?usage: run-bridge-wrapper.sh <bridge-dir>}"

# launchd has a minimal PATH; put the (newest) nvm node on PATH so npm + node resolve.
NODE_DIR="$(dirname "$(ls -t "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)")"
[ -n "${NODE_DIR:-}" ] && [ -d "$NODE_DIR" ] && export PATH="$NODE_DIR:$PATH"

cd "$BRIDGE_DIR" || { echo "[$(date +%T)] bridge dir missing: $BRIDGE_DIR" >&2; exit 1; }

# Self-heal a missing/broken tsx runner before boot.
if [ ! -x node_modules/.bin/tsx ] || [ ! -f node_modules/tsx/dist/cli.mjs ]; then
  echo "[$(date +%T)] bridge tsx missing/broken in $BRIDGE_DIR — self-healing via npm install" >&2
  npm install --no-audit --no-fund || echo "[$(date +%T)] npm install failed; attempting boot anyway" >&2
fi

exec node node_modules/.bin/tsx src/index.ts
