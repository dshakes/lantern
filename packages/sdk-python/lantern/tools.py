"""Built-in tool definitions for the Lantern Python SDK.

These mirror the tool definitions in the TypeScript SDK.  They are used in
two ways:

1. Passed to ``@agent(tools=[...])`` so the LLM knows what tools are
   available.
2. The runtime resolves tool calls to the corresponding Lantern built-in
   implementations (web search, code execution, filesystem, browser).

Usage::

    from lantern.tools import tool

    @agent("researcher", tools=[tool.web, tool.python])
    async def researcher(input: dict, ctx: AgentContext) -> dict:
        results = await ctx.tools.web.search(input["query"])
        ...
"""

from __future__ import annotations

from lantern.types import ToolDef


class _ToolRegistry:
    """Namespace for built-in Lantern tool definitions."""

    @property
    def web(self) -> ToolDef:
        """Web search and fetch tool."""
        return ToolDef(
            name="lantern.web",
            description="Web search and fetch. Search the web or fetch a URL.",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["search", "fetch"]},
                    "query": {"type": "string", "description": "Search query (for search)"},
                    "url": {"type": "string", "description": "URL to fetch (for fetch)"},
                },
                "required": ["action"],
            },
        )

    @property
    def python(self) -> ToolDef:
        """Execute Python code in a sandboxed environment."""
        return ToolDef(
            name="lantern.python",
            description="Execute Python code in a sandboxed environment.",
            parameters={
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to execute"},
                    "packages": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Pip packages to install before execution",
                    },
                },
                "required": ["code"],
            },
        )

    @property
    def fs(self) -> ToolDef:
        """Read and write files in the agent's scoped workspace."""
        return ToolDef(
            name="lantern.fs",
            description="Read and write files in the agent's scoped workspace.",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["read", "write", "list"]},
                    "path": {"type": "string"},
                    "content": {"type": "string", "description": "Content to write (for write)"},
                },
                "required": ["action", "path"],
            },
        )

    @property
    def browser(self) -> ToolDef:
        """Control a headless browser for web automation."""
        return ToolDef(
            name="lantern.browser",
            description="Control a headless browser for web automation.",
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["navigate", "click", "type", "screenshot", "extract"],
                    },
                    "url": {"type": "string"},
                    "selector": {"type": "string"},
                    "text": {"type": "string"},
                },
                "required": ["action"],
            },
        )

    def all(self) -> list[ToolDef]:
        """Return all built-in tool definitions."""
        return [self.web, self.python, self.fs, self.browser]


tool = _ToolRegistry()
