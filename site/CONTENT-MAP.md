# Content map: old Lantern sites (deleted in fd11a65d) to the new PAL site

Method: old sources read with `git show fd11a65d^:<path>`; new docs compared by 5-word shingle overlap after Lantern->PAL
normalisation, plus identifier sweeps (every `LANTERN_*` var checked as `PAL_*`; every `/v1/...` path; connector names).
Docs tree is still being reorganised by other agents (egress/identity/receipts/security now under `security/`, observability and SDKs
have their own sections). Paths below are relative to `src/content/docs/docs/` unless prefixed `pages/`, `data/`.
"Lives at" for landing items = `src/pages/*.astro`, `src/data/*.ts`.

Overlap legend: coverage = share of old prose shingles found in the new page. Low numbers are almost always rewording,
table/JSX-to-markdown reshaping, or rename (lantern->pal), not loss. Spot checks listed in section 2.

## 1. Old page inventory

### apps/landing
| Old route / file | New location | Status |
|---|---|---|
| `/` (page.tsx: Hero, How, PainFix, Measured, Compare summary, budget code, Start) | `pages/index.astro`, `pages/runtime/index.astro` (How/Measured/Compare-summary/budget code live on /runtime), `data/promise.ts`, `data/site.ts` | moved |
| `/compare` | `pages/compare/index.astro` | kept (all rows/cells found) |
| `/runtime` (meta-refresh stub to home) | `pages/runtime/index.astro` (now a real page) | superseded |
| `/privacy` (privacy/page.tsx) | none | **GAP** |
| `/terms` (terms/page.tsx) | none | **GAP** |
| layout.tsx, opengraph-image, twitter-image | `public/og.png`, `layouts/Page.astro` | moved |
| robots.ts, sitemap.ts | Astro sitemap (config) | not checked (config, not content) |
| _components/site.tsx (Nav: How it works / Benchmarks / Compare / Docs / GitHub; Footer; "Run it locally" + "Star on GitHub" + "Needs Docker, no API key. Apache-2.0.") | `layouts/Page.astro`, `components/SiteTitle.astro`, `data/site.ts` | moved (Footer Privacy/Terms links now dead-end, see GAP) |
| _components/BrokerDemo.tsx (3-step animated broker demo) | `pages/runtime/index.astro` mentions "no network card"; the 3 steps (no NIC / placeholder key swapped to 200 / plain HTTP 403) not found | **GAP (partial)** |
| _components/CopyCommand, ThemeToggle, Logo | `components/Copy.astro`, Starlight theme, `components/Logo.astro` | moved |
| public/media/broker-run-poster.webp | not in `public/` | **GAP** (asset) |

### apps/docs (all 40 pages mapped)
| Old route | New location | Overlap |
|---|---|---|
| `/` (page.tsx: paths, features, "new since 0.2.0", reference list) | `index.mdx` | 0.38 (restructured; see item table) |
| `/quickstart` | `start/quickstart.mdx` | 0.83 |
| `/installation` | `start/installation.mdx` | 0.57 (dev creds / ports / verify all present) |
| `/demo` | `start/demo.mdx` | 0.85 |
| `/examples` | `start/examples.mdx` | 0.91 |
| `/agents` | `build/agents.mdx` | 0.69 |
| `/accounts` | `build/accounts.mdx` | 0.92 |
| `/budgets` | `build/budgets.mdx` | 0.81 |
| `/connectors` | `build/connectors.mdx` | 0.71 |
| `/evaluations` | `build/evaluations.mdx` | 0.89 |
| `/marketplace` | `build/marketplace.mdx` | 0.75 |
| `/models` | `build/models.mdx` | 0.85 |
| `/scheduling` | `build/scheduling.mdx` | 0.81 |
| `/testing` | `build/testing.mdx` | 0.91 |
| `/triggers` | `build/triggers.mdx` | 0.84 |
| `/personal` | `pal/index.mdx` | 0.82 |
| `/surfaces` | `pal/surfaces.mdx` | 0.78 |
| `/knowledge` | `pal/knowledge.mdx` | 0.87 |
| `/human-in-the-loop` | `pal/human-in-the-loop.mdx` | 0.82 |
| `/runtime` | `runtime/index.mdx` | 1.00 |
| `/runtime/quickstart` | `runtime/quickstart.mdx` | 0.63 |
| `/runtime/isolation` | `runtime/isolation.mdx` | 0.82 |
| `/runtime/durable-execution` | `runtime/durable-execution.mdx` | 0.80 |
| `/runtime/sandbox-lifecycle` | `runtime/sandbox-lifecycle.mdx` | 0.85 |
| `/runtime/local-microvms` | `runtime/local-microvms.mdx` | 0.86 |
| `/runtime/sessions-and-memory` | `runtime/sessions-and-memory.mdx` | 0.79 |
| `/runtime/streaming` | `runtime/streaming.mdx` | 0.80 |
| `/runtime/egress` | `security/egress.mdx` | 0.74 |
| `/runtime/identity` | `security/identity.mdx` | 0.76 |
| `/runtime/receipts` | `security/receipts.mdx` | 0.77 |
| `/runtime/observability` | `observability/index.mdx` | 0.67 |
| `/security` | `security/index.mdx` | 0.72 |
| `/architecture` (interactive explorer) | `runtime/architecture.mdx` + `components/islands/*` (architecture-data/sequences/geometry/types ported) | 0.27 text (content is in island data files) |
| `/stack` | `runtime/stack.mdx` | 0.81 |
| `/deployment` | `operate/deployment.mdx` | 0.71 |
| `/operations` | `operate/operations.mdx` | 0.80 |
| `/api` | `reference/api.mdx` | 0.80 |
| `/cli` | `reference/cli.mdx` | 0.87 |
| `/sdk` | `sdks/index.mdx` | 0.74 |
| `/env-vars` | `reference/env-vars.mdx` + `components/docs/env-vars.json` + `EnvTable.astro` (data-driven; text overlap meaningless, all 182 vars verified present as `PAL_*`) | n/a |
| (new) changelog | `changelog.mdx` | new |
| _components: Brands.tsx, Diagram/Flow/SystemDiagram/RuntimeDiagram/PersonalHarness*, AgentLoop, ArchHome, CodeTabs, Search, Toc, Recording | `data/brands.ts`, `data/diagrams.ts`, `components/Diagram.astro`, `SysDiagram.astro`, `LayerStack.astro`, `ArchSvg.astro`, `Phone.astro`; Starlight search/TOC | moved (Recording: see GAP) |

## 2. Item-level table

### Features
| Item | Old source | New location | Status |
|---|---|---|---|
| Hero: "Run your agents in your own cloud"; microVM + crash-resume, spend caps, routing, signed receipts; VPC, Apache-2.0 | landing/page.tsx Hero | `pages/index.astro` | kept (reworded) |
| How: control plane thinks / microVM runs / host decides (3 steps) | page.tsx How | `pages/runtime/index.astro`, `data/diagrams.ts` | moved |
| PainFix x4 (own cloud, resume, refused before call, signed receipt) | page.tsx PainFix | `pages/runtime/index.astro` | moved |
| "Plus routing w/ failover, eval suites gate CI, sessions, schedules, 18 connectors" | page.tsx PainFix footer | `data/brands.ts` (18 connectors), `index.mdx` | moved |
| Budget-before-first-token section + enforced scope sentence | page.tsx Code | `pages/runtime/index.astro`, `build/budgets.mdx` | kept |
| Docs home: 4 paths (demo, quickstart, runtime quickstart, security, deployment) | docs/page.tsx `paths` | `index.mdx`, `start/*` | kept |
| Docs home features (durable exec, isolation classes, streaming, observability, budgets, evals) | docs/page.tsx `features` | `index.mdx` | kept |
| Docs home "new since 0.2.0" recent list | docs/page.tsx `recent` | `changelog.mdx` | moved |
| Agent lifecycle states (queued/running/succeeded/failed/cancelled) | agents | `build/agents.mdx`, `reference/api.mdx` | kept |
| Agent run triggers (dashboard/CLI/REST/schedule/surfaces) | agents | `build/agents.mdx` | kept |
| Capability model names (auto, reasoning-large/small, code-*, vision-*) | agents, models | `build/agents.mdx`, `build/models.mdx` | kept |
| Built-in tools web_search, shell_exec errors | agents | `build/agents.mdx` | kept |
| Sign-up modes, captcha 400/403/503, email verification, purge | accounts | `build/accounts.mdx` | kept (captcha error line shorter) |
| Confidence gate + estimators + calibration | human-in-the-loop | `pal/human-in-the-loop.mdx` | kept |
| Takeover grant/deny/release | examples, HITL | `pal/human-in-the-loop.mdx`, `start/examples.mdx` | kept |
| Crash-resume sweep steps 1-4, microVM-tier resume, `RESUME=1` | durable-execution | `runtime/durable-execution.mdx` | kept |
| Isolation classes decision tree | isolation | `runtime/isolation.mdx` | kept |
| Pause/resume/fork, snapshot artifacts | sandbox-lifecycle | `runtime/sandbox-lifecycle.mdx` | kept |
| Memory distillates (flag-gated) + endpoint | sessions-and-memory | `runtime/sessions-and-memory.mdx` | kept |
| Token streaming event contract | streaming | `runtime/streaming.mdx` | kept |
| Personal assistant: two hard gates, voice clone, quiet hours, env table | personal | `pal/index.mdx`, `pages/pal/index.astro` | kept |
| Surfaces: WhatsApp personal bridge, Slack, Telegram, voice (Twilio/LiveKit) | surfaces | `pal/surfaces.mdx` | kept |
| A2A cards, visibility rules, marketplace, MCP | marketplace | `build/marketplace.mdx` | kept |
| Helm values, bootstrap token, dev-vs-managed deps, migrations | deployment | `operate/deployment.mdx` | kept |
| Alerts list, backup/restore drill, kiosk guard, RLS enable | operations | `operate/operations.mdx` | kept |
| "Why Rust/Go/TS/Python" + glossary | stack | `runtime/stack.mdx` | kept |
| Broker demo: 3 PASS lines (no eth0; placeholder key -> 200; plain HTTP -> 403) | landing BrokerDemo.tsx | not found | **GAP** |
| Wax-seal mail-slot analogy for trigger secret | triggers | partly (mail-slot kept in egress; "wax seal" not found in triggers) | intentionally-dropped (analogy only) |

### Numbers / stats
| Item | Old source | New location | Status |
|---|---|---|---|
| 634 ms snapshot, 138 ms restore, <160 ms per fork | page.tsx TIMINGS | `pages/runtime/index.astro`, `runtime/sandbox-lifecycle.mdx` | kept; sourced by `docs/benchmarks/runtime-latency.md` (M4 Max, nested KVM, 1 vCPU/128 MiB) |
| Stop 207 ms; Fork 1/2/3 = 131/145/160 ms bar chart; "Milliseconds, one run" caption | page.tsx Measured | only 3 headline numbers on /runtime; per-step values in `sandbox-lifecycle.mdx` table (131/160 present, 207/145 not confirmed) | **restore-needed (minor)** |
| "indicative, nested KVM on an M4 Max", "laptop not bare metal" caveat | page.tsx Measured | `pages/runtime/index.astro` has "M4 Max" | kept |
| 18 connectors | page.tsx, connectors | `data/brands.ts`, `build/connectors.mdx` | kept |
| Fork fan-out "up to 1,000 (default 100), validated with 3 forks" | compare | `pages/compare/index.astro` | kept |
| E2B "up to 20" forks; ACE "thousands" (per Google) | compare | `pages/compare/index.astro` | kept; vendor claims, dated 2026-10-28 |
| Free-tier / quota / rate numbers (spawn burst 20, hook burst 10, 60/min, 1 MiB body, 30 s) | accounts, triggers, env-vars | same pages / `env-vars.json` | kept |
| Metrics `*.run.step.duration`, `.retries`, `.total`, `budget.check.errors` | observability, budgets | `observability/index.mdx` (`lantern.run.step.duration` seen; `.retries` name not found by grep), `build/budgets.mdx` | **verify** (names may still say lantern.* vs pal.*) |

### Connectors and brand logos
| Item | Old source | New location | Status |
|---|---|---|---|
| Logos: WhatsApp, iMessage, Slack, Discord, Telegram, Voice, Web Chat, GitHub, Gmail, Google, Notion, Linear | docs Brands.tsx | `data/brands.ts` (all, plus Calendar/Drive/Sheets/Jira/Sentry/PagerDuty/Vercel/HubSpot/Salesforce/Stripe/Twilio) | kept (expanded) |
| 18 connectors by group (comms, email/calendar, docs/storage, dev tools, CRM, commerce) with actions + auth | connectors | `build/connectors.mdx` (SOQL, create_incident, gmail.modify, Messaging Service confirmed) | kept |
| Per-connector `*_CONNECTOR_BASEURL_*` override, prod block | connectors | `build/connectors.mdx`, `env-vars.json` | kept |
| OAuth vs API-key setup flow, assign connectors to agent | connectors | `build/connectors.mdx` | kept |

### Comparisons
| Item | Old source | New location | Status |
|---|---|---|---|
| Home summary table (5 rows: VPC, crash-resume, spend caps, routing, creds outside sandbox) | page.tsx SUMMARY | `pages/runtime/index.astro` (checked "Apache-2.0"); row text not individually verified | kept/verify |
| Sandbox matrix, 11 rows x (Lantern, ACE, E2B, Modal) | compare/page.tsx SANDBOX | `pages/compare/index.astro` (gVisor, Titan, DLP, Proven at scale, up to 20 present) | kept |
| Platform matrix, 6 rows (durable, budgets, routing, receipts, self-host, availability) | compare PLATFORM | `pages/compare/index.astro` | kept |
| "Who should pick what" (ACE / E2B or Modal / Lantern) | compare picks | `pages/compare/index.astro` | kept |
| Footnote: vendor docs as of 2026-10-28; ACE deep dive Oct 22 2026 | compare | `pages/compare/index.astro` | kept |

### Code samples
| Item | Old source | New location | Status |
|---|---|---|---|
| Budget SDK sample (`budgets.upsert`, `maxCostUsdPerDay: 25`, `hardFail`) + 402 body `"daily spend would reach $25.0318 exceeding limit $25.0000"` | page.tsx Code | `pages/runtime/index.astro` (25.0318 and maxCostUsdPerDay found) | kept |
| Clone-and-run: `git clone ... && make demo` | page.tsx CLONE | `data/site.ts`, `start/demo.mdx` | kept |
| Trigger CodeTabs curl/TS/Python/Go/CLI | triggers | `build/triggers.mdx` | kept |
| SDK samples (TS/Python/Go, streaming, parallel fan-out) | sdk | `sdks/index.mdx` | kept |
| AgentSpec yaml (hello demo) | runtime/quickstart | `runtime/quickstart.mdx` | kept |
| Session SDK snippet, SSE event JSON | sessions, streaming | same | kept |

### FAQ / other
| Item | Old source | New location | Status |
|---|---|---|---|
| Privacy policy (entity "Lantern Assistant", contact support@lantern.run, effective June 2, 2026) | privacy/page.tsx | none | **GAP** |
| Terms of service (same entity/contact/date) | terms/page.tsx | none | **GAP** |
| SEO metadata (titles/descriptions per page) | each page `metadata` | frontmatter | kept |
| Search index script | docs/scripts/build-search-index.mjs | Starlight/Pagefind | intentionally-dropped (replaced) |
| robots/sitemap | robots.ts, sitemap.ts | Astro config | not checked |
| Recording component (embeds asciinema/gif) | docs Recording.tsx | `start/examples.mdx` mentions "recording" | verify |
| Dev credentials table, service ports | installation | `start/installation.mdx` | kept |
| Env var names LANTERN_* | all | `PAL_*` in docs; master Go code already reads `PAL_*` (e.g. `PAL_SIGNUP_MODE` in auth_lifecycle.go) | kept (renamed consistently; 182/182 on env-vars page) |

## 3. GAPS to restore

| # | Gap | Old text / code | Suggested target |
|---|---|---|---|
| 1 | Privacy page | Footer link `/privacy/`; entity `"Lantern Assistant"`, contact `support@lantern.run`, effective `June 2, 2026`; full text in `git show fd11a65d^:apps/landing/app/privacy/page.tsx` (203 lines). Rename entity/contact with owner OK (legal text, do not auto-rewrite). | new `src/pages/privacy` (marketing page), not docs |
| 2 | Terms page | same entity/contact/date; `git show fd11a65d^:apps/landing/app/terms/page.tsx` (170 lines) | new `src/pages/terms` |
| 3 | Broker demo (3 steps) | "Looks for a network card -> none: The VM has no network device. Its only way out is a socket to the host." / "Calls an API with the key 'placeholder' -> 200: The host swapped in the real credential... the agent only ever saw 'placeholder'." / "Sends the same call over plain HTTP -> 403: Refused by the host. A credential never leaves unencrypted." Source: infra/firecracker/broker-e2e.sh PASS lines, recording docs/media/egress-broker-kvm.gif | `security/egress.mdx` (broker mode section) and `pages/runtime/index.astro` |
| 4 | Broker poster/recording asset | `apps/landing/public/media/broker-run-poster.webp`, `docs/media/egress-broker-kvm.gif` | `public/media/` + `security/egress.mdx` |
| 5 | Per-step timing chart | Snapshot 634, Stop 207, Restore 138, Fork 1/2/3 = 131/145/160 ms; "One Firecracker run, 1 vCPU and 128 MiB per VM, on a laptop rather than bare metal"; links "Full benchmark" (docs/benchmarks/runtime-latency.md) and recording | `runtime/sandbox-lifecycle.mdx` (ensure 207 and 145 rows in table; add benchmark link) |
| 6 | Home summary "Not applicable / Out of scope" cells | `Spend caps: Daily caps; per-run cap on workflows only` vs `Out of scope; Modal partly`; `Credentials outside sandbox: Opt-in broker mode` vs `ACE by default; E2B (beta) and Modal (experimental) opt-in` | verify in `pages/runtime/index.astro`; full version already in `pages/compare/index.astro` |
| 7 | Metric names | `pal.run.step.retries`, `pal.run.total`, `pal.budget.check.errors` (old pages said lantern.*) | `observability/index.mdx`: new page still shows `lantern.run.step.duration`; decide one prefix and check `.retries`/`.total` rows exist |
| 8 | Minor prose dropped | "wax seal" trigger analogy (triggers); full "common HTTP status codes" blurb text (api: 400/401/403/404/402 list is present as table) | `build/triggers.mdx` (optional) |

Unverifiable / invented-number check: no invented latency figures found. 634/207/138/131/145/160 ms and "M4 Max, nested KVM, 1 vCPU 128 MiB" are sourced in
`docs/benchmarks/runtime-latency.md` (lines 72-78: M4 Max, macOS 15, nested KVM, Ubuntu 24.04, 4 vCPU/8 GiB guest, VM 1 vCPU/128 MiB). Vendor claims on
/compare ("thousands, memory-deduplicated (per Google)", E2B "up to 20", dated 2026-10-28) are third-party and unverifiable here; they carry "per Google"/date
qualifiers in the new page. "Proven at scale: Lima nested-KVM + CI only" is self-reported and accurate to the benchmark.

## Gap resolution (docs pass, site/v2-docs)

| # | Gap | Resolution |
| --- | --- | --- |
| 1 | `/privacy` page | OPEN, owner decision: legal text names an entity and contact; not a docs page (src/pages, landing owner). |
| 2 | `/terms` page | OPEN, same as 1. |
| 3 | 3-step broker demo | RESTORED as the "See it on a real VM" table in `docs/security/egress.mdx`. |
| 4 | Broker recording | RESTORED as a link to `docs/media/egress-broker-kvm.gif` from `docs/security/egress.mdx`; the webp poster stays dropped (no image needed for a link). |
| 5 | Per-step timings | RESTORED in `docs/runtime/sandbox-lifecycle.mdx#cost`: 131/145/160 ms forks, ~200 ms stop, benchmark link, run date, "not production" label. |
| 6 | Home summary cells | Landing/compare owner; the full matrix is on `pages/compare`. |
| 7 | Metric names | KEPT as `lantern.*`: that is what the code emits on master (they are wire names until the infra rename). |
| 8 | "Wax seal" analogy | Intentionally dropped (style only). |
