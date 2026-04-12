"""Agent definition — decorator and class-based patterns (Google ADK-inspired).

Usage (decorator)::

    @agent("my-agent", model="auto")
    async def my_agent(input: dict, ctx: AgentContext) -> dict:
        result = await step("greet", lambda: ctx.llm.complete(prompt="Hello"))
        return {"greeting": result}

Usage (class-based)::

    class MyAgent(LanternAgent):
        name = "my-agent"
        model = "auto"

        async def run(self, input: dict, ctx: AgentContext) -> dict:
            ...
"""

from __future__ import annotations

import re
from typing import Any, Awaitable, Callable

from lantern.errors import LanternValidationError
from lantern.types import (
    AgentConfig,
    AgentContext,
    Capability,
    IsolationClass,
    IsolationConfig,
    MemoryConfig,
    ResourceLimits,
    ToolDef,
)

_NAME_RE = re.compile(r"^[a-z0-9-]{1,63}$")


def _validate_name(name: str) -> None:
    if not _NAME_RE.match(name):
        raise LanternValidationError(
            f'Agent name must match [a-z0-9-]{{1,63}}, got: "{name}"'
        )


# ---------------------------------------------------------------------------
# Registered agent — the object returned by the @agent decorator
# ---------------------------------------------------------------------------

class RegisteredAgent:
    """Wrapper around a user-defined agent function plus its config.

    This is the object stored in the module-level registry and loaded by the
    runner at startup.
    """

    def __init__(
        self,
        config: AgentConfig,
        fn: Callable[[dict[str, Any], AgentContext], Awaitable[Any]],
    ) -> None:
        self.config = config
        self._fn = fn
        # Preserve the original function metadata for introspection
        self.__name__ = getattr(fn, "__name__", config.name)
        self.__doc__ = getattr(fn, "__doc__", None)

    async def run(self, input: dict[str, Any], ctx: AgentContext) -> Any:
        return await self._fn(input, ctx)

    def __repr__(self) -> str:
        return f"<RegisteredAgent name={self.config.name!r} version={self.config.version!r}>"


# ---------------------------------------------------------------------------
# Module-level registry — simple dict mapping name -> RegisteredAgent
# ---------------------------------------------------------------------------

_registry: dict[str, RegisteredAgent] = {}


def get_agent(name: str) -> RegisteredAgent | None:
    """Retrieve a registered agent by name."""
    return _registry.get(name)


def list_agents() -> list[RegisteredAgent]:
    """Return all registered agents."""
    return list(_registry.values())


# ---------------------------------------------------------------------------
# @agent decorator
# ---------------------------------------------------------------------------

def agent(
    name: str,
    *,
    version: str = "0.1.0",
    model: Capability | str = "auto",
    description: str = "",
    tools: list[ToolDef] | None = None,
    memory: list[MemoryConfig] | None = None,
    limits: ResourceLimits | dict[str, Any] | None = None,
    isolation: IsolationConfig | dict[str, Any] | None = None,
    labels: dict[str, str] | None = None,
) -> Callable[
    [Callable[[dict[str, Any], AgentContext], Awaitable[Any]]],
    RegisteredAgent,
]:
    """Decorator that creates and registers a Lantern agent.

    Parameters
    ----------
    name:
        DNS-compatible identifier ([a-z0-9-]{1,63}).
    version:
        Semver string, defaults to ``"0.1.0"``.
    model:
        Default model capability for LLM calls.  ``"auto"`` lets the
        model router decide.
    description:
        Human-readable description.
    tools:
        Built-in tool definitions to make available.
    memory:
        Memory configurations for the agent.
    limits:
        Resource limits (CPU, memory, GPU, timeout, cost, tokens, steps).
    isolation:
        Isolation class for the agent's runtime environment.
    labels:
        Arbitrary key-value labels.

    Returns a :class:`RegisteredAgent` instance that wraps the decorated
    function and holds its :class:`AgentConfig`.
    """
    _validate_name(name)

    # Coerce convenience dicts into typed models
    if isinstance(limits, dict):
        limits = ResourceLimits(**limits)
    if isinstance(isolation, dict):
        isolation = IsolationConfig(**isolation)

    config = AgentConfig(
        name=name,
        version=version,
        model=model,
        description=description,
        tools=tools,
        memory=memory,
        limits=limits,
        isolation=isolation,
        labels=labels or {},
    )

    def decorator(
        fn: Callable[[dict[str, Any], AgentContext], Awaitable[Any]],
    ) -> RegisteredAgent:
        if not callable(fn):
            raise LanternValidationError("Agent must wrap a callable")

        registered = RegisteredAgent(config, fn)
        _registry[name] = registered
        return registered

    return decorator


# ---------------------------------------------------------------------------
# Class-based agent (Google ADK style)
# ---------------------------------------------------------------------------

class LanternAgent:
    """Base class for class-based agent definitions.

    Subclass and override ``run``. Class attributes map to ``AgentConfig``
    fields::

        class Greeter(LanternAgent):
            name = "greeter"
            version = "1.0.0"
            model = "chat-small"
            description = "A friendly greeter"

            async def run(self, input: dict, ctx: AgentContext) -> dict:
                greeting = await ctx.llm.complete(prompt=f"Hello {input['name']}")
                return {"greeting": greeting}
    """

    name: str = ""
    version: str = "0.1.0"
    model: Capability | str = "auto"
    description: str = ""
    tools: list[ToolDef] | None = None
    memory: list[MemoryConfig] | None = None
    limits: ResourceLimits | None = None
    isolation: IsolationConfig | None = None
    labels: dict[str, str] = {}

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        # Only register concrete subclasses that define a name
        if cls.name:
            _validate_name(cls.name)
            config = AgentConfig(
                name=cls.name,
                version=cls.version,
                model=cls.model,
                description=cls.description,
                tools=cls.tools,
                memory=cls.memory,
                limits=cls.limits,
                isolation=cls.isolation,
                labels=cls.labels or {},
            )

            # Create a RegisteredAgent that delegates to an instance of the class
            instance = cls()
            registered = RegisteredAgent(config, instance._dispatch)
            _registry[cls.name] = registered
            # Store a reference so the class can be used directly too
            cls._registered = registered  # type: ignore[attr-defined]

    async def _dispatch(self, input: dict[str, Any], ctx: AgentContext) -> Any:
        return await self.run(input, ctx)

    async def run(self, input: dict[str, Any], ctx: AgentContext) -> Any:
        raise NotImplementedError("Subclass must implement run()")

    async def init(self) -> None:
        """Optional init hook called once before the first run."""
