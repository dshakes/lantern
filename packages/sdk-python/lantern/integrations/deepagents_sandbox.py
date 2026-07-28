"""Lantern microVM sandbox backend for the `deepagents` agent harness.

Gives a deepagents agent an ``execute`` tool (plus the derived filesystem
tools: ls/read/write/edit/glob/grep) backed by a Lantern Firecracker microVM
instead of a local shell — egress allowlist, secret vending, and tenant quota
all enforced by the Lantern runtime (invariant #5: untrusted code runs in a
microVM).

Usage::

    from deepagents import create_deep_agent
    from lantern.integrations.deepagents_sandbox import LanternSandbox

    with LanternSandbox.create(image_digest="sha256:...") as sandbox:
        agent = create_deep_agent(backend=sandbox)
        agent.invoke({"messages": [{"role": "user", "content": "run the tests"}]})

Composes with deepagents' own ``CompositeBackend`` — e.g. mount a
``StoreBackend`` at ``/memories/`` for state that outlives the VM, while
everything else executes inside the microVM.

Requires ``pip install lantern-sdk[deepagents]``.
"""

from __future__ import annotations

import base64
import shlex
from typing import Any

from deepagents.backends.protocol import (
    FILE_NOT_FOUND,
    IS_DIRECTORY,
    PERMISSION_DENIED,
    ExecuteResponse,
    FileDownloadResponse,
    FileUploadResponse,
)
from deepagents.backends.sandbox import BaseSandbox

from .runtime_client import LanternRuntimeClient

__all__ = ["LanternSandbox"]


def _classify(stderr: str) -> str:
    low = stderr.lower()
    if "no such file" in low:
        return FILE_NOT_FOUND
    if "is a directory" in low:
        return IS_DIRECTORY
    if "permission denied" in low:
        return PERMISSION_DENIED
    return FILE_NOT_FOUND


class LanternSandbox(BaseSandbox):
    """deepagents ``SandboxBackendProtocol`` over a Lantern microVM.

    All filesystem operations are derived by ``BaseSandbox`` from the three
    primitives below, each of which round-trips through
    ``POST /v1/runtime/vms/{id}/exec``.
    """

    def __init__(self, client: LanternRuntimeClient, vm_id: str, *, owns_vm: bool = False) -> None:
        super().__init__()
        self._client = client
        self._vm_id = vm_id
        self._owns_vm = owns_vm

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    @classmethod
    def create(
        cls,
        *,
        image_digest: str,
        base_url: str | None = None,
        api_key: str | None = None,
        isolation: str = "firecracker",
        wait_timeout: float = 120.0,
        **spec: Any,
    ) -> LanternSandbox:
        """Schedule a fresh microVM and return a sandbox bound to it.

        Extra ``spec`` kwargs pass through to ``/v1/runtime/schedule``
        (``labels``, ``limits``, ``egressRules``, ``secrets``, ...).
        """
        client = LanternRuntimeClient(base_url, api_key)
        placed = client.schedule(image_digest, isolation=isolation, **spec)
        vm_id = placed["vmId"]
        if not placed.get("stub"):
            client.wait_running(vm_id, timeout=wait_timeout)
        return cls(client, vm_id, owns_vm=True)

    @classmethod
    def connect(cls, vm_id: str, *, base_url: str | None = None, api_key: str | None = None) -> LanternSandbox:
        """Attach to an already-running VM (does not terminate it on close)."""
        return cls(LanternRuntimeClient(base_url, api_key), vm_id)

    def close(self) -> None:
        try:
            if self._owns_vm:
                self._client.terminate(self._vm_id)
        finally:
            self._client.close()

    def __enter__(self) -> LanternSandbox:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    # SandboxBackendProtocol primitives
    # ------------------------------------------------------------------

    @property
    def id(self) -> str:
        return f"lantern:{self._vm_id}"

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        # timeout is enforced VM-side by the harness exec channel; the HTTP
        # client's own timeout is the client-side backstop.
        stdout, stderr, exit_code = self._client.exec(self._vm_id, command)
        output = stdout if not stderr else (f"{stdout}\n{stderr}" if stdout else stderr)
        return ExecuteResponse(output=output, exit_code=exit_code)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        # ponytail: content travels base64-inline over the exec channel — fine
        # for agent-sized files; switch to an S3 presigned-upload endpoint if
        # multi-MB transfers show up.
        results: list[FileUploadResponse] = []
        for path, content in files:
            try:
                b64 = base64.b64encode(content).decode("ascii")
                parent = shlex.quote(path.rsplit("/", 1)[0] or "/")
                cmd = f"mkdir -p {parent} && printf '%s' {b64} | base64 -d > {shlex.quote(path)}"
                _, stderr, exit_code = self._client.exec(self._vm_id, cmd)
                error = _classify(stderr) if exit_code != 0 else None
                results.append(FileUploadResponse(path=path, error=error))
            except Exception:
                results.append(FileUploadResponse(path=path, error=PERMISSION_DENIED))
        return results

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        results: list[FileDownloadResponse] = []
        for path in paths:
            try:
                q = shlex.quote(path)
                cmd = f"if [ -d {q} ]; then echo 'Is a directory' >&2; exit 1; fi; base64 < {q}"
                stdout, stderr, exit_code = self._client.exec(self._vm_id, cmd)
                if exit_code != 0:
                    results.append(FileDownloadResponse(path=path, content=None, error=_classify(stderr)))
                else:
                    content = base64.b64decode("".join(stdout.split()))
                    results.append(FileDownloadResponse(path=path, content=content, error=None))
            except Exception:
                results.append(FileDownloadResponse(path=path, content=None, error=FILE_NOT_FOUND))
        return results
