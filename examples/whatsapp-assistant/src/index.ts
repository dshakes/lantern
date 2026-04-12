import { agent, step } from "@lantern/sdk";
import { z } from "zod";

// --- Input / Output types ---

interface Attachment {
  type: "image" | "audio" | "document" | "video";
  url: string;
  mimeType: string;
  filename?: string;
}

interface WhatsAppInput {
  message: string;
  attachments?: Attachment[];
}

type Intent =
  | "calendar"
  | "email"
  | "task"
  | "question"
  | "reminder"
  | "expense";

interface WhatsAppOutput {
  reply: string;
  intent: Intent;
  actions: ActionTaken[];
}

interface ActionTaken {
  type: string;
  description: string;
  result: string;
}

// --- Zod schemas ---

const intentSchema = z.object({
  intent: z.enum([
    "calendar",
    "email",
    "task",
    "question",
    "reminder",
    "expense",
  ]),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  complexity: z.enum(["simple", "complex"]),
});

const calendarActionSchema = z.object({
  action: z.enum(["check-availability", "create-event", "modify-event", "list-events"]),
  title: z.string().optional(),
  date: z.string().optional(),
  time: z.string().optional(),
  duration: z.string().optional(),
  attendees: z.array(z.string()).optional(),
});

const emailActionSchema = z.object({
  action: z.enum(["read-inbox", "summarize-thread", "draft-reply", "send-email"]),
  query: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  threadId: z.string().optional(),
});

const taskActionSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.enum(["urgent", "high", "medium", "low"]),
  dueDate: z.string().optional(),
  project: z.string().optional(),
});

const reminderSchema = z.object({
  message: z.string(),
  delay: z.string(),
  delayDescription: z.string(),
});

const expenseSchema = z.object({
  amount: z.number(),
  currency: z.string(),
  category: z.string(),
  merchant: z.string(),
  date: z.string(),
  description: z.string(),
});

// --- Agent definition ---

export default agent<WhatsAppInput, WhatsAppOutput>({
  name: "whatsapp-assistant",
  version: "0.1.0",
  model: "auto",

  async run({ input, ctx }) {
    ctx.log.info("WhatsApp message received", {
      messageLength: input.message.length,
      hasAttachments: (input.attachments?.length ?? 0) > 0,
    });

    const actions: ActionTaken[] = [];

    // Step 1: Classify the intent
    // Uses chat-small — intent classification is a lightweight task
    const classification = await step("understand-intent", async () => {
      const attachmentInfo = input.attachments?.length
        ? `\nAttachments: ${input.attachments.map((a) => `${a.type} (${a.mimeType})`).join(", ")}`
        : "";

      return ctx.llm.json({
        messages: [
          {
            role: "system",
            content: `You are a personal assistant that classifies WhatsApp messages into intents.
                      Classify the user's message into exactly one intent category.
                      Also assess whether the request is simple or complex.
                      Simple: quick factual answer, single action. Complex: requires reasoning, multi-step.`,
          },
          {
            role: "user",
            content: `${input.message}${attachmentInfo}`,
          },
        ],
        schema: intentSchema,
        capability: "chat-small",
        optimize: "fast",
      });
    });

    ctx.log.info("Intent classified", {
      intent: classification.intent,
      confidence: classification.confidence,
      complexity: classification.complexity,
    });

    let reply: string;

    // Step 2: Handle intent-specific logic
    switch (classification.intent) {
      case "calendar": {
        reply = await handleCalendar(input.message, actions, ctx);
        break;
      }
      case "email": {
        reply = await handleEmail(input.message, actions, ctx);
        break;
      }
      case "task": {
        reply = await handleTask(input.message, actions, ctx);
        break;
      }
      case "question": {
        // Cost-aware routing: simple questions use chat-small, complex use reasoning-large
        reply = await handleQuestion(
          input.message,
          classification.complexity,
          actions,
          ctx,
        );
        break;
      }
      case "reminder": {
        reply = await handleReminder(input.message, actions, ctx);
        break;
      }
      case "expense": {
        reply = await handleExpense(input, actions, ctx);
        break;
      }
    }

    // Step 3: Send the reply back to WhatsApp via ctx.ask
    // ctx.ask on a surface trigger sends the response back to the originating surface
    await step("respond", async () => {
      await ctx.ask({
        surface: "whatsapp",
        message: reply,
      });
    });

    ctx.log.info("Reply sent", {
      intent: classification.intent,
      actionsPerformed: actions.length,
      costUsd: ctx.cost.estimateUsd(),
    });

    return {
      reply,
      intent: classification.intent,
      actions,
    };
  },
});

// --- Intent handlers ---

async function handleCalendar(
  message: string,
  actions: ActionTaken[],
  ctx: any,
): Promise<string> {
  // Parse what the user wants to do with their calendar
  const calendarIntent = await step("calendar-parse", async () => {
    return ctx.llm.json({
      prompt: `Parse this calendar request: "${message}"
               Determine the action and extract relevant details (date, time, title, attendees).`,
      schema: calendarActionSchema,
      capability: "chat-small",
      optimize: "fast",
    });
  });

  if (
    calendarIntent.action === "check-availability" ||
    calendarIntent.action === "list-events"
  ) {
    // Read events from Google Calendar
    const events = await step("calendar-read", async () => {
      return ctx.connectors.google_calendar.listEvents({
        date: calendarIntent.date ?? new Date().toISOString().split("T")[0],
        days: 1,
      });
    });

    const summary = await step("calendar-summarize", async () => {
      return ctx.llm.complete({
        prompt: `Summarize these calendar events for a WhatsApp reply. Be concise and friendly.
                 Events: ${JSON.stringify(events)}
                 User asked: "${message}"`,
        capability: "chat-small",
        optimize: "cheap",
      });
    });

    actions.push({
      type: "calendar-read",
      description: `Checked calendar for ${calendarIntent.date}`,
      result: `Found ${(events as any)?.items?.length ?? 0} events`,
    });

    return summary;
  }

  // Create or modify an event
  const result = await step("calendar-write", async () => {
    return ctx.connectors.google_calendar.createEvent({
      title: calendarIntent.title ?? "Untitled Event",
      date: calendarIntent.date,
      time: calendarIntent.time,
      duration: calendarIntent.duration ?? "30m",
      attendees: calendarIntent.attendees,
    });
  });

  actions.push({
    type: "calendar-create",
    description: `Created event: ${calendarIntent.title}`,
    result: `Scheduled for ${calendarIntent.date} at ${calendarIntent.time}`,
  });

  return `Done! I've created "${calendarIntent.title}" on ${calendarIntent.date} at ${calendarIntent.time}.`;
}

async function handleEmail(
  message: string,
  actions: ActionTaken[],
  ctx: any,
): Promise<string> {
  const emailIntent = await step("email-parse", async () => {
    return ctx.llm.json({
      prompt: `Parse this email request: "${message}"
               Determine the action: read inbox, summarize a thread, draft a reply, or send an email.`,
      schema: emailActionSchema,
      capability: "chat-small",
      optimize: "fast",
    });
  });

  if (emailIntent.action === "read-inbox" || emailIntent.action === "summarize-thread") {
    // Read from Gmail
    const emails = await step("email-fetch", async () => {
      return ctx.connectors.gmail.listMessages({
        query: emailIntent.query ?? "is:unread",
        maxResults: 10,
      });
    });

    const summary = await step("email-summarize", async () => {
      return ctx.llm.complete({
        messages: [
          {
            role: "system",
            content: `Summarize these emails for a WhatsApp reply. Use bullet points.
                      Keep it scannable — the user is reading on their phone.`,
          },
          {
            role: "user",
            content: `Emails: ${JSON.stringify(emails)}\nUser asked: "${message}"`,
          },
        ],
        capability: "chat-small",
        optimize: "cheap",
      });
    });

    actions.push({
      type: "email-read",
      description: "Summarized inbox",
      result: `Processed ${(emails as any)?.messages?.length ?? 0} messages`,
    });

    return summary;
  }

  // Draft or send
  const draft = await step("email-draft", async () => {
    return ctx.llm.complete({
      prompt: `Draft an email based on this request: "${message}"
               To: ${emailIntent.to ?? "(determine from context)"}
               Subject: ${emailIntent.subject ?? "(determine from context)"}
               Keep it professional but natural.`,
      capability: "chat-small",
    });
  });

  if (emailIntent.action === "send-email") {
    await step("email-send", async () => {
      return ctx.connectors.gmail.sendMessage({
        to: emailIntent.to,
        subject: emailIntent.subject,
        body: draft,
      });
    });

    actions.push({
      type: "email-send",
      description: `Sent email to ${emailIntent.to}`,
      result: `Subject: ${emailIntent.subject}`,
    });

    return `Email sent to ${emailIntent.to}!`;
  }

  actions.push({
    type: "email-draft",
    description: "Drafted email reply",
    result: draft.slice(0, 100),
  });

  return `Here's a draft:\n\n${draft}\n\nReply "send" to send it, or tell me what to change.`;
}

async function handleTask(
  message: string,
  actions: ActionTaken[],
  ctx: any,
): Promise<string> {
  const task = await step("task-parse", async () => {
    return ctx.llm.json({
      prompt: `Parse this task from the user's message: "${message}"
               Extract the title, description, priority, optional due date, and project.`,
      schema: taskActionSchema,
      capability: "chat-small",
      optimize: "fast",
    });
  });

  // Create the task in Linear
  await step("task-create", async () => {
    return ctx.connectors.linear.createIssue({
      title: task.title,
      description: task.description,
      priority: task.priority,
      dueDate: task.dueDate,
      project: task.project,
    });
  });

  actions.push({
    type: "task-create",
    description: `Created task: ${task.title}`,
    result: `Priority: ${task.priority}`,
  });

  const dueInfo = task.dueDate ? ` (due ${task.dueDate})` : "";
  return `Task created: *${task.title}*${dueInfo}\nPriority: ${task.priority}`;
}

async function handleQuestion(
  message: string,
  complexity: "simple" | "complex",
  actions: ActionTaken[],
  ctx: any,
): Promise<string> {
  // Cost-aware routing: simple questions use chat-small, complex ones use reasoning-large
  // This is a key Lantern differentiator — automatic big/small model selection
  const capability = complexity === "simple" ? "chat-small" : "reasoning-large";
  const optimize = complexity === "simple" ? "cheap" : "best";

  ctx.log.info("Routing question by complexity", { complexity, capability });

  const answer = await step("answer-question", async () => {
    return ctx.llm.complete({
      messages: [
        {
          role: "system",
          content: `You are a helpful personal assistant responding via WhatsApp.
                    Keep answers concise and mobile-friendly. Use line breaks for readability.
                    If you're unsure, say so rather than guessing.`,
        },
        {
          role: "user",
          content: message,
        },
      ],
      capability,
      optimize,
    });
  });

  actions.push({
    type: "question-answer",
    description: `Answered ${complexity} question`,
    result: `Used ${capability}`,
  });

  return answer;
}

async function handleReminder(
  message: string,
  actions: ActionTaken[],
  ctx: any,
): Promise<string> {
  // Parse the reminder timing
  const reminder = await step("reminder-parse", async () => {
    return ctx.llm.json({
      prompt: `Parse this reminder request: "${message}"
               Extract the reminder message and when to send it.
               Express the delay as a duration string (e.g., "30m", "2h", "1d").
               Also provide a human-readable description of the delay.`,
      schema: reminderSchema,
      capability: "chat-small",
      optimize: "fast",
    });
  });

  // Durable sleep — this is the killer feature.
  // The agent suspends, the process can die, the VM can restart,
  // and the reminder will still fire at the right time.
  await step.sleep("reminder-wait", reminder.delay);

  // After waking up, send the reminder back to WhatsApp
  await step("reminder-send", async () => {
    await ctx.ask({
      surface: "whatsapp",
      message: `Reminder: ${reminder.message}`,
    });
  });

  actions.push({
    type: "reminder-set",
    description: `Set reminder: ${reminder.message}`,
    result: `Will fire in ${reminder.delayDescription}`,
  });

  return `Got it! I'll remind you ${reminder.delayDescription}: "${reminder.message}"`;
}

async function handleExpense(
  input: WhatsAppInput,
  actions: ActionTaken[],
  ctx: any,
): Promise<string> {
  let extractedText = input.message;

  // If there's an image attachment (receipt photo), use vision to extract data
  if (input.attachments?.some((a) => a.type === "image")) {
    const receiptImage = input.attachments.find((a) => a.type === "image")!;

    extractedText = await step("expense-ocr", async () => {
      return ctx.llm.complete({
        messages: [
          {
            role: "system",
            content: "Extract the merchant name, total amount, currency, date, and items from this receipt image.",
          },
          {
            role: "user",
            content: `Image: ${receiptImage.url}\n\nAdditional context from user: ${input.message}`,
          },
        ],
        // Uses vision-small — receipt OCR doesn't need a frontier model
        capability: "vision-small",
        optimize: "cheap",
      });
    });
  }

  // Parse structured expense data
  const expense = await step("expense-parse", async () => {
    return ctx.llm.json({
      prompt: `Extract expense details from this text: "${extractedText}"
               If the user provided context: "${input.message}"
               Today's date: ${new Date().toISOString().split("T")[0]}`,
      schema: expenseSchema,
      capability: "chat-small",
      optimize: "fast",
    });
  });

  // Log to Google Sheets
  await step("expense-log", async () => {
    return ctx.connectors.google_sheets.appendRow({
      spreadsheetId: "expenses-tracker",
      range: "Expenses!A:F",
      values: [
        expense.date,
        expense.merchant,
        expense.category,
        expense.amount,
        expense.currency,
        expense.description,
      ],
    });
  });

  actions.push({
    type: "expense-log",
    description: `Logged expense: ${expense.merchant}`,
    result: `${expense.currency} ${expense.amount} in ${expense.category}`,
  });

  return `Expense logged!\n${expense.merchant}: ${expense.currency} ${expense.amount}\nCategory: ${expense.category}`;
}
