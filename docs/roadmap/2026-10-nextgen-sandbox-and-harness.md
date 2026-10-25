# 2026-10 — Next-gen sandbox + personal harness plan

Three read-only audits (headless runtime, security + cost, personal bridges) were
run against `master@377d42b`, then cross-checked against the 2026 sandbox market
(E2B, Modal, Daytona, Vercel Sandbox, Blaxel) and personal-agent products
(Dot/Muse/Duet-style chiefs of staff). This doc is the plan; each row links to
the wave that ships it.

## Where the market is (Oct 2026)

- **Sandboxes:** sub-second cold start is table stakes; the differentiators are
  *stateful* lifecycle — pause/resume with memory, fork-from-snapshot (N copies
  of a running sandbox), file + streaming-exec APIs, per-sandbox egress policy.
  Daytona's core went closed in June 2026, so "self-hostable in your VPC with
  first-class fork/pause" is close to uncontested.
- **Personal agents:** the bar moved from "answers well" to "owns the task":
  commitments tracked to closure, outcome measurement, proactive but gated.

Lantern's wedge: the only stack that combines **customer-VPC data plane +
microVM isolation + durable journal (crash-resume) + verifiable receipts**, and
the personal harness is that stack dog-fooded on a real life.

## Audit findings → wave

### Wave 1 (this branch, `feat/ga-nextgen`) — correctness + security before features

| # | Finding | Severity | Fix |
|---|---|---|---|
| S1 | Helm never set `JWT_SECRET`; `LANTERN_ENV` defaulted to `""` → every prod guard off, dev JWT secret signs owner tokens | Critical | secretKeyRef wired, `LANTERN_ENV=production` default, `values-prod.yaml` |
| R1 | control-plane dropped `limits`/`egress_rules`/`secrets` when building AgentSpec → VMs booted with no egress allowlist | Critical | decode + round-trip test |
| R2 | Firecracker guest never received cmd/egress/uid (cmdline mangled spaces) | Critical | `spawn.json` contract on the cert drive (ADR 0025) |
| R3 | workload + tools ran as the harness uid → SO_PEERCRED, egress REDIRECT and cert-key isolation all defeated | Critical | privilege drop to `LANTERN_WORKLOAD_UID` |
| R4 | runtime-manager had no per-call authz; a guest's VM cert could Exec/Stop any VM | High | VM-cert vs service-token interceptor |
| R5 | `ExecTool` not tenant-scoped | High | `tenant_id` on request, NotFound on mismatch |
| S2 | model-router `:50053` unauthenticated while carrying tenant provider keys | High | service-token interceptor, fail-closed in prod |
| S3 | API-key creation allowed scope escalation; many mutators unscoped | High | subset check + `WithScope` annotations |
| S4–S6 | Slack signature, Twilio `webhook_auth=off`, `USE_CLAUDE_CODE` not fatal in prod | Medium | startup guards |
| R6–R11 | snapshot restore ignored but reported success; quota slot leak; tenant-unscoped scheduler idempotency; spawn race; unbounded tool/exec buffers; warm pool bypassed | Medium | each fixed with a regression test |
| C1 | workflow `ai-step` + confidence votes never metered or budget-checked | High (cost) | `CheckBudget`/`RecordUsage` in the closure |
| C2 | `web_search` unmetered | High (cost) | usage threaded into totals |
| C3 | streaming/no-tools paths skipped Anthropic prompt caching | High (cost) | `anthropicSystemWithCache` |
| C5 | one idempotency key per run → distinct requests collided | Medium | body hash in key |
| B1 | commitments surfaced but never closed | Product | LLM-judged ledger with verbatim-evidence guard |
| B2 | bridge quality unmeasurable; introspect died silently for weeks | Product | encrypted sent-log + staleness alarm |
| B3 | bridge parity regressions (#250, #252) | Product | parity gate test |

### Wave 2 — sandbox lifecycle (the market differentiator)

- `POST /v1/runtime/vms/{id}/pause` (snapshot + stop) / `resume`, and
  `POST /v1/runtime/vms/{id}/fork` with `{"count":N}` (restore N times, max 10) on top of the now-honest
  `restore_snapshot_id` path. SDK (TS/Python/Go) + `lantern vm pause|resume|fork`.
- Snapshot-backed warm pool entries for sub-second resume.
- File APIs exposed over REST + SDK (harness tools `read_file`/`write_file`/`list_dir` land in wave 1).
- Live egress-policy updates over the heartbeat ack.

### Wave 3 — cost + routing

- `reasoning-small` capability for `::purpose` side calls (gates, judges) instead
  of the default large model; replace remaining hardcoded model ids (invariant #6).
- ~~Tenant-wide budget row~~ — shipped: `PUT/GET/DELETE /v1/budgets/tenant` caps agentless `/v1/completions`.
- Model-router LIVE cutover (ADR 0014) once S2 is deployed.

### Wave 4 — personal harness

- Nested approvals in child runs (currently `ErrChildRunPaused`).
- Outcome learning beyond 👎: did a nudge/auto-action help? (feeds the sent-log).
- WhatsApp-only deployments: world-model + gmail ingest parity (today both
  bridges share one `owner-profile.md`, so the iMessage refresh covers WA on the
  owner's Mac).

## Needs a human

- Firecracker end-to-end on a Linux/KVM host (this Mac can build + unit-test the
  Rust, not boot a microVM).
- Live bridge validation in the owner's real logs after deploy.
- `helm install` against a real cluster.
