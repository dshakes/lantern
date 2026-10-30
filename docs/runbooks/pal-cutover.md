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

## Exact commands

```bash
cd ~/workspace/lantern
git fetch origin && git checkout origin/master -- scripts/cutover   # get the tool without moving the checkout
scripts/cutover/pal-cutover.sh plan          # read-only. Must end with "0 preflight failure(s)"
scripts/cutover/pal-cutover.sh apply         # the cutover
scripts/cutover/pal-cutover.sh verify        # re-run the post-checks whenever you like
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
5. **state-move**: `mv ~/.lantern ~/.pal` (the same-volume check passed in
   preflight), then `ln -s ~/.pal ~/.lantern`.
6. **env**: renames `LANTERN_*` → `PAL_*` in `~/.pal/*.env`, leaving values
   untouched, and writes the files `0600`.
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
scripts/cutover/pal-cutover.sh rollback                      # newest ~/pal-cutover-backup-*
scripts/cutover/pal-cutover.sh rollback ~/pal-cutover-backup-<ts>
scripts/cutover/pal-cutover.sh verify --old
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
by three failure injections: after the state move, after the DB rename, and
a build failure after checkout. Each must auto-roll back to a snapshot
byte-identical to the start. The snapshot covers file checksums and modes,
plists, launchd jobs, git HEAD/remote/worktree, the DB data checksum and the
role verifiers. Expected result: `52 passed, 0 failed`.
