"""deepagents agent running on a PAL microVM sandbox.

Requires: pip install "./packages/sdk-python[deepagents]"  (from a repo checkout)
Env: LANTERN_API_URL, LANTERN_API_KEY

Demonstrates:
- the PAL sandbox backend (execute + derived filesystem tools in a
  Firecracker microVM, egress/quota enforced by the PAL runtime)
- a composite backend: `/memories/` outlives the VM (LangGraph store),
  everything else lives inside the sandbox
- rubric-gated self-evaluation before the agent answers
"""

from deepagents import create_deep_agent
from deepagents.backends.composite import CompositeBackend
from deepagents.backends.store import StoreBackend
from deepagents.middleware.rubric import RubricMiddleware
from langgraph.store.memory import InMemoryStore

from pal.integrations.deepagents_sandbox import PalSandbox


def main() -> None:
    with PalSandbox.create(
        image_digest="sha256:REPLACE_WITH_AGENT_IMAGE",
        limits={"cpu": 1, "memory_mb": 1024},
        egressRules=[{"pattern": "pypi.org", "http_methods": ["GET"]}],
    ) as sandbox:
        backend = CompositeBackend(
            default=sandbox,
            routes={"/memories/": StoreBackend(store=InMemoryStore())},
        )
        agent = create_deep_agent(
            backend=backend,
            middleware=[
                RubricMiddleware(
                    model="anthropic:claude-sonnet-4-6",
                    max_iterations=2,
                ),
            ],
            system_prompt=(
                "You have a sandboxed shell and filesystem. Persist anything "
                "worth keeping across sessions under /memories/."
            ),
        )
        result = agent.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": "Clone and summarize the repo layout of httpx, then save the summary to /memories/httpx.md",
                    }
                ]
            }
        )
        print(result["messages"][-1].content)


if __name__ == "__main__":
    main()
