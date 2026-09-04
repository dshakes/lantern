#!/usr/bin/env bash
# Shared helpers for the LaunchAgent wrappers.
#
# Sourced by run-microservice.sh and run-api-wrapper.sh so the launch mechanics
# are defined once. Expects REPO_ROOT to be set by the caller.
#
# Usage:  . "$REPO_ROOT/scripts/launchd/lib.sh"

# Wait for a TCP port to accept connections.
#
#   wait_port <port> <name> [required]
#
# Default is advisory: warn after ~120s and continue, because most services
# have their own retry/backoff and starting is better than not starting.
# Pass `required` for a dependency the service genuinely cannot run without
# (the control-plane and its database) — then a timeout exits non-zero and
# launchd retries on its ThrottleInterval instead of crash-looping instantly.
wait_port() {
  local port="$1" name="$2" required="${3:-}"
  local i
  for i in {1..60}; do
    if nc -z localhost "$port" 2>/dev/null; then
      echo "[$(date +%T)] $name (:$port) reachable (after $((i * 2))s)"
      return 0
    fi
    sleep 2
  done
  if [[ "$required" == "required" ]]; then
    echo "[$(date +%T)] $name (:$port) never became reachable — is docker-compose up?" >&2
    return 1
  fi
  echo "[$(date +%T)] WARN: $name (:$port) not reachable after 120s — starting anyway" >&2
  return 0
}

# Build a Go service to a real binary, then exec it.
#
#   run_go <service-dir> <package> [binary-name]
#
# NOT `go run`. `go run` compiles to a temp binary and then SUPERVISES it as a
# child, so launchd's job pid is the `go` wrapper rather than the server:
#
#   launchd → go run → server        (what we had)
#   launchd → server                 (what we want)
#
# With the wrapper in between, signals land on the wrong process. `launchctl
# kickstart -k` and a plain `kill` both leave the real server orphaned and
# still holding its port, so the next start dies with "address already in use"
# — which is exactly what happened when restarting these by hand.
#
# Rebuilds whenever any .go file is newer than the binary, so pulling source is
# enough to pick up changes on the next restart — the property `go run` gave us
# for free and the reason it was used here originally.
run_go() {
  local svc="$1" pkg="$2" name="${3:-$(basename "$2")}"
  cd "$REPO_ROOT/services/$svc"
  local bin="bin/$name"
  if [[ ! -x "$bin" ]] || [[ -n "$(find . \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) -newer "$bin" -print -quit 2>/dev/null)" ]]; then
    echo "[$(date +%T)] building $svc -> $bin"
    go build -o "$bin" "$pkg"
  fi
  echo "[$(date +%T)] starting $svc -> $bin"
  exec "$bin"
}

# Build a Rust release binary if absent, then exec it.
#
#   run_rust <service-dir> <cargo-bin-name>
run_rust() {
  local svc="$1" pkg="$2"
  cd "$REPO_ROOT/services/$svc"
  local bin="target/release/$pkg"
  if [[ ! -x "$bin" ]]; then
    echo "[$(date +%T)] $bin missing — building (first boot, this is slow)…"
    cargo build --release
  fi
  echo "[$(date +%T)] starting $svc -> $bin"
  exec "$bin"
}
