# dedupe.pl — collapse the dual reads the rename made identical (step 40), as a
# `perl -0pi` program. Each rule fires only when both sides are textually the
# same, so it cannot change behaviour. Also used by merge-master.sh.
  1 while s/\$\{(PAL_\w+):([-=])\$\{\1:-((?:[^{}]|\$\{[^{}]*\})*)\}\}/\${$1:$2$3}/g;
  s/\$\{(PAL_\w+):-\$\{\1\}\}/\${$1}/g;
  s/\(\s*(process\.env\.PAL_\w+)\s*(?:\|\||\?\?)\s*\1\s*\)/$1/g;
  s/(process\.env\.PAL_\w+)\s*(?:\|\||\?\?)\s*\1\b/$1/g;
  s/\(\s*(os\.environ\.get\("PAL_\w+")\)\s+or\s+\1(, [^()]*(?:\([^()]*\)[^()]*)*)?\)\s*\)/$1.($2 \/\/ "").")"/ge;
  s/(os\.environ\.get\("PAL_\w+")\)\s+or\s+\1(, [^()]*(?:\([^()]*\)[^()]*)*)?\)/$1.($2 \/\/ "").")"/ge;
  s/cmp\.Or\((os\.Getenv\("PAL_\w+"\)), \1\)/$1/g;
  s/getenv\(("PAL_\w+"), getenv\(\1, ([^()]*)\)\)/getenv($1, $2)/g;
  s/getenv\(("PAL_\w+"), os\.Getenv\(\1\)\)/os.Getenv($1)/g;
  s/(\.Values\.[\w.]+\.env\.PAL_\w+) \| default \1\b/$1/g;
  s/\b((?:vars|secrets)\.PAL_\w+) \|\| \1\b/$1/g;
  s/\(pal\|pal\)/pal/g;
  s/(["\x27])(PAL_[A-Z0-9_]+)\1, \1\2\1/$1$2$1/g;
  s/\((pal_\w+\{[^{}]*\}) or \1\)/$1/g;
  s/\b(pal_\w+) or \1\b/$1/g;
  s/ \(legacy name (pal_\w+) also matched\)//g;
# Terraform: `moved` blocks and deprecated variable aliases that now point at
# themselves, and coalesce(var.x, var.x, d).
  s/^# ADR 0032: addresses renamed[^\n]*\n#[^\n]*\n//mg;
  s/^moved \{\n\s*from\s*=\s*(\S+)\n\s*to\s*=\s*\1\n\}\n\n?//mg;
  s/^variable "\w+" \{\n\s*description\s*=\s*"Deprecated alias of [^"]*"\n(?:[^\n]*\n)*?\}\n\n?//mg;
  s/coalesce\((var\.\w+), \1, /coalesce($1, /g;

# Public domains: the old brand's domains were rewritten to pal.run / pal.dev,
# which are owned by third parties. Never point anything at them:
#   error-type URIs and the product/docs site -> the project docs site;
#   any other host (api., app., cdn., <tenant>., ...) -> RFC 2606 pal.example.com;
#   e-mail addresses -> non-routable pal.local; security contact -> GitHub PVR.
# K8s label/annotation keys (pal.dev/<key>) are names, not hosts, and are left
# alone; the old node-label domain joins them under pal.dev/.
s{`security\.pal\.run/advisories`}{[GitHub private vulnerability reporting](https://github.com/dshakes/pal/security/advisories/new)}g;
s{`security\@pal\.run`}{GitHub private vulnerability reporting}g;
s{https?://pal\.(?:run|dev)/errors/}{https://dshakes.github.io/pal/errors/}g;
s{https?://(?:www\.|docs\.)?pal\.(?:run|dev)\b(?![._-])}{https://dshakes.github.io/pal}g;
s{((?:https?|wss?)://)?((?:[a-z0-9-]+\.|<[\w-]+>\.)+)pal\.(?:run|dev)\b(?![._-])}{($1//"").$2."pal.example.com"}ge;
s{\@pal\.(?:run|dev)\b(?![._-])}{\@pal.local}g;
s{\bpal\.dev/(acme/[\w./-]+\@sha256)}{registry.pal.example.com/$1}g;
s{\bpal\.run/component\b}{pal.dev/component}g;
s{(?<![\w./@-])pal\.run/(?!component)}{pal.example.com/}g;
s{(?<![\w./@-])pal\.run\b(?![._/-])}{pal.example.com}g;
