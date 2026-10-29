"""PAL runtime internals.

This sub-package contains the production runtime components:

- ``runtime`` — environment detection (production vs dev)
- ``step_runtime`` — journal-aware step execution
- ``llm_client`` — gRPC LLM client (model router)
- ``tool_client`` — gRPC tool client
- ``memory_client`` — gRPC memory client
- ``context`` — AgentContext builder
- ``runner`` — agent runner entry point
"""

from pal.runtime.context import build_dev_context, build_production_context
from pal.runtime.runner import main, run_agent
from pal.runtime.runtime import RuntimeMode, detect_mode

__all__ = [
    "RuntimeMode",
    "detect_mode",
    "build_dev_context",
    "build_production_context",
    "run_agent",
    "main",
]
