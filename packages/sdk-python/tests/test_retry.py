"""Retry/backoff behavior for LanternClient._request.

429/503 and network-layer errors are retried with bounded exponential
backoff; 4xx auth/validation errors are never retried.
"""

from __future__ import annotations

from typing import Any

import httpx

from lantern.client import LanternClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _SequenceTransport(httpx.AsyncBaseTransport):
    """Returns one response per call from a fixed sequence, then repeats the last."""

    def __init__(self, responses: list[tuple[int, Any]]) -> None:
        self._responses = responses
        self.call_count = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        idx = min(self.call_count, len(self._responses) - 1)
        status, body = self._responses[idx]
        self.call_count += 1
        content = b"" if body is None else str(body).encode()
        return httpx.Response(status, content=content, headers={"content-type": "application/json"})


class _RaisingTransport(httpx.AsyncBaseTransport):
    """Raises a network error N times, then succeeds."""

    def __init__(self, fail_times: int, ok_body: Any) -> None:
        self._fail_times = fail_times
        self._ok_body = ok_body
        self.call_count = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.call_count += 1
        if self.call_count <= self._fail_times:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(200, content=str(self._ok_body).encode(), headers={"content-type": "application/json"})


def _client(transport: httpx.AsyncBaseTransport) -> LanternClient:
    c = LanternClient(base_url="https://api.example.com", api_key="test-key")
    c._client = httpx.AsyncClient(base_url="https://api.example.com", transport=transport, headers=c._headers())
    return c


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRetry:
    async def test_retries_503_then_succeeds(self):
        t = _SequenceTransport([(503, "unavailable"), (200, '{"id": "a1"}')])
        c = _client(t)
        result = await c._request("GET", "/v1/agents/a1")
        assert result == {"id": "a1"}
        assert t.call_count == 2

    async def test_retries_429_then_succeeds(self):
        t = _SequenceTransport([(429, "rate limited"), (429, "rate limited"), (200, '{"id": "a1"}')])
        c = _client(t)
        result = await c._request("GET", "/v1/agents/a1")
        assert result == {"id": "a1"}
        assert t.call_count == 3

    async def test_does_not_retry_400(self):
        t = _SequenceTransport([(400, "bad request")])
        c = _client(t)
        try:
            await c._request("GET", "/v1/agents/a1")
            raise AssertionError("expected LanternApiError")
        except Exception as e:
            assert type(e).__name__ == "LanternApiError"
        assert t.call_count == 1

    async def test_exhausts_retries_and_raises(self):
        t = _SequenceTransport([(503, "down"), (503, "down"), (503, "down"), (503, "down")])
        c = _client(t)
        try:
            await c._request("GET", "/v1/agents/a1")
            raise AssertionError("expected LanternApiError")
        except Exception as e:
            assert type(e).__name__ == "LanternApiError"
            assert e.status == 503
        assert t.call_count == 3  # default max attempts

    async def test_retries_network_error_then_succeeds(self):
        t = _RaisingTransport(fail_times=1, ok_body='{"id": "a1"}')
        c = _client(t)
        result = await c._request("GET", "/v1/agents/a1")
        assert result == {"id": "a1"}
        assert t.call_count == 2

    async def test_exhausts_network_error_retries(self):
        t = _RaisingTransport(fail_times=10, ok_body='{"id": "a1"}')
        c = _client(t)
        try:
            await c._request("GET", "/v1/agents/a1")
            raise AssertionError("expected httpx.TransportError")
        except httpx.TransportError:
            pass
        assert t.call_count == 3  # default max attempts
