"""Tests for the deepagents sandbox integration.

Two layers:

1. ``LanternRuntimeClient`` HTTP contract — always runs (httpx MockTransport,
   no deepagents needed).
2. ``LanternSandbox`` protocol conformance — skipped unless ``deepagents`` is
   installed (optional extra). Drives BaseSandbox's *derived* filesystem ops
   (write/read/ls/glob) through our three primitives, with exec routed to a
   local subprocess standing in for the microVM's exec channel.
"""

from __future__ import annotations

import json
import subprocess

import httpx
import pytest

from lantern.errors import LanternApiError
from lantern.integrations.runtime_client import LanternRuntimeClient

# ----------------------------------------------------------------------
# Layer 1: HTTP contract
# ----------------------------------------------------------------------


def _client(handler) -> LanternRuntimeClient:
    return LanternRuntimeClient("https://api.test", "key-123", transport=httpx.MockTransport(handler))


def test_schedule_and_exec_contract():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/runtime/schedule":
            body = json.loads(request.content)
            assert body["imageDigest"] == "sha256:abc"
            assert body["isolation"] == "firecracker"
            return httpx.Response(200, json={"vmId": "vm-1", "node": "n1", "az": "a", "stub": True})
        if request.url.path == "/v1/runtime/vms/vm-1/exec":
            # Lantern's exec is execve-style (command = executable, argv = args),
            # so a bare shell line must be wrapped in /bin/sh -c.
            assert json.loads(request.content) == {"command": "/bin/sh", "argv": ["-c", "echo hi"]}
            return httpx.Response(200, json={"stdout": "hi\n", "stderr": "", "exitCode": 0})
        raise AssertionError(f"unexpected {request.url.path}")

    c = _client(handler)
    placed = c.schedule("sha256:abc", isolation="firecracker")
    assert placed["vmId"] == "vm-1"
    assert c.exec("vm-1", "echo hi") == ("hi\n", "", 0)
    assert all(r.headers["Authorization"] == "Bearer key-123" for r in seen)


def test_terminate_sends_grace_param():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert request.url.path == "/v1/runtime/vms/vm-9"
        assert request.url.params["grace"] == "10s"
        return httpx.Response(204)

    _client(handler).terminate("vm-9", grace="10s")


def test_get_vm_unwraps_detail_envelope():
    """GET /v1/runtime/vms/{id} really returns {"vm": {...}, "events": [...]}.

    Regression: the client used to read `state` off the envelope, so it was
    always None and wait_running() spun until it timed out.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"vm": {"vmId": "vm-2", "state": "running"}, "events": [{"action": "schedule"}]},
        )

    vm = _client(handler).get_vm("vm-2")
    assert vm["state"] == "running"
    assert vm["vmId"] == "vm-2"


def test_wait_running_polls_then_returns():
    states = iter(["pending", "spawning", "running"])

    def handler(request: httpx.Request) -> httpx.Response:
        # Real detail-endpoint envelope, not a flattened row.
        return httpx.Response(200, json={"vm": {"vmId": "vm-2", "state": next(states)}, "events": []})

    vm = _client(handler).wait_running("vm-2", timeout=5, poll_interval=0)
    assert vm["state"] == "running"


def test_wait_running_raises_on_terminal_state():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"vm": {"vmId": "vm-3", "state": "failed", "stateReason": "oom"}, "events": []})

    with pytest.raises(RuntimeError, match="oom"):
        _client(handler).wait_running("vm-3", timeout=5, poll_interval=0)


def test_exec_with_explicit_argv_is_not_shell_wrapped():
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content) == {"command": "python3", "argv": ["-c", "print(1)"]}
        return httpx.Response(200, json={"stdout": "1\n", "stderr": "", "exitCode": 0})

    assert _client(handler).exec("vm-1", "python3", ["-c", "print(1)"]) == ("1\n", "", 0)


def test_api_error_surfaces_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, text="quota exceeded")

    with pytest.raises(LanternApiError):
        _client(handler).schedule("sha256:abc")


# ----------------------------------------------------------------------
# Layer 2: BaseSandbox conformance (optional dep)
# ----------------------------------------------------------------------


class _LocalExecClient:
    """Stands in for LanternRuntimeClient: exec runs in a local shell."""

    def exec(self, vm_id: str, command: str) -> tuple[str, str, int]:
        p = subprocess.run(command, shell=True, capture_output=True, text=True)
        return p.stdout, p.stderr, p.returncode

    def terminate(self, vm_id: str, *, grace: str = "30s") -> None:
        pass

    def close(self) -> None:
        pass


@pytest.fixture
def sandbox(tmp_path):
    pytest.importorskip("deepagents")
    from lantern.integrations.deepagents_sandbox import LanternSandbox

    sb = LanternSandbox(_LocalExecClient(), "vm-local")
    sb._root = str(tmp_path)  # test-only: absolute paths under tmp_path
    return sb


def test_execute_combines_output(sandbox):
    r = sandbox.execute("echo out; echo err >&2; exit 3")
    assert "out" in r.output and "err" in r.output
    assert r.exit_code == 3


def test_upload_download_roundtrip_binary(sandbox):
    path = f"{sandbox._root}/sub/dir/blob.bin"
    payload = bytes(range(256))
    [up] = sandbox.upload_files([(path, payload)])
    assert up.error is None
    [down] = sandbox.download_files([path])
    assert down.error is None
    assert down.content == payload


def test_download_missing_and_directory(sandbox):
    missing, isdir = sandbox.download_files([f"{sandbox._root}/nope.txt", sandbox._root])
    assert missing.error == "file_not_found"
    assert isdir.error == "is_directory"


def test_derived_write_read_ls(sandbox):
    """BaseSandbox-derived ops work end-to-end through our primitives."""
    path = f"{sandbox._root}/notes.txt"
    w = sandbox.write(path, "hello lantern\n")
    assert w.error is None
    r = sandbox.read(path)
    assert r.error is None
    assert "hello lantern" in r.file_data["content"]
    listing = sandbox.ls(sandbox._root)
    assert listing.error is None
    assert any(f["path"].endswith("notes.txt") for f in listing.entries)


def test_id_is_namespaced(sandbox):
    assert sandbox.id == "lantern:vm-local"
