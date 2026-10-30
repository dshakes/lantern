#!/usr/bin/env bash
# Step 30 — ordered content rewrite over every tracked text file that still
# mentions the old brand. Order matters (most specific first):
#   1. one-off prose removals (README origin story, "still carries the old name")
#   2. X-<Old>-Header        -> X-Pal-Header      (HTTP header casing)
#   3. <Old>Identifier       -> PalIdentifier     (CamelCase continuation)
#      fooOldBar             -> fooPalBar
#   4. <Old> (word)          -> PAL               (brand in prose / UI)
#   5. OLD_ENV / OLD         -> PAL_ENV / PAL
#   6. old (any other case)  -> pal               (module path, proto package,
#      lanternv1, headers, paths, labels, metrics, DB role, ...)
# Symlinks and binaries are skipped (git grep -I, [[ -L ]]).
source "${ZL_HERE:?}/lib.sh"

list="$(zl_files_matching lantern)"
[[ -n "$list" ]] || { zl_note "nothing to rewrite"; exit 0; }
zl_note "$(printf '%s\n' "$list" | wc -l | tr -d ' ') files to rewrite"

printf '%s\n' "$list" | tr '\n' '\0' | xargs -0 -n 200 perl -0pi -e '
  # 1. one-off prose
  if ($ARGV eq "README.md") {
    s/^We started as Lantern[^\n]*\n\n?//m;
    s/ The CLI, packages and `LANTERN_\*` env vars still carry the old name while the rename lands; the commands below are the real ones today\.//;
  }
  # dev seed password is now "pal": swap the bcrypt hash of the old one
  s/\$2b\$10\$\.hAunSjVIs5aiTYrzIAmfuLbpy1Im2N4xIvhjFVG5v3fak\/eeyP7W/\$2a\$10\$TjzuOlrLRP\/7gC9HGdUX0u4aLfWZH\/ho3WzZUiW7bSbRkAf2VEIau/g;
  # the one kept legacy wire name (scripts/brand-allowlist.txt): pre-rename
  # iPhone Shortcuts send it to /v1/signals; protected from the rewrite.
  my $keep = $ARGV =~ m{^(services/control-plane/internal/handlers/signals(_test)?\.go|apps/web/app/api/signals/route\.ts)$};
  s/x-lantern-signal-token/\x00KEEP\x00/g if $keep;
  # 2-6. the rename
  s/X-Lantern-/X-Pal-/g;
  s/Lantern(?=[A-Za-z0-9])/Pal/g;
  s/(?<=[A-Za-z0-9_])Lantern/Pal/g;
  s/Lantern/PAL/g;
  s/LANTERN/PAL/g;
  s/lantern/pal/g;
  s/(?i:lantern)/pal/g;
  s/\x00KEEP\x00/x-lantern-signal-token/g if $keep;
'

left="$(git grep -I -i -l lantern -- . "${ZL_EXCLUDES[@]}" | grep -v -E '^(services/control-plane/internal/handlers/signals(_test)?\.go|apps/web/app/api/signals/route\.ts)$' || true)"
[[ -z "$left" ]] || zl_fail "content still mentions the old name:
$left"
zl_note "content rewritten"
