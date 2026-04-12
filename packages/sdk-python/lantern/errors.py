"""Error types for the Lantern Python SDK."""

from __future__ import annotations


class LanternError(Exception):
    """Base exception for all Lantern SDK errors."""


class LanternApiError(LanternError):
    """Raised when the Lantern HTTP API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"Lantern API error {status}: {body[:200]}")


class LanternStepError(LanternError):
    """Raised when a durable step fails after exhausting retries."""

    def __init__(self, step_name: str, message: str, *, attempt: int = 0) -> None:
        self.step_name = step_name
        self.attempt = attempt
        super().__init__(f"Step '{step_name}' failed (attempt {attempt}): {message}")


class LanternLlmError(LanternError):
    """Raised when an LLM call fails."""

    def __init__(self, message: str, *, capability: str | None = None, provider: str | None = None) -> None:
        self.capability = capability
        self.provider = provider
        super().__init__(message)


class LanternTimeoutError(LanternError):
    """Raised when an operation exceeds its timeout."""

    def __init__(self, operation: str, duration: str) -> None:
        self.operation = operation
        self.duration = duration
        super().__init__(f"Operation '{operation}' timed out after {duration}")


class LanternValidationError(LanternError):
    """Raised when input validation fails."""
