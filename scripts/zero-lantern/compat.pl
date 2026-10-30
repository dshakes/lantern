# compat.pl — line-level removal of the transition compat layers (step 10), as
# a `perl -0pi` program. Every rule is specific to a compat construct, so it is
# a no-op on any other file. merge-master.sh also runs it on the base/theirs
# stages of a conflicted file, with ZL_PATH carrying the logical path.
my $path = $ENV{ZL_PATH} // $ARGV;

# Go: palenv (Bridge() calls, import, go.mod require/replace, Dockerfile COPY,
# Makefile/CI steps), palenv.Get("X") -> os.Getenv("PAL_X").
s/^[ \t]*palenv\.Bridge\(\)[ \t]*\n//mg;
s/^[ \t]*"github\.com\/dshakes\/[a-z]+\/packages\/palenv"[ \t]*\n//mg;
s/^[ \t]*github\.com\/dshakes\/[a-z]+\/packages\/palenv v0\.0\.0[^\n]*\n//mg;
s/^replace github\.com\/dshakes\/[a-z]+\/packages\/palenv => [^\n]*\n//mg;
s/^COPY packages\/palenv\/?[^\n]*\n//mg;
s/^[ \t]*cd packages\/palenv && [^\n]*\n//mg;
s/^[ \t]*- name: golangci-lint \(palenv\)\n(?:[ \t]+[^\n-][^\n]*\n)*\n?//mg;
s/palenv\.Get\("([A-Z0-9_]+)"\)/os.Getenv("PAL_$1")/g;

# Rust: pal_env::var -> std::env::var; the path dependency everywhere.
s/\bpal_env::var\(/std::env::var(/g;
s/^pal_env = \{ path = "[^"]*" \}\n//mg;
s/^# Context is the repo root \(see build-images\.yml\): pal_env is a path dependency\n# at \.\.\/\.\.\/packages\/pal-env-rs, so the repo layout is preserved\.\n//mg;
s/^COPY packages\/pal-env-rs\/?[^\n]*\n//mg;
s/^!?packages\/pal-env-rs(\/target)?\n//mg;
s/^[ \t]*cd packages\/pal-env-rs && [^\n]*\n//mg;
s/^[ \t]*- name: cargo clippy \(pal-env-rs\)\n[ \t]+run: [^\n]*\n\n?//mg;

# TS: the env-compat imports and re-runs.
s/^\/\/ [^\n]*\n\/\/ entrypoint that did not import env-compat first \(ADR 0032\)\.\nimport "\.\/env-compat\.js";\n//mg;
s/^import "(?:\.\/|\@(?:pal|lantern)\/bridge-core\/)env-compat(?:\.js)?";\n//mg;
s/^import \{ bridgeEnv \} from "\@(?:pal|lantern)\/bridge-core\/env-compat";\n//mg;
s/^[ \t]*bridgeEnv\(\);[^\n]*\n//mg;
s/^[ \t]*"\.\/env-compat": "\.\/src\/env-compat\.ts",\n//mg;

# Python: pal._env.get("X", d) -> os.environ.get("PAL_X", d).
if ($path =~ /\.py$/) {
  s/\b_env\.get\("([A-Z0-9_]+)"/os.environ.get("PAL_$1"/g;
  if (/^import os$/m) { s/^from pal import _env\n//mg } else { s/^from pal import _env$/import os/mg }
}

# SDK deprecated aliases.
if ($path =~ m{^packages/sdk-(ts/src|python/pal)/}) {
  s/^Lantern\w+ = Pal\w+[ \t]+# deprecated alias[^\n]*\n//mg;
  s/^export \* from "\.\/(?:runtime\/)?deprecated\.js";\n//mg;
  s/\bLantern\w+, (?=Pal)//g;
  s/^[ \t]+"?Lantern\w+"?,\n//mg;
}
if ($path =~ m{^packages/sdk-ts/package(-lock)?\.json$}) {
  s/,\n[ \t]*"lantern-run": "[^"]*"//g;
  s/\n[ \t]*"lantern-run": "[^"]*",//g;
}
if ($path eq "packages/sdk-python/pyproject.toml") {
  s/^lantern-runner = [^\n]*\n//mg;
  s/include = \["pal\*", "lantern\*"\]/include = ["pal*"]/g;
}

# CLI: the legacy binary name and its alias handling.
if ($path eq "packages/cli/internal/cli/main.go") {
  s/\n\/\/ legacyBinaryName is the pre-rename name[^\n]*\n\/\/[^\n]*\nconst legacyBinaryName = "lantern"\n//;
  s/\/\/ Main runs the CLI and returns the process exit code\. cmd\/pal and the legacy\n\/\/ cmd\/lantern both call it, so the two binaries cannot drift\.\n/\/\/ Main runs the CLI and returns the process exit code.\n/;
  s/\n\tif invokedAs\(os\.Args\[0\]\) == legacyBinaryName \{\n(?:\t\t[^\n]*\n|\t\t\t[^\n]*\n)*?\t\}\n/\n/;
  s/\n\/\/ invokedAs is the binary name from argv\[0\][^\n]*\nfunc invokedAs\(argv0 string\) string \{\n[^\n]*\n\}\n//;
  s/\nfunc isTerminal\(w io\.Writer\) bool \{\n(?:[^\n]*\n)*?\}\n//;
}
if ($path eq "packages/cli/internal/cli/main_test.go") {
  s/^func TestInvokedAs\(t \*testing\.T\) \{\n(?:[^\n]*\n)*?\}\n\n//m;
}
if ($path eq "Formula/pal.rb") {
  s/^# Installs `pal` plus a `lantern` symlink[^\n]*\n# so existing scripts keep working\.\n//m;
  s/^[ \t]*# v0\.2\.0 predates the rename[^\n]*\n[ \t]*main = File\.directory\?\("cmd\/pal"\) \? "\.\/cmd\/pal" : "\.\/cmd\/lantern"\n//m;
  s/, main\n/, ".\/cmd\/pal"\n/;
  s/^[ \t]*bin\.install_symlink "pal" => "lantern"\n//m;
  s/^[ \t]*system bin\/"lantern", "--version"\n//m;
}

# CI / Makefile: the env-read gate is superseded by brand-check --enforce.
s/^[ \t]*# ADR 0032: code reads PAL_\*; the compat layer serves LANTERN_\*\.\n[ \t]*- name: env-read-check[^\n]*\n[ \t]*run: bash scripts\/env-read-check\.sh\n/      # ADR 0032: no reference to the previous brand outside the allowlist.\n      - name: brand-check (strict)\n        run: bash scripts\/brand-check.sh --enforce\n/m;
s/^\tbash scripts\/env-read-check\.sh\n/\tbash scripts\/brand-check.sh --enforce\n/mg;
