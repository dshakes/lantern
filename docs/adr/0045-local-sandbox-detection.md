# ADR 0045 — Local sandbox detection for `dev` (Firecracker via Lima on macOS)

**Status:** Accepted
**Date:** 2026-10-29
**Deciders:** Platform team

---

## Context

With no scheduler address the control-plane uses `stubSchedulerClient`: it
fabricates vm ids and spawns nothing. `dev` never set a scheduler address, so on
every laptop the design-time loop silently ran against the stub. Real
Firecracker on a Mac already worked inside the Lima guest
(`infra/lima/firecracker-dev.yaml`, `make lima-e2e`), but only as a one-shot
test; nothing connected it to the dev stack.

## Decision

1. **One detection, two consumers.** `packages/cli/internal/cli/sandbox_mode.go`
   `detectSandbox` picks `firecracker` (Linux + usable `/dev/kvm` + firecracker,
   manager on `localhost:50054`), `lima` (macOS, Lima VM `firecracker-dev`
   `Running`, manager on `localhost:52054`), `docker` (a manager on `:50054`
   without KVM), or `stub`. `dev` prints it as one `sandbox:` line; `doctor`
   shows it as the first Sandbox-runtime check. A mode is chosen **only when its
   manager answers on TCP** — host capability alone never yields a non-stub
   mode, and a forwarded port alone never yields `lima` (the VM must be
   `Running`). Stub always names the one command that fixes it.
2. **Wiring.** In a non-stub mode `dev` starts (or reuses) the runtime-scheduler
   on `:50055` with `PAL_DEFAULT_MANAGER_ADDR=<detected manager>` and starts the
   API with `PAL_SCHEDULER_GRPC_ADDR=localhost:50055`. Names are `PAL_*` and
   reach the binaries' `LANTERN_*` reads through `palenv.Bridge` (ADR 0032).
3. **Lima topology.** `make lima-runtime` runs a long-lived, jailed Firecracker
   runtime-manager inside the guest on `0.0.0.0:52054`. Lima's default port
   forwarding exposes it as the Mac's `localhost:52054`; it self-registers by
   heartbeating the host scheduler at `host.lima.internal:8085` and advertises
   `localhost:52054`. Scheduler and API stay on the host (pure Go, no KVM need).
   `52054` avoids a host Docker manager on `50054` and `make lima-e2e`'s
   in-guest `50054`.

## Consequences

- The local loop is honest: a developer either has real microVMs or reads, in
  one line, that they do not and how to get them.
- **Dev-only security posture** for `lima-runtime`: plaintext gRPC, no service
  token, `LANTERN_ENV` unset — the manager's existing dev defaults. It binds
  inside the VM's private NAT network and is forwarded only to the Mac's
  loopback. Production keeps its fail-closed guards (mTLS, service token)
  unchanged; nothing here relaxes them.
- The Firecracker backend boots the harness rootfs from `make lima-image`
  (static busybox) and runs the spec's command; it does not pull
  `imageDigest`. Image-based workloads stay on the Docker tier locally and on
  K8s (gVisor/Kata) in the cloud. The agent spec (`agent.yaml`) is the same
  artifact in both places; only the API URL and key change.
- When `dev` reuses an existing scheduler (e.g. a LaunchAgent), that scheduler
  may also know a Docker-backend node; placement can pick either.

## Alternatives considered

- **Run the scheduler in the guest too.** Needs a Go toolchain or a
  cross-compiled binary in the VM for no isolation benefit.
- **Auto-start `lima-runtime` from `dev`.** Builds Rust in the VM on every dev
  start and contends with other in-VM runs; left as an explicit command that
  `dev`'s stub line names.
