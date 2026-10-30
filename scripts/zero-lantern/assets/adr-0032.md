# ADR 0032 — Rename to PAL

- **Status:** Accepted (owner, 2026-10-29). Completed 2026-10-30.
- **Relates to:** ADR 0001 (language stack), ADR 0008 (secret relay), ADR 0025 (spawn contract), ADR 0026 (egress broker)

## Context

The owner decided the brand is **PAL** (Personal Agentic Layer): PAL the personal agent and PAL
Runtime the platform. The goal: the previous product name appears nowhere — not in code, docs,
identifiers, wire names, file names or the README — and nothing breaks.

The old name was not just prose. It was in about 1,100 files: environment variables, the protobuf
package (part of every gRPC method path), HTTP headers, secret refs, well-known URLs, K8s
namespaces, kernel boot-args, Postgres names, cookies and localStorage keys, bot-self echo
prefixes, launchd labels, binaries, package names, the Go module path and the repo name.

## Decision

1. **Staged, then cut over.** The rename first landed in revertible PRs that made both names work
   (env compat helpers, dual-accept readers, deprecated SDK aliases), so the live bridges and API
   kept running throughout. Once every reader understood the PAL names, a final pass removed the
   old name and every compat layer in one change.
2. **The final pass is a codemod** (under `scripts/`, removed once the last in-flight PR landed): ordered, idempotent steps (remove the
   compat layers, `git mv` paths, rewrite content, collapse the now-identical dual reads, add the
   DB rename migration, regenerate `gen/go` from `packages/proto/pal/v1`, install this ADR and the
   strict allowlist, format, verify). It can be re-run after merging `master` until the last
   in-flight PR has landed.
3. **One name per thing.** `PAL_*` env vars only, the `pal.v1` proto package (`/pal.v1.*` gRPC
   paths), `x-pal-*` headers, `pal.secret/` refs, `/.well-known/pal-*`, `pal-t-<tenant>`
   namespaces, `pal.dev/*` labels, `/run/pal` and `/var/lib/pal` in guests, `pal-*` crates and
   binaries, the `github.com/dshakes/pal` Go module, the `pal` / `pal_app` dev database names.
   There are no fallbacks: a process configured with the old names starts with defaults, so the
   operator cutover (env files, launchd labels, the state directory, DB user/role) runs before
   the new binaries start. The contract the cutover follows is listed in the PR.
4. **Persisted data is migrated, not aliased.** Migrations are append-only, so the historical
   migration files keep their SQL semantics; the role name in them is updated textually (the
   runner, golang-migrate, records only versions — no checksums), and a new migration
   (`pal_brand_rename`) renames what an existing database still carries: the restricted RLS role
   (`ALTER ROLE ... RENAME` keeps grants, but clears an MD5 password — the cutover resets it),
   tenant K8s namespaces, the at-rest encryption envelope marker, stored secret refs and env keys.
   Tables whose rows are hashed or signed (`journal_events`, `run_receipts`,
   `marketplace_invocations`) are not rewritten.
5. **Brand gate.** `scripts/brand-check.sh --enforce` runs in the required `lint` CI job and fails
   on any occurrence of the old name outside `scripts/brand-allowlist.txt`. The allowlist holds
   only what cannot avoid the name, each with its reason: the gate itself, the codemod, the DB
   rename migration, and one wire name kept for a single release — the signal-token header the
   owner's already-installed iPhone Shortcuts send to `/v1/signals`, until they are re-pointed
   at `x-pal-signal-token`.

## Consequences

- Externally visible names changed (env vars, headers, gRPC paths, well-known URLs, CLI binary,
  SDK class names, Homebrew formula, iOS Shortcut header, WhatsApp device name). The release
  notes list them; anything outside this repo that still sends an old name must be updated.
- A baked microVM image or data plane built before the rename speaks the old wire names and must
  be rebuilt from this tree.
- The owner's iPhone Shortcuts are updated by the owner (`x-pal-signal-token`, Shortcut names);
  `/v1/signals` accepts their old header for one release, then the allowlist entry and the
  fallback are deleted together.
- A WhatsApp re-pair may be needed because the linked-device name changed.

## Alternatives considered

- **Keep the compat layers forever.** Leaves the old name in env readers, wire aliases and SDK
  exports indefinitely; rejected by the owner ("no references anywhere").
- **Brand-only rename (prose and UI), keeping identifiers.** Rejected for the same reason.
