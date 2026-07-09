#!/bin/bash
# Bridge self-introspection cadence — runs headless Claude Code a few times a day
# to audit the LIVE iMessage + WhatsApp bot's real responses, fix clear bugs, and
# merge low-risk fixes to master. Design + rationale: scripts/introspect/PROMPT.md.
#
# Safe by construction: skips entirely if the working tree is dirty (never runs
# over in-flight work), caps its own runtime, and logs every run. The MERGE gate
# (tests green + reviewer) lives in the PROMPT the model must obey.
set -uo pipefail

REPO="/Users/shakes/workspace/lantern"
CLAUDE="/Users/shakes/.nvm/versions/node/v22.18.0/bin/claude"
NODE_BIN="/Users/shakes/.nvm/versions/node/v22.18.0/bin"
STATE_DIR="$HOME/.lantern/introspect"
MODEL="${LANTERN_INTROSPECT_MODEL:-sonnet}"
MAX_SECONDS="${LANTERN_INTROSPECT_MAX_SECONDS:-1500}"   # 25 min hard cap
TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUNLOG="$STATE_DIR/run-$TS.log"

# launchd gives a minimal PATH; give git/node/claude what they need.
export PATH="$NODE_BIN:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
mkdir -p "$STATE_DIR"

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Lantern introspect\"" >/dev/null 2>&1 || true; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$RUNLOG"; }

cd "$REPO" || { log "repo missing"; exit 0; }

# GUARD: never run over uncommitted work — the cadence commits to master, so a
# dirty tree could sweep in the owner's in-progress edits.
if [ -n "$(git status --porcelain)" ]; then
  log "working tree dirty — skipping this run"
  notify "skipped (uncommitted changes in repo)"
  exit 0
fi

# Sync master (fast-forward only; bail on divergence rather than force anything).
git fetch origin master --quiet 2>>"$RUNLOG"
git checkout master --quiet 2>>"$RUNLOG" || { log "checkout master failed"; exit 0; }
if ! git merge --ff-only origin/master --quiet 2>>"$RUNLOG"; then
  log "master diverged from origin — skipping (needs a human)"
  notify "skipped (master diverged)"; exit 0
fi

log "starting introspection (model=$MODEL, cap=${MAX_SECONDS}s, dryrun=${LANTERN_INTROSPECT_DRYRUN:-0})"
BEFORE="$(git rev-parse HEAD)"

# DRY-RUN valve: set LANTERN_INTROSPECT_DRYRUN=1 to review the cadence's judgment
# (report only, NO merges) before trusting its auto-merges. Default off (owner
# chose auto-merge-low-risk).
DRYRUN_SYS=()
if [ "${LANTERN_INTROSPECT_DRYRUN:-0}" = "1" ]; then
  DRYRUN_SYS=(--append-system-prompt "DRY RUN: do NOT edit, commit, or push anything. Only write the report file with what you WOULD have fixed.")
fi

# Run headless with a hard timeout (macOS has no timeout(1)): background + kill.
# --strict-mcp-config with no --mcp-config = load NO MCP servers. This env
# carries a huge set of MCP tool schemas that blow the context ("Prompt is too
# long"); the audit only needs built-in tools (Bash/Read/Edit/Grep/Agent).
"$CLAUDE" -p "$(cat "$REPO/scripts/introspect/PROMPT.md")" \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  --strict-mcp-config \
  "${DRYRUN_SYS[@]}" \
  >>"$RUNLOG" 2>&1 &
CPID=$!
( sleep "$MAX_SECONDS"; kill -TERM "$CPID" 2>/dev/null; sleep 10; kill -KILL "$CPID" 2>/dev/null ) &
WATCHDOG=$!
wait "$CPID" 2>/dev/null; RC=$?
kill "$WATCHDOG" 2>/dev/null || true

AFTER="$(git rev-parse HEAD)"
if [ "$BEFORE" != "$AFTER" ]; then
  log "introspection MERGED: $BEFORE -> $AFTER (rc=$RC)"
  notify "merged a fix to master ($(git log -1 --format=%s | cut -c1-60))"
else
  log "introspection done, no merge (rc=$RC)"
  notify "review done — no changes"
fi
# Keep only the last 60 run logs.
ls -1t "$STATE_DIR"/run-*.log 2>/dev/null | tail -n +61 | xargs rm -f 2>/dev/null || true
