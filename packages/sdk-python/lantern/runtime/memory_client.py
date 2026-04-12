"""Production memory client that talks to the memory service over gRPC.

Provides three memory tiers:
- **core**: Key-value store (tenant/user/agent scoped)
- **recall**: Vector search over recent conversation history
- **archival**: Long-term vector store with explicit add/search
"""

from __future__ import annotations

from typing import Any

from lantern.errors import LanternError
from lantern.types import (
    ArchivalMemory,
    CoreMemory,
    MemoryClient as MemoryClientBase,
    MemoryEntry,
    RecallMemory,
)


class GrpcMemoryClient(MemoryClientBase):
    """Memory client that communicates with the memory service via gRPC."""

    def __init__(self, grpc_endpoint: str, run_id: str, tenant_id: str) -> None:
        super().__init__()
        self._endpoint = grpc_endpoint
        self._run_id = run_id
        self._tenant_id = tenant_id
        self._channel: Any = None

        # Replace default sub-clients with gRPC-backed ones
        self.core = _GrpcCoreMemory(self)
        self.recall = _GrpcRecallMemory(self)
        self.archival = _GrpcArchivalMemory(self)

    async def _ensure_channel(self) -> Any:
        if self._channel is None:
            try:
                import grpc.aio  # type: ignore[import-untyped]
                self._channel = grpc.aio.insecure_channel(self._endpoint)
            except ImportError:
                raise LanternError("grpcio is required for production memory calls")
        return self._channel

    async def _call(self, method: str, params: dict[str, Any]) -> Any:
        """Generic memory service invocation over gRPC."""
        channel = await self._ensure_channel()

        try:
            from google.protobuf import json_format, struct_pb2  # type: ignore[import-untyped]

            request_struct = struct_pb2.Struct()
            json_format.ParseDict(params, request_struct)

            stub = channel.unary_unary(
                f"/lantern.memory.v1.MemoryService/{method}",
                request_serializer=request_struct.SerializeToString,
                response_deserializer=struct_pb2.Struct.FromString,
            )

            metadata = [
                ("x-lantern-tenant-id", self._tenant_id),
                ("x-lantern-run-id", self._run_id),
            ]

            response = await stub(request_struct, metadata=metadata)
            return json_format.MessageToDict(response)

        except Exception as exc:
            if "grpc" in type(exc).__module__:
                raise LanternError(f"Memory gRPC error ({method}): {exc}") from exc
            raise

    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
            self._channel = None


class _GrpcCoreMemory(CoreMemory):
    def __init__(self, client: GrpcMemoryClient) -> None:
        self._client = client

    async def get(self, key: str) -> str | None:
        result = await self._client._call("CoreGet", {"key": key})
        return result.get("value")

    async def set(self, key: str, value: str) -> None:
        await self._client._call("CoreSet", {"key": key, "value": value})


class _GrpcRecallMemory(RecallMemory):
    def __init__(self, client: GrpcMemoryClient) -> None:
        self._client = client

    async def search(self, query: str, *, top_k: int | None = None) -> list[MemoryEntry]:
        params: dict[str, Any] = {"query": query, "tier": "recall"}
        if top_k is not None:
            params["top_k"] = top_k
        result = await self._client._call("Search", params)
        entries = result.get("entries", [])
        return [MemoryEntry.model_validate(e) for e in entries]


class _GrpcArchivalMemory(ArchivalMemory):
    def __init__(self, client: GrpcMemoryClient) -> None:
        self._client = client

    async def search(self, query: str, *, top_k: int | None = None) -> list[MemoryEntry]:
        params: dict[str, Any] = {"query": query, "tier": "archival"}
        if top_k is not None:
            params["top_k"] = top_k
        result = await self._client._call("Search", params)
        entries = result.get("entries", [])
        return [MemoryEntry.model_validate(e) for e in entries]

    async def add(self, text: str, metadata: dict[str, Any] | None = None) -> None:
        params: dict[str, Any] = {"text": text, "tier": "archival"}
        if metadata:
            params["metadata"] = metadata
        await self._client._call("Add", params)
