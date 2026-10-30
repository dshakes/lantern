# Runbook: cut the always-on Mac over from Lantern to PAL

This moves the machine that runs the product (both bridges, the control-plane
API, the dashboard and the runtime services under launchd) from the old names to
the PAL names in one supervised pass, and can put it back exactly as it was.

| What | Before | After |
|---|---|---|
| launchd labels | `dev.lantern.*` | `dev.pal.*` |
| state dir | `~/.lantern/` | `~/.pal/`, moved with one `rename(2)`. `~/.lantern` stays as a symlink unless the contract turns that off. |
| env keys in `~/.pal/*.env` | `LANTERN_X=…` | `PAL_X=…`. Values are byte-identical and every file is written `0600`. |
| plist `EnvironmentVariables` | `LANTERN_X` | `PAL_X`. Keys that exist only in the live plist (secrets, the tunnel URL) are carried over. |
| logs | `~/Library/Logs/Lantern/` | `~/Library/Logs/PAL/` (old logs stay where they are) |
| Postgres | db/user `lantern`, role `lantern_app` | renamed in place to the names in the contract (`pal` / `pal_app`), with passwords reset from the new config |
| checkout | stale `master`, origin `dshakes/lantern` | origin `dshakes/pal`, at the release commit, rebuilt |

The tool is `scripts/cutover/pal-cutover.sh`. It takes every name from
`scripts/cutover/pal-cutover.contract`, which mirrors the zero-lantern contract.
(Edit the unpacked copy in `~/pal-cutover-tool`, or override any value from the
environment, e.g. `DB_NEW_NAME=lantern $T plan`.)
**If the contract keeps a name, set the old and new values to the same thing in
the contract file.** Each step whose names don't change does nothing. For
example, if the DB stays `lantern`, set `DB_NEW_NAME=lantern`, and likewise for
`DB_NEW_USER` and `DB_NEW_APP_ROLE`. The script itself needs no change.

## Prerequisites

1. **The release is merged to `master`.** The PRs that make the code expect the
   contract names must be on `origin/master`. `plan` checks this for you: it
   fails if the release still hardcodes `"lantern_app"`, if its plist
   `DATABASE_URL` doesn't name the new DB/user, if bridge-core never mentions
   `.pal`, if the bridges don't read `PAL_BRIDGE_TOKEN`, or if the compose
   project or volume names changed. A changed compose project or volume name
   would make `infra` boot an **empty** database.
2. **The checkout has no uncommitted changes.** Today
   `services/imessage-bridge/src/session.ts` and its test are modified. The
   bridges run straight from `src/`, so those changes may be what is live right
   now. Commit them, or run with `PAL_CUTOVER_STASH=1`. That stashes them,
   and rollback re-applies the stash.
3. Docker Desktop is up and `docker-postgres-1` is healthy.
4. At least ~2 GB free in `$HOME` for the backup (state is 17 MB, the DB is about
   540 MB, and WhatsApp creds plus bridge state are about 60 MB).
5. You have 30 minutes when a short bot outage is acceptable.
6. You're at the Mac, logged in to the GUI session. launchd user agents live
   in `gui/<uid>`.

## The database schema is ahead of the running code (decide BEFORE apply)

The control-plane embeds its migrations
(`services/control-plane/internal/db/migrations/`) and runs golang-migrate
`Up()` at boot. When the database's `schema_migrations.version` is **higher**
than the newest migration the binary embeds, `Up()` fails with
`no migration found for version N` and **the API does not start**.

On 2026-10-30 the live `lantern` DB was at **v31**, because agent test runs
migrated it. The checkout everything runs from (`a2e6ae2c`) embeds only up to
**0022**. Two consequences:

- **The API running right now cannot restart.** It has been up since Oct 25.
  Any kickstart, crash or reboot leaves it down. Don't restart it before the
  cutover.
- **A rollback to the pre-cutover commit cannot start the API either.**
  Restoring the DB dump brings back v31, not v22.

`plan` and `apply` check this in a "schema version vs. embedded migrations"
section:

| Check | Result when the DB is ahead |
|---|---|
| the release commit | **FAIL**: the cutover would leave the API down; pick a release that embeds ≥ the DB version |
| the current checkout | WARN: what is running now cannot restart |
| the rollback target | **FAIL** until you choose one of the two options below |
| a dirty `schema_migrations` | **FAIL**: a migration failed half-way; fix that first |

Rollback runs the check again against the checkout it is about to start, and so
does `verify --old`. Either prints `FAIL rollback checkout / running checkout:
… is at schema vN but … embeds migrations only up to M`, so an API that won't
start can't be mistaken for a clean rollback.

**Your choice (pick one before `apply`):**

1. **Roll back to the release commit** (recommended). Run
   `PAL_CUTOVER_ROLLBACK_REF=<release sha> $T plan`, then the same variable on
   `apply` and on `rollback`. Rollback still restores every name: the
   `dev.lantern.*` agents, `~/.lantern`, the `LANTERN_*` env keys, the DB dump
   and the old remote. Only the code stays at the release, which can start
   against v31. This works only if the release still reads the old names
   (the compat fallbacks in PAL-RENAME-PLAN: `PAL_*` with `LANTERN_*`
   fallback, `~/.pal` then `~/.lantern`). `plan` doesn't prove that, so treat
   it as **roll forward only** if those fallbacks were removed.
2. **Roll forward only.** Run `PAL_CUTOVER_ROLL_FORWARD_ONLY=1 $T apply`.
   Rollback still restores names, state, plists and the DB, but the API stays
   down until a commit that embeds ≥ v31 is checked out. The rollback exits
   non-zero and says so. If the cutover fails, the fix is to repair forward.

There is no safe way to "down-migrate" the live DB to v22: the extra tables
(`brief_items`, `pal_region_fence`, …) were created by migrations that the old
code doesn't know about.

## Exact commands

```bash
cd ~/workspace/lantern && git fetch origin
# Unpack the tool OUTSIDE the checkout: checking it out into the checkout would
# itself be a tracked change, and preflight refuses a dirty tree.
mkdir -p ~/pal-cutover-tool && git archive origin/master scripts/cutover | tar -x -C ~/pal-cutover-tool
T=~/pal-cutover-tool/scripts/cutover/pal-cutover.sh   # REPO_DIR in the contract is absolute, so it can run from anywhere
$T plan          # read-only. Must end with "plan summary: 0 failure(s)"
$T apply         # the cutover
$T verify        # re-run the post-checks whenever you like
```

`plan` changes nothing and does not fetch. It prints every action `apply` would
take, plus each rendered plist's env key **names**:

- renamed
- carried over from the live plist
- template value wins (only `DATABASE_URL` and `PATH`)
- live override kept (for example the dashboard's `NEXT_PUBLIC_API_URL`)

No secret value is ever printed. Read the WARN lines before you apply.

`apply` runs these steps in order. It journals each one to
`~/pal-cutover-backup-<ts>/journal`:

1. **preflight**: the same checks as `plan`, plus `git fetch` from the
   renamed repo. Any failure exits before anything changes.
2. **render**: builds every `dev.pal.*` plist into the backup's `work/`
   directory, using the release templates and merging in the live plist env.
3. **stop**: `bootout` the bridges first, then the dashboard, then everything
   else. It then checks with `lsof` that nothing still holds files open under
   `~/.lantern` or the in-repo state.
4. **backup**: the backup goes to `~/pal-cutover-backup-<ts>/`. The directory
   is `0700` and every file in it is `0600`:
   - `state.tgz` (`~/.lantern`)
   - `plists.tgz` (every `dev.lantern.*`, including the `.bak`/`.tmp` strays)
   - `repo-state.tgz` (both `bridge_state/` dirs plus `auth_sessions/`)
   - `db.dump` (`pg_dump -Fc`), plus a checksum of a plain dump
   - `roles.tsv` (the two roles' password verifiers)
   - `git.env` and `worktree.patch`
   - `pre.snapshot` (the checksum manifest rollback compares against)
   - `SHA256SUMS`

   Each archive is listed back, entry counts are compared and the dump is
   read with `pg_restore -l`. This runs **after** the stop, so the snapshot
   is consistent.
5. **state-move**: renames `~/.lantern` to `~/.pal` with a single `rename(2)`
   (the same-volume check passed in preflight), then `ln -s ~/.pal ~/.lantern`.
   Immediately before the rename it checks again that `~/.pal` doesn't exist.
   An **empty** `~/.pal` is replaced; a **non-empty** one fails the step and
   triggers rollback. During the live cutover something wrote
   `~/.pal/credentials.json` after preflight, and a plain `mv` then moved the
   state *into* it (`~/.pal/.lantern`), so every service booted with empty
   state. The rename can no longer nest. Afterwards the step asserts that a
   known file (`bridge.env`) is at the top of `~/.pal` and that
   `~/.pal/.lantern` doesn't exist. Rollback only moves `~/.pal` aside if the
   cutover put the state there.
6. **env**: renames `LANTERN_*` → `PAL_*` in `~/.pal/*.env`, leaving values
   untouched, and writes the files `0600`. It fails if it finds a different
   number of `*.env` files than the old directory had. Finding zero used to
   pass silently.
7. **db**: creates a temporary superuser (a session cannot rename its own
   user), ends any remaining sessions, renames the DB and both roles, sets the
   main user's password from the new `DATABASE_URL` and the app role's from
   `PAL_APP_DB_PASSWORD` if set. It then drops the temporary role and proves
   a TCP password login.
8. **plists**: installs `dev.pal.*` (`0600`, checked with `plutil -lint`) and
   moves every `dev.lantern.*` into the backup's `retired-plists/`.
9. **git**: points `origin` at `dshakes/pal`, then fast-forwards `master`
   to the release commit.
10. **build**: runs `npm install` in both bridges, `cargo build --release` for
    the 4 Rust services and `go build` for the 3 Go services, then rebuilds
    the dashboard from a clean `.next`. The wrapper never rebuilds an existing
    dashboard bundle, so a restart alone would keep serving the old UI.
    Each `npm` runs under **the node that service actually runs under**,
    because native modules (lightningcss, tailwind-oxide, next-swc) are built
    per CPU architecture:
    - the dashboard uses the node its plist `PATH` resolves. Live, that was
      `/usr/local/bin/node`, which is x64 under Rosetta.
    - the bridges use the newest nvm node, which is what
      `run-bridge-wrapper.sh` execs.

    Live, the build used the arm64 nvm node while the dashboard ran under x64,
    so the x64 native modules were missing and the dashboard returned 500. The
    step prints each node path and architecture, and fails unless
    `.next/standalone/server.js` exists. Without it, the wrapper starts a
    `next build` on first boot, which outlasts the health window. The
    dashboard health check now waits up to `DASHBOARD_TIMEOUT_SECS`
    (default 900 s).
11. **start**: bootstraps every agent that was loaded before, in dependency
    order, retrying the known "bootstrap failed and left it down" case.
12. **health**: see the next section.

If any step 3–11 fails, `apply` **rolls back automatically** and exits 1. To
stop and inspect instead, set `PAL_CUTOVER_AUTO_ROLLBACK=0`. A failed
**health** check does *not* auto-roll back, because a slow WhatsApp reconnect
is not a reason to undo a good cutover. It exits 2 and tells you to look, or
to run `rollback`.

### Expected output (abridged)

```
=== preflight
  ok    state dir /Users/shakes/.lantern (329 entries, 17M)
  ok    same volume: mv is a single atomic rename(2)
  ok    env bridge.env: 11 keys to rename, 0 duplicates
  ok    loaded dev.lantern.* jobs: api dashboard whatsapp-bridge imessage-bridge …
=== release readiness (origin/master)
  ok    template dev.pal.api.plist
  ok    no Go code hardcodes role "lantern_app"
  ok    compose project/volume names unchanged
=== backup → /Users/shakes/pal-cutover-backup-2026…
  ok    state.tgz 329 entries, plists 27, dump 120M (… tables), checksums verified
=== database: lantern/lantern/lantern_app → pal/pal/pal_app
  ok    TCP password login as pal@pal
=== health (new side: dev.pal.*)
  ok    API http://localhost:8080/healthz → 200
  ok    WhatsApp session connected (no QR)
  ok    iMessage chat.db open (lastSeenRowid …)
=== CUTOVER COMPLETE in …s — backup: /Users/shakes/pal-cutover-backup-…
```

### Health checks (`verify`)

- Every agent that had a pid before has one again. One-shot agents (`infra`,
  `introspect`, the watchers) only need to be loaded.
- The API `/healthz` returns 200, and the dashboard returns 200 (following the
  `/login` redirect).
- Both bridges answer `/health`.
- The bridge tokens come from `~/.pal/bridge.env`, parsed exactly as the
  wrapper's `set -a; . bridge.env` sees them: `export`, quotes and inline
  `# comments` are handled. A key missing from the file, or empty after
  parsing, is reported by **name** as a FAIL. Before this fix a wrong parse
  showed up only as `status.connected=?` while WhatsApp was in fact connected.
- WhatsApp `status.connected=true` and `has-creds=true` with **no QR**. The
  creds live in `services/whatsapp-bridge/auth_sessions/`, inside the checkout,
  and the cutover doesn't move them. If a contract ever moves them, `apply`
  moves them and compares the tree checksum.
- iMessage `diagnostics.chatDb.open=true`, and an `opened chat.db` line in the
  log.
- The last `LIVENESS:` line from each bridge is printed. These lines appear
  only while replies are being suppressed (mute, kill switch, pauses). None is
  good; a new `MUTED` or `kill switch` is not.
- The signals endpoint accepts `x-pal-signal-token`. This is a WARN rather than
  a failure while the release only accepts the old header.

**The self-chat round trip is not automated.** Send `?` in self-chat on
iMessage **and** on WhatsApp. Expect exactly one Brief on each, and no
echo/doubled replies for 10 minutes.

### Expected downtime

The bot is down from the stop step until the bridges are back up:

| Phase | Time |
|---|---|
| stop + backup | 2–4 min (most of it is dumping the 540 MB DB twice: archive + checksum) |
| state, env, DB, plists, git | under 30 s |
| build | the long pole. The checkout is about 365 commits behind, so the Rust release builds and the dashboard build take **5–15 min**. |
| start + health | 1–3 min (the WhatsApp reconnect is usually under 30 s) |

Plan for **~10–20 minutes**. **Messages that arrive in that window are not
auto-answered on iMessage.** On boot the bridge sets its `chat.db` watermark
to the current max rowid (`services/imessage-bridge/src/chat-db.ts`), so
anything older is skipped. Whether WhatsApp answers its offline backlog on
reconnect is not verified. Pick a quiet hour, and afterwards ask the bot
`what did I miss` in self-chat, or check both apps by hand.

## What you must do after

1. **iPhone Shortcuts:** change the request header from
   `x-lantern-signal-token` to `x-pal-signal-token` (same token value), and
   rename the Shortcuts if you want them to say PAL. Do this only after
   `verify` prints `signals endpoint accepts x-pal-signal-token`. The old
   header stays accepted (it's allowlisted), so nothing breaks in the gap.
2. **WhatsApp re-pair: should not be needed.** The creds don't move. If
   `verify` says "not connected", read
   `~/Library/Logs/PAL/whatsapp-bridge.err.log` **before** re-pairing.
   A Bad-MAC storm self-heals, and re-pairing costs you the session.
   `rollback` deliberately does **not** overwrite `auth_sessions/` from the
   backup: restoring an older Signal ratchet causes decrypt failures.
3. **macOS may show "Background Items Added"** for the new `dev.pal.*` labels.
   Allow them under System Settings → General → Login Items. Full Disk Access
   is granted to the node binary, not the label, so iMessage keeps it. If
   `chat.db not open` shows up, re-grant FDA to the path from `which node`.
4. The quick-tunnel URL changes whenever `tunnel` restarts, as it does on
   every restart. `tunnel-watcher` re-syncs Twilio and `PAL_PUBLIC_BASE_URL`.
   If your Shortcuts call the tunnel URL directly, update them.
5. Delete `~/pal-cutover-backup-<ts>/` once you're confident, perhaps after a
   week. It holds secrets: the env files, plists with tokens, and the DB.
6. Optional: to drop the `~/.lantern` compat symlink, first fix the WARN'd env
   values that contain `~/.lantern` paths (`PAL_PERSONAL_DOCS_ROOTS`, …).

## Rollback

```bash
$T rollback                      # newest ~/pal-cutover-backup-*
$T rollback ~/pal-cutover-backup-<ts>
$T verify --old
```

Rollback does the following:

1. Boots out every `dev.pal.*` and `dev.lantern.*` agent.
2. Sets the `dev.pal.*` plists aside and restores the archived `dev.lantern.*`
   set, strays included.
3. Removes the symlink, moves `~/.pal` aside and restores `~/.lantern` from
   `state.tgz`.
4. Renames the roles back and restores their exact password verifiers.
5. Renames the post-cutover DB to `<old>_postcutover_<ts>` and restores the
   old DB from `db.dump` with `pg_restore -C`. Post-cutover writes are kept
   in that renamed DB, never dropped.
6. Resets the checkout to the old commit and old remote, re-applies a stash,
   and rebuilds the old code. The Rust binaries share names, so the old code
   must be compiled again.
7. Compares a fresh snapshot with `pre.snapshot` and prints
   `snapshot IDENTICAL` or a diff.
8. Restarts the old agents and runs the old-side health checks.

Everything rollback sets aside goes to
`~/pal-cutover-backup-<ts>/rolledback-<ts>/`, so nothing written after the
cutover is lost.

- **Keep post-cutover DB writes instead:** run `rollback --db=rename`. It
  renames the DB back and skips the dump restore.
- **A late rollback:** if the PAL stack ran for hours, the snapshot diff will
  show repo-state drift in `bridge_state` (left alone on purpose, as is
  `auth_sessions`). The restored `~/.lantern` is the pre-cutover copy;
  post-cutover state is in `rolledback-<ts>/state-new`.
- **Downtime:** a rollback after the git step rebuilds the old commit and takes
  about as long as the cutover.

## How this was tested

`scripts/cutover/test-sandbox.sh` runs the whole thing against a synthetic
machine:

- a throwaway `HOME` under `/private/tmp` with fake `~/.lantern`, fake plists
  and fake secrets
- recorder stubs for `launchctl`, `docker`, `cargo`, `go`, `npm` and `curl`,
  selected by `PAL_CUTOVER_SANDBOX=1`, which refuses a real `HOME` or any DB
  name without `test` in it
- throwaway `cutover_test` DB and `*_test` roles in the dev Postgres, dropped
  at the end
- a synthetic repo with an old commit and a release commit

The run is plan → backup → apply → verify → rollback → verify --old, followed
by three failure injections, plus four schema-version cases (DB ahead of the
old code: plan refuses until a choice is made; DB ahead of the release: plan
refuses; rollback to `PAL_CUTOVER_ROLLBACK_REF`: everything but git is
identical; roll-forward-only: rollback and `verify --old` report the API cannot
start), plus the live-found cases (a non-empty `~/.pal` appearing mid-cutover
is refused without nesting; an empty one is replaced; an `export KEY="v"  # c`
token line; per-service node selection for `npm`). The failure injections are: after the state move, after the DB rename, and
a build failure after checkout. Each must auto-roll back to a snapshot
byte-identical to the start. The snapshot covers file checksums and modes,
plists, launchd jobs, git HEAD/remote/worktree, the DB data checksum and the
role verifiers. Expected result: `78 passed, 0 failed`.
