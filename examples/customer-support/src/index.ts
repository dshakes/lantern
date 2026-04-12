import { agent, step } from "@lantern/sdk";
import { z } from "zod";

// --- Types ---

interface SupportInput {
  ticketId: string;
  customerMessage: string;
  customerEmail: string;
}

interface SupportOutput {
  ticketId: string;
  classification: TicketClassification;
  response: string;
  requiresApproval: boolean;
  approved: boolean;
  humanReviewed: boolean;
  resolutionStored: boolean;
}

interface TicketClassification {
  category: "billing" | "technical" | "feature-request" | "complaint" | "refund";
  severity: "low" | "medium" | "high" | "critical";
  sentiment: "positive" | "neutral" | "negative" | "angry";
  refundAmount?: number;
}

interface CustomerHistory {
  totalTickets: number;
  openTickets: number;
  accountTier: string;
  lifetimeValue: number;
  previousIssues: string[];
}

// --- Zod schemas ---

const classificationSchema = z.object({
  category: z.enum([
    "billing",
    "technical",
    "feature-request",
    "complaint",
    "refund",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  sentiment: z.enum(["positive", "neutral", "negative", "angry"]),
  refundAmount: z.number().optional(),
  reasoning: z.string(),
});

const customerHistorySchema = z.object({
  totalTickets: z.number(),
  openTickets: z.number(),
  accountTier: z.string(),
  lifetimeValue: z.number(),
  previousIssues: z.array(z.string()),
});

const draftResponseSchema = z.object({
  response: z.string(),
  tone: z.string(),
  referencedPolicies: z.array(z.string()),
  suggestedFollowUp: z.string().optional(),
});

const accuracyCheckSchema = z.object({
  isAccurate: z.boolean(),
  issues: z.array(
    z.object({
      type: z.enum(["hallucination", "overpromise", "policy-violation", "tone-issue"]),
      description: z.string(),
      suggestion: z.string(),
    }),
  ),
  revisedResponse: z.string().optional(),
});

// --- Agent definition ---

export default agent<SupportInput, SupportOutput>({
  name: "customer-support",
  version: "0.1.0",
  model: "auto",

  async run({ input, ctx }) {
    ctx.log.info("Processing support ticket", {
      ticketId: input.ticketId,
      customerEmail: input.customerEmail,
    });

    // Step 1: Load customer context from memory and external systems
    const [customerMemory, ticket] = await Promise.all([
      step("load-memory", async () => {
        // Search recall memory for past interactions with this customer
        const pastInteractions = await ctx.mem.recall.search(
          `customer:${input.customerEmail}`,
          { topK: 10 },
        );

        // Get stored customer profile from core KV memory
        const profileJson = await ctx.mem.core.get(
          `customer:${input.customerEmail}`,
        );
        const profile = profileJson ? JSON.parse(profileJson) : null;

        return { pastInteractions, profile };
      }),
      step("load-ticket", async () => {
        // Fetch the full ticket and customer data from Zendesk
        const ticketData = await ctx.connectors.zendesk.getTicket({
          ticketId: input.ticketId,
        });
        const customerData = await ctx.connectors.zendesk.getUser({
          email: input.customerEmail,
        });
        return { ticket: ticketData, customer: customerData };
      }),
    ]);

    // Build a customer history summary for the LLM
    const historyContext = customerMemory.pastInteractions
      .map(
        (entry) =>
          `[${entry.createdAt.toISOString().split("T")[0]}] ${entry.text}`,
      )
      .join("\n");

    ctx.log.info("Context loaded", {
      pastInteractions: customerMemory.pastInteractions.length,
      hasProfile: !!customerMemory.profile,
    });

    // Step 2: Classify the ticket
    // Uses chat-small — classification is a well-defined routing task
    const classification = await step("classify", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a support ticket classifier. Analyze the customer message, their
                      history, and the ticket metadata to classify the issue.

                      For refund requests, extract the dollar amount if mentioned.
                      Assess severity based on: account tier, sentiment, business impact.
                      A high-LTV customer with an angry sentiment is always "high" severity.`,
          },
          {
            role: "user",
            content: `Customer email: ${input.customerEmail}
                      Customer message: ${input.customerMessage}
                      Account tier: ${(ticket.customer as any)?.tier ?? "unknown"}
                      Lifetime value: $${(ticket.customer as any)?.lifetimeValue ?? "unknown"}

                      Previous interactions:
                      ${historyContext || "No previous interactions on record."}`,
          },
        ],
        schema: classificationSchema,
        capability: "chat-small",
        optimize: "fast",
      });
    });

    ctx.log.info("Ticket classified", {
      category: classification.category,
      severity: classification.severity,
      sentiment: classification.sentiment,
      refundAmount: classification.refundAmount,
    });

    // Step 3: Handle approval gates for sensitive actions
    // This is a key Lantern differentiator: the agent DURABLY SUSPENDS waiting for
    // human approval. The process can restart, the VM can be recycled — when the
    // approver clicks "approve" in Slack/dashboard, the agent resumes exactly here.
    let requiresApproval = false;
    let approved = true;

    const needsApproval =
      (classification.category === "refund" &&
        (classification.refundAmount ?? 0) > 100) ||
      (classification.category === "complaint" &&
        classification.severity === "critical");

    if (needsApproval) {
      requiresApproval = true;

      ctx.log.info("Requesting approval for sensitive action", {
        category: classification.category,
        refundAmount: classification.refundAmount,
        severity: classification.severity,
      });

      // This call SUSPENDS the agent. It does not busy-wait or poll.
      // The workflow engine persists the state and resumes when approval arrives.
      await step("request-approval", async () => {
        await ctx.approval.request({
          reason:
            classification.category === "refund"
              ? `Refund $${classification.refundAmount} for ${input.customerEmail} (Ticket #${input.ticketId})`
              : `Critical complaint from ${input.customerEmail} (LTV: $${(ticket.customer as any)?.lifetimeValue ?? "?"}) — requires manual review before response`,
          approvers: ["support-lead", "cs-manager"],
          quorum: 1,
          expiresAt: new Date(
            Date.now() + 4 * 60 * 60 * 1000,
          ).toISOString(),
          policy: "support-escalation",
        });
      });

      // If we reach here, the approval was granted.
      // If it was denied or expired, the step would have thrown and the run would fail.
      ctx.log.info("Approval granted, continuing");
    }

    // Step 4: Draft the response
    // Uses reasoning-small — nuanced customer communication needs careful word choice
    const draft = await step("draft-response", async () => {
      const toneGuidance =
        classification.sentiment === "angry"
          ? "Be empathetic and acknowledge their frustration before addressing the issue."
          : classification.sentiment === "negative"
            ? "Be warm and helpful. Show you understand their concern."
            : "Be friendly and efficient.";

      const refundContext =
        classification.category === "refund" && approved
          ? `The refund of $${classification.refundAmount} has been approved. Confirm it will be processed.`
          : "";

      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a skilled customer support agent. Draft a response that:
                      1. Acknowledges the customer's issue specifically (not generically)
                      2. References their history when relevant
                      3. Provides a clear resolution or next steps
                      4. Maintains the right tone: ${toneGuidance}
                      5. Is concise — under 200 words
                      ${refundContext}

                      IMPORTANT: Never promise features we don't have. Never make up policies.
                      If you're unsure about a policy, say you'll check and follow up.`,
          },
          {
            role: "user",
            content: `Customer message: ${input.customerMessage}
                      Classification: ${classification.category} / ${classification.severity}
                      Customer tier: ${(ticket.customer as any)?.tier ?? "standard"}
                      Past issues: ${historyContext || "None"}`,
          },
        ],
        schema: draftResponseSchema,
        capability: "reasoning-small",
      });
    });

    // Step 5: Verify accuracy with a stronger model
    // Uses reasoning-large to catch hallucinations, overpromises, and policy violations
    // This is a guardrail step — the small model drafts, the large model checks
    const accuracyCheck = await step("check-accuracy", async () => {
      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a quality assurance reviewer for customer support responses.
                      Check the draft for:
                      1. Hallucinations: Does it state facts not supported by the context?
                      2. Overpromises: Does it commit to things we may not be able to deliver?
                      3. Policy violations: Does it contradict standard support policies?
                      4. Tone issues: Is the tone appropriate for the situation?

                      If there are issues, provide a revised response that fixes them.
                      If the draft is good, set isAccurate to true and leave revisedResponse empty.`,
          },
          {
            role: "user",
            content: `Original customer message: ${input.customerMessage}
                      Classification: ${classification.category} / ${classification.severity}
                      Draft response: ${draft.response}
                      Referenced policies: ${draft.referencedPolicies.join(", ")}`,
          },
        ],
        schema: accuracyCheckSchema,
        capability: "reasoning-large",
      });
    });

    // Use the revised response if the accuracy check found issues
    const finalDraft = accuracyCheck.revisedResponse ?? draft.response;

    if (!accuracyCheck.isAccurate) {
      ctx.log.warn("Accuracy check caught issues in draft", {
        issues: accuracyCheck.issues.map((i) => i.type),
      });
    }

    // Step 6: Human review via Slack before sending
    // The agent asks a human to review the response, then waits for their answer
    let humanReviewed = false;

    const reviewResponse = await step("human-review", async () => {
      return ctx.ask({
        surface: "slack",
        message: `*Ticket #${input.ticketId}* — ${classification.category} (${classification.severity})\n\nCustomer said:\n> ${input.customerMessage.slice(0, 200)}\n\nProposed response:\n> ${finalDraft.slice(0, 500)}\n\n${!accuracyCheck.isAccurate ? `\n:warning: QA flagged: ${accuracyCheck.issues.map((i) => i.type).join(", ")}\n` : ""}`,
        options: ["Send as-is", "Edit before sending", "Reject"],
        timeout: "2h",
      });
    });

    humanReviewed = true;

    let responseToSend = finalDraft;

    if (reviewResponse === "Reject") {
      ctx.log.info("Response rejected by human reviewer");
      return {
        ticketId: input.ticketId,
        classification,
        response: "",
        requiresApproval,
        approved,
        humanReviewed,
        resolutionStored: false,
      };
    }

    if (reviewResponse === "Edit before sending") {
      // Ask the reviewer for an edited version
      responseToSend = await step("get-edited-response", async () => {
        return ctx.ask({
          surface: "slack",
          message: "Please paste the edited response:",
          timeout: "1h",
        });
      });
    }

    // Step 7: Send the response via Zendesk
    await step("send-response", async () => {
      await ctx.connectors.zendesk.addTicketComment({
        ticketId: input.ticketId,
        body: responseToSend,
        public: true,
      });

      // Update ticket status based on classification
      const newStatus =
        classification.category === "refund" && approved
          ? "solved"
          : "pending";

      await ctx.connectors.zendesk.updateTicket({
        ticketId: input.ticketId,
        status: newStatus,
        tags: [
          classification.category,
          classification.severity,
          requiresApproval ? "approval-required" : "auto-handled",
        ],
      });
    });

    // Step 8: Store the resolution in archival memory for future reference
    // Next time this customer writes in, step 1 will find this interaction
    const resolutionStored = await step("update-memory", async () => {
      // Store the full interaction in archival (vector-searchable) memory
      await ctx.mem.archival.add(
        `customer:${input.customerEmail} ticket:${input.ticketId} category:${classification.category} — Customer said: "${input.customerMessage.slice(0, 200)}" — Resolution: "${responseToSend.slice(0, 200)}"`,
        {
          ticketId: input.ticketId,
          customerEmail: input.customerEmail,
          category: classification.category,
          severity: classification.severity,
          resolvedAt: ctx.now().toISOString(),
        },
      );

      // Update the customer profile in core KV memory
      const existingProfile = customerMemory.profile ?? {
        totalTickets: 0,
        categories: {},
      };

      await ctx.mem.core.set(
        `customer:${input.customerEmail}`,
        JSON.stringify({
          ...existingProfile,
          totalTickets: existingProfile.totalTickets + 1,
          lastContact: ctx.now().toISOString(),
          lastCategory: classification.category,
          categories: {
            ...existingProfile.categories,
            [classification.category]:
              (existingProfile.categories[classification.category] ?? 0) + 1,
          },
        }),
      );

      return true;
    });

    ctx.log.info("Ticket resolved", {
      ticketId: input.ticketId,
      category: classification.category,
      requiresApproval,
      humanReviewed,
      costUsd: ctx.cost.estimateUsd(),
    });

    return {
      ticketId: input.ticketId,
      classification,
      response: responseToSend,
      requiresApproval,
      approved,
      humanReviewed,
      resolutionStored,
    };
  },
});
