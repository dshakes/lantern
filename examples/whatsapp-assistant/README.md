# whatsapp-assistant

> **Heads up: this example targets the Lantern SDK in-VM runtime, which is not
> runnable yet.** It uses `agent()` / `step()` with `ctx.llm`, `ctx.tools`,
> `ctx.connectors`, and/or `ctx.mem` — the in-microVM tool runtime, where
> `exec_tool` currently returns `TOOL_STATUS_UNAVAILABLE` (see the repo
> `CLAUDE.md`). It illustrates the intended SDK shape; it does **not** execute
> against the running stack today. For agents that run right now against the
> live control-plane, see [`examples/quickstart/`](../quickstart/).


Personal WhatsApp agent that manages your calendar, email, tasks, reminders, and expenses through natural conversation.

## How to run

This agent is triggered automatically when you message it on WhatsApp. To test locally:

```bash
lantern run whatsapp-assistant --input '{"message": "What do I have on my calendar tomorrow?"}'
```

```bash
lantern run whatsapp-assistant --input '{"message": "Remind me to call the dentist in 2 hours"}'
```

```bash
lantern run whatsapp-assistant --input '{"message": "Log this receipt", "attachments": [{"type": "image", "url": "https://example.com/receipt.jpg", "mimeType": "image/jpeg"}]}'
```

## Example input

```json
{
  "message": "Schedule a meeting with Sarah tomorrow at 2pm for 30 minutes to discuss the Q2 roadmap"
}
```

## Input options

| Field | Type | Default | Description |
|---|---|---|---|
| `message` | string | (required) | The WhatsApp message text |
| `attachments` | Attachment[] | `[]` | Optional image/audio/document attachments |

## Supported intents

| Intent | Example message | Connectors used |
|---|---|---|
| **calendar** | "What's on my calendar today?" | Google Calendar |
| **email** | "Summarize my unread emails" | Gmail |
| **task** | "Add a task: finish the proposal by Friday" | Linear |
| **question** | "What's the capital of Bhutan?" | None (LLM only) |
| **reminder** | "Remind me to call Mom in 2 hours" | None (durable sleep) |
| **expense** | "Log this receipt" + photo | Google Sheets, Vision |

## Example output

```json
{
  "reply": "Done! I've created \"Q2 Roadmap Discussion with Sarah\" on 2026-04-13 at 14:00.",
  "intent": "calendar",
  "actions": [
    {
      "type": "calendar-create",
      "description": "Created event: Q2 Roadmap Discussion with Sarah",
      "result": "Scheduled for 2026-04-13 at 14:00"
    }
  ]
}
```

## Lantern features demonstrated

- **Omnichannel surfaces**: Triggered directly from WhatsApp messages; replies go back to WhatsApp via `ctx.ask`
- **Durable sleep**: Reminders use `step.sleep()` which survives process restarts and VM recycling -- the reminder fires even if the underlying infrastructure changes
- **Cost-aware routing**: Simple questions use `chat-small` with `optimize: "cheap"`, complex questions use `reasoning-large` with `optimize: "best"` -- automatic big/small model selection
- **Connector ecosystem**: Integrates with Google Calendar, Gmail, Linear, and Google Sheets out of the box
- **Vision model routing**: Receipt photos are processed with `vision-small` -- cheapest model that can do OCR
- **Personal workflows**: Runs on YOUR calendar, YOUR email, YOUR task list -- authenticated via your personal connector credentials
