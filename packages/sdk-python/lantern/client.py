"""HTTP client for the Lantern API (mirrors the TypeScript SDK client)."""

from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

import httpx

from lantern.errors import LanternApiError
from lantern.types import AgentInfo, Run, StreamEvent


class LanternClient:
    """Async HTTP client for the Lantern platform API.

    Usage::

        client = LanternClient()  # reads LANTERN_API_URL / LANTERN_API_KEY
        agent = await client.agents.create(name="my-agent")
        run = await client.runs.create(agent="my-agent", input={"q": "hi"})

        async for event in client.runs.events(run.id):
            print(event.kind, event.data)
    """

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        *,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = (
            base_url
            or os.environ.get("LANTERN_API_URL")
            or "https://api.lantern.run"
        ).rstrip("/")
        self._api_key = api_key or os.environ.get("LANTERN_API_KEY") or ""
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

        # Bind sub-resource namespaces
        self.agents = self._Agents(self)
        self.runs = self._Runs(self)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self._timeout,
                headers=self._headers(),
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> LanternClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            h["Authorization"] = f"Bearer {self._api_key}"
        return h

    async def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        client = await self._get_client()
        kwargs: dict[str, Any] = {}
        if body is not None:
            kwargs["content"] = json.dumps(body)
        if params:
            # Filter out None values
            kwargs["params"] = {k: str(v) for k, v in params.items() if v is not None}

        resp = await client.request(method, path, **kwargs)
        if not resp.is_success:
            raise LanternApiError(resp.status_code, resp.text)

        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    async def _sse_stream(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: dict[str, Any] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Open an SSE connection and yield parsed StreamEvents."""
        client = await self._get_client()
        headers = {**self._headers(), "Accept": "text/event-stream"}
        kwargs: dict[str, Any] = {"headers": headers}
        if body is not None:
            kwargs["content"] = json.dumps(body)
        if params:
            kwargs["params"] = {k: str(v) for k, v in params.items() if v is not None}

        async with client.stream(method, path, **kwargs) as resp:
            if not resp.is_success:
                body_text = await resp.aread()
                raise LanternApiError(resp.status_code, body_text.decode("utf-8", errors="replace"))

            buffer = ""
            async for chunk in resp.aiter_text():
                buffer += chunk
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if line.startswith("data: "):
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":
                            return
                        try:
                            event = StreamEvent.model_validate_json(data_str)
                            yield event
                            if event.kind == "end":
                                return
                        except Exception:
                            # Skip malformed events
                            pass

    # ------------------------------------------------------------------
    # agents namespace
    # ------------------------------------------------------------------

    class _Agents:
        def __init__(self, client: LanternClient) -> None:
            self._c = client

        async def create(
            self,
            *,
            name: str,
            description: str = "",
            labels: dict[str, str] | None = None,
        ) -> AgentInfo:
            data = await self._c._request("POST", "/v1/agents", body={
                "name": name,
                "description": description,
                "labels": labels or {},
            })
            return AgentInfo.model_validate(data)

        async def get(self, name: str) -> AgentInfo:
            data = await self._c._request("GET", f"/v1/agents/{name}")
            return AgentInfo.model_validate(data)

        async def list(
            self,
            *,
            page_size: int = 50,
            page_token: str | None = None,
        ) -> AgentListResponse:
            data = await self._c._request("GET", "/v1/agents", params={
                "pageSize": page_size,
                "pageToken": page_token,
            })
            agents = [AgentInfo.model_validate(a) for a in data.get("agents", [])]
            return AgentListResponse(agents=agents, next_page_token=data.get("nextPageToken"))

        async def delete(self, name: str) -> None:
            await self._c._request("DELETE", f"/v1/agents/{name}")

    # ------------------------------------------------------------------
    # runs namespace
    # ------------------------------------------------------------------

    class _Runs:
        def __init__(self, client: LanternClient) -> None:
            self._c = client

        async def create(
            self,
            *,
            agent: str,
            input: Any,
            stream: bool = False,
            labels: dict[str, str] | None = None,
            idempotency_key: str | None = None,
        ) -> Run | AsyncIterator[StreamEvent]:
            payload: dict[str, Any] = {
                "agent_name": agent,
                "input": input,
                "labels": labels or {},
            }
            if idempotency_key:
                payload["idempotency_key"] = idempotency_key

            if stream:
                payload["stream"] = True
                return self._c._sse_stream("POST", "/v1/runs", body=payload)

            data = await self._c._request("POST", "/v1/runs", body=payload)
            return Run.model_validate(data)

        async def get(self, id: str) -> Run:
            data = await self._c._request("GET", f"/v1/runs/{id}")
            return Run.model_validate(data)

        async def list(
            self,
            *,
            agent: str | None = None,
            status: str | None = None,
            page_size: int = 50,
            page_token: str | None = None,
        ) -> RunListResponse:
            data = await self._c._request("GET", "/v1/runs", params={
                "agent": agent,
                "status": status,
                "pageSize": page_size,
                "pageToken": page_token,
            })
            runs = [Run.model_validate(r) for r in data.get("runs", [])]
            return RunListResponse(runs=runs, next_page_token=data.get("nextPageToken"))

        async def cancel(self, id: str, reason: str = "") -> Run:
            data = await self._c._request("POST", f"/v1/runs/{id}/cancel", body={"reason": reason})
            return Run.model_validate(data)

        def events(
            self,
            run_id: str,
            *,
            from_seq: int = 0,
            live: bool = True,
        ) -> AsyncIterator[StreamEvent]:
            return self._c._sse_stream(
                "GET",
                f"/v1/runs/{run_id}/events",
                params={"from_seq": from_seq, "live": live},
            )

        async def signal(self, run_id: str, name: str, value: Any = None) -> None:
            await self._c._request(
                "POST",
                f"/v1/runs/{run_id}/signals/{name}",
                body={"value": value},
            )


# ---------------------------------------------------------------------------
# Response wrappers
# ---------------------------------------------------------------------------

class AgentListResponse:
    __slots__ = ("agents", "next_page_token")

    def __init__(self, agents: list[AgentInfo], next_page_token: str | None = None) -> None:
        self.agents = agents
        self.next_page_token = next_page_token


class RunListResponse:
    __slots__ = ("runs", "next_page_token")

    def __init__(self, runs: list[Run], next_page_token: str | None = None) -> None:
        self.runs = runs
        self.next_page_token = next_page_token
