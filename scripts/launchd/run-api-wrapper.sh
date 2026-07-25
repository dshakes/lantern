#!/usr/bin/env bash
# Run the Lantern control-plane API. Waits for Postgres to be reachable
# before launching (launchd-spawned processes don't have a guarantee
# that the infra LaunchAgent finished, and we don't want a crash-loop
# at boot).

set -uo pipefail
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"

# launchd hands us a minimal PATH — restore go + homebrew.
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/opt/go/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Shared wiring defaults (scheduler address, node identity, JWT secret), also
# sourced by the `make run-*` targets so the two cannot drift.
# shellcheck source=./service-env.sh
. "$REPO_ROOT/scripts/launchd/service-env.sh"

# Shared launch helpers (wait_port / run_go).
# shellcheck source=./lib.sh
. "$REPO_ROOT/scripts/launchd/lib.sh"

# Shared local env — same file the bridge + dashboard wrappers source. Feature
# flags (LANTERN_CONFIDENCE_*, LANTERN_IMMIGRATION_SENTINEL, …) live here so a
# plain `kickstart -k` reloads them with no plist bootout/bootstrap: launchd
# re-runs this wrapper, which re-sources the file every start. That still holds
# now the server is a compiled binary rather than `go run` — the reload comes
# from re-sourcing here, not from how the process is launched.
#
# Sourced AFTER service-env.sh so anything set here wins over the shared
# defaults.
if [ -f "$HOME/.lantern/bridge.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.lantern/bridge.env"
  set +a
fi

# Postgres is `required`: without it the API cannot serve anything, so a
# timeout exits non-zero and lets launchd retry on its ThrottleInterval
# rather than booting into a guaranteed-broken state.
wait_port 5432 postgres required || exit 1

echo "[$(date +%T)] starting control-plane API on :8080"
run_go control-plane ./cmd/server server
