#!/usr/bin/env bash
# Step 60 — regenerate what was derived from renamed sources.
#   * gen/go/pal/v1 from packages/proto/pal/v1 (the proto package is now
#     pal.v1: the raw descriptors embed it, so a text rewrite is not enough —
#     protoc re-emits them). Generators are pinned to the versions the tree
#     already used so the only diff is the rename.
#   * Cargo.lock files: crate names changed and the pal_env path dep is gone.
source "${ZL_HERE:?}/lib.sh"

PROTOC_GEN_GO_VERSION=v1.36.11
PROTOC_GEN_GO_GRPC_VERSION=v1.5.1
tools="${ZL_TOOLS:-${XDG_CACHE_HOME:-$HOME/.cache}/zero-lantern/bin}"
mkdir -p "$tools"
have() { [[ -x "$tools/$1" ]] && "$tools/$1" --version 2>/dev/null | grep -q "${2#v}"; }
have protoc-gen-go "$PROTOC_GEN_GO_VERSION" ||
  GOBIN="$tools" go install "google.golang.org/protobuf/cmd/protoc-gen-go@$PROTOC_GEN_GO_VERSION"
have protoc-gen-go-grpc "$PROTOC_GEN_GO_GRPC_VERSION" ||
  GOBIN="$tools" go install "google.golang.org/grpc/cmd/protoc-gen-go-grpc@$PROTOC_GEN_GO_GRPC_VERSION"
command -v protoc >/dev/null || zl_fail "protoc not found"

gen_into() {
  mkdir -p "$1"
  PATH="$tools:$PATH" protoc --proto_path=packages/proto \
    --go_out="$1" --go_opt=paths=source_relative \
    --go-grpc_out="$1" --go-grpc_opt=paths=source_relative \
    packages/proto/pal/v1/*.proto
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gen_into "$tmp/a"
rm -f gen/go/pal/v1/*.pb.go
cp "$tmp/a/pal/v1/"*.pb.go gen/go/pal/v1/
git add -A gen/go/pal/v1

# Reproducibility: a second generation must be byte-identical.
gen_into "$tmp/b"
diff -r "$tmp/a/pal/v1" "$tmp/b/pal/v1" >/dev/null || zl_fail "protoc output is not reproducible"
grep -rq 'lantern' gen/go/pal/v1 && zl_fail "generated code still embeds the old name"
zl_note "gen/go/pal/v1 regenerated ($(ls gen/go/pal/v1 | wc -l | tr -d ' ') files)"

# Cargo.lock: let cargo drop/rename entries (no version bumps: metadata only re-resolves what changed).
for m in services/*/Cargo.toml packages/*/Cargo.toml; do
  [[ -f "$m" ]] || continue
  d="$(dirname "$m")"
  [[ -f "$d/Cargo.lock" ]] || continue
  (cd "$d" && cargo metadata --format-version 1 >/dev/null 2>"$tmp/cargo.err") ||
    { cat "$tmp/cargo.err" >&2; zl_fail "cargo metadata failed in $d"; }
done
zl_note "Cargo.lock files refreshed"
