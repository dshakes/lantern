#!/bin/bash
# deploy-local.sh — make the running LaunchAgents match origin/master, and PROVE it.
#
# Why this exists (ADR 0024, W5.3): a merge is not a deploy. In one fortnight
# three services ran stale code for weeks after their fixes were merged — the
# control-plane on a July build with a metering bug that failed 11,074 times,
# both bridges on an August build, and two Rust services on binaries that
# still carried a patched DoS. Every "merged" was true; none of them was live.
#
# What "deploy" means per service class:
#   Rust     run_rust execs target/release/<bin> and only BUILDS when the file
#            is missing — so a restart alone keeps the old code. Rebuild when
#            src/Cargo.* is newer than the binary; restart when the binary is
#            newer than the running process.
#   Go       run_go rebuilds on start when any *.go/go.mod/go.sum is newer
#            than bin/, so a restart IS a deploy. Restart when sources are
#            newer than the running process.
#   Bridges  tsx runs straight from src/, so a restart IS a deploy. Restart
#            when services/<bridge>/src or packages/bridge-core/src is newer
#            than the running process.
#
# Then verify: every restarted service must have a process whose start time is
# after this run began. A deploy that cannot prove itself exits non-zero.
#
#   make deploy-local            # rebuild/restart only what changed
#   FORCE=1 make deploy-local    # restart everything regardless
set -uo pipefail
# `ps -o lstart=` and `date -j -f "%a %b %d %T %Y"` both parse/format against
# the locale — a non-English LC_TIME (or, on the 1st-9th of the month, extra
# padding that only appears in some locales) breaks the parse. Pin to C so the
# format is always the plain ASCII one the parser below expects.
export LC_ALL=C
export LC_TIME=C
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
cd "$REPO_ROOT"
FORCE="${FORCE:-0}"
UID_="$(id -u)"

log()  { printf '[%s] %s\n' "$(date +%T)" "$*"; }
fail() { log "FAIL  $*"; FAILED=1; }
FAILED=0

# --- 1. master must be the thing we deploy -------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "master" ]]; then
  echo "deploy-local runs master; you are on '$branch'. Switch first." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "working tree has uncommitted changes; deploy only ships committed master." >&2
  exit 1
fi
git fetch -q origin && git merge -q --ff-only origin/master || { echo "cannot fast-forward master to origin/master" >&2; exit 1; }
log "master: $(git log --oneline -1)"
T0="$(date +%s)"

# --- helpers ---------------------------------------------------------------
epoch_of_pid() {  # process start time as epoch seconds ("" if no such pid)
  local pid="$1" st
  # macOS pads single-digit days with an extra space (e.g. "Fri Sep  4 …");
  # `tr -s ' '` squeezes runs of spaces so the fixed-width %d format always matches.
  st="$(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ' | sed 's/^ *//; s/ *$//')" || return 1
  [[ -n "$st" ]] || return 1
  date -j -f "%a %b %d %T %Y" "$st" +%s 2>/dev/null
}
pid_of_agent() {  # label -> the launchd job's own pid ("" if not loaded/running)
  # Query launchd directly rather than pattern-matching process cmdlines:
  # bridges run as `exec node node_modules/.bin/tsx src/index.ts`, so a
  # cmdline grep for "<bridge>/src/index.ts" never matches, and a bare
  # process-name grep can also latch onto a stale/orphaned process or the
  # same service running from another checkout. `launchctl print` reports
  # the actual job pid launchd is supervising.
  local label="$1" pid
  pid="$(launchctl print "gui/$UID_/dev.lantern.$label" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/{print $NF; exit}')"
  [[ "$pid" =~ ^[0-9]+$ ]] && echo "$pid"
}
newest_source_epoch() {  # newest mtime among the given paths (files or dirs)
  local newest=0 f m
  for f in "$@"; do
    [[ -e "$f" ]] || continue
    m="$(find "$f" -type f \( -name '*.rs' -o -name '*.go' -o -name '*.ts' -o -name 'Cargo.lock' -o -name 'Cargo.toml' \
                            -o -name 'go.mod' -o -name 'go.sum' -o -name 'package.json' -o -name 'package-lock.json' -o -name 'tsconfig.json' \) \
         -exec stat -f %m {} + 2>/dev/null | sort -n | tail -1)"
    [[ -n "$m" && "$m" -gt "$newest" ]] && newest="$m"
  done
  echo "$newest"
}
declare -a RESTART=() SKIPPED=()
want_restart() {  # label, newest-source-epoch → decides + records reason
  local label="$1" src="$2" pid p
  pid="$(pid_of_agent "$label")"
  if [[ "$FORCE" == "1" ]]; then RESTART+=("$label"); return; fi
  if [[ -z "$pid" ]]; then RESTART+=("$label"); log "RESTART $label (not running)"; return; fi
  p="$(epoch_of_pid "$pid" || echo 0)"
  if [[ "$src" -gt "$p" ]]; then
    RESTART+=("$label"); log "RESTART $label (sources $(date -r "$src" +%m-%d\ %T) newer than process $(date -r "$p" +%m-%d\ %T))"
  else
    SKIPPED+=("$label"); log "skip    $label (process already newer than its sources)"
  fi
}

# --- 2. Rust: rebuild when stale, restart when the binary outruns the process
for rs in gateway model-router runtime-manager surface-gateway; do
  dir="services/$rs"; bin="$dir/target/release/lantern-$rs"
  [[ -d "$dir" ]] || continue
  src="$(newest_source_epoch "$dir/src" "$dir/Cargo.lock" "$dir/Cargo.toml")"
  b_before="$(stat -f %m "$bin" 2>/dev/null || echo 0)"
  if [[ ! -x "$bin" || "$src" -gt "$b_before" ]]; then
    log "build   $rs (sources newer than binary)…"
    ( cd "$dir" && cargo build --release -q ) || { fail "$rs: cargo build failed"; continue; }
    b_after="$(stat -f %m "$bin" 2>/dev/null || echo 0)"
    # Say REBUILT only if cargo actually produced a new binary; a lockfile
    # whose git mtime moved with nothing to compile is a no-op, not a rebuild.
    [[ "$b_after" -gt "$b_before" ]] && log "REBUILT $rs" || log "no-op   $rs (nothing to compile)"
  fi
  want_restart "$rs" "$(stat -f %m "$bin" 2>/dev/null || echo 0)"
done

# --- 3. Go: run_go rebuilds on start, so restart when sources are newer ------
want_restart api               "$(newest_source_epoch services/control-plane)"
want_restart runtime-scheduler "$(newest_source_epoch services/runtime-scheduler)"
want_restart workflow-engine   "$(newest_source_epoch services/workflow-engine)"

# --- 4. Bridges: tsx from source, so restart when sources are newer ---------
core="$(newest_source_epoch packages/bridge-core/src packages/bridge-core/package.json packages/bridge-core/package-lock.json)"
for br in imessage-bridge whatsapp-bridge; do
  s="$(newest_source_epoch "services/$br/src" "services/$br/package.json" "services/$br/package-lock.json" "services/$br/tsconfig.json")"
  [[ "$core" -gt "$s" ]] && s="$core"
  want_restart "$br" "$s"
done

# --- 5. restart + prove -------------------------------------------------------
for label in "${RESTART[@]:-}"; do
  [[ -n "$label" ]] || continue
  launchctl kickstart -k "gui/$UID_/dev.lantern.$label" 2>/dev/null || fail "$label: launchctl kickstart failed (is dev.lantern.$label installed?)"
done
sleep 3
for label in "${RESTART[@]:-}"; do
  [[ -n "$label" ]] || continue
  pid=""; for _ in $(seq 1 30); do pid="$(pid_of_agent "$label")"; [[ -n "$pid" ]] && break; sleep 2; done
  if [[ -z "$pid" ]]; then fail "$label: not running after restart"; continue; fi
  p="$(epoch_of_pid "$pid" || echo 0)"
  if [[ "$p" -ge "$T0" ]]; then log "OK      $label pid=$pid started $(date -r "$p" +%T)"
  else fail "$label: process started $(date -r "$p" +%m-%d\ %T), BEFORE this deploy — still on old code"; fi
done

# --- 6. summary ----------------------------------------------------------------
log "restarted: ${RESTART[*]:-none}"
log "skipped:   ${SKIPPED[*]:-none}"
if [[ "$FAILED" -ne 0 ]]; then log "DEPLOY INCOMPLETE"; exit 1; fi
log "DEPLOY VERIFIED"
