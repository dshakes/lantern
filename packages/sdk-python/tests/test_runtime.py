"""Tests for client.runtime (pause/resume/fork/exec_stream). httpx MockTransport, no server."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from lantern.client import LanternClient
from lantern.errors import LanternApiError


class _Bytes(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for c in self._chunks:
            yield c


class _T(httpx.AsyncBaseTransport):
    def __init__(self, status: int = 200, body: Any = None, sse: bytes | None = None) -> None:
        self.status, self.body, self.sse = status, body, sse
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.sse is not None:
            # one byte per chunk: worst case for line and multibyte-char boundaries
            chunks = [bytes([b]) for b in self.sse]
            return httpx.Response(self.status, stream=_Bytes(chunks), headers={"content-type": "text/event-stream"})
        content = json.dumps(self.body).encode() if self.body is not None else b""
        return httpx.Response(self.status, content=content, headers={"content-type": "application/json"})


def _client(t: _T) -> LanternClient:
    c = LanternClient(base_url="https://api.example.com", api_key="k")
    c._client = httpx.AsyncClient(base_url="https://api.example.com", transport=t, headers=c._headers())
    return c


async def test_pause_and_resume():
    t = _T(body={"vmId": "vm1", "snapshotId": "s1", "state": "paused"})
    r = await _client(t).runtime.pause("vm1")
    assert (r.vm_id, r.snapshot_id, r.state) == ("vm1", "s1", "paused")
    assert t.requests[-1].method == "POST" and t.requests[-1].url.path == "/v1/runtime/vms/vm1/pause"


@pytest.mark.parametrize("status", [402, 409])
async def test_resume_errors(status: int):
    t = _T(status=status, body={"error": "x"})
    with pytest.raises(LanternApiError) as ei:
        await _client(t).runtime.resume("vm1")
    assert ei.value.status == status
    assert len(t.requests) == 1


async def test_fork_body_and_partial_failure():
    t = _T(body={"sourceVmId": "vm1", "snapshotId": "s", "forks": [{"vmId": "a", "state": "running"}, {"vmId": "b", "state": "failed", "error": "boom"}]})
    r = await _client(t).runtime.fork("vm1", count=2)
    assert json.loads(t.requests[-1].content) == {"count": 2}
    assert r.forks[1].error == "boom"


async def test_exec_stream_split_chunks_and_utf8():
    sse = (
        'event: stdout\ndata: {"data":"héllo €"}\n\n'
        'event: stderr\ndata: {"data":"warn"}\n\n'
        'event: exit\ndata: {"exitCode":3}\n\n'
    ).encode()
    t = _T(sse=sse)
    events = [e async for e in _client(t).runtime.exec_stream("vm1", "/bin/sh", ["-c", "x"])]
    assert [(e.type, e.data, e.exit_code) for e in events] == [
        ("stdout", "héllo €", None),
        ("stderr", "warn", None),
        ("exit", "", 3),
    ]
    assert t.requests[-1].headers["accept"] == "text/event-stream"


async def test_exec_stream_error_event_and_http_error():
    t = _T(sse=b'event: error\ndata: {"error":"vm gone"}\n\n')
    with pytest.raises(LanternApiError):
        [e async for e in _client(t).runtime.exec_stream("vm1", "ls")]
    t2 = _T(status=409, sse=b"conflict")
    with pytest.raises(LanternApiError) as ei:
        [e async for e in _client(t2).runtime.exec_stream("vm1", "ls")]
    assert ei.value.status == 409
