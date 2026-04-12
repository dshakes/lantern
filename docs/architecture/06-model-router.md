# The Spectrum — Lantern's Smart AI Gateway

> **What this is:** the multi-LLM router and intelligence layer that decides — for every model call — *which model* to use based on the cost / latency / accuracy budget the agent declared. We call it **the Spectrum** because it routes across the full spectrum of models from tiny edge models to frontier closed-source giants.
>
> **Why it matters:** the difference between an agent that costs $0.001 per run and one that costs $1.00 per run is which model handled which step. Choosing well is the single biggest lever on production agent economics. No one is automating this well today. Lantern automates it as a first-class feature.

---

## The thesis

Every step in an agent has a different shape:
- A **routing classifier** ("is this email a support request or a sales lead?") needs ~50 tokens of output, fast, and is dirt-simple — a 1B parameter model on an edge GPU is overkill. Pay $0.0001.
- A **plan synthesis** ("write a 6-step research plan for this question") needs ~500 tokens, careful structure, decent reasoning — a Llama 3 8B locally or a Claude Sonnet does great. Pay $0.005.
- A **final synthesis** of a hard research question needs the best frontier reasoning model in the world. Pay $0.50.

Today, agent developers either:
1. **Pick the biggest model and use it for everything.** Wastes 50× on simple steps. (Most LangGraph and CrewAI deployments.)
2. **Manually pick a model per step.** Brittle, doesn't adapt as new models come out, requires expertise. (Sophisticated teams.)
3. **Use OpenRouter.** Solves *vendor* selection but not *capability vs. cost vs. latency* selection. The agent still has to know what it wants.

**The Spectrum solves all three.** The agent declares a *capability* and an *optimization target* (`cheap`, `fast`, `best`, or a Pareto budget). The Spectrum picks the model. When cheaper models work, it uses them. When they fail, it escalates. It learns from outcomes.

---

## Capabilities, not models

The agent's code never references a vendor or a model name. It references a **capability**:

| Capability | What it means | Models behind it (rotates as the field moves) |
|---|---|---|
| `reasoning-frontier` | Best-in-class reasoning, no expense spared | GPT-5 reasoning, Claude Opus 4.6, Gemini Ultra reasoning |
| `reasoning-large` | Strong reasoning, moderate cost | Claude Sonnet 4.5, Gemini Pro, GPT-5-mini reasoning |
| `reasoning-small` | Cheap reasoning that still chains thoughts | Llama 3.3 70B, Claude Haiku, Gemini Flash |
| `chat-large` | High-quality conversational | Claude Sonnet, GPT-5, Gemini Pro |
| `chat-small` | Cheap chat | Mistral 7B, Llama 3 8B, Gemma 9B, Claude Haiku |
| `chat-edge` | Sub-millisecond classification on local hardware | DistilBERT, ALBERT-base, TinyLlama 1.1B, Phi-3-mini |
| `vision-large` | Best multimodal | Claude Sonnet vision, GPT-5 vision, Gemini Pro vision |
| `vision-small` | Cheap multimodal | Llama 3.2 11B vision, Pixtral, Gemini Flash vision |
| `code-large` | Best code generation | Claude Sonnet, GPT-5, DeepSeek Coder V3 |
| `code-small` | Cheap code | DeepSeek Coder 6.7B, Codestral, StarCoder2 |
| `embed-large` | Best embeddings | text-embedding-3-large, voyage-3, mxbai-embed-large |
| `embed-small` | Cheap embeddings | text-embedding-3-small, bge-small, all-MiniLM-L6-v2 |
| `rerank` | Cross-encoder rerankers | Cohere rerank-3, bge-reranker-v2 |
| `transcribe` | Speech-to-text | Whisper-large-v3, Distil-Whisper, AssemblyAI |
| `tts` | Text-to-speech | ElevenLabs Flash, Cartesia, OpenAI TTS |
| `auto` | Spectrum picks based on classified prompt | (any of the above) |

The mapping from capability to concrete model is in the Spectrum's **routing table**, updated continuously as new models are released, benchmarked on the eval suite, and rotated into the appropriate tier.

---

## The optimization target

For every model call, the agent declares (or inherits from agent.yaml) an **optimization target**:

```ts
ctx.llm.complete({
  capability: "reasoning-large",
  prompt,
  optimize: "balanced",       // cheap | fast | best | balanced | { cost_weight, latency_weight, accuracy_weight }
});
```

| Target | Behavior |
|---|---|
| `cheap` | Pick the lowest-cost model that has historically succeeded on this prompt class for this tenant. Escalate only on failure or low confidence. |
| `fast` | Pick the model with the lowest p50 TTFT, regardless of cost (within tenant budget). Prefer edge models on low-latency hardware. |
| `best` | Pick the highest-accuracy model on this prompt class. Cost no object. |
| `balanced` (default) | Pareto-optimal — minimize a weighted combination of cost, latency, and inverse accuracy. Default weights: cost 0.4, latency 0.2, accuracy 0.4. |
| `{ ... }` | Custom weights. |

Per-tenant policy can override or constrain agents (e.g., "cheap is the default for free-tier users; team tier can use balanced").

---

## How a routing decision is made

```
                 agent calls ctx.llm.complete({capability, prompt, optimize})
                                       │
                                       ▼
                       ┌──────────────────────────────┐
                       │  1. Cache lookup             │
                       │     prompt SHA256 → result?  │
                       │     embedding kNN → result?  │
                       └─────┬────────────────────────┘
                             │ miss
                             ▼
                       ┌──────────────────────────────┐
                       │  2. Prompt classifier        │
                       │     tiny ALBERT ~50ms        │
                       │     → prompt class label     │
                       └─────┬────────────────────────┘
                             │
                             ▼
                       ┌──────────────────────────────┐
                       │  3. Candidate generation     │
                       │     filter routing table by  │
                       │     capability + tenant +    │
                       │     budget + availability    │
                       │     → list of candidates     │
                       └─────┬────────────────────────┘
                             │
                             ▼
                       ┌──────────────────────────────┐
                       │  4. Score candidates         │
                       │     for each c in candidates:│
                       │       cost   = price * tokens│
                       │       latency = p50_ttft[c]  │
                       │       acc = success_rate[c, class, tenant]
                       │       score = optimize.weighted(cost, latency, acc)
                       │     pick argmin score        │
                       └─────┬────────────────────────┘
                             │
                             ▼
                       ┌──────────────────────────────┐
                       │  5. Call the chosen provider │
                       │     stream tokens back       │
                       │     measure outcome          │
                       └─────┬────────────────────────┘
                             │
                             ▼
                       ┌──────────────────────────────┐
                       │  6. Confidence check         │
                       │     if logprobs/self-eval    │
                       │     signal low confidence,   │
                       │     escalate to next tier    │
                       │     and discard cheap result │
                       └─────┬────────────────────────┘
                             │
                             ▼
                       ┌──────────────────────────────┐
                       │  7. Record outcome           │
                       │     update success_rate[c, class, tenant]
                       │     update latency_sketch[c]
                       │     emit usage event         │
                       └──────────────────────────────┘
```

### The prompt classifier

A small transformer (ALBERT-base or DistilBERT, ~50ms inference on CPU) trained on a labeled corpus of prompt classes:

- `simple-classification` — short input, structured output, no reasoning
- `extraction` — pull structured data from a doc
- `summarization` — short to short
- `long-summarization` — long doc to short summary
- `question-answering-easy` — factual lookup
- `question-answering-hard` — multi-hop reasoning
- `code-generation-easy` — short snippets
- `code-generation-hard` — full features
- `creative-writing`
- `multi-turn-conversation`
- `tool-use`
- `agent-planning`
- ... (~30 classes total)

This is the same pattern Vercel uses internally for AI Gateway routing hints. The classifier runs in-process in the Spectrum (Rust + ONNX Runtime) — ~50ms total overhead per request.

The classifier itself is one of the routes (`chat-edge`), so when an agent calls `chat-edge` with a real classification job, it uses the same model.

### Success rate tracking

For each `(model, prompt_class, tenant)` tuple, the Spectrum tracks a Beta-Bernoulli posterior over "did this call succeed":

- "Success" is defined per-call:
  - **Schema match** for `ctx.llm.json` (response parses against the requested JSON schema)
  - **No retry** required by the calling code
  - **No explicit `ctx.llm.report({success: false})`** from the agent
  - **Self-evaluation pass** when enabled (the next-larger model evaluates the smaller model's output)

- Posterior is updated on every call. Old observations decay exponentially (half-life = 2 weeks) to adapt to model changes and prompt drift.

- A new (model, class, tenant) starts with an informative prior derived from the global eval suite scores so we don't have to learn from scratch.

This is how the Spectrum **learns which cheap models work for which jobs in your specific workload** without you having to know.

### Confidence-based escalation

After a model returns, the Spectrum checks confidence:

- **Logprobs path** — for models that expose logprobs (OpenAI, some Claude endpoints, all open models served via vLLM), compute per-token entropy. If average entropy on the response is above threshold, mark low confidence.
- **Self-eval path** — for models without logprobs, optionally call a small grader model to score the response. Costs ~5% of the original call.
- **Schema-validation path** — if `ctx.llm.json`'s output fails schema validation, that's an automatic low confidence.

On low confidence, the Spectrum:
1. **Discards the cheap result** (does not return it to the agent)
2. **Re-runs against the next-tier model** in the candidates list
3. **Records the escalation** so the success_rate decays for the cheap model on this class
4. Returns the better result

The agent never sees the failed cheap call — it just gets a slightly slower, slightly more expensive response that's correct. This is critical: **cheap routing must never trade accuracy for cost without permission**.

For agents that prefer to avoid escalation entirely, set `optimize: "best"` or pin a capability to a specific tier.

---

## Multi-provider / multi-source

The Spectrum talks to:

| Source | How |
|---|---|
| **Closed-source frontier APIs** | OpenAI, Anthropic, Google, xAI, Cohere — one HTTPS client each, with native streaming, prompt cache (Anthropic), reasoning effort (OpenAI/Claude) |
| **OpenRouter** | As one upstream — gives access to hundreds of models for niches the platform doesn't host directly |
| **Vercel AI Gateway** | As another upstream when configured by the tenant |
| **Self-hosted on Lantern GPUs** | vLLM and Text Generation Inference servers running open-weight models (Llama, Mistral, Mixtral, Qwen, DeepSeek, Phi). Lantern operates these inside the same K8s cluster as the rest of the platform, on a dedicated GPU node pool. Cost is amortized infrastructure cost, often 5-10× cheaper than equivalent API calls. |
| **Edge models** | TinyLlama, Phi-3-mini, Gemma 2B, DistilBERT, ALBERT — running directly inside the Spectrum's Rust process via `candle`, `mistral.rs`, or ONNX Runtime. Sub-50ms inference, no network hop. Used for classification, routing decisions, simple extraction. |
| **Tenant BYO** | Tenants can register their own provider (a private vLLM endpoint, an Ollama at home, a corporate Bedrock account) and the Spectrum will route to it transparently. |

**The point: the agent never knows or cares.** It says `capability: "chat-small", optimize: "cheap"` and the Spectrum picks the cheapest path that's been working.

### How edge / open / closed coexist

Routing tiers from cheapest to most expensive:

```
Tier 0 — Edge (in-process)              ~50ms,   ~$0.0000  per call
Tier 1 — Self-hosted small open model   ~150ms,  ~$0.0001  per 1k tokens
Tier 2 — Self-hosted large open model   ~500ms,  ~$0.001   per 1k tokens
Tier 3 — Closed-source small (Haiku/Flash) ~400ms, ~$0.0005 per 1k tokens (input)
Tier 4 — Closed-source large (Sonnet/GPT) ~800ms, ~$0.003 per 1k tokens
Tier 5 — Closed-source frontier (Opus/Ultra) ~2000ms, ~$0.015 per 1k tokens
```

The Spectrum walks up tiers on escalation. For `optimize: cheap`, it starts at the cheapest tier the prompt class supports. For `optimize: best`, it starts at Tier 5. For `optimize: balanced`, it picks the predicted Pareto winner directly.

### Edge models matter

Edge models (Tier 0) are the killer for latency-sensitive agent steps. Examples:

- **Routing decisions** — "should this go to the support agent or the sales agent?" — DistilBERT, 5ms, free.
- **Format extraction** — "is this an email address?" — regex first, then a tiny model.
- **Simple classification** — sentiment, intent, language detection — sub-50ms.
- **First-pass safety checks** — "is this prompt asking for illegal content?" — fast classifier before we pay for a frontier call.

Putting these inline in the Spectrum (in-process Rust) means a multi-step agent can do dozens of decisions per second without making any network calls.

---

## Caching layers

| Layer | What it caches | Hit rate target | TTL |
|---|---|---|---|
| **Exact prompt cache** | SHA-256 of normalized request → response | 5-15% in agent workloads | 24h, configurable |
| **Semantic prompt cache** | Embedding kNN (cosine ≥ 0.985) → response | 10-25% in repetitive workloads | 24h |
| **Provider-native prompt cache** | Pass-through to Anthropic prompt cache, OpenAI's automatic cache | n/a (saves cost transparently) | provider-managed |
| **Tool-result cache** | Memoize idempotent connector / web tool results within a run | 20-40% in research workloads | per-run |
| **Capability→model decision cache** | Skip the classifier for prompts whose hash matches a recent decision | high | 5min |

Caches respect:
- **Per-tenant isolation** — never serve a cached response across tenants.
- **`no_cache: true`** opt-out per call.
- **PII redaction** — caches store ciphertext; the lookup key is over normalized prompt; the value is encrypted with a tenant key.

### Semantic cache details

Embeddings of read-only prompts (no tool calls, no time-sensitive content) are stored in the same pgvector instance as memory. On cache lookup, the Spectrum:
1. Embeds the new prompt (50ms with edge embedder)
2. kNN search in pgvector with `cosine >= 0.985` and `tenant_id = ?`
3. If hit, return the cached response with `cache_kind: semantic` in metadata.

Semantic caching is **only enabled for prompts with no tool calls** (so we don't return stale weather, prices, etc.) and **only for `optimize: cheap` or `optimize: balanced`** (so `optimize: best` always pays for fresh).

---

## Failover and reliability

For each provider, the Spectrum tracks:
- **5xx rate** in the last 1 minute (sliding window)
- **429 rate** in the last 1 minute
- **Latency p99** in the last 5 minutes

When a primary returns 5xx or 429:
1. Mark provider degraded for 30 seconds.
2. Find the next-best provider for the same capability tier.
3. Retry transparently. The agent never sees the failure.
4. If the failover model produces a different format, normalize it via the provider adapter.

Generation IDs are injected on the first content chunk (Vercel pattern) so dashboard reconnects can resume mid-stream even across a provider failover.

---

## Budgets and policy enforcement

Per-tenant and per-agent budgets:

```yaml
# in agent.yaml
limits:
  max_cost_usd: 5.00          # per run
  max_tokens: 2_000_000       # per run

# at tenant level
budgets:
  monthly_cap_usd: 500
  warn_at_pct: 75
  hard_cutoff: true
```

The Spectrum:
- Reads the tenant's current monthly spend from billing on every call (cached for 5s).
- Reads the per-run remaining budget from the workflow engine's run state.
- If the call would exceed either, returns a structured `BudgetExceeded` error to the agent.
- Agents handle this either by switching to a smaller model (`optimize: "cheap"` retry) or by pausing the run and emitting an "approval required" notification.

Budget enforcement is **synchronous and authoritative** — there's no chance of accidentally going over because of an async billing pipeline lag.

---

## Streaming protocol

The Spectrum streams from the upstream provider to the caller in **the same wire format** the agent SDK expects, regardless of which provider was picked. We normalize:

- OpenAI Chat Completions stream → Lantern stream
- OpenAI Responses API stream → Lantern stream
- Anthropic Messages stream → Lantern stream
- Google Gemini stream → Lantern stream
- vLLM SSE → Lantern stream
- llama.cpp REST → buffered → Lantern stream

The wire format is the **OpenAI Chat Completions stream** (the de facto standard) extended with optional Lantern fields:
- `lantern.generation_id` — set on first chunk for resumption
- `lantern.model_used` — the actual model the Spectrum picked
- `lantern.cost_estimate_usd` — running cost
- `lantern.cache` — `none` | `exact` | `semantic` | `provider`
- `lantern.tier` — `0` (edge) through `5` (frontier)

These extras are wrapped in the `metadata` channel of the protocol; vanilla OpenAI clients ignore them.

---

## Observability

Every model call emits an OTel span with:
- `model.capability`, `model.actual`, `model.tier`
- `optimize.target`
- `prompt.class` (from the classifier)
- `tokens.in`, `tokens.out`
- `cost_usd`
- `latency.ttft_ms`, `latency.total_ms`
- `cache.kind` (none/exact/semantic/provider)
- `escalated` (true if cheap model failed and we escalated)
- `failover` (true if primary provider was down)
- `budget.remaining_usd`

The dashboard's run inspector shows the model decision tree per step: classifier output, candidate scores, chosen model, escalations, cache hits.

---

## What this looks like in agent code

```ts
// Smallest possible — let the Spectrum decide
const reply = await ctx.llm.complete({ prompt: "What's 2+2?" });
// → routed to chat-edge tier 0 (Phi-3-mini), 5ms, free

// Capability-addressed
const plan = await ctx.llm.json({
  capability: "reasoning-large",
  schema: PlanSchema,
  prompt: "Make a 6-step plan to research X",
});
// → routed to Claude Sonnet (via Spectrum), ~800ms, ~$0.003

// Cost-optimized (cheap is fine)
const summary = await ctx.llm.complete({
  capability: "auto",
  prompt: longText,
  optimize: "cheap",
});
// → routed first to self-hosted Llama 3 8B; if low confidence, escalates to Sonnet

// Latency-optimized (fast wins)
const verdict = await ctx.llm.complete({
  capability: "chat-small",
  prompt: "Is this email a refund request? Reply yes or no.",
  optimize: "fast",
});
// → routed to edge classifier in-process (Tier 0), 5ms

// Always-best (cost no object)
const deep = await ctx.llm.json({
  capability: "reasoning-frontier",
  schema: ResearchSchema,
  prompt: hardQuestion,
  optimize: "best",
  no_cache: true,
});
// → routed to Claude Opus or GPT-5 reasoning, ~2s, expensive
```

The agent **never names a vendor or model**. The Spectrum makes the choice, learns from outcomes, and the same code automatically gets cheaper as new edge models drop and faster as new frontier models drop.

---

## What's intentionally NOT in the Spectrum

- **No proprietary model.** We don't train our own LLM. We route across what the world has built.
- **No prompt rewriting.** The Spectrum routes raw prompts; it does not rewrite them. Prompt engineering belongs in the agent or in shared prompt templates.
- **No agent loop.** The Spectrum is a model gateway, not an agent. The agent loop lives in the workflow engine.
- **No "free" tier of frontier models.** When the agent says `optimize: best`, it pays for best.
- **No fake savings.** Every escalation is recorded; every cache hit is reported. Cost-tracking is real.

---

## See also

- [`07-context-management.md`](07-context-management.md) — token budgeter, summarization, cache reuse
- [`adr/0006-spectrum-routing.md`](../adr/0006-spectrum-routing.md) — why we built the Spectrum and didn't just point at OpenRouter
- [`adr/0011-mcp-and-a2a.md`](../adr/0011-mcp-and-a2a.md) — how the Spectrum participates in MCP/A2A flows
