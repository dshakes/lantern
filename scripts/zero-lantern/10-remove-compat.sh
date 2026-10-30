#!/usr/bin/env bash
# Step 10 — remove the transition compat layers (ADR 0032 steps 1-9). After the
# rename there is one name per thing, so every "read PAL_X, fall back to the
# old name" helper, deprecated alias and legacy shim goes. Runs BEFORE the
# content rewrite: otherwise `OldClient = PalClient` would become
# `PalClient = PalClient` and the shim package would collide with `pal/`.
source "${ZL_HERE:?}/lib.sh"

# --- whole files / packages ---------------------------------------------------
zl_rm \
  packages/palenv \
  packages/pal-env-rs \
  packages/bridge-core/src/env-compat.ts \
  packages/bridge-core/src/env-compat.test.ts \
  packages/sdk-python/pal/_env.py \
  packages/sdk-python/tests/test_env.py \
  packages/sdk-python/tests/test_compat.py \
  packages/sdk-python/lantern \
  packages/sdk-ts/src/deprecated.ts \
  packages/sdk-ts/src/runtime/deprecated.ts \
  packages/sdk-ts/__tests__/deprecated-aliases.test.ts \
  packages/cli/cmd/lantern \
  services/control-plane/cmd/server/legacy_env_test.go \
  scripts/env-read-check.sh

# --- line-level surgery (perl, idempotent: no match = no change) --------------
# Go: Bridge() calls, the palenv import, go.mod require/replace, Dockerfile COPY.
while IFS= read -r f; do
  perl -0pi -e '
    s/^[ \t]*palenv\.Bridge\(\)[ \t]*\n//mg;
    s/^[ \t]*"github\.com\/dshakes\/[a-z]+\/packages\/palenv"[ \t]*\n//mg;
    s/^[ \t]*github\.com\/dshakes\/[a-z]+\/packages\/palenv v0\.0\.0[^\n]*\n//mg;
    s/^replace github\.com\/dshakes\/[a-z]+\/packages\/palenv => [^\n]*\n//mg;
    s/^COPY packages\/palenv\/?[^\n]*\n//mg;
    s/^[ \t]*cd packages\/palenv && [^\n]*\n//mg;
    s/^[ \t]*- name: golangci-lint \(palenv\)\n(?:[ \t]+[^\n-][^\n]*\n)*\n?//mg;
    s/palenv\.Get\("([A-Z0-9_]+)"\)/os.Getenv("PAL_$1")/g;
  ' "$f"
done < <(git grep -l -E "palenv" -- "*.go" "*go.mod" "**/Dockerfile*" "Makefile" ".github/**" || true)

# Rust: pal_env::var -> std::env::var; drop the path dependency everywhere.
while IFS= read -r f; do
  perl -0pi -e '
    s/\bpal_env::var\(/std::env::var(/g;
    s/^pal_env = \{ path = "[^"]*" \}\n//mg;
    s/^# Context is the repo root \(see build-images\.yml\): pal_env is a path dependency\n# at \.\.\/\.\.\/packages\/pal-env-rs, so the repo layout is preserved\.\n//mg;
    s/^COPY packages\/pal-env-rs\/?[^\n]*\n//mg;
    s/^!?packages\/pal-env-rs(\/target)?\n//mg;
    s/^[ \t]*cd packages\/pal-env-rs && [^\n]*\n//mg;
    s/^[ \t]*- name: cargo clippy \(pal-env-rs\)\n[ \t]+run: [^\n]*\n\n?//mg;
  ' "$f"
done < <(git grep -l -E "pal_env|pal-env-rs" -- "*.rs" "*Cargo.toml" "**/Dockerfile*" "**/*.dockerignore" "Makefile" ".github/**" || true)

# TS: the env-compat imports and re-runs.
while IFS= read -r f; do
  perl -0pi -e '
    s/^\/\/ [^\n]*\n\/\/ entrypoint that did not import env-compat first \(ADR 0032\)\.\nimport "\.\/env-compat\.js";\n//mg;
    s/^import "(?:\.\/|\@pal\/bridge-core\/)env-compat(?:\.js)?";\n//mg;
    s/^import \{ bridgeEnv \} from "\@pal\/bridge-core\/env-compat";\n//mg;
    s/^[ \t]*bridgeEnv\(\);[^\n]*\n//mg;
    s/^[ \t]*"\.\/env-compat": "\.\/src\/env-compat\.ts",\n//mg;
  ' "$f"
done < <(git grep -l -E "env-compat|bridgeEnv" -- "*.ts" "*package.json" || true)

# Python: pal._env.get("X", d) -> os.environ.get("PAL_X", d).
while IFS= read -r f; do
  perl -0pi -e '
    s/\b_env\.get\("([A-Z0-9_]+)"/os.environ.get("PAL_$1"/g;
    if (/^import os$/m) { s/^from pal import _env\n//mg } else { s/^from pal import _env$/import os/mg }
  ' "$f"
done < <(git grep -l -E "\b_env\.get\(|from pal import _env" -- "*.py" || true)

# SDK deprecated aliases (ADR 0032 step 9).
while IFS= read -r f; do
  perl -0pi -e '
    s/^Lantern\w+ = Pal\w+[ \t]+# deprecated alias[^\n]*\n//mg;
    s/^export \* from "\.\/(?:runtime\/)?deprecated\.js";\n//mg;
    s/\bLantern\w+, (?=Pal)//g;
    s/^[ \t]+"?Lantern\w+"?,\n//mg;
  ' "$f"
done < <(git grep -l -E "\bLantern[A-Z]\w*\b|deprecated\.js" -- "packages/sdk-ts/src/**" "packages/sdk-python/pal/**" || true)
for f in packages/sdk-ts/package.json packages/sdk-ts/package-lock.json; do
  [[ ! -f $f ]] || perl -0pi -e 's/,\n[ \t]*"lantern-run": "[^"]*"//g; s/\n[ \t]*"lantern-run": "[^"]*",//g' "$f"
done
[[ ! -f packages/sdk-python/pyproject.toml ]] || perl -0pi -e '
  s/^lantern-runner = [^\n]*\n//mg;
  s/include = \["pal\*", "lantern\*"\]/include = ["pal*"]/g;
' packages/sdk-python/pyproject.toml

# CLI: the legacy `lantern` binary name and its alias handling.
f=packages/cli/internal/cli/main.go
if [[ -f $f ]] && grep -q legacyBinaryName "$f"; then
  perl -0pi -e '
    s/\n\/\/ legacyBinaryName is the pre-rename name[^\n]*\n\/\/[^\n]*\nconst legacyBinaryName = "lantern"\n//;
    s/\/\/ Main runs the CLI and returns the process exit code\. cmd\/pal and the legacy\n\/\/ cmd\/lantern both call it, so the two binaries cannot drift\.\n/\/\/ Main runs the CLI and returns the process exit code.\n/;
    s/\n\tif invokedAs\(os\.Args\[0\]\) == legacyBinaryName \{\n(?:\t\t[^\n]*\n|\t\t\t[^\n]*\n)*?\t\}\n/\n/;
    s/\n\/\/ invokedAs is the binary name from argv\[0\][^\n]*\nfunc invokedAs\(argv0 string\) string \{\n[^\n]*\n\}\n//;
    s/\nfunc isTerminal\(w io\.Writer\) bool \{\n(?:[^\n]*\n)*?\}\n//;
  ' "$f"
  perl -0pi -e '
    s/^func TestInvokedAs\(t \*testing\.T\) \{\n(?:[^\n]*\n)*?\}\n\n//m;
  ' packages/cli/internal/cli/main_test.go
fi
f=Formula/pal.rb
if [[ -f $f ]]; then
  perl -0pi -e '
    s/^# Installs `pal` plus a `lantern` symlink[^\n]*\n# so existing scripts keep working\.\n//m;
    s/^[ \t]*# v0\.2\.0 predates the rename[^\n]*\n[ \t]*main = File\.directory\?\("cmd\/pal"\) \? "\.\/cmd\/pal" : "\.\/cmd\/lantern"\n//m;
    s/, main\n/, ".\/cmd\/pal"\n/;
    s/^[ \t]*bin\.install_symlink "pal" => "lantern"\n//m;
    s/^[ \t]*system bin\/"lantern", "--version"\n//m;
  ' "$f"
fi

# CI / Makefile: the env-read gate is superseded by brand-check --enforce.
perl -0pi -e '
  s/^[ \t]*# ADR 0032: code reads PAL_\*; the compat layer serves LANTERN_\*\.\n[ \t]*- name: env-read-check[^\n]*\n[ \t]*run: bash scripts\/env-read-check\.sh\n/      # ADR 0032: no reference to the previous brand outside the allowlist.\n      - name: brand-check (strict)\n        run: bash scripts\/brand-check.sh --enforce\n/m;
' .github/workflows/sdlc-lint.yml
perl -0pi -e 's/^\tbash scripts\/env-read-check\.sh\n/\tbash scripts\/brand-check.sh --enforce\n/mg' Makefile

# --- postcondition ------------------------------------------------------------
left="$(git grep -n -E 'palenv\.(Bridge|Get)\(|pal_env::var|env-compat|bridgeEnv\(|from pal import _env|legacyBinaryName|env-read-check\.sh' -- . "${ZL_EXCLUDES[@]}" ':!:docs/**' ':!:*.md' ':!:*.mdx' | perl -ne 'print unless /^[^:]+:\d+:\s*(\/\/|#|\*|test\()/' || true)"
[[ -z "$left" ]] || zl_fail "compat references remain:
$left"
zl_note "compat layers removed"
