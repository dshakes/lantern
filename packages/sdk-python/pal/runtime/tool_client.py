"""Production tool client that executes built-in tools via gRPC.

In the Lantern runtime, tool calls are dispatched to the tool service
which runs them in the appropriate isolation context (e.g. web search
hits the search service, python exec runs in the sandbox, etc.).
"""

from __future__ import annotations

from typing import Any

from lantern.errors import LanternError
from lantern.types import ToolClient as ToolClientBase


class GrpcToolClient(ToolClientBase):
    """Tool client that communicates with the tool service via gRPC."""

    def __init__(self, grpc_endpoint: str, run_id: str, tenant_id: str) -> None:
        super().__init__()
        self._endpoint = grpc_endpoint
        self._run_id = run_id
        self._tenant_id = tenant_id
        self._channel: Any = None

        # Replace the default sub-clients with gRPC-backed ones
        self.web = self._GrpcWeb(self)
        self.python = self._GrpcPython(self)
        self.fs = self._GrpcFs(self)

    async def _ensure_channel(self) -> Any:
        if self._channel is None:
            try:
                import grpc.aio  # type: ignore[import-untyped]
                self._channel = grpc.aio.insecure_channel(self._endpoint)
            except ImportError:
                raise LanternError("grpcio is required for production tool calls")
        return self._channel

    async def _call_tool(self, tool_name: str, action: str, params: dict[str, Any]) -> Any:
        """Generic tool invocation over gRPC."""
        channel = await self._ensure_channel()

        try:
            from google.protobuf import json_format, struct_pb2  # type: ignore[import-untyped]

            request = {
                "tool": tool_name,
                "action": action,
                "params": params,
            }
            request_struct = struct_pb2.Struct()
            json_format.ParseDict(request, request_struct)

            stub = channel.unary_unary(
                "/lantern.tools.v1.ToolService/Execute",
                request_serializer=request_struct.SerializeToString,
                response_deserializer=struct_pb2.Struct.FromString,
            )

            metadata = [
                ("x-lantern-tenant-id", self._tenant_id),
                ("x-lantern-run-id", self._run_id),
            ]

            response = await stub(request_struct, metadata=metadata)
            return json_format.MessageToDict(response).get("result")

        except Exception as exc:
            if "grpc" in type(exc).__module__:
                raise LanternError(f"Tool gRPC error ({tool_name}/{action}): {exc}") from exc
            raise

    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
            self._channel = None

    class _GrpcWeb:
        def __init__(self, client: GrpcToolClient) -> None:
            self._client = client

        async def search(self, query: str) -> Any:
            return await self._client._call_tool("lantern.web", "search", {"query": query})

        async def fetch(self, url: str) -> str:
            result = await self._client._call_tool("lantern.web", "fetch", {"url": url})
            return str(result)

    class _GrpcPython:
        def __init__(self, client: GrpcToolClient) -> None:
            self._client = client

        async def exec(self, code: str) -> Any:
            return await self._client._call_tool("lantern.python", "exec", {"code": code})

    class _GrpcFs:
        def __init__(self, client: GrpcToolClient) -> None:
            self._client = client

        async def read(self, path: str) -> str:
            result = await self._client._call_tool("lantern.fs", "read", {"path": path})
            return str(result)

        async def write(self, path: str, content: str) -> None:
            await self._client._call_tool("lantern.fs", "write", {"path": path, "content": content})
