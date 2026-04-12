"""Tests for lantern.agent — decorator and class-based agent definition."""

from __future__ import annotations

import pytest

from lantern.agent import (
    LanternAgent,
    RegisteredAgent,
    _registry,
    agent,
    get_agent,
    list_agents,
)
from lantern.errors import LanternValidationError
from lantern.types import AgentContext


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ctx() -> AgentContext:
    return AgentContext(
        run_id="run-test",
        tenant_id="tenant-test",
        agent_name="test",
        agent_version="0.1.0",
    )


# ---------------------------------------------------------------------------
# @agent decorator tests
# ---------------------------------------------------------------------------

class TestAgentDecorator:
    """Tests for the @agent decorator."""

    def test_creates_registered_agent(self):
        @agent("test-decorator-agent")
        async def my_agent(input: dict, ctx: AgentContext) -> dict:
            return {"ok": True}

        assert isinstance(my_agent, RegisteredAgent)
        assert my_agent.config.name == "test-decorator-agent"
        assert my_agent.config.version == "0.1.0"

    def test_preserves_config_fields(self):
        @agent(
            "test-config-agent",
            version="2.0.0",
            model="reasoning-large",
            description="A test agent",
            labels={"env": "test", "team": "ml"},
        )
        async def configured_agent(input: dict, ctx: AgentContext) -> dict:
            return input

        assert configured_agent.config.version == "2.0.0"
        assert configured_agent.config.model == "reasoning-large"
        assert configured_agent.config.description == "A test agent"
        assert configured_agent.config.labels == {"env": "test", "team": "ml"}

    def test_registers_in_global_registry(self):
        @agent("test-registry-agent")
        async def reg_agent(input: dict, ctx: AgentContext) -> dict:
            return {}

        found = get_agent("test-registry-agent")
        assert found is reg_agent

    async def test_run_delegates_to_function(self):
        @agent("test-run-agent")
        async def run_agent(input: dict, ctx: AgentContext) -> dict:
            return {"echo": input.get("msg")}

        result = await run_agent.run({"msg": "hello"}, _make_ctx())
        assert result == {"echo": "hello"}


# ---------------------------------------------------------------------------
# Name validation tests
# ---------------------------------------------------------------------------

class TestNameValidation:
    """Tests for agent name validation."""

    def test_rejects_empty_name(self):
        with pytest.raises(LanternValidationError, match="Agent name must match"):
            @agent("")
            async def empty_agent(input: dict, ctx: AgentContext) -> dict:
                return {}

    def test_rejects_uppercase(self):
        with pytest.raises(LanternValidationError, match="Agent name must match"):
            @agent("MyAgent")
            async def upper_agent(input: dict, ctx: AgentContext) -> dict:
                return {}

    def test_rejects_spaces(self):
        with pytest.raises(LanternValidationError, match="Agent name must match"):
            @agent("my agent")
            async def space_agent(input: dict, ctx: AgentContext) -> dict:
                return {}

    def test_rejects_underscores(self):
        with pytest.raises(LanternValidationError, match="Agent name must match"):
            @agent("my_agent")
            async def underscore_agent(input: dict, ctx: AgentContext) -> dict:
                return {}

    def test_rejects_too_long(self):
        with pytest.raises(LanternValidationError, match="Agent name must match"):
            @agent("a" * 64)
            async def long_agent(input: dict, ctx: AgentContext) -> dict:
                return {}

    def test_accepts_63_chars(self):
        name = "a" * 63

        @agent(name)
        async def long_ok_agent(input: dict, ctx: AgentContext) -> dict:
            return {}

        assert long_ok_agent.config.name == name

    def test_accepts_hyphens_and_numbers(self):
        @agent("my-agent-v2")
        async def hn_agent(input: dict, ctx: AgentContext) -> dict:
            return {}

        assert hn_agent.config.name == "my-agent-v2"


# ---------------------------------------------------------------------------
# Class-based agent tests
# ---------------------------------------------------------------------------

class TestClassBasedAgent:
    """Tests for LanternAgent subclasses."""

    def test_class_agent_registers(self):
        class MyClassAgent(LanternAgent):
            name = "test-class-agent"
            version = "1.0.0"
            description = "Class-based test"

            async def run(self, input: dict, ctx: AgentContext) -> dict:
                return {"class": True}

        found = get_agent("test-class-agent")
        assert found is not None
        assert found.config.name == "test-class-agent"
        assert found.config.version == "1.0.0"

    async def test_class_agent_run(self):
        class RunClassAgent(LanternAgent):
            name = "test-class-run-agent"

            async def run(self, input: dict, ctx: AgentContext) -> dict:
                return {"input_keys": list(input.keys())}

        found = get_agent("test-class-run-agent")
        assert found is not None
        result = await found.run({"a": 1, "b": 2}, _make_ctx())
        assert set(result["input_keys"]) == {"a", "b"}

    def test_class_agent_validates_name(self):
        with pytest.raises(LanternValidationError):
            class BadNameAgent(LanternAgent):
                name = "Bad Name"

                async def run(self, input: dict, ctx: AgentContext) -> dict:
                    return {}


# ---------------------------------------------------------------------------
# Registry tests
# ---------------------------------------------------------------------------

class TestRegistry:
    """Tests for the global agent registry."""

    def test_list_agents_returns_all(self):
        agents = list_agents()
        # We registered several agents in the tests above
        assert len(agents) > 0
        names = {a.config.name for a in agents}
        assert "test-decorator-agent" in names

    def test_get_nonexistent_returns_none(self):
        assert get_agent("nonexistent-agent-xyz") is None
