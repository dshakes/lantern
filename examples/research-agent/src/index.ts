import { agent, step } from "@lantern/sdk";
import { z } from "zod";

interface ResearchInput {
  topic: string;
  depth?: "shallow" | "medium" | "deep";
  maxSources?: number;
}

interface Source {
  title: string;
  url: string;
  snippet: string;
}

interface ResearchOutput {
  topic: string;
  summary: string;
  keyFindings: string[];
  sources: Source[];
  followUpQuestions: string[];
}

export default agent<ResearchInput, ResearchOutput>({
  name: "research-agent",
  version: "0.1.0",
  model: "auto",

  async run({ input, ctx }) {
    const depth = input.depth ?? "medium";
    const maxSources = input.maxSources ?? 5;

    ctx.log.info("Starting research", { topic: input.topic, depth });

    // Step 1: Generate search queries based on depth
    const queries = await step("generate-queries", async () => {
      const queryCount = depth === "shallow" ? 2 : depth === "medium" ? 4 : 6;

      return ctx.llm.json({
        prompt: `Generate ${queryCount} diverse search queries to thoroughly research the topic: "${input.topic}".
                 Include different angles and perspectives.`,
        schema: z.object({
          queries: z.array(z.string()),
        }),
        capability: "chat-small",
      });
    });

    ctx.log.info("Generated queries", { count: queries.queries.length });

    // Step 2: Execute all searches in parallel
    const searchResults = await step.map(
      "search",
      queries.queries,
      async (query) => {
        const results = await ctx.tools.web.search(query);
        return { query, results };
      },
    );

    // Step 3: Fetch and extract content from top results
    const allSources: Source[] = [];
    const contents: string[] = [];

    const topUrls = searchResults
      .flatMap((r: any) => r.results?.items ?? [])
      .slice(0, maxSources);

    const fetched = await step.map(
      "fetch-sources",
      topUrls,
      async (item: any) => {
        const content = await ctx.tools.web.fetch(item.url);
        return {
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          content: content.slice(0, 3000), // truncate for context budget
        };
      },
    );

    for (const source of fetched) {
      allSources.push({
        title: source.title,
        url: source.url,
        snippet: source.snippet,
      });
      contents.push(`## ${source.title}\n${source.content}`);
    }

    // Step 4: Synthesize all findings into a structured report
    const report = await step("synthesize", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a research analyst. Synthesize the provided sources into a
                      comprehensive research report on the given topic.`,
          },
          {
            role: "user",
            content: `Topic: ${input.topic}\n\nSources:\n${contents.join("\n\n---\n\n")}

                      Produce a JSON response with:
                      - summary: 2-3 paragraph overview
                      - keyFindings: array of 3-7 key findings
                      - followUpQuestions: 3 questions for further research`,
          },
        ],
        schema: z.object({
          summary: z.string(),
          keyFindings: z.array(z.string()),
          followUpQuestions: z.array(z.string()),
        }),
        capability: "reasoning-large",
      });
    });

    // Step 5: Store in archival memory for future reference
    await step("store-findings", async () => {
      await ctx.mem.archival.add(
        `Research on "${input.topic}": ${report.summary}`,
        { topic: input.topic, type: "research-report" },
      );
    });

    ctx.log.info("Research complete", {
      sources: allSources.length,
      findings: report.keyFindings.length,
    });

    return {
      topic: input.topic,
      summary: report.summary,
      keyFindings: report.keyFindings,
      sources: allSources,
      followUpQuestions: report.followUpQuestions,
    };
  },
});
