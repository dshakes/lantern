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
#   Go       run_go rebuilds on start when any *.go is newer than bin/, so a
#            restart IS a deploy. Restart when sources are newer than the
#            running process.
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
  st="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/ *$//')" || return 1
  [[ -n "$st" ]] || return 1
  date -j -f "%a %b %d %T %Y" "$st" +%s 2>/dev/null
}
pid_of() { pgrep -f "$1" | head -1; }
newest_source_epoch() {  # newest mtime among the given paths (files or dirs)
  local newest=0 f m
  for f in "$@"; do
    [[ -e "$f" ]] || continue
    m="$(find "$f" -type f \( -name '*.rs' -o -name '*.go' -o -name '*.ts' -o -name 'Cargo.lock' -o -name 'Cargo.toml' -o -name 'go.sum' \) -exec stat -f %m {} + 2>/dev/null | sort -n | tail -1)"
    [[ -n "$m" && "$m" -gt "$newest" ]] && newest="$m"
  done
  echo "$newest"
}
declare -a RESTART=() SKIPPED=()
want_restart() {  # label, process-pattern, newest-source-epoch → decides + records reason
  local label="$1" pat="$2" src="$3" pid p
  pid="$(pid_of "$pat")"
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
  want_restart "$rs" "lantern-$rs" "$(stat -f %m "$bin" 2>/dev/null || echo 0)"
done

# --- 3. Go: run_go rebuilds on start, so restart when sources are newer ------
want_restart api               "bin/server"          "$(newest_source_epoch services/control-plane)"
want_restart runtime-scheduler "bin/scheduler"       "$(newest_source_epoch services/runtime-scheduler)"
want_restart workflow-engine   "bin/workflow-engine" "$(newest_source_epoch services/workflow-engine)"

# --- 4. Bridges: tsx from source, so restart when sources are newer ---------
core="$(newest_source_epoch packages/bridge-core/src)"
for br in imessage-bridge whatsapp-bridge; do
  s="$(newest_source_epoch "services/$br/src")"; [[ "$core" -gt "$s" ]] && s="$core"
  want_restart "$br" "$br/src/index.ts" "$s"
done

# --- 5. restart + prove -------------------------------------------------------
declare -A PAT=( [api]="bin/server" [runtime-scheduler]="bin/scheduler" [workflow-engine]="bin/workflow-engine"
                 [imessage-bridge]="imessage-bridge/src/index.ts" [whatsapp-bridge]="whatsapp-bridge/src/index.ts"
                 [gateway]="lantern-gateway" [model-router]="lantern-model-router"
                 [runtime-manager]="lantern-runtime-manager" [surface-gateway]="lantern-surface-gateway" )
for label in "${RESTART[@]:-}"; do
  [[ -n "$label" ]] || continue
  launchctl kickstart -k "gui/$UID_/dev.lantern.$label" 2>/dev/null || fail "$label: launchctl kickstart failed (is dev.lantern.$label installed?)"
done
sleep 3
for label in "${RESTART[@]:-}"; do
  [[ -n "$label" ]] || continue
  pid=""; for _ in $(seq 1 30); do pid="$(pid_of "${PAT[$label]}")"; [[ -n "$pid" ]] && break; sleep 2; done
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
