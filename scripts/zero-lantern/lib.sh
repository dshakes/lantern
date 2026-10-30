# shellcheck shell=bash
# Shared helpers for the zero-lantern steps. Sourced, not executed.
set -euo pipefail
cd "${ZL_ROOT:?run via scripts/zero-lantern/run.sh}"

# Files the codemod never rewrites: the codemod itself, the brand gate (it has
# to name what it looks for), and the one DB migration that renames persisted
# objects still carrying the old name. Paths are git pathspec excludes.
ZL_EXCLUDES=(
  ':!:scripts/zero-lantern/**'
  ':!:scripts/brand-check.sh'
  ':!:scripts/brand-allowlist.txt'
  ':!:services/control-plane/internal/db/migrations/*_pal_brand_rename.*.sql'
)

# Tracked regular text files (not symlinks, not binaries) whose content matches
# the case-insensitive pattern $1.
zl_files_matching() {
  local rc=0
  git grep -I -i -l -e "$1" -- . "${ZL_EXCLUDES[@]}" | while IFS= read -r f; do
    [[ -L "$f" ]] || printf '%s\n' "$f"
  done || rc=$?
  [[ $rc -le 1 ]] || return "$rc"
}

zl_fail() { echo "zero-lantern: $*" >&2; exit 1; }
zl_note() { echo "    $*"; }

# rm -rf a tracked path if it is still there (idempotent).
zl_rm() {
  local p
  for p in "$@"; do
    if [[ -e "$p" || -L "$p" ]]; then
      git rm -r -q --cached --ignore-unmatch -- "$p" >/dev/null
      rm -rf -- "$p"
      zl_note "removed $p"
    fi
  done
}
