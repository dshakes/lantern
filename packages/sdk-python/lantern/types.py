"""Type definitions for the Lantern Python SDK.

All public data models use Pydantic v2. Enums use StrEnum (Python 3.11+).
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, AsyncIterator, Awaitable, Callable

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class Capability(StrEnum):
    REASONING_FRONTIER = "reasoning-frontier"
    REASONING_LARGE = "reasoning-large"
    REASONING_SMALL = "reasoning-small"
    CHAT_LARGE = "chat-large"
    CHAT_SMALL = "chat-small"
    CHAT_EDGE = "chat-edge"
    VISION_LARGE = "vision-large"
    VISION_SMALL = "vision-small"
    CODE_LARGE = "code-large"
    CODE_SMALL = "code-small"
    EMBED_LARGE = "embed-large"
    EMBED_SMALL = "embed-small"
    RERANK = "rerank"
    TRANSCRIBE = "transcribe"
    TTS = "tts"
    AUTO = "auto"


class OptimizeTarget(StrEnum):
    CHEAP = "cheap"
    FAST = "fast"
    BEST = "best"
    BALANCED = "balanced"


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    PAUSED = "paused"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TriggerKind(StrEnum):
    API = "api"
    SCHEDULE = "schedule"
    WEBHOOK = "webhook"
    SURFACE = "surface"
    A2A = "a2a"
    CONNECTOR = "connector"
    MANUAL = "manual"


class IsolationClass(StrEnum):
    TRUSTED = "trusted"
    STANDARD = "standard"
    UNTRUSTED = "untrusted"
    HOSTILE = "hostile"
    WASM = "wasm"
    DEVCONTAINER = "devcontainer"


class MemoryTier(StrEnum):
    CORE = "core"
    RECALL = "recall"
    ARCHIVAL = "archival"


class StreamEventKind(StrEnum):
    LLM_DELTA = "llm_delta"
    LLM_COMPLETE = "llm_complete"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    STEP_STARTED = "step_started"
    STEP_COMPLETED = "step_completed"
    STEP_FAILED = "step_failed"
    LOG = "log"
    QUESTION = "question"
    APPROVAL = "approval"
    HEARTBEAT = "heartbeat"
    END = "end"


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class PrivacyLevel(StrEnum):
    STANDARD = "standard"
    PRIVATE = "private"
    AUDIT = "audit"


class RouteStrategy(StrEnum):
    AUTO = "auto"
    CHEAPEST = "cheapest"
    FASTEST = "fastest"
    BEST = "best"
    ROUND_ROBIN = "round-robin"
    FAILOVER = "failover"


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

class ToolCallMessage(BaseModel):
    id: str
    name: str
    arguments: str


class Message(BaseModel):
    role: MessageRole
    content: str
    name: str | None = None
    tool_calls: list[ToolCallMessage] | None = None
    tool_call_id: str | None = None


class ToolDef(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any]


class RetryPolicy(BaseModel):
    max_attempts: int | None = None
    initial_interval: str | None = None
    backoff: float | None = None
    max_interval: str | None = None
    non_retryable: list[str] | None = None


class StepOptions(BaseModel):
    retry: RetryPolicy | None = None
    timeout: str | None = None


class MemoryConfig(BaseModel):
    kind: str  # "vector" | "kv"
    name: str
    scope: str  # "tenant" | "user" | "agent" | "run"
    embedding: Capability | None = None


class ResourceLimits(BaseModel):
    cpu: str | None = None
    memory: str | None = None
    gpu: str | None = None
    timeout: str | None = None
    max_steps: int | None = None
    max_tokens: int | None = None
    max_cost_usd: float | None = None


class IsolationConfig(BaseModel):
    isolation_class: IsolationClass = Field(alias="class", default=IsolationClass.STANDARD)

    model_config = {"populate_by_name": True}


class RunError(BaseModel):
    code: str
    message: str
    step_id: str | None = None


class Run(BaseModel):
    id: str
    tenant_id: str
    agent_id: str
    status: RunStatus
    input: Any = None
    output: Any | None = None
    error: RunError | None = None
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime
    labels: dict[str, str] = Field(default_factory=dict)


class AgentInfo(BaseModel):
    id: str
    name: str
    description: str | None = None
    current_version_id: str | None = None
    created_at: datetime
    labels: dict[str, str] = Field(default_factory=dict)


class StreamEvent(BaseModel):
    run_id: str
    step_id: str | None = None
    seq: int
    ts: datetime
    kind: StreamEventKind
    data: dict[str, Any] = Field(default_factory=dict)


class MemoryEntry(BaseModel):
    id: str
    text: str
    score: float
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class ApprovalRequest(BaseModel):
    reason: str
    approvers: list[str] | None = None
    quorum: int | None = None
    expires_at: str | None = None
    policy: str | None = None


class AskOptions(BaseModel):
    surface: str | None = None
    message: str
    options: list[str] | None = None
    timeout: str | None = None


class NotifyOptions(BaseModel):
    channel: str
    message: str
    attachments: list[Any] | None = None


class OptimizeWeights(BaseModel):
    cost_weight: float
    latency_weight: float
    accuracy_weight: float


class ContextBudget(BaseModel):
    max_input_tokens: int | None = None
    target_input_tokens: int | None = None
    keep_recent_n: int | None = None
    reserve_for_output: int | None = None


class CompactionConfig(BaseModel):
    fresh_for_turns: int | None = None
    compact_for_turns: int | None = None
    sketch_for_turns: int | None = None


class RecallConfig(BaseModel):
    top_k: int | None = None
    threshold: float | None = None


class ContextConfig(BaseModel):
    budget: ContextBudget | None = None
    compaction: CompactionConfig | None = None
    recall: RecallConfig | None = None
    prefix_cache: str | None = None  # "anthropic" | "openai" | "auto"


class ContextBuildOpts(BaseModel):
    system: str
    tools: list[ToolDef] | None = None
    history: list[Message] = Field(default_factory=list)
    new_user_message: str = ""
    resources: list[Any] | None = None
    budget: ContextBudget | None = None


class BuiltContext(BaseModel):
    messages: list[Message]
    tokens_estimate: int = 0
    dropped_count: int = 0
    compacted_count: int = 0
    prefix_cache_tokens: int = 0


# ---------------------------------------------------------------------------
# Session, Guardrail, and Connector config models
# ---------------------------------------------------------------------------


class SessionConfig(BaseModel):
    """Configuration for interactive multi-turn sessions."""

    enabled: bool = True
    max_messages: int | None = None
    idle_timeout: str | None = None
    durable: bool = True


class GuardrailConfig(BaseModel):
    """Configuration for PII blocking, content filtering, and topic restrictions."""

    block_pii: bool = False
    content_filter: bool = False
    blocked_topics: list[str] = Field(default_factory=list)


class SessionMessage(BaseModel):
    """A message in a session."""

    id: str
    session_id: str
    role: MessageRole
    content: str
    created_at: datetime


class Session(BaseModel):
    """A multi-turn interactive session."""

    id: str
    agent_id: str
    tenant_id: str
    status: str = "active"
    messages: list[SessionMessage] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime | None = None


class ConnectorAction(BaseModel):
    """A single action exposed by a connector."""

    id: str
    name: str
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)


class ConnectorInfo(BaseModel):
    """Metadata about an installed connector."""

    id: str
    connector_id: str
    display_name: str
    status: str = "active"
    actions: list[ConnectorAction] = Field(default_factory=list)
    installed_at: datetime | None = None


class ConnectorResult(BaseModel):
    """Result of executing a connector action."""

    success: bool
    data: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


# ---------------------------------------------------------------------------
# LLM option models
# ---------------------------------------------------------------------------

class LlmOptions(BaseModel):
    prompt: str | None = None
    messages: list[Message] | None = None
    capability: Capability | None = None
    optimize: OptimizeTarget | OptimizeWeights | None = None
    tools: list[ToolDef] | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    stop: list[str] | None = None
    no_cache: bool = False


class LlmJsonOptions(LlmOptions):
    schema_def: dict[str, Any] = Field(default_factory=dict, alias="schema")

    model_config = {"populate_by_name": True}


class LlmStreamOptions(LlmOptions):
    pass


# ---------------------------------------------------------------------------
# Agent config model
# ---------------------------------------------------------------------------

class AgentConfig(BaseModel):
    name: str
    version: str = "0.1.0"
    description: str = ""
    model: Capability | str = "auto"
    tools: list[ToolDef] | None = None
    memory: list[MemoryConfig] | None = None
    limits: ResourceLimits | None = None
    isolation: IsolationConfig | None = None
    labels: dict[str, str] = Field(default_factory=dict)
    instructions: str | None = None
    system_prompt: str | None = None
    guardrails: GuardrailConfig | None = None
    privacy: PrivacyLevel | None = None
    session: SessionConfig | None = None
    connectors: list[str] | None = None


# ---------------------------------------------------------------------------
# Protocol / interface types for context objects
# ---------------------------------------------------------------------------

class LlmClient:
    """Interface for LLM operations available in AgentContext."""

    async def complete(self, **kwargs: Any) -> str:
        raise NotImplementedError

    async def json(self, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def stream(self, **kwargs: Any) -> AsyncIterator[str]:
        raise NotImplementedError
        yield  # noqa: unreachable — makes this an async generator

    async def embed(self, texts: list[str], capability: Capability | None = None) -> list[list[float]]:
        raise NotImplementedError


class ToolClient:
    """Interface for built-in tool operations available in AgentContext."""

    class _Web:
        async def search(self, query: str) -> Any:
            raise NotImplementedError

        async def fetch(self, url: str) -> str:
            raise NotImplementedError

    class _Python:
        async def exec(self, code: str) -> Any:
            raise NotImplementedError

    class _Fs:
        async def read(self, path: str) -> str:
            raise NotImplementedError

        async def write(self, path: str, content: str) -> None:
            raise NotImplementedError

    def __init__(self) -> None:
        self.web = self._Web()
        self.python = self._Python()
        self.fs = self._Fs()


class CoreMemory:
    async def get(self, key: str) -> str | None:
        raise NotImplementedError

    async def set(self, key: str, value: str) -> None:
        raise NotImplementedError


class RecallMemory:
    async def search(self, query: str, *, top_k: int | None = None) -> list[MemoryEntry]:
        raise NotImplementedError


class ArchivalMemory:
    async def search(self, query: str, *, top_k: int | None = None) -> list[MemoryEntry]:
        raise NotImplementedError

    async def add(self, text: str, metadata: dict[str, Any] | None = None) -> None:
        raise NotImplementedError


class MemoryClient:
    """Interface for memory operations available in AgentContext."""

    def __init__(self) -> None:
        self.core = CoreMemory()
        self.recall = RecallMemory()
        self.archival = ArchivalMemory()


class Logger:
    def info(self, msg: str, **fields: Any) -> None:
        raise NotImplementedError

    def warn(self, msg: str, **fields: Any) -> None:
        raise NotImplementedError

    def error(self, msg: str, **fields: Any) -> None:
        raise NotImplementedError

    def debug(self, msg: str, **fields: Any) -> None:
        raise NotImplementedError


class CostTracker:
    def estimate_usd(self) -> float:
        raise NotImplementedError

    def tokens_in(self) -> int:
        raise NotImplementedError

    def tokens_out(self) -> int:
        raise NotImplementedError


class ApprovalClient:
    async def request(self, opts: ApprovalRequest) -> None:
        raise NotImplementedError


class ScreenClient:
    async def share(self, *, fps: int | None = None, region: str | None = None, allow_takeover: bool = False) -> None:
        raise NotImplementedError


class ConnectorClient:
    """Dynamic connector access: connector_client["slack"]["send_message"](input)."""

    async def call(self, connector_id: str, action_id: str, input: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def __getitem__(self, connector_id: str) -> "_ConnectorNamespace":
        return _ConnectorNamespace(self, connector_id)


class _ConnectorNamespace:
    def __init__(self, client: ConnectorClient, connector_id: str) -> None:
        self._client = client
        self._connector_id = connector_id

    def __getitem__(self, action_id: str) -> Callable[..., Awaitable[dict[str, Any]]]:
        async def _call(input: dict[str, Any]) -> dict[str, Any]:
            return await self._client.call(self._connector_id, action_id, input)
        return _call


class McpClient:
    """MCP client: mcp("server_id").call("method", params)."""

    def __call__(self, server_id: str) -> "_McpNamespace":
        return _McpNamespace(server_id)


class _McpNamespace:
    def __init__(self, server_id: str) -> None:
        self._server_id = server_id

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        raise NotImplementedError

    async def resource(self, uri: str) -> Any:
        raise NotImplementedError


class A2aClient:
    """A2A client: a2a("agent_card_url").submit(input=..., timeout=...)."""

    def __call__(self, agent_card_url: str) -> "_A2aNamespace":
        return _A2aNamespace(agent_card_url)


class _A2aNamespace:
    def __init__(self, agent_card_url: str) -> None:
        self._url = agent_card_url

    async def submit(self, *, input: Any, timeout: str | None = None) -> Any:
        raise NotImplementedError


class ContextManager:
    def configure(self, opts: ContextConfig) -> None:
        raise NotImplementedError

    def build(self, opts: ContextBuildOpts) -> BuiltContext:
        raise NotImplementedError

    def pin(self, turn: Message) -> None:
        raise NotImplementedError


class AgentContext:
    """Full context object passed to agent run functions."""

    run_id: str
    tenant_id: str
    agent_name: str
    agent_version: str

    llm: LlmClient
    tools: ToolClient
    mem: MemoryClient
    connectors: ConnectorClient
    log: Logger
    cost: CostTracker
    signal: Any  # abort signal

    approval: ApprovalClient
    ask: Callable[[AskOptions], Awaitable[str]]
    notify: Callable[[NotifyOptions], Awaitable[None]]
    screen: ScreenClient

    mcp: McpClient
    a2a: A2aClient
    subagent: Callable[..., Awaitable[Any]]

    context: ContextManager

    def __init__(
        self,
        *,
        run_id: str,
        tenant_id: str,
        agent_name: str,
        agent_version: str,
        llm: LlmClient | None = None,
        tools: ToolClient | None = None,
        mem: MemoryClient | None = None,
        connectors: ConnectorClient | None = None,
        log: Logger | None = None,
        cost: CostTracker | None = None,
        signal: Any = None,
        approval: ApprovalClient | None = None,
        ask: Callable[[AskOptions], Awaitable[str]] | None = None,
        notify: Callable[[NotifyOptions], Awaitable[None]] | None = None,
        screen: ScreenClient | None = None,
        mcp: McpClient | None = None,
        a2a: A2aClient | None = None,
        subagent: Callable[..., Awaitable[Any]] | None = None,
        context: ContextManager | None = None,
    ) -> None:
        self.run_id = run_id
        self.tenant_id = tenant_id
        self.agent_name = agent_name
        self.agent_version = agent_version
        self.llm = llm or LlmClient()
        self.tools = tools or ToolClient()
        self.mem = mem or MemoryClient()
        self.connectors = connectors or ConnectorClient()
        self.log = log or Logger()
        self.cost = cost or CostTracker()
        self.signal = signal
        self.approval = approval or ApprovalClient()
        self.ask = ask or _default_ask
        self.notify = notify or _default_notify
        self.screen = screen or ScreenClient()
        self.mcp = mcp or McpClient()
        self.a2a = a2a or A2aClient()
        self.subagent = subagent or _default_subagent
        self.context = context or ContextManager()

    def now(self) -> datetime:
        return datetime.now()

    def random(self) -> float:
        import random
        return random.random()

    def uuid(self) -> str:
        import uuid
        return str(uuid.uuid4())


async def _default_ask(opts: AskOptions) -> str:
    raise NotImplementedError("ask() is only available in the Lantern runtime")


async def _default_notify(opts: NotifyOptions) -> None:
    raise NotImplementedError("notify() is only available in the Lantern runtime")


async def _default_subagent(agent: str, input: Any) -> Any:
    raise NotImplementedError("subagent() is only available in the Lantern runtime")
