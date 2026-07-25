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

## Go services build a binary, not `go run`

`run-microservice.sh` compiles Go services to `services/<svc>/bin/<name>` and
execs that, rather than `go run`. `go run` supervises a child process in the
build cache, so launchd's pid is the wrapper and not the server — signals land
on the wrong process, and `launchctl kickstart -k` or a plain `kill` leaves an
orphan holding the port, so the next start fails with "address already in use".
The binary is rebuilt whenever a `.go` file is newer than it.

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
