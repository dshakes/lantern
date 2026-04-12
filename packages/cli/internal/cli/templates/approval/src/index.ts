import { agent, step } from "@lantern/sdk";

interface Proposal {
  title: string;
  description: string;
  estimatedCost: number;
  actions: string[];
}

export default agent({
  name: "{{.Name}}",
  async run({ input, ctx }) {
    // Step 1: Gather context and recall relevant past decisions from memory.
    const context = await step("gather-context", async () => {
      // Search vector memory for similar past requests.
      const pastDecisions = await ctx.memory.recall({
        query: input.request,
        limit: 5,
      });

      ctx.log.info("Recalled past decisions", { count: pastDecisions.length });

      return {
        request: input.request,
        pastDecisions: pastDecisions.map(
          (d: { content: string; score: number }) => ({
            content: d.content,
            relevance: d.score,
          }),
        ),
      };
    });

    // Step 2: Generate a proposal based on the request and context.
    const proposal = await step("generate-proposal", async () => {
      const pastContext =
        context.pastDecisions.length > 0
          ? `\n\nRelevant past decisions:\n${context.pastDecisions
              .map(
                (d: { content: string; relevance: number }) =>
                  `- (relevance: ${d.relevance.toFixed(2)}) ${d.content}`,
              )
              .join("\n")}`
          : "";

      const result = await ctx.llm.complete({
        prompt: `Based on the following request, generate a concrete proposal with a title, description, estimated cost, and list of actions to take.
${pastContext}

Request: ${context.request}

Return JSON: { "title": "...", "description": "...", "estimatedCost": 0.00, "actions": ["action1", "action2", ...] }`,
      });

      return result as Proposal;
    });

    ctx.log.info("Proposal generated", { title: proposal.title });

    // Step 3: Ask the user a clarifying question if the request is ambiguous.
    // ctx.ask() durably pauses the run and resumes when the user replies.
    const clarification = await step("clarify-scope", async () => {
      const answer = await ctx.ask({
        question: `I've drafted a proposal: "${proposal.title}". Before I request approval, is there anything you'd like me to adjust?\n\nPlanned actions:\n${proposal.actions.map((a: string, i: number) => `${i + 1}. ${a}`).join("\n")}\n\nEstimated cost: $${proposal.estimatedCost.toFixed(2)}`,
        timeout: "24h",
      });

      return answer;
    });

    // Step 4: Revise the proposal if the user requested changes.
    const finalProposal = await step("revise-proposal", async () => {
      if (
        clarification.response.toLowerCase() === "looks good" ||
        clarification.response.toLowerCase() === "no changes"
      ) {
        return proposal;
      }

      const revised = await ctx.llm.complete({
        prompt: `Revise the following proposal based on the user's feedback.

Original proposal:
${JSON.stringify(proposal, null, 2)}

User feedback: ${clarification.response}

Return the revised proposal in the same JSON format.`,
      });

      return revised as Proposal;
    });

    // Step 5: Request formal approval. This durably pauses the run until
    // an authorized approver accepts or rejects.
    const approval = await step("request-approval", async () => {
      const result = await ctx.approval.request({
        title: finalProposal.title,
        description: finalProposal.description,
        details: {
          estimatedCost: `$${finalProposal.estimatedCost.toFixed(2)}`,
          actions: finalProposal.actions,
        },
        approvers: input.approvers ?? ["team-lead"],
        timeout: "72h",
      });

      ctx.log.info("Approval decision received", {
        approved: result.approved,
        approver: result.approvedBy,
      });

      return result;
    });

    if (!approval.approved) {
      // Store the rejection in memory for future context.
      await step("remember-rejection", async () => {
        await ctx.memory.store({
          content: `Rejected: "${finalProposal.title}" — reason: ${approval.reason ?? "no reason given"}`,
          metadata: { type: "decision", outcome: "rejected" },
        });
      });

      return {
        status: "rejected",
        proposal: finalProposal.title,
        rejectedBy: approval.approvedBy,
        reason: approval.reason,
      };
    }

    // Step 6: Execute the approved actions.
    const results = await step("execute-actions", async () => {
      const outcomes: { action: string; status: string }[] = [];

      for (const action of finalProposal.actions) {
        const outcome = await ctx.llm.complete({
          prompt: `Execute the following action and describe the result:\n\nAction: ${action}\n\nReturn JSON: { "action": "...", "status": "completed" | "failed", "details": "..." }`,
        });
        outcomes.push(outcome as { action: string; status: string });
      }

      return outcomes;
    });

    // Step 7: Store the outcome in memory for future reference.
    await step("remember-outcome", async () => {
      await ctx.memory.store({
        content: `Approved and executed: "${finalProposal.title}" — ${results.length} actions completed`,
        metadata: {
          type: "decision",
          outcome: "approved",
          cost: finalProposal.estimatedCost,
        },
      });
    });

    return {
      status: "completed",
      proposal: finalProposal.title,
      approvedBy: approval.approvedBy,
      actionsExecuted: results.length,
      results,
    };
  },
});
