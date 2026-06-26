/// Hand-defined protobuf types matching `packages/proto/lantern/v1/models.proto`.
///
/// We define these with prost derive macros rather than running `protoc` so the
/// service can be compiled stand-alone without a protoc toolchain. The field
/// numbers and types are kept in exact correspondence with the `.proto` file.
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, prost::Enumeration, Serialize, Deserialize)]
#[repr(i32)]
pub enum Capability {
    Unspecified = 0,
    ReasoningFrontier = 1,
    ReasoningLarge = 2,
    ReasoningSmall = 3,
    ChatLarge = 4,
    ChatSmall = 5,
    ChatEdge = 6,
    VisionLarge = 7,
    VisionSmall = 8,
    CodeLarge = 9,
    CodeSmall = 10,
    EmbedLarge = 11,
    EmbedSmall = 12,
    Rerank = 13,
    Transcribe = 14,
    Tts = 15,
    Auto = 99,
}

impl Capability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unspecified => "unspecified",
            Self::ReasoningFrontier => "reasoning-frontier",
            Self::ReasoningLarge => "reasoning-large",
            Self::ReasoningSmall => "reasoning-small",
            Self::ChatLarge => "chat-large",
            Self::ChatSmall => "chat-small",
            Self::ChatEdge => "chat-edge",
            Self::VisionLarge => "vision-large",
            Self::VisionSmall => "vision-small",
            Self::CodeLarge => "code-large",
            Self::CodeSmall => "code-small",
            Self::EmbedLarge => "embed-large",
            Self::EmbedSmall => "embed-small",
            Self::Rerank => "rerank",
            Self::Transcribe => "transcribe",
            Self::Tts => "tts",
            Self::Auto => "auto",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, prost::Enumeration, Serialize, Deserialize)]
#[repr(i32)]
pub enum OptimizeTarget {
    Unspecified = 0,
    Cheap = 1,
    Fast = 2,
    Best = 3,
    Balanced = 4,
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct CompleteRequest {
    #[prost(string, tag = "1")]
    pub run_id: String,
    #[prost(string, tag = "2")]
    pub step_id: String,
    #[prost(string, tag = "3")]
    pub tenant_id: String,

    #[prost(enumeration = "Capability", tag = "10")]
    pub capability: i32,
    #[prost(enumeration = "OptimizeTarget", tag = "11")]
    pub optimize: i32,

    #[prost(message, repeated, tag = "20")]
    pub messages: Vec<Message>,
    #[prost(message, repeated, tag = "21")]
    pub tools: Vec<Tool>,
    // response_format is Struct in proto; we use serde_json::Value at the boundary.
    #[prost(bytes = "vec", tag = "22")]
    pub response_format: Vec<u8>,

    #[prost(int32, tag = "30")]
    pub max_tokens: i32,
    #[prost(double, tag = "31")]
    pub temperature: f64,
    #[prost(double, tag = "32")]
    pub top_p: f64,
    #[prost(string, repeated, tag = "33")]
    pub stop: Vec<String>,

    #[prost(bool, tag = "40")]
    pub no_cache: bool,
    #[prost(string, tag = "41")]
    pub idempotency_key: String,

    /// Request-scoped provider credentials: provider id ("openai",
    /// "anthropic") -> API key, supplied per-call by the control-plane (which
    /// holds the tenant's AES-GCM key). When present the router builds a
    /// per-request provider from these; when empty it uses its startup env
    /// provider. INVARIANT #10: these are secrets — NEVER logged or traced.
    /// `#[serde(skip)]` keeps them out of any serde rendering (e.g. cache
    /// keying or accidental debug serialization).
    #[prost(map = "string, string", tag = "42")]
    #[serde(skip)]
    pub provider_credentials: std::collections::HashMap<String, String>,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct Message {
    #[prost(string, tag = "1")]
    pub role: String,
    #[prost(string, tag = "2")]
    pub content: String,
    #[prost(string, tag = "3")]
    pub name: String,
    #[prost(message, repeated, tag = "4")]
    pub tool_calls: Vec<ToolCallMessage>,
    #[prost(string, tag = "5")]
    pub tool_call_id: String,
    #[prost(message, repeated, tag = "6")]
    pub parts: Vec<ContentPart>,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct ContentPart {
    #[prost(oneof = "content_part::Part", tags = "1, 2, 3")]
    pub part: Option<content_part::Part>,
}

pub mod content_part {
    use super::*;

    #[derive(Clone, prost::Oneof, Serialize, Deserialize)]
    pub enum Part {
        #[prost(string, tag = "1")]
        Text(String),
        #[prost(message, tag = "2")]
        Image(super::ImagePart),
        #[prost(message, tag = "3")]
        File(super::FilePart),
    }
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct ImagePart {
    #[prost(string, tag = "1")]
    pub url: String,
    #[prost(bytes = "vec", tag = "2")]
    pub data: Vec<u8>,
    #[prost(string, tag = "3")]
    pub media_type: String,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct FilePart {
    #[prost(string, tag = "1")]
    pub url: String,
    #[prost(bytes = "vec", tag = "2")]
    pub data: Vec<u8>,
    #[prost(string, tag = "3")]
    pub media_type: String,
    #[prost(string, tag = "4")]
    pub filename: String,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct ToolCallMessage {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(string, tag = "3")]
    pub arguments: String,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct Tool {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(string, tag = "2")]
    pub description: String,
    // parameters is Struct in proto; serialized as opaque bytes here.
    #[prost(bytes = "vec", tag = "3")]
    pub parameters: Vec<u8>,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct CompleteResponse {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub model_used: String,
    #[prost(int32, tag = "3")]
    pub tier: i32,

    #[prost(message, optional, tag = "10")]
    pub message: Option<Message>,

    #[prost(int64, tag = "20")]
    pub tokens_in: i64,
    #[prost(int64, tag = "21")]
    pub tokens_out: i64,
    #[prost(double, tag = "22")]
    pub cost_usd: f64,
    #[prost(string, tag = "23")]
    pub cache_kind: String,
    #[prost(bool, tag = "24")]
    pub escalated: bool,
    #[prost(double, tag = "25")]
    pub latency_ms: f64,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct CompleteChunk {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub model_used: String,
    #[prost(int32, tag = "3")]
    pub tier: i32,

    #[prost(oneof = "complete_chunk::Data", tags = "10, 11, 12, 13")]
    pub data: Option<complete_chunk::Data>,
}

pub mod complete_chunk {
    use super::*;

    #[derive(Clone, prost::Oneof, Serialize, Deserialize)]
    pub enum Data {
        #[prost(string, tag = "10")]
        TextDelta(String),
        #[prost(message, tag = "11")]
        ToolCallDelta(super::ToolCallMessage),
        #[prost(message, tag = "12")]
        Usage(super::ChunkUsage),
        #[prost(message, tag = "13")]
        Done(super::ChunkDone),
    }
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct ChunkUsage {
    #[prost(int64, tag = "1")]
    pub tokens_in: i64,
    #[prost(int64, tag = "2")]
    pub tokens_out: i64,
    #[prost(double, tag = "3")]
    pub cost_usd: f64,
    #[prost(string, tag = "4")]
    pub cache_kind: String,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct ChunkDone {
    #[prost(string, tag = "1")]
    pub finish_reason: String,
    #[prost(bool, tag = "2")]
    pub escalated: bool,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct EmbedRequest {
    #[prost(string, tag = "1")]
    pub tenant_id: String,
    #[prost(enumeration = "Capability", tag = "2")]
    pub capability: i32,
    #[prost(string, repeated, tag = "3")]
    pub texts: Vec<String>,

    /// Same request-scoped credential map as CompleteRequest.provider_credentials.
    /// provider id -> API key, supplied per-call by the control-plane; NEVER
    /// logged (invariant #10). Empty -> router uses its startup env provider.
    #[prost(map = "string, string", tag = "4")]
    #[serde(skip)]
    pub provider_credentials: std::collections::HashMap<String, String>,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct EmbedResponse {
    #[prost(message, repeated, tag = "1")]
    pub embeddings: Vec<Embedding>,
    #[prost(string, tag = "2")]
    pub model_used: String,
    #[prost(int64, tag = "3")]
    pub total_tokens: i64,
    #[prost(double, tag = "4")]
    pub cost_usd: f64,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct Embedding {
    #[prost(float, repeated, tag = "1")]
    pub values: Vec<f32>,
    #[prost(int32, tag = "2")]
    pub dimensions: i32,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct TokenizeRequest {
    #[prost(string, tag = "1")]
    pub model_hint: String,
    #[prost(string, tag = "2")]
    pub text: String,
}

#[derive(Clone, prost::Message, Serialize, Deserialize)]
pub struct TokenizeResponse {
    #[prost(int32, tag = "1")]
    pub token_count: i32,
    #[prost(string, tag = "2")]
    pub tokenizer_used: String,
}

// ---------------------------------------------------------------------------
// gRPC service trait (tonic-style)
// ---------------------------------------------------------------------------

#[tonic::async_trait]
pub trait ModelService: Send + Sync + 'static {
    type CompleteStreamStream: tokio_stream::Stream<Item = Result<CompleteChunk, tonic::Status>>
        + Send
        + 'static;

    async fn complete(
        &self,
        request: tonic::Request<CompleteRequest>,
    ) -> Result<tonic::Response<CompleteResponse>, tonic::Status>;

    async fn complete_stream(
        &self,
        request: tonic::Request<CompleteRequest>,
    ) -> Result<tonic::Response<Self::CompleteStreamStream>, tonic::Status>;

    async fn embed(
        &self,
        request: tonic::Request<EmbedRequest>,
    ) -> Result<tonic::Response<EmbedResponse>, tonic::Status>;

    async fn tokenize(
        &self,
        request: tonic::Request<TokenizeRequest>,
    ) -> Result<tonic::Response<TokenizeResponse>, tonic::Status>;
}

/// Generated-style gRPC server wrapper.
pub struct ModelServiceServer<T: ModelService> {
    inner: std::sync::Arc<T>,
}

impl<T: ModelService> ModelServiceServer<T> {
    pub fn new(inner: T) -> Self {
        Self {
            inner: std::sync::Arc::new(inner),
        }
    }
}

impl<T: ModelService> Clone for ModelServiceServer<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<T: ModelService> tonic::codegen::Service<tonic::codegen::http::Request<tonic::body::BoxBody>>
    for ModelServiceServer<T>
{
    type Response = tonic::codegen::http::Response<tonic::body::BoxBody>;
    type Error = std::convert::Infallible;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
    >;

    fn poll_ready(
        &mut self,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: tonic::codegen::http::Request<tonic::body::BoxBody>) -> Self::Future {
        let inner = self.inner.clone();
        let path = req.uri().path().to_string();

        Box::pin(async move {
            let resp = match path.as_str() {
                "/lantern.v1.ModelService/Complete" => {
                    let mut grpc = tonic::server::Grpc::new(tonic::codec::ProstCodec::default());
                    let svc = CompleteService(inner);
                    grpc.unary(svc, req).await
                }
                "/lantern.v1.ModelService/CompleteStream" => {
                    let mut grpc = tonic::server::Grpc::new(tonic::codec::ProstCodec::default());
                    let svc = CompleteStreamService(inner);
                    grpc.server_streaming(svc, req).await
                }
                "/lantern.v1.ModelService/Embed" => {
                    let mut grpc = tonic::server::Grpc::new(tonic::codec::ProstCodec::default());
                    let svc = EmbedService(inner);
                    grpc.unary(svc, req).await
                }
                "/lantern.v1.ModelService/Tokenize" => {
                    let mut grpc = tonic::server::Grpc::new(tonic::codec::ProstCodec::default());
                    let svc = TokenizeService(inner);
                    grpc.unary(svc, req).await
                }
                _ => tonic::codegen::http::Response::builder()
                    .status(200)
                    .header("grpc-status", "12")
                    .header("content-type", "application/grpc")
                    .body(tonic::body::empty_body())
                    .unwrap(),
            };

            Ok(resp)
        })
    }
}

impl<T: ModelService> tonic::server::NamedService for ModelServiceServer<T> {
    const NAME: &'static str = "lantern.v1.ModelService";
}

// --- per-method service adapters ---

struct CompleteService<T: ModelService>(std::sync::Arc<T>);
impl<T: ModelService> tonic::server::UnaryService<CompleteRequest> for CompleteService<T> {
    type Response = CompleteResponse;
    type Future = std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<tonic::Response<Self::Response>, tonic::Status>>
                + Send,
        >,
    >;
    fn call(&mut self, request: tonic::Request<CompleteRequest>) -> Self::Future {
        let inner = self.0.clone();
        Box::pin(async move { inner.complete(request).await })
    }
}

struct CompleteStreamService<T: ModelService>(std::sync::Arc<T>);
impl<T: ModelService> tonic::server::ServerStreamingService<CompleteRequest>
    for CompleteStreamService<T>
{
    type Response = CompleteChunk;
    type ResponseStream = T::CompleteStreamStream;
    type Future = std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<tonic::Response<Self::ResponseStream>, tonic::Status>,
                > + Send,
        >,
    >;
    fn call(&mut self, request: tonic::Request<CompleteRequest>) -> Self::Future {
        let inner = self.0.clone();
        Box::pin(async move { inner.complete_stream(request).await })
    }
}

struct EmbedService<T: ModelService>(std::sync::Arc<T>);
impl<T: ModelService> tonic::server::UnaryService<EmbedRequest> for EmbedService<T> {
    type Response = EmbedResponse;
    type Future = std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<tonic::Response<Self::Response>, tonic::Status>>
                + Send,
        >,
    >;
    fn call(&mut self, request: tonic::Request<EmbedRequest>) -> Self::Future {
        let inner = self.0.clone();
        Box::pin(async move { inner.embed(request).await })
    }
}

struct TokenizeService<T: ModelService>(std::sync::Arc<T>);
impl<T: ModelService> tonic::server::UnaryService<TokenizeRequest> for TokenizeService<T> {
    type Response = TokenizeResponse;
    type Future = std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<tonic::Response<Self::Response>, tonic::Status>>
                + Send,
        >,
    >;
    fn call(&mut self, request: tonic::Request<TokenizeRequest>) -> Self::Future {
        let inner = self.0.clone();
        Box::pin(async move { inner.tokenize(request).await })
    }
}
