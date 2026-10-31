"""Error types for the PAL Python SDK."""

from __future__ import annotations


class PalError(Exception):
    """Base exception for all PAL SDK errors."""


class PalApiError(PalError):
    """Raised when the PAL HTTP API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"PAL API error {status}: {body[:200]}")


class PalPolicyDeniedError(PalApiError):
    """403 ``agent_policy_denied``: the agent's policy does not allow this dispatch."""

    def __init__(self, status: int, body: str, *, kind: str = "", target: str = "", message: str = "") -> None:
        self.kind = kind
        self.target = target
        self.message = message
        super().__init__(status, body)


class PalPolicyVersionConflictError(PalApiError):
    """409 ``version_conflict``: the policy changed since it was read; re-read and retry."""


class PalStepError(PalError):
    """Raised when a durable step fails after exhausting retries."""

    def __init__(self, step_name: str, message: str, *, attempt: int = 0) -> None:
        self.step_name = step_name
        self.attempt = attempt
        super().__init__(f"Step '{step_name}' failed (attempt {attempt}): {message}")


class PalLlmError(PalError):
    """Raised when an LLM call fails."""

    def __init__(self, message: str, *, capability: str | None = None, provider: str | None = None) -> None:
        self.capability = capability
        self.provider = provider
        super().__init__(message)


class PalTimeoutError(PalError):
    """Raised when an operation exceeds its timeout."""

    def __init__(self, operation: str, duration: str) -> None:
        self.operation = operation
        self.duration = duration
        super().__init__(f"Operation '{operation}' timed out after {duration}")


class PalValidationError(PalError):
    """Raised when input validation fails."""
