# Visual Workflow Builder — No-Code Design Surface

> **What this is:** the drag-and-drop canvas that lets non-technical users build production-grade agent workflows without writing a single line of code, while staying interoperable with the SDK.
>
> **Why it matters:** the wrong way to build "no-code" is to make it a separate product that compiles to a separate runtime. The right way is to make the canvas and the code two views of the same artifact.

---

## Goals

1. **Visual is first-class, not a toy.** A workflow built on the canvas runs on the exact same workflow engine as one built with the SDK. Same durability, same observability, same isolation.
2. **Bidirectional with code.** A workflow can be built visually, exported to TypeScript, edited in code, and re-imported visually as long as it stays within the canvas-buildable subset. Anything outside the subset (custom JS, complex control flow) shows up as a "code block" node on the canvas.
3. **Real types everywhere.** Every input field on every node is typed by the connector or capability schema. The canvas knows what fields are available because it has the full JSON schema.
4. **Live test runs from the canvas.** Click "Test run", provide inputs, and watch the run light up node-by-node with real values flowing through edges.
5. **Templates for the 80%.** A template gallery with 50+ starter workflows for common personal and team use cases.
6. **Mobile-friendly** for view + start; desktop for edit.

---

## Anatomy of the canvas

Built on **React Flow** (TypeScript) inside `apps/web/builder`. State managed by Zustand; persistence over the gRPC client to `control-plane`. Validation via Zod schemas generated from the connector and capability registries.

Node types:

| Node | Purpose | Examples |
|---|---|---|
| **Trigger** | Starts the workflow | Schedule, Webhook, Manual button, Connector trigger ("New email in Gmail"), Surface trigger ("Slack mention") |
| **Action** | Calls a connector action | "Send email via Gmail", "Create issue in Linear", "Post to Slack" |
| **AI step** | Calls the model router with a prompt template | "Summarize this email", "Extract structured data" |
| **Agent step** | Invokes a sub-agent | "Run research-agent on this query" |
| **Tool step** | Calls a built-in tool | Web search, Python sandbox, file ops |
| **Condition** | Branches on a typed expression | `email.subject contains "urgent"` |
| **Loop** | Iterates over a list | `for each item in extracted_items` |
| **Parallel** | Fans out to multiple children | `do A, B, C in parallel` |
| **Approval** | Pauses for human approval | "Wait for owner to approve" |
| **Wait** | Durable sleep / wait for date / wait for signal | "Wait until tomorrow 9am" |
| **Code block** | Free-form TypeScript escape hatch | Any logic the canvas can't express |
| **End / Return** | Final output | `return summary` |

Edges carry **typed values**. The canvas validates that the output type of source matches the expected input type of target. Mismatches show as red squiggles inline.

### Example workflow on the canvas

```
┌────────────────────────┐
│ Trigger                │
│  Gmail · new_email     │
│  query: "from:boss"    │
└─────────┬──────────────┘
          │  email
          ▼
┌────────────────────────┐
│ Condition              │
│  email.subject         │
│  contains "ASAP"       │
└────┬────────┬──────────┘
     │ yes    │ no
     ▼        ▼
 ┌─────────┐ ┌────────────────┐
 │ AI step │ │ Action         │
 │ classify│ │ Slack · post   │
 │ urgency │ │ #notifications │
 └────┬────┘ └────────────────┘
      │  category
      ▼
 ┌────────────────────────┐
 │ Approval               │
 │  if category == "ship" │
 │  ask owner             │
 └─────────┬──────────────┘
           │ approved
           ▼
 ┌────────────────────────┐
 │ Action                 │
 │  Linear · create_issue │
 │  title: ${ai.title}    │
 └─────────┬──────────────┘
           ▼
       ┌───────┐
       │  End  │
       └───────┘
```

---

## Compilation: canvas → bundle

When the user hits **Save**, the canvas serializes to a `canvas.json`, then compiles it into a regular Lantern agent bundle:

```
canvas.json ──► compiler ──► src/index.ts (generated TypeScript)
                                   │
                                   ▼
                          lantern build ──► bundle.tar.zst
```

The generated TypeScript looks like the SDK code an engineer would write by hand:

```ts
// generated from canvas.json — do not edit by hand
import { agent, step, tool } from "@lantern/sdk";
import { gmail, slack, linear } from "@lantern/connectors";

export default agent({
  name: "boss-email-triage",
  version: "0.1.0",
  triggers: [{ kind: "connector", connector: "gmail", trigger: "new_email", input: { query: "from:boss" } }],

  async run({ trigger, ctx }) {
    const email = trigger.payload;

    if (!email.subject.toLowerCase().includes("asap")) {
      return await step("notify", () =>
        ctx.connectors.slack.post({ channel: "#notifications", text: email.subject })
      );
    }

    const classification = await step("classify", () =>
      ctx.llm.json({ capability: "reasoning-small", schema: ClassifySchema, prompt: classifyPrompt(email) })
    );

    if (classification.category === "ship") {
      await ctx.approval.request({
        reason: `Ship task from boss: ${classification.title}`,
        approvers: ["user:owner"],
      });
    }

    return await step("create-issue", () =>
      ctx.connectors.linear.create_issue({
        title: classification.title,
        description: classification.summary,
      })
    );
  },
});
```

The compiler also produces an `agent.yaml` from the canvas metadata. The result is a bundle indistinguishable from one written by hand.

---

## Round-trip: code → canvas

The reverse direction is harder but supported for the canvas-buildable subset:

1. The compiler can parse generated bundles back into a canvas representation losslessly (because we wrote them).
2. For hand-written bundles, a static analysis pass walks the AST, recognizes `step()`, `step.map`, `step.race`, `ctx.connectors.*`, `ctx.approval.*`, and `if/else` patterns, and reconstructs a canvas where possible.
3. Anything outside the recognizable subset (custom JS, complex control flow, dynamic imports) becomes a single **Code Block** node on the canvas, with the original code preserved verbatim. The user can edit it as code; the rest of the canvas keeps working.

This means: **engineers and non-technical users can collaborate on the same workflow.** A non-technical user can build the skeleton visually; an engineer can drop into a Code Block for the tricky bit; the non-technical user can keep editing the rest.

---

## Live test runs

The canvas can launch a test run with sample inputs. The control plane creates a real run on the workflow engine, but tagged as `mode: "test"` so it's:
- Free (no billing)
- Visible only to the editor
- Allowed to skip rate-limit checks on connectors
- Auto-deleted after 24h

As the run progresses, the canvas highlights the current node, paints completed nodes green and failed nodes red, and shows real input/output values inline on each edge. Click any node to see the full payload.

This is the killer feature for non-technical users: **instant feedback that their workflow does what they think it does.**

---

## Templates

A template is a saved canvas JSON plus metadata. The template gallery at `/templates` shows them organized by:
- **Use case** — "Personal productivity", "Customer support", "Sales follow-up", "Devops", "Research", "Content creation"
- **Apps used** — "Gmail + Slack", "Linear + GitHub", "Notion + Drive"
- **Difficulty** — "Beginner", "Intermediate", "Advanced"

The 50 launch templates include staples like:
- "When I get an email from my boss, classify urgency and ping me on Slack"
- "Every Monday at 9am, summarize last week's GitHub PRs and post to Slack"
- "When a Stripe payment fails, find the customer in HubSpot and create a Linear issue"
- "Watch a Notion database for new entries, draft a tweet, ask me to approve, then post"
- "When someone messages my Telegram bot, search my Notion for an answer, reply"
- "When a calendar event starts, transcribe via Whisper, summarize action items, email participants"
- "Every morning, read my unread Gmail, prioritize, draft replies for me to approve in iMessage"

Cloning a template into a personal workflow is one tap.

---

## Permissioning + safety on the canvas

Non-technical users will accidentally build workflows that send 1000 emails or rack up $50 in OpenAI calls in a minute. The canvas defends them:

- **Spending ceiling per workflow** — defaults to $1 per run unless raised
- **Action budget per run** — defaults to 50 connector actions per run
- **Approval gate auto-inserted** when an action targets > 5 recipients in a single call
- **Dry-run mode** — schedule the workflow but every action is logged instead of executed
- **Replayable history** — every run is replayable from any step with modified inputs

These defaults can be overridden, but only after confirmation.

---

## What's intentionally NOT in the canvas

- **No general programming.** If you need a `while` loop with a complex condition, drop into a Code Block. The canvas isn't a programming language.
- **No custom UIs.** The canvas builds workflows, not apps. If users want a UI, they build a Slack/iMessage interaction via Control Surfaces.
- **No version control.** Bundles are versioned by the platform; the canvas exposes "history" and "diff" but not branching/merging. Engineers who want git can `lantern pull` to a repo and use git there.

---

## Implementation notes

- `apps/web/builder/` — React Flow + Zustand + Zod
- `services/control-plane/canvas_compiler.go` — canvas.json → TypeScript → bundle
- `packages/canvas-types` — shared types between canvas and compiler
- `apps/web/builder/templates/` — the 50 launch templates as canvas.json files
