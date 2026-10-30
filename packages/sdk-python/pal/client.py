"""HTTP client for the PAL API (mirrors the TypeScript SDK client)."""

from __future__ import annotations

import asyncio
import json
import random
from collections.abc import AsyncIterator
from typing import Any

import httpx

import os
from pal.errors import PalApiError
from pal.types import (
    AgentInfo,
    ConnectorInfo,
    ConnectorResult,
    ExecStreamEvent,
    Run,
    Session,
    SessionMessage,
    StreamEvent,
    VmForkResult,
    VmPauseResult,
    VmResumeResult,
)

# Bounded exponential backoff with full jitter, mirroring
# packages/bridge-core/src/retry.ts. Only 429/503 and network-layer
# failures are transient; 4xx auth/validation errors are never retried.
_RETRY_MAX_ATTEMPTS = 3
_RETRY_BASE_DELAY_S = 0.5
_RETRY_MAX_DELAY_S = 4.0
_RETRYABLE_STATUS = {429, 503}


def _retry_backoff_s(attempt: int) -> float:
    ceiling = min(_RETRY_MAX_DELAY_S, _RETRY_BASE_DELAY_S * 2**attempt)
    return random.uniform(0, ceiling)


class PalClient:
    """Async HTTP client for the PAL platform API.

    Usage::

        client = PalClient()  # reads LANTERN_API_URL / LANTERN_API_KEY
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
        route_strategy: str | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("PAL_API_URL") or "https://api.lantern.run").rstrip("/")
        self._api_key = api_key or os.environ.get("PAL_API_KEY") or ""
        self._timeout = timeout
        self._route_strategy = route_strategy or os.environ.get("PAL_ROUTE_STRATEGY") or "auto"
        self._client: httpx.AsyncClient | None = None

        # Bind sub-resource namespaces
        self.agents = self._Agents(self)
        self.runs = self._Runs(self)
        self.sessions = self._Sessions(self)
        self.connectors = self._Connectors(self)
        self.budgets = self._Budgets(self)
        self.triggers = self._Triggers(self)
        self.evals = self._Evals(self)
        self.experiments = self._Experiments(self)
        self.marketplace = self._Marketplace(self)
        self.mcp = self._MCP(self)
        self.receipts = self._Receipts(self)
        self.feedback = self._Feedback(self)
        self.rehearsals = self._Rehearsals(self)
        self.runtime = self._Runtime(self)

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

    async def __aenter__(self) -> PalClient:
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
        if self._route_strategy and self._route_strategy != "auto":
            # legacy header name sent too while servers migrate (ADR 0032)
            h["X-Pal-Route-Strategy"] = h["X-Lantern-Route-Strategy"] = self._route_strategy
        return h

    async def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        kwargs: dict[str, Any] = {}
        if body is not None:
            kwargs["content"] = json.dumps(body)
        if params:
            # Filter out None values
            kwargs["params"] = {k: str(v) for k, v in params.items() if v is not None}

        for attempt in range(_RETRY_MAX_ATTEMPTS):
            client = await self._get_client()
            try:
                resp = await client.request(method, path, **kwargs)
            except httpx.TransportError:
                if attempt + 1 >= _RETRY_MAX_ATTEMPTS:
                    raise
                await asyncio.sleep(_retry_backoff_s(attempt))
                continue

            if resp.is_success:
                if resp.status_code == 204 or not resp.content:
                    return None
                return resp.json()

            if resp.status_code in _RETRYABLE_STATUS and attempt + 1 < _RETRY_MAX_ATTEMPTS:
                await asyncio.sleep(_retry_backoff_s(attempt))
                continue

            raise PalApiError(resp.status_code, resp.text)

    @staticmethod
    def _items(data: Any, key: str) -> list[Any]:
        """Normalize a list response.

        The control-plane list endpoints return a BARE JSON array
        (writeJSON(w, 200, <slice>)); a wrapped ``{key: [...]}`` shape is
        accepted too for forward-compat. Anything else yields [].
        """
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            items = data.get(key, [])
            return items if isinstance(items, list) else []
        return []

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
                raise PalApiError(resp.status_code, body_text.decode("utf-8", errors="replace"))

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
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def create(
            self,
            *,
            name: str,
            description: str = "",
            labels: dict[str, str] | None = None,
        ) -> AgentInfo:
            data = await self._c._request(
                "POST",
                "/v1/agents",
                body={
                    "name": name,
                    "description": description,
                    "labels": labels or {},
                },
            )
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
            data = await self._c._request(
                "GET",
                "/v1/agents",
                params={
                    "pageSize": page_size,
                    "pageToken": page_token,
                },
            )
            agents = [AgentInfo.model_validate(a) for a in PalClient._items(data, "agents")]
            token = data.get("nextPageToken") if isinstance(data, dict) else None
            return AgentListResponse(agents=agents, next_page_token=token)

        async def delete(self, name: str) -> None:
            await self._c._request("DELETE", f"/v1/agents/{name}")

    # ------------------------------------------------------------------
    # runs namespace
    # ------------------------------------------------------------------

    class _Runs:
        def __init__(self, client: PalClient) -> None:
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
                # Handler decodes camelCase `agentName` (rest.go CreateRun);
                # snake_case is silently dropped → an agent-less run.
                "agentName": agent,
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
            data = await self._c._request(
                "GET",
                "/v1/runs",
                params={
                    "agent": agent,
                    "status": status,
                    "pageSize": page_size,
                    "pageToken": page_token,
                },
            )
            runs = [Run.model_validate(r) for r in PalClient._items(data, "runs")]
            token = data.get("nextPageToken") if isinstance(data, dict) else None
            return RunListResponse(runs=runs, next_page_token=token)

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

        async def forecast(self, agent_name: str, input: str) -> ForecastResult:
            """Forecast tokens/cost/confidence for a prospective run.

            Returns a ForecastResult with ``would_exceed_budget`` set to True
            when a budget policy would block execution.
            """
            data = await self._c._request(
                "POST",
                "/v1/runs/forecast",
                body={
                    "agentName": agent_name,
                    "input": input,
                },
            )
            return ForecastResult(
                agent_name=data.get("agentName", agent_name),
                model=data.get("model", ""),
                provider=data.get("provider", ""),
                estimated_tokens_in=data.get("estimatedTokensIn", 0),
                estimated_tokens_out=data.get("estimatedTokensOut", 0),
                estimated_cost_usd=data.get("estimatedCostUsd", 0.0),
                confidence=data.get("confidence", 0.0),
                would_exceed_budget=data.get("wouldExceedBudget", False),
                block_reason=data.get("blockReason"),
                reasoning=data.get("reasoning"),
            )

    # ------------------------------------------------------------------
    # sessions namespace
    # ------------------------------------------------------------------

    class _Sessions:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def create(
            self,
            *,
            agent: str,
            metadata: dict[str, Any] | None = None,
        ) -> Session:
            """Create a new interactive session for an agent."""
            data = await self._c._request(
                "POST",
                "/v1/sessions",
                body={
                    # Handler decodes camelCase `agentName` (sessions.go
                    # CreateSession:79); snake_case is silently dropped.
                    "agentName": agent,
                    "metadata": metadata or {},
                },
            )
            return Session.model_validate(data)

        async def get(self, session_id: str) -> Session:
            """Retrieve a session by ID."""
            data = await self._c._request("GET", f"/v1/sessions/{session_id}")
            return Session.model_validate(data)

        async def list(
            self,
            *,
            agent: str | None = None,
            status: str | None = None,
            page_size: int = 50,
            page_token: str | None = None,
        ) -> SessionListResponse:
            """List sessions, optionally filtered by agent or status."""
            data = await self._c._request(
                "GET",
                "/v1/sessions",
                params={
                    "agent": agent,
                    "status": status,
                    "pageSize": page_size,
                    "pageToken": page_token,
                },
            )
            sessions = [Session.model_validate(s) for s in PalClient._items(data, "sessions")]
            token = data.get("nextPageToken") if isinstance(data, dict) else None
            return SessionListResponse(sessions=sessions, next_page_token=token)

        async def send_message(
            self,
            session_id: str,
            *,
            content: str,
            role: str = "user",
        ) -> SessionMessage:
            """Send a message to a session and get the agent's response."""
            data = await self._c._request(
                "POST",
                f"/v1/sessions/{session_id}/messages",
                body={"content": content, "role": role},
            )
            return SessionMessage.model_validate(data)

        def stream_events(
            self,
            session_id: str,
            *,
            from_seq: int = 0,
        ) -> AsyncIterator[StreamEvent]:
            """Stream events from a session (SSE)."""
            return self._c._sse_stream(
                "GET",
                f"/v1/sessions/{session_id}/events",
                params={"from_seq": from_seq},
            )

        async def stop(self, session_id: str) -> None:
            """Stop a running session (POST /v1/sessions/{id}/stop)."""
            await self._c._request("POST", f"/v1/sessions/{session_id}/stop")

        async def delete(self, session_id: str) -> None:
            """Delete a session (DELETE /v1/sessions/{id}).

            Previously named ``close``; this is the correct server route.
            """
            await self._c._request("DELETE", f"/v1/sessions/{session_id}")

        # Backward-compat alias — was using wrong route (POST /{id}/close).
        # Now delegates to delete() which uses DELETE /v1/sessions/{id}.
        async def close(self, session_id: str) -> None:
            """Deprecated alias for delete(). Kept for backward compatibility."""
            await self.delete(session_id)

    # ------------------------------------------------------------------
    # connectors namespace
    # ------------------------------------------------------------------

    class _Connectors:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def list(
            self,
            *,
            page_size: int = 50,
            page_token: str | None = None,
        ) -> ConnectorListResponse:
            """List installed connectors."""
            data = await self._c._request(
                "GET",
                "/v1/connectors",
                params={
                    "pageSize": page_size,
                    "pageToken": page_token,
                },
            )
            items = [ConnectorInfo.model_validate(c) for c in PalClient._items(data, "connectors")]
            token = data.get("nextPageToken") if isinstance(data, dict) else None
            return ConnectorListResponse(connectors=items, next_page_token=token)

        async def get(self, connector_id: str) -> ConnectorInfo:
            """Get details for an installed connector."""
            data = await self._c._request("GET", f"/v1/connectors/{connector_id}")
            return ConnectorInfo.model_validate(data)

        async def execute(
            self,
            connector_id: str,
            action: str,
            params: dict[str, Any] | None = None,
        ) -> ConnectorResult:
            """Execute a connector action.

            The action name is passed as a query parameter per the server contract
            (GET/POST /v1/connectors/{connectorId}/execute?action={action}).

            Example::

                result = await client.connectors.execute(
                    "slack", "send_message",
                    params={"channel": "#general", "text": "Hello from PAL!"},
                )
            """
            data = await self._c._request(
                "POST",
                f"/v1/connectors/{connector_id}/execute",
                body={"params": params or {}},
                params={"action": action},
            )
            return ConnectorResult.model_validate(data)

        async def list_actions(self, connector_id: str) -> list[dict[str, Any]]:
            """List available actions for a connector."""
            data = await self._c._request("GET", f"/v1/connectors/{connector_id}/actions")
            return data.get("actions", [])

    # ------------------------------------------------------------------
    # budgets namespace
    # ------------------------------------------------------------------

    class _Budgets:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def upsert(
            self,
            agent_name: str,
            *,
            max_cost_usd_per_day: float | None = None,
            max_cost_usd_per_run: float | None = None,
            max_runs_per_day: int | None = None,
            tool_limits: dict[str, int] | None = None,
            hard_fail: bool = False,
            notify_at_pct: int | None = None,
        ) -> BudgetResult:
            """Upsert a per-agent budget policy (PUT /v1/agents/{name}/budget)."""
            body: dict[str, Any] = {"agentName": agent_name, "hardFail": hard_fail}
            if max_cost_usd_per_day is not None:
                body["maxCostUsdPerDay"] = max_cost_usd_per_day
            if max_cost_usd_per_run is not None:
                body["maxCostUsdPerRun"] = max_cost_usd_per_run
            if max_runs_per_day is not None:
                body["maxRunsPerDay"] = max_runs_per_day
            if tool_limits:
                body["toolLimits"] = tool_limits
            if notify_at_pct is not None:
                body["notifyAtPct"] = notify_at_pct
            data = await self._c._request("PUT", f"/v1/agents/{agent_name}/budget", body=body)
            return BudgetResult.from_dict(data or body)

        async def get(self, agent_name: str) -> BudgetResult:
            """Get the budget configured for an agent (GET /v1/agents/{name}/budget)."""
            data = await self._c._request("GET", f"/v1/agents/{agent_name}/budget")
            return BudgetResult.from_dict(data)

        async def delete(self, agent_name: str) -> None:
            """Remove a budget from an agent (DELETE /v1/agents/{name}/budget)."""
            await self._c._request("DELETE", f"/v1/agents/{agent_name}/budget")

        async def list_all(self) -> list[BudgetResult]:
            """List all budgets for the tenant (GET /v1/budgets)."""
            data = await self._c._request("GET", "/v1/budgets")
            return [BudgetResult.from_dict(b) for b in (data or [])]

    # ------------------------------------------------------------------
    # triggers namespace (inbound webhooks, ADR 0028)
    # ------------------------------------------------------------------

    class _Triggers:
        """Inbound webhook triggers. A provider POSTs signed deliveries to
        ``base_url + trigger["hookPath"]``; each verified delivery starts a run."""

        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def create(
            self,
            agent_name: str,
            *,
            provider: str,
            secret: str | None = None,
            input_template: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            """Create a trigger (POST /v1/agents/{name}/triggers). ``secret`` is in
            the response only when PAL generated it — store it then."""
            body: dict[str, Any] = {"provider": provider}
            if secret is not None:
                body["secret"] = secret
            if input_template is not None:
                body["inputTemplate"] = input_template
            data: dict[str, Any] = await self._c._request("POST", f"/v1/agents/{agent_name}/triggers", body=body)
            return data

        async def list(self, agent_name: str) -> list[dict[str, Any]]:
            """List an agent's triggers (GET /v1/agents/{name}/triggers). Never includes secrets."""
            return await self._c._request("GET", f"/v1/agents/{agent_name}/triggers") or []

        async def get(self, trigger_id: str) -> dict[str, Any]:
            """Get one trigger (GET /v1/triggers/{id})."""
            data: dict[str, Any] = await self._c._request("GET", f"/v1/triggers/{trigger_id}")
            return data

        async def update(
            self,
            trigger_id: str,
            *,
            enabled: bool | None = None,
            secret: str | None = None,
            input_template: dict[str, Any] | None = None,
            clear_input_template: bool = False,
        ) -> dict[str, Any]:
            """Update a trigger (PATCH /v1/triggers/{id})."""
            body: dict[str, Any] = {}
            if enabled is not None:
                body["enabled"] = enabled
            if secret is not None:
                body["secret"] = secret
            if clear_input_template:
                body["inputTemplate"] = None
            elif input_template is not None:
                body["inputTemplate"] = input_template
            data: dict[str, Any] = await self._c._request("PATCH", f"/v1/triggers/{trigger_id}", body=body)
            return data

        async def delete(self, trigger_id: str) -> None:
            """Delete a trigger (DELETE /v1/triggers/{id})."""
            await self._c._request("DELETE", f"/v1/triggers/{trigger_id}")

    # ------------------------------------------------------------------
    # evals namespace
    # ------------------------------------------------------------------

    class _Evals:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def upsert_suite(
            self,
            agent_name: str,
            name: str,
            cases: list[dict[str, Any]],
            *,
            description: str = "",
        ) -> str:
            """Create or update an eval suite. Returns the suite ID."""
            data = await self._c._request(
                "POST",
                "/v1/eval-suites",
                body={
                    "agentName": agent_name,
                    "name": name,
                    "description": description,
                    "cases": cases,
                },
            )
            return (data or {}).get("id", "")

        async def list_suites(self, agent_name: str | None = None) -> list[dict[str, Any]]:
            """List eval suites, optionally filtered by agent."""
            data = await self._c._request(
                "GET",
                "/v1/eval-suites",
                params={
                    "agentName": agent_name,
                },
            )
            return data or []

        async def get_suite(self, suite_id: str) -> dict[str, Any]:
            """Get a single eval suite by ID."""
            data = await self._c._request("GET", f"/v1/eval-suites/{suite_id}")
            return data or {}

        async def delete_suite(self, suite_id: str) -> None:
            """Delete an eval suite."""
            await self._c._request("DELETE", f"/v1/eval-suites/{suite_id}")

        async def record_run(
            self,
            suite_id: str,
            case_results: list[dict[str, Any]],
            *,
            agent_version: str = "",
            commit_sha: str = "",
            branch: str = "",
            duration_ms: int = 0,
            total_cost_usd: float = 0.0,
        ) -> EvalRunResult:
            """Submit eval case results. Returns HTTP 422 if regressed vs. baseline."""
            data = await self._c._request(
                "POST",
                "/v1/eval-runs",
                body={
                    "suiteId": suite_id,
                    "agentVersion": agent_version,
                    "commitSha": commit_sha,
                    "branch": branch,
                    "durationMs": duration_ms,
                    "totalCostUsd": total_cost_usd,
                    "caseResults": case_results,
                },
            )
            return EvalRunResult.from_dict(data or {})

        async def list_runs(
            self,
            *,
            suite_id: str | None = None,
            agent_name: str | None = None,
            branch: str | None = None,
        ) -> list[dict[str, Any]]:
            """List eval runs."""
            data = await self._c._request(
                "GET",
                "/v1/eval-runs",
                params={
                    "suiteId": suite_id,
                    "agentName": agent_name,
                    "branch": branch,
                },
            )
            return data or []

        async def set_baseline(self, agent_name: str, branch: str, eval_run_id: str) -> None:
            """Pin an eval run as the baseline for a branch."""
            await self._c._request(
                "POST",
                "/v1/eval-baselines",
                body={
                    "agentName": agent_name,
                    "branch": branch,
                    "evalRunId": eval_run_id,
                },
            )

        async def get_baseline(self, agent_name: str, branch: str) -> dict[str, Any]:
            """Get the pinned baseline for (agent, branch)."""
            data = await self._c._request(
                "GET",
                "/v1/eval-baselines",
                params={
                    "agentName": agent_name,
                    "branch": branch,
                },
            )
            return data or {}

    # ------------------------------------------------------------------
    # experiments namespace
    # ------------------------------------------------------------------

    class _Experiments:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def create(
            self,
            agent_name: str,
            name: str,
            *,
            variant_a_version: str,
            variant_b_version: str,
            traffic_split_b: int = 50,
            eval_suite_id: str = "",
            auto_promote: bool = False,
            min_runs_to_promote: int = 0,
        ) -> dict[str, Any]:
            """Create an A/B experiment (POST /v1/experiments)."""
            data = await self._c._request(
                "POST",
                "/v1/experiments",
                body={
                    "agentName": agent_name,
                    "name": name,
                    "variantAVersion": variant_a_version,
                    "variantBVersion": variant_b_version,
                    "trafficSplitB": traffic_split_b,
                    "evalSuiteId": eval_suite_id,
                    "autoPromote": auto_promote,
                    "minRunsToPromote": min_runs_to_promote,
                },
            )
            return data or {}

        async def list(self) -> list[dict[str, Any]]:
            """List all experiments."""
            data = await self._c._request("GET", "/v1/experiments")
            return data or []

        async def get(self, experiment_id: str) -> dict[str, Any]:
            """Get a single experiment."""
            data = await self._c._request("GET", f"/v1/experiments/{experiment_id}")
            return data or {}

        async def record_outcome(
            self,
            experiment_id: str,
            variant: str,
            score: float,
        ) -> None:
            """Record a per-run outcome score for a variant (0..1).

            The control plane updates rolling stats and may auto-promote a winner.
            """
            await self._c._request(
                "POST",
                f"/v1/experiments/{experiment_id}/record",
                body={
                    "variant": variant,
                    "score": score,
                },
            )

        async def conclude(
            self,
            experiment_id: str,
            winner: str,
            promote: bool = False,
        ) -> None:
            """Manually conclude an experiment and optionally promote the winner."""
            await self._c._request(
                "POST",
                f"/v1/experiments/{experiment_id}/conclude",
                body={
                    "winner": winner,
                    "promote": promote,
                },
            )

    # ------------------------------------------------------------------
    # marketplace namespace
    # ------------------------------------------------------------------

    class _Marketplace:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def list(
            self,
            *,
            category: str | None = None,
            query: str | None = None,
        ) -> list[dict[str, Any]]:
            """List published marketplace agents."""
            data = await self._c._request(
                "GET",
                "/v1/marketplace",
                params={
                    "category": category,
                    "q": query,
                },
            )
            return data or []

        async def get(self, slug: str) -> dict[str, Any]:
            """Get a marketplace entry by slug."""
            data = await self._c._request("GET", f"/v1/marketplace/{slug}")
            return data or {}

        async def publish(
            self,
            agent_name: str,
            slug: str,
            category: str,
            tags: list[str] | None = None,
        ) -> dict[str, Any]:
            """Publish a tenant-local agent to the marketplace."""
            data = await self._c._request(
                "POST",
                "/v1/marketplace/publish",
                body={
                    "agentName": agent_name,
                    "slug": slug,
                    "category": category,
                    "tags": tags or [],
                },
            )
            return data or {}

        async def fork(self, slug: str, new_name: str) -> AgentInfo:
            """Fork a marketplace agent into the caller's tenant."""
            data = await self._c._request(
                "POST",
                f"/v1/marketplace/{slug}/fork",
                body={
                    "name": new_name,
                },
            )
            return AgentInfo.model_validate(data)

        async def star(self, slug: str) -> None:
            """Star a marketplace agent."""
            await self._c._request("POST", f"/v1/marketplace/{slug}/star")

        async def unstar(self, slug: str) -> None:
            """Unstar a marketplace agent."""
            await self._c._request("DELETE", f"/v1/marketplace/{slug}/star")

    # ------------------------------------------------------------------
    # mcp namespace
    # ------------------------------------------------------------------

    class _MCP:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def list_servers(
            self,
            *,
            category: str | None = None,
            query: str | None = None,
        ) -> list[dict[str, Any]]:
            """List curated MCP servers (GET /v1/mcp/servers)."""
            data = await self._c._request(
                "GET",
                "/v1/mcp/servers",
                params={
                    "category": category,
                    "q": query,
                },
            )
            return data or []

        async def get_server(self, slug: str) -> dict[str, Any]:
            """Get a single MCP server entry."""
            data = await self._c._request("GET", f"/v1/mcp/servers/{slug}")
            return data or {}

        async def attach(
            self,
            agent_name: str,
            slug: str,
            config: dict[str, Any] | None = None,
        ) -> None:
            """Attach an MCP server to an agent."""
            await self._c._request(
                "POST",
                f"/v1/agents/{agent_name}/mcp-servers",
                body={
                    "slug": slug,
                    "config": config or {},
                },
            )

        async def detach(self, agent_name: str, slug: str) -> None:
            """Detach an MCP server from an agent."""
            await self._c._request("DELETE", f"/v1/agents/{agent_name}/mcp-servers/{slug}")

        async def list_attachments(self, agent_name: str) -> list[dict[str, Any]]:
            """List MCP servers attached to an agent."""
            data = await self._c._request("GET", f"/v1/agents/{agent_name}/mcp-servers")
            return data or []

    # ------------------------------------------------------------------
    # receipts namespace
    # ------------------------------------------------------------------

    class _Receipts:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def issue(self, run_id: str) -> dict[str, Any]:
            """Issue and persist a signed receipt for a completed run."""
            data = await self._c._request("POST", f"/v1/runs/{run_id}/receipt")
            return data or {}

        async def verify(self, receipt: dict[str, Any]) -> ReceiptVerifyResult:
            """Verify a receipt signature (no auth required)."""
            data = await self._c._request("POST", "/v1/runs/receipts/verify", body=receipt)
            return ReceiptVerifyResult(
                valid=data.get("valid", False),
                reason=data.get("reason"),
                run_id=data.get("runId"),
                issued_at=data.get("issuedAt"),
                tenant_id=data.get("tenantId"),
            )

    # ------------------------------------------------------------------
    # feedback namespace
    # ------------------------------------------------------------------

    class _Feedback:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def submit(
            self,
            run_id: str,
            *,
            score: int,
            comment: str = "",
            preferred_output: str = "",
            source: str = "sdk",
        ) -> None:
            """Submit human feedback for a run (score 1..5)."""
            await self._c._request(
                "POST",
                f"/v1/runs/{run_id}/feedback",
                body={
                    "score": score,
                    "comment": comment,
                    "preferredOutput": preferred_output,
                    "source": source,
                },
            )

        async def list_for_run(self, run_id: str) -> list[dict[str, Any]]:
            """List feedback entries for a run."""
            data = await self._c._request("GET", f"/v1/runs/{run_id}/feedback")
            return data or []

        async def summary_for_agent(self, agent_name: str) -> FeedbackSummary:
            """Get aggregate feedback summary for an agent."""
            data = await self._c._request("GET", f"/v1/agents/{agent_name}/feedback")
            return FeedbackSummary(
                agent_name=data.get("agentName", agent_name),
                total_feedback=data.get("totalFeedback", 0),
                avg_score=data.get("avgScore", 0.0),
                thumbs_up=data.get("thumbsUp", 0),
                thumbs_down=data.get("thumbsDown", 0),
                runs_with_preferred_output=data.get("runsWithPreferredOutput", 0),
                last_7_days_avg_score=data.get("last7DaysAvgScore", 0.0),
            )

    # ------------------------------------------------------------------
    # rehearsals namespace
    # ------------------------------------------------------------------
    # runtime namespace (microVMs)
    # ------------------------------------------------------------------

    class _Runtime:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def schedule(self, spec: dict[str, Any]) -> dict[str, Any]:
            """Submit an AgentSpec to schedule a microVM workload.

            Pass ``idle_timeout_secs`` (int) in *spec* to enable idle-suspend
            auto-pause: the VM will be automatically snapshotted and stopped
            after that many seconds of inactivity (no running exec/workload
            child). 0 or absent means never auto-suspend. Exec, ExecTool, and
            file-API requests to an auto-suspended VM transparently resume it.
            """
            return await self._c._request("POST", "/v1/runtime/schedule", body=spec)

        async def list(self, *, state: str | None = None, limit: int | None = None) -> list[dict[str, Any]]:
            data = await self._c._request("GET", "/v1/runtime/vms", params={"state": state, "limit": limit})
            return self._c._items(data, "vms")

        async def get(self, vm_id: str) -> dict[str, Any]:
            """Bare VM row (the detail endpoint wraps it as ``{vm, events}``)."""
            data = await self._c._request("GET", f"/v1/runtime/vms/{vm_id}")
            if isinstance(data, dict) and isinstance(data.get("vm"), dict):
                return data["vm"]
            return data

        async def terminate(self, vm_id: str, *, grace: str | None = None) -> None:
            await self._c._request("DELETE", f"/v1/runtime/vms/{vm_id}", params={"grace": grace})

        async def exec(self, vm_id: str, command: str, argv: list[str] | None = None) -> dict[str, Any]:
            """Buffered exec (execve-style: ``command`` is the executable)."""
            return await self._c._request(
                "POST", f"/v1/runtime/vms/{vm_id}/exec", body={"command": command, "argv": argv or []}
            )

        async def exec_stream(
            self, vm_id: str, command: str, argv: list[str] | None = None
        ) -> AsyncIterator[ExecStreamEvent]:
            """Streaming exec over SSE: stdout/stderr chunks, then one ``exit`` event.

            Raises PalApiError on non-2xx and on an SSE ``error`` event.
            """
            client = await self._c._get_client()
            headers = {**self._c._headers(), "Accept": "text/event-stream"}
            body = json.dumps({"command": command, "argv": argv or []})
            async with client.stream("POST", f"/v1/runtime/vms/{vm_id}/exec", headers=headers, content=body) as resp:
                if not resp.is_success:
                    raw = await resp.aread()
                    raise PalApiError(resp.status_code, raw.decode("utf-8", errors="replace"))

                event, data = "message", ""
                buffer = ""
                # aiter_text decodes incrementally, so split multibyte chars are safe.
                async for chunk in resp.aiter_text():
                    buffer += chunk
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.rstrip("\r")
                        if line == "":
                            if data:
                                out = self._parse_exec_event(event, data)
                                if out is not None:
                                    yield out
                                    if out.type == "exit":
                                        return
                            event, data = "message", ""
                        elif line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            data = line[5:].strip()

        @staticmethod
        def _parse_exec_event(event: str, data: str) -> ExecStreamEvent | None:
            try:
                payload = json.loads(data)
            except ValueError:
                return None
            if not isinstance(payload, dict):
                return None
            if event in ("stdout", "stderr"):
                return ExecStreamEvent(type=event, data=str(payload.get("data", "")))
            if event == "exit":
                return ExecStreamEvent(type="exit", exit_code=int(payload.get("exitCode", 0)))
            if event == "error":
                raise PalApiError(500, str(payload.get("error") or payload.get("message") or "exec stream error"))
            return None

        async def pause(self, vm_id: str) -> VmPauseResult:
            """Snapshot + pause a running VM. 409 if not running."""
            data = await self._c._request("POST", f"/v1/runtime/vms/{vm_id}/pause")
            return VmPauseResult.model_validate(data)

        async def resume(self, vm_id: str) -> VmResumeResult:
            """Resume a paused VM. 402 quota exceeded, 409 if not paused."""
            data = await self._c._request("POST", f"/v1/runtime/vms/{vm_id}/resume")
            return VmResumeResult.model_validate(data)

        async def fork(self, vm_id: str, *, count: int = 1) -> VmForkResult:
            """Fork ``count`` (1..LANTERN_MAX_FORK_COUNT, default cap 100) VMs from a snapshot. Per-fork failures are in ``forks[].error``."""
            data = await self._c._request("POST", f"/v1/runtime/vms/{vm_id}/fork", body={"count": count})
            return VmForkResult.model_validate(data)

        async def list_files(self, vm_id: str, path: str | None = None) -> dict[str, Any]:
            """List a directory under the VM's /workspace (default: the root).

            Returns ``{path, entries: [{name, type, size}], truncated}``.
            """
            return await self._c._request("GET", f"/v1/runtime/vms/{vm_id}/files", params={"path": path})

        async def read_file(self, vm_id: str, path: str) -> dict[str, Any]:
            """Read a UTF-8 text file (≤ 1 MiB). Returns ``{content, truncated}``."""
            client = await self._c._get_client()
            resp = await client.get(
                f"/v1/runtime/vms/{vm_id}/files/content", params={"path": path}, headers=self._c._headers()
            )
            if not resp.is_success:
                raise PalApiError(resp.status_code, resp.text)
            # x-lantern-truncated: legacy fallback
            truncated = resp.headers.get("x-pal-truncated") or resp.headers.get("x-lantern-truncated")
            return {"content": resp.text, "truncated": truncated == "true"}

        async def write_file(self, vm_id: str, path: str, content: str) -> dict[str, Any]:
            """Create or overwrite a UTF-8 text file (≤ 1 MiB; 413 above). Returns ``{path, bytesWritten}``."""
            client = await self._c._get_client()
            headers = {**self._c._headers(), "Content-Type": "text/plain; charset=utf-8"}
            resp = await client.put(
                f"/v1/runtime/vms/{vm_id}/files/content",
                params={"path": path},
                headers=headers,
                content=content.encode("utf-8"),
            )
            if not resp.is_success:
                raise PalApiError(resp.status_code, resp.text)
            return resp.json()

    # ------------------------------------------------------------------

    class _Rehearsals:
        def __init__(self, client: PalClient) -> None:
            self._c = client

        async def pull(
            self,
            agent_name: str,
            *,
            window: str = "",
            include_failures: bool = True,
            include_low_score: bool = True,
            limit: int = 0,
        ) -> RehearseResponse:
            """Pull past failed/low-score runs as synthetic test cases.

            Results can be replayed locally and posted back via evals.record_run()
            to gate merges through the existing baseline machinery.
            """
            body: dict[str, Any] = {
                "agentName": agent_name,
                "includeFailures": include_failures,
                "includeLowScore": include_low_score,
            }
            if window:
                body["window"] = window
            if limit > 0:
                body["limit"] = limit
            data = await self._c._request("POST", "/v1/runs/rehearse", body=body)
            return RehearseResponse(
                agent_name=(data or {}).get("agentName", agent_name),
                window=(data or {}).get("window", window),
                cases=(data or {}).get("cases", []),
                count=(data or {}).get("count", 0),
                reason=(data or {}).get("reason"),
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


class SessionListResponse:
    __slots__ = ("sessions", "next_page_token")

    def __init__(self, sessions: list[Session], next_page_token: str | None = None) -> None:
        self.sessions = sessions
        self.next_page_token = next_page_token


class ConnectorListResponse:
    __slots__ = ("connectors", "next_page_token")

    def __init__(self, connectors: list[ConnectorInfo], next_page_token: str | None = None) -> None:
        self.connectors = connectors
        self.next_page_token = next_page_token


class ForecastResult:
    """Result of a cost/token forecast for a prospective run."""

    __slots__ = (
        "agent_name",
        "model",
        "provider",
        "estimated_tokens_in",
        "estimated_tokens_out",
        "estimated_cost_usd",
        "confidence",
        "would_exceed_budget",
        "block_reason",
        "reasoning",
    )

    def __init__(
        self,
        *,
        agent_name: str,
        model: str,
        provider: str,
        estimated_tokens_in: int,
        estimated_tokens_out: int,
        estimated_cost_usd: float,
        confidence: float,
        would_exceed_budget: bool,
        block_reason: str | None,
        reasoning: dict[str, Any] | None,
    ) -> None:
        self.agent_name = agent_name
        self.model = model
        self.provider = provider
        self.estimated_tokens_in = estimated_tokens_in
        self.estimated_tokens_out = estimated_tokens_out
        self.estimated_cost_usd = estimated_cost_usd
        self.confidence = confidence
        self.would_exceed_budget = would_exceed_budget
        self.block_reason = block_reason
        self.reasoning = reasoning


class BudgetResult:
    """A per-agent budget policy."""

    __slots__ = (
        "agent_name",
        "max_cost_usd_per_day",
        "max_cost_usd_per_run",
        "max_runs_per_day",
        "tool_limits",
        "hard_fail",
        "notify_at_pct",
    )

    def __init__(
        self,
        *,
        agent_name: str,
        max_cost_usd_per_day: float | None = None,
        max_cost_usd_per_run: float | None = None,
        max_runs_per_day: int | None = None,
        tool_limits: dict[str, int] | None = None,
        hard_fail: bool = False,
        notify_at_pct: int | None = None,
    ) -> None:
        self.agent_name = agent_name
        self.max_cost_usd_per_day = max_cost_usd_per_day
        self.max_cost_usd_per_run = max_cost_usd_per_run
        self.max_runs_per_day = max_runs_per_day
        self.tool_limits = tool_limits
        self.hard_fail = hard_fail
        self.notify_at_pct = notify_at_pct

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BudgetResult:
        return cls(
            agent_name=d.get("agentName", ""),
            max_cost_usd_per_day=d.get("maxCostUsdPerDay"),
            max_cost_usd_per_run=d.get("maxCostUsdPerRun"),
            max_runs_per_day=d.get("maxRunsPerDay"),
            tool_limits=d.get("toolLimits"),
            hard_fail=d.get("hardFail", False),
            notify_at_pct=d.get("notifyAtPct"),
        )


class EvalRunResult:
    """Server-side score and regression flag for an eval run."""

    __slots__ = ("id", "passed", "score", "cases_total", "cases_passed", "regressed", "baseline_score")

    def __init__(
        self,
        *,
        id: str,
        passed: bool,
        score: float,
        cases_total: int,
        cases_passed: int,
        regressed: bool,
        baseline_score: float | None,
    ) -> None:
        self.id = id
        self.passed = passed
        self.score = score
        self.cases_total = cases_total
        self.cases_passed = cases_passed
        self.regressed = regressed
        self.baseline_score = baseline_score

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EvalRunResult:
        return cls(
            id=d.get("id", ""),
            passed=d.get("passed", False),
            score=d.get("score", 0.0),
            cases_total=d.get("casesTotal", 0),
            cases_passed=d.get("casesPassed", 0),
            regressed=d.get("regressed", False),
            baseline_score=d.get("baselineScore"),
        )


class ReceiptVerifyResult:
    """Result of verifying a signed run receipt."""

    __slots__ = ("valid", "reason", "run_id", "issued_at", "tenant_id")

    def __init__(
        self,
        *,
        valid: bool,
        reason: str | None,
        run_id: str | None,
        issued_at: str | None,
        tenant_id: str | None,
    ) -> None:
        self.valid = valid
        self.reason = reason
        self.run_id = run_id
        self.issued_at = issued_at
        self.tenant_id = tenant_id


class FeedbackSummary:
    """Aggregate feedback summary for an agent."""

    __slots__ = (
        "agent_name",
        "total_feedback",
        "avg_score",
        "thumbs_up",
        "thumbs_down",
        "runs_with_preferred_output",
        "last_7_days_avg_score",
    )

    def __init__(
        self,
        *,
        agent_name: str,
        total_feedback: int,
        avg_score: float,
        thumbs_up: int,
        thumbs_down: int,
        runs_with_preferred_output: int,
        last_7_days_avg_score: float,
    ) -> None:
        self.agent_name = agent_name
        self.total_feedback = total_feedback
        self.avg_score = avg_score
        self.thumbs_up = thumbs_up
        self.thumbs_down = thumbs_down
        self.runs_with_preferred_output = runs_with_preferred_output
        self.last_7_days_avg_score = last_7_days_avg_score


class RehearseResponse:
    """Synthetic test set returned for rehearsal."""

    __slots__ = ("agent_name", "window", "cases", "count", "reason")

    def __init__(
        self,
        *,
        agent_name: str,
        window: str,
        cases: list[dict[str, Any]],
        count: int,
        reason: str | None,
    ) -> None:
        self.agent_name = agent_name
        self.window = window
        self.cases = cases
        self.count = count
        self.reason = reason


