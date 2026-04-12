# customer-support

Support agent that classifies tickets, requests approval for sensitive actions, drafts and quality-checks responses, gets human sign-off, and builds customer memory over time.

## How to run

```bash
lantern run customer-support --input '{"ticketId": "ZD-4821", "customerMessage": "I was charged twice for my Pro subscription last month. I need a refund for the duplicate charge of $149.", "customerEmail": "jane@acme.co"}'
```

## Example input

```json
{
  "ticketId": "ZD-4821",
  "customerMessage": "I was charged twice for my Pro subscription last month. I need a refund for the duplicate charge of $149.",
  "customerEmail": "jane@acme.co"
}
```

## Input options

| Field | Type | Default | Description |
|---|---|---|---|
| `ticketId` | string | (required) | Zendesk ticket ID |
| `customerMessage` | string | (required) | The customer's message text |
| `customerEmail` | string | (required) | Customer email for memory lookup |

## Example output

```json
{
  "ticketId": "ZD-4821",
  "classification": {
    "category": "refund",
    "severity": "high",
    "sentiment": "negative",
    "refundAmount": 149
  },
  "response": "Hi Jane, I can see the duplicate charge on your account and I'm sorry for the inconvenience. I've processed a refund of $149 which should appear on your statement within 3-5 business days. Your Pro subscription remains active and unaffected. Let me know if you have any questions.",
  "requiresApproval": true,
  "approved": true,
  "humanReviewed": true,
  "resolutionStored": true
}
```

## Agent workflow

1. **Load context** -- Searches vector memory for past interactions with this customer and fetches the ticket from Zendesk
2. **Classify** -- Categorizes the ticket (billing/technical/refund/complaint/feature-request) and assesses severity
3. **Approval gate** -- For refunds > $100 or critical complaints, the agent **durably suspends** until a support lead approves
4. **Draft response** -- Uses `reasoning-small` to write a nuanced, context-aware reply
5. **Quality check** -- Uses `reasoning-large` to catch hallucinations, overpromises, and policy violations
6. **Human review** -- Asks a human on Slack to approve, edit, or reject the response before sending
7. **Send** -- Posts the response to Zendesk and updates ticket status
8. **Update memory** -- Stores the resolution in archival memory so future interactions have context

## Lantern features demonstrated

- **Durable approval gates**: `ctx.approval.request()` suspends the agent until a human approves -- survives process restarts, VM recycling, and infrastructure changes
- **Human-in-the-loop**: `ctx.ask()` sends an interactive prompt to Slack with options, waits for a response, then continues
- **Memory (vector + KV)**: Recall memory stores past interactions searchable by semantic similarity; core KV memory tracks customer profiles across runs
- **Multi-model quality pipeline**: Small model drafts, large model verifies -- catches hallucinations before they reach customers
- **Connector integration**: Zendesk for ticket management, Slack for human review
- **Cost-aware routing**: Classification uses `chat-small` (cheap), drafting uses `reasoning-small` (balanced), verification uses `reasoning-large` (only where accuracy is critical)
