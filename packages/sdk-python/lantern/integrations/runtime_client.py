"""Thin synchronous client for the Lantern microVM runtime REST surface.

Sync on purpose: agent-framework backend protocols (filesystem/sandbox ops)
are synchronous, and bridging the async ``LanternClient`` into a sync call
site from inside a running event loop is fragile. This client covers only the
four runtime endpoints the sandbox integration needs.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

from ..errors import LanternApiError

_TERMINAL_STATES = {"terminated", "failed"}


class LanternRuntimeClient:
    """Sync client for ``/v1/runtime/*`` (schedule, get, exec, terminate)."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        *,
        timeout: float = 120.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("LANTERN_API_URL") or "https://api.lantern.run").rstrip("/")
        self._api_key = api_key or os.environ.get("LANTERN_API_KEY") or ""
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        self._http = httpx.Client(
            base_url=self.base_url,
            timeout=timeout,
            headers=headers,
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    def _request(self, method: str, path: str, *, json: Any = None, params: dict[str, str] | None = None) -> Any:
        resp = self._http.request(method, path, json=json, params=params)
        if not resp.is_success:
            raise LanternApiError(resp.status_code, resp.text)
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    def schedule(self, image_digest: str, **spec: Any) -> dict[str, Any]:
        """POST /v1/runtime/schedule. Returns {vmId, node, az, stub?, ...}."""
        body = {"imageDigest": image_digest, **spec}
        return self._request("POST", "/v1/runtime/schedule", json=body)

    def get_vm(self, vm_id: str) -> dict[str, Any]:
        """GET /v1/runtime/vms/{id}, normalized to the bare VM row.

        The detail endpoint wraps the row as ``{"vm": {...}, "events": [...]}``
        while the list endpoint returns bare rows; callers (and ``wait_running``)
        want the row either way.
        """
        data = self._request("GET", f"/v1/runtime/vms/{vm_id}")
        if isinstance(data, dict) and isinstance(data.get("vm"), dict):
            return data["vm"]
        return data

    def exec(self, vm_id: str, command: str, argv: list[str] | None = None) -> tuple[str, str, int]:
        """POST /v1/runtime/vms/{id}/exec. Returns (stdout, stderr, exit_code).

        Lantern's exec contract is execve-style: ``command`` is the executable
        and ``argv`` its arguments, with NO implicit shell — matching
        ``lantern vm exec <id> -- <cmd> [args]`` and the in-VM harness. So when
        ``argv`` is omitted we run the string through ``/bin/sh -c``, since the
        sandbox backend emits shell syntax (pipes, redirects, ``&&``).
        """
        if argv is None:
            payload: dict[str, Any] = {"command": "/bin/sh", "argv": ["-c", command]}
        else:
            payload = {"command": command, "argv": argv}
        data = self._request("POST", f"/v1/runtime/vms/{vm_id}/exec", json=payload)
        return data.get("stdout", ""), data.get("stderr", ""), int(data.get("exitCode", 0))

    def terminate(self, vm_id: str, *, grace: str = "30s") -> None:
        self._request("DELETE", f"/v1/runtime/vms/{vm_id}", params={"grace": grace})

    def wait_running(self, vm_id: str, *, timeout: float = 120.0, poll_interval: float = 2.0) -> dict[str, Any]:
        """Poll until the VM reaches ``running``; raise on terminal state or timeout."""
        deadline = time.monotonic() + timeout
        while True:
            vm = self.get_vm(vm_id)
            state = vm.get("state", "")
            if state == "running":
                return vm
            if state in _TERMINAL_STATES:
                raise RuntimeError(f"vm {vm_id} entered state {state!r}: {vm.get('stateReason')}")
            if time.monotonic() >= deadline:
                raise TimeoutError(f"vm {vm_id} not running after {timeout}s (state={state!r})")
            time.sleep(poll_interval)
