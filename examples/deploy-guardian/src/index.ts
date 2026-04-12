import { agent, step } from "@lantern/sdk";
import { z } from "zod";

// --- Types ---

interface WebhookPayload {
  action: string;
  ref: string;
  repository: {
    full_name: string;
    default_branch: string;
  };
  head_commit?: {
    id: string;
    message: string;
    author: { name: string; email: string };
  };
  pull_request?: {
    number: number;
    title: string;
    merged: boolean;
    merge_commit_sha: string;
    user: { login: string };
    labels: { name: string }[];
  };
  sender: { login: string };
}

interface SignalResult {
  source: string;
  status: "healthy" | "degraded" | "critical" | "unknown";
  details: string;
  metrics?: Record<string, number>;
}

interface DeployDecision {
  action: "deploy" | "block" | "rollback";
  riskScore: number;
  rationale: string;
}

interface DeployGuardianOutput {
  repo: string;
  commitSha: string;
  riskScore: number;
  decision: "deploy" | "block" | "rollback";
  rationale: string;
  signals: SignalResult[];
  codeAnalysis: CodeRiskAnalysis;
  requiresApproval: boolean;
  postDeployStatus?: string;
}

interface CodeRiskAnalysis {
  riskLevel: "low" | "medium" | "high" | "critical";
  changedFiles: number;
  riskFactors: string[];
  safetyFactors: string[];
}

// --- Zod schemas ---

const codeRiskSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  changedFiles: z.number(),
  riskFactors: z.array(z.string()),
  safetyFactors: z.array(z.string()),
  sensitiveAreas: z.array(
    z.object({
      file: z.string(),
      concern: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
  summary: z.string(),
});

const riskAssessmentSchema = z.object({
  riskScore: z.number().min(1).max(10),
  decision: z.enum(["deploy", "block"]),
  rationale: z.string(),
  keyRisks: z.array(z.string()),
  mitigations: z.array(z.string()),
  recommendedMonitoringMinutes: z.number(),
});

const postDeployCheckSchema = z.object({
  status: z.enum(["healthy", "degraded", "critical"]),
  shouldRollback: z.boolean(),
  rationale: z.string(),
  metrics: z.array(
    z.object({
      name: z.string(),
      preDeploy: z.number(),
      postDeploy: z.number(),
      changePercent: z.number(),
      isAnomaly: z.boolean(),
    }),
  ),
});

// --- Agent definition ---

export default agent<WebhookPayload, DeployGuardianOutput>({
  name: "deploy-guardian",
  version: "0.1.0",
  model: "auto",

  async run({ input, ctx }) {
    const repo = input.repository.full_name;
    const commitSha =
      input.head_commit?.id ??
      input.pull_request?.merge_commit_sha ??
      "unknown";
    const commitMessage =
      input.head_commit?.message ?? input.pull_request?.title ?? "";
    const author =
      input.head_commit?.author?.name ??
      input.pull_request?.user?.login ??
      input.sender.login;

    ctx.log.info("Deploy guardian triggered", {
      repo,
      commitSha: commitSha.slice(0, 8),
      author,
      action: input.action,
    });

    // Step 1: Analyze the code diff for risk
    // Uses code-large — needs deep understanding of code changes and their implications
    const diff = await step("fetch-diff", async () => {
      return ctx.connectors.github.getCommitDiff({
        repo,
        sha: commitSha,
      });
    });

    const codeAnalysis = await step("analyze-changes", async () => {
      const files = (diff as any)?.files ?? [];

      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a senior SRE reviewing a deploy for risk. Analyze the code diff
                      and assess deployment risk. Look for:
                      - Database migrations or schema changes
                      - Changes to authentication/authorization
                      - Infrastructure or config changes
                      - Changes to payment/billing code
                      - API contract changes (breaking changes)
                      - Large refactors with no test changes
                      - Changes to feature flags or rollout controls

                      Also note safety factors: good test coverage, feature flags, small scope, etc.`,
          },
          {
            role: "user",
            content: `Repository: ${repo}
                      Commit: ${commitSha.slice(0, 8)} — "${commitMessage}"
                      Author: ${author}
                      Files changed: ${files.length}

                      Diff:
                      ${JSON.stringify(files.slice(0, 30), null, 2)}`,
          },
        ],
        schema: codeRiskSchema,
        capability: "code-large",
      });
    });

    ctx.log.info("Code analysis complete", {
      riskLevel: codeAnalysis.riskLevel,
      changedFiles: codeAnalysis.changedFiles,
      riskFactors: codeAnalysis.riskFactors.length,
    });

    // Step 2: Check operational signals in parallel
    // step.map fans out to 4 monitoring systems concurrently
    const signals = await step.map(
      "check-signals",
      [
        {
          name: "github-actions",
          check: async (): Promise<SignalResult> => {
            const runs = await ctx.connectors.github.getCheckRuns({
              repo,
              ref: commitSha,
            });
            const checkRuns = (runs as any)?.check_runs ?? [];
            const failed = checkRuns.filter(
              (r: any) => r.conclusion === "failure",
            );
            const pending = checkRuns.filter(
              (r: any) => r.status === "in_progress",
            );
            return {
              source: "GitHub Actions",
              status:
                failed.length > 0
                  ? "critical"
                  : pending.length > 0
                    ? "degraded"
                    : "healthy",
              details:
                failed.length > 0
                  ? `${failed.length} check(s) failed: ${failed.map((f: any) => f.name).join(", ")}`
                  : pending.length > 0
                    ? `${pending.length} check(s) still running`
                    : `All ${checkRuns.length} checks passed`,
              metrics: {
                total: checkRuns.length,
                passed: checkRuns.filter(
                  (r: any) => r.conclusion === "success",
                ).length,
                failed: failed.length,
                pending: pending.length,
              },
            };
          },
        },
        {
          name: "sentry",
          check: async (): Promise<SignalResult> => {
            const errors = await ctx.connectors.sentry.getIssues({
              project: repo.split("/")[1],
              timeRange: "1h",
              sort: "freq",
            });
            const issueCount = (errors as any)?.issues?.length ?? 0;
            const errorRate = (errors as any)?.errorRate ?? 0;
            return {
              source: "Sentry",
              status:
                errorRate > 5
                  ? "critical"
                  : errorRate > 1
                    ? "degraded"
                    : "healthy",
              details:
                errorRate > 1
                  ? `Elevated error rate: ${errorRate}/min across ${issueCount} issues`
                  : `Normal error rate: ${errorRate}/min`,
              metrics: { errorRate, activeIssues: issueCount },
            };
          },
        },
        {
          name: "datadog",
          check: async (): Promise<SignalResult> => {
            const metrics = await ctx.connectors.datadog.queryMetrics({
              queries: [
                `avg:system.cpu.user{service:${repo.split("/")[1]}}`,
                `avg:trace.http.request.duration{service:${repo.split("/")[1]}}`,
                `sum:trace.http.request.errors{service:${repo.split("/")[1]}}.as_rate()`,
              ],
              timeRange: "1h",
            });
            const cpuAvg = (metrics as any)?.cpu ?? 0;
            const p99Latency = (metrics as any)?.latency_p99 ?? 0;
            const errorRate = (metrics as any)?.error_rate ?? 0;
            return {
              source: "Datadog",
              status:
                cpuAvg > 80 || errorRate > 5
                  ? "critical"
                  : cpuAvg > 60 || errorRate > 1
                    ? "degraded"
                    : "healthy",
              details: `CPU: ${cpuAvg}%, P99 latency: ${p99Latency}ms, Error rate: ${errorRate}/s`,
              metrics: { cpuAvg, p99Latency, errorRate },
            };
          },
        },
        {
          name: "pagerduty",
          check: async (): Promise<SignalResult> => {
            const incidents = await ctx.connectors.pagerduty.getIncidents({
              serviceIds: [repo.split("/")[1]],
              statuses: ["triggered", "acknowledged"],
            });
            const activeIncidents = (incidents as any)?.incidents ?? [];
            const criticalCount = activeIncidents.filter(
              (i: any) => i.urgency === "high",
            ).length;
            return {
              source: "PagerDuty",
              status:
                criticalCount > 0
                  ? "critical"
                  : activeIncidents.length > 0
                    ? "degraded"
                    : "healthy",
              details:
                activeIncidents.length > 0
                  ? `${activeIncidents.length} active incident(s) (${criticalCount} critical)`
                  : "No active incidents",
              metrics: {
                activeIncidents: activeIncidents.length,
                critical: criticalCount,
              },
            };
          },
        },
      ],
      async (signal) => signal.check(),
    );

    ctx.log.info("Operational signals checked", {
      signals: signals.map(
        (s: SignalResult) => `${s.source}: ${s.status}`,
      ),
    });

    // Step 3: Synthesize all signals into a risk assessment
    // Uses reasoning-large — this is the critical decision point, needs strong judgment
    const assessment = await step("assess-risk", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a senior SRE making a deploy/no-deploy decision. Synthesize the
                      code analysis and operational signals into a risk score (1-10) and decision.

                      Risk scoring guide:
                      1-3: Low risk. Small changes, all checks pass, no active incidents.
                      4-6: Medium risk. Some concerns but manageable with monitoring.
                      7-8: High risk. Significant concerns — requires approval from on-call.
                      9-10: Critical risk. Active incidents, failing checks, or dangerous code changes. Block.

                      CRITICAL: If any CI check has failed, the risk score MUST be >= 8.
                      If there are active PagerDuty incidents, add +2 to the score.
                      A deploy during an active incident is almost always wrong.`,
          },
          {
            role: "user",
            content: `Commit: ${commitSha.slice(0, 8)} — "${commitMessage}" by ${author}

                      Code Analysis:
                      Risk level: ${codeAnalysis.riskLevel}
                      Risk factors: ${codeAnalysis.riskFactors.join("; ")}
                      Safety factors: ${codeAnalysis.safetyFactors.join("; ")}
                      Summary: ${codeAnalysis.summary}

                      Operational Signals:
                      ${signals.map((s: SignalResult) => `${s.source}: ${s.status} — ${s.details}`).join("\n")}`,
          },
        ],
        schema: riskAssessmentSchema,
        capability: "reasoning-large",
      });
    });

    ctx.log.info("Risk assessed", {
      riskScore: assessment.riskScore,
      decision: assessment.decision,
    });

    // Step 4: If high risk, request approval from on-call engineer
    let requiresApproval = false;

    if (assessment.riskScore > 7 && assessment.decision !== "block") {
      requiresApproval = true;

      ctx.log.info("High-risk deploy — requesting approval", {
        riskScore: assessment.riskScore,
      });

      // Durable approval gate — survives restarts
      await step("request-approval", async () => {
        await ctx.approval.request({
          reason: `High-risk deploy (score: ${assessment.riskScore}/10) for ${repo}\n\nCommit: ${commitSha.slice(0, 8)} — "${commitMessage}"\nRisks: ${assessment.keyRisks.join(", ")}\nMitigations: ${assessment.mitigations.join(", ")}`,
          approvers: ["oncall-engineer"],
          quorum: 1,
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          policy: "deploy-approval",
        });
      });
    }

    // Step 5: Execute the decision
    let decision: "deploy" | "block" | "rollback" = assessment.decision;

    if (assessment.decision === "block") {
      // Blocked — notify and stop
      await step("notify-block", async () => {
        await ctx.notify({
          channel: "slack",
          message: `*Deploy BLOCKED* for \`${repo}\`\n\nCommit: \`${commitSha.slice(0, 8)}\` — "${commitMessage}"\nRisk score: ${assessment.riskScore}/10\n\nReason: ${assessment.rationale}\n\nKey risks:\n${assessment.keyRisks.map((r) => `- ${r}`).join("\n")}`,
        });

        // Post a commit status to GitHub
        await ctx.connectors.github.createCommitStatus({
          repo,
          sha: commitSha,
          state: "failure",
          description: `Deploy blocked — risk score ${assessment.riskScore}/10`,
          context: "lantern/deploy-guardian",
        });
      });
    } else {
      // Approved — trigger the deploy
      await step("execute-deploy", async () => {
        await ctx.connectors.vercel.createDeployment({
          project: repo.split("/")[1],
          ref: commitSha,
          production: true,
        });

        await ctx.connectors.github.createCommitStatus({
          repo,
          sha: commitSha,
          state: "success",
          description: `Deploy approved — risk score ${assessment.riskScore}/10`,
          context: "lantern/deploy-guardian",
        });

        await ctx.notify({
          channel: "slack",
          message: `*Deploy started* for \`${repo}\`\n\nCommit: \`${commitSha.slice(0, 8)}\` — "${commitMessage}" by ${author}\nRisk score: ${assessment.riskScore}/10\n${requiresApproval ? "Approved by on-call engineer.\n" : ""}Monitoring for ${assessment.recommendedMonitoringMinutes} minutes...`,
        });
      });

      // Step 6: Post-deploy monitoring
      // Durable sleep — the agent sleeps for N minutes then wakes up to check health
      // The VM can be recycled during this sleep; the workflow engine resumes it
      const monitorDuration = `${assessment.recommendedMonitoringMinutes}m`;

      ctx.log.info("Sleeping for post-deploy monitoring", {
        duration: monitorDuration,
      });

      await step.sleep("post-deploy-wait", monitorDuration);

      // Check health after the monitoring window
      const postDeployCheck = await step("post-deploy-check", async () => {
        // Fetch fresh signals after the deploy
        const [sentryPost, datadogPost] = await Promise.all([
          ctx.connectors.sentry.getIssues({
            project: repo.split("/")[1],
            timeRange: `${assessment.recommendedMonitoringMinutes}m`,
            sort: "new",
          }),
          ctx.connectors.datadog.queryMetrics({
            queries: [
              `avg:trace.http.request.errors{service:${repo.split("/")[1]}}.as_rate()`,
              `avg:trace.http.request.duration{service:${repo.split("/")[1]}}`,
            ],
            timeRange: `${assessment.recommendedMonitoringMinutes}m`,
          }),
        ]);

        return ctx.llm.json({
          messages: [
            {
              role: "system",
              content: `You are monitoring a production deploy. Compare pre-deploy and post-deploy
                        metrics. Flag any anomalies. Decide if a rollback is needed.

                        Rollback criteria:
                        - Error rate increased by more than 3x
                        - New critical Sentry issues appeared
                        - P99 latency increased by more than 50%`,
            },
            {
              role: "user",
              content: `Pre-deploy signals:
                        ${signals.map((s: SignalResult) => `${s.source}: ${JSON.stringify(s.metrics)}`).join("\n")}

                        Post-deploy signals (after ${assessment.recommendedMonitoringMinutes} minutes):
                        Sentry: ${JSON.stringify(sentryPost)}
                        Datadog: ${JSON.stringify(datadogPost)}`,
            },
          ],
          schema: postDeployCheckSchema,
          capability: "reasoning-large",
        });
      });

      if (postDeployCheck.shouldRollback) {
        decision = "rollback";

        await step("rollback", async () => {
          // Trigger rollback via Vercel
          await ctx.connectors.vercel.rollbackDeployment({
            project: repo.split("/")[1],
          });

          await ctx.notify({
            channel: "slack",
            message: `*ROLLBACK triggered* for \`${repo}\`\n\nReason: ${postDeployCheck.rationale}\n\nMetrics:\n${postDeployCheck.metrics
              .filter((m) => m.isAnomaly)
              .map(
                (m) =>
                  `- ${m.name}: ${m.preDeploy} -> ${m.postDeploy} (${m.changePercent > 0 ? "+" : ""}${m.changePercent.toFixed(1)}%)`,
              )
              .join("\n")}`,
          });
        });

        ctx.log.warn("Post-deploy rollback executed", {
          rationale: postDeployCheck.rationale,
        });
      } else {
        await step("notify-healthy", async () => {
          await ctx.notify({
            channel: "slack",
            message: `*Deploy healthy* for \`${repo}\` after ${assessment.recommendedMonitoringMinutes}m monitoring.\n\nStatus: ${postDeployCheck.status}\n${postDeployCheck.rationale}`,
          });
        });

        ctx.log.info("Post-deploy check passed", {
          status: postDeployCheck.status,
        });
      }
    }

    ctx.log.info("Deploy guardian complete", {
      decision,
      riskScore: assessment.riskScore,
      costUsd: ctx.cost.estimateUsd(),
    });

    return {
      repo,
      commitSha,
      riskScore: assessment.riskScore,
      decision,
      rationale: assessment.rationale,
      signals,
      codeAnalysis: {
        riskLevel: codeAnalysis.riskLevel,
        changedFiles: codeAnalysis.changedFiles,
        riskFactors: codeAnalysis.riskFactors,
        safetyFactors: codeAnalysis.safetyFactors,
      },
      requiresApproval,
      postDeployStatus:
        decision === "rollback"
          ? "rolled-back"
          : decision === "block"
            ? undefined
            : "healthy",
    };
  },
});
