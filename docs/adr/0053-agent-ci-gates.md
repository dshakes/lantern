# ADR 0053 — Shift-left CI gates for agents (`pal ci`)

- Status: Accepted
- Date: 2026-10-31
- Scope: CLI `pal ci init|check|lint|contract` (`packages/cli/internal/cli/ci_*.go`), one refactor of `eval_cmd.go` (`execEvalRun`), `scripts/e2e-agent-ci.sh`
- Plan: AGENT-LIFECYCLE-PLAN Phase 5

## Context

Phase 4 (ADR 0052) gave agents hermetic eval suites and a 422 regression gate, but
nothing wired them into a builder's pull-request flow. A builder had to hand-write
CI, and nothing checked the manifest itself (a vendor model id, a literal key, no
egress allowlist, no cost ceiling) before it reached a workspace.

## Decision

**The model generates; code decides.** `pal ci init` renders a GitHub Actions
workflow (`.github/workflows/pal-agent-ci.yml`) and a POSIX entrypoint
(`.pal/ci.sh`, usable from any CI). Rendering is a pure function of four validated
parameters (agent, suite, manifest, branch): same input, same bytes. Every gate
verdict is deterministic Go; no model call exists anywhere in `pal ci check`.

### Gates, in order (`pal ci check`)

1. **Manifest lint** (`PAL-LINT-*`): name kebab-case, model present, prompt or
   workflow present, `limits` well-formed, `knowledge` paths exist and stay inside
   the repo. Unknown top-level keys warn (deploy ignores them silently).
2. **Policy / security lint** (`PAL-SEC|EGR|MDL|HST-*`): no credential-shaped
   values or secret-named literals (use `pal.secret/...` refs); an `egress:` key
   must exist (`egress: []` is an explicit deny-all) with exact hosts or `*.domain`
   (matches any subdomain depth) only; every `model` key (including inside `workflow`) is a capability, not a
   vendor id (invariant #6); every URL host must be in the egress allowlist or
   loopback. Findings carry rule id and path, **never the value** (invariant #10).
3. **Hermetic eval** (`PAL-EVAL-*`): `POST /v1/eval-suites/{id}/run` against the
   baseline for `--branch`. Fails on any failed case, a regression (422), an empty
   suite, or a run that stopped early (incomplete results are not a pass).
4. **Budget** (`PAL-BUD-*`): `POST /v1/runs/forecast`. Fails if the run has no cost
   ceiling (neither `limits.max_cost_usd` nor a server per-run budget), the
   forecast says it would exceed a budget, or the estimate exceeds a ceiling.
   With no run history the estimate is unavailable and only the ceiling is checked
   (reported as such).

Fail closed: a gate that cannot decide (no credentials, server error) is `error`,
not skipped; `passed` is true only if all four are `pass`. If gate 1 or 2 fails,
gates 3 and 4 are `skipped` so no money is spent on a manifest that cannot ship,
and the run still fails.

### Output

`pal-ci-report.json` (`pal.ci.report/v1`: per-gate status, summary, findings,
metrics) and `pal-ci-summary.md` (PR comment body, marked
`<!-- pal-ci-report -->`). The workflow appends it to the job summary, uploads
both as an artifact and upserts a single PR comment (same-repo PRs only; fork PRs
have no secrets and so fail gates 3-4 closed).

### Eval runs the PR's version: `--stage`

The eval endpoint runs the agent as stored in the workspace. `--stage` therefore
deploys the PR's manifest (same path as `pal deploy`) before the run. That mutates
the workspace behind `PAL_API_KEY`, so it **refuses unless
`PAL_CI_STAGING_ACK=1`**, which the builder must set deliberately; the generated
workflow and script document that the key must be a non-production workspace. On
pushes to the default branch the script passes `--set-baseline`, pinning the
passing run as that branch's baseline; PRs compare against `github.base_ref`.

### Agentic generation: tool contract

`pal ci contract` prints the `generate_ci_gate` tool (JSON schema in/out) for the
onboarding agent (ADR 0051). The agent calls `pal ci init --json --dry-run`,
shows the files, and only a human-approved call without `--dry-run` writes. Inputs
are regex-validated before interpolation (agent, suite, manifest, branch), since a
model may have chosen them: no newline, quote, `..`, absolute path or shell
metacharacter can reach YAML or shell. Writes refuse existing files without
`--force` and never write through a symlink. `pal ci init --check` detects a
hand-edited gate.

## Threat notes

- Generated files contain no hostnames; the API address is the repo's own
  `PAL_API_URL`. No third-party default hosts.
- `PAL_API_KEY` is read from the environment only; never echoed to logs, reports
  or findings. The workflow requests `contents: read`, `pull-requests: write`.
- Actions are referenced by major tag (`@v4`/`@v5`/`@v7`), not SHA: pin them in
  your repo if your threat model requires it.
- Policy lint is a static check of the manifest. It does not replace runtime
  enforcement (egress allowlist at the harness, ADR 0006/0026; secret vending).
  The manifest-level `egress:` key is read by this gate; the schedule spec is what
  the runtime enforces.
- Detection is regex/shape based: it will not catch an obfuscated credential. It
  is a floor, not a scanner.

## Not done (follow-ups)

- Server endpoint `POST /v1/agents/{name}/ci-workflow:generate` and wiring the
  contract into the onboarding agent's server tool list (it only has REST tools
  today). The CLI is the executor of the contract for now.
- `pal test --against=last-green` and the injection-eval suite named in the plan.
- A pinned release channel for `go install` (`PAL_CLI_VERSION` defaults to `latest`).
