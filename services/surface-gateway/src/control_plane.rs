//! Minimal gRPC client for the control-plane RunService.
//!
//! Mirrors services/gateway/src/grpc.rs in structure:
//!   - hand-rolled prost message stubs (no build.rs / protoc)
//!   - `x-lantern-service-token` metadata on every call (invariant #7)
//!   - `tenant_id` metadata so the interceptor chain can enforce RLS
//!
//! CONTROL_PLANE_ADDR must point to the gRPC port (:50051), not the REST
//! port (:8080).  LANTERN_GRPC_SERVICE_TOKEN must match the control-plane's
//! configured value in production (fail-closed on the server side).

use prost::Message;
use prost_types::Struct;
use tonic::Request;
use tonic::transport::Channel;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Proto stubs — tags must match gen/go/lantern/v1/runs.pb.go
// ---------------------------------------------------------------------------

/// TRIGGER_KIND_SURFACE = 4 (see lantern/v1/runs.proto)
const TRIGGER_KIND_SURFACE: i32 = 4;

#[derive(Clone, PartialEq, Message)]
struct CreateRunRequest {
    #[prost(string, tag = "1")]
    agent_name: String,
    /// Protobuf-encoded google.protobuf.Struct (see struct_to_bytes).
    #[prost(bytes = "vec", tag = "2")]
    input: Vec<u8>,
    #[prost(int32, tag = "3")]
    trigger_kind: i32,
    /// Lantern session UUID (groups run under the surface conversation).
    #[prost(string, tag = "8")]
    session_id: String,
}

/// We only need the run id from the response; other Run fields are ignored.
#[derive(Clone, PartialEq, Message)]
struct CreateRunResponse {
    #[prost(string, tag = "1")]
    id: String,
}

#[derive(Clone, PartialEq, Message)]
struct SignalRunRequest {
    #[prost(string, tag = "1")]
    run_id: String,
    #[prost(string, tag = "2")]
    signal_name: String,
    /// Protobuf-encoded google.protobuf.Struct.
    #[prost(bytes = "vec", tag = "3")]
    value: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct SignalRunResponse {}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// gRPC client for the subset of RunService the surface-gateway needs.
pub struct ControlPlaneClient {
    channel: Channel,
    service_token: String,
}

impl ControlPlaneClient {
    /// Connect (lazily) to the control-plane gRPC address.
    ///
    /// Uses `connect_lazy` so startup is instant and dial errors surface on
    /// the first RPC call rather than at process boot.
    pub async fn connect(addr: &str, service_token: String) -> anyhow::Result<Self> {
        let endpoint = tonic::transport::Endpoint::from_shared(addr.to_string())
            .map_err(|e| anyhow::anyhow!("invalid CONTROL_PLANE_ADDR {addr:?}: {e}"))?;
        let channel = endpoint.connect_lazy();

        if service_token.is_empty() {
            tracing::warn!(
                addr,
                "LANTERN_GRPC_SERVICE_TOKEN is unset — no service token on control-plane \
                 gRPC calls (acceptable in dev; required in production per invariant #7)"
            );
        }

        Ok(Self {
            channel,
            service_token,
        })
    }

    /// Stamp `tenant_id` and `x-lantern-service-token` onto a request's metadata.
    fn inject_metadata<T>(&self, req: &mut Request<T>, tenant_id: &str) {
        let md = req.metadata_mut();
        if let Ok(val) = tenant_id.parse() {
            md.insert("tenant_id", val);
        }
        if !self.service_token.is_empty()
            && let Ok(val) = self.service_token.parse()
        {
            md.insert("x-lantern-service-token", val);
        }
    }

    /// Create a surface-triggered run. Returns the new run_id.
    ///
    /// `input_text` is wrapped in `{"text": ...}` so the inline executor's
    /// key scan (`"text"` is first preference) delivers the user's message to
    /// the agent.
    pub async fn create_run(
        &self,
        tenant_id: &str,
        agent_name: &str,
        session_id: &str,
        input_text: &str,
    ) -> Result<String, AppError> {
        let input = struct_to_bytes(&[("text", input_text)])?;
        let mut request = Request::new(CreateRunRequest {
            agent_name: agent_name.to_string(),
            input,
            trigger_kind: TRIGGER_KIND_SURFACE,
            session_id: session_id.to_string(),
        });
        self.inject_metadata(&mut request, tenant_id);

        let path = http::uri::PathAndQuery::from_static("/lantern.v1.RunService/CreateRun");
        let mut grpc = tonic::client::Grpc::new(self.channel.clone());
        grpc.ready()
            .await
            .map_err(|e| AppError::Upstream(format!("control-plane gRPC not ready: {e}")))?;
        let codec = tonic::codec::ProstCodec::<CreateRunRequest, CreateRunResponse>::default();
        let run = grpc
            .unary(request, path, codec)
            .await
            .map_err(|s| {
                AppError::Upstream(format!(
                    "RunService/CreateRun failed ({:?}): {}",
                    s.code(),
                    s.message()
                ))
            })?
            .into_inner();

        if run.id.is_empty() {
            return Err(AppError::Upstream(
                "RunService/CreateRun returned empty run id".to_string(),
            ));
        }
        Ok(run.id)
    }

    /// Signal an active run with a named signal and string key-value payload.
    ///
    /// The control-plane `SignalRun` RPC is not yet implemented (returns
    /// `Unimplemented`) — this call will fail with an `Upstream` error that
    /// the caller logs.  The gRPC call is still correct and authenticated so
    /// it will work once the server side is wired.
    // ponytail: SignalRun is Unimplemented server-side; this call is the correct
    // contract — remove the comment when the handler is implemented.
    pub async fn signal_run(
        &self,
        tenant_id: &str,
        run_id: &str,
        signal_name: &str,
        fields: &[(&str, &str)],
    ) -> Result<(), AppError> {
        let value = struct_to_bytes(fields)?;
        let mut request = Request::new(SignalRunRequest {
            run_id: run_id.to_string(),
            signal_name: signal_name.to_string(),
            value,
        });
        self.inject_metadata(&mut request, tenant_id);

        let path = http::uri::PathAndQuery::from_static("/lantern.v1.RunService/SignalRun");
        let mut grpc = tonic::client::Grpc::new(self.channel.clone());
        grpc.ready()
            .await
            .map_err(|e| AppError::Upstream(format!("control-plane gRPC not ready: {e}")))?;
        let codec = tonic::codec::ProstCodec::<SignalRunRequest, SignalRunResponse>::default();
        grpc.unary(request, path, codec).await.map_err(|s| {
            AppError::Upstream(format!(
                "RunService/SignalRun failed ({:?}): {}",
                s.code(),
                s.message()
            ))
        })?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/// Encode a list of string key-value pairs as a protobuf google.protobuf.Struct.
///
/// The output bytes are the proto-binary encoding of the Struct message, not JSON.
/// They are sent as field tag `bytes = "vec"` in the gRPC request message, where
/// the proto schema expects `google.protobuf.Struct`.  The Go server's `GetInput()`
/// will successfully unmarshal these as a `*structpb.Struct`.
pub(crate) fn struct_to_bytes(fields: &[(&str, &str)]) -> Result<Vec<u8>, AppError> {
    use prost_types::{Value, value::Kind};
    let s = Struct {
        fields: fields
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string(),
                    Value {
                        kind: Some(Kind::StringValue(v.to_string())),
                    },
                )
            })
            .collect(),
    };
    let mut buf = Vec::new();
    s.encode(&mut buf)
        .map_err(|e| AppError::Internal(format!("struct_to_bytes encode: {e}")))?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;
    use prost_types::{Struct, value::Kind};

    /// struct_to_bytes must produce valid proto that round-trips through prost.
    #[test]
    fn struct_to_bytes_roundtrip_single_field() {
        let bytes = struct_to_bytes(&[("text", "hello world")]).unwrap();
        let decoded = Struct::decode(bytes.as_slice()).unwrap();
        let val = decoded
            .fields
            .get("text")
            .expect("field 'text' must be present");
        assert_eq!(
            val.kind,
            Some(Kind::StringValue("hello world".to_string())),
            "string value must survive encode/decode"
        );
    }

    #[test]
    fn struct_to_bytes_multiple_fields() {
        let bytes = struct_to_bytes(&[("request_id", "r-42"), ("approved", "true")]).unwrap();
        let decoded = Struct::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.fields.len(), 2, "both fields must be present");
        assert!(decoded.fields.contains_key("request_id"));
        assert!(decoded.fields.contains_key("approved"));
    }

    #[test]
    fn struct_to_bytes_empty_is_valid_proto() {
        // Empty struct encodes to 0 bytes, which is a valid proto message.
        let bytes = struct_to_bytes(&[]).unwrap();
        Struct::decode(bytes.as_slice()).expect("empty struct must decode");
    }

    /// CreateRunRequest: verify agent_name (tag 1), trigger_kind (tag 3),
    /// and session_id (tag 8) survive a proto encode/decode round-trip.
    #[test]
    fn create_run_request_field_tags() {
        let req = CreateRunRequest {
            agent_name: "my-agent".to_string(),
            input: vec![],
            trigger_kind: TRIGGER_KIND_SURFACE,
            session_id: "sess-00000001".to_string(),
        };
        let buf = req.encode_to_vec();
        let decoded = CreateRunRequest::decode(buf.as_slice()).unwrap();
        assert_eq!(decoded.agent_name, "my-agent");
        assert_eq!(decoded.trigger_kind, 4, "TRIGGER_KIND_SURFACE must be 4");
        assert_eq!(decoded.session_id, "sess-00000001");
    }

    /// SignalRunRequest: run_id (tag 1) and signal_name (tag 2) must survive.
    #[test]
    fn signal_run_request_field_tags() {
        let req = SignalRunRequest {
            run_id: "run-abc123".to_string(),
            signal_name: "surface_message".to_string(),
            value: vec![],
        };
        let buf = req.encode_to_vec();
        let decoded = SignalRunRequest::decode(buf.as_slice()).unwrap();
        assert_eq!(decoded.run_id, "run-abc123");
        assert_eq!(decoded.signal_name, "surface_message");
    }

    /// The input bytes embedded in a CreateRunRequest must decode as a valid Struct.
    #[test]
    fn create_run_input_embedding() {
        let input_bytes = struct_to_bytes(&[("text", "what is the weather?")]).unwrap();
        let req = CreateRunRequest {
            agent_name: "weather-agent".to_string(),
            input: input_bytes,
            trigger_kind: TRIGGER_KIND_SURFACE,
            session_id: String::new(),
        };
        let buf = req.encode_to_vec();
        let decoded = CreateRunRequest::decode(buf.as_slice()).unwrap();
        // The embedded input bytes must still decode as a valid Struct.
        let s = Struct::decode(decoded.input.as_slice()).unwrap();
        let val = s.fields.get("text").unwrap();
        assert_eq!(
            val.kind,
            Some(Kind::StringValue("what is the weather?".to_string()))
        );
    }
}
