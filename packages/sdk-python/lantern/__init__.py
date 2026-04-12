"""Lantern Python SDK — build production AI agents with durable execution.

Quick start::

    from lantern import agent, step

    @agent("hello-world", model="auto")
    async def hello(input: dict, ctx):
        greeting = await step("greet", lambda: ctx.llm.complete(
            prompt=f"Say hello to {input['name']}",
            capability="chat-small",
        ))
        return {"greeting": greeting}
"""

from lantern.agent import LanternAgent, agent, get_agent, list_agents
from lantern.client import LanternClient
from lantern.errors import (
    LanternApiError,
    LanternError,
    LanternLlmError,
    LanternStepError,
    LanternTimeoutError,
    LanternValidationError,
)
from lantern.step import step, step_map, step_race, step_signal, step_sleep
from lantern.tools import tool
from lantern.types import (
    AgentConfig,
    AgentContext,
    AgentInfo,
    ApprovalRequest,
    AskOptions,
    BuiltContext,
    Capability,
    CompactionConfig,
    ContextBudget,
    ContextBuildOpts,
    ContextConfig,
    IsolationClass,
    IsolationConfig,
    LlmClient,
    LlmJsonOptions,
    LlmOptions,
    LlmStreamOptions,
    MemoryClient,
    MemoryConfig,
    MemoryEntry,
    MemoryTier,
    Message,
    MessageRole,
    NotifyOptions,
    OptimizeTarget,
    OptimizeWeights,
    RecallConfig,
    ResourceLimits,
    RetryPolicy,
    Run,
    RunError,
    RunStatus,
    StepOptions,
    StreamEvent,
    StreamEventKind,
    ToolCallMessage,
    ToolClient,
    ToolDef,
    TriggerKind,
)

__version__ = "0.1.0"

__all__ = [
    # Agent definition
    "agent",
    "LanternAgent",
    "get_agent",
    "list_agents",
    # Step primitives
    "step",
    "step_map",
    "step_race",
    "step_sleep",
    "step_signal",
    # Client
    "LanternClient",
    # Tools
    "tool",
    # Errors
    "LanternError",
    "LanternApiError",
    "LanternStepError",
    "LanternLlmError",
    "LanternTimeoutError",
    "LanternValidationError",
    # Types — enums
    "Capability",
    "OptimizeTarget",
    "RunStatus",
    "TriggerKind",
    "IsolationClass",
    "MemoryTier",
    "StreamEventKind",
    "MessageRole",
    # Types — models
    "AgentConfig",
    "AgentContext",
    "AgentInfo",
    "Message",
    "ToolCallMessage",
    "ToolDef",
    "RetryPolicy",
    "StepOptions",
    "MemoryConfig",
    "ResourceLimits",
    "IsolationConfig",
    "RunError",
    "Run",
    "StreamEvent",
    "MemoryEntry",
    "ApprovalRequest",
    "AskOptions",
    "NotifyOptions",
    "OptimizeWeights",
    "ContextBudget",
    "CompactionConfig",
    "RecallConfig",
    "ContextConfig",
    "ContextBuildOpts",
    "BuiltContext",
    "LlmOptions",
    "LlmJsonOptions",
    "LlmStreamOptions",
    # Types — clients/interfaces
    "LlmClient",
    "ToolClient",
    "MemoryClient",
]
