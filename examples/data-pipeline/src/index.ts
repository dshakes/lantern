import { agent, step } from "@lantern/sdk";
import { z } from "zod";

// --- Types ---

interface DataPipelineInput {
  // No input required — triggered on schedule
  // Optional overrides for manual runs:
  dateRange?: { start: string; end: string };
  skipDistribution?: boolean;
}

interface DataSource {
  name: string;
  recordCount: number;
  fetchDurationMs: number;
}

interface Trend {
  metric: string;
  direction: "up" | "down" | "flat";
  changePercent: number;
  insight: string;
}

interface Anomaly {
  metric: string;
  expected: string;
  actual: string;
  severity: "low" | "medium" | "high";
  possibleCause: string;
}

interface DataPipelineOutput {
  report: string;
  sources: DataSource[];
  trends: Trend[];
  anomalies: Anomaly[];
  costBreakdown: CostBreakdown;
  distributedTo: string[];
}

interface CostBreakdown {
  totalUsd: number;
  byStep: Record<string, number>;
}

// --- Zod schemas ---

const crmDataSchema = z.object({
  newDeals: z.number(),
  closedWonDeals: z.number(),
  closedWonRevenue: z.number(),
  pipelineValue: z.number(),
  avgDealCycledays: z.number(),
  topDeals: z.array(
    z.object({
      name: z.string(),
      value: z.number(),
      stage: z.string(),
      owner: z.string(),
    }),
  ),
});

const billingDataSchema = z.object({
  mrr: z.number(),
  newSubscriptions: z.number(),
  churnedSubscriptions: z.number(),
  netRevenueRetention: z.number(),
  topExpansions: z.array(
    z.object({
      customer: z.string(),
      previousMrr: z.number(),
      newMrr: z.number(),
    }),
  ),
  failedPayments: z.number(),
});

const analyticsDataSchema = z.object({
  weeklyActiveUsers: z.number(),
  signups: z.number(),
  activationRate: z.number(),
  topPages: z.array(z.object({ path: z.string(), views: z.number() })),
  avgSessionDuration: z.number(),
  bounceRate: z.number(),
});

const transformedDataSchema = z.object({
  period: z.string(),
  revenue: z.object({
    mrr: z.number(),
    arr: z.number(),
    newRevenue: z.number(),
    churnedRevenue: z.number(),
    netNew: z.number(),
  }),
  growth: z.object({
    userGrowth: z.number(),
    revenueGrowth: z.number(),
    dealVelocity: z.number(),
  }),
  health: z.object({
    activationRate: z.number(),
    nrr: z.number(),
    churnRate: z.number(),
    paymentFailureRate: z.number(),
  }),
  highlights: z.array(z.string()),
});

const analysisSchema = z.object({
  trends: z.array(
    z.object({
      metric: z.string(),
      direction: z.enum(["up", "down", "flat"]),
      changePercent: z.number(),
      insight: z.string(),
    }),
  ),
  anomalies: z.array(
    z.object({
      metric: z.string(),
      expected: z.string(),
      actual: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      possibleCause: z.string(),
    }),
  ),
  executiveSummary: z.string(),
  recommendations: z.array(z.string()),
});

// --- Agent definition ---

export default agent<DataPipelineInput, DataPipelineOutput>({
  name: "data-pipeline",
  version: "0.1.0",
  model: "auto",

  async run({ input, ctx }) {
    const now = ctx.now();
    const weekEnd = now.toISOString().split("T")[0];
    const weekStart =
      input?.dateRange?.start ??
      new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

    ctx.log.info("Data pipeline started", { weekStart, weekEnd });

    const costByStep: Record<string, number> = {};
    const sources: DataSource[] = [];

    function trackCost(stepName: string, costBefore: number) {
      costByStep[stepName] = ctx.cost.estimateUsd() - costBefore;
    }

    // Step 1: Fetch data from 3 sources in parallel
    // step.map executes all fetches concurrently — no waiting for sequential API calls
    const costBeforeFetch = ctx.cost.estimateUsd();

    const [crmRaw, billingRaw, analyticsRaw] = await step.map(
      "fetch-sources",
      [
        {
          name: "hubspot",
          fetch: async () => {
            const start = Date.now();
            const data = await ctx.connectors.hubspot.getDeals({
              dateRange: { start: weekStart, end: weekEnd },
              properties: [
                "dealname",
                "amount",
                "dealstage",
                "hubspot_owner_id",
                "closedate",
              ],
            });
            sources.push({
              name: "HubSpot CRM",
              recordCount: (data as any)?.deals?.length ?? 0,
              fetchDurationMs: Date.now() - start,
            });
            return data;
          },
        },
        {
          name: "stripe",
          fetch: async () => {
            const start = Date.now();
            const data = await ctx.connectors.stripe.getSubscriptionMetrics({
              dateRange: { start: weekStart, end: weekEnd },
            });
            sources.push({
              name: "Stripe Billing",
              recordCount: (data as any)?.subscriptions?.length ?? 0,
              fetchDurationMs: Date.now() - start,
            });
            return data;
          },
        },
        {
          name: "google_analytics",
          fetch: async () => {
            const start = Date.now();
            const data = await ctx.connectors.google_analytics.getReport({
              dateRange: { start: weekStart, end: weekEnd },
              metrics: [
                "activeUsers",
                "newUsers",
                "sessions",
                "bounceRate",
                "avgSessionDuration",
              ],
              dimensions: ["pagePath", "date"],
            });
            sources.push({
              name: "Google Analytics",
              recordCount: (data as any)?.rows?.length ?? 0,
              fetchDurationMs: Date.now() - start,
            });
            return data;
          },
        },
      ],
      async (source) => source.fetch(),
    );

    trackCost("fetch-sources", costBeforeFetch);

    ctx.log.info("Data fetched from all sources", {
      sources: sources.map((s) => `${s.name}: ${s.recordCount} records`),
    });

    // Step 2: Transform and normalize the raw data
    // Uses chat-small — data cleaning/normalization is a straightforward task
    const costBeforeTransform = ctx.cost.estimateUsd();

    const transformed = await step("transform", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a data analyst. Clean, normalize, and merge data from three
                      sources (CRM, billing, analytics) into a unified weekly business metrics
                      object. Calculate derived metrics like ARR (MRR * 12), net new revenue,
                      churn rate, etc. Extract 3-5 weekly highlights.`,
          },
          {
            role: "user",
            content: `Period: ${weekStart} to ${weekEnd}

                      CRM Data (HubSpot):
                      ${JSON.stringify(crmRaw, null, 2)}

                      Billing Data (Stripe):
                      ${JSON.stringify(billingRaw, null, 2)}

                      Analytics Data (Google Analytics):
                      ${JSON.stringify(analyticsRaw, null, 2)}`,
          },
        ],
        schema: transformedDataSchema,
        capability: "chat-small",
        optimize: "cheap",
      });
    });

    trackCost("transform", costBeforeTransform);

    ctx.log.info("Data transformed", {
      mrr: transformed.revenue.mrr,
      highlights: transformed.highlights.length,
    });

    // Step 3: Analyze trends and detect anomalies
    // Uses reasoning-large — pattern recognition and anomaly detection need strong reasoning
    const costBeforeAnalysis = ctx.cost.estimateUsd();

    const analysis = await step("analyze-trends", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a senior business analyst. Analyze the weekly metrics to identify:
                      1. Trends: what's moving up, down, or flat vs expected
                      2. Anomalies: anything unexpected that needs attention
                      3. Executive summary: 2-3 paragraph overview for leadership
                      4. Recommendations: 2-4 actionable next steps

                      Be specific with numbers. Flag anything that deviates more than 10% from
                      a reasonable baseline. Prioritize findings by business impact.`,
          },
          {
            role: "user",
            content: `Weekly metrics for ${transformed.period}:
                      ${JSON.stringify(transformed, null, 2)}`,
          },
        ],
        schema: analysisSchema,
        capability: "reasoning-large",
      });
    });

    trackCost("analyze-trends", costBeforeAnalysis);

    ctx.log.info("Analysis complete", {
      trends: analysis.trends.length,
      anomalies: analysis.anomalies.length,
    });

    // Step 4: Generate a formatted report
    const costBeforeReport = ctx.cost.estimateUsd();

    const report = await step("generate-report", async () => {
      const anomalySection =
        analysis.anomalies.length > 0
          ? `\n## Anomalies Detected\n${analysis.anomalies
              .map(
                (a) =>
                  `- **${a.severity.toUpperCase()}** — ${a.metric}: Expected ${a.expected}, got ${a.actual}. ${a.possibleCause}`,
              )
              .join("\n")}`
          : "";

      return ctx.llm.complete({
        messages: [
          {
            role: "system",
            content: `Generate a clean, well-formatted Markdown weekly business report.
                      Include sections for: Executive Summary, Key Metrics, Trends, Anomalies
                      (if any), and Recommendations. Use tables for metrics. Keep it concise
                      but comprehensive — this goes to the C-suite.`,
          },
          {
            role: "user",
            content: `Period: ${transformed.period}

                      Executive Summary:
                      ${analysis.executiveSummary}

                      Metrics:
                      ${JSON.stringify(transformed.revenue, null, 2)}
                      ${JSON.stringify(transformed.growth, null, 2)}
                      ${JSON.stringify(transformed.health, null, 2)}

                      Trends:
                      ${JSON.stringify(analysis.trends, null, 2)}

                      ${anomalySection}

                      Recommendations:
                      ${analysis.recommendations.map((r) => `- ${r}`).join("\n")}

                      Highlights:
                      ${transformed.highlights.map((h) => `- ${h}`).join("\n")}`,
          },
        ],
        capability: "chat-small",
        optimize: "cheap",
      });
    });

    trackCost("generate-report", costBeforeReport);

    // Step 5: Distribute the report to multiple channels
    const distributedTo: string[] = [];

    if (!input?.skipDistribution) {
      const costBeforeDistribute = ctx.cost.estimateUsd();

      await step("distribute", async () => {
        // Post to Slack
        await ctx.notify({
          channel: "slack",
          message: `*Weekly Business Report — ${transformed.period}*\n\n${analysis.executiveSummary}\n\nFull report attached.`,
          attachments: [{ type: "markdown", content: report }],
        });
        distributedTo.push("slack:#weekly-metrics");

        // Email stakeholders
        await ctx.connectors.gmail.sendMessage({
          to: "leadership@company.com",
          subject: `Weekly Business Report — ${transformed.period}`,
          body: report,
        });
        distributedTo.push("email:leadership@company.com");

        // Update Google Sheet with this week's row
        await ctx.connectors.google_sheets.appendRow({
          spreadsheetId: "weekly-metrics-tracker",
          range: "WeeklyData!A:J",
          values: [
            transformed.period,
            transformed.revenue.mrr,
            transformed.revenue.arr,
            transformed.revenue.netNew,
            transformed.growth.userGrowth,
            transformed.growth.revenueGrowth,
            transformed.health.activationRate,
            transformed.health.nrr,
            transformed.health.churnRate,
            analysis.anomalies.length,
          ],
        });
        distributedTo.push("google-sheets:weekly-metrics-tracker");

        // Post to Notion
        await ctx.connectors.notion.createPage({
          parentId: "weekly-reports-db",
          title: `Weekly Report — ${transformed.period}`,
          content: report,
          properties: {
            MRR: transformed.revenue.mrr,
            Anomalies: analysis.anomalies.length,
            Status: "Published",
          },
        });
        distributedTo.push("notion:weekly-reports-db");
      });

      trackCost("distribute", costBeforeDistribute);
    }

    const totalCost = ctx.cost.estimateUsd();

    ctx.log.info("Pipeline complete", {
      totalCostUsd: totalCost,
      costByStep,
      distributedTo,
    });

    return {
      report,
      sources,
      trends: analysis.trends,
      anomalies: analysis.anomalies,
      costBreakdown: {
        totalUsd: totalCost,
        byStep: costByStep,
      },
      distributedTo,
    };
  },
});
