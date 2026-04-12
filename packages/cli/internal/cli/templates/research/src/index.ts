import { agent, step } from "@lantern/sdk";
import { z } from "zod";

const QuerySchema = z.object({
  queries: z.array(z.string()).describe("Search queries to research the topic"),
});

const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});

const SynthesisSchema = z.object({
  summary: z.string().describe("Concise synthesis of all findings"),
  keyFindings: z.array(z.string()).describe("Bullet-point key findings"),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
});

export default agent({
  name: "{{.Name}}",
  async run({ input, ctx }) {
    // Step 1: Generate targeted search queries from the research topic.
    const { queries } = await step("generate-queries", async () => {
      const result = await ctx.llm.complete({
        prompt: `You are a research assistant. Given the topic below, generate 3-5 targeted search queries that will cover the topic thoroughly.

Topic: ${input.topic}

Return a JSON object with a "queries" array of strings.`,
        schema: QuerySchema,
      });
      return result;
    });

    ctx.log.info("Generated queries", { count: queries.length, queries });

    // Step 2: Execute searches in parallel using step.map.
    const searchResults = await step.map(
      "search",
      queries,
      async (query) => {
        const results = await ctx.tools.webSearch({ query, maxResults: 5 });
        return results.map((r: z.infer<typeof SearchResultSchema>) => ({
          query,
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        }));
      },
    );

    const allResults = searchResults.flat();
    ctx.log.info("Search complete", { totalResults: allResults.length });

    // Step 3: Synthesize all search results into a coherent report.
    const synthesis = await step("synthesize", async () => {
      const context = allResults
        .map((r) => `[${r.title}](${r.url})\n${r.snippet}`)
        .join("\n\n");

      const result = await ctx.llm.complete({
        prompt: `You are a research analyst. Synthesize the following search results into a clear, well-structured report on the topic: "${input.topic}"

Search Results:
${context}

Return a JSON object with:
- "summary": a concise paragraph synthesizing all findings
- "keyFindings": an array of key bullet points
- "sources": an array of {title, url} for the most relevant sources`,
        schema: SynthesisSchema,
      });
      return result;
    });

    return {
      topic: input.topic,
      summary: synthesis.summary,
      keyFindings: synthesis.keyFindings,
      sources: synthesis.sources,
      queriesUsed: queries,
    };
  },
});
