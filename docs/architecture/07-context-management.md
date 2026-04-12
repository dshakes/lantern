# Context Management — Big Context Windows Are Not Enough

> **What this is:** the layer that decides what goes into the LLM's prompt on each call: which messages, which tool results, which memories, how much summarization, how much cache reuse. The Spectrum picks *which model*; the Context Manager picks *what to send*.
>
> **Why it matters:** the new generation of models has 1-2M token context windows. Filling them is the most expensive thing you can do. Modern agent economics live or die on whether you put 50,000 tokens in front of the model when 5,000 would have done.

---

## The thesis

Three things drive the cost of an LLM call: tokens in, tokens out, and the model picked. We already automate model picking (the Spectrum). Token *output* is mostly bounded by the task. **Token input is the giant lever no one is pulling well.**

In a typical multi-turn agent run today:
- Tool results dominate the prompt (often 80%+).
- Old conversation turns are dragged forward unnecessarily.
- The model is asked to find the needle in a haystack on every call instead of the agent compacting before sending.
- Provider prompt caches are not exploited because the prefix changes every turn.

The Context Manager fixes this with a few small disciplines applied automatically and transparently:

1. **Token budget per call.** The agent sets a budget; the manager guarantees the prompt fits.
2. **Hierarchical compaction.** Tool results are progressively summarized as they age out of the active window.
3. **Selective recall over wholesale dragging.** Old turns are recalled by relevance, not by recency.
4. **Prefix stability for cache reuse.** The prompt is constructed so the *prefix* (system + tools + instructions) is byte-stable across calls within a run, maximizing provider prompt cache hits.
5. **Lazy expansion.** Resources (files, MCP responses, large connector outputs) are loaded by reference and only expanded if the model asks.

Done well, this cuts production token costs 3-10× without measurable accuracy loss.

---

## Where the manager sits

```
agent code: ctx.llm.complete({ prompt, tools, history? })
                      │
                      ▼
        ┌────────────────────────────┐
        │   Context Manager (in SDK) │
        │  - load history/memory     │
        │  - apply token budget      │
        │  - compact tool results    │
        │  - stabilize prefix        │
        │  - lazy refs               │
        └────────────────┬───────────┘
                         │  built prompt
                         ▼
              ┌──────────────────┐
              │   Spectrum       │
              └──────────────────┘
```

The Context Manager is implemented in the SDK (`@lantern/sdk/context`) so it runs inside the agent sandbox, not as a separate service. This keeps it deterministic with the workflow journal — the same input → the same prompt → the same model decision → the same response (modulo provider non-determinism the Spectrum tracks).

---

## Token budgeter

Every prompt-building call goes through a budgeter:

```ts
const built = ctx.context.build({
  system: SYSTEM_PROMPT,
  tools: [/* tool defs */],
  history: history,                  // structured turns
  newUserMessage: input,
  resources: [bigDoc],
  budget: {
    max_input_tokens: 32_000,        // hard cap
    target_input_tokens: 16_000,     // optimization target
    keep_recent_n: 6,                // recent turns always included
    reserve_for_output: 4_000,
  },
});

const reply = await ctx.llm.complete({ ...built, capability: "reasoning-large" });
```

The budgeter:
1. **Counts tokens** for every section using a fast tokenizer matched to the candidate model family (BPE for OpenAI, Claude tokenizer for Anthropic, sentencepiece for Llama). The Spectrum tells the budgeter which model family is most likely so it counts accurately.
2. **Includes the always-on bits** (system, tools, recent N turns, the new user message).
3. **Greedily includes** older turns and resources by relevance score until target is reached.
4. **If still over the target**, applies compaction (below).
5. **If still over the max**, drops lowest-relevance items and emits a warning.

The budgeter never silently drops content the agent considers required — `requiredResources` are added first and never compacted unless they alone exceed the max (in which case the call fails loudly).

---

## Hierarchical compaction

Tool results are the biggest source of bloat. The manager keeps each tool result at one of four resolutions:

| Stage | Form | Token cost |
|---|---|---|
| **Fresh** | Full result, exactly as the tool returned it | High |
| **Compacted** | A small-model-generated summary keyed to the original | ~10% |
| **Sketched** | A 1-2 sentence note + a "load full" reference | ~1% |
| **Forgotten** | Removed from the prompt; still in the journal | 0 |

A tool result starts **fresh**. After N turns (configurable, default 2), it's automatically **compacted** by a `chat-small` model call (cheap; the cost is recovered many times over by the avoided tokens). After M turns, it's **sketched**. After K turns (or when the budget pushes), it's **forgotten** from the prompt — but the agent can still recall it from the run journal or memory if the model asks for it.

Compaction happens **out of band**, in a background `step()` so it's durable and replay-safe. The compacted version is cached by the hash of the original.

```
Turn 1: weather_api.get(SF)        → 1200 tokens (fresh)
Turn 2: weather_api.get(SF)        → 1200 tokens (fresh)
Turn 3: ...                          ↓ compacted
                                   "SF: 62°F overcast, ..."  120 tokens
Turn 5: ...                          ↓ sketched
                                   "Got SF weather (ref:t1)"   12 tokens
Turn 9: ...                          ↓ forgotten
                                   (not in prompt; still in journal)
```

If a later turn says "remember the temperature in San Francisco?", the manager detects the model's reference and re-expands from the journal automatically — at the cost of one more LLM call but with the original data.

---

## Selective recall vs. recency

Old turns aren't dragged forward by recency. They're scored by relevance to the current input + recent context, using:
1. **BM25** lexical similarity (free, fast)
2. **Embedding similarity** (one embedding call against the recall vector store)
3. **Recency decay** (mild — a small bonus for newness)
4. **Pinned-by-the-agent flag** (`ctx.context.pin(turn)` — never gets dropped)

The top K (configurable, default 4) old turns above a threshold are included. The rest stay in the journal where the model can summon them.

This is a real perf cliff: a research agent that runs for 50 turns can have a 200K-token raw history but a 12K-token *relevant* history. We pay for the latter.

---

## Memory integration

Three tiers, each with different inclusion rules:

| Tier | Always included? | Mechanism |
|---|---|---|
| **Core memory** | Yes | Inserted in the system prompt. Capped at 2 KB. Edited by the agent itself. |
| **Recall memory** | On demand | Vector + BM25 search; top K above threshold included |
| **Archival memory** | Only on explicit `mem.search()` | Treated as a tool result |

The boundary between recall and archival is "did the agent decide to look it up." Core is always present; recall is included automatically if relevant; archival requires the agent to ask.

This is the Letta model adapted to fit Lantern's prompt budgeter.

---

## Prefix stability and prompt caching

Anthropic and OpenAI both offer **prompt caching** that gives you a 5-10× cost discount on cached prefix tokens. The catch: the *exact* same byte sequence has to recur. The biggest mistake teams make is rebuilding prompts in a way that perturbs the prefix.

The Context Manager builds prompts with this layout:

```
[1] system prompt (stable per agent version)
[2] tool definitions (stable per agent version)
[3] core memory (semi-stable; only changes when the agent edits it)
[4] retrieved memory hits (changes per call — placed AFTER stable region)
[5] turn history (changes per call — placed AFTER stable region)
[6] new user message (changes per call — placed AFTER stable region)
```

Sections 1-3 form a stable prefix. Section 3 changes only when core memory changes (rare). Sections 1-2 change only when the agent version changes (very rare). The provider's prompt cache hits the entire stable prefix on every call.

The manager **explicitly emits a `cache_breakpoint` directive** at the end of section 3 for providers that honor it (Anthropic). For OpenAI's automatic caching, the prefix is naturally stable.

When the prefix needs to change (a new tool is added, the system prompt is updated), the manager warns "this will reset your prompt cache for this agent version" so the user knows.

### Result: ~70% of input tokens are cached prefix on most multi-turn agent runs. Cost drops accordingly.

---

## Lazy expansion of large resources

When a tool returns a 50K-token document, the manager does NOT put 50K tokens in the prompt. Instead it puts a **reference**:

```json
{
  "kind": "resource",
  "id": "res_01HXY...",
  "description": "PDF of Q3 financial report, 47 pages, 51,233 tokens",
  "summary": "Q3 revenue $24.1M (+18% YoY), opex $19.2M, net loss $1.4M, ...",
  "expand_with_tool": "read_resource(res_01HXY...)"
}
```

The model sees the summary. If it decides it needs the full doc, it calls `read_resource(...)` and the manager loads the full content into the next turn. If it doesn't, you saved 50K tokens.

This is the same pattern as MCP resources — read by reference, not by value. The Context Manager applies it automatically to all tool results above a threshold (default 2K tokens).

---

## Per-call configuration

Defaults are usually right but everything is overridable:

```ts
ctx.context.configure({
  budget: {
    max_input_tokens: 64_000,
    target_input_tokens: 24_000,
    keep_recent_n: 8,
    reserve_for_output: 8_000,
  },
  compaction: {
    fresh_for_turns: 3,
    compact_for_turns: 8,
    sketch_for_turns: 20,
  },
  recall: {
    top_k: 6,
    threshold: 0.62,
  },
  prefix_cache: "anthropic",     // or "openai" | "auto"
});
```

---

## Observability

Every prompt build emits a span with:
- `tokens.system`, `tokens.tools`, `tokens.core_memory`
- `tokens.recalled_memory`, `tokens.history`, `tokens.new_input`, `tokens.resources`
- `tokens.total_input`, `tokens.compacted_away`, `tokens.dropped`
- `compactions_run`, `compaction_cost_usd`
- `prefix_cache_breakpoint_position`
- `recall.candidates_considered`, `recall.included`

The dashboard shows a per-turn token stack chart so users can see exactly where their tokens are going and whether the cache is working.

---

## Failure modes

| Failure | What the manager does |
|---|---|
| Total context exceeds max even after maxing compaction | Returns `ContextTooLarge` error to the agent. The agent decides whether to fail, drop a tool result, or split the work. |
| Compaction LLM call fails | Falls back to "sketched" using a deterministic truncation. Logs the failure. |
| Tokenizer / model mismatch (Spectrum picks a model with a different tokenizer than the budgeter assumed) | Re-runs the budgeter with the correct tokenizer; usually fits because we leave headroom. Worst case, some content is dropped. |
| Recall memory store is down | Skips recall; uses recent-only history. Logs a warning. |
| User pinned more content than fits in `max_input_tokens` | Errors loudly. We never silently drop pinned content. |

---

## What's intentionally NOT here

- **No automatic prompt rewriting.** We don't paraphrase user prompts. We assemble; we don't author.
- **No "smart context" for the input message.** The new input is always included as-is. It's the only thing we trust the user/agent to control verbatim.
- **No background context preloading.** The manager runs synchronously per call (compaction happens out of band but is durable, not racy).
- **No "magic" for arbitrary models.** Cache stability tricks are model-family-specific; we expose what works per family rather than promising the same speedup everywhere.

---

## See also

- [`06-model-router.md`](06-model-router.md) — the Spectrum picks the model
- [`05-workflow-engine.md`](05-workflow-engine.md) — compaction runs as a background `step()`
- Letta / MemGPT papers — the memory tier model we adapted
