# Provider Landscape Research — April 2026

> **Sources:** Live web research, April 2026 (see citations inline). Knowledge cutoff for the synthesizing model is May 2025; everything in this document was verified against current vendor docs and recent third-party reviews.
>
> **Audience:** Lantern architects and engineers. The point is *not* to summarize every vendor — it's to identify what they each do well, what they each get wrong, and what we should steal vs. avoid.

---

## Methodology

We grouped the field into four buckets and evaluated each on the same dimensions:

| Dimension | What we looked for |
|---|---|
| **Core primitive** | Function? Agent class? Workflow graph? Sandbox? |
| **Isolation model** | Pod, microVM, V8 isolate, Wasm, Durable Object |
| **Durability** | How is run state journaled and replayed? |
| **Orchestration patterns** | Linear, parallel/fan-out, signals, sagas, HITL |
| **Model support** | Single vendor or multi-vendor? |
| **Cold start** | Real numbers, not marketing |
| **Pricing model** | Per request, per second, per token |
| **Lock-in surface** | What's portable, what's not |
| **One genuine differentiator** | Why someone picks them |
| **One real limitation** | Why someone leaves them |

---

## 1. Cloudflare Agents SDK + Workflows + Containers + Sandbox

**Core primitive:** TypeScript class (`Agent`) backed by a **Durable Object** — a stateful "micro-server" with its own embedded SQL database, WebSocket, and scheduler. Agents SDK v0.3.7 (Feb 2026) added first-class Workflows integration (`AgentWorkflow` class) for bidirectional communication between durable workflows and the originating Agent. ([Changelog](https://developers.cloudflare.com/changelog/post/2026-02-03-agents-workflows-integration/))

**Isolation model:** V8 isolates for the agent itself (~5ms cold start, but tiny memory ceiling, no native deps). For untrusted code or container workloads, Cloudflare Containers and the new Sandbox SDK run real OCI containers. ([Containers](https://developers.cloudflare.com/containers/), [Sandbox SDK](https://developers.cloudflare.com/sandbox/))

**Durability:** Workflows journal each step. State persists in Durable Object SQLite or D1.

**Orchestration:** Linear and parallel. Synchronous `setState()` with validation hooks. Fixed-interval scheduling via `scheduleEvery()`.

**Model support:** Workers AI (in-house), plus Bring-Your-Own via the AI Gateway. Now supports the OpenAI Agents SDK on top of Cloudflare's runtime. ([Building agents with OpenAI](https://blog.cloudflare.com/building-agents-with-openai-and-cloudflares-agents-sdk/))

**Differentiator:** Global edge execution. The agent literally runs near the user. Stateful Durable Objects without operating a database.

**Limitation:** **Lock-in is total.** The Agent class doesn't run anywhere but Cloudflare. Memory ceilings on isolates limit what you can do without Containers. No GPU.

**What we steal:** The "agent = a class with state" mental model. The synchronous state hook. WebSocket-first design.

**What we avoid:** Vendor lock-in via Durable Objects. We use Postgres + Redis instead.

---

## 2. Vercel AI SDK + AI Gateway + v0

**Core primitive:** A function call to a model, optionally wrapped in `ToolLoopAgent` — a model + tools loop that auto-iterates until the model finishes. ([Vercel AI SDK](https://ai-sdk.dev/docs/introduction))

**Isolation model:** Vercel Functions (Lambda under the hood). No microVM story for untrusted user code.

**Durability:** None native — durability is delegated to Temporal via the official Temporal + Vercel AI SDK integration. ([Temporal blog](https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel))

**Orchestration:** ToolLoopAgent (autonomous loop). Linear primarily. Multi-step via the SDK's `streamText` + `experimental_continueSteps`.

**Model support:** Best-in-class. **AI Gateway** is a unified OpenAI/Anthropic-compatible endpoint at `https://ai-gateway.vercel.sh/v1` with hundreds of models, automatic failover, BYOK, observability, budgets, embeddings, and "no markup on tokens." Recent additions: GLM 5.1 (long-horizon), Claude Opus 4.6 Fast Mode (2.5x faster output). ([AI Gateway docs](https://vercel.com/docs/ai-gateway))

**Differentiator:** **AI Gateway is the cleanest multi-model abstraction in the industry.** Single endpoint, single key, transparent failover, no markup. Generation IDs injected on the first stream chunk for resilient resumption.

**Limitation:** No durable execution. No sandbox/isolation primitive. Vercel Functions are for short HTTP requests, not long-running agents.

**What we steal:** AI Gateway's exact API surface and the "no markup, transparent failover" pricing. The streaming generation-ID-on-first-chunk pattern.

**What we avoid:** Building the agent runtime on top of FaaS. Long-running agents need a different substrate.

---

## 3. Modal Labs

**Core primitive:** A Python function decorated with `@app.function`. Fully serverless: no Dockerfiles, no K8s, no YAML. ([Modal docs](https://modal.com/docs/guide))

**Isolation model:** Custom container runtime. **GPU memory snapshots** (alpha) capture VRAM weights, CUDA kernels, and execution context. Up to 10x faster cold starts on snapshotted GPU workloads; 2-4s typical without snapshots. ([Modal cold start](https://modal.com/docs/guide/cold-start), [GPU snapshot](https://modal.com/docs/examples/gpu_snapshot), [Modal + Mistral 3](https://modal.com/blog/mistral-3))

**Durability:** Function-level retries; no full durable execution graph natively.

**Orchestration:** Map/reduce (`function.map(...)`), sequential, queues. No first-class HITL or sagas.

**Model support:** BYO. Most users run their own model containers.

**Differentiator:** **Best GPU cold start in the serverless category** when combined with snapshotting. Python-first DX is superb — `modal serve` to dev locally with cloud execution.

**Limitation:** Python-only. No real durable workflow story. Snapshotting still alpha as of April 2026.

**What we steal:** GPU snapshot/restore approach. The "function.map" parallel primitive. Local→cloud dev loop.

**What we avoid:** Python-only positioning. We need TS/Go/Python parity.

---

## 4. E2B

**Core primitive:** A `Sandbox` — a Firecracker microVM you spawn from an SDK call. Optimized for AI-generated code execution. ([E2B](https://e2b.dev/), [GitHub](https://github.com/e2b-dev/E2B))

**Isolation model:** **Firecracker microVMs**, the same tech that powers AWS Lambda. Each code execution runs in its own kernel — hardware-level isolation, not process-level.

**Cold start:** **~150ms boot times** (verified April 2026). ([Northflank: Daytona vs E2B](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes))

**Durability:** Sandboxes are ephemeral by design.

**Model support:** Provider-agnostic — sandboxes don't care, you bring the LLM.

**Differentiator:** **Best-in-class isolation latency for untrusted AI code.** Massive scale: 40k sessions/month → 15M sessions/month in 12 months (Mar 2024 → Mar 2025). ~50% of Fortune 500 reportedly running agent workloads on it.

**Limitation:** Just a sandbox — no orchestration, no agent loop, no model routing. You build the rest.

**What we steal:** Firecracker as the default isolation substrate for the `untrusted` isolation class. The 150ms cold-start target.

**What we avoid:** Treating sandboxes as the whole product. Sandboxes are a runtime, not a platform.

---

## 5. Daytona

**Core primitive:** A long-lived **workspace sandbox** with persistent state, Git, LSP, and computer-use capabilities (Linux/macOS/Windows desktops). ([Daytona](https://www.daytona.io/), [Series A](https://www.prnewswire.com/news-releases/daytona-raises-24m-series-a-to-give-every-agent-a-computer-302680740.html))

**Isolation model:** OCI/Docker-compatible sandboxes. **<90ms boot times** ([Daytona](https://www.daytona.io/)).

**Durability:** Workspaces persist across agent sessions. Install a package once, it stays.

**Orchestration:** None — same as E2B, you bring the orchestrator.

**Differentiator:** **Persistent workspaces.** Most sandbox tools are stateless; Daytona treats them as long-lived. Plus computer use across desktops. **Open source — you can self-host.**

**Limitation:** Same as E2B: a runtime, not a platform.

**What we steal:** Persistent workspace mode for the `devcontainer` runtime class. Open-source self-hostability as a tier-1 promise.

---

## 6. LangGraph Platform / LangSmith Deployment

**Core primitive:** A **graph** of nodes, where each node is a function. Edges define the control flow; conditional edges allow branching. ([LangGraph](https://github.com/langchain-ai/langgraph), [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence))

**Isolation model:** Container per deployment. Multi-tenant via process isolation.

**Durability:** **Checkpointing.** When compiled with a checkpointer, a snapshot of graph state is saved at every step. Threads organize the snapshots. **If one node in a parallel super-step fails, LangGraph keeps the other nodes' outputs and only re-runs the failed one.** ([Checkpointing architecture](https://deepwiki.com/langchain-ai/langgraph/4.1-checkpointing-architecture))

**Orchestration:** Graphs (linear, parallel super-steps, conditional edges, cycles). HITL via interrupts. **Time travel debugging** via checkpoint history. TTLs on threads and long-term memory entries.

**Model support:** Provider-agnostic via LangChain.

**Differentiator:** **The graph mental model and checkpoint-per-superstep durability are unique.** Time travel is genuinely useful.

**Limitation:** LangChain heritage means surface-area sprawl and abstraction creep. Renamed to "LangSmith Deployment" in October 2025, which signals consolidation but also churn.

**What we steal:** Per-superstep checkpointing. Time travel. TTLs on threads and memory. Partial-failure-aware retry for parallel super-steps.

**What we avoid:** The deep LangChain abstraction layers. Our `step()` API is intentionally lower-level.

---

## 7. OpenAI Agents SDK + Responses API

**Core primitive:** An `Agent` (Python class) with **tools**, **handoffs**, and **guardrails**. ([Agents SDK](https://openai.github.io/openai-agents-python/))

**Isolation model:** Runs in your process. No isolation primitive of its own — bring your own.

**Durability:** None native. Temporal integration provides this externally. ([Temporal blog](https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel))

**Orchestration:**
- **Handoffs:** an agent delegates to another. Represented as tools to the LLM (`transfer_to_<agent>`).
- **Guardrails:** input guardrails before the first agent runs; output guardrails after the final agent. Tool guardrails run on every tool call.
- **Streaming.** ([Guardrails docs](https://openai.github.io/openai-agents-python/guardrails/), [Handoffs docs](https://openai.github.io/openai-agents-python/handoffs/))

**Model support:** Provider-agnostic — works with OpenAI **Responses API** (which is replacing the Assistants API; sunset target mid-2026), Chat Completions, and 100+ other LLMs via Chat Completions–style endpoints.

**Differentiator:** **The handoff pattern is the cleanest multi-agent primitive in the industry.** Modeling delegation as a tool call lets the LLM reason about it natively.

**Limitation:** No durable execution. No isolation. You're on your own for production.

**What we steal:** Handoffs-as-tools. Input/output guardrails as a first-class concept. The Responses API surface.

**What we avoid:** Living in-process only. Lantern runs the agent loop on durable infrastructure.

---

## 8. Anthropic Claude Managed Agents + Claude Agent SDK

**Core primitive:** Two products:
1. **Claude Agent SDK** — runs in your process; you own the runtime. ([SDK](https://github.com/anthropics/claude-agent-sdk-python))
2. **Claude Managed Agents** (launched April 8, 2026) — fully hosted; Anthropic runs the agent for you. ([Anthropic announcement](https://www.anthropic.com/engineering/managed-agents), [docs](https://platform.claude.com/docs/en/managed-agents/overview))

**Isolation model:** For Managed Agents, Anthropic runs the agent on its own sandboxing — they describe it as "decoupling the brain from the hands."

**Pricing:** Normal Claude token rates **plus $0.08 per session-hour** while a Managed Agents session is running. (As of April 10, 2026.)

**Durability:** Long-horizon via Managed Agents. Sessions can run for hours.

**Orchestration:** Tool use, sub-agents, MCP servers. Computer use is mature.

**Model support:** Claude only.

**Differentiator:** **Fully managed long-horizon agent execution from the model vendor.** Initial customers: Notion, Rakuten, Asana.

**Limitation:** **Single model vendor** (this is the whole point of Lantern's existence). The $0.08/session-hour fee scales linearly.

**What we steal:** The "decoupling brain from hands" mental model. Computer use is a tier-1 tool category.

**What we avoid:** Single-model lock-in. We bake multi-model into the core.

---

## 9. Temporal (general durable execution)

**Core primitive:** A **Workflow** (deterministic function) and **Activities** (side-effecting functions). ([Temporal](https://temporal.io/))

**Durability:** Event-sourced. Every workflow event is journaled. On crash/restart, the workflow re-executes deterministically and skips events already in the journal.

**Orchestration:** Anything you can express as code: linear, parallel, signals, queries, child workflows, sagas, sleeps that survive process restarts (workflows can run for years).

**2026 platform additions:** Temporal Nexus (cross-namespace workflows) GA, Multi-Region Replication GA with 99.99% SLA, Temporal Cloud on GCP, Ruby + .NET SDKs. **Official OpenAI Agents SDK integration** brings durable execution to OpenAI's framework. ([Temporal AI](https://temporal.io/solutions/ai))

**Differentiator:** **The most battle-tested durable execution engine in production.** True deterministic replay.

**Limitation:** **Steep learning curve.** Workflow code must be deterministic, which catches everyone the first time. Operations is non-trivial — Temporal Cloud helps but isn't free.

**What we steal:** **The entire durable execution model.** Lantern's workflow engine is Temporal-shaped: deterministic functions, event journal, replay on restart. We borrow signals, queries, child workflows.

**What we avoid:** Forcing users to write deterministic code by hand. Lantern's `step()` API hides the determinism trap by making non-step code an explicit error.

---

## 10. Inngest

**Core primitive:** A **function** composed of **steps** (`step.run`). Each step is a unit of work, retried independently, results cached. ([Inngest steps](https://www.inngest.com/docs/features/inngest-functions/steps-workflows))

**Durability:** Checkpoint-based. Failures retry from the last successful step, not from scratch.

**Orchestration:** Steps, sleeps, signals (waitForEvent), parallel steps, queues. Triggers from events, cron, HTTP.

**2026 additions:** Agent Skills (Feb 2026) for AI coding agents. ([Inngest changelog](https://www.inngest.com/changelog))

**Differentiator:** **Lowest learning curve for durable execution.** "Just wrap your code in `step.run`." The DX wins for teams that don't want to think about determinism rules.

**Limitation:** Less powerful than Temporal — fewer primitives, no multi-region replication GA, smaller ecosystem.

**What we steal:** **The `step.run` ergonomic.** This is the Lantern SDK's primary API. Easier than Temporal's workflow/activity split.

---

## 11. Honorable mentions (briefer)

- **AWS Bedrock Agents:** Tightest AWS integration; tied to Bedrock-hosted models. Step Functions for complex flows. Lock-in to AWS.
- **Google Vertex AI Agent Builder + ADK:** Agent Development Kit (ADK) is Google's open SDK; runs on Vertex Agent Engine for managed deployment. Strong tooling for grounding on Google Search and Vertex Search.
- **Mastra:** TypeScript-native agent framework with built-in workflows, eval, and memory. Smaller team, fast-moving.
- **CrewAI:** Multi-agent role-based orchestration. Good for "team of agents with personas" patterns. Less infra story.
- **Letta (formerly MemGPT):** Agent memory system specifically — self-editing long-term memory + recall retrieval. We borrow the **memory tier** model: core, recall, archival.

---

## Firecracker / microVM landscape

- **Firecracker snapshot/restore:** Verified production-grade. Real-world reports: **~28ms boot from snapshot** by mapping the snapshot file via `MAP_PRIVATE` and resuming CPU state directly — no kernel boot, no init. ([28ms blog post](https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k))
- **AWS Lambda SnapStart** uses this exact technique. ([SnapStart](https://elasticscale.com/blog/aws-lambda-snapstart-reducing-cold-start-times-with-firecracker/))
- **Kata Containers** offers 150-300ms startup overhead with K8s RuntimeClass integration; deployable on AWS EKS bare-metal.
- **firecracker-containerd** (project by AWS) bridges Firecracker to containerd, enabling K8s integration via runtime classes.
- **State of MicroVM Isolation 2026** ([emirb.github.io](https://emirb.github.io/blog/microvm-2026/)) — comprehensive review confirming Firecracker is still the best fit for ephemeral, untrusted code.

**Lantern decision:** Firecracker via firecracker-containerd as the default `untrusted` runtime. Kata for `hostile`. K8s Job pods for `trusted`. WASI for `wasm`. See `docs/adr/0002-microvm-runtime.md`.

---

## What this means for Lantern

We are not building a clone. We are picking the **best primitive from each** and unifying them into a single platform with **none of the lock-in**:

| From | We take |
|---|---|
| **Vercel AI Gateway** | Multi-model abstraction, transparent failover, no markup, generation-id-first streaming |
| **Cloudflare Agents** | "Agent = stateful class" mental model, WebSocket-first runtime |
| **Modal** | GPU snapshot/restore, function.map, local→cloud dev loop |
| **E2B** | Firecracker as default `untrusted` runtime, 150ms cold start target |
| **Daytona** | Persistent workspaces for `devcontainer` class, open-source self-hostability |
| **LangGraph** | Per-superstep checkpointing, time travel, partial-failure-aware retries |
| **OpenAI Agents SDK** | Handoffs-as-tools, input/output/tool guardrails |
| **Claude Managed Agents** | "Decouple brain from hands" model, computer use as tier-1 |
| **Temporal** | Event-sourced durable execution, signals, queries, child workflows |
| **Inngest** | `step.run` as the primary user-facing API |
| **Letta** | Memory tier model: core / recall / archival |
| **Firecracker** | 28ms snapshot-restore as the cold-start floor |

What no one else has yet, and what Lantern will:

1. **All of the above in a single platform**, not bolted together by the user.
2. **Cost-aware big/small model routing** that learns from past runs (no one is doing this well).
3. **Context manager** that compacts tool results, summarizes long histories, and reuses prompt cache across steps automatically.
4. **First-class polyglot SDKs** (TS, Python, Go) with identical semantics — most platforms are Python-first or TS-first only.
5. **Truly portable agent bundles** — same bundle runs on K8s Job, Firecracker, Kata, Wasm, or local dev with no rebuild.
6. **Self-hostable** as a tier-1 promise (Helm chart on day one).

---

## Citations

- Cloudflare: [Agents docs](https://developers.cloudflare.com/agents/), [Workflows](https://developers.cloudflare.com/workflows/), [Containers](https://developers.cloudflare.com/containers/), [Sandbox SDK](https://developers.cloudflare.com/sandbox/), [v0.3.7 changelog](https://developers.cloudflare.com/changelog/post/2026-02-03-agents-workflows-integration/)
- Vercel: [AI Gateway docs](https://vercel.com/docs/ai-gateway), [AI SDK](https://ai-sdk.dev/docs/introduction)
- Modal: [Cold start](https://modal.com/docs/guide/cold-start), [GPU snapshot](https://modal.com/docs/examples/gpu_snapshot), [Mistral 3 blog](https://modal.com/blog/mistral-3)
- E2B: [Site](https://e2b.dev/), [GitHub](https://github.com/e2b-dev/E2B), [Northflank comparison](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes)
- Daytona: [Site](https://www.daytona.io/), [Series A](https://www.prnewswire.com/news-releases/daytona-raises-24m-series-a-to-give-every-agent-a-computer-302680740.html)
- LangGraph: [Persistence docs](https://docs.langchain.com/oss/python/langgraph/persistence), [Checkpointing architecture](https://deepwiki.com/langchain-ai/langgraph/4.1-checkpointing-architecture), [Why LangGraph Platform](https://blog.langchain.com/why-langgraph-platform/)
- OpenAI: [Agents SDK](https://openai.github.io/openai-agents-python/), [Guardrails](https://openai.github.io/openai-agents-python/guardrails/), [Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- Anthropic: [Managed Agents engineering blog](https://www.anthropic.com/engineering/managed-agents), [docs](https://platform.claude.com/docs/en/managed-agents/overview), [Agent SDK Python](https://github.com/anthropics/claude-agent-sdk-python)
- Temporal: [Temporal AI](https://temporal.io/solutions/ai), [Building durable agents with Vercel AI SDK](https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel)
- Inngest: [Steps & Workflows](https://www.inngest.com/docs/features/inngest-functions/steps-workflows), [Durable Execution](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents)
- Firecracker: [Snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md), [28ms blog](https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k), [State of MicroVM 2026](https://emirb.github.io/blog/microvm-2026/), [firecracker-containerd](https://github.com/firecracker-microvm/firecracker-containerd)
