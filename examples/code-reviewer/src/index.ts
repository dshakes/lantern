import { agent, step } from "@lantern/sdk";
import { z } from "zod";

interface ReviewInput {
  repo: string; // "owner/repo"
  prNumber: number;
  focus?: string[]; // areas to focus on: "security", "performance", "style", etc.
}

interface ReviewComment {
  file: string;
  line: number;
  severity: "critical" | "warning" | "suggestion" | "praise";
  message: string;
}

interface ReviewOutput {
  summary: string;
  verdict: "approve" | "request-changes" | "comment";
  comments: ReviewComment[];
  score: number; // 1-10
}

export default agent<ReviewInput, ReviewOutput>({
  name: "code-reviewer",
  version: "0.1.0",
  model: "auto",

  async run({ input, ctx }) {
    ctx.log.info("Starting code review", {
      repo: input.repo,
      pr: input.prNumber,
    });

    // Step 1: Fetch PR details and diff via GitHub connector
    const pr = await step("fetch-pr", async () => {
      return ctx.connectors.github.getPullRequest({
        repo: input.repo,
        number: input.prNumber,
      });
    });

    const diff = await step("fetch-diff", async () => {
      return ctx.connectors.github.getPullRequestDiff({
        repo: input.repo,
        number: input.prNumber,
      });
    });

    ctx.log.info("Fetched PR", {
      title: (pr as any).title,
      files: (diff as any).files?.length ?? 0,
    });

    // Step 2: Analyze each changed file in parallel
    const files = (diff as any).files ?? [];
    const fileReviews = await step.map(
      "review-file",
      files,
      async (file: any) => {
        const focusAreas = input.focus?.length
          ? `Focus especially on: ${input.focus.join(", ")}.`
          : "";

        return ctx.llm.json({
          messages: [
            {
              role: "system",
              content: `You are an expert code reviewer. Review the following file diff and provide
                        specific, actionable feedback. Be constructive and precise. ${focusAreas}`,
            },
            {
              role: "user",
              content: `File: ${file.filename}\nStatus: ${file.status}\n\nDiff:\n${file.patch}`,
            },
          ],
          schema: z.object({
            comments: z.array(
              z.object({
                line: z.number(),
                severity: z.enum([
                  "critical",
                  "warning",
                  "suggestion",
                  "praise",
                ]),
                message: z.string(),
              }),
            ),
          }),
          capability: "code-large",
        });
      },
    );

    // Step 3: Collect all comments across files
    const allComments: ReviewComment[] = fileReviews.flatMap(
      (review: any, idx: number) =>
        (review.comments ?? []).map((c: any) => ({
          file: files[idx].filename,
          line: c.line,
          severity: c.severity,
          message: c.message,
        })),
    );

    // Step 4: Generate overall summary and verdict
    const summary = await step("summarize", async () => {
      const criticalCount = allComments.filter(
        (c) => c.severity === "critical",
      ).length;
      const warningCount = allComments.filter(
        (c) => c.severity === "warning",
      ).length;

      return ctx.llm.json({
        prompt: `Summarize this code review:
                 - PR: ${(pr as any).title}
                 - Files changed: ${files.length}
                 - Critical issues: ${criticalCount}
                 - Warnings: ${warningCount}
                 - Total comments: ${allComments.length}

                 Comments: ${JSON.stringify(allComments.slice(0, 20))}

                 Provide a verdict and score (1-10).`,
        schema: z.object({
          summary: z.string(),
          verdict: z.enum(["approve", "request-changes", "comment"]),
          score: z.number().min(1).max(10),
        }),
        capability: "reasoning-small",
      });
    });

    // Step 5: Post review comments back to GitHub
    await step("post-review", async () => {
      await ctx.connectors.github.createPullRequestReview({
        repo: input.repo,
        number: input.prNumber,
        body: summary.summary,
        event:
          summary.verdict === "approve"
            ? "APPROVE"
            : summary.verdict === "request-changes"
              ? "REQUEST_CHANGES"
              : "COMMENT",
        comments: allComments.slice(0, 30).map((c) => ({
          path: c.file,
          line: c.line,
          body: `**${c.severity.toUpperCase()}**: ${c.message}`,
        })),
      });
    });

    ctx.log.info("Review complete", {
      verdict: summary.verdict,
      score: summary.score,
      comments: allComments.length,
    });

    return {
      summary: summary.summary,
      verdict: summary.verdict,
      comments: allComments,
      score: summary.score,
    };
  },
});
