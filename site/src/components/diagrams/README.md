# Diagrams

Interactive, theme-aware (`--lx-*` tokens in `styles/tokens.css`) React islands.
Import from the barrel and hydrate with a client directive:

```mdx
import { HoldsGates } from '../../../../components/diagrams';

<HoldsGates client:visible />
```

| Component | Capability | Kind |
| --- | --- | --- |
| `SystemContext` | Runtime: high-level system context | flow, step-through |
| `ContainerView` | Runtime: every service by tier | flow, hover |
| `ArchitectureExplorer` | Runtime: system / manager / harness explorer, trust + broker overlays (ported) | explorer |
| `RunSequence` | Run lifecycle: inline, budget 402, crash re-drive, data plane (ported) | sequence |
| `MicroVmRunSequence` | Run lifecycle on the microVM tier, quota 402 | sequence |
| `ToolCallSequence` | Tool call into a microVM (ported) | sequence |
| `VmLifecycle` | microVM state machine: spawn, running, idle-suspend, paused, fork, restore, terminate (ported) | state machine |
| `SandboxLifecycleSequence` | Schedule, idle-suspend, pause/resume, fork (ported) | sequence |
| `EgressSequence` | Egress broker, credential injection, deny cases, DLP block (ported + DLP) | sequence |
| `BrokerDemo` | Recorded broker e2e run, animated (ported from landing) | console |
| `TrustBoundaries` | Security trust boundaries, hop by hop | flow, step-through |
| `TenancyRls` | Multi-tenancy and RLS; cross-tenant and spoofed-tenant | flow, scenarios |
| `CheckpointSequence` | Durable checkpoint and crash-resume | sequence |
| `ModelRouting` | Model routing, router fallback, provider failover, 402 | flow, scenarios |
| `BudgetEvalGate` | Budgets / forecast 402 and eval gate 422 | flow, scenarios |
| `DeployTopology` | Local design time vs cloud topology | flow, scenarios |
| `AgentNetwork` | MCP attach, A2A discovery, marketplace invoke | flow, scenarios |
| `BriefAttention` | pal: Brief / attention ranking | flow, scenarios |
| `HoldsGates` | pal: Holds (commitment + grounding gates) | flow, scenarios |
| `VoicePipeline` | pal: draft → bot-tell guard → refine → gates → send | flow, scenarios |
| `CrossChannelMemory` | pal: person graph, timeline, episodes | flow, scenarios |
| `WorldModel` | pal: world model refresh | flow, scenarios |
| `ProactiveNudges` | pal: proactive nudges | flow, scenarios |
| `SkillForge` | pal: skill forge | flow, scenarios |
| `Recap` | pal: "what did I miss" recap | flow, scenarios |
| `WebhookTriggers` | Signed webhook: HMAC verify, dedupe, run; bad signature, duplicate, budget 402 | flow, scenarios |
| `CronSchedules` | Cron: timezone resolution (schedule, env default, UTC), next fire, claim and fire | flow, scenarios |
| `ConnectorActions` | Connector execute: encrypted install, vendor call, not installed 404, recorded test mode | flow, scenarios |
| `TracePropagation` | HTTP and gRPC spans, EnrichSpan attributes, traceparent into the microVM | flow, scenarios |
| `SignedReceipts` | Journal hash, Ed25519 signature, public verify, tampered journal | flow, scenarios |
| `TokenStreaming` | Provider to client token stream, tool-turn single message, mid-stream error | flow, scenarios |
| `SessionsMemory` | Session turn, memory distillation, crash mid-turn | flow, scenarios |
| `KnowledgeHandoff` | Document upload, cited answers, handoff to a human | flow, scenarios |
| `IdentitySecrets` | Secret ref, SO_PEERCRED vending, denied peer, relay fail-closed | flow, scenarios |
| `IsolationClasses` | Isolation class placement and fail-closed refusal | flow, scenarios |
| `InvocationModes` | Sync, stream, async, cron and webhook starts of one run | flow, scenarios |
| `OnboardingFlow` | Agentic onboarding: spec, approve, provider test, create, first run | flow, scenarios |

`FlowDiagram` (the kit) takes a `FlowDef` (nodes, edges, frames, scenarios of
steps); see `flows-runtime.ts` / `flows-pal.ts`. It gives every diagram the same
behaviour: autoplay once in view, play/step/scrub, arrow keys, Tab to each box,
hover tooltip, click for details, animated flow on lit edges (static under
`prefers-reduced-motion`), and pan or "Fit to screen" on phones.

All live on the Architecture docs pages (`src/content/docs/docs/architecture/`).
Facts come from `RUNTIME-GAP-ANALYSIS.md` §3 and CLAUDE.md; numbers only from the verified fact sheet.
