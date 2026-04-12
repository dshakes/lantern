import { agent, step } from "@lantern/sdk";

interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

interface EmailSummary {
  from: string;
  subject: string;
  summary: string;
  priority: "high" | "medium" | "low";
}

export default agent({
  name: "{{.Name}}",
  async run({ input, ctx }) {
    // Step 1: Read recent unread emails from Gmail.
    const emails = await step("read-gmail", async () => {
      const messages: Email[] = await ctx.connectors.gmail.listMessages({
        query: "is:unread",
        maxResults: input.maxEmails ?? 10,
      });

      ctx.log.info("Fetched unread emails", { count: messages.length });
      return messages;
    });

    if (emails.length === 0) {
      ctx.log.info("No unread emails found, skipping");
      return { emailsProcessed: 0, message: "No unread emails to process" };
    }

    // Step 2: Summarize each email with the LLM.
    const summaries = await step("summarize-emails", async () => {
      const emailContext = emails
        .map(
          (e: Email) =>
            `From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}`,
        )
        .join("\n---\n");

      const result = await ctx.llm.complete({
        prompt: `Summarize each of the following emails in 1-2 sentences. For each, assess priority (high/medium/low) based on urgency and sender importance.

${emailContext}

Return a JSON array of objects with: from, subject, summary, priority`,
      });

      return result as EmailSummary[];
    });

    // Step 3: Post the digest to a Slack channel.
    const slackMessage = await step("post-to-slack", async () => {
      const highPriority = summaries.filter(
        (s: EmailSummary) => s.priority === "high",
      );
      const otherCount = summaries.length - highPriority.length;

      const blocks = [
        `*Email Digest* — ${summaries.length} unread emails`,
        "",
        ...highPriority.map(
          (s: EmailSummary) =>
            `:red_circle: *${s.subject}* (from ${s.from})\n${s.summary}`,
        ),
        "",
        otherCount > 0
          ? `_Plus ${otherCount} more at normal/low priority._`
          : "_All emails are high priority._",
      ].join("\n");

      const result = await ctx.connectors.slack.postMessage({
        channel: input.slackChannel ?? "#email-digest",
        text: blocks,
      });

      ctx.log.info("Posted digest to Slack", {
        channel: input.slackChannel ?? "#email-digest",
      });

      return result;
    });

    // Step 4: Log the summary to Google Sheets for tracking.
    await step("log-to-sheets", async () => {
      const rows = summaries.map((s: EmailSummary) => [
        new Date().toISOString(),
        s.from,
        s.subject,
        s.summary,
        s.priority,
      ]);

      await ctx.connectors.googleSheets.appendRows({
        spreadsheetId: input.spreadsheetId,
        range: "EmailLog!A:E",
        values: rows,
      });

      ctx.log.info("Logged to Google Sheets", { rowCount: rows.length });
    });

    return {
      emailsProcessed: emails.length,
      highPriority: summaries.filter((s: EmailSummary) => s.priority === "high")
        .length,
      slackMessageId: slackMessage.ts,
      sheetsRowsAdded: summaries.length,
    };
  },
});
