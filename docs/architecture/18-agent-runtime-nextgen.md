# 18 — Agent Runtime: Next-Generation Strategy & Gap Analysis

- **Status:** Proposal (for review)
- **Date:** 2026-06-18
- **Owner:** Runtime team
- **Branch:** `feat/agent-runtime-nextgen`
- **Related:** [ADR 0009 — Kubernetes as default runtime substrate](../adr/0009-kubernetes-default-runtime-substrate.md), [04-runtime-isolation](04-runtime-isolation.md), [04b-microvm-productionization](04b-microvm-productionization.md), [05-workflow-engine](05-workflow-engine.md), [17-deployment-model](17-deployment-model.md)

> This is a strategy + gap-analysis document, not a spec. It establishes **where the
> enterprise agent-runtime market is going (2025–2028)**, **where the named
> incumbents lead and lag**, **where Lantern's runtime genuinely stands today
> (honest, stub-aware)**, and a **prod-grade phased roadmap** to put Lantern on par
> with — then ahead of — AWS Bedrock AgentCore, Google Vertex Agent Engine,
> Anthropic (Agent SDK + Managed Agents), OpenAI's agent suite, and Temporal.
> Every phase carries explicit **test + validation gates** — no phase is "done"
> on a green typecheck alone.

---

## 0. Executive summary

**The category crystallized in 2025–2026.** The "agent runtime" is now a distinct
infrastructure tier sitting between the model and the app. The whole field has
converged on the same stack shape:

> **per-session hardware isolation + durable execution + governed per-agent identity
> + open interop (MCP/A2A) + OTel-native observability + a real memory layer.**

Every layer is being individually commoditized by a well-funded vendor. **The
defensible, futuristic position is vertical integration** — a single fabric where
the microVM boot, the durable journal entry, the agent's short-lived identity, the
signed receipt, the OTel span, and the memory mutation are *the same event*,
end-to-end traceable and externally verifiable. Golem calls this missing tier the
**"agent execution kernel."** It maps almost exactly onto Lantern's existing
control-plane/data-plane split + `journal_events` + `run_receipts` + per-session
microVM + cross-channel memory. **That coherence is the thing no single-layer
vendor can ship — and it is Lantern's wedge.**

**Where Lantern is today (honest, verified 2026-06-18 by reading the code, not a
summary):** the runtime is **substantially further along than an earlier draft of
this doc implied**. The architecture and contracts are genuinely strong and ahead of
the field on *design* (six isolation classes, a clean scheduler/manager/harness proto
split, defense-in-depth egress, tenant-bound secret relay with mTLS, signed receipts,
cross-channel memory), and most of the data path is real:

- **Scheduler → Manager dispatch** is a real `GRPCDialer` (connection-pooled,
  per-node), selected whenever `LANTERN_DEFAULT_MANAGER_ADDR` is set; the
  `LogOnlyDialer` is only a dev fallback. *Not a blocker.*
  (`services/runtime-scheduler/internal/dialer/manager.go`,
  `cmd/scheduler/main.go:97`)
- **Control-plane → Scheduler** is a real `grpcSchedulerClient`, selected on
  `LANTERN_SCHEDULER_GRPC_ADDR`; `stubSchedulerClient` is the unset fallback.
  *Not a blocker.* (`services/control-plane/internal/handlers/runtime.go:442`)
- **Harness `VendSecret`** calls the real `RuntimeHarness.VendSecret` RPC over an
  mTLS tonic channel (`tls.rs`); the stub is an explicit opt-in
  (`LANTERN_ALLOW_SECRET_STUB=1`). *Done.*
- **Harness heartbeat stream** — *was* a loopback stub (heartbeats dropped, egress
  revocations never propagated). **Closed in this branch** (commit on
  `feat/agent-runtime-nextgen`): a real bidirectional `RuntimeHarness.Heartbeat`
  tonic stream over the same mTLS channel, with proto round-trip conversions and
  unit tests.

**What genuinely remains for Phase 0:** (1) the manager-side **Report ingestion
pipeline** is `unimplemented` (`service.rs` `report` handler), so harness OTLP/log
forwarding has nowhere to land; (2) the wiring is **config-gated, not yet the
default** (env vars must be set) — making it the default is part of the K8s-default
work (Phase 1); (3) there is **no end-to-end integration test on a real cluster**
proving `schedule → place → spawn → mTLS heartbeat → vend secret → egress-deny →
terminate` with zero mocks. Phase 0 is "prove it boots end-to-end and make the real
path the default"; it is mostly *validation + defaulting*, not greenfield.

**The directional bet (this branch):** **make Kubernetes the default substrate**
(ADR 0009) and express isolation as a **RuntimeClass tier on a pod**
(runc → gVisor → Kata/Firecracker), the same architecture GKE Agent Sandbox and
Northflank converged on in 2026. This unifies five backends into one substrate,
matches Lantern's data-plane-on-customer-K8s deployment model, and preserves the
hard invariant that untrusted/hostile code never runs in a bare shared-kernel pod.

---

## 1. Market & industry trends (2025–2026 → 2028)

Sourced from a June 2026 sweep of primary vendor docs, standards bodies, and
analyst material. Treat funding figures / exact version tags as directional.

### 1.1 Isolation & sandboxing — per-session microVMs are table stakes
- **One microVM per *session*** (not per tenant, not per agent type) is the new
  default unit, driven by prompt-injection containment and per-session FS state.
- **The cold-start race is won by snapshot/restore.** Firecracker snapshot restore
  is at p50 ~3.2ms / p99 ~8.7ms; practitioner builds hit ~28ms end-to-end. "Idle is
  free, active is metered to the millisecond" (Blaxel perpetual-standby, <25ms resume).
- **Field:** E2B (OSS Firecracker), Modal (gVisor + GPU memory snapshots),
  Daytona (27ms, $24M Series A), Vercel Sandbox (Firecracker, GA Jan 2026),
  Cloudflare (DO isolates + Sandbox container + **Outbound Workers** zero-trust egress),
  Fly.io Sprites (per-agent persistent Firecracker, 100GB NVMe), **GKE Agent Sandbox**
  (gVisor default + Kata option, warm pool 300 sandboxes/sec/cluster, GA May 2026),
  AWS AgentCore Runtime (per-session microVM, 8h).
- **The Wasm split is the emerging architecture:** WASI Preview 2 / Component Model
  is stable → **Wasm at the tool layer** (sub-ms, capability-typed, signed components
  from an OCI registry as MCP tools, cf. Microsoft **Wassette**) **under microVMs at
  the agent layer**.
- **Frontier:** sub-5ms p99 restore; per-session microVM + persistent NVMe;
  deny-all egress with per-request credential injection; GPU via gVisor nvproxy;
  confidential-compute attestation (SEV-SNP / TDX + Hopper TEE, ~7% overhead).

### 1.2 Durable execution — "durable agent" is the default substrate
- The forcing logic: 5 steps × 99% = 95% end-to-end; agents chain LLM calls, tools,
  and **multi-day human waits** — a crash mid-run must not re-spend tokens or
  re-fire side effects.
- **Load-bearing distinction (Diagrid):** *checkpoints ≠ durable execution.*
  LangGraph/CrewAI/ADK give you save-points *you* must detect and resume. True
  durable execution adds automatic failure detection, recovery, duplicate
  prevention, and replay-based resumption — transparently. **This is the single
  most-cited gap in the market.**
- **Field:** Temporal (event sourcing; OpenAI Agents SDK integration GA 2026;
  $300M Series D), Restate, DBOS (durable execution as a Postgres library), Inngest
  (`step.ai` caches LLM results across retries), Cloudflare Workflows V2, Vercel WDK,
  Azure Durable Task + MS Agent Framework, AWS Step Functions + AgentCore.
- **Frontier:** *adaptive durability* (runtime auto-classifies steps by cost &
  reversibility); *agent-authored orchestration* (agent emits its own step graph
  per task); semantic saga/compensation; per-step cost in the event log
  ("cost time-travel"); zero-downtime version migration of in-flight workflows.

### 1.3 Governance & security — three hard deadlines forcing the architecture
- Non-human identities outnumber humans 90–144:1; AI credential exposures +81% YoY.
- Convergence: **no static keys, per-instance agent identity, JIT task-scoped
  permissions, default-deny egress, hash-chained audit, signed receipts.**
- **Standards moving fast:** SPIFFE/SPIRE extended to agents; IETF **WIMSE**;
  **AIMS** (WIMSE+SPIFFE+OAuth+OIDC); Anthropic Workload Identity Federation;
  MS Entra Agent ID; Okta for AI Agents. **OWASP Top 10 for Agentic Applications
  2026** (goal hijack, tool misuse, memory poisoning, rogue agents) with design
  principles **Least-Agency** + **Strong Observability**. **NIST AI 600-1**;
  **EU AI Act high-risk gate Aug 2, 2026** (automatic event logging, Article 14
  human oversight, Article 50 content marking) — the biggest forcing function for
  audit trails.
- **Prompt injection is acknowledged unsolvable at the model layer** → defense moved
  to the runtime: structural trust-label separation, pre-commit staging buffers for
  tool results, output exfiltration scanning.
- **Audit/provenance:** IETF **Agent Audit Trail** draft (hash-chained records:
  `agent_id`, `session_id`, `action_type`, `trust_level`, `prev_hash`); ECDSA-signed
  execution receipts queryable without re-running; **C2PA v2.3**.

### 1.4 Interop — a two-layer stack (MCP vertical, A2A horizontal)
- **MCP** (LLM↔tools) donated to the **Agentic AI Foundation** (Linux Foundation,
  Dec 2025); ~9,650 servers; **Streamable HTTP is now the preferred transport**
  (standalone HTTP+SSE is **legacy**); OAuth 2.1 + PKCE + RFC 8707 for remote servers;
  tool-poisoning CVEs push toward signed manifests + gateway-level sanitization.
- **A2A** (agent↔agent) → Linux Foundation Jun 2025, 150+ orgs; **v1.0 stable Apr
  2026 with signed Agent Cards + cryptographic domain verification** ("DKIM for agents").
- **AGNTCY** ("Internet of Agents"); **AG-UI** (agent↔user generative-UI protocol)
  + Google **A2UI**.

### 1.5 Observability — OTel GenAI semconv is the convergence point
- Every vendor aligns to **OTel GenAI semantic conventions** (`invoke_agent`,
  `execute_tool`, `invoke_workflow`, MCP `tools/call`; `gen_ai.usage.*_tokens`,
  `gen_ai.response.finish_reasons`, `gen_ai.evaluation.result`).
- Differentiator moved from "do you have traces" to **agent-specific signals**:
  tool-call traces, **retry/loop detection** (looping agents still return 200s),
  per-step token+cost, cache hit/miss, reasoning tokens, **inline eval scores**.

### 1.6 Memory — from "a vector store you call" to a real layer
- Shape: **hybrid (vector+graph+keyword), multi-scope (user+agent+session+org),
  self-editing, async-consolidated, MCP-exposed, with temporal validity windows.**
- **Field:** Mem0 (AWS SDK's memory provider; OpenMemory MCP), Zep/Graphiti
  (temporal knowledge graph; SOC2+HIPAA+GDPR), Letta/MemGPT (self-paging +
  sleep-time consolidation), Cognee, LangMem.
- **Unsolved (= opportunity):** cross-agent shared memory with ordering guarantees
  (last-write-wins everywhere); + memory mutation audit log for regulated use.

### 1.7 Next-gen UX — flight recorders, time-travel, generative UI, agent inboxes
- Observability UX going **conversation-centric, not span-centric**: swimlanes per
  agent grouped by conversation, checkpoint-level replay ("flight recorder",
  Honeycomb Agent Timeline). Live takeover (operator injects into a running session
  via WebRTC, hands back with state preserved). AG-UI/A2UI generative UI.

### 1.8 Analyst framing
- **Gartner:** first standalone Hype Cycle for Agentic AI (2026); **>40% of agentic
  projects canceled by 2027** (cost/value/risk); 2026 newly profiles *agentic AI
  governance, agentic AI security, FinOps for agents* — the "build → control & audit"
  pivot; flags "agent washing."
- **Forrester:** the **"trust tax"** — every autonomous action needs audit-defensible
  logging; predicts agentic AI triggers major breaches in 2026 via privilege
  escalation/impersonation/injection.
- **AgentOps** is now a named discipline (parallel to MLOps); **"agentic mesh"**
  (McKinsey) = registry-and-discovery pattern with discovery / asset registry /
  observability / authN-authZ / evals / compliance.

---

## 2. Competitive landscape — the named incumbents

### 2.1 At a glance

| Capability | **AWS AgentCore** | **Google Agent Engine** | **Anthropic** | **OpenAI** | **Temporal** | **Lantern (today)** |
|---|---|---|---|---|---|---|
| What it *is* | Managed agent runtime (7+ composable services) | Managed serverless agent runtime | Framework (Agent SDK) + **Managed Agents (beta)** | LLM+tools+SDK; durability lib (Apr 2026) | Durable-execution engine | **Full-stack runtime + control/data plane** |
| Per-session isolation | ✅ microVM, sanitized teardown | ✅ serverless + code-exec sandbox (no-net, 300s) | Hosted code sandbox (5GiB/1CPU/no-net); managed via Bedrock | BYO sandbox (E2B/Modal/…) | N/A (you host workers) | ✅ 6 classes; dispatch + mTLS heartbeat real; **no RuntimeClass tiering / cluster e2e yet** |
| Max session | 8h | quota-limited | long/resumable (beta) | provider-dependent | days–years (durable timers) | design supports long; replay partial |
| Durable execution | Memory persists; runtime ephemeral | Sessions GA; runtime ephemeral | server-side event log (beta) | snapshot/rehydrate (BYO compute) | ✅ **best-in-class** replay | journal_events ✅; **replay partial** |
| Per-agent identity | IAM + workload identity | ✅ **SPIFFE + X.509-bound tokens** | Workload Identity Federation | OpenAI-cloud centric | namespaces (Cloud RBAC) | tenant_id everywhere; **no per-instance agent identity** |
| Egress control | VPC | VPC-SC + PSC + Agent Gateway | product permissioning | — | your workers | ✅ **harness allowlist + nftables (designed)** |
| Signed receipts/audit | CloudWatch GenAI audit | Access Transparency | RSP/ASL | dev tracing | Cloud audit = control-plane only | ✅ **HMAC receipts + journal hash** |
| Interop | MCP + A2A | **owns A2A**; MCP | **owns MCP**; A2A | MCP (adopted) | — | MCP + A2A cards ✅ |
| Memory layer | AgentCore Memory (Mem0) | **Memory Bank (GA)** + Example Store | hosted sandbox state | Responses store (30d) | — | ✅ **cross-channel person graph + episodic + topic** |
| Observability | OTel→CloudWatch GenAI | Cloud Trace | dev tracing | tracing on by default | Web UI / visibility | OTel partial; run waterfall ✅ |
| Execution locality | AWS cloud | GCP cloud | Anthropic cloud | OpenAI cloud / BYO | your VPC (workers) | ✅ **customer VPC (data plane)** |
| Compliance | HIPAA, SOC2, ISO, PCI | **FedRAMP, SOC, ISO, PCI, HIPAA** | RSP/ASL | SOC2 T2, ZDR | SOC2 T2 + HIPAA (Cloud) | early |

### 2.2 The structural read
- **Only Google ships a complete, GA, governed managed runtime today.** Its
  moat is governance: per-agent **SPIFFE identity + X.509-bound tokens**, VPC-SC,
  CMEK, FedRAMP. **This is the bar Lantern must clear on governance.**
- **AWS leads on isolation-as-a-guarantee** (per-session microVM, 8h) and breadth
  (Gateway/Identity/Memory/Browser/Code-Interpreter/Policy/Eval) — but at the cost of
  **12 independently-billable SKUs** (cost opacity) and a documented Code-Interpreter
  IAM-role escalation + gateway-only policy boundary.
- **Anthropic & OpenAI are framework-first.** Anthropic's Agent SDK *"runs the agent
  loop inside your own process"*; its Managed Agents runtime is **beta and not
  ZDR/HIPAA-eligible**. OpenAI's Apr-2026 durability is **library-level + BYO-compute**
  — no OpenAI-operated multi-tenant durable runtime.
- **Temporal is the reliability floor, not an agent platform** — no LLM routing, no
  tools, no memory/marketplace/governance of agents; self-hosted has **zero RBAC/audit**
  and Cloud audit logs miss data-plane events.
- **The seam none of them own:** a **vendor-operated, multi-tenant, durable agent
  runtime that executes inside the customer's VPC with a tenant-scoped, tamper-evident,
  data-plane audit substrate.** That seam is exactly Lantern's control-plane/data-plane
  + journal + receipts architecture. **Defend it.**

---

## 3. Lantern runtime — current state (honest, stub-aware)

Grades: ✅ production-grade · ⚠️ partial · ❌ stub/mock. File refs are anchors,
not exhaustive.

### 3.1 Component maturity
| Component | Grade | Reality |
|---|---|---|
| **Scheduler placement** (`runtime-scheduler/internal/scoring`) | ✅ | 5-factor score (warm-pool/region/fair-share/cost/health), per-tenant hard cap, Postgres write-through. |
| **Scheduler → Manager dispatch** (`internal/dialer/manager.go`) | ✅ | Real connection-pooled `GRPCDialer`, selected on `LANTERN_DEFAULT_MANAGER_ADDR`. `LogOnlyDialer` is a dev fallback only. |
| **Manager: Firecracker** (`backends/firecracker.rs`) | ⚠️ | Cold-boot KVM validated; warm snapshots via mmap; TAP+seccomp. Jailer snapshot-restore untested. |
| **Manager: K8s Job** (`backends/k8s.rs`) | ✅~ | Full kube client, Job+Pod, resource limits, seccomp, NetworkPolicy. **No RuntimeClass tiering yet** (needed for ADR 0009). |
| **Manager: Kata / Wasmtime / Docker** | ⚠️ | Kata lifecycle exists, no IT; Wasmtime WASIp1 + epoch timeouts solid; Docker dev-only. |
| **Control-plane → Scheduler** (`handlers/runtime.go`) | ✅ | Real `grpcSchedulerClient`, selected on `LANTERN_SCHEDULER_GRPC_ADDR`. `stubSchedulerClient` is the unset fallback. |
| **Harness: boot + egress** (`harness/src/egress.rs`) | ✅ | HTTP CONNECT proxy + nftables + token-bucket + audit-on-deny + deny private/link-local (169.254/RFC1918). |
| **Harness ↔ Manager mTLS** (`manager_client.rs`, `tls.rs`) | ✅ | TLS channel from injected per-VM cert/key/CA; https when present, http dev fallback. |
| **Harness `VendSecret`** (`manager_client.rs`) | ✅ | Calls the real `RuntimeHarness.VendSecret` RPC; stub is opt-in (`LANTERN_ALLOW_SECRET_STUB=1`). |
| **Harness heartbeat stream** (`manager_client.rs`) | ✅ | **Closed in this branch** — real bidi `Heartbeat` tonic stream over mTLS; proto round-trip + unit tests. Egress revocations on `HeartbeatAck` now propagate. |
| **Harness `Report` / manager ingestion** (`report.rs`, `service.rs`) | ❌ | Manager `report` handler is `unimplemented`; harness `forward_one` returns Err honestly. OTLP/log forwarding has nowhere to land yet. |
| **Control-plane secret relay** (`handlers/runtime_secrets.go`) | ✅ | Token auth (constant-time), fail-closed, VM-binding check, rate-limited, audited. ADR 0008. |
| **Workflow interpreter** (`internal/workflow/interpreter.go`) | ⚠️ | trigger/ai-step/tool/connector/condition execute; **approval is real** — `rest.go` wires `WaitForApproval` to a `takeover_requests` row that blocks until granted/released/denied/expired (auto-approve only on the nil/test path). **loop + subagent are still no-ops**. |
| **journal_events / receipts / run_locks** | ✅ | Event-sourced log, HMAC-signed receipts bound to journal hash, distributed locking. **Crash-replay not wired into the run path.** |
| **OTel traces** | ⚠️ | `trace_id` propagates; **tenant_id/run_id/step_id missing on many spans**; collectors partial. |

### 3.2 What actually remains for Phase 0
The data path is real and config-gated. The remaining Phase-0 work is **validation +
defaulting + telemetry sink**, not greenfield:
1. **Manager Report ingestion** — wire the `report` handler (`service.rs`) so harness
   OTLP/logs/audit have a sink; then connect `report.rs::forward_one`.
2. **Make the real path the default** — today it needs env vars; the K8s-default
   install (Phase 1) sets them as standard.
3. **End-to-end cluster integration test** — `schedule → place → K8s spawn → mTLS
   heartbeat → vend secret → egress-deny → terminate`, zero mocks, on kind/k3s in CI.

---

## 4. Gap analysis — by dimension (zero-compromise lens)

Severity: **P0** = blocks a working/credible enterprise runtime · **P1** = on-par gap
vs incumbents · **P2** = "2-years-ahead" frontier.

### Governance
- **P0** — Per-instance agent identity. Lantern stops at `tenant_id`. Google issues
  **per-agent SPIFFE + X.509-bound tokens**; AWS has workload identity. *Need:*
  per-agent-instance OIDC/SPIFFE identity minted at spawn, short-lived, the subject of
  every audit row and secret vend.
- **P0** — RBAC scope enforcement not wired on all `/v1/runtime/*` mutating routes.
- **P1** — JIT, task-scoped tool permissions that expire on workflow completion
  (capability manifests enforced at runtime).
- **P1** — Human-in-the-loop approval is auto-approve in the interpreter; needs the
  durable `takeover_requests` gate keyed on action type/confidence/sensitivity.
- **P2** — Receipts are HMAC (shared-secret). Frontier = **ECDSA/asymmetric, IETF-AAT
  schema-aligned, C2PA-ready**, externally verifiable without sharing the key —
  ahead of the EU AI Act Aug-2-2026 gate.

### Security
- **P0** — Harness ↔ manager mTLS + real `VendSecret` (see §3.2).
- **P0** — Host-level egress firewall (CNI NetworkPolicy / Outbound-Worker-style
  credential injection) to complement the guest-side allowlist.
- **P1** — Untrusted/hostile isolation under the K8s-default substrate must be a
  **hardened RuntimeClass (gVisor/Kata)**, never a bare pod (ADR 0009).
- **P1** — Pre-commit staging buffer for tool results (prompt-injection containment);
  output exfiltration scanning.
- **P2** — Confidential compute (SEV-SNP/TDX) attestation for regulated verticals;
  signed Wasm MCP tools from an OCI registry.

### Scalability
- **P0** — End-to-end dispatch (remove both stubs) so warm pools and quotas actually
  govern real boots.
- **P1** — Per-spawn rate limiting (today fair-share is placement-only; nothing stops a
  spawn storm per tenant).
- **P1** — Snapshot-restore cold-start budget published & measured (target sub-second;
  frontier sub-5ms p99).
- **P2** — Scale-to-zero with "idle is free" billing granularity; warm pool 100s/sec.

### Resiliency
- **P0** — Journal-based crash replay actually wired into the run executor (today the
  journal exists but replay isn't used on restart).
- **P1** — Durable execution parity with Temporal's "automatic detect + recover +
  dedup + replay" (close the checkpoint≠durable gap); loop + subagent nodes durable.
- **P2** — Adaptive durability (auto-classify steps by cost/reversibility); semantic
  saga/compensation for irreversible side effects; zero-downtime migration of
  in-flight workflows.

### Availability
- **P1** — Scheduler HA (etcd leader election) deployed, not just designed.
- **P1** — Node self-heal/auto-remediation (today drain is manual on stuck nodes).
- **P1** — Published SLOs (single-region 99.9% / multi-region 99.99% to match Temporal).

### Observability
- **P0** — OTel GenAI semconv on every span with `tenant_id`/`run_id`/`step_id`;
  per-runtime metrics on control-plane + scheduler.
- **P1** — Agent-specific signals: **loop/retry detection**, per-step token+cost
  (incl. reasoning + cache tokens), inline `gen_ai.evaluation.result`.
- **P2** — Conversation-centric flight recorder + checkpoint-level time-travel replay.

### Memory
- **P1** — Temporal validity windows (Zep-style) on facts; memory-mutation audit log.
- **P2** — Cross-agent shared memory with CRDT conflict resolution (not last-write-wins);
  MCP-native memory endpoint with self-editing + async consolidation (sleep-time).

### UX (futuristic)
- **P1** — AG-UI/A2UI-native generative UI (replies are still text/markdown).
- **P2** — Live WebRTC takeover into a running session with state preserved
  (contract exists via `takeover_requests`; media last-mile is the gap).

---

## 5. Target architecture — the "Agent Execution Kernel"

The thesis: **one event fabric, six concerns.** A single spawn produces one
correlated chain — `schedule → place → boot → identity → run steps → vend secrets →
egress → emit spans → mutate memory → sign receipt` — where every link shares the
same `(tenant_id, run_id, step_id, agent_instance_id, trace_id)` and is replayable
and externally verifiable.

```
                         ┌──────────────────────────────────────────────┐
   Control plane (SaaS)  │  authn/z · per-instance identity issuer ·     │
                         │  quota+budget gate · secret relay · audit ·   │
                         │  receipt signer · OTel collector · marketplace│
                         └───────────────┬──────────────────────────────┘
                                         │ gRPC (tenant_id metadata)
                         ┌───────────────▼──────────────┐
   Data plane            │  runtime-scheduler           │  placement (warm-pool/
   (customer K8s/VPC)    │  (HA, etcd leader)           │  region/fair-share/cost/health)
                         └───────────────┬──────────────┘
                                         │ real ClientConn pool (NO stub)
                         ┌───────────────▼──────────────┐
                         │  runtime-manager (per node)  │  K8s-default substrate
                         │  RuntimeClass tiering:        │
                         │  runc → gVisor → Kata/FC      │  ← ADR 0009
                         └───────────────┬──────────────┘
                                         │ vsock mTLS
                         ┌───────────────▼──────────────┐
                         │  in-VM harness (PID 1)        │  identity attest · egress
                         │  egress allowlist · VendSecret│  deny-default · OTLP report
                         └──────────────────────────────┘
   Durable spine:  journal_events (event source) ── replay ── run_receipts (ECDSA)
   Memory spine:   person graph + episodic + topic ── temporal validity ── mutation audit
```

**Five non-negotiables (zero-compromise):**
1. **Governance:** per-instance identity is the subject of every audit row, secret
   vend, and tool call; RBAC enforced on every mutating route; receipts externally
   verifiable; EU-AI-Act event logging by default.
2. **Security:** untrusted/hostile never on a bare pod; mTLS everywhere on the data
   plane; deny-default egress at host + guest; secrets short-TTL, tenant-bound, never
   logged.
3. **Scalability:** real dispatch + warm pools + per-spawn rate limits + sub-second
   cold start.
4. **Resiliency/Availability:** durable-by-default with automatic detect/recover/
   dedup/replay; scheduler HA; published SLOs.
5. **Observability:** OTel GenAI on every span; loop/cost/eval signals first-class;
   flight-recorder UX.

---

## 6. Kubernetes as the default substrate (ADR 0009 summary)

**Decision:** Kubernetes becomes the **default runtime substrate**; isolation is a
**RuntimeClass tier on a pod**, not a separate backend. This unifies the backends,
matches the data-plane-on-customer-K8s deployment model, and is the architecture
GKE Agent Sandbox / Northflank converged on.

| IsolationClass | Substrate | RuntimeClass | Co-tenancy |
|---|---|---|---|
| `TRUSTED` | K8s pod | `runc` | shared nodes (signed first-party only) |
| `STANDARD` *(default)* | K8s pod | **`gvisor`** | shared, gVisor-isolated |
| `UNTRUSTED` | K8s pod | **`gvisor`** + egress allowlist + seccomp deny-default | shared, hardened |
| `HOSTILE` | K8s pod | **`kata-qemu`** (microVM via K8s) / `kata-fc` | dedicated node pool, no co-tenancy |
| `WASM` | K8s pod | `crun`+Wasm (or in-process on trusted hosts) | shared |
| `DEVCONTAINER` | long-lived K8s pod + PVC | `gvisor` | per-workspace |

**Invariant preserved:** `UNTRUSTED`/`HOSTILE` still get hardware/gVisor isolation —
expressed as a hardened RuntimeClass instead of a bare pod. The `choose_backend`
refusal-to-downgrade logic (`services/runtime-manager/src/service.rs`) is **extended**,
not weakened: a K8s node may satisfy untrusted/hostile **only when it advertises the
required hardened RuntimeClass**; otherwise it still fails closed. Firecracker remains
available as `kata-fc`/a dedicated node pool — no longer the default, never removed.
See [ADR 0009](../adr/0009-kubernetes-default-runtime-substrate.md) for the full
decision, migration, and the security argument.

---

## 7. Phased implementation roadmap (prod-grade, gated)

Each phase ships behind **explicit test + validation gates**. A phase is **not done**
until its gate is green *and observed* (per repo rule: never report a check clean
without running it). Estimates assume the current team; sequence matters more than dates.

### Phase 0 — Prove it boots end-to-end + make the real path default
**Status:** dispatch (`GRPCDialer`/`grpcSchedulerClient`), harness mTLS, `VendSecret`,
and the **heartbeat stream** are real (the last closed in this branch). Remaining:
**Scope:**
- ✅ *(done)* Real `GRPCDialer` + `grpcSchedulerClient` (config-gated); harness mTLS +
  `VendSecret`; **bidi `Heartbeat` stream over mTLS** (this branch, with unit tests).
- Wire the manager-side **Report ingestion** handler (`service.rs`) and connect
  `harness/src/report.rs::forward_one` so OTLP/logs/audit have a sink.
- Make the real path the **default** in the data-plane install (set
  `LANTERN_SCHEDULER_GRPC_ADDR` / `LANTERN_DEFAULT_MANAGER_ADDR`), lands with Phase 1.
**Gate:** end-to-end integration test — `control-plane Schedule → scheduler placement
→ manager Spawn (K8s) → harness boots, authenticates over mTLS, vends one real secret,
egress-denies a blocked domain, streams a heartbeat the manager records → Terminate`.
Run on CI with a kind/k3s cluster. **No mocks in the happy path.** Owner re-runs the
gate on returned work. *(Cluster e2e is the open item; cargo/go unit + clippy gates are
green now.)*

### Phase 1 — Kubernetes-default substrate + isolation tiering (ADR 0009)
**Scope:**
- K8s backend sets `runtimeClassName` per IsolationClass (runc/gVisor/Kata).
- Extend `choose_backend` so a K8s node satisfies untrusted/hostile **only** when it
  advertises the hardened RuntimeClass; otherwise fail closed.
- Flip the default backend/config to `k8s`; provision gVisor + Kata RuntimeClasses in
  the data-plane install (Helm/Kustomize).
- Host-level egress: default-deny NetworkPolicy + credential-injecting egress proxy.
**Gate:** security-auditor sign-off + integration tests proving (a) untrusted lands on
gVisor, hostile on Kata; (b) a node without the RuntimeClass **refuses** untrusted
(fail-closed assertion); (c) default-deny egress blocks `169.254.169.254` + RFC1918;
(d) no co-tenancy for hostile. Validate on a real cluster with gVisor + Kata installed.

### Phase 2 — Governance to clear the Google bar
**Status:**
- ✅ *(done, this branch)* **RBAC scope enforcement** on the runtime routes
  (`runtime:read/write/admin`, least-privilege, 403 + audit on denial; 27 tests).
- ✅ *(done, this branch)* **Asymmetric receipts** — Ed25519 signing, public key
  published at `/.well-known/lantern-receipts`, offline external verification, tamper
  detection; HMAC back-compat retained (8 tests).
- ✅ *(already present, verified)* **Durable HITL approval** — `rest.go` wires
  `WaitForApproval` to a `takeover_requests` row that blocks until
  granted/released/denied/expired (30-min timeout). Follow-up: swap the 1s poll for
  Postgres LISTEN/NOTIFY.
**Remaining:**
- ✅ *(done, this branch)* **`tenant_id` provenance (P0 security, invariant #7):** the
  K8s backend derived the namespace from caller-supplied `env[LANTERN_TENANT_ID]` —
  an empty `spec.tenant_id` + caller env let a pod land in another tenant's namespace.
  Fixed: tenant is now a first-class authenticated field on the internal
  `ScheduleRequest`; `spawn_to_schedule`/`restore` fail closed on empty, strip + re-inject
  the authenticated value (caller can't shadow), and `namespace_for` derives solely
  from it (refuses empty). Tested.
- **Per-agent-instance identity:** SPIFFE SVID / OIDC short-lived token minted at
  spawn; stamp `agent_instance_id` on every audit row, secret vend, and tool call.
- **Non-owner Postgres role** with RLS validated end-to-end.
**Gate:** security-auditor review; tests for (a) cross-tenant identity isolation;
(b) ✅ a missing scope → 403 on every mutating route; (c) RLS denies a non-owner read;
(d) ✅ external receipt verification with the published public key; (e) ✅ approval node
blocks until granted; (f) a spec with a mismatched body tenant_id is rejected.

### Phase 3 — Durable-by-default resiliency (Temporal-parity)
**Scope:**
- Wire journal-based crash replay into the run executor (resume from last
  `step_completed`, dedup side-effects by idempotency key).
- Durable loop + subagent nodes in the interpreter.
- Automatic failure detection + recovery watchdog (close checkpoint≠durable gap).
- Scheduler HA (etcd leader election) deployed; per-spawn rate limiting.
**Gate:** chaos/integration tests — kill the executor mid-run and assert exactly-once
completion + no double side-effect + no re-spent tokens; kill the scheduler leader and
assert failover < N s; spawn-storm test asserts the rate limit holds. Publish measured
SLOs.

### Phase 4 — Observability + cost (FinOps for agents)
**Scope:**
- OTel GenAI semconv on every span; `tenant_id`/`run_id`/`step_id`/`agent_instance_id`
  on all; control-plane + scheduler runtime metrics.
- Loop/retry anomaly detection as a first-class incident class; per-step token+cost
  (reasoning + cache tokens) in the journal; inline `gen_ai.evaluation.result`.
**Gate:** trace-completeness test (every step emits a conformant span with required
attrs); a synthetic looping agent fires the loop-detection signal; cost attribution
reconciles to the model-router meter within tolerance.

### Phase 5 — Frontier UX + interop (2-years-ahead)
**Scope:**
- Conversation-centric flight recorder + checkpoint time-travel replay in the dashboard;
  live WebRTC takeover media last-mile.
- AG-UI/A2UI generative UI; signed A2A agent card + MCP host/client with description
  sanitization; Streamable HTTP transport (retire legacy HTTP+SSE).
- Wasm MCP tool layer (signed components from an OCI registry).
**Gate:** manual UX validation in a browser (per repo rule — load the page, drive a
real session, observe takeover hand-back with state preserved); A2A card signature
verifies; an MCP tool-poisoning attempt is sanitized at the gateway.

### Phase 6 — Memory + confidential compute (regulated verticals)
**Scope:**
- Temporal validity windows on facts; memory-mutation audit log; MCP-native memory
  endpoint with async (sleep-time) consolidation; cross-agent CRDT shared memory.
- SEV-SNP/TDX confidential-compute node pool with attestation for HIPAA/Fed verticals.
**Gate:** memory-mutation audit completeness test; attestation verification test;
compliance mapping reviewed.

---

## 8. Risks, non-goals, success metrics

**Risks**
- **Scope sprawl** — the field has ~10 frontier moves; chasing all at once starves
  Phase 0. *Mitigation:* Phase 0/1 are non-negotiable and ship first; everything else
  is sequenced and independently shippable.
- **Security regression during the K8s flip** — *Mitigation:* `choose_backend` stays
  fail-closed; Phase 1 gate is a security-auditor sign-off, not a typecheck.
- **Durable-execution build-vs-buy** — Temporal is the reliability floor others build
  *on*. *Open question for ADR:* adopt Temporal as the durable substrate vs. harden
  the in-house workflow engine. Invariant: the workflow engine remains the only thing
  that mutates run state.

**Non-goals (now)**
- Becoming a model vendor (we route, per invariant #6).
- A new database (Postgres+Redis+S3+pgvector cover it, per repo rule).
- GPU-in-session at Phase 0–3.

**Success metrics (the bar)**
- End-to-end boot succeeds with zero stubs in the happy path (Phase 0).
- Untrusted/hostile provably never on a bare pod (Phase 1).
- Match Google on governance primitives: per-instance identity + RBAC + external
  receipt verification (Phase 2).
- Match Temporal on durability: exactly-once completion under chaos (Phase 3).
- p99 cold start sub-second; published SLOs 99.9%/99.99% (Phase 3–4).
- OTel GenAI conformance + loop/cost/eval signals (Phase 4).
- The differentiator stated once, defended throughout: **the only vendor-operated,
  durable, multi-tenant agent runtime that executes in the customer's VPC with a
  tamper-evident, externally-verifiable, data-plane audit substrate.**

---

## 9. Sources

Vendor primary docs and standards bodies captured June 2026: AWS Bedrock AgentCore
(docs/FAQs/pricing/limits), Google Vertex Agent Engine + ADK + A2A (cloud.google.com,
linuxfoundation.org), Anthropic Agent SDK + Managed Agents + MCP (platform.claude.com,
modelcontextprotocol.io), OpenAI Agents SDK + AgentKit (developers.openai.com),
Temporal (docs.temporal.io, temporal.io/blog), OWASP Agentic Top 10 2026
(genai.owasp.org), OTel GenAI semconv (opentelemetry.io), EU AI Act timeline
(artificialintelligenceact.eu), Gartner/Forrester agentic-AI framing, Mem0/Zep/Letta
memory, GKE Agent Sandbox / E2B / Modal / Cloudflare / Fly.io / Vercel sandbox docs.
Several 2026 datelines and funding/market figures are directional — verify before
external quotation.
