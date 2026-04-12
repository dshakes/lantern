import { agent, step } from "@lantern/sdk";

type Intent = "calendar" | "email" | "reminder" | "general";

interface ClassificationResult {
  intent: Intent;
  confidence: number;
  extractedEntities: Record<string, string>;
}

export default agent({
  name: "{{.Name}}",
  async run({ input, ctx }) {
    const userMessage: string = input.message;

    // Step 1: Classify the user's intent.
    const classification = await step("classify-intent", async () => {
      const result = await ctx.llm.complete({
        prompt: `Classify the following message into one of these intents: calendar, email, reminder, general.

Also extract any relevant entities (dates, times, names, subjects).

Message: "${userMessage}"

Return JSON: { "intent": "...", "confidence": 0.0-1.0, "extractedEntities": { ... } }`,
      });
      return result as ClassificationResult;
    });

    ctx.log.info("Intent classified", {
      intent: classification.intent,
      confidence: classification.confidence,
    });

    // Step 2: Route to the appropriate handler based on intent.
    switch (classification.intent) {
      case "calendar": {
        const calendarResult = await step("check-calendar", async () => {
          const date = classification.extractedEntities.date ?? "today";
          const events = await ctx.connectors.googleCalendar.listEvents({
            timeMin: date,
            maxResults: 10,
          });

          const summary = await ctx.llm.complete({
            prompt: `Summarize these calendar events in a friendly, concise way suitable for a chat message:

${JSON.stringify(events, null, 2)}

Keep it brief and conversational.`,
          });

          return { events, summary };
        });

        return {
          intent: "calendar",
          reply: calendarResult.summary,
          eventCount: calendarResult.events.length,
        };
      }

      case "email": {
        const emailResult = await step("email-summary", async () => {
          const query = classification.extractedEntities.subject
            ? `subject:${classification.extractedEntities.subject}`
            : "is:unread";

          const messages = await ctx.connectors.gmail.listMessages({
            query,
            maxResults: 5,
          });

          const summary = await ctx.llm.complete({
            prompt: `Summarize these emails in a brief, conversational way for a chat reply:

${JSON.stringify(messages, null, 2)}

Be concise — this is a chat message, not a report.`,
          });

          return { messageCount: messages.length, summary };
        });

        return {
          intent: "email",
          reply: emailResult.summary,
          emailCount: emailResult.messageCount,
        };
      }

      case "reminder": {
        const reminderResult = await step("set-reminder", async () => {
          const parsed = await ctx.llm.complete({
            prompt: `Parse this reminder request and return JSON with "title" (string) and "dueAt" (ISO 8601 datetime):

"${userMessage}"

If no specific time is given, default to 1 hour from now.`,
          });

          const { title, dueAt } = parsed as { title: string; dueAt: string };

          await ctx.connectors.googleCalendar.createEvent({
            summary: `Reminder: ${title}`,
            start: dueAt,
            end: dueAt,
            reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
          });

          return { title, dueAt };
        });

        return {
          intent: "reminder",
          reply: `Got it — I'll remind you about "${reminderResult.title}" at ${reminderResult.dueAt}.`,
        };
      }

      case "general":
      default: {
        const generalResult = await step("general-reply", async () => {
          const reply = await ctx.llm.complete({
            prompt: `You are a helpful personal assistant replying via chat. Be concise and friendly.

User: ${userMessage}`,
          });
          return reply as string;
        });

        return {
          intent: "general",
          reply: generalResult,
        };
      }
    }
  },
});
