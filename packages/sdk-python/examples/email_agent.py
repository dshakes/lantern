"""Email triage agent -- demonstrates sessions, connectors, guardrails, and smart routing.

This agent connects to Gmail, triages incoming email, drafts replies using
an LLM, and optionally sends them after human approval.

Run locally::

    export LANTERN_API_KEY="your-key"
    python -m lantern.runtime.runner --agent email-triage --input '{"mode": "triage"}'

Or use in a session (interactive multi-turn)::

    from lantern import LanternClient
    import asyncio

    async def main():
        async with LanternClient() as client:
            session = await client.sessions.create(agent="email-triage")
            reply = await client.sessions.send_message(
                session.id, content="Summarize my unread emails"
            )
            print(reply.content)

    asyncio.run(main())
"""

from lantern import agent, step, step_map, step_sleep
from lantern.types import (
    AgentContext,
    GuardrailConfig,
    MemoryConfig,
    RetryPolicy,
    SessionConfig,
)


@agent(
    "email-triage",
    model="auto",
    description="AI email assistant -- triages, summarizes, and drafts replies",
    memory=[
        MemoryConfig(kind="kv", name="contacts", scope="user"),
        MemoryConfig(kind="vector", name="email-history", scope="user", embedding="embed-large"),
    ],
    limits={
        "timeout": "5m",
        "max_steps": 30,
        "max_cost_usd": 0.50,
    },
)
async def email_triage(input: dict, ctx: AgentContext) -> dict:
    """Triage unread emails, summarize them, and draft replies."""

    mode: str = input.get("mode", "triage")
    max_emails: int = input.get("max_emails", 10)

    ctx.log.info(f"Starting email triage in {mode} mode", max_emails=max_emails)

    # ---- Step 1: Fetch unread emails via the Gmail connector ----
    emails = await step(
        "fetch-emails",
        lambda: ctx.connectors["gmail"]["list_unread"]({"max_results": max_emails}),
        retry=RetryPolicy(max_attempts=2, initial_interval="1s"),
    )

    email_list: list[dict] = emails.get("emails", [])
    if not email_list:
        ctx.log.info("No unread emails found")
        return {"summary": "Inbox zero -- no unread emails.", "count": 0, "actions": []}

    ctx.log.info(f"Found {len(email_list)} unread emails")

    # ---- Step 2: Classify each email (parallel, bounded concurrency) ----
    async def classify_email(email: dict, index: int) -> dict:
        classification = await ctx.llm.json(
            prompt=(
                f"Classify this email and suggest an action.\n\n"
                f"From: {email.get('from', 'unknown')}\n"
                f"Subject: {email.get('subject', '(no subject)')}\n"
                f"Body: {email.get('body', '')[:1000]}\n\n"
                f"Return JSON with: category (important|fyi|spam|action-required), "
                f"priority (high|medium|low), one_line_summary (string), "
                f"suggested_action (reply|archive|forward|flag)"
            ),
            capability="chat-small",
            schema={
                "type": "object",
                "properties": {
                    "category": {"type": "string"},
                    "priority": {"type": "string"},
                    "one_line_summary": {"type": "string"},
                    "suggested_action": {"type": "string"},
                },
            },
        )
        return {**email, **classification}

    classified = await step_map(
        "classify",
        email_list,
        classify_email,
        concurrency=5,
    )

    # ---- Step 3: Draft replies for action-required emails ----
    action_required = [e for e in classified if e.get("suggested_action") == "reply"]

    drafts: list[dict] = []
    if action_required:
        async def draft_reply(email: dict, index: int) -> dict:
            reply_text = await ctx.llm.complete(
                prompt=(
                    f"Draft a professional, concise reply to this email.\n\n"
                    f"From: {email.get('from', 'unknown')}\n"
                    f"Subject: {email.get('subject', '')}\n"
                    f"Body: {email.get('body', '')[:2000]}\n\n"
                    f"Keep the reply under 150 words. Be helpful and direct."
                ),
                capability="chat-large",
                max_tokens=300,
            )
            return {
                "to": email.get("from", ""),
                "subject": f"Re: {email.get('subject', '')}",
                "draft": reply_text,
                "original_id": email.get("id", ""),
            }

        drafts = await step_map(
            "draft-replies",
            action_required,
            draft_reply,
            concurrency=3,
        )

        ctx.log.info(f"Drafted {len(drafts)} replies")

    # ---- Step 4: Store context in memory for future sessions ----
    summary_text = "\n".join(
        f"- [{e.get('priority', '?')}] {e.get('one_line_summary', e.get('subject', ''))}"
        for e in classified
    )

    await step(
        "store-context",
        lambda: ctx.mem.archival.add(
            f"Email triage summary ({len(classified)} emails):\n{summary_text}",
            metadata={"email_count": len(classified), "mode": mode},
        ),
    )

    # ---- Step 5: Build the response ----
    executive_summary = await step(
        "summarize",
        lambda: ctx.llm.complete(
            prompt=(
                f"Write a 2-3 sentence executive summary of these emails:\n\n"
                f"{summary_text}\n\n"
                f"Focus on what needs attention."
            ),
            capability="chat-small",
            max_tokens=150,
        ),
    )

    ctx.log.info("Email triage complete", cost=ctx.cost.estimate_usd())

    return {
        "summary": executive_summary,
        "count": len(classified),
        "by_priority": {
            "high": len([e for e in classified if e.get("priority") == "high"]),
            "medium": len([e for e in classified if e.get("priority") == "medium"]),
            "low": len([e for e in classified if e.get("priority") == "low"]),
        },
        "actions": [
            {
                "email_id": e.get("id"),
                "action": e.get("suggested_action"),
                "summary": e.get("one_line_summary"),
            }
            for e in classified
        ],
        "drafts": drafts,
        "cost_usd": ctx.cost.estimate_usd(),
    }
