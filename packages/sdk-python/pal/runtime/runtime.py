"""Runtime detection and configuration.

Determines whether the agent is running inside the PAL production
runtime (Firecracker / Kata sandbox) or in local dev mode.
"""

from __future__ import annotations

import os
from enum import StrEnum



class RuntimeMode(StrEnum):
    PRODUCTION = "production"
    DEV = "dev"


def detect_mode() -> RuntimeMode:
    """Detect whether we are in production or dev mode.

    The PAL runtime sets ``PAL_RUNTIME=1`` in the sandbox
    environment.  Anything else is treated as dev mode.
    """
    if os.environ.get("PAL_RUNTIME") == "1":
        return RuntimeMode.PRODUCTION
    return RuntimeMode.DEV


def get_runtime_env(key: str, default: str = "") -> str:
    """Read a runtime environment variable with a default."""
    return os.environ.get(key, default)


def require_runtime_env(key: str) -> str:
    """Read a required runtime environment variable; raise if missing."""
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Required environment variable {key!r} is not set")
    return value


# Well-known environment variables set by the PAL runtime
RUNTIME_ENV_KEYS = {
    "PAL_RUNTIME": "Set to '1' inside the sandbox",
    "PAL_RUN_ID": "Current run ID",
    "PAL_TENANT_ID": "Tenant ID",
    "PAL_AGENT_NAME": "Agent name",
    "PAL_AGENT_VERSION": "Agent version",
    "PAL_GRPC_ENDPOINT": "gRPC endpoint for runtime services",
    "PAL_JOURNAL_PATH": "Path to the step journal (local file in sandbox)",
    "PAL_API_URL": "HTTP API base URL",
    "PAL_API_KEY": "API key (set as a resolved secret)",
}
