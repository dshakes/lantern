# AGENT.md — The Lantern Agent Bundle Specification

> **What this document is:** the file-format spec for a Lantern agent bundle. Read this if you are writing an agent, building an SDK, or implementing the agent loader.
>
> **What this document is not:** a tutorial. For that, see `docs/user-guides/quickstart.md`.

---

## Goals of the spec

1. **Declarative first, code second.** A user can describe an agent in YAML and never write a line of code. They can also write the whole thing in TypeScript or Python and skip YAML entirely. Both compile to the same bundle.
2. **Portable.** A bundle is a self-contained, content-addressed tarball. Same bundle runs locally (`lantern dev`), on K8s Jobs, in a Firecracker microVM, or in a Wasmtime sandbox.
3. **Versioned and signed.** Every bundle has a semver, an immutable digest, and an optional cosign signature.
4. **Composable.** Agents can call other agents (sub-agents) through a typed RPC, and the runtime treats this as a step in the parent's workflow.

---

## Bundle layout

```
my-agent/
├── agent.yaml          REQUIRED — manifest (see below)
├── README.md           OPTIONAL — shown in dashboard
├── src/                code (TS, Python, Go — language picked in manifest)
│   ├── index.ts
│   └── ...
├── tools/              OPTIONAL — custom tool definitions
│   └── search.ts
├── prompts/            OPTIONAL — versioned prompt templates
│   └── plan.md
├── tests/              OPTIONAL — agent-level tests (run by `lantern test`)
└── .lanternignore        OPTIONAL — files to exclude from the bundle
```

After `lantern build`:

```
.lantern/build/
├── bundle.tar.zst      content-addressed, the thing that gets pushed
├── manifest.lock.json  resolved manifest with digests
└── snapshot.fcs        OPTIONAL — Firecracker snapshot for fast cold start
```

---

## `agent.yaml` — the manifest

Minimal example:

```yaml
lantern: 1                     # spec version, integer
name: research-agent         # [a-z0-9-]{1,63}
version: 0.3.1               # semver
runtime: nodejs-22           # see "Runtimes" section below
entry: src/index.ts          # main file relative to bundle root
```

Full example with every field:

```yaml
lantern: 1
name: research-agent
version: 0.3.1
description: A research agent that plans, searches, and synthesizes.
authors:
  - name: Acme Inc
    email: agents@acme.dev

runtime: nodejs-22
entry: src/index.ts
build:
  install: pnpm install --frozen-lockfile
  command: pnpm build
  artifacts: [dist/]

# How the agent is invoked
input:
  schema:
    type: object
    properties:
      query: { type: string, minLength: 1 }
    required: [query]
output:
  schema: { type: string }   # JSON schema for the response

# Models the agent may call. Addressed by capability, not name.
models:
  default: auto                  # router picks
  reasoning: reasoning-large      # for plan steps
  fast: chat-small                # for tool dispatch
  embedding: embed-small          # for memory writes

# Tools the agent is allowed to call
tools:
  - lantern.web                  # built-in: web search + fetch
  - lantern.python               # built-in: sandboxed Python interpreter
  - lantern.fs                   # built-in: scoped filesystem
  - ./tools/search.ts          # custom tool

# Memory backends
memory:
  - kind: vector
    name: facts
    scope: user                 # tenant | user | run
    embedding: embed-small
  - kind: kv
    name: prefs
    scope: user

# Resource limits per run
limits:
  cpu: "2"                     # vCPUs
  memory: 2Gi
  timeout: 30m
  max_steps: 200
  max_tokens: 2_000_000
  max_cost_usd: 5.00

# Where it runs. Defaults are usually right.
isolation:
  class: standard              # trusted | standard | untrusted | hostile
  # trusted   → K8s Job pod (no microVM)
  # standard  → Firecracker microVM (default)
  # untrusted → Firecracker + egress allowlist + readonly rootfs
  # hostile   → Kata Containers + seccomp deny-all-but

# Triggers — how runs get started
triggers:
  - kind: api                  # POST /v1/agents/research-agent/runs
  - kind: schedule
    cron: "0 9 * * MON"
  - kind: webhook
    secret: lantern.secret/github_webhook
  - kind: event
    topic: documents.created

# Notifications when runs reach terminal states
notify:
  on_failure:
    - slack: lantern.secret/slack_oncall
  on_complete:
    - email: research@acme.dev
  on_approval_required:
    - inapp: true

# Concurrency and rate limits
concurrency:
  max_in_flight: 50            # per-tenant cap
  per_user: 5                  # per end-user cap
  queue: priority              # fifo | priority | fair-share

# Approvals — gates the agent can request
approvals:
  spend_over_usd: 1.00         # auto-approve under $1
  policies:
    - file_writes_outside: ['/tmp', '/workspace']
    - egress_to_unlisted_domain: deny

# Metadata for the dashboard, billing, observability
labels:
  team: research
  cost_center: r-and-d
  pii: false
```

---

## Runtimes

| `runtime` | What you get |
|---|---|
| `nodejs-22` | Node 22 LTS, npm/pnpm/yarn, native ESM, TS via tsx |
| `python-3.12` | Python 3.12, pip/uv/poetry |
| `go-1.23` | Go 1.23 |
| `bun-1.1` | Bun 1.1 |
| `wasm` | WASI-preview2; pure-function only, no network |
| `container` | BYO Dockerfile |
| `devcontainer` | A devcontainer.json — long-running, IDE-like |

The runtime determines the base image, the language SDK injected as `@lantern/sdk`, and the snapshot strategy.

---

## Programmatic surface — TypeScript

```ts
import { agent, step, tool } from "@lantern/sdk";

export default agent({
  name: "research-agent",
  // The whole agent.yaml fields are accepted here too;
  // lantern build merges yaml + decorator and writes manifest.lock.json.
  async run({ input, ctx }) {
    // ctx.llm   — model router client
    // ctx.tools — typed accessor to declared tools
    // ctx.mem   — memory backends (typed by name)
    // ctx.log   — structured logger, OTel-attached
    // ctx.signal — abort signal honoring server-side cancel
    // ctx.approval — request human approval (suspends durably)

    const plan = await step("plan", async () => {
      return ctx.llm.json({
        capability: "reasoning-large",
        schema: PlanSchema,
        prompt: `Make a research plan for: ${input.query}`,
      });
    });

    const findings = await step.map("search", plan.subqueries, async (q) => {
      return ctx.tools.web.search(q);
    }, { concurrency: 8 });

    const cost = ctx.cost.estimateUsd();
    if (cost > 0.50) {
      await ctx.approval.request({
        reason: `Synthesis will cost ~$${cost.toFixed(2)}`,
        timeout: "10m",
      });
    }

    return await step("synth", async () =>
      ctx.llm.stream({
        capability: "reasoning-large",
        prompt: synthPrompt(findings),
      })
    );
  },
});
```

### Step semantics

- **`step(name, fn)`** — runs `fn` and persists the return value as a journal entry. On replay, the journal entry is returned without re-running `fn`. Steps must be **deterministic given their inputs** (the inputs come from `input` and previous steps' outputs).
- **`step.map(name, items, fn, opts)`** — fan-out parallel. Each child has a stable ID derived from its index + a hash of `items[i]`. Replay-safe.
- **`step.race(name, fns)`** — first-success wins; losers are cancelled.
- **`step.sleep(name, duration)`** — durable sleep, survives crashes.
- **`step.signal(name)`** — wait for an external signal via API.

If your code does I/O outside a `step`, the engine will throw `NondeterministicReplayError` on the next replay. This is intentional.

---

## Sub-agents

```ts
const summary = await ctx.subagent("summarizer-agent", { text: longDoc });
```

This is a typed gRPC call to the control plane that schedules a child run, blocks until it completes, and replays as a single step in the parent's journal.

---

## Bundle digest and signing

```
$ lantern build
✓ bundle.tar.zst  sha256:1f2e...  18.2 MB
✓ manifest.lock.json
$ cosign sign --key lantern.key bundle.tar.zst
$ lantern push
✓ pushed to lantern.dev/acme/research-agent@sha256:1f2e...
```

The control plane verifies the cosign signature against tenant-trusted keys before scheduling.

---

## Schema reference

The full JSON schema for `agent.yaml` lives at `packages/sdk-ts/src/schema/agent.schema.json` and is regenerated from a single TypeScript source of truth in `packages/shared-types/src/agent.ts`. Changes to that file require an ADR.

---

## See also

- `docs/architecture/05-workflow-engine.md` — how steps are journaled and replayed
- `docs/architecture/04-runtime-isolation.md` — how `isolation.class` maps to physical runtimes
- `docs/adr/0007-agent-bundle-format.md` — why we picked tarballs over OCI images for bundles
