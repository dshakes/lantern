"""Tests for LanternClient — endpoint correctness and parity methods.

Uses httpx's MockTransport so no real server is needed.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from lantern.client import LanternClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _MockTransport(httpx.AsyncBaseTransport):
    """Record every request and return a canned response."""

    def __init__(self, status: int = 200, body: Any = None) -> None:
        self._status = status
        self._body = body
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        content = json.dumps(self._body).encode() if self._body is not None else b""
        return httpx.Response(self._status, content=content, headers={"content-type": "application/json"})


def _client(transport: _MockTransport) -> LanternClient:
    c = LanternClient(base_url="https://api.example.com", api_key="test-key")
    # Inject a pre-built async client with our mock transport
    c._client = httpx.AsyncClient(
        base_url="https://api.example.com",
        transport=transport,
        headers=c._headers(),
    )
    return c


def _last(transport: _MockTransport) -> httpx.Request:
    return transport.requests[-1]


# ---------------------------------------------------------------------------
# Bug fix #1: connectors.execute — correct path and action query param
# ---------------------------------------------------------------------------


class TestConnectorExecute:
    async def test_uses_execute_path_not_actions_path(self):
        t = _MockTransport(body={"success": True, "data": {}, "error": None})
        c = _client(t)
        await c.connectors.execute("slack", "send_message", params={"text": "hi"})
        req = _last(t)
        # Must hit /v1/connectors/{id}/execute, not /v1/connectors/{id}/actions/{action}
        assert req.url.path == "/v1/connectors/slack/execute"

    async def test_action_is_query_param_not_path_segment(self):
        t = _MockTransport(body={"success": True, "data": {}, "error": None})
        c = _client(t)
        await c.connectors.execute("github", "create_issue", params={"title": "bug"})
        req = _last(t)
        assert req.url.params["action"] == "create_issue"
        assert "create_issue" not in req.url.path

    async def test_method_is_post(self):
        t = _MockTransport(body={"success": True, "data": {}, "error": None})
        c = _client(t)
        await c.connectors.execute("slack", "send_message")
        assert _last(t).method == "POST"

    async def test_params_sent_in_body(self):
        t = _MockTransport(body={"success": True, "data": {}, "error": None})
        c = _client(t)
        await c.connectors.execute("slack", "post_message", params={"channel": "#dev", "text": "hello"})
        body = json.loads(_last(t).content)
        assert body["params"]["channel"] == "#dev"
        assert body["params"]["text"] == "hello"


# ---------------------------------------------------------------------------
# Bug fix #2: sessions.close/delete — correct verb (DELETE, not POST)
# ---------------------------------------------------------------------------


class TestSessionDelete:
    async def test_delete_uses_delete_method(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.sessions.delete("sess-123")
        assert _last(t).method == "DELETE"

    async def test_delete_hits_correct_path(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.sessions.delete("sess-abc")
        assert _last(t).url.path == "/v1/sessions/sess-abc"

    async def test_close_alias_also_uses_delete(self):
        """close() is a backward-compat alias; must also use DELETE."""
        t = _MockTransport(status=204)
        c = _client(t)
        await c.sessions.close("sess-xyz")
        req = _last(t)
        assert req.method == "DELETE"
        assert req.url.path == "/v1/sessions/sess-xyz"

    async def test_stop_uses_post_to_stop_path(self):
        """stop() is a separate operation — POST /v1/sessions/{id}/stop."""
        t = _MockTransport(body={"status": "stopped"})
        c = _client(t)
        await c.sessions.stop("sess-789")
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/sessions/sess-789/stop"


# ---------------------------------------------------------------------------
# Budget parity methods
# ---------------------------------------------------------------------------


class TestBudgets:
    async def test_upsert_uses_put(self):
        t = _MockTransport(body={"agentName": "my-agent", "hardFail": False})
        c = _client(t)
        await c.budgets.upsert("my-agent", max_cost_usd_per_day=10.0, hard_fail=False)
        assert _last(t).method == "PUT"
        assert _last(t).url.path == "/v1/agents/my-agent/budget"

    async def test_upsert_sends_fields(self):
        t = _MockTransport(body={"agentName": "a", "hardFail": True})
        c = _client(t)
        await c.budgets.upsert("a", max_cost_usd_per_run=5.0, hard_fail=True)
        body = json.loads(_last(t).content)
        assert body["maxCostUsdPerRun"] == 5.0
        assert body["hardFail"] is True

    async def test_get_uses_get(self):
        t = _MockTransport(body={"agentName": "a", "hardFail": False})
        c = _client(t)
        await c.budgets.get("a")
        assert _last(t).method == "GET"
        assert _last(t).url.path == "/v1/agents/a/budget"

    async def test_delete_uses_delete(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.budgets.delete("a")
        assert _last(t).method == "DELETE"
        assert _last(t).url.path == "/v1/agents/a/budget"

    async def test_list_all_uses_get_budgets(self):
        t = _MockTransport(body=[])
        c = _client(t)
        await c.budgets.list_all()
        assert _last(t).method == "GET"
        assert _last(t).url.path == "/v1/budgets"


# ---------------------------------------------------------------------------
# Cost forecast parity method
# ---------------------------------------------------------------------------


class TestForecast:
    async def test_forecast_posts_to_runs_forecast(self):
        t = _MockTransport(
            body={
                "agentName": "a",
                "model": "gpt-4o",
                "provider": "openai",
                "estimatedTokensIn": 100,
                "estimatedTokensOut": 50,
                "estimatedCostUsd": 0.002,
                "confidence": 0.9,
                "wouldExceedBudget": False,
            }
        )
        c = _client(t)
        result = await c.runs.forecast("a", "hello")
        assert _last(t).method == "POST"
        assert _last(t).url.path == "/v1/runs/forecast"
        assert result.estimated_cost_usd == 0.002
        assert result.would_exceed_budget is False

    async def test_forecast_body_fields(self):
        t = _MockTransport(body={"agentName": "x", "wouldExceedBudget": True, "blockReason": "over daily limit"})
        c = _client(t)
        result = await c.runs.forecast("x", "some input")
        body = json.loads(_last(t).content)
        assert body["agentName"] == "x"
        assert body["input"] == "some input"
        assert result.would_exceed_budget is True
        assert result.block_reason == "over daily limit"


# ---------------------------------------------------------------------------
# Eval suite + run + baseline parity methods
# ---------------------------------------------------------------------------


class TestEvals:
    async def test_upsert_suite_posts(self):
        t = _MockTransport(body={"id": "suite-1"})
        c = _client(t)
        suite_id = await c.evals.upsert_suite("my-agent", "smoke", [])
        assert suite_id == "suite-1"
        assert _last(t).method == "POST"
        assert _last(t).url.path == "/v1/eval-suites"

    async def test_record_run_posts(self):
        t = _MockTransport(
            body={
                "id": "run-1",
                "passed": True,
                "score": 0.95,
                "casesTotal": 5,
                "casesPassed": 5,
                "regressed": False,
            }
        )
        c = _client(t)
        result = await c.evals.record_run("suite-1", [], agent_version="v1", branch="main")
        assert result.passed is True
        assert result.score == 0.95
        assert _last(t).url.path == "/v1/eval-runs"

    async def test_set_baseline_posts(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.evals.set_baseline("my-agent", "main", "run-1")
        body = json.loads(_last(t).content)
        assert body["agentName"] == "my-agent"
        assert body["branch"] == "main"
        assert body["evalRunId"] == "run-1"
        assert _last(t).url.path == "/v1/eval-baselines"


# ---------------------------------------------------------------------------
# A/B experiments parity methods
# ---------------------------------------------------------------------------


class TestExperiments:
    async def test_create_experiment_posts(self):
        t = _MockTransport(body={"id": "exp-1", "status": "running"})
        c = _client(t)
        result = await c.experiments.create(
            "my-agent",
            "v1-vs-v2",
            variant_a_version="v1",
            variant_b_version="v2",
            traffic_split_b=30,
        )
        assert result["id"] == "exp-1"
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/experiments"
        body = json.loads(req.content)
        assert body["trafficSplitB"] == 30

    async def test_record_outcome_posts(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.experiments.record_outcome("exp-1", "b", 0.87)
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/experiments/exp-1/record"
        body = json.loads(req.content)
        assert body["variant"] == "b"
        assert body["score"] == 0.87

    async def test_conclude_posts(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.experiments.conclude("exp-1", "b", promote=True)
        body = json.loads(_last(t).content)
        assert body["winner"] == "b"
        assert body["promote"] is True


# ---------------------------------------------------------------------------
# Marketplace parity methods
# ---------------------------------------------------------------------------


class TestMarketplace:
    async def test_list_marketplace(self):
        t = _MockTransport(body=[{"slug": "cool-agent"}])
        c = _client(t)
        result = await c.marketplace.list(category="nlp")
        assert result[0]["slug"] == "cool-agent"
        req = _last(t)
        assert req.url.path == "/v1/marketplace"
        assert req.url.params.get("category") == "nlp"

    async def test_publish_posts(self):
        t = _MockTransport(body={"slug": "my-slug"})
        c = _client(t)
        await c.marketplace.publish("my-agent", "my-slug", "utilities", ["tag1"])
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/marketplace/publish"

    async def test_fork_posts(self):
        t = _MockTransport(body={"id": "ag-2", "name": "forked", "created_at": "2024-01-01T00:00:00Z"})
        c = _client(t)
        await c.marketplace.fork("some-slug", "forked")
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/marketplace/some-slug/fork"

    async def test_star_posts(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.marketplace.star("cool-agent")
        assert _last(t).method == "POST"
        assert _last(t).url.path == "/v1/marketplace/cool-agent/star"

    async def test_unstar_deletes(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.marketplace.unstar("cool-agent")
        assert _last(t).method == "DELETE"
        assert _last(t).url.path == "/v1/marketplace/cool-agent/star"


# ---------------------------------------------------------------------------
# MCP server registry parity methods
# ---------------------------------------------------------------------------


class TestMCP:
    async def test_list_servers(self):
        t = _MockTransport(body=[{"slug": "my-mcp"}])
        c = _client(t)
        result = await c.mcp.list_servers()
        assert result[0]["slug"] == "my-mcp"
        assert _last(t).url.path == "/v1/mcp/servers"

    async def test_attach_posts(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.mcp.attach("my-agent", "my-mcp", config={"key": "val"})
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/agents/my-agent/mcp-servers"
        body = json.loads(req.content)
        assert body["slug"] == "my-mcp"

    async def test_detach_deletes(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.mcp.detach("my-agent", "my-mcp")
        req = _last(t)
        assert req.method == "DELETE"
        assert req.url.path == "/v1/agents/my-agent/mcp-servers/my-mcp"


# ---------------------------------------------------------------------------
# Receipt parity methods
# ---------------------------------------------------------------------------


class TestReceipts:
    async def test_issue_posts(self):
        t = _MockTransport(body={"payload": {}, "signature": "abc", "algorithm": "ed25519"})
        c = _client(t)
        result = await c.receipts.issue("run-42")
        assert result["signature"] == "abc"
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/runs/run-42/receipt"

    async def test_verify_posts(self):
        receipt = {"payload": {"runId": "run-42"}, "signature": "sig", "algorithm": "ed25519"}
        t = _MockTransport(body={"valid": True, "runId": "run-42"})
        c = _client(t)
        result = await c.receipts.verify(receipt)
        assert result.valid is True
        assert result.run_id == "run-42"
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/runs/receipts/verify"


# ---------------------------------------------------------------------------
# Run feedback parity methods
# ---------------------------------------------------------------------------


class TestFeedback:
    async def test_submit_posts(self):
        t = _MockTransport(status=204)
        c = _client(t)
        await c.feedback.submit("run-1", score=5, comment="great")
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/runs/run-1/feedback"
        body = json.loads(req.content)
        assert body["score"] == 5
        assert body["comment"] == "great"
        assert body["source"] == "sdk"

    async def test_summary_gets(self):
        t = _MockTransport(
            body={
                "agentName": "a",
                "totalFeedback": 10,
                "avgScore": 4.2,
                "thumbsUp": 8,
                "thumbsDown": 2,
                "runsWithPreferredOutput": 3,
                "last7DaysAvgScore": 4.5,
            }
        )
        c = _client(t)
        result = await c.feedback.summary_for_agent("a")
        assert result.avg_score == 4.2
        assert result.thumbs_up == 8
        req = _last(t)
        assert req.method == "GET"
        assert req.url.path == "/v1/agents/a/feedback"


# ---------------------------------------------------------------------------
# Rehearsals parity methods
# ---------------------------------------------------------------------------


class TestRehearsals:
    async def test_pull_posts_to_rehearse(self):
        t = _MockTransport(
            body={
                "agentName": "a",
                "window": "7d",
                "cases": [],
                "count": 0,
            }
        )
        c = _client(t)
        result = await c.rehearsals.pull("a", window="7d", include_failures=True)
        assert result.agent_name == "a"
        assert result.window == "7d"
        req = _last(t)
        assert req.method == "POST"
        assert req.url.path == "/v1/runs/rehearse"
        body = json.loads(req.content)
        assert body["agentName"] == "a"
        assert body["includeFailures"] is True
