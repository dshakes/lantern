"""Durable step primitives.

In local / dev mode these execute functions directly.  In the Lantern
production runtime the step journal intercepts calls so that results
are persisted and replayed on retries.

Usage::

    from lantern import step, step_map, step_race, step_sleep, step_signal

    result = await step("fetch-data", lambda: fetch_data())
    results = await step_map("process", items, process_item, concurrency=4)
    winner = await step_race("compete", [fast_path, slow_path])
    await step_sleep("cooldown", "30s")
    payload = await step_signal("wait-approval", timeout="5m")
"""

from __future__ import annotations

import asyncio
import re
from contextvars import ContextVar
from typing import Any, Awaitable, Callable, TypeVar

from lantern.errors import LanternStepError, LanternTimeoutError
from lantern.types import RetryPolicy, StepOptions

T = TypeVar("T")
R = TypeVar("R")

# ---------------------------------------------------------------------------
# Runtime hook — the production runtime replaces this with a journal-aware
# implementation via set_step_runtime().
# ---------------------------------------------------------------------------

StepRunnerFn = Callable[[str, Callable[[], Awaitable[Any]], StepOptions | None], Awaitable[Any]]

_step_runtime: ContextVar[StepRunnerFn | None] = ContextVar("_step_runtime", default=None)


def set_step_runtime(runner: StepRunnerFn) -> None:
    """Install a journal-aware step runner (called by the production runtime)."""
    _step_runtime.set(runner)


def _get_runtime() -> StepRunnerFn:
    rt = _step_runtime.get()
    if rt is not None:
        return rt
    return _dev_step_runner


# ---------------------------------------------------------------------------
# Dev-mode implementation — just calls the function directly
# ---------------------------------------------------------------------------

async def _dev_step_runner(name: str, fn: Callable[[], Awaitable[Any]], opts: StepOptions | None) -> Any:
    timeout_ms: int | None = None
    if opts and opts.timeout:
        timeout_ms = _parse_duration(opts.timeout)

    if timeout_ms is not None:
        try:
            return await asyncio.wait_for(fn(), timeout=timeout_ms / 1000.0)
        except asyncio.TimeoutError:
            raise LanternTimeoutError(name, opts.timeout if opts and opts.timeout else "unknown") from None
    return await fn()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def step(
    name: str,
    fn: Callable[[], Awaitable[T]],
    *,
    retry: RetryPolicy | None = None,
    timeout: str | None = None,
) -> T:
    """Execute a durable step.

    In production, the result is journalled and replayed on restart. In dev
    mode, ``fn`` is called directly.
    """
    opts = StepOptions(retry=retry, timeout=timeout) if (retry or timeout) else None
    runtime = _get_runtime()
    return await runtime(name, fn, opts)  # type: ignore[return-value]


async def step_map(
    name: str,
    items: list[T],
    fn: Callable[[T, int], Awaitable[R]],
    *,
    concurrency: int | None = None,
    retry: RetryPolicy | None = None,
    timeout: str | None = None,
) -> list[R]:
    """Execute a step for each item in parallel (bounded concurrency).

    Each item gets its own journal entry keyed as ``{name}[{index}]``.
    """
    if not items:
        return []

    effective_concurrency = concurrency if concurrency is not None else len(items)
    effective_concurrency = max(1, effective_concurrency)

    results: list[R | None] = [None] * len(items)
    semaphore = asyncio.Semaphore(effective_concurrency)

    async def _run_item(index: int, item: T) -> None:
        async with semaphore:
            step_name = f"{name}[{index}]"
            results[index] = await step(
                step_name,
                lambda i=item, idx=index: fn(i, idx),  # type: ignore[misc]
                retry=retry,
                timeout=timeout,
            )

    await asyncio.gather(*[_run_item(i, item) for i, item in enumerate(items)])
    return results  # type: ignore[return-value]


async def step_race(
    name: str,
    fns: list[Callable[[], Awaitable[T]]],
    *,
    retry: RetryPolicy | None = None,
    timeout: str | None = None,
) -> T:
    """Execute multiple step functions concurrently, return the first to complete.

    Remaining tasks are cancelled.
    """
    if not fns:
        raise LanternStepError(name, "step_race requires at least one function")

    tasks = [
        asyncio.create_task(
            step(f"{name}[{i}]", fn, retry=retry, timeout=timeout)
        )
        for i, fn in enumerate(fns)
    ]

    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        # Return the result of the first completed task
        first = next(iter(done))
        return first.result()  # type: ignore[return-value]
    except Exception:
        for t in tasks:
            t.cancel()
        raise


async def step_sleep(name: str, duration: str) -> None:
    """Durable sleep that survives process restarts in production.

    In dev mode this is a plain ``asyncio.sleep``.
    """
    ms = _parse_duration(duration)
    runtime = _get_runtime()

    async def _sleep() -> None:
        await asyncio.sleep(ms / 1000.0)

    await runtime(name, _sleep, None)


async def step_signal(name: str, *, timeout: str | None = None) -> Any:
    """Wait for an external signal.

    Only functional in the Lantern production runtime where the workflow
    engine delivers signals to paused runs.
    """
    raise LanternStepError(
        name,
        "step_signal() is only available in the Lantern runtime. "
        "In local dev, use a mock or test fixture.",
    )


# ---------------------------------------------------------------------------
# Duration parser
# ---------------------------------------------------------------------------

_DURATION_RE = re.compile(r"^(\d+)(ms|s|m|h|d)$")

_UNIT_MS: dict[str, int] = {
    "ms": 1,
    "s": 1_000,
    "m": 60_000,
    "h": 3_600_000,
    "d": 86_400_000,
}


def _parse_duration(s: str) -> int:
    """Parse a duration string like ``'30s'`` into milliseconds."""
    match = _DURATION_RE.match(s)
    if not match:
        raise ValueError(f"Invalid duration: {s!r} (expected e.g. '30s', '5m', '1h')")
    value, unit = int(match.group(1)), match.group(2)
    return value * _UNIT_MS[unit]
