#!/bin/bash
# pal-cutover.sh — move the owner's always-on Mac from Lantern names to PAL
# names (launchd labels, state dir, env keys, DB names, checkout remote) and
# back again, with a backup that rollback restores byte-for-byte.
#
#   pal-cutover.sh plan                 dry run: preflight + every action, nothing changes
#   pal-cutover.sh backup               timestamped backup only (services keep running)
#   pal-cutover.sh apply                preflight → stop → backup → move → … → start → health
#   pal-cutover.sh verify [--old]       post-checks only (new side, or the old side)
#   pal-cutover.sh rollback [BACKUP_DIR] [--db=dump|rename]
#   pal-cutover.sh snapshot OUT [--side=old|new]   checksum manifest (used by tests + rollback)
#
# Names come from pal-cutover.contract (override with PAL_CUTOVER_CONTRACT or
# per-variable env). Knobs:
#   PAL_CUTOVER_SANDBOX=1        test mode: HOME must be a throwaway dir, launchctl/docker/
#                                builders resolve to recorders in PAL_CUTOVER_STUB_BIN,
#                                DB names must contain "test"
#   PAL_CUTOVER_STASH=1          stash tracked local changes in the checkout instead of refusing
#   PAL_CUTOVER_FAIL_AT=<step>   inject a failure right after <step> (tests)
#   PAL_CUTOVER_AUTO_ROLLBACK=0  on a failed step, stop and leave things for inspection
#   PAL_CUTOVER_BACKUP_ROOT      where ~/pal-cutover-backup-<ts>/ is created (default $HOME)
#
# PRIVACY: this script never prints a secret value or file contents. Env files
# and plists are reported by KEY NAME only; passwords and tokens are moved
# between processes over stdin, never argv.
# SC2015: `cond && ok … || bad …` is intended — ok/warn/bad always return 0.
# shellcheck disable=SC2015
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/cutover_helper.py"
CONTRACT="${PAL_CUTOVER_CONTRACT:-$SCRIPT_DIR/pal-cutover.contract}"
# shellcheck source=./pal-cutover.contract
. "$CONTRACT"

SANDBOX="${PAL_CUTOVER_SANDBOX:-0}"
FAIL_AT="${PAL_CUTOVER_FAIL_AT:-}"
AUTO_ROLLBACK="${PAL_CUTOVER_AUTO_ROLLBACK:-1}"
STASH="${PAL_CUTOVER_STASH:-0}"
BACKUP_ROOT="${PAL_CUTOVER_BACKUP_ROOT:-$HOME}"
LA_DIR="$HOME/Library/LaunchAgents"
UIDN="$(id -u)"
TS="$(date +%Y%m%d%H%M%S)"
TMP_ROLE="${DB_NEW_USER}_cutover_tmp"
DRY=0
BK=""
WORK=""
REL_SHA=""
FAILED=0
WARNED=0

# ------------------------------------------------------------------ output
log()  { printf '[%s] %s\n' "$(date +%T)" "$*"; }
ok()   { printf '[%s]   ok    %s\n' "$(date +%T)" "$*"; }
warn() { printf '[%s]   WARN  %s\n' "$(date +%T)" "$*"; WARNED=$((WARNED + 1)); }
bad()  { printf '[%s]   FAIL  %s\n' "$(date +%T)" "$*"; FAILED=$((FAILED + 1)); }
die()  { printf '[%s] FATAL %s\n' "$(date +%T)" "$*" >&2; exit 1; }
would(){ printf '[%s]   would %s\n' "$(date +%T)" "$*"; }
hdr()  { printf '\n[%s] === %s\n' "$(date +%T)" "$*"; }
helper() { python3 -I "$HELPER" "$@"; }
journal() { [[ -n "$BK" && "$DRY" == 0 ]] && printf '%s %s\n' "$1" "$2" >> "$BK/journal"; return 0; }
journaled() { [[ -f "$1/journal" ]] && grep -q "^$2$" "$1/journal"; }

# ------------------------------------------------------------------ guards
real_home() { dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}'; }

guard_mode() {
  local rh; rh="$(real_home)"
  if [[ "$SANDBOX" == 1 ]]; then
    case "$HOME" in /private/tmp/*|/tmp/*|/private/var/folders/*) ;; *) die "sandbox: HOME=$HOME is not a throwaway dir";; esac
    [[ -n "$rh" && "$HOME" == "$rh" ]] && die "sandbox: HOME is the real home"
    [[ -d "${PAL_CUTOVER_STUB_BIN:-}" ]] || die "sandbox: PAL_CUTOVER_STUB_BIN must point at the recorder stubs"
    export PATH="$PAL_CUTOVER_STUB_BIN:$PATH"
    local t
    for t in launchctl docker cargo go npm; do
      [[ "$(command -v "$t")" == "$PAL_CUTOVER_STUB_BIN/$t" ]] || die "sandbox: $t does not resolve to the stub"
    done
    for t in "$DB_OLD_NAME" "$DB_NEW_NAME" "$DB_OLD_USER" "$DB_NEW_USER" "$DB_OLD_APP_ROLE" "$DB_NEW_APP_ROLE"; do
      [[ "$t" == *test* ]] || die "sandbox: DB name '$t' must contain 'test' (refusing to touch real objects)"
    done
    [[ "$REPO_DIR" == "$HOME"/* ]] || die "sandbox: REPO_DIR must live under the sandbox HOME"
  else
    case "$HOME" in /private/tmp/*|/tmp/*) die "HOME=$HOME looks like a sandbox; set PAL_CUTOVER_SANDBOX=1";; esac
    [[ "$(command -v launchctl)" == /bin/launchctl ]] || die "launchctl is not /bin/launchctl (stub on PATH?)"
  fi
  local n
  for n in "$DB_OLD_NAME" "$DB_NEW_NAME" "$DB_OLD_USER" "$DB_NEW_USER" "$DB_OLD_APP_ROLE" "$DB_NEW_APP_ROLE"; do
    [[ "$n" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || die "contract: '$n' is not a plain lowercase SQL identifier"
  done
}

# ------------------------------------------------------------------ launchd
loaded_with_prefix() {  # prints "<label> <pid|->" for every loaded job with prefix
  launchctl list 2>/dev/null | awk -v p="$1." 'NR>1 && index($3,p)==1 {print $3, $1}'
}
agent_pid() {
  launchctl print "gui/$UIDN/$1" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/{print $NF; exit}'
}
is_loaded() { launchctl print "gui/$UIDN/$1" >/dev/null 2>&1; }
svc_of() { echo "${1#"$2".}"; }
ordered() {  # ordered <svc...>: START_ORDER first, then the rest by name
  local s o out=""
  for o in $START_ORDER; do for s in "$@"; do [[ "$s" == "$o" ]] && out="$out $s"; done; done
  for s in $(printf '%s\n' "$@" | sort); do case " $START_ORDER " in *" $s "*) ;; *) out="$out $s";; esac; done
  echo "$out"
}
bootout_wait() {
  local label="$1" i
  is_loaded "$label" || return 0
  launchctl bootout "gui/$UIDN/$label" 2>/dev/null
  for i in $(seq 1 30); do is_loaded "$label" || return 0; sleep 1; done
  return 1
}
bootstrap_retry() {  # known failure mode: bootstrap errors and leaves the job down
  local plist="$1" label="$2"
  launchctl bootstrap "gui/$UIDN" "$plist" 2>/dev/null && return 0
  sleep 2
  is_loaded "$label" || launchctl bootstrap "gui/$UIDN" "$plist" 2>/dev/null
  is_loaded "$label" && launchctl kickstart -k "gui/$UIDN/$label" 2>/dev/null
  is_loaded "$label"
}

# ------------------------------------------------------------------ postgres (via the compose container)
pg() {  # pg USER DB  < sql      (local socket inside the container)
  docker exec -i "$DB_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U "$1" -d "$2"
}
pg1() { printf '%s\n' "$3" | pg "$1" "$2"; }
sql_lit() { local s="${1//\'/\'\'}"; printf "'%s'" "$s"; }
role_exists() { [[ "$(pg1 "$1" postgres "select 1 from pg_roles where rolname=$(sql_lit "$2")" 2>/dev/null)" == 1 ]]; }
db_exists() { [[ "$(pg1 "$1" postgres "select 1 from pg_database where datname=$(sql_lit "$2")" 2>/dev/null)" == 1 ]]; }
admin_user() {  # whichever of old/new main user currently exists
  if role_exists "$DB_OLD_USER" "$DB_OLD_USER" 2>/dev/null; then echo "$DB_OLD_USER"; else echo "$DB_NEW_USER"; fi
}
tcp_login() {  # tcp_login USER DB  (password on stdin) — proves password auth over TCP
  docker exec -i "$DB_CONTAINER" sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; psql -X -At -h 127.0.0.1 -U "$1" -d "$2" -c "select current_user"' _ "$1" "$2"
}
DB_SHA_CACHE=""  # "name sha" — the backup computes it once, the snapshot reuses it
db_plain_sha() {  # schema+data checksum; \restrict lines carry a random per-run key
  [[ -n "$DB_SHA_CACHE" && "${DB_SHA_CACHE%% *}" == "$2" ]] && { echo "${DB_SHA_CACHE#* }"; return; }
  docker exec "$DB_CONTAINER" pg_dump -U "$1" -Fp "$2" 2>/dev/null | grep -vE '^\\(un)?restrict ' | shasum -a 256 | awk '{print $1}'
}
db_renaming() { [[ "$DB_OLD_NAME" != "$DB_NEW_NAME" || "$DB_OLD_USER" != "$DB_NEW_USER" || "$DB_OLD_APP_ROLE" != "$DB_NEW_APP_ROLE" ]]; }

# ------------------------------------------------------------------ files
tree_manifest() {  # mode sha path for every entry under $1 (relative paths)
  local root="$1"
  [[ -e "$root" ]] || { echo "absent $root"; return; }
  ( cd "$root" && find . -mindepth 1 | sort | while IFS= read -r p; do
      if [[ -L "$p" ]]; then printf 'link %s -> %s\n' "$p" "$(readlink "$p")"
      elif [[ -d "$p" ]]; then printf '%s dir %s\n' "$(stat -f %Sp "$p")" "$p"
      else printf '%s %s %s\n' "$(stat -f %Sp "$p")" "$(shasum -a 256 "$p" | awk '{print $1}')" "$p"; fi
    done )
}
same_volume() { [[ "$(stat -f %d "$1")" == "$(stat -f %d "$2")" ]]; }
env_files() { local d="$1"; [[ -d "$d" ]] && find "$d" -maxdepth 1 -type f -name '*.env' | sort; }
fail_injection() { [[ -n "$FAIL_AT" && "$FAIL_AT" == "$1" ]] && { bad "injected failure after step '$1' (PAL_CUTOVER_FAIL_AT)"; return 1; }; return 0; }

side_vars() {  # side_vars old|new — sets S_PREFIX S_STATE S_LOGS S_ENV
  if [[ "$1" == old ]]; then
    S_PREFIX="$OLD_LABEL_PREFIX"; S_STATE="$OLD_STATE_DIR"; S_LOGS="$OLD_LOG_DIR"; S_ENV="$OLD_ENV_PREFIX"
  else
    S_PREFIX="$NEW_LABEL_PREFIX"; S_STATE="$NEW_STATE_DIR"; S_LOGS="$NEW_LOG_DIR"; S_ENV="$NEW_ENV_PREFIX"
  fi
}
side_key() { echo "${S_ENV}${1#"$NEW_ENV_PREFIX"}"; }  # map a contract (new) key name to the side's prefix

# ================================================================== snapshot
snapshot() {  # snapshot OUT [old|new] — everything rollback promises to restore, as checksums
  local out="$1" side="${2:-old}" u db f
  side_vars "$side"
  {
    echo "## state $S_STATE"
    if [[ -L "$S_STATE" ]]; then echo "symlink -> $(readlink "$S_STATE")"; else tree_manifest "$S_STATE"; fi
    echo "## launchagents"
    for f in "$LA_DIR/$OLD_LABEL_PREFIX".* "$LA_DIR/$NEW_LABEL_PREFIX".*; do
      [[ -e "$f" ]] && printf '%s %s %s\n' "$(stat -f %Sp "$f")" "$(shasum -a 256 "$f" | awk '{print $1}')" "$(basename "$f")"
    done
    echo "## launchd loaded"
    { loaded_with_prefix "$OLD_LABEL_PREFIX"; loaded_with_prefix "$NEW_LABEL_PREFIX"; } | awk '{print $1}' | sort
    echo "## repo state"
    for f in $REPO_STATE_PATHS; do echo "# $f"; tree_manifest "$REPO_DIR/$f"; done
    echo "## git"
    git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null
    git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null
    git -C "$REPO_DIR" remote get-url origin 2>/dev/null
    git -C "$REPO_DIR" diff HEAD 2>/dev/null | shasum -a 256 | awk '{print "worktree-diff", $1}'
    echo "## db"
    u="$(admin_user)"
    for f in "$DB_OLD_USER" "$DB_OLD_APP_ROLE" "$DB_NEW_USER" "$DB_NEW_APP_ROLE"; do
      echo "role $f $(pg1 "$u" postgres "select coalesce(md5(rolpassword),'nopw')||' super='||rolsuper from pg_authid where rolname=$(sql_lit "$f")" 2>/dev/null || echo '?')"
    done
    for db in "$DB_OLD_NAME" "$DB_NEW_NAME"; do
      if db_exists "$u" "$db"; then echo "db $db owner=$(pg1 "$u" postgres "select pg_get_userbyid(datdba) from pg_database where datname=$(sql_lit "$db")") sha=$(db_plain_sha "$u" "$db")"; else echo "db $db absent"; fi
    done
  } > "$out"
}

# ================================================================== preflight
PRE_LOADED=""   # "label pid" lines of the old side at preflight time
preflight() {
  hdr "preflight"
  local t f s
  for t in python3 git docker launchctl tar shasum curl lsof; do
    command -v "$t" >/dev/null 2>&1 && ok "tool $t" || bad "missing tool: $t"
  done

  # --- state dir
  if [[ -L "$OLD_STATE_DIR" ]]; then bad "$OLD_STATE_DIR is already a symlink (cutover done? -> $(readlink "$OLD_STATE_DIR"))"
  elif [[ ! -d "$OLD_STATE_DIR" ]]; then bad "$OLD_STATE_DIR does not exist"
  else ok "state dir $OLD_STATE_DIR ($(find "$OLD_STATE_DIR" | wc -l | tr -d ' ') entries, $(du -sh "$OLD_STATE_DIR" | awk '{print $1}'))"; fi
  if [[ -e "$NEW_STATE_DIR" || -L "$NEW_STATE_DIR" ]]; then bad "$NEW_STATE_DIR already exists — refusing to merge into it"
  else ok "$NEW_STATE_DIR is free"; fi
  if [[ -d "$OLD_STATE_DIR" ]]; then
    same_volume "$OLD_STATE_DIR" "$(dirname "$NEW_STATE_DIR")" && ok "same volume: mv is a single atomic rename(2)" \
      || bad "$OLD_STATE_DIR and $(dirname "$NEW_STATE_DIR") are on different volumes (mv would copy, not rename)"
  fi

  # --- env files (key names only)
  for f in $(env_files "$OLD_STATE_DIR"); do
    s="$(helper env-rename "$f" "$OLD_ENV_PREFIX" "$NEW_ENV_PREFIX" --dry)"
    case $? in
      0) ok "env $(basename "$f"): $(printf '%s' "$s" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(len(d["renamed"]),"keys to rename,",len(d["dropped_duplicates"]),"duplicates")')"
         printf '%s' "$s" | python3 -I -c 'import json,sys;d=json.load(sys.stdin)
for k in d["values_referencing_old_prefix"]: print("VALREF",k)
for k in d["values_with_old_state_path"]: print("PATHREF",k)' | while read -r kind k; do
           if [[ "$kind" == VALREF ]]; then warn "$(basename "$f"): value of $k expands a ${OLD_ENV_PREFIX}* variable (left as-is)"
           else warn "$(basename "$f"): value of $k contains a ~/.lantern path (works via the compat symlink; update it by hand to drop the symlink)"; fi
         done ;;
      3) bad "env $(basename "$f"): old and new key both set with DIFFERENT values: $(printf '%s' "$s" | python3 -I -c 'import json,sys;print(" ".join(json.load(sys.stdin)["conflicts"]))')" ;;
      *) bad "env $(basename "$f"): could not parse" ;;
    esac
  done

  # --- launchd
  PRE_LOADED="$(loaded_with_prefix "$OLD_LABEL_PREFIX")"
  if [[ -z "$PRE_LOADED" ]]; then bad "no $OLD_LABEL_PREFIX.* jobs loaded — nothing to cut over (already done?)"
  else ok "loaded $OLD_LABEL_PREFIX.* jobs: $(echo "$PRE_LOADED" | awk '{print $1}' | sed "s/^$OLD_LABEL_PREFIX\.//" | tr '\n' ' ')"; fi
  for f in "$LA_DIR/$NEW_LABEL_PREFIX".*; do [[ -e "$f" ]] && bad "already installed: $f"; done
  for f in "$LA_DIR/$OLD_LABEL_PREFIX".*; do
    case "$f" in *.plist) ;; *) [[ -e "$f" ]] && warn "stray file $(basename "$f") will be retired into the backup";; esac
  done

  # --- database
  if [[ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null)" != true ]]; then
    bad "postgres container $DB_CONTAINER is not running"
  elif ! role_exists "$DB_OLD_USER" "$DB_OLD_USER"; then bad "cannot connect as $DB_OLD_USER (or role missing)"
  else
    ok "postgres reachable as $DB_OLD_USER ($(pg1 "$DB_OLD_USER" postgres 'show password_encryption'))"
    db_exists "$DB_OLD_USER" "$DB_OLD_NAME" && ok "database $DB_OLD_NAME ($(pg1 "$DB_OLD_USER" postgres "select pg_size_pretty(pg_database_size($(sql_lit "$DB_OLD_NAME")))"))" || bad "database $DB_OLD_NAME missing"
    if db_renaming; then
      [[ "$DB_OLD_NAME" != "$DB_NEW_NAME" ]] && { db_exists "$DB_OLD_USER" "$DB_NEW_NAME" && bad "database $DB_NEW_NAME already exists" || ok "database name $DB_NEW_NAME free"; }
      for t in "$DB_OLD_USER:$DB_NEW_USER" "$DB_OLD_APP_ROLE:$DB_NEW_APP_ROLE"; do
        [[ "${t%%:*}" == "${t##*:}" ]] && continue
        role_exists "$DB_OLD_USER" "${t%%:*}" && ok "role ${t%%:*} present" || bad "role ${t%%:*} missing"
        role_exists "$DB_OLD_USER" "${t##*:}" && bad "role ${t##*:} already exists" || ok "role name ${t##*:} free"
      done
      role_exists "$DB_OLD_USER" "$TMP_ROLE" && bad "leftover temp role $TMP_ROLE exists (from an aborted run?)"
    else ok "contract keeps DB/user/role names — DB step is a no-op"; fi
  fi

  # --- checkout
  if ! git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then bad "$REPO_DIR is not a git checkout"; return; fi
  if [[ "$DRY" == 0 ]]; then
    git -C "$REPO_DIR" fetch -q "$REPO_REMOTE_URL" "+refs/heads/$RELEASE_BRANCH:refs/remotes/origin/$RELEASE_BRANCH" 2>/dev/null \
      && ok "fetched $RELEASE_BRANCH from $REPO_REMOTE_URL" || bad "git fetch from $REPO_REMOTE_URL failed"
  else
    log "  (plan does not fetch; release ref resolved from the last fetch)"
  fi
  REL_SHA="$(git -C "$REPO_DIR" rev-parse --verify -q "$RELEASE_REF^{commit}")" || { bad "release ref $RELEASE_REF does not resolve"; return; }
  ok "release $RELEASE_REF = $(git -C "$REPO_DIR" log -1 --format='%h %s' "$REL_SHA" | cut -c1-90)"
  local head br dirty
  head="$(git -C "$REPO_DIR" rev-parse HEAD)"; br="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
  ok "checkout at $br $(git -C "$REPO_DIR" log -1 --format='%h' HEAD) ($(git -C "$REPO_DIR" rev-list --count "HEAD..$REL_SHA") commits behind release)"
  dirty="$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)"
  if [[ -n "$dirty" ]]; then
    if [[ "$STASH" == 1 ]]; then warn "tracked changes will be stashed (PAL_CUTOVER_STASH=1): $(echo "$dirty" | awk '{print $2}' | tr '\n' ' ')"
    else bad "tracked local changes (bridges run straight from src/, so these may be LIVE): $(echo "$dirty" | awk '{print $2}' | tr '\n' ' ') — commit them, or rerun with PAL_CUTOVER_STASH=1"; fi
  fi
  local tip; tip="$(git -C "$REPO_DIR" rev-parse -q --verify "refs/heads/$RELEASE_BRANCH")"
  if [[ -n "$tip" ]] && ! git -C "$REPO_DIR" merge-base --is-ancestor "$tip" "$REL_SHA"; then
    bad "local $RELEASE_BRANCH has commits not in the release (cannot fast-forward)"
  fi
  [[ "$head" == "$REL_SHA" ]] && warn "checkout is already at the release commit"

  # --- does the release actually expect the contract's names?
  readiness
  [[ -d "$WA_CREDS_OLD" ]] && ok "WhatsApp creds at $WA_CREDS_OLD ($(find "$WA_CREDS_OLD" -type f | wc -l | tr -d ' ') files)" || warn "no WhatsApp creds at $WA_CREDS_OLD (QR pairing will be needed)"
  if [[ "$WA_CREDS_OLD" != "$WA_CREDS_NEW" && -e "$WA_CREDS_NEW" ]]; then bad "WhatsApp creds target $WA_CREDS_NEW already exists"; fi
  for f in $REPO_STATE_PATHS; do [[ -e "$REPO_DIR/$f" ]] || warn "repo state path missing: $f"; done
}

readiness() {
  hdr "release readiness ($RELEASE_REF)"
  local svc t g
  for svc in $(echo "$PRE_LOADED" | awk '{print $1}' | sed "s/^$OLD_LABEL_PREFIX\.//"); do
    if git -C "$REPO_DIR" cat-file -e "$REL_SHA:$TEMPLATE_DIR/$NEW_LABEL_PREFIX.$svc.plist" 2>/dev/null; then ok "template $NEW_LABEL_PREFIX.$svc.plist"
    elif git -C "$REPO_DIR" cat-file -e "$REL_SHA:$TEMPLATE_DIR/$OLD_LABEL_PREFIX.$svc.plist" 2>/dev/null; then warn "release still ships $OLD_LABEL_PREFIX.$svc.plist only — new plist derived from it (label/env renamed)"
    else log "  .     $svc has no repo template — the live plist is converted in place"; fi
  done
  if git -C "$REPO_DIR" cat-file -e "$REL_SHA:packages/bridge-core/src/state-dir.ts" 2>/dev/null; then
    git -C "$REPO_DIR" show "$REL_SHA:packages/bridge-core/src/state-dir.ts" | grep -q "\"$(basename "$NEW_STATE_DIR")\"" \
      && ok "bridge-core state-dir knows $(basename "$NEW_STATE_DIR")" || bad "release bridge-core/state-dir.ts never mentions \"$(basename "$NEW_STATE_DIR")\""
  fi
  g="$(git -C "$REPO_DIR" grep -l "${NEW_ENV_PREFIX}BRIDGE_TOKEN" "$REL_SHA" -- services/whatsapp-bridge/src 2>/dev/null | head -1)"
  [[ -n "$g" ]] && ok "bridges read ${NEW_ENV_PREFIX}* keys" || bad "release WhatsApp bridge never reads ${NEW_ENV_PREFIX}BRIDGE_TOKEN"
  if db_renaming; then
    t="$(git -C "$REPO_DIR" grep -n "\"$DB_OLD_APP_ROLE\"" "$REL_SHA" -- 'services/*.go' ':(exclude)*_test.go' 2>/dev/null | head -3)"
    [[ -z "$t" ]] && ok "no Go code hardcodes role \"$DB_OLD_APP_ROLE\"" || bad "release Go code still hardcodes \"$DB_OLD_APP_ROLE\" (AppPool would fail after the role rename): $(echo "$t" | cut -d: -f2-3 | tr '\n' ' ')"
  fi
  # compose: a renamed project/volume would boot an EMPTY postgres on the next infra start
  local a b
  a="$(git -C "$REPO_DIR" show "HEAD:$COMPOSE_FILE" 2>/dev/null | awk '/^name:/{print} /^volumes:/{v=1;next} v&&/^[^ ]/{v=0} v&&/^  [a-z]/{print}' | sort)"
  b="$(git -C "$REPO_DIR" show "$REL_SHA:$COMPOSE_FILE" 2>/dev/null | awk '/^name:/{print} /^volumes:/{v=1;next} v&&/^[^ ]/{v=0} v&&/^  [a-z]/{print}' | sort)"
  [[ "$a" == "$b" ]] && ok "compose project/volume names unchanged" || bad "compose project or volume names change in the release — infra would start an empty database"
  t="$(git -C "$REPO_DIR" grep -l "$OLD_LABEL_PREFIX\." "$REL_SHA" -- scripts 2>/dev/null | sed "s/^$REL_SHA://" | tr '\n' ' ')"
  [[ -z "$t" ]] && ok "release scripts reference no $OLD_LABEL_PREFIX.* labels" || warn "release scripts still name $OLD_LABEL_PREFIX.* labels: $t"
}

# ================================================================== render (new plists into the backup work dir)
render_template() {  # render_template SVC OUT → 0 template rendered, 1 none
  local svc="$1" out="$2" src="" node
  if git -C "$REPO_DIR" cat-file -e "$REL_SHA:$TEMPLATE_DIR/$NEW_LABEL_PREFIX.$svc.plist" 2>/dev/null; then src="$TEMPLATE_DIR/$NEW_LABEL_PREFIX.$svc.plist"
  elif git -C "$REPO_DIR" cat-file -e "$REL_SHA:$TEMPLATE_DIR/$OLD_LABEL_PREFIX.$svc.plist" 2>/dev/null; then src="$TEMPLATE_DIR/$OLD_LABEL_PREFIX.$svc.plist"
  else return 1; fi
  node="$(command -v node || echo /usr/local/bin/node)"
  git -C "$REPO_DIR" show "$REL_SHA:$src" | sed \
    -e "s|__NODE__|$node|g" -e "s|__REPO_ROOT__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" -e "s|__UID__|$UIDN|g" \
    -e "s|$OLD_LOG_DIR|$NEW_LOG_DIR|g" > "$out"
  chmod 600 "$out"
}

render() {
  hdr "render new plists"
  mkdir -p "$WORK/templates" "$WORK/plists"
  local f svc label tmpl summary args
  for f in "$LA_DIR/$OLD_LABEL_PREFIX".*.plist; do
    [[ -e "$f" ]] || continue
    label="$(helper plist-get "$f" Label)"
    [[ "$label" == "$OLD_LABEL_PREFIX".* ]] || { warn "$(basename "$f") has label '$label' — skipped"; continue; }
    svc="$(svc_of "$label" "$OLD_LABEL_PREFIX")"
    args=(plist-convert --old "$f" --out "$WORK/plists/$NEW_LABEL_PREFIX.$svc.plist" --label "$NEW_LABEL_PREFIX.$svc"
          --old-env "$OLD_ENV_PREFIX" --new-env "$NEW_ENV_PREFIX" --template-wins "$TEMPLATE_WINS_KEYS"
          --map "$OLD_LOG_DIR=$NEW_LOG_DIR" --map "$OLD_STATE_DIR=$NEW_STATE_DIR" --map "$OLD_LABEL_PREFIX.=$NEW_LABEL_PREFIX.")
    tmpl="$WORK/templates/$svc.plist"
    render_template "$svc" "$tmpl" && args+=(--template "$tmpl")
    summary="$(helper "${args[@]}")" || { bad "could not render $label"; continue; }
    printf '%s' "$summary" | python3 -I -c 'import json,sys; d=json.load(sys.stdin)
print("  .     %-34s from %-14s env renamed[%s] carried-from-live[%s] template-wins[%s] live-override-kept[%s]" % (d["label"], d["source"], " ".join(d["env_keys_renamed"]), " ".join(d["env_keys_carried_from_live"]), " ".join(d["env_keys_where_template_wins"]), " ".join(d["env_keys_live_override_kept"])))'
  done
  [[ -n "$(ls "$WORK/plists" 2>/dev/null)" ]] || bad "rendered nothing"
  local url
  if db_renaming; then
    for f in "$WORK/plists"/*.plist; do
      url="$(helper plist-get "$f" env:DATABASE_URL)"
      [[ -n "$url" ]] || continue
      if [[ "$(helper url-part "$url" user)" == "$DB_NEW_USER" && "$(helper url-part "$url" db)" == "$DB_NEW_NAME" ]]; then
        ok "$(basename "$f") DATABASE_URL names $DB_NEW_USER@$DB_NEW_NAME"
      else
        bad "$(basename "$f") DATABASE_URL does not name $DB_NEW_USER@$DB_NEW_NAME (release template not updated?)"
      fi
    done
  fi
}

# ================================================================== steps
step_stop() {
  hdr "stop $OLD_LABEL_PREFIX.* agents"
  local svcs="" l s first rest
  for l in $(echo "$PRE_LOADED" | awk '{print $1}'); do svcs="$svcs $(svc_of "$l" "$OLD_LABEL_PREFIX")"; done
  first=""; rest=""
  for s in $svcs; do case " $STOP_FIRST " in *" $s "*) first="$first $s";; *) rest="$rest $s";; esac; done
  for s in $first $rest; do
    if [[ "$DRY" == 1 ]]; then would "launchctl bootout gui/$UIDN/$OLD_LABEL_PREFIX.$s"; continue; fi
    bootout_wait "$OLD_LABEL_PREFIX.$s" && ok "stopped $s" || { bad "$s still loaded after bootout"; return 1; }
  done
  [[ "$DRY" == 1 ]] && { would "verify nothing holds files open under $OLD_STATE_DIR and the repo state paths (lsof)"; return 0; }
  local holders p
  for p in "$OLD_STATE_DIR" $REPO_STATE_PATHS; do
    [[ "$p" == /* ]] || p="$REPO_DIR/$p"
    [[ -e "$p" ]] || continue
    holders="$(lsof -t +D "$p" 2>/dev/null | sort -u)"
    if [[ -n "$holders" ]]; then
      bad "still open under $p by: $(for h in $holders; do ps -o comm= -p "$h"; done | sort -u | tr '\n' ' ')"
      return 1
    fi
  done
  ok "nothing holds files open under the state paths"
}

step_backup() {
  hdr "backup → $BK"
  local name p n1 n2 paths
  if [[ "$DRY" == 1 ]]; then
    would "mkdir -m 700 $BACKUP_ROOT/pal-cutover-backup-<ts>/ (files 0600)"
    would "tar $OLD_STATE_DIR → state.tgz; $LA_DIR/{$OLD_LABEL_PREFIX,$NEW_LABEL_PREFIX}.* → plists.tgz; $REPO_STATE_PATHS → repo-state.tgz"
    would "pg_dump -Fc $DB_OLD_NAME → db.dump (+ plain-dump checksum, role password verifiers → roles.tsv)"
    would "record git HEAD/branch/remote + worktree.patch; snapshot → pre.snapshot; SHA256SUMS; verify every archive"
    return 0
  fi
  umask 077
  mkdir -p "$BK" && chmod 700 "$BK"
  tar -C "$(dirname "$OLD_STATE_DIR")" -czf "$BK/state.tgz" "$(basename "$OLD_STATE_DIR")" || { bad "tar state"; return 1; }
  ( cd "$LA_DIR" && ls -d "$OLD_LABEL_PREFIX".* "$NEW_LABEL_PREFIX".* 2>/dev/null ) > "$BK/plists.list"
  tar -C "$LA_DIR" -czf "$BK/plists.tgz" -T "$BK/plists.list" || { bad "tar plists"; return 1; }
  paths=""; for p in $REPO_STATE_PATHS; do [[ -e "$REPO_DIR/$p" ]] && paths="$paths $p"; done
  # shellcheck disable=SC2086  # word-split on purpose: relative path list
  tar -C "$REPO_DIR" -czf "$BK/repo-state.tgz" $paths || { bad "tar repo state"; return 1; }
  docker exec "$DB_CONTAINER" pg_dump -U "$DB_OLD_USER" -Fc "$DB_OLD_NAME" > "$BK/db.dump" || { bad "pg_dump"; return 1; }
  db_plain_sha "$DB_OLD_USER" "$DB_OLD_NAME" > "$BK/db.plain.sha256"
  DB_SHA_CACHE="$DB_OLD_NAME $(cat "$BK/db.plain.sha256")"
  pg1 "$DB_OLD_USER" postgres "select rolname||chr(9)||coalesce(rolpassword,'') from pg_authid where rolname in ($(sql_lit "$DB_OLD_USER"),$(sql_lit "$DB_OLD_APP_ROLE"))" > "$BK/roles.tsv"
  {
    echo "OLD_HEAD=$(git -C "$REPO_DIR" rev-parse HEAD)"
    echo "OLD_BRANCH=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
    echo "OLD_REMOTE=$(git -C "$REPO_DIR" remote get-url origin)"
    echo "REL_SHA=$REL_SHA"
  } > "$BK/git.env"
  git -C "$REPO_DIR" diff HEAD > "$BK/worktree.patch"
  git -C "$REPO_DIR" status --porcelain > "$BK/git-status.txt"
  cp "$CONTRACT" "$BK/contract.env"
  snapshot "$BK/pre.snapshot" old
  DB_SHA_CACHE=""
  # integrity: every archive lists, its entry count matches the source, the dump is readable
  for name in state plists repo-state; do
    tar -tzf "$BK/$name.tgz" > "$BK/$name.entries" || { bad "$name.tgz is unreadable"; return 1; }
  done
  n1="$(find "$OLD_STATE_DIR" | wc -l | tr -d ' ')"; n2="$(grep -vc '^$' "$BK/state.entries")"
  [[ "$n1" == "$n2" ]] || { bad "state.tgz has $n2 entries, source has $n1"; return 1; }
  docker exec -i "$DB_CONTAINER" pg_restore -l < "$BK/db.dump" > "$BK/db.toc" || { bad "db.dump is not a readable archive"; return 1; }
  ( cd "$BK" && shasum -a 256 state.tgz plists.tgz repo-state.tgz db.dump roles.tsv > SHA256SUMS && shasum -a 256 -c -s SHA256SUMS ) || { bad "checksum verify"; return 1; }
  find "$BK" -maxdepth 1 -type f -exec chmod 600 {} +
  ok "state.tgz $n2 entries, plists $(wc -l < "$BK/plists.list" | tr -d ' '), dump $(du -h "$BK/db.dump" | awk '{print $1}') ($(grep -c 'TABLE DATA' "$BK/db.toc") tables), checksums verified"
}

step_state_move() {
  hdr "move $OLD_STATE_DIR → $NEW_STATE_DIR"
  if [[ "$DRY" == 1 ]]; then
    would "mv $OLD_STATE_DIR $NEW_STATE_DIR   (rename(2), same volume)"
    [[ "$STATE_COMPAT_SYMLINK" == 1 ]] && would "ln -s $NEW_STATE_DIR $OLD_STATE_DIR   (compat for anything still hardcoding the old path)"
    [[ "$WA_CREDS_OLD" != "$WA_CREDS_NEW" ]] && would "mv $WA_CREDS_OLD $WA_CREDS_NEW (tree checksum verified)"
    return 0
  fi
  journal begin state-move
  mv "$OLD_STATE_DIR" "$NEW_STATE_DIR" || { bad "mv failed"; return 1; }
  [[ -d "$NEW_STATE_DIR" && ! -e "$OLD_STATE_DIR" ]] || { bad "post-move check"; return 1; }
  if [[ "$STATE_COMPAT_SYMLINK" == 1 ]]; then ln -s "$NEW_STATE_DIR" "$OLD_STATE_DIR" || { bad "symlink"; return 1; }; fi
  ok "moved ($(find "$NEW_STATE_DIR" | wc -l | tr -d ' ') entries)$([[ "$STATE_COMPAT_SYMLINK" == 1 ]] && echo ", compat symlink in place")"
  if [[ "$WA_CREDS_OLD" != "$WA_CREDS_NEW" && -d "$WA_CREDS_OLD" ]]; then
    local before after
    before="$(tree_manifest "$WA_CREDS_OLD" | shasum -a 256)"
    mkdir -p "$(dirname "$WA_CREDS_NEW")" && mv "$WA_CREDS_OLD" "$WA_CREDS_NEW" || { bad "move WhatsApp creds"; return 1; }
    journal end wa-creds-move
    after="$(tree_manifest "$WA_CREDS_NEW" | shasum -a 256)"
    [[ "$before" == "$after" ]] && ok "WhatsApp creds moved intact" || { bad "WhatsApp creds checksum changed in the move"; return 1; }
  fi
  journal end state-move
}

step_env() {
  hdr "rewrite env keys $OLD_ENV_PREFIX* → $NEW_ENV_PREFIX* in $NEW_STATE_DIR/*.env"
  local f s dir="$NEW_STATE_DIR"
  [[ "$DRY" == 1 ]] && dir="$OLD_STATE_DIR"
  for f in $(env_files "$dir"); do
    if [[ "$DRY" == 1 ]]; then
      would "rewrite $(basename "$f") (0600): $(helper env-rename "$f" "$OLD_ENV_PREFIX" "$NEW_ENV_PREFIX" --dry | python3 -I -c 'import json,sys;print(" ".join(json.load(sys.stdin)["renamed"]))')"
      continue
    fi
    journal begin "env:$(basename "$f")"
    s="$(helper env-rename "$f" "$OLD_ENV_PREFIX" "$NEW_ENV_PREFIX")" || { bad "env rewrite $(basename "$f")"; return 1; }
    ok "$(basename "$f"): renamed $(printf '%s' "$s" | python3 -I -c 'import json,sys;print(len(json.load(sys.stdin)["renamed"]))') keys, mode $(stat -f %Sp "$f")"
  done
}

new_db_password() {  # from the rendered plist's DATABASE_URL; never printed
  local p="$WORK/plists/$NEW_LABEL_PREFIX.$DB_URL_AGENT.plist" url
  [[ -f "$p" ]] || return 1
  url="$(helper plist-get "$p" env:DATABASE_URL)"
  [[ -n "$url" ]] || return 1
  [[ "$(helper url-part "$url" user)" == "$DB_NEW_USER" && "$(helper url-part "$url" db)" == "$DB_NEW_NAME" ]] || return 2
  helper url-part "$url" password
}

app_password() {  # from the (rewritten) env files
  local f v=""
  for f in $(env_files "$NEW_STATE_DIR"); do
    helper env-keys "$f" | grep -qx "$DB_APP_PASSWORD_KEY" && v="$(helper env-get "$f" "$DB_APP_PASSWORD_KEY")"
  done
  printf '%s' "$v"
}

step_db() {
  hdr "database: $DB_OLD_NAME/$DB_OLD_USER/$DB_OLD_APP_ROLE → $DB_NEW_NAME/$DB_NEW_USER/$DB_NEW_APP_ROLE"
  if ! db_renaming; then ok "names unchanged — skipped"; return 0; fi
  local admin="$DB_OLD_USER" pw rc i
  pw="$(new_db_password)"; rc=$?
  if [[ $rc == 2 ]]; then bad "rendered $DB_URL_AGENT plist DATABASE_URL does not name $DB_NEW_USER@$DB_NEW_NAME"; return 1; fi
  if [[ "$DRY" == 1 ]]; then
    [[ "$DB_OLD_USER" != "$DB_NEW_USER" ]] && would "CREATE ROLE $TMP_ROLE SUPERUSER (a session cannot rename its own user)"
    would "terminate remaining sessions on $DB_OLD_NAME; ALTER DATABASE $DB_OLD_NAME RENAME TO $DB_NEW_NAME"
    would "ALTER ROLE $DB_OLD_USER RENAME TO $DB_NEW_USER; ALTER ROLE $DB_OLD_APP_ROLE RENAME TO $DB_NEW_APP_ROLE"
    would "set $DB_NEW_USER password from the new $DB_URL_AGENT DATABASE_URL$([[ -z "$pw" ]] && echo ' (NONE FOUND — verifier kept)'); set $DB_NEW_APP_ROLE password from $DB_APP_PASSWORD_KEY if present"
    would "DROP ROLE $TMP_ROLE; prove TCP password login as $DB_NEW_USER@$DB_NEW_NAME"
    return 0
  fi
  journal begin db
  if [[ "$DB_OLD_USER" != "$DB_NEW_USER" ]]; then
    pg1 "$DB_OLD_USER" postgres "CREATE ROLE $TMP_ROLE SUPERUSER LOGIN" || { bad "create temp role"; return 1; }
    admin="$TMP_ROLE"
  fi
  if [[ "$DB_OLD_NAME" != "$DB_NEW_NAME" ]]; then
    for i in 1 2 3 4 5; do
      if pg "$admin" postgres <<SQL >/dev/null 2>&1
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_OLD_NAME' AND pid <> pg_backend_pid();
ALTER DATABASE $DB_OLD_NAME RENAME TO $DB_NEW_NAME;
SQL
      then break; fi
      [[ $i == 5 ]] && { bad "could not rename database (sessions keep reconnecting?)"; return 1; }
      sleep 1
    done
    journal end db-rename
    ok "database renamed"
  fi
  if [[ "$DB_OLD_APP_ROLE" != "$DB_NEW_APP_ROLE" ]]; then
    pg1 "$admin" postgres "ALTER ROLE $DB_OLD_APP_ROLE RENAME TO $DB_NEW_APP_ROLE" >/dev/null 2>&1 || { bad "rename app role"; return 1; }
    journal end app-role-rename
    ok "role $DB_OLD_APP_ROLE → $DB_NEW_APP_ROLE"
  fi
  if [[ "$DB_OLD_USER" != "$DB_NEW_USER" ]]; then
    pg1 "$admin" postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='$DB_OLD_USER' AND pid <> pg_backend_pid()" >/dev/null
    pg1 "$admin" postgres "ALTER ROLE $DB_OLD_USER RENAME TO $DB_NEW_USER" >/dev/null 2>&1 || { bad "rename main user (NOTICE: an MD5 verifier is cleared by a rename)"; return 1; }
    journal end user-rename
    ok "role $DB_OLD_USER → $DB_NEW_USER"
  fi
  if [[ -n "$pw" ]]; then
    printf 'ALTER ROLE %s PASSWORD %s;\n' "$DB_NEW_USER" "$(sql_lit "$pw")" | pg "$admin" postgres >/dev/null || { bad "set $DB_NEW_USER password"; return 1; }
    ok "$DB_NEW_USER password set from the new DATABASE_URL"
  else warn "no password in the new DATABASE_URL — kept the existing verifier"; fi
  local apw; apw="$(app_password)"
  if [[ -n "$apw" ]]; then
    printf 'ALTER ROLE %s PASSWORD %s;\n' "$DB_NEW_APP_ROLE" "$(sql_lit "$apw")" | pg "$admin" postgres >/dev/null || { bad "set $DB_NEW_APP_ROLE password"; return 1; }
    printf '%s\n' "$apw" | tcp_login "$DB_NEW_APP_ROLE" "$DB_NEW_NAME" >/dev/null 2>&1 && ok "$DB_NEW_APP_ROLE password reset from $DB_APP_PASSWORD_KEY; TCP login ok" || { bad "$DB_NEW_APP_ROLE TCP login failed"; return 1; }
  else ok "$DB_APP_PASSWORD_KEY not set in env — $DB_NEW_APP_ROLE keeps its existing verifier"; fi
  if [[ "$admin" == "$TMP_ROLE" ]]; then
    pg1 "$DB_NEW_USER" postgres "DROP ROLE $TMP_ROLE" || { bad "drop temp role"; return 1; }
  fi
  if [[ -n "$pw" ]]; then
    [[ "$(printf '%s\n' "$pw" | tcp_login "$DB_NEW_USER" "$DB_NEW_NAME" 2>/dev/null)" == "$DB_NEW_USER" ]] \
      && ok "TCP password login as $DB_NEW_USER@$DB_NEW_NAME" || { bad "TCP login as $DB_NEW_USER@$DB_NEW_NAME failed"; return 1; }
  fi
  journal end db
}

step_plists() {
  hdr "install $NEW_LABEL_PREFIX.* plists, retire $OLD_LABEL_PREFIX.*"
  local f
  if [[ "$DRY" == 1 ]]; then
    for f in "$WORK/plists"/*.plist; do [[ -e "$f" ]] && would "install $LA_DIR/$(basename "$f") (0600)"; done
    for f in "$LA_DIR/$OLD_LABEL_PREFIX".*; do [[ -e "$f" ]] && would "retire $(basename "$f") → backup/retired-plists/"; done
    would "mkdir $NEW_LOG_DIR"
    return 0
  fi
  journal begin plists
  mkdir -p "$NEW_LOG_DIR" "$BK/retired-plists"
  for f in "$WORK/plists"/*.plist; do
    cp -p "$f" "$LA_DIR/$(basename "$f")" && chmod 600 "$LA_DIR/$(basename "$f")" || { bad "install $(basename "$f")"; return 1; }
    plutil -lint -s "$LA_DIR/$(basename "$f")" || { bad "$(basename "$f") fails plutil -lint"; return 1; }
  done
  for f in "$LA_DIR/$OLD_LABEL_PREFIX".*; do [[ -e "$f" ]] && mv "$f" "$BK/retired-plists/"; done
  ok "installed $(find "$WORK/plists" -name "*.plist" | wc -l | tr -d ' ') plists; old ones retired"
  journal end plists
}

step_git() {
  hdr "checkout → $RELEASE_BRANCH @ ${REL_SHA:0:9}"
  local cur
  cur="$(git -C "$REPO_DIR" remote get-url origin)"
  if [[ "$DRY" == 1 ]]; then
    [[ "$cur" != "$REPO_REMOTE_URL" ]] && would "git remote set-url origin $REPO_REMOTE_URL (was $cur)" || ok "origin already $REPO_REMOTE_URL"
    [[ "$STASH" == 1 ]] && would "git stash push (tracked changes) — reapplied by rollback"
    would "git checkout $RELEASE_BRANCH && git merge --ff-only ${REL_SHA:0:9}"
    return 0
  fi
  journal begin git
  [[ "$cur" != "$REPO_REMOTE_URL" ]] && { git -C "$REPO_DIR" remote set-url origin "$REPO_REMOTE_URL" || { bad "set-url"; return 1; }; }
  if [[ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]]; then
    git -C "$REPO_DIR" stash push -q -m "pal-cutover-$TS" || { bad "git stash"; return 1; }
    echo "STASH_SHA=$(git -C "$REPO_DIR" rev-parse 'stash@{0}')" >> "$BK/git.env"
    ok "stashed tracked changes"
  fi
  if git -C "$REPO_DIR" rev-parse -q --verify "refs/heads/$RELEASE_BRANCH" >/dev/null; then
    git -C "$REPO_DIR" checkout -q "$RELEASE_BRANCH" && git -C "$REPO_DIR" merge -q --ff-only "$REL_SHA" || { bad "checkout/fast-forward"; return 1; }
  else
    git -C "$REPO_DIR" checkout -q -b "$RELEASE_BRANCH" "$REL_SHA" || { bad "checkout"; return 1; }
  fi
  [[ "$(git -C "$REPO_DIR" rev-parse HEAD)" == "$REL_SHA" ]] && ok "HEAD = $(git -C "$REPO_DIR" log -1 --format='%h %s' | cut -c1-80)" || { bad "HEAD mismatch"; return 1; }
  journal end git
}

build_tree() {  # build_tree LABEL — what `make deploy-local` would rebuild, done up front so errors surface before start
  local d svc log="${BK:-/tmp}/build-$1.log"
  [[ "$DRY" == 1 ]] && {
    would "npm install in $BRIDGE_DIRS"
    would "cargo build --release in services/{${RUST_SERVICES// /,}}"
    would "go build control-plane, runtime-scheduler, workflow-engine (run_go also rebuilds on start)"
    would "dashboard: npm install && rm -rf .next && npm run build (the wrapper never rebuilds an existing bundle)"
    return 0; }
  : > "$log"
  for d in $BRIDGE_DIRS; do
    ( cd "$REPO_DIR/$d" && npm install --no-audit --no-fund ) >> "$log" 2>&1 || { bad "npm install $d (see $log)"; return 1; }
  done
  for svc in $RUST_SERVICES; do
    [[ -d "$REPO_DIR/services/$svc" ]] || continue
    ( cd "$REPO_DIR/services/$svc" && cargo build --release -q ) >> "$log" 2>&1 || { bad "cargo build $svc (see $log)"; return 1; }
  done
  for d in control-plane:./cmd/server:server runtime-scheduler:./cmd/scheduler:scheduler workflow-engine:./cmd/server:workflow-engine; do
    IFS=: read -r svc pkg bin <<< "$d"
    [[ -d "$REPO_DIR/services/$svc" ]] || continue
    ( cd "$REPO_DIR/services/$svc" && go build -o "bin/$bin" "$pkg" ) >> "$log" 2>&1 || { bad "go build $svc (see $log)"; return 1; }
  done
  ( cd "$REPO_DIR/$DASHBOARD_DIR" && npm install --no-audit --no-fund && rm -rf .next && npm run build ) >> "$log" 2>&1 || { bad "dashboard build (see $log)"; return 1; }
  ok "built bridges deps, ${RUST_SERVICES}, go services, dashboard (log: $log)"
}
step_build() { hdr "build"; build_tree "$1"; }

start_side() {  # start_side PREFIX — bootstrap every job that was loaded before, in order
  local prefix="$1" svcs="" l s plist
  for l in $(echo "$PRE_LOADED" | awk '{print $1}'); do svcs="$svcs $(svc_of "$l" "$OLD_LABEL_PREFIX")"; done
  # shellcheck disable=SC2086  # svcs is a space-separated word list by design
  for s in $(ordered $svcs); do
    plist="$LA_DIR/$prefix.$s.plist"
    if [[ "$DRY" == 1 ]]; then would "launchctl bootstrap gui/$UIDN $plist"; continue; fi
    [[ -f "$plist" ]] || { bad "missing $plist"; continue; }
    bootstrap_retry "$plist" "$prefix.$s" && ok "started $prefix.$s" || bad "could not start $prefix.$s"
  done
  [[ "$FAILED" == 0 ]]
}
step_start() { hdr "start $NEW_LABEL_PREFIX.* agents"; journal begin start; start_side "$NEW_LABEL_PREFIX"; }

# ================================================================== health
http() {  # http URL [header-line] [code|body] — secret header travels via curl -K on stdin
  local url="$1" hdrline="${2:-}" mode="${3:-code}" esc
  esc="${hdrline//\\/\\\\}"; esc="${esc//\"/\\\"}"
  if [[ "$mode" == code ]]; then
    { [[ -n "$hdrline" ]] && printf 'header = "%s"\n' "$esc"; } | curl -s -m 5 -L -o /dev/null -w '%{http_code}' -K - "$url" 2>/dev/null
  else
    { [[ -n "$hdrline" ]] && printf 'header = "%s"\n' "$esc"; } | curl -s -m 5 -K - "$url" 2>/dev/null
  fi
}
wait_http() {  # wait_http NAME URL [header]
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS )) c=""
  while [[ $(date +%s) -lt $deadline ]]; do
    c="$(http "$2" "${3:-}")"; [[ "$c" == 200 ]] && { ok "$1 → 200"; return 0; }
    sleep 3
  done
  bad "$1 → ${c:-no answer} after ${HEALTH_TIMEOUT_SECS}s"; return 1
}
json_field() { python3 -I -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit()
for k in sys.argv[1].split("."): d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else str(d).lower())' "$1"; }

health() {  # health old|new
  local side="$1" envf tok sig l pid prepid line f
  side_vars "$side"
  hdr "health ($side side: $S_PREFIX.*)"
  [[ "$DRY" == 1 ]] && { would "API /healthz, dashboard 200, bridge /health ×2, WhatsApp connected + creds, iMessage chat.db open, LIVENESS lines, signal endpoint"; return 0; }
  local f0=$FAILED
  # every job that had a pid before must have one again; one-shot jobs only need to be loaded
  while read -r l prepid; do
    [[ -n "$l" ]] || continue
    l="$S_PREFIX.$(svc_of "$l" "$OLD_LABEL_PREFIX")"
    if ! is_loaded "$l"; then bad "$l not loaded"; continue; fi
    if [[ "$prepid" =~ ^[0-9]+$ ]]; then
      pid=""; for _ in $(seq 1 20); do pid="$(agent_pid "$l")"; [[ -n "$pid" ]] && break; sleep 1; done
      [[ -n "$pid" ]] && ok "$l running (pid $pid)" || bad "$l loaded but not running"
    fi
  done <<< "$PRE_LOADED"
  wait_http "API $API_URL/healthz" "$API_URL/healthz"
  wait_http "dashboard $DASHBOARD_URL" "$DASHBOARD_URL"
  wait_http "WhatsApp bridge /health" "$WA_URL/health"
  wait_http "iMessage bridge /health" "$IM_URL/health"
  envf="$S_STATE/bridge.env"
  tok="$( [[ -f "$envf" ]] && helper env-get "$envf" "$(side_key "$WA_TOKEN_KEY")")"
  line="$( [[ -n "$tok" ]] && echo "Authorization: Bearer $tok")"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS )) st=""
  while [[ $(date +%s) -lt $deadline ]]; do
    st="$(http "$WA_URL/session/$TENANT_ID/status" "$line" body | json_field connected)"
    [[ "$st" == true ]] && break; sleep 5
  done
  [[ "$st" == true ]] && ok "WhatsApp session connected (no QR)" || bad "WhatsApp session not connected (status.connected=${st:-?}) — check the err log before re-pairing"
  [[ "$(http "$WA_URL/session/$TENANT_ID/has-creds" "$line" body | json_field hasCreds)" == true ]] && ok "WhatsApp creds present" || bad "WhatsApp has-creds=false"
  tok="$( [[ -f "$envf" ]] && helper env-get "$envf" "$(side_key "$IM_TOKEN_KEY")")"
  line="$( [[ -n "$tok" ]] && echo "Authorization: Bearer $tok")"
  st="$(http "$IM_URL/session/$TENANT_ID/diagnostics" "$line" body)"
  if [[ "$(printf '%s' "$st" | json_field chatDb.open)" == true ]]; then ok "iMessage chat.db open (lastSeenRowid $(printf '%s' "$st" | json_field chatDb.lastSeenRowid))"
  else bad "iMessage chat.db not open — Full Disk Access for the node binary? (state=$(printf '%s' "$st" | json_field state))"; fi
  for f in imessage-bridge whatsapp-bridge; do
    line="$(cat "$S_LOGS/$f.out.log" "$S_LOGS/$f.err.log" 2>/dev/null | grep -a 'LIVENESS' | tail -1 | grep -oE 'LIVENESS: [^"]*' | cut -c1-90)"
    [[ -n "$line" ]] && log "  .     $f last LIVENESS: $line" || log "  .     $f: no LIVENESS line yet (they only print while replies are suppressed — none is good)"
  done
  grep -aq 'opened chat.db' "$S_LOGS/imessage-bridge.out.log" "$S_LOGS/imessage-bridge.err.log" 2>/dev/null && ok "iMessage log: opened chat.db" || warn "iMessage log has no 'opened chat.db' line"
  if [[ -f "$LA_DIR/$S_PREFIX.api.plist" ]]; then
    sig="$(helper plist-get "$LA_DIR/$S_PREFIX.api.plist" "env:$(side_key "$SIGNAL_TOKEN_KEY")")"
    if [[ -n "$sig" ]]; then
      local h="$SIGNAL_HEADER"; [[ "$side" == old ]] && h="${SIGNAL_HEADER/pal/lantern}"
      [[ "$(http "$API_URL/v1/signals?limit=1" "$h: $sig")" == 200 ]] && ok "signals endpoint accepts $h" || warn "signals endpoint rejected $h"
    fi
  fi
  if [[ "$WA_CREDS_OLD" != "$WA_CREDS_NEW" && "$side" == new ]]; then [[ -d "$WA_CREDS_NEW" ]] && ok "WhatsApp creds at new path" || bad "WhatsApp creds missing at $WA_CREDS_NEW"; fi
  log "  .     owner check (NOT automated): send '?' in self-chat on both channels → exactly ONE Brief each, no echo loop for 10 min"
  [[ "$FAILED" == "$f0" ]]
}

# ================================================================== commands
latest_backup() { find "$BACKUP_ROOT" -maxdepth 1 -type d -name 'pal-cutover-backup-*' 2>/dev/null | sort | tail -1; }

cmd_plan() {
  DRY=1
  guard_mode
  preflight
  local pf=$FAILED
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/pal-cutover-plan.XXXXXX")"; chmod 700 "$WORK"
  [[ -n "$REL_SHA" ]] && render
  step_stop; step_backup; step_state_move; step_env; step_db; step_plists; step_git; step_build plan; start_side "$NEW_LABEL_PREFIX"; health new
  rm -rf "$WORK"
  hdr "plan summary: $pf preflight failure(s), $WARNED warning(s)"
  [[ "$pf" == 0 ]] || { log "apply would REFUSE until the failures above are fixed"; return 1; }
}

cmd_backup() {
  guard_mode
  BK="$BACKUP_ROOT/pal-cutover-backup-$TS"
  REL_SHA="$(git -C "$REPO_DIR" rev-parse -q --verify "$RELEASE_REF^{commit}" || true)"
  warn "standalone backup: services are still running, so file state may be mid-write (the DB dump itself is transactionally consistent). apply takes its own backup after stopping everything."
  step_backup || die "backup failed"
  log "backup: $BK"
}

run_step() {  # run_step NAME FUNC [args]
  local name="$1"; shift
  "$@" && fail_injection "$name" && return 0
  hdr "step '$name' FAILED"
  if [[ "$AUTO_ROLLBACK" == 1 && -n "$BK" ]]; then
    log "auto-rollback from $BK (PAL_CUTOVER_AUTO_ROLLBACK=0 to disable)"
    FAILED=0; cmd_rollback "$BK"; exit 1
  fi
  log "stopped. inspect, then: $0 rollback $BK"
  exit 1
}

cmd_apply() {
  guard_mode
  preflight
  [[ "$FAILED" == 0 ]] || die "preflight failed ($FAILED) — nothing was changed"
  BK="$BACKUP_ROOT/pal-cutover-backup-$TS"; WORK="$BK/work"
  umask 077; mkdir -p "$WORK"; chmod 700 "$BK"
  printf '%s\n' "$PRE_LOADED" > "$BK/loaded.txt"
  journal begin apply
  local T0; T0="$(date +%s)"
  render; [[ "$FAILED" == 0 ]] || { rm -rf "$BK"; die "render failed — nothing was changed"; }
  run_step stop step_stop
  run_step backup step_backup
  run_step state-move step_state_move
  run_step env step_env
  run_step db step_db
  run_step plists step_plists
  run_step git step_git
  run_step build step_build apply
  run_step start step_start
  journal end apply
  if health new; then
    hdr "CUTOVER COMPLETE in $(( $(date +%s) - T0 ))s — backup: $BK"
  else
    hdr "CUTOVER APPLIED BUT HEALTH FAILED ($FAILED) — investigate, or: $0 rollback $BK"
    exit 2
  fi
}

cmd_verify() {
  guard_mode
  local side=new; [[ "${1:-}" == --old ]] && side=old
  local bkd; bkd="$(latest_backup)"
  if [[ -n "$bkd" && -f "$bkd/loaded.txt" ]]; then PRE_LOADED="$(cat "$bkd/loaded.txt")"
  else side_vars "$side"; PRE_LOADED="$(loaded_with_prefix "$S_PREFIX" | sed "s/^$S_PREFIX\./$OLD_LABEL_PREFIX./")"; fi
  health "$side"
}

cmd_rollback() {
  guard_mode
  local bkd="" dbmode=dump a
  for a in "$@"; do case "$a" in --db=*) dbmode="${a#--db=}";; *) bkd="$a";; esac; done
  [[ -n "$bkd" ]] || bkd="$(latest_backup)"
  [[ -d "$bkd" ]] || die "no backup dir (looked in $BACKUP_ROOT)"
  BK="$bkd"
  hdr "ROLLBACK from $bkd (db mode: $dbmode)"
  PRE_LOADED="$(cat "$bkd/loaded.txt" 2>/dev/null)"
  local has_backup=0 aside="$bkd/rolledback-$TS" l f
  [[ -f "$bkd/SHA256SUMS" ]] && ( cd "$bkd" && shasum -a 256 -c -s SHA256SUMS ) && has_backup=1
  [[ "$has_backup" == 1 ]] && ok "backup checksums verified" || warn "no verified backup (apply failed before it finished) — restoring launchd only; state was not touched"
  mkdir -p "$aside"

  # 1. stop everything of both prefixes
  for l in $( { loaded_with_prefix "$NEW_LABEL_PREFIX"; loaded_with_prefix "$OLD_LABEL_PREFIX"; } | awk '{print $1}'); do
    bootout_wait "$l" && ok "stopped $l" || bad "could not stop $l"
  done
  # 2. plists: set new ones aside, restore the archived set
  for f in "$LA_DIR/$NEW_LABEL_PREFIX".*; do [[ -e "$f" ]] && mkdir -p "$aside/plists" && mv "$f" "$aside/plists/"; done
  if [[ -f "$bkd/plists.tgz" ]]; then tar -C "$LA_DIR" -xpzf "$bkd/plists.tgz" && ok "restored $(wc -l < "$bkd/plists.list" | tr -d ' ') plists"
  elif [[ -d "$bkd/retired-plists" ]]; then mv "$bkd/retired-plists"/* "$LA_DIR/" 2>/dev/null; ok "restored retired plists"; fi
  # 3. state dir
  if [[ "$has_backup" == 1 ]]; then
    [[ -L "$OLD_STATE_DIR" ]] && rm "$OLD_STATE_DIR"
    [[ -d "$NEW_STATE_DIR" && ! -L "$NEW_STATE_DIR" ]] && mv "$NEW_STATE_DIR" "$aside/state-new"
    [[ -d "$OLD_STATE_DIR" ]] && mv "$OLD_STATE_DIR" "$aside/state-old"
    tar -C "$(dirname "$OLD_STATE_DIR")" -xpzf "$bkd/state.tgz" && ok "restored $OLD_STATE_DIR from state.tgz (post-cutover state kept at $aside)" || bad "state restore"
  fi
  if journaled "$bkd" "end wa-creds-move" && [[ -d "$WA_CREDS_NEW" && ! -e "$WA_CREDS_OLD" ]]; then
    mv "$WA_CREDS_NEW" "$WA_CREDS_OLD" && ok "WhatsApp creds moved back"
  fi
  # 4. database
  if journaled "$bkd" "begin db" && db_renaming; then rollback_db "$bkd" "$dbmode" "$aside"; fi
  # 5. checkout
  if journaled "$bkd" "begin git"; then rollback_git "$bkd" || bad "git rollback"; fi
  # 6. prove it (both snapshots are taken with every agent stopped)
  if [[ "$has_backup" == 1 ]]; then
    snapshot "$aside/post.snapshot" old
    if diff -u "$bkd/pre.snapshot" "$aside/post.snapshot" > "$aside/snapshot.diff"; then ok "snapshot IDENTICAL to pre-cutover (state, plists, repo state, git, DB checksum, role verifiers)"
    else warn "snapshot differs from pre-cutover — see $aside/snapshot.diff (expected only if the new stack ran long enough to write repo state)"; fi
  fi
  # 7. start the old side
  hdr "start $OLD_LABEL_PREFIX.* agents"
  start_side "$OLD_LABEL_PREFIX"
  health old
  hdr "rollback finished ($FAILED failure(s))"
  [[ "$FAILED" == 0 ]]
}

rollback_db() {
  local bkd="$1" mode="$2" aside="$3" admin r p
  hdr "database rollback"
  admin="$(admin_user)"
  if [[ "$admin" == "$DB_NEW_USER" && "$DB_OLD_USER" != "$DB_NEW_USER" ]]; then
    role_exists "$DB_NEW_USER" "$TMP_ROLE" || pg1 "$DB_NEW_USER" postgres "CREATE ROLE $TMP_ROLE SUPERUSER LOGIN"
    pg1 "$TMP_ROLE" postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='$DB_NEW_USER'" >/dev/null
    pg1 "$TMP_ROLE" postgres "ALTER ROLE $DB_NEW_USER RENAME TO $DB_OLD_USER" >/dev/null 2>&1 && ok "role $DB_NEW_USER → $DB_OLD_USER" || bad "rename user back"
  fi
  admin="$DB_OLD_USER"
  role_exists "$admin" "$TMP_ROLE" && pg1 "$admin" postgres "DROP ROLE $TMP_ROLE"
  if [[ "$DB_OLD_APP_ROLE" != "$DB_NEW_APP_ROLE" ]] && role_exists "$admin" "$DB_NEW_APP_ROLE"; then
    pg1 "$admin" postgres "ALTER ROLE $DB_NEW_APP_ROLE RENAME TO $DB_OLD_APP_ROLE" >/dev/null 2>&1 && ok "role $DB_NEW_APP_ROLE → $DB_OLD_APP_ROLE" || bad "rename app role back"
  fi
  # exact password verifiers as captured (SCRAM/MD5 strings are accepted verbatim by ALTER ROLE)
  while IFS=$'\t' read -r r p; do
    [[ -n "$r" ]] || continue
    if [[ -n "$p" ]]; then printf 'ALTER ROLE %s PASSWORD %s;\n' "$r" "$(sql_lit "$p")" | pg "$admin" postgres >/dev/null
    else pg1 "$admin" postgres "ALTER ROLE $r PASSWORD NULL" >/dev/null; fi
  done < /dev/null
  ok "role password verifiers restored"
  if db_exists "$admin" "$DB_NEW_NAME" && [[ "$DB_OLD_NAME" != "$DB_NEW_NAME" ]]; then
    pg1 "$admin" postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_NEW_NAME'" >/dev/null
    if [[ "$mode" == rename ]]; then
      pg1 "$admin" postgres "ALTER DATABASE $DB_NEW_NAME RENAME TO $DB_OLD_NAME" && ok "database renamed back (keeps post-cutover writes)"
    else
      local keep="${DB_OLD_NAME}_postcutover_$TS"
      pg1 "$admin" postgres "ALTER DATABASE $DB_NEW_NAME RENAME TO $keep" && ok "post-cutover database kept as $keep"
      docker exec -i "$DB_CONTAINER" pg_restore -U "$admin" -d postgres -C --exit-on-error < "$bkd/db.dump" \
        && ok "restored $DB_OLD_NAME from db.dump" || bad "pg_restore failed"
    fi
  fi
  local s; s="$(db_plain_sha "$admin" "$DB_OLD_NAME")"
  [[ "$s" == "$(cat "$bkd/db.plain.sha256")" ]] && ok "database checksum matches the backup" || warn "database checksum differs from the backup (expected with --db=rename after the new stack wrote data)"
}

rollback_git() {
  local bkd="$1" OLD_HEAD="" OLD_BRANCH="" OLD_REMOTE="" STASH_SHA=""
  hdr "checkout rollback"
  # shellcheck disable=SC1090,SC1091
  . "$bkd/git.env"
  git -C "$REPO_DIR" remote set-url origin "$OLD_REMOTE"
  if [[ "$OLD_BRANCH" != HEAD ]]; then
    git -C "$REPO_DIR" checkout -q "$OLD_BRANCH" && git -C "$REPO_DIR" reset -q --keep "$OLD_HEAD" || return 1
  else
    git -C "$REPO_DIR" checkout -q --detach "$OLD_HEAD" || return 1
  fi
  if [[ -n "$STASH_SHA" ]]; then git -C "$REPO_DIR" stash apply -q "$STASH_SHA" && ok "re-applied stashed changes (stash kept)" || return 1; fi
  [[ "$(git -C "$REPO_DIR" rev-parse HEAD)" == "$OLD_HEAD" ]] && ok "HEAD back at ${OLD_HEAD:0:9} on $OLD_BRANCH" || return 1
  build_tree rollback
}

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

case "${1:-}" in
  plan)     cmd_plan ;;
  backup)   cmd_backup ;;
  apply)    cmd_apply ;;
  verify)   shift; cmd_verify "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  snapshot) shift; guard_mode; snapshot "${1:?out file}" "${2:-old}" ;;
  *)        usage ;;
esac
