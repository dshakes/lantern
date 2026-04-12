"""Build the full AgentContext for production and dev modes."""

from __future__ import annotations

import logging
import os
import sys
from typing import Any, Awaitable, Callable

from lantern.types import (
    AgentContext,
    AskOptions,
    CostTracker,
    Logger,
    NotifyOptions,
)


# ---------------------------------------------------------------------------
# Dev-mode logger that writes to stderr
# ---------------------------------------------------------------------------

class DevLogger(Logger):
    """Logger implementation for local dev mode (writes to stderr)."""

    def __init__(self, agent_name: str) -> None:
        self._logger = logging.getLogger(f"lantern.{agent_name}")
        if not self._logger.handlers:
            handler = logging.StreamHandler(sys.stderr)
            handler.setFormatter(logging.Formatter(
                "[%(asctime)s] %(levelname)s %(name)s: %(message)s",
                datefmt="%H:%M:%S",
            ))
            self._logger.addHandler(handler)
            self._logger.setLevel(logging.DEBUG)

    def info(self, msg: str, **fields: Any) -> None:
        self._logger.info(msg, extra=fields if fields else None)

    def warn(self, msg: str, **fields: Any) -> None:
        self._logger.warning(msg, extra=fields if fields else None)

    def error(self, msg: str, **fields: Any) -> None:
        self._logger.error(msg, extra=fields if fields else None)

    def debug(self, msg: str, **fields: Any) -> None:
        self._logger.debug(msg, extra=fields if fields else None)


# ---------------------------------------------------------------------------
# Dev-mode cost tracker (noop)
# ---------------------------------------------------------------------------

class DevCostTracker(CostTracker):
    def __init__(self) -> None:
        self._tokens_in = 0
        self._tokens_out = 0

    def estimate_usd(self) -> float:
        return 0.0

    def tokens_in(self) -> int:
        return self._tokens_in

    def tokens_out(self) -> int:
        return self._tokens_out


# ---------------------------------------------------------------------------
# Context builders
# ---------------------------------------------------------------------------

def build_dev_context(
    *,
    agent_name: str,
    agent_version: str,
    run_id: str | None = None,
    tenant_id: str | None = None,
) -> AgentContext:
    """Build an AgentContext suitable for local development.

    LLM, tool, and memory clients are stubs that raise NotImplementedError.
    The logger writes to stderr.
    """
    import uuid

    return AgentContext(
        run_id=run_id or f"dev-{uuid.uuid4().hex[:8]}",
        tenant_id=tenant_id or "dev-tenant",
        agent_name=agent_name,
        agent_version=agent_version,
        log=DevLogger(agent_name),
        cost=DevCostTracker(),
    )


def build_production_context(
    *,
    agent_name: str,
    agent_version: str,
) -> AgentContext:
    """Build an AgentContext for the Lantern production runtime.

    Reads environment variables set by the sandbox to configure
    gRPC-backed clients.
    """
    from lantern.runtime.llm_client import GrpcLlmClient
    from lantern.runtime.memory_client import GrpcMemoryClient
    from lantern.runtime.tool_client import GrpcToolClient

    run_id = os.environ.get("LANTERN_RUN_ID", "")
    tenant_id = os.environ.get("LANTERN_TENANT_ID", "")
    grpc_endpoint = os.environ.get("LANTERN_GRPC_ENDPOINT", "localhost:50051")

    return AgentContext(
        run_id=run_id,
        tenant_id=tenant_id,
        agent_name=agent_name,
        agent_version=agent_version,
        llm=GrpcLlmClient(grpc_endpoint, run_id, tenant_id),
        tools=GrpcToolClient(grpc_endpoint, run_id, tenant_id),
        mem=GrpcMemoryClient(grpc_endpoint, run_id, tenant_id),
        log=DevLogger(agent_name),  # Will be replaced with OTel-aware logger
        cost=DevCostTracker(),  # Will be replaced with runtime cost tracker
    )
