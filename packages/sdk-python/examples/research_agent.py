"""Research agent — demonstrates all major SDK features.

This agent takes a research topic, searches the web, fetches relevant
pages, synthesizes findings, and stores them in archival memory.

Run locally::

    python -m lantern.runtime.runner --agent research-agent \\
        --input '{"topic": "quantum error correction", "depth": 3}'
"""

from lantern import agent, step, step_map, step_sleep
from lantern.tools import tool
from lantern.types import AgentContext, RetryPolicy


@agent(
    "research-agent",
    model="auto",
    description="Deep research agent that searches, reads, and synthesizes",
    tools=[tool.web, tool.python],
    memory=[
        {"kind": "vector", "name": "findings", "scope": "agent", "embedding": "embed-large"},
    ],
    limits={
        "timeout": "10m",
        "max_steps": 50,
        "max_cost_usd": 1.0,
    },
)
async def research(input: dict, ctx: AgentContext) -> dict:
    """Perform deep research on a topic."""

    topic: str = input["topic"]
    depth: int = input.get("depth", 3)

    ctx.log.info(f"Starting research on: {topic}", depth=depth)

    # Step 1: Generate search queries
    queries = await step(
        "generate-queries",
        lambda: ctx.llm.json(
            prompt=(
                f"Generate {depth} diverse search queries to research the topic: {topic}\n"
                "Return a JSON object with a 'queries' array of strings."
            ),
            capability="reasoning-small",
            schema={"type": "object", "properties": {"queries": {"type": "array", "items": {"type": "string"}}}},
        ),
    )
    query_list: list[str] = queries.get("queries", [topic])

    ctx.log.info(f"Generated {len(query_list)} search queries")

    # Step 2: Search the web for each query (parallel, bounded concurrency)
    async def search_query(query: str, index: int) -> dict:
        results = await ctx.tools.web.search(query)
        return {"query": query, "results": results}

    search_results = await step_map(
        "web-search",
        query_list,
        search_query,
        concurrency=3,
        retry=RetryPolicy(max_attempts=2, initial_interval="1s"),
    )

    # Step 3: Collect unique URLs from search results
    urls: list[str] = []
    seen: set[str] = set()
    for sr in search_results:
        for result in (sr.get("results") or []):
            url = result.get("url", "") if isinstance(result, dict) else ""
            if url and url not in seen:
                seen.add(url)
                urls.append(url)
    urls = urls[:depth * 2]  # Limit total fetches

    ctx.log.info(f"Found {len(urls)} unique URLs to fetch")

    # Step 4: Fetch page content (parallel)
    async def fetch_page(url: str, index: int) -> dict:
        try:
            content = await ctx.tools.web.fetch(url)
            return {"url": url, "content": content[:5000], "success": True}
        except Exception as exc:
            return {"url": url, "content": "", "success": False, "error": str(exc)}

    pages = await step_map(
        "fetch-pages",
        urls,
        fetch_page,
        concurrency=5,
        retry=RetryPolicy(max_attempts=2, initial_interval="500ms"),
    )

    successful_pages = [p for p in pages if p.get("success")]
    ctx.log.info(f"Successfully fetched {len(successful_pages)}/{len(urls)} pages")

    # Step 5: Synthesize findings
    page_summaries = "\n\n---\n\n".join(
        f"Source: {p['url']}\n{p['content']}"
        for p in successful_pages
    )

    synthesis = await step(
        "synthesize",
        lambda: ctx.llm.complete(
            prompt=(
                f"You are a research analyst. Synthesize the following sources into a "
                f"comprehensive summary about: {topic}\n\n"
                f"Sources:\n{page_summaries}\n\n"
                f"Provide:\n"
                f"1. A clear summary of the current state of knowledge\n"
                f"2. Key findings and breakthroughs\n"
                f"3. Open questions and areas of active research\n"
                f"4. Practical implications"
            ),
            capability="reasoning-large",
            max_tokens=2000,
        ),
    )

    # Step 6: Store in archival memory for future reference
    await step(
        "store-findings",
        lambda: ctx.mem.archival.add(
            synthesis,
            metadata={"topic": topic, "source_count": len(successful_pages)},
        ),
    )

    # Step 7: Brief cooldown to be a good API citizen
    await step_sleep("cooldown", "1s")

    # Step 8: Generate a concise executive summary
    executive_summary = await step(
        "executive-summary",
        lambda: ctx.llm.complete(
            prompt=(
                f"Condense this research synthesis into a 2-3 sentence executive summary:\n\n"
                f"{synthesis}"
            ),
            capability="chat-small",
            max_tokens=200,
        ),
    )

    ctx.log.info("Research complete")

    return {
        "topic": topic,
        "executive_summary": executive_summary,
        "full_synthesis": synthesis,
        "sources_searched": len(query_list),
        "pages_fetched": len(successful_pages),
        "cost_estimate_usd": ctx.cost.estimate_usd(),
    }
