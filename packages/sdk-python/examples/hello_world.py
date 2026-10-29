"""Hello World agent — minimal example of the PAL Python SDK.

Run locally::

    python -m pal.runtime.runner --agent hello-world --input '{"name": "World"}'
"""

from pal import agent, step
from pal.types import AgentContext


@agent("hello-world", model="auto", description="A friendly greeter")
async def hello(input: dict, ctx: AgentContext) -> dict:
    """Greet someone using an LLM."""

    greeting = await step(
        "greet",
        lambda: ctx.llm.complete(
            prompt=f"Say hello to {input['name']} in a friendly way. Keep it to one sentence.",
            capability="chat-small",
        ),
    )

    ctx.log.info(f"Generated greeting for {input['name']}")

    return {"greeting": greeting}
