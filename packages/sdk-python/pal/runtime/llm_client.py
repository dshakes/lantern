"""Production LLM client that talks to the model router over gRPC.

In the Lantern runtime, LLM calls are routed through the model router
which handles caching, routing to concrete models, metering, and
multi-tenant isolation.
"""

from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

from lantern.errors import LanternLlmError
from lantern.types import Capability, LlmClient as LlmClientBase, Message


class GrpcLlmClient(LlmClientBase):
    """LLM client that communicates with the model router via gRPC.

    Initialized with a gRPC channel from the runtime.
    """

    def __init__(self, grpc_endpoint: str, run_id: str, tenant_id: str) -> None:
        self._endpoint = grpc_endpoint
        self._run_id = run_id
        self._tenant_id = tenant_id
        self._channel: Any = None

    async def _ensure_channel(self) -> Any:
        if self._channel is None:
            try:
                import grpc.aio  # type: ignore[import-untyped]
                self._channel = grpc.aio.insecure_channel(self._endpoint)
            except ImportError:
                raise LanternLlmError(
                    "grpcio is required for production runtime LLM calls. "
                    "Install with: pip install grpcio"
                )
        return self._channel

    async def complete(self, **kwargs: Any) -> str:
        """Send a completion request to the model router.

        Keyword Args:
            prompt: Simple string prompt (convenience).
            messages: List of Message dicts for multi-turn.
            capability: Model capability to request.
            optimize: Optimization target.
            tools: Tool definitions for function calling.
            max_tokens: Maximum output tokens.
            temperature: Sampling temperature.
            stop: Stop sequences.
            no_cache: Bypass response cache.
        """
        channel = await self._ensure_channel()

        # Build the gRPC request payload
        request = self._build_request(kwargs)

        try:
            # In production this calls the generated proto stub.
            # For now we use a generic unary call pattern that will be
            # wired to the generated lantern.modelrouter.v1 service.
            from google.protobuf import json_format, struct_pb2  # type: ignore[import-untyped]

            request_struct = struct_pb2.Struct()
            json_format.ParseDict(request, request_struct)

            # The actual gRPC call — stub will be generated from protos
            # lantern.modelrouter.v1.ModelRouter/Complete
            stub = channel.unary_unary(
                "/lantern.modelrouter.v1.ModelRouter/Complete",
                request_serializer=request_struct.SerializeToString,
                response_deserializer=struct_pb2.Struct.FromString,
            )

            metadata = [
                ("x-lantern-tenant-id", self._tenant_id),
                ("x-lantern-run-id", self._run_id),
            ]

            response = await stub(request_struct, metadata=metadata)
            result = json_format.MessageToDict(response)
            return result.get("content", "")

        except Exception as exc:
            if "grpc" in type(exc).__module__:
                raise LanternLlmError(
                    f"Model router gRPC error: {exc}",
                    capability=kwargs.get("capability"),
                ) from exc
            raise

    async def json(self, **kwargs: Any) -> Any:
        """Send a completion request that returns structured JSON."""
        kwargs.setdefault("response_format", "json")
        raw = await self.complete(**kwargs)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LanternLlmError(f"Failed to parse LLM JSON response: {exc}") from exc

    async def stream(self, **kwargs: Any) -> AsyncIterator[str]:
        """Stream tokens from the model router."""
        channel = await self._ensure_channel()
        request = self._build_request(kwargs)

        try:
            from google.protobuf import json_format, struct_pb2  # type: ignore[import-untyped]

            request_struct = struct_pb2.Struct()
            json_format.ParseDict(request, request_struct)

            stub = channel.unary_stream(
                "/lantern.modelrouter.v1.ModelRouter/StreamComplete",
                request_serializer=request_struct.SerializeToString,
                response_deserializer=struct_pb2.Struct.FromString,
            )

            metadata = [
                ("x-lantern-tenant-id", self._tenant_id),
                ("x-lantern-run-id", self._run_id),
            ]

            async for chunk in stub(request_struct, metadata=metadata):
                result = json_format.MessageToDict(chunk)
                delta = result.get("delta", "")
                if delta:
                    yield delta

        except Exception as exc:
            if "grpc" in type(exc).__module__:
                raise LanternLlmError(
                    f"Model router stream gRPC error: {exc}",
                    capability=kwargs.get("capability"),
                ) from exc
            raise

    async def embed(
        self, texts: list[str], capability: Capability | None = None
    ) -> list[list[float]]:
        """Generate embeddings via the model router."""
        channel = await self._ensure_channel()

        try:
            from google.protobuf import json_format, struct_pb2  # type: ignore[import-untyped]

            request = {
                "texts": texts,
                "capability": capability or "embed-large",
            }
            request_struct = struct_pb2.Struct()
            json_format.ParseDict(request, request_struct)

            stub = channel.unary_unary(
                "/lantern.modelrouter.v1.ModelRouter/Embed",
                request_serializer=request_struct.SerializeToString,
                response_deserializer=struct_pb2.Struct.FromString,
            )

            metadata = [
                ("x-lantern-tenant-id", self._tenant_id),
                ("x-lantern-run-id", self._run_id),
            ]

            response = await stub(request_struct, metadata=metadata)
            result = json_format.MessageToDict(response)
            return result.get("embeddings", [])

        except Exception as exc:
            if "grpc" in type(exc).__module__:
                raise LanternLlmError(f"Embed gRPC error: {exc}") from exc
            raise

    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
            self._channel = None

    @staticmethod
    def _build_request(kwargs: dict[str, Any]) -> dict[str, Any]:
        """Convert keyword args to a gRPC request dict."""
        request: dict[str, Any] = {}

        if "prompt" in kwargs:
            request["messages"] = [{"role": "user", "content": kwargs["prompt"]}]
        elif "messages" in kwargs:
            messages = kwargs["messages"]
            request["messages"] = [
                m.model_dump() if hasattr(m, "model_dump") else m
                for m in messages
            ]

        for key in ("capability", "optimize", "max_tokens", "temperature", "stop", "no_cache", "response_format"):
            if key in kwargs and kwargs[key] is not None:
                request[key] = kwargs[key]

        if "tools" in kwargs and kwargs["tools"]:
            request["tools"] = [
                t.model_dump() if hasattr(t, "model_dump") else t
                for t in kwargs["tools"]
            ]

        return request
