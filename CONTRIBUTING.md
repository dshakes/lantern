# Contributing to Lantern

Thanks for your interest in Lantern. This guide gets you from clone to a
mergeable change.

## Get it running

See the [README](README.md#quick-start). The fastest path needs only Docker:

```bash
git clone https://github.com/dshakes/lantern.git
cd lantern
make dev        # full platform stack in Docker
# or: lantern dev   (host hot-reload — see README Option B)
```

## Before you start

- Read [`CLAUDE.md`](CLAUDE.md) — it is the single source of truth for repo
  conventions and the **architectural invariants** (control plane never runs
  user code, the workflow engine is the only run-state mutator, multi-tenant by
  default, models addressed by capability, etc.). Changes that violate an
  invariant won't be merged.
- For a load-bearing or cross-service change, read/add an
  [ADR](docs/adr/) first.
- Prerequisites and versions: [README → Prerequisites](README.md#prerequisites)
  (Go 1.23+, Rust 1.85+ edition 2024, Node 20 LTS+, Docker). Toolchains are
  pinned via `.nvmrc` and `rust-toolchain.toml`.

## Standards

- **Tests with every change.** New behavior ships with unit tests; bug fixes
  ship with a regression test. Don't weaken assertions to make a suite pass.
- **No secrets or personal data** in commits. Use the templates
  (`docs/personal/owner-profile.example.md`, `.env.example`).
- **Regenerate protobuf** with `make proto` after editing a `.proto`; never
  hand-edit generated code.
- Match the surrounding code's style. Go: `gofmt`/`go vet`. Rust:
  `cargo clippy -- -D warnings`. TS: `tsc` clean.

## The gate

Run the same checks CI runs before opening a PR:

```bash
make ci-local     # lint + test + audit across Go / Rust / TypeScript / Python
```

`make test`, `make lint`, and `make audit` are also available individually. PRs
run the test matrix automatically.

## Security

Found a vulnerability? **Do not open a public issue** — see
[SECURITY.md](SECURITY.md) for private reporting.
