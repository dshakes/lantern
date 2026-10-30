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

# Public domains: the old brand's domains were rewritten to pal.run / pal.dev,
# which are owned by third parties. Never point anything at them:
#   error-type URIs and the product/docs site -> the project docs site;
#   any other host (api., app., cdn., <tenant>., ...) -> RFC 2606 pal.example.com;
#   e-mail addresses -> non-routable pal.local; security contact -> GitHub PVR.
# K8s label/annotation keys (pal.dev/<key>) and node labels (pal.run/component)
# are names, not hosts, and are left alone.
s{`security\.pal\.run/advisories`}{[GitHub private vulnerability reporting](https://github.com/dshakes/pal/security/advisories/new)}g;
s{`security\@pal\.run`}{GitHub private vulnerability reporting}g;
s{https?://pal\.(?:run|dev)/errors/}{https://dshakes.github.io/pal/errors/}g;
s{https?://(?:www\.|docs\.)?pal\.(?:run|dev)\b(?![._-])}{https://dshakes.github.io/pal}g;
s{((?:https?|wss?)://)?((?:[a-z0-9-]+\.|<[\w-]+>\.)+)pal\.(?:run|dev)\b(?![._-])}{($1//"").$2."pal.example.com"}ge;
s{\@pal\.(?:run|dev)\b(?![._-])}{\@pal.local}g;
s{\bpal\.dev/(acme/[\w./-]+\@sha256)}{registry.pal.example.com/$1}g;
s{(?<![\w./@-])pal\.run/(?!component)}{pal.example.com/}g;
s{(?<![\w./@-])pal\.run\b(?![._/-])}{pal.example.com}g;
