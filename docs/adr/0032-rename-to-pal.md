# ADR 0032 — Rename PAL to PAL

- **Status:** Accepted (was Proposed; accepted by the owner 2026-10-29)
- **Relates to:** ADR 0001 (language stack), ADR 0008 (secret relay), ADR 0025 (spawn contract), ADR 0026 (egress broker)

## Context

The owner has decided the brand is **PAL** (Personal Agentic Layer): PAL the personal agent and
PAL Runtime the platform. The goal is "no references of pal" and "nothing should break".

`pal` is not just prose. It is in about 1,100 files and 14,000 places: environment variables
(`PAL_*`), the protobuf package (`pal.v1`, which is part of every gRPC method path), HTTP
headers, secret refs (`pal.secret/...`), well-known URLs, K8s namespaces (`pal-t-<tenant>`),
kernel boot-args (`pal.env.*`), Postgres names, cookies and localStorage keys, bot-self echo
prefixes, launchd labels, binaries, package names, the Go module path and the repo name.

Some of these names are persisted or shipped outside this repo: in baked microVM images, customer
data planes, rows at rest, the owner's iPhone Shortcuts and late iCloud echoes. Renaming them in
one step breaks running systems. The live bridges and API on the owner's Mac run from `master` and
read `PAL_*` today.

## Decision

1. **Staged rename, each PR revertible and CI-green.** Compat comes first, then renames (readers
   before writers), then a CI gate. The PR sequence is in the rename plan:
   0 this ADR and the brand report · 1 env compat helpers and security filters · 2 env read
   sweep · 3 wire dual-accept readers · 4 writers flip · 5 dashboard storage keys · 6 bridge brand
   strings and bot-self prefixes · 7 prose/UI/docs · 8 internal identifiers · 9 public SDKs with
   deprecated aliases · 10 metrics/helm · 11 binaries and CLI `pal` (alias `pal`) · 12 repo
   rename (owner) · 13 Go module path · 14 brand gate enforced in CI.
2. **Env compat: PAL wins, PAL still works.** For every `PAL_X` or `PAL_X`, the process sees
   both names. When both are set and differ, `PAL_X` wins, with one exception: an **empty**
   `PAL_X` never overrides a non-empty `PAL_X` and is treated as unset. Otherwise a stray
   `PAL_CREDENTIAL_KEY=` would switch off at-rest encryption, and `PAL_GRPC_SERVICE_TOKEN=` would
   switch off service auth. Only the key name is logged, never a value. There is one helper per
   language:
   - Go: `packages/palenv` (`Bridge()` is the first statement of every shipped `main()`; `Get` reads
     with fallback, for libraries).
   - TS: `packages/bridge-core/src/env-compat.ts` (the first import in both bridge entrypoints; it
     re-runs after `loadEnvFile`).
   - Rust: `packages/pal-env-rs` (`pal_env::var`, read-only, because `set_var` is unsafe in edition
     2024). **It is not wired into any read site until step 2.** Until then, Rust services
     (runtime-manager, harness, gateway, model-router, surface-gateway) read only `PAL_*`.
   - Python: `pal/_env.py`.
   - Shell: `${PAL_X:-${PAL_X:-default}}`.
3. **Security filters treat both namespaces the same, in the same PR as the helpers.** Several trust
   boundaries filter by the `PAL_` prefix. Once PAL compat exists, a `PAL_*` key must not slip
   past any of them:
   - the harness workload env filter (`supervisor.rs::workload_may_see`): `PAL_*` is withheld like
     `PAL_*`, the 14 visible keys are accepted under both names and both names are emitted to
     the workload;
   - the harness spawn-contract filter (`bootenv.rs::caller_key_allowed`) and the manager's
     caller-env sanitizer (`own_workload_env`). Both drop **every** caller-supplied `PAL_*` key,
     including the twins of legitimate caller keys such as `PAL_AGENT_INSTANCE_TOKEN`. Nothing
     upstream stamps or replaces identity under the `PAL_` name yet, so a `PAL_` twin would be
     chosen by the caller, and once the harness prefers `PAL_` it would authenticate VendSecret.
     These filters relax only when the writers flip (step 4).
   - the identity writers, as defense in depth: the control plane's stamp site
     (`stampAgentIdentity`) and the scheduler's fork `withIdentity` delete the `PAL_` identity
     names before writing the `PAL_` ones, and `redactSpecSecrets` redacts both token names.
   - the `PAL_WORKLOAD_UID` drop in the Firecracker spawn contract and boot-args;
   - the dev `EnvSecretResolver` (`PAL_SECRET_*` before `PAL_SECRET_*`).
   Each has a test, and each test was mutation-checked: with the PAL branch removed, the test fails.
4. **Permanent allowlist.** These names stay as internal wire or data names forever, and are
   listed with reasons in `scripts/brand-allowlist.txt`:
   - proto package `pal.v1` and its directory. It is in every gRPC path, in baked VM images and
     on customer data planes. The Go import alias may change.
   - `pal-t-` namespaces and `pal-run-` handles, which are persisted.
   - `/.well-known/pal-*`. The `pal-*` paths are served too.
   - `pal.secret/` refs, which are user data at rest. Both forms are accepted.
   - `pal.env.*` boot-args and the guest-visible `PAL_*` keys (dual-emitted), for old images.
   - `x-pal-signal-token`, used by the owner's iPhone Shortcuts.
   - the legacy bot-self prefixes, for late echoes.
   - DB name, user and role (`pal`, `pal_app`). `ALTER ROLE ... RENAME` clears an MD5
     password.
   - the checkout directory.
5. **Brand gate.** `scripts/brand-check.sh` counts `pal` hits in tracked files that the
   allowlist does not cover. `--report` is the default. `--enforce` is required in CI only at step 14.

## Consequences

- During the transition both names work, so operators can migrate env files at their own pace.
  `~/.pal/bridge.env` keeps working without edits.
- **Operator checklist until step 2 lands:**
  - Keep every `PAL_*` variable set for the Rust services. They do not read `PAL_*` yet, so a
    `PAL_`-only env silently falls back to defaults there.
  - Go and TS processes accept either name.
  - Do not rely on an empty `PAL_X` to clear a setting; unset `PAL_X` instead.
- In the iMessage bridge, the process env (launchd plist, `bridge.env`) beats the env files
  (`.env`, `~/.pal/imessage.env`). `process.loadEnvFile` never overrides a key that is already
  set, and the import-time bridge has already copied `PAL_X` into `PAL_X`. So a `PAL_X` in an
  env file is ignored whenever the process env carries `PAL_X`. Migrate the process env first,
  or both together.
- A process started by a bridged Go/TS parent sees `PAL_X` mirrored from `PAL_X`. A parent that
  overrides `PAL_X` for a child must set `PAL_X` too, or the child's bridge will prefer the stale
  mirror. The CLI's `pal dev` does this.
- Every new prefix-based env filter must handle both namespaces. The harness and manager tests
  check this.
- The allowlist never shrinks for wire/data names. Legacy readers are never removed.
- Owner-only steps (repo rename, registries, DNS, webhook URLs, trademark clearance) are outside
  this repo and are tracked in the plan.

## Alternatives considered

- **Big-bang rename.** This breaks baked images, customer data planes, persisted refs and the live
  bridges. Rejected.
- **Brand-only rename (prose and UI), keeping every identifier.** This does not meet the owner's
  "no references" goal. The allowlist and gate make the remaining names explicit and justified.
