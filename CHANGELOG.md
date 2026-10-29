# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is pre-1.0; there are no stable release branches yet.

---

## [Unreleased]

### Added
- **Host-asserted software measurement (ADR 0031, ACE A5)** — at every Firecracker
  spawn and restore the runtime-manager computes a SHA-256 over the five canonical
  inputs it directly controls: kernel image, rootfs image, harness binary (32 zero
  bytes when baked into rootfs), kernel boot arguments, and the spawn contract with
  secret and per-VM identity fields excluded (reproducible across VMs from the
  same images + spec). The 64-character hex measurement is:
  - Embedded in the per-VM X.509 cert as a custom extension (OID `1.3.6.1.4.1.99999.3`,
    a placeholder — a registered IANA PEN is needed).
  - Stored in `runtime_vms.software_measurement` (migration `0029_software_measurement`)
    via the reconciler after spawn completes.
  - Included in signed run receipts as `softwareMeasurement` (additive; omitempty
    keeps existing receipts byte-identical and their signatures valid).
  - Returned in `VmHandle.software_measurement` (proto field 5) so orchestrators
    can consume it without a DB query.
  Gate control: `LANTERN_MEASUREMENT_GATE` (`off` | `warn` [default] | `enforce`).
  Reference values: `LANTERN_REFERENCE_MEASUREMENTS` (comma-separated hex).
  **HOST-ASSERTED only** — proves what the host recorded it launched, NOT
  what ran inside the VM; hardware attestation (ADR 0023) remains UNVERIFIED.
- **Egress DLP (ADR 0030)** — per-tenant data-loss-prevention policy applied by the egress broker to TLS-terminated and plain-HTTP egress. Detectors: Luhn-validated card numbers, secret-key prefixes (AWS/GitHub/Slack/PEM), email (threshold-based), phone (threshold-based), custom regex. Modes: `off | audit | block`. Block mode fails closed on inspection error. Audit events carry rule id, detector, host, byte offset/count — never the matched value (invariant #10). Policy stored in `dlp_policies` (RLS-enforced, migration 0028). REST CRUD at `GET/PUT /v1/egress/dlp-policy` + `POST/DELETE /v1/egress/dlp-policy/rules`. Compiled into the broker at VM spawn via `AgentSpec.dlp_policy` (proto field 19). Opaque CONNECT tunnels not inspected. e2e: `broker-e2e.sh` DLP block case.
- **Prod enforces API-key scopes** — `values-prod.yaml` (and staging) set `LANTERN_AUTHZ_ENFORCE=1`; a first-class `controlPlane.env.LANTERN_AUTHZ_ENFORCE` chart value, a boot log line stating the mode, a `ControlPlane403RateElevated` alert, a chart render test (`infra/helm/lantern/tests/authz-enforce.sh`, run in CI), and the soak/rollback/re-scoping steps in `docs/runbooks/ga-staged-rollout.md`. JWT sessions and unscoped legacy keys are unaffected.
- Docs site: Cmd/Ctrl-K search over a build-time index (no external service), per-page titles/descriptions/Open Graph tags,
  `sitemap.xml` + `robots.txt`, a top bar (landing link, search, GitHub, theme) and an "Edit this page on GitHub" link.
- **CI: fixture-tier e2e lane** — `.github/workflows/sdlc-e2e.yml` (jobs `examples`, `browser`, `deploy-cli`) runs the webhook-example suites, Playwright and the `lantern deploy` e2e on every PR and master push with no provider key; skip = fail. Docs truth pass: `e2e/README.md` test tiers, `docs/GA-READINESS.md`, `docs/LAUNCH-CHECKLIST.md` re-verified against code.
- **Kiosk demo mode** (ADR 0029, #342) — `make demo` / `lantern demo` start the stack with Docker only and no API
  key: each visitor gets an ephemeral, auto-deleted tenant (30 minutes) with sample agents, answers come from the
  `llm-replay` fixture server, RLS and scope enforcement are on. `lantern demo --down` / `make demo-down` delete
  all demo data. Docs: `/demo`.
- **Playwright dashboard tier** (#343) — headless-Chromium specs for auth, onboarding, settings and theme against a
  private throwaway stack (own Postgres DB, Redis index, log mailer, fixture LLM). Run `npm run test:e2e` from
  `apps/web` (`apps/web/e2e/README.md`). Docs: `/testing`.
- Docs: `lantern demo` and `lantern hooks` in the CLI reference.
- **Data analyst sandbox example (X5)** — `examples/data-analyst` (pandas image, sandbox
  spec, explainer agent) and `e2e/examples/data_analyst_test.go`: CSV in, exec analysis, JSON +
  PNG out, egress denied, fixture-LLM explanation. Docker tier runs in CI; the files API and
  `ExecTool` are Firecracker-only, so that tier is the KVM nightly.
- **Examples: daily digest, Telegram assistant, voice receptionist** — three
  runnable agents under `examples/` (spec, workflow, schedule/number, README with
  a fixture path and a real-account path) and `make test-e2e-examples`, which
  boots a private fixture stack and asserts: schedule fires -> Slack post;
  signed Telegram update -> reply; signed Twilio webhooks -> TwiML, `<Reject>`
  over budget, cost reconciled in `agent_usage_daily`. Signature negatives for
  Telegram and WhatsApp in `services/surface-gateway/tests`. Docs: `/testing`,
  `/surfaces`, `/scheduling`.
- **Surface-gateway replies** — a Telegram or WhatsApp message now gets the
  run's output back in the chat (the gateway polls the run and sends it, then
  frees the session). Before, the run was created and the answer was dropped.
  `TELEGRAM_API_BASE_URL` points Bot API calls at a fixture (refused in prod).
- **Examples: PR triage + incident responder** (`examples/pr-triage-webhook`, `examples/incident-responder`) — signed
  GitHub/Sentry/PagerDuty webhooks drive workflow graphs (GitHub comment + Slack thread; Sentry/PagerDuty lookup,
  Slack, approval node, PagerDuty note). `make test-e2e-examples` runs them on a throwaway fixture stack
  (`scripts/e2e-examples.sh`, `e2e/examples`). Docs: `/examples`.
- PagerDuty `add_note` connector action; `POST /v1/runs/{id}/takeover/{id}/deny` (approval node fails the step).

### Fixed
- **Fork/restore no longer byte-copies the VM disk on reflink filesystems.** Since disk-consistent snapshots, every fork and restore staged the disk with a full copy (O(n) in disk size). The manager now clones it copy-on-write (`FICLONE`) on XFS/btrfs, falls back to a full copy with a `disk_staging="full_copy"` warning on ext4/tmpfs, and can be made strict with `LANTERN_REQUIRE_REFLINK=1`.
- **Receipt verification now detects an edited payload.** With a stored receipt, `POST /v1/runs/receipts/verify` compared only the signature string, so a receipt whose `costUsd`/`status` had been changed but that carried the original signature verified as `valid: true`. It now also requires the payload to match the issued one (canonical compare), which keeps receipts valid across key rotation.
- Workflow `connector` nodes could not call Sentry or PagerDuty ("dispatch not yet wired").
- A workflow whose JSON held a backslash (e.g. an escaped quote in a prompt) failed to load and the agent silently ran as a plain LLM call (`::text::bytea`).
- Map-form workflow params (`inputMapping`/`parameters`) now render `{{...}}` templates.
- After an approval park, the resumed node's `step_completed`/`step_failed` was dropped from the journal (seq collision with `step_waiting`).

### Added

- Self-service onboarding polish (W2-S): a six-template starter gallery in dashboard onboarding
  (served by `GET /v1/agents/templates`), a verify-email fix path for `403 email_unverified` on run
  creation, free-tier caps (`LANTERN_FREE_TIER_*`) applied to every new tenant on password and Google
  sign-up, and the `lantern.onboarding.step.total` counter.
- **`lantern deploy` is real** (W2-D) — reads `agent.yaml`, creates the agent or
  updates its prompt/model (`PATCH /v1/agents/{name}`), saves an optional
  `workflow` (`PUT .../workflow`), then `POST /v1/agents/{name}/deploy`. `--json`
  prints the API response, `--dry-run` makes no mutating call. Non-2xx maps to
  exit codes 3 (auth) / 4 (402) / 5 (404) / 6 (5xx). Replaces the simulated
  output. New e2e: `e2e/deploy`. Docs: `/cli#deploy`.
- **Fixture LLM tier** — `LANTERN_LLM_BASEURL_{OPENAI,ANTHROPIC}` re-points every
  provider call (completions, streaming, tool loop, web_search) at
  `cmd/llm-replay`, a deterministic OpenAI/Anthropic wire-format server with
  scriptable replies and tool calls and realistic token usage, so CI and kiosk
  mode need no provider key. Refused in production. Docs: `/testing`.
- **Webhook triggers** (ADR 0028, #323) — a public `POST /v1/hooks/{id}` URL per
  agent; GitHub, Sentry, PagerDuty or any HMAC-SHA256 sender starts a run. The
  signature is the only credential; duplicate deliveries return
  `200 {"duplicate":true}` and start no run. Managed over REST, the TS/Python/Go
  SDKs, `lantern hooks` and the dashboard (`/agents/[name]/triggers`). Docs:
  `/triggers`.
- **Account lifecycle** (ADR 0027, #318) — `LANTERN_SIGNUP_MODE`
  (`open`/`invite`/`closed`, closed by default in prod), email verification,
  password reset, HMAC invite codes, Turnstile captcha, Redis rate limits on the
  pre-auth routes, owner-only data export (`GET /v1/tenants/{id}/export`) and
  workspace deletion from Settings. Pluggable mailer (`LANTERN_MAILER` =
  `log`/`smtp`/`http`). Docs: `/accounts`.
- **Connector actions** (#316) — Slack `reply_thread`, GitHub `comment_pr`,
  Sentry `get_issue`, Google Calendar `create_event`, and a PagerDuty connector.
  Recorded test mode: `LANTERN_CONNECTOR_BASEURL_*` points a connector at the
  `connector-replay` fixture server; refused in production.
- **End-to-end kit** (#317) — `make test-e2e` against a live stack with a spend
  policy enforced in code (reserved `e2e-*` agents, hard-fail budget per agent,
  cheapest model tier) and `make e2e-clean`. Docs: `/testing`.
- **Docs** — new pages for webhook triggers, accounts, end-to-end tests and
  running real Firecracker microVMs on a Mac (Lima); budgets rewritten around an
  enforcement matrix; models page lists every capability name per provider.
- **Per-agent model** — `POST`/`PATCH /v1/agents` accept a `model` (SDK
  capability such as `fast` / `reasoning-small`, or a vendor id) and `GET`
  returns it. Runs, sessions and `auto` workflow ai-steps try it first; unset
  or `auto` keeps the default chain. A cheap-tier agent fails over only to the
  other provider's cheap tier and never to a Sonnet / gpt-4o / Opus class model
  — it fails instead (migration 0025, `agents.model`). Docs: Agents → Model
  selection, Models → Per-agent model.
- Helm: `runtime-scheduler` and `surface-gateway` templates, per-tier HPA, PodDisruptionBudgets, default-deny
  `NetworkPolicy` with the required allow flows, an opt-in Postgres backup CronJob, and `values-ci.yaml`.
- Control-plane Prometheus `/metrics` on `:8080`; the control-plane SLO alert group is now enabled.
- `scripts/db-restore-drill.sh` and `scripts/check-app-grants.sh`; a kind + Calico `helm-install` CI job.

### Fixed
- `lantern test` now works against a real API: `POST /v1/runs` answers 201 and runs asynchronously, but the CLI required
  200 and read the output immediately. It now polls `GET /v1/runs/{id}` to a terminal status (`--timeout`, default 2m per
  case); a failed run or a timeout scores as a failed case with its error. `--rehearse` had the same bug and is fixed too.
- New sign-ups now land on `/onboarding`: the authenticated-redirect effect raced the explicit redirect and sent them
  to `/agents`.
- Password reset and the other `/auth/*` recovery pages work for logged-out visitors: a 401 from the global
  model-context fetch no longer bounces them off the page.
- Docs: install steps no longer point at registry packages that do not exist (`@lantern/sdk` is not on npm; the
  PyPI name `lantern-sdk` belongs to an unrelated project), broken `dshakes.github.io/lantern/<page>/` README links
  now include `/docs/`, and `make dev-infra` is documented as Postgres and Redis only (no MinIO).
- `@lantern/sdk` built output threw `module is not defined` on import under Node ESM (the runner's
  `require.main === module` check); it now checks `process.argv` only.
- Workflow `connector` nodes could not call Sentry or PagerDuty ("dispatch not yet wired").
- A workflow whose JSON held a backslash (e.g. an escaped quote in a prompt) failed to load and the agent silently ran as a plain LLM call (`::text::bytea`).
- Map-form workflow params (`inputMapping`/`parameters`) now render `{{...}}` templates.
- After an approval park, the resumed node's `step_completed`/`step_failed` was dropped from the journal (seq collision with `step_waiting`).
- **Workflows silently skipped** — agent workflow JSON, run input/output and
  connector configs were read with `jsonb::text::bytea`, which fails on any
  backslash (`\n`, `\"`); the error was swallowed, so such workflows ran as a
  plain LLM call and crash-recovery could not re-drive runs whose input held a
  quote or newline. Now read as `::text`.
- **Voice cost reconciliation** — `AdjustUsageCost` let Postgres infer the delta
  as INTEGER, truncating every sub-dollar adjustment to 0, so a call's
  duration-based cost (and refund) never reached `agent_usage_daily`.
- **Workflow connector nodes** — only gmail/slack/github/notion/linear worked;
  google-calendar, sentry, pagerduty and the rest failed with "not yet wired".
  They now use the shared executor (including OAuth refresh).
- **Templated free text in `inputMapping`** — a multi-line or quoted LLM reply
  spliced into a JSON `inputMapping` made the params invalid (connector got no
  `text`); values are now JSON-escaped when the raw render does not parse.
- **Voice call record failures** are logged instead of swallowed.
- **Data export redacts credentials structurally** (#330) — any column with a
  secret/token/key/password/hash/enc segment is left out, including webhook
  trigger secrets (`agent_triggers.secret_enc`) and `data_planes.reg_token_hash`,
  which were previously exported.
- **Cost forecast works** (#330) — it read run history with
  `status = 'completed'`, which no run has, so it never estimated cost; it now
  averages `succeeded` runs, so the per-run and daily-cost checks run.
- **Workflow runs count toward runs/day** (#330) — once each, on success.
  Failed runs still do not count.
- Agents created from a template now keep their system prompt and labels. The
  template-create and prompt back-fill UPDATEs wrote a column that did not
  exist, failed, and the error was discarded.
- `/v1/completions` honours the request's `model` on its failover paths.
- Helm: the default in-cluster Postgres crash-looped (Bitnami chart on the pgvector image) and the Bitnami
  MinIO images were no longer pullable, so a default `helm install` did not come up.
- `values-prod.yaml` and `values-staging.yaml` rendered unpullable image references (`/lantern/lantern-gateway:tag`);
  they now use the published `ghcr.io/dshakes/lantern/<name>` images.
- **Balanced default picks Sonnet** (#326) — `auto`/`balanced` routing picked
  Opus because price was only a capped bonus; price is now a real penalty, so the
  default is Sonnet (GPT-4o when only OpenAI is keyed).

### Changed
- Helm: Postgres (pgvector) and the S3-compatible store are now first-party templates instead of Bitnami
  subcharts, enabled by default for dev/kind and disabled in `values-prod.yaml` in favour of
  `externalDatabase` / `externalS3`. Redis remains a Bitnami subchart (`Chart.lock` pins it). Not an in-place upgrade from the
  Bitnami-based chart (StatefulSet selectors differ): dump, uninstall, install, restore.
  `externalS3.region` sets the S3 signing region (default `us-east-1`).
- **Budgets enforced further** (#315, #319) — `maxTokensPerDay` now blocks;
  workflow runs re-check the tenant cap, daily caps and `maxCostUsdPerRun`
  before every `ai-step` and confidence vote; `toolLimits` gate workflow `tool`
  and `connector` nodes. A budget lookup error now fails closed for hard-fail
  budgets (503 `budget check unavailable; retry shortly` at run create, 402
  elsewhere) instead of allowing the call. Still not enforced: the per-run cap on
  single-call paths and projected cost at run creation.
- **`web_search` tool nodes honour the per-run cap** (#324) — they check
  `maxCostUsdPerRun` against the run's accrued spend and add their LLM cost to
  the run, like ai-steps.
- **Fast restore** (#325) — after resume or fork the runtime-manager holds the
  first exec until the restored harness has re-identified and heartbeated
  (`LANTERN_HARNESS_READY_TIMEOUT_MS`, default 5 s) instead of the caller
  retrying; first exec after restore p50 2.9 s on nested-virt Lima (was 4.2 s).
- **Workflow tool nodes execute** (#319) — `tool` nodes dispatch to the sandbox
  runtime or the built-in `web_search` and fail loudly when the runtime is not
  wired, instead of returning a placeholder; side effects carry an idempotency
  key per loop iteration.
- **Capability resolution** (#320) — unknown capability names route to the
  balanced default (logged once) instead of a hardcoded model; `fast` and
  `cheap` resolve to the cheap tier.
- **Disk snapshots** (#322) — Firecracker snapshots capture the VM's writable
  disk alongside memory and vmstate; resume, idle wake and fork stage from it, so
  files written before a snapshot survive restore.

## [0.2.0] - 2026-10-27

The sandbox runtime release: credentials kept out of the VM, idle VMs that
suspend themselves, copy-on-write forks, and the full lifecycle tested on real
KVM.

### Added
- **Host egress broker** (opt-in, `LANTERN_EGRESS_MODE=broker`, Firecracker;
  ADR 0026, #299) — broker-mode VMs get no network device; egress and the
  harness control channel run over vsock to a per-VM broker on the host, which
  enforces the allowlist and injects credentials from `lantern.secret/...` refs
  (`egress[].inject`, exact hostnames only) so the secret never enters the VM.
  HTTPS is terminated only for injected hosts, with a per-VM CA scoped to them.
  Validated live on KVM (`infra/firecracker/broker-e2e.sh`).
- **Idle auto-suspend + transparent auto-resume** (#296) — `idleTimeoutSecs` on
  schedule / `lantern run --idle-timeout`; idle VMs are snapshotted and stopped
  through the crash-safe pause path (quota slot freed) and resumed on the next
  exec or file request (REST, CLI or SDK).
- **Shared-memory copy-on-write forks** (#295) — forks hard-link one read-only
  snapshot memory file (`MAP_PRIVATE`); fork cap configurable
  (`LANTERN_MAX_FORK_COUNT`, default 100, ceiling 1000).
- **Sandbox file API** (#294) — list/read/write files under `/workspace` via
  REST, TS/Python/Go SDKs and `lantern vm ls|cat|put`.
- **Agentic onboarding** (#297) — conversational `/onboarding` flow (LLM-designed
  agent spec, real provider check, streamed first run, sandbox try-out,
  resumable) and interactive `lantern onboard`; `lantern doctor` checks the
  sandbox runtime.
- **Real-KVM lifecycle e2e** (#298) — snapshot → restore → fork ×3 (jailed, with
  an inode check proving shared memory) in Lima and GitHub's KVM runners, with
  per-step timings in `docs/benchmarks/runtime-latency.md`.
- **New brand, README, landing site, docs site and diagrams** — 28 diagrams in
  one visual system, animated landing hero and lifecycle walkthrough.
- GA hardening stack (#276–#292): pause/resume/fork, per-call runtime-manager
  authz and service token, re-identification on restore, per-fork identity,
  manager-owned harness config, tenant-wide budget cap, tool-spend metering,
  body-hashed LLM idempotency keys.

### Fixed
- Harness reaper raced tokio's pidfd wait (`ECHILD` from `shell_exec` after
  restore); stale sockets broke same-vm_id restore; first exec after restore
  waited out a dead address (37 s → ~4 s); unjailed restores shared one rootfs.
- Manager secret relay sent the node's env tenant/vm_id instead of the VM's
  (empty scope on multi-tenant nodes) — now the VM's, empty fails closed.
- Onboarding: generate-spec returned the raw completion envelope; CLI sent
  `api_key` instead of `apiKey`; saved keys were never tested.

### Security
- wasmtime moved to the 36.x LTS line (20 guest-can-panic-host advisories,
  #293); wasmtime's unused `cache` feature dropped to remove zstd
  (RUSTSEC-2026-0395/0396/0400); h2/quinn-proto/rustls/webpki/zod bumps.

### Earlier unreleased work
- **Interactive TTY exec** — `lantern vm exec <vm> -it -- <cmd>` allocates a real
  PTY in the guest (harness `openpty` + controlling terminal + winsize) and
  streams it bidirectionally; the CLI enters raw mode (no-op on non-terminal
  stdin). Docker backend sets `Tty: true`. Non-tty exec is byte-identical.
  `ExecRequest` gains `tty`/`term_rows`/`term_cols`/`term`.
- **Firecracker guest exec** — the in-guest harness now serves its first RPC
  (`RuntimeHarness.Exec`); the manager records each VM's guest address from the
  heartbeat peer and forwards `lantern vm exec` into firecracker-class VMs over
  that channel (`services/harness/src/exec.rs`, `runtime-manager` service.rs).
- **Firecracker jailer wrapping** — opt-in via `FIRECRACKER_JAILER_PATH`
  (chroot + drop to non-root `FIRECRACKER_JAILER_UID`/`GID`, default 123:100;
  `FIRECRACKER_CHROOT_BASE` default `/srv/jailer`). Argv construction unit-tested;
  jailed exec is Linux-runtime-only; jailed snapshot-restore fails closed.
- **K8s isolation validation harness** (`infra/k8s/`, `make k8s-validate`) — kind
  + Calico cluster asserting default-deny egress, seccomp/cap-drop, and admission
  rejection of privileged pods. Ran green (18/18).
- **End-to-end runtime suite** (`e2e/runtime/`, `make test-e2e`) — drives the live
  control-plane REST surface through the full VM lifecycle; skips when the stack
  is down.
- **Lima Firecracker dev path** (`infra/lima/`) — run real microVMs on Apple
  Silicon (M3+/macOS 15+) via nested virt; verified ~1.6 s boot on an M4 Max.
- `Exec` and `Stats` gRPC handlers for the Docker backend in `runtime-manager`
  (`services/runtime-manager/src/service.rs`). Both were previously
  `UNIMPLEMENTED` stubs; the Docker path is now backed.
- Make targets `run-runtime-manager`, `run-scheduler`, `run-api-runtime` for
  running the full W12 runtime stack locally without Docker Compose.
- Docker Compose `runtime` profile so `make dev` can optionally include the
  runtime-manager and scheduler containers.
- Runtime handler tests in the control-plane covering the `/v1/runtime/*`
  endpoint surface.
- `examples/headless-agents/` demo images baked with `lantern-harness` as PID 1
  so demos work without a separately-deployed harness image.
- `services/runtime-manager/README.md` and `packages/sdk-python/README.md` (new).

### runtime-manager
- **Kata backend** (`src/backends/kata.rs`): `RUNTIME_BACKEND=kata` activates a
  thin Docker-delegating backend that sets `HostConfig.runtime` to
  `KATA_RUNTIME_NAME` (default `kata-runtime`). Exec and Stats work through the
  inner Docker client unchanged.
- **Wasm backend** (`src/backends/wasm.rs`): `RUNTIME_BACKEND=wasm` runs
  WebAssembly modules in-process via Wasmtime (WASIp1). Memory limits via
  `StoreLimitsBuilder`; CPU limits via epoch interruption with configurable
  `limits.timeout`.
- **Exec + Stats for docker and kata**: both gRPC methods are now backed for the
  Docker and Kata backends.
- **SnapshotStore** (`src/snapshot_store.rs`): filesystem-backed snapshot
  persistence under `SNAPSHOT_DIR` (default `/var/lib/lantern/snapshots`) with
  ADR 0007 Tier-2 retention (keep last 3 per `(agent_version_id, vm_id)`, delete
  after 7 days). SHA-256 computed over sorted artifact bytes.
- **RelaySecretResolver** (`src/secret_resolver.rs`): production secret resolver
  calling `POST /v1/runtime/secrets/resolve` on the control-plane (ADR 0008).
  Activated when both `LANTERN_CONTROL_PLANE_URL` and `LANTERN_RUNTIME_SECRET_TOKEN`
  are set. Fail-closed: unset env → `EnvSecretResolver` (dev/CI default).
- **`RuntimeManager.Snapshot` RPC** added to `packages/proto/lantern/v1/runtime.proto`
  and hand-stub Go bindings in `gen/go/`.

### harness
- **Egress per-rule rate limiting** (`src/egress.rs`): token bucket throttles
  byte throughput per CONNECT tunnel when `EgressRule.rate_bps` is non-zero.
  Burst = 1 second of traffic; `rate_bps == 0` is unlimited.
- **Plain-HTTP method filtering** (`src/egress.rs`): `EgressRule.http_methods`
  is now checked on plain-HTTP (non-CONNECT) requests. CONNECT tunnels are not
  filtered (opaque TLS — no MITM).
- **Cgroup v2 stats** (`src/heartbeat.rs`): `sample_usage_loop` reads
  `memory.current` and `cpu.stat usage_usec` from the cgroup v2 unified hierarchy
  first; falls back to `/proc/self/status` VmRSS on macOS / cgroup v1 / no mount.

### runtime-scheduler
- **Postgres write-through persistence** (`internal/store/`): when `DATABASE_URL`
  is set, every cluster-state mutation is written to Postgres (`sched_nodes`,
  `sched_vms`, `sched_snapshots` tables) and state is restored from DB on restart.
  DB write failures degrade to in-memory-only rather than failing placement.
- **Snapshot forwarding to manager**: `Snapshot` RPC now calls the winning node's
  manager and persists the returned metadata in `sched_snapshots`.

### control-plane
- **`POST /v1/runtime/secrets/resolve`** (`internal/handlers/runtime_secrets.go`):
  service-to-service endpoint for the runtime-manager's `RelaySecretResolver`.
  Authenticates via `X-Lantern-Runtime-Token` / `LANTERN_RUNTIME_SECRET_TOKEN`;
  returns 403 when the token is unset (fail-closed). See ADR 0008.
- **`docs/adr/0008-runtime-secret-relay.md`**: new ADR documenting the relay
  endpoint design and security properties.

### CI
- **`sdlc-qa.yml`**: Go tests now run against a `pgvector/pgvector:pg16` Postgres
  service with `DATABASE_URL` set, so scheduler and control-plane DB-dependent
  tests run in CI.
- **`make test-db`**: new Make target that starts dev Postgres if needed and runs
  all Go tests with `DATABASE_URL` wired.

---

### runtime-manager (this batch)
- **K8s exec** (`src/backends/k8s.rs`): `exec_command` uses the kube `ws` feature
  (`Api::exec` / `AttachedProcess`) to attach to the `agent-runner` container and
  collect stdout, stderr, and exit code. Previously `UNIMPLEMENTED`.
- **K8s stats** (`src/backends/k8s.rs`): `stats_sample` queries
  `GET /apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods/{name}`. Surfaces a clear
  "metrics-server not installed" error when the API group is absent rather than an
  opaque transport failure.
- **Firecracker stats via heartbeat cache** (`service.rs`): the manager now consumes
  `RuntimeHarness::Heartbeat` bidirectional streams from in-VM harnesses and caches
  `ResourceUsage` per `vm_id`. The `Stats` gRPC method serves the cached value for
  Firecracker VMs; entries older than 30 s yield `Status::UNAVAILABLE` with an
  explicit staleness message.
- **SnapshotStore S3/MinIO tier** (`src/snapshot_store.rs`): `put` uploads all
  artifacts + `meta.json` to S3 after writing locally; `get` falls back to S3 when
  the local copy is missing. Activated by `S3_ENDPOINT` + `S3_BUCKET` +
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. S3 upload failures are non-fatal
  (warn-logged; local copy is always written first). Verified live against dev MinIO.

### control-plane (this batch)
- **Secret relay per-VM binding** (`internal/handlers/runtime_secrets.go`): the
  `POST /v1/runtime/secrets/resolve` endpoint now verifies that `vm_id` exists in
  `runtime_vms`, belongs to the claimed `tenant_id`, and is in a non-terminal state
  before resolving any credentials. Binding failures return `404 {"error":"not found"}`
  — identical for unknown VM, wrong tenant, and terminal state (no oracle). Binding
  failures count against the per-IP auth rate limiter to throttle probing.
- **`go vet` clean**: pre-existing `t.Context()` failures replaced with
  `context.Background()`; `go vet ./...` now exits clean across the control-plane.

### CI (this batch)
- **`microvm-integration.yml`**: added `cargo test --all` steps for
  `services/runtime-manager` and `services/harness` on the KVM runner, running before
  the heavier image-build step so test regressions fail fast.

### Dev environment
- **`infra/lima/`**: Lima VM template (`firecracker-dev.yaml`) + guide for running
  real Firecracker microVMs on Apple Silicon Macs (M3+/macOS 15+) via nested
  virtualization — provisions the pinned Firecracker release and validates
  `/dev/kvm`. Verified: Ubuntu 22.04 microVM boots to login in ~1.6 s on an M4 Max.

### Fixed (live-boot validation on KVM)
- Running `infra/firecracker/integration-test.sh` on a real KVM host surfaced and
  fixed six runtime-manager bugs that blocked an actual microVM boot: missing
  rustls CryptoProvider (mTLS panic), invalid firecracker `--log-level` flag,
  unbuilt `certs.img` drive, missing vsock runtime dir, swallowed anyhow error
  chain, and a corrupting bare snapshot-restore mem-path derivation. A real
  microVM now boots end-to-end; the in-guest harness VendSecret agent remains
  the one open piece. Also fixed the build-image.sh CI kernel URL (upstream
  renamed the artifact keys) and the integration test's certs (Go's TLS needs
  EKU extensions openssl omits).

---

## [0.1.0] - Unreleased

Public alpha. All five modules are implemented; Module 1 microVM live-boot is
fail-closed pending Linux/KVM integration CI.

### Module 1 — Agent Runtime

- Control plane (Go, `:8080` REST + `:50051` gRPC): agents, runs, sessions,
  schedules, budgets, evals, marketplace, MCP, A2A, voice, receipts, RLHF,
  rehearsals, human-takeover, marketplace commerce, webchat embed, workflow
  interpreter (7 node types).
- Workflow engine (Go, `:50052`): durable event-sourced step execution, in-memory
  replay queue, journal persistence.
- Model router (Rust, `:50053`): capability-based multi-LLM routing over
  OpenAI / Anthropic / Google; failover, prompt/semantic caching, per-tenant
  key management.
- Runtime scheduler (Go, `:50055` / `:8085`): warm-pool / region / fair-share /
  cost / health placement scoring; per-tenant concurrency cap.
- Runtime manager (Rust, `:50054`): Docker (full), Firecracker (full, Linux/KVM
  gate), K8s Jobs (full) isolation backends; mTLS + per-VM cert issuance;
  `VendSecret` with declared-URI allowlist and cert-CN identity check.
- Harness (Rust, in-VM): egress HTTP CONNECT proxy, secret vending, log
  forwarding, OTel pass-through, supervisor, snapshot/drain signal handling.
- Gateway (Rust, `:8443`): TLS termination, JWT auth, rate limiting, SSE proxy.

### Module 2 — Personal Agent ("Jarvis")

- WhatsApp bridge (TS, `:3100`) and iMessage bridge (TS, `:3200`) with
  owner-only access, voice-from-history, pacing, bot-tell guards, quiet-hours
  queue, draft-and-confirm, claim verifier.
- Cross-channel unified memory (person graph, 14-day episodes, 7-day topic
  index), anticipation nudges, 👎 learning flywheel, personal-docs assistant
  with OCR, agentic macOS actions (Calendar / Notes / Mail).

### Module 3 — Trust and Governance

- Policy-as-code budgets: per-day cost, per-run cost, tokens/day, runs/day,
  per-tool rate limits, hard-fail HTTP 402.
- Pre-run cost forecaster (`POST /v1/runs/forecast`).
- Eval suites + per-branch baselines + CI gating (HTTP 422 on regression).
- Rehearsals: replay past failed / low-score runs against a candidate version.
- HMAC-SHA256 verifiable receipts over journal SHA-256; public verifier at
  `/proof`.
- AES-256-GCM credential encryption at rest; Postgres RLS on `agents`/`runs`.

### Module 4 — Channels and Reach

- WhatsApp, iMessage, Slack, Telegram, Discord, voice (Twilio/LiveKit),
  webchat embed (`/widget.js`), email — signature-verified inbound.
- 17 first-party connector APIs with OAuth: Gmail, Google Calendar/Drive/Sheets,
  Slack, Discord, Telegram, Twilio, GitHub, Linear, Jira, Sentry, Vercel,
  Notion, HubSpot, Salesforce, Stripe.

### Module 5 — Developer Experience

- TypeScript SDK (`@lantern/sdk`): HTTP client, in-process runtime, connectors.
- Python SDK (`lantern-sdk` 0.1.0): HTTP client + agent/step/tool decorator layer.
- Go SDK (stub).
- `lantern` CLI (Go/Cobra): `dev`, `init`, `run`, `agents`, `runs`, `test`,
  `deploy`, `logs`, `login`.
- Visual workflow editor that saves and executes graphs.
- MCP server registry + per-agent attachments.
- A2A agent cards (`/.well-known/agent.json`).
- Forkable agent marketplace with HMAC-signed cross-tenant invocation.
- A/B experiments with deterministic FNV-1a splitting and auto-promotion.

### Infrastructure

- `make dev` (full Docker Compose stack), `lantern dev` (hot-reload daily
  driver), dev credentials seeded on first boot.
- Helm chart (`infra/helm/`), Terraform stubs (`infra/terraform/`).
- Four headless-agent demo examples (`examples/headless-agents/01–04`).

---

[Unreleased]: https://github.com/dshakes/lantern/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dshakes/lantern/releases/tag/v0.1.0
