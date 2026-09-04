# Lantern services as macOS LaunchAgents

Prod-grade always-on setup so the bridges **and the backend services**
(API, dashboard, gateway, model-router, workflow-engine, runtime-manager,
runtime-scheduler) auto-start at login and auto-restart if they crash. Use
this when you want Lantern running 24/7 on your Mac without typing
`make run-*` each time.

## Install

```bash
# Both bridges:
./scripts/launchd/install.sh

# Just one:
./scripts/launchd/install.sh whatsapp
./scripts/launchd/install.sh imessage
```

The installer:

1. Reads the template plists in this directory.
2. Substitutes `__NODE__`, `__REPO_ROOT__`, `__HOME__` with real paths.
3. Writes them to `~/Library/LaunchAgents/`.
4. Loads them via `launchctl load`.

Logs land in `~/Library/Logs/Lantern/<bridge>.{out,err}.log`. Tail with:

```bash
tail -f ~/Library/Logs/Lantern/imessage-bridge.err.log
tail -f ~/Library/Logs/Lantern/whatsapp-bridge.err.log
```

## Service wiring lives in one place

The `make run-*` targets and the plists used to define the same ports and
addresses separately, and they agreed only by luck. When they drifted the
failure was silent: `dev.lantern.runtime-manager.plist` was missing
`SCHEDULER_URL`, so under launchd the runtime-manager never self-registered —
the scheduler marked the node draining and every placement failed with
`FailedPrecondition`, while the manager process itself stayed healthy and
logged nothing alarming. It only ever worked when someone happened to start it
with `make run-runtime-manager`, which did set the variable.

Shared defaults now live in **`scripts/launchd/service-env.sh`**, sourced by
both `run-microservice.sh` (the launchd path) and the `make run-*` targets.
Each entry uses `: "${VAR:=default}"`, so precedence is:

1. Anything already exported — a plist's `EnvironmentVariables`, or an
   operator running `SCHEDULER_URL=... make run-runtime-manager`
2. The shared defaults

A plist can still override for a real multi-node deployment; the shared file
only guarantees a sane single-host value is never simply *absent*.

Verify before you trust it:

```bash
make check-launchd-env
```

That fails if a plist is missing wiring its service cannot run without, or if
a plist and the shared defaults disagree. Worth running after editing either.

## Credential encryption (`LANTERN_CREDENTIAL_KEY`)

Connector OAuth tokens and LLM API keys are AES-256-GCM encrypted at rest in
Postgres. The master key is `LANTERN_CREDENTIAL_KEY`: a **base64- or
hex-encoded 32-byte** value you generate yourself — it is not issued by any
provider.

```bash
openssl rand -hex 32
```

It lives in **`~/.lantern/control-plane.env`** (mode `0600`), sourced only by
`run-api-wrapper.sh`. Deliberately *not* in `bridge.env`: that file is also
sourced by the dashboard and both bridge wrappers, and none of them need the
key. Least privilege — it exists only in the process that encrypts with it.

When the variable is unset, storage silently falls back to plaintext. That is
fine for a scratch database and wrong everywhere else; `LANTERN_ENV=prod`
refuses to boot without it.

### Back the key up

Losing it makes every encrypted credential permanently unreadable. This is not
hypothetical — it already happened here: the Gmail and Google Calendar tokens
were written under a key that was later lost, so they decrypt to nothing and
those connectors must be re-authorized. No tool can recover them.

### Re-encrypting after setting or rotating a key

Setting a key does not retroactively encrypt existing rows; `internal/secrets`
detects legacy plaintext on read and re-stores it encrypted only on the next
write, which for an API key may be never. To do it now:

```bash
cd services/control-plane
LANTERN_CREDENTIAL_KEY=... DATABASE_URL=... go run ./cmd/reencrypt-credentials -dry-run
LANTERN_CREDENTIAL_KEY=... DATABASE_URL=... go run ./cmd/reencrypt-credentials
```

Each row is decrypted back and compared byte-for-byte before the transaction
commits; a mismatch aborts everything. Rows already encrypted under the current
key are skipped, so it is idempotent. Values encrypted under a *different* key
are reported and left untouched.

The same command is the re-encrypt half of a key rotation (ADR 0008).

## Go services build a binary, not `go run`

Every Go service — control-plane, runtime-scheduler, workflow-engine — compiles
to `services/<svc>/bin/<name>` and is exec'd. `go run` compiles to a temp binary
and then *supervises* it, so the process tree was:

```
launchd → go run → server      ← launchd's pid is the wrapper
launchd → server               ← what we have now
```

With the wrapper in between, signals land on the wrong process: `launchctl
kickstart -k` and a plain `kill` both leave the real server orphaned and still
holding its port, so the next start dies with "address already in use".

The binary is rebuilt whenever a `.go` file is newer than it, which preserves
the one property `go run` gave us for free — pulling source is enough to pick
up changes on the next restart.

Shared launch helpers (`wait_port`, `run_go`, `run_rust`) live in
`scripts/launchd/lib.sh`, sourced by both `run-microservice.sh` and
`run-api-wrapper.sh`.

## Deploy: `make deploy-local`

A merge is not a deploy. `launchctl kickstart -k` restarts a process, but for
a Rust service that means re-exec'ing the same `target/release` binary — `run_rust`
only builds when the file is *missing*. In one fortnight three services ran
weeks-old code after their fixes were merged: the control-plane on a July
build (a metering bug that failed 11,074 times), both bridges on an August
build, and two Rust binaries still carrying a patched DoS.

```bash
make deploy-local          # rebuild/restart only what changed since the running process
FORCE=1 make deploy-local  # restart everything
```

What it does, per service class:

| Class | Deploy means | Decided by |
|---|---|---|
| Rust (gateway, model-router, runtime-manager, surface-gateway) | `cargo build --release` **then** restart | sources newer than binary → build; binary newer than process → restart |
| Go (api, runtime-scheduler, workflow-engine) | restart (`run_go` rebuilds on start) | sources newer than the running process |
| Bridges (tsx from `src/`) | restart | `services/<bridge>/src` or `packages/bridge-core/src` newer than the process |

Then it **proves** it: every restarted service must have a process whose start
time is after the run began, or the script exits non-zero with `DEPLOY
INCOMPLETE`. It refuses to run off `master`, with uncommitted changes, or when
master cannot fast-forward to `origin/master` — it ships committed master and
nothing else. "REBUILT" is printed only when cargo actually wrote a new binary;
a lockfile whose git mtime moved with nothing to compile prints `no-op`.

## macOS permissions (iMessage bridge)

LaunchAgent-spawned processes get their own permission identity — the
grants you gave your terminal app DO NOT carry over. Re-grant for the
new launchd process:

1. **Full Disk Access** — needed to read `~/Library/Messages/chat.db`.
   - System Settings → Privacy & Security → Full Disk Access
   - Click `+`, navigate to your Node binary (typically
     `/opt/homebrew/bin/node` on Apple Silicon, `/usr/local/bin/node`
     on Intel — the installer prints the exact path).
2. **Automation** — needed to send via Messages.app.
   - System Settings → Privacy & Security → Automation
   - First send will trigger the prompt. Allow.

## Status / stop / start

```bash
launchctl list | grep lantern      # see what's loaded
launchctl unload ~/Library/LaunchAgents/dev.lantern.imessage-bridge.plist  # stop
launchctl load ~/Library/LaunchAgents/dev.lantern.imessage-bridge.plist    # start
```

## Uninstall

```bash
./scripts/launchd/install.sh --uninstall
```

Removes both plists from `~/Library/LaunchAgents` and unloads them.

## Editing config (e.g., changing API URL or ports)

The installer copies the plist with substitutions baked in — editing the
template here does NOT update the installed version. To change config:

1. Edit the template plist in this directory.
2. Re-run the installer: `./scripts/launchd/install.sh`.

OR edit the installed plist directly at
`~/Library/LaunchAgents/dev.lantern.<bridge>-bridge.plist`, then:

```bash
launchctl unload ~/Library/LaunchAgents/dev.lantern.imessage-bridge.plist
launchctl load   ~/Library/LaunchAgents/dev.lantern.imessage-bridge.plist
```

## Troubleshooting

**Bridge not responding on its port**: check the err log.

```bash
tail -20 ~/Library/Logs/Lantern/imessage-bridge.err.log
```

Common causes:
- Node binary moved (homebrew upgrade reshuffled paths). Re-run installer.
- Repo path changed. Re-run installer.
- Permission denied reading chat.db. Re-grant Full Disk Access to the
  exact Node binary path from `which node`.

**Bridge crash-loops**: KeepAlive only respawns on crash, not clean exit.
ThrottleInterval=10s prevents tight loops. If you see repeat crashes
in the err log, check that:
- Postgres is running (`make dev-infra`)
- Control-plane is running (`make run-api`)
- `LANTERN_API_URL` in the plist matches your control-plane host
