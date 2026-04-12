"""Journal-aware step execution for the production runtime.

In production, every step result is written to a journal.  On replay
(e.g. after a restart), the journal is read first and cached results are
returned without re-executing the step function.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from lantern.errors import LanternStepError
from lantern.types import StepOptions


class StepJournal:
    """Append-only journal of step results.

    Each entry is a JSON line::

        {"step": "<name>", "result": <value>, "ts": <epoch_ms>}

    Failed steps are recorded as::

        {"step": "<name>", "error": "<message>", "ts": <epoch_ms>}
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._cache: dict[str, Any] = {}
        self._loaded = False

    def _load(self) -> None:
        """Load all journal entries from disk into the in-memory cache."""
        if self._loaded:
            return
        self._loaded = True
        if not self._path.exists():
            return
        with self._path.open("r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    name = entry["step"]
                    if "error" in entry:
                        self._cache[name] = _JournalError(entry["error"])
                    else:
                        self._cache[name] = entry["result"]
                except (json.JSONDecodeError, KeyError):
                    continue

    def has(self, name: str) -> bool:
        self._load()
        return name in self._cache

    def get(self, name: str) -> Any:
        self._load()
        value = self._cache[name]
        if isinstance(value, _JournalError):
            raise LanternStepError(name, value.message)
        return value

    def record_result(self, name: str, result: Any) -> None:
        """Append a successful result to the journal."""
        self._load()
        self._cache[name] = result
        entry = {"step": name, "result": result, "ts": _now_ms()}
        self._append(entry)

    def record_error(self, name: str, error: str) -> None:
        """Append a failure to the journal."""
        self._load()
        self._cache[name] = _JournalError(error)
        entry = {"step": name, "error": error, "ts": _now_ms()}
        self._append(entry)

    def _append(self, entry: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("a") as f:
            f.write(json.dumps(entry, default=str) + "\n")


class _JournalError:
    __slots__ = ("message",)

    def __init__(self, message: str) -> None:
        self.message = message


def _now_ms() -> int:
    return int(time.time() * 1000)


def create_journal_step_runner(journal: StepJournal) -> Callable[
    [str, Callable[[], Awaitable[Any]], StepOptions | None],
    Awaitable[Any],
]:
    """Create a step runner that checks the journal before executing."""

    async def runner(
        name: str,
        fn: Callable[[], Awaitable[Any]],
        opts: StepOptions | None,
    ) -> Any:
        # Replay from journal if available
        if journal.has(name):
            return journal.get(name)

        # Execute and persist
        max_attempts = 1
        if opts and opts.retry and opts.retry.max_attempts:
            max_attempts = opts.retry.max_attempts

        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                result = await fn()
                journal.record_result(name, result)
                return result
            except Exception as exc:
                last_error = exc
                # Check non-retryable errors
                if opts and opts.retry and opts.retry.non_retryable:
                    exc_name = type(exc).__name__
                    if exc_name in opts.retry.non_retryable:
                        break

        error_msg = str(last_error) if last_error else "unknown error"
        journal.record_error(name, error_msg)
        raise LanternStepError(name, error_msg, attempt=max_attempts)

    return runner


def get_journal_path() -> str:
    """Get the journal file path from the runtime environment."""
    return os.environ.get("LANTERN_JOURNAL_PATH", "/tmp/lantern-journal.jsonl")
