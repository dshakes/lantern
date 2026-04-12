"""Tests for lantern.step — durable step primitives in dev mode."""

from __future__ import annotations

import asyncio
import time

import pytest

from lantern.step import step, step_map, step_race, step_sleep, step_signal
from lantern.errors import LanternStepError


# ---------------------------------------------------------------------------
# step() tests
# ---------------------------------------------------------------------------

class TestStep:
    """Tests for the basic step() function in dev mode."""

    async def test_executes_function(self):
        async def fetch():
            return {"items": [1, 2, 3]}

        result = await step("fetch", fetch)
        assert result == {"items": [1, 2, 3]}

    async def test_executes_async_function(self):
        async def do_work():
            await asyncio.sleep(0.01)
            return "done"

        result = await step("work", do_work)
        assert result == "done"

    async def test_propagates_errors(self):
        async def failing():
            raise ValueError("boom")

        with pytest.raises(ValueError, match="boom"):
            await step("fail", failing)

    async def test_different_return_types(self):
        async def ret_int():
            return 42

        async def ret_str():
            return "hello"

        async def ret_list():
            return [1, 2]

        async def ret_none():
            return None

        assert await step("int", ret_int) == 42
        assert await step("str", ret_str) == "hello"
        assert await step("list", ret_list) == [1, 2]
        assert await step("none", ret_none) is None


# ---------------------------------------------------------------------------
# step_map() tests
# ---------------------------------------------------------------------------

class TestStepMap:
    """Tests for step_map() parallel processing."""

    async def test_processes_all_items(self):
        async def double(item: int, index: int) -> int:
            return item * 2

        results = await step_map("double", [1, 2, 3, 4, 5], double)
        assert results == [2, 4, 6, 8, 10]

    async def test_empty_input(self):
        async def noop(item: int, index: int) -> int:
            return item

        results = await step_map("empty", [], noop)
        assert results == []

    async def test_preserves_order(self):
        async def delayed(item: int, index: int) -> str:
            # Items that come first sleep longer
            await asyncio.sleep(item * 0.01)
            return f"item-{item}"

        results = await step_map("ordered", [3, 1, 2], delayed)
        assert results == ["item-3", "item-1", "item-2"]

    async def test_concurrency_limit(self):
        concurrent = 0
        max_concurrent = 0

        async def tracked(item: int, index: int) -> int:
            nonlocal concurrent, max_concurrent
            concurrent += 1
            max_concurrent = max(max_concurrent, concurrent)
            await asyncio.sleep(0.02)
            concurrent -= 1
            return item

        await step_map("limited", list(range(6)), tracked, concurrency=2)
        assert max_concurrent <= 2

    async def test_default_concurrency_is_unbounded(self):
        concurrent = 0
        max_concurrent = 0

        async def tracked(item: int, index: int) -> int:
            nonlocal concurrent, max_concurrent
            concurrent += 1
            max_concurrent = max(max_concurrent, concurrent)
            await asyncio.sleep(0.02)
            concurrent -= 1
            return item

        items = list(range(5))
        await step_map("unbounded", items, tracked)
        # All 5 should run at once
        assert max_concurrent == 5


# ---------------------------------------------------------------------------
# step_race() tests
# ---------------------------------------------------------------------------

class TestStepRace:
    """Tests for step_race() first-to-complete semantics."""

    async def test_returns_fastest(self):
        async def slow():
            await asyncio.sleep(1.0)
            return "slow"

        async def fast():
            await asyncio.sleep(0.01)
            return "fast"

        result = await step_race("race", [slow, fast])
        assert result == "fast"

    async def test_single_function(self):
        async def only():
            return "only"

        result = await step_race("single", [only])
        assert result == "only"

    async def test_empty_raises(self):
        with pytest.raises(LanternStepError, match="at least one function"):
            await step_race("empty", [])


# ---------------------------------------------------------------------------
# step_sleep() tests
# ---------------------------------------------------------------------------

class TestStepSleep:
    """Tests for step_sleep() duration parsing and execution."""

    async def test_sleeps_for_duration(self):
        start = time.monotonic()
        await step_sleep("nap", "50ms")
        elapsed_ms = (time.monotonic() - start) * 1000
        assert elapsed_ms >= 40  # allow some tolerance
        assert elapsed_ms < 200

    async def test_parses_seconds(self):
        # Just verify it doesn't raise for valid durations
        start = time.monotonic()
        await step_sleep("quick", "1ms")
        elapsed = time.monotonic() - start
        assert elapsed < 1.0  # should be nearly instant

    async def test_invalid_duration_raises(self):
        with pytest.raises(ValueError, match="Invalid duration"):
            await step_sleep("bad", "5x")


# ---------------------------------------------------------------------------
# step_signal() tests
# ---------------------------------------------------------------------------

class TestStepSignal:
    """Tests for step_signal() — only works in production runtime."""

    async def test_raises_in_dev_mode(self):
        with pytest.raises(LanternStepError, match="only available in the Lantern runtime"):
            await step_signal("wait-approval")
