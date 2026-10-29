#!/usr/bin/env bash
# env-read-check — fail on a NEW direct read of a LANTERN_* env var (ADR 0032).
#
# Code reads the PAL_* name; the compat layer (Go palenv.Bridge, TS env-compat,
# Rust pal_env, Python _env) keeps LANTERN_* working. A direct LANTERN_ read is
# allowed only:
#   - as a fallback on the same line as its PAL_ twin (PAL_X || LANTERN_X),
#   - as a write (process.env.LANTERN_X = ...),
#   - in the paths listed below, each with its reason.
#
# Usage: scripts/env-read-check.sh   (exit 1 and list offenders on failure)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

pattern='(Getenv|LookupEnv)\("LANTERN_|env::var(_os)?\("LANTERN_|process\.env\.LANTERN_|os\.environ\.get\("LANTERN_|os\.environ\["LANTERN_'

allow=(
  ':!docs' ':!site' ':!*.md' ':!*.mdx'           # prose and published docs (rename PR 7)
  ':!packages/palenv'                            # Go compat helper
  ':!packages/pal-env-rs'                        # Rust compat helper
  ':!packages/bridge-core/src/env-compat.ts'     # TS compat helper
  ':!packages/sdk-python/lantern/_env.py'        # Python compat helper
  ':!services/harness/src/bootenv.rs'            # boot-env hydration: reads guard its own LANTERN_ set_var writes (writers flip in step 4)
  ':!apps/web/components/view-code.tsx'          # user-facing code samples shown in the UI (rename PR 7)
  ':!scripts/env-read-check.sh'
)

rc=0
matches="$(git grep -nE "$pattern" -- . "${allow[@]}")" || rc=$?
# git grep exit 1 = no match; anything higher is a real failure.
[[ $rc -le 1 ]] || { echo "env-read-check: git grep failed (exit $rc)" >&2; exit "$rc"; }
[[ -z "$matches" ]] && { echo "env-read-check: ok (no direct LANTERN_* env reads)"; exit 0; }

bad="$(printf '%s\n' "$matches" | perl -ne '
  my ($loc, $line) = /^([^:]+:\d+):(.*)$/ or next;
  my $code = $line;                                          # writes and deletes are fine:
  $code =~ s/delete\s+process\.env\.LANTERN_\w+//g;
  $code =~ s/process\.env\.LANTERN_\w+\s*=(?!=)//g;
  my @miss = grep { $code !~ /\bPAL_\Q$_\E\b/ } ($code =~ /(?:Getenv|LookupEnv|var_os|var|get)\("LANTERN_(\w+)"|process\.env\.LANTERN_(\w+)|os\.environ\["LANTERN_(\w+)"/g);
  @miss = grep { defined } @miss;
  print "$loc: LANTERN_$miss[0] read without a PAL_$miss[0] fallback\n" if @miss;
')"

if [[ -n "$bad" ]]; then
  printf '%s\n' "$bad"
  echo "env-read-check: read the PAL_ name (the compat layer serves LANTERN_), or add the path to the allowlist with a reason." >&2
  exit 1
fi
echo "env-read-check: ok (only PAL_-fallback reads of LANTERN_*)"
