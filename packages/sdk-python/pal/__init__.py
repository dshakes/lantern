"""PAL Python SDK — build production AI agents with durable execution.

Quick start::

    from pal import agent, step

    @agent("hello-world", model="auto")
    async def hello(input: dict, ctx):
        greeting = await step("greet", lambda: ctx.llm.complete(
            prompt=f"Say hello to {input['name']}",
            capability="chat-small",
        ))
        return {"greeting": greeting}
"""

from pal.agent import PalAgent, agent, get_agent, list_agents
from pal.client import PalClient
from pal.errors import (
    PalApiError,
    PalError,
    PalLlmError,
    PalStepError,
    PalTimeoutError,
    PalValidationError,
)
from pal.step import step, step_map, step_race, step_signal, step_sleep
from pal.tools import tool
from pal.types import (
    AgentConfig,
    AgentContext,
    AgentInfo,
    ApprovalRequest,
    AskOptions,
    BuiltContext,
    Capability,
    CompactionConfig,
    ConnectorAction,
    ConnectorInfo,
    ConnectorResult,
    ContextBudget,
    ContextBuildOpts,
    ContextConfig,
    GuardrailConfig,
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
    PrivacyLevel,
    RecallConfig,
    ResourceLimits,
    RetryPolicy,
    RouteStrategy,
    Run,
    RunError,
    RunStatus,
    Session,
    SessionConfig,
    SessionMessage,
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
    # Deprecated aliases (ADR 0032)
    # Agent definition
    "agent",
    "PalAgent",
    "get_agent",
    "list_agents",
    # Step primitives
    "step",
    "step_map",
    "step_race",
    "step_sleep",
    "step_signal",
    # Client
    "PalClient",
    # Tools
    "tool",
    # Errors
    "PalError",
    "PalApiError",
    "PalStepError",
    "PalLlmError",
    "PalTimeoutError",
    "PalValidationError",
    # Types — enums
    "Capability",
    "OptimizeTarget",
    "RunStatus",
    "TriggerKind",
    "IsolationClass",
    "MemoryTier",
    "StreamEventKind",
    "MessageRole",
    "PrivacyLevel",
    "RouteStrategy",
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
    "SessionConfig",
    "GuardrailConfig",
    "Session",
    "SessionMessage",
    "ConnectorAction",
    "ConnectorInfo",
    "ConnectorResult",
    # Types — clients/interfaces
    "LlmClient",
    "ToolClient",
    "MemoryClient",
]
