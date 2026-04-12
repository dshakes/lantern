import { agent, step } from "@lantern/sdk";
import { z } from "zod";

// --- Input / Output types ---

interface TalentSearchInput {
  role: string;
  skills: string[];
  experience: string;
  location?: string;
  count?: number;
}

interface CandidateProfile {
  name: string;
  headline: string;
  platform: string;
  profileUrl: string;
  matchScore: number;
  skills: string[];
  highlights: string[];
  experience: string;
  location: string;
}

interface OutreachDraft {
  candidateName: string;
  subject: string;
  body: string;
  channel: "email" | "linkedin";
}

interface TalentSearchOutput {
  candidates: CandidateProfile[];
  outreachDrafts: OutreachDraft[];
  searchSummary: string;
}

// --- Zod schemas for structured LLM output ---

const searchQueriesSchema = z.object({
  queries: z.array(
    z.object({
      query: z.string(),
      platform: z.enum(["linkedin", "github", "stackoverflow", "academic"]),
      rationale: z.string(),
    }),
  ),
});

const candidateAnalysisSchema = z.object({
  name: z.string(),
  headline: z.string(),
  matchScore: z.number().min(0).max(100),
  skills: z.array(z.string()),
  highlights: z.array(z.string()),
  experience: z.string(),
  location: z.string(),
  strengthsForRole: z.string(),
  concerns: z.string(),
});

const rankingSchema = z.object({
  rankedCandidates: z.array(
    z.object({
      name: z.string(),
      rank: z.number(),
      adjustedScore: z.number().min(0).max(100),
      rationale: z.string(),
    }),
  ),
  searchSummary: z.string(),
});

const outreachSchema = z.object({
  drafts: z.array(
    z.object({
      candidateName: z.string(),
      subject: z.string(),
      body: z.string(),
      channel: z.enum(["email", "linkedin"]),
    }),
  ),
});

// --- Agent definition ---

export default agent<TalentSearchInput, TalentSearchOutput>({
  name: "talent-scout",
  version: "0.1.0",
  model: "auto",

  async run({ input, ctx }) {
    const targetCount = input.count ?? 5;

    ctx.log.info("Starting talent search", {
      role: input.role,
      skills: input.skills,
      experience: input.experience,
      location: input.location,
      targetCount,
    });

    // Step 1: Generate targeted search queries from the job spec
    // Uses reasoning-small — this is a lightweight planning task, no need for a big model
    const searchPlan = await step("craft-queries", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a technical recruiting strategist. Generate targeted search
                      queries to find candidates on different platforms. Each query should use
                      platform-specific syntax (e.g., GitHub search operators, LinkedIn Boolean).`,
          },
          {
            role: "user",
            content: `Find candidates for this role:
                      Role: ${input.role}
                      Required skills: ${input.skills.join(", ")}
                      Experience level: ${input.experience}
                      Location: ${input.location ?? "Remote / Anywhere"}

                      Generate 2 queries per platform: LinkedIn, GitHub, Stack Overflow, and
                      academic papers. Tailor each query to that platform's search syntax.`,
          },
        ],
        schema: searchQueriesSchema,
        capability: "reasoning-small",
        optimize: "cheap",
      });
    });

    ctx.log.info("Search plan ready", {
      queryCount: searchPlan.queries.length,
    });

    // Step 2: Search all platforms in parallel
    // step.map fans out across platforms concurrently — each search is independent
    const searchResults = await step.map(
      "search-platforms",
      searchPlan.queries,
      async (querySpec) => {
        const results = await ctx.tools.web.search(querySpec.query);
        return {
          platform: querySpec.platform,
          query: querySpec.query,
          results,
        };
      },
    );

    // Collect all candidate URLs from search results
    const candidateUrls = searchResults.flatMap((r: any) => {
      const items = r.results?.items ?? [];
      return items.map((item: any) => ({
        url: item.url,
        title: item.title,
        snippet: item.snippet,
        platform: r.platform,
      }));
    });

    ctx.log.info("Platforms searched", {
      totalResults: candidateUrls.length,
    });

    // Deduplicate by URL and take top results
    const seen = new Set<string>();
    const uniqueCandidates = candidateUrls.filter((c: any) => {
      if (seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    }).slice(0, targetCount * 3); // fetch more than needed to allow ranking

    // Step 3: Deep-analyze each candidate in parallel
    // Uses code-large for GitHub analysis (understanding repos/contributions)
    const analyzedCandidates = await step.map(
      "analyze-candidates",
      uniqueCandidates,
      async (candidate: any) => {
        // Fetch the profile/page content
        const pageContent = await ctx.tools.web.fetch(candidate.url);
        const truncated = pageContent.slice(0, 5000);

        const analysis = await ctx.llm.json({
          messages: [
            {
              role: "system",
              content: `You are a technical talent analyst. Analyze this candidate's profile
                        for the role of ${input.role} requiring ${input.skills.join(", ")}.
                        Experience level: ${input.experience}.
                        Extract structured information about the candidate.
                        If information is not available, make reasonable inferences from context.`,
            },
            {
              role: "user",
              content: `Platform: ${candidate.platform}
                        URL: ${candidate.url}
                        Title: ${candidate.title}
                        Snippet: ${candidate.snippet}

                        Page content:
                        ${truncated}`,
            },
          ],
          schema: candidateAnalysisSchema,
          capability: "code-large",
        });

        return {
          ...analysis,
          platform: candidate.platform,
          profileUrl: candidate.url,
        };
      },
    );

    ctx.log.info("Candidates analyzed", {
      count: analyzedCandidates.length,
    });

    // Step 4: Rank and score all candidates holistically
    // Uses reasoning-large — this requires nuanced judgment across multiple signals
    const ranking = await step("rank-candidates", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a senior technical recruiter. Rank and score candidates for the
                      role based on holistic fit. Consider skills match, experience level,
                      demonstrated impact, and cultural signals. Be specific in your rationale.`,
          },
          {
            role: "user",
            content: `Role: ${input.role}
                      Required skills: ${input.skills.join(", ")}
                      Experience: ${input.experience}
                      Location preference: ${input.location ?? "Remote / Anywhere"}

                      Candidates to rank:
                      ${JSON.stringify(analyzedCandidates, null, 2)}

                      Rank all candidates. Adjust their match scores based on holistic assessment.
                      Produce a 2-3 sentence search summary covering the talent landscape.`,
          },
        ],
        schema: rankingSchema,
        capability: "reasoning-large",
      });
    });

    // Merge ranking data with candidate profiles
    const rankedProfiles: CandidateProfile[] = ranking.rankedCandidates
      .slice(0, targetCount)
      .map((ranked) => {
        const original = analyzedCandidates.find(
          (c: any) => c.name === ranked.name,
        );
        return {
          name: ranked.name,
          headline: original?.headline ?? "",
          platform: original?.platform ?? "unknown",
          profileUrl: original?.profileUrl ?? "",
          matchScore: ranked.adjustedScore,
          skills: original?.skills ?? [],
          highlights: original?.highlights ?? [],
          experience: original?.experience ?? "",
          location: original?.location ?? "",
        };
      });

    // Step 5: Draft personalized outreach for top candidates
    // Uses chat-small — outreach writing is formulaic, doesn't need a large model
    const outreach = await step("generate-outreach", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a recruiting outreach specialist. Write personalized, concise
                      messages that reference specific things about each candidate's work.
                      Avoid generic flattery. Be direct about the opportunity. Keep messages
                      under 150 words.`,
          },
          {
            role: "user",
            content: `Role: ${input.role}
                      Skills: ${input.skills.join(", ")}

                      Write outreach for these top candidates:
                      ${JSON.stringify(rankedProfiles, null, 2)}

                      For each candidate, choose email or LinkedIn based on which platform
                      they were found on. Write a subject line and message body.`,
          },
        ],
        schema: outreachSchema,
        capability: "chat-small",
        optimize: "cheap",
      });
    });

    // Step 6: Notify the recruiter via Slack with results
    await step("notify-recruiter", async () => {
      const topNames = rankedProfiles
        .slice(0, 3)
        .map((c) => `${c.name} (${c.matchScore}%)`)
        .join(", ");

      await ctx.notify({
        channel: "slack",
        message: `Talent search complete for *${input.role}*\n\nFound ${rankedProfiles.length} qualified candidates.\nTop matches: ${topNames}\n\nFull results available in the run dashboard.`,
      });
    });

    ctx.log.info("Talent search complete", {
      candidates: rankedProfiles.length,
      outreachDrafts: outreach.drafts.length,
      costUsd: ctx.cost.estimateUsd(),
    });

    return {
      candidates: rankedProfiles,
      outreachDrafts: outreach.drafts,
      searchSummary: ranking.searchSummary,
    };
  },
});
