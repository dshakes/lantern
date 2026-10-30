# rewrite.pl — the ordered rename rules (step 30), as a `perl -0pi` program.
# Also used by merge-master.sh on the base/theirs stages of a conflicted file;
# there ZL_PATH carries the logical path (the file itself is a temp copy).
  # 1. one-off prose
  if (($ENV{ZL_PATH} // $ARGV) eq "README.md") {
    s/^We started as Lantern[^\n]*\n\n?//m;
    s/ The CLI, packages and `LANTERN_\*` env vars still carry the old name while the rename lands; the commands below are the real ones today\.//;
  }
  # dev seed password is now "pal": swap the bcrypt hash of the old one
  s/\$2b\$10\$\.hAunSjVIs5aiTYrzIAmfuLbpy1Im2N4xIvhjFVG5v3fak\/eeyP7W/\$2a\$10\$TjzuOlrLRP\/7gC9HGdUX0u4aLfWZH\/ho3WzZUiW7bSbRkAf2VEIau/g;
  # the one kept legacy wire name (scripts/brand-allowlist.txt): pre-rename
  # iPhone Shortcuts send it to /v1/signals; protected from the rewrite.
  my $zlp = $ENV{ZL_PATH} // $ARGV;
  my $keep = $zlp =~ m{^(services/control-plane/internal/handlers/signals(_test)?\.go|apps/web/app/api/signals/route\.ts)$};
  s/x-lantern-signal-token/\x00KEEP\x00/g if $keep;
  # the pre-rename VM cert marker, matched only to refuse (runtime-manager tls.rs)
  my $keepou = $zlp eq "services/runtime-manager/src/tls.rs";
  s/LEGACY_VM_CERT_OU: &str = "lantern-vm"/\x00KEEPOU\x00/g if $keepou;
  # 2-6. the rename
  s/X-Lantern-/X-Pal-/g;
  s/Lantern(?=[A-Za-z0-9])/Pal/g;
  s/(?<=[A-Za-z0-9_])Lantern/Pal/g;
  s/Lantern/PAL/g;
  s/LANTERN/PAL/g;
  s/lantern/pal/g;
  s/(?i:lantern)/pal/g;
  s/\x00KEEP\x00/x-lantern-signal-token/g if $keep;
  s/\x00KEEPOU\x00/LEGACY_VM_CERT_OU: &str = "lantern-vm"/g if $keepou;
