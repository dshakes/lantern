use std::collections::HashMap;

use prost::Message;
use serde::{Deserialize, Serialize};
use tonic::transport::Channel;
use tonic::{Request, Streaming};

use crate::auth::Claims;
use crate::error::{grpc_status_to_app_error, AppError};

// ---------------------------------------------------------------------------
// Proto message definitions (hand-rolled prost structs matching the protos)
// ---------------------------------------------------------------------------

// -- Timestamps --

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct Timestamp {
    #[prost(int64, tag = "1")]
    pub seconds: i64,
    #[prost(int32, tag = "2")]
    pub nanos: i32,
}

// -- Agent messages --

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct Agent {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub tenant_id: String,
    #[prost(string, tag = "3")]
    pub name: String,
    #[prost(string, tag = "4")]
    pub description: String,
    #[prost(string, tag = "5")]
    pub current_version_id: String,
    #[prost(string, tag = "6")]
    pub created_by: String,
    #[prost(message, optional, tag = "7")]
    pub created_at: Option<Timestamp>,
    #[prost(message, optional, tag = "8")]
    pub archived_at: Option<Timestamp>,
    #[prost(map = "string, string", tag = "9")]
    pub labels: HashMap<String, String>,
}

#[derive(Clone, PartialEq, Message)]
pub struct CreateAgentRequest {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(string, tag = "2")]
    pub description: String,
    #[prost(map = "string, string", tag = "3")]
    pub labels: HashMap<String, String>,
}

#[derive(Clone, PartialEq, Message)]
pub struct GetAgentRequest {
    #[prost(string, tag = "1")]
    pub name: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct ListAgentsRequest {
    #[prost(int32, tag = "1")]
    pub page_size: i32,
    #[prost(string, tag = "2")]
    pub page_token: String,
    #[prost(map = "string, string", tag = "3")]
    pub label_filter: HashMap<String, String>,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct ListAgentsResponse {
    #[prost(message, repeated, tag = "1")]
    pub agents: Vec<Agent>,
    #[prost(string, tag = "2")]
    pub next_page_token: String,
    #[prost(int32, tag = "3")]
    pub total_count: i32,
}

#[derive(Clone, PartialEq, Message)]
pub struct DeleteAgentRequest {
    #[prost(string, tag = "1")]
    pub name: String,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct DeleteAgentResponse {}

// -- Run messages --

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, prost::Enumeration, Serialize, Deserialize)]
#[repr(i32)]
pub enum RunStatus {
    Unspecified = 0,
    Queued = 1,
    Running = 2,
    Paused = 3,
    Succeeded = 4,
    Failed = 5,
    Cancelled = 6,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, prost::Enumeration, Serialize, Deserialize)]
#[repr(i32)]
pub enum TriggerKind {
    Unspecified = 0,
    Api = 1,
    Schedule = 2,
    Webhook = 3,
    Surface = 4,
    A2a = 5,
    Connector = 6,
    Manual = 7,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct RunError {
    #[prost(string, tag = "1")]
    pub code: String,
    #[prost(string, tag = "2")]
    pub message: String,
    #[prost(string, tag = "3")]
    pub step_id: String,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct Run {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub tenant_id: String,
    #[prost(string, tag = "3")]
    pub agent_id: String,
    #[prost(string, tag = "4")]
    pub agent_version_id: String,
    #[prost(enumeration = "RunStatus", tag = "5")]
    pub status: i32,
    #[prost(enumeration = "TriggerKind", tag = "6")]
    pub trigger_kind: i32,
    #[prost(message, optional, tag = "10")]
    pub error: Option<RunError>,
    #[prost(double, tag = "11")]
    pub cost_usd: f64,
    #[prost(int64, tag = "12")]
    pub tokens_in: i64,
    #[prost(int64, tag = "13")]
    pub tokens_out: i64,
    #[prost(message, optional, tag = "14")]
    pub started_at: Option<Timestamp>,
    #[prost(message, optional, tag = "15")]
    pub finished_at: Option<Timestamp>,
    #[prost(message, optional, tag = "16")]
    pub created_at: Option<Timestamp>,
    #[prost(string, tag = "17")]
    pub parent_run_id: String,
    #[prost(map = "string, string", tag = "18")]
    pub labels: HashMap<String, String>,
}

#[derive(Clone, PartialEq, Message)]
pub struct CreateRunRequest {
    #[prost(string, tag = "1")]
    pub agent_name: String,
    #[prost(bytes = "vec", tag = "2")]
    pub input: Vec<u8>,
    #[prost(enumeration = "TriggerKind", tag = "3")]
    pub trigger_kind: i32,
    #[prost(bool, tag = "5")]
    pub stream: bool,
    #[prost(map = "string, string", tag = "6")]
    pub labels: HashMap<String, String>,
    #[prost(string, tag = "7")]
    pub idempotency_key: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct GetRunRequest {
    #[prost(string, tag = "1")]
    pub id: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct ListRunsRequest {
    #[prost(string, tag = "1")]
    pub agent_name: String,
    #[prost(enumeration = "RunStatus", tag = "2")]
    pub status_filter: i32,
    #[prost(int32, tag = "3")]
    pub page_size: i32,
    #[prost(string, tag = "4")]
    pub page_token: String,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct ListRunsResponse {
    #[prost(message, repeated, tag = "1")]
    pub runs: Vec<Run>,
    #[prost(string, tag = "2")]
    pub next_page_token: String,
    #[prost(int32, tag = "3")]
    pub total_count: i32,
}

#[derive(Clone, PartialEq, Message)]
pub struct CancelRunRequest {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub reason: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct StreamRunEventsRequest {
    #[prost(string, tag = "1")]
    pub run_id: String,
    #[prost(uint64, tag = "2")]
    pub from_seq: u64,
    #[prost(bool, tag = "3")]
    pub live: bool,
}

#[derive(Clone, PartialEq, Message)]
pub struct SignalRunRequest {
    #[prost(string, tag = "1")]
    pub run_id: String,
    #[prost(string, tag = "2")]
    pub signal_name: String,
    #[prost(bytes = "vec", tag = "3")]
    pub value: Vec<u8>,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct SignalRunResponse {}

// -- Stream event messages --

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct StreamEvent {
    #[prost(string, tag = "1")]
    pub run_id: String,
    #[prost(string, tag = "2")]
    pub step_id: String,
    #[prost(uint64, tag = "3")]
    pub seq: u64,
    #[prost(message, optional, tag = "4")]
    pub ts: Option<Timestamp>,
    #[prost(oneof = "StreamEventPayload", tags = "10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21")]
    pub payload: Option<StreamEventPayload>,
}

#[derive(Clone, PartialEq, prost::Oneof, Serialize, Deserialize)]
pub enum StreamEventPayload {
    #[prost(message, tag = "10")]
    LlmDelta(LlmDelta),
    #[prost(message, tag = "11")]
    LlmComplete(LlmComplete),
    #[prost(message, tag = "12")]
    ToolCall(ToolCallEvent),
    #[prost(message, tag = "13")]
    ToolResult(ToolResultEvent),
    #[prost(message, tag = "14")]
    StepStarted(StepStarted),
    #[prost(message, tag = "15")]
    StepCompleted(StepCompleted),
    #[prost(message, tag = "16")]
    StepFailed(StepFailed),
    #[prost(message, tag = "17")]
    Log(LogLine),
    #[prost(message, tag = "18")]
    Question(QuestionEvent),
    #[prost(message, tag = "19")]
    Approval(ApprovalEvent),
    #[prost(message, tag = "20")]
    Heartbeat(Heartbeat),
    #[prost(message, tag = "21")]
    End(StreamEnd),
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct LlmDelta {
    #[prost(string, tag = "1")]
    pub text: String,
    #[prost(string, tag = "2")]
    pub model_used: String,
    #[prost(string, tag = "3")]
    pub generation_id: String,
    #[prost(int32, tag = "4")]
    pub tier: i32,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct LlmComplete {
    #[prost(string, tag = "1")]
    pub model_used: String,
    #[prost(int64, tag = "2")]
    pub tokens_in: i64,
    #[prost(int64, tag = "3")]
    pub tokens_out: i64,
    #[prost(double, tag = "4")]
    pub cost_usd: f64,
    #[prost(string, tag = "5")]
    pub cache_kind: String,
    #[prost(bool, tag = "6")]
    pub escalated: bool,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct ToolCallEvent {
    #[prost(string, tag = "1")]
    pub tool_name: String,
    #[prost(string, tag = "3")]
    pub call_id: String,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct ToolResultEvent {
    #[prost(string, tag = "1")]
    pub call_id: String,
    #[prost(bool, tag = "3")]
    pub is_error: bool,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct StepStarted {
    #[prost(string, tag = "1")]
    pub step_id: String,
    #[prost(int32, tag = "2")]
    pub attempt: i32,
    #[prost(string, tag = "3")]
    pub kind: String,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct StepCompleted {
    #[prost(string, tag = "1")]
    pub step_id: String,
    #[prost(int32, tag = "2")]
    pub attempt: i32,
    #[prost(double, tag = "3")]
    pub duration_ms: f64,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct StepFailed {
    #[prost(string, tag = "1")]
    pub step_id: String,
    #[prost(int32, tag = "2")]
    pub attempt: i32,
    #[prost(string, tag = "3")]
    pub error_code: String,
    #[prost(string, tag = "4")]
    pub error_message: String,
    #[prost(bool, tag = "5")]
    pub will_retry: bool,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct LogLine {
    #[prost(string, tag = "1")]
    pub level: String,
    #[prost(string, tag = "2")]
    pub message: String,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct QuestionEvent {
    #[prost(string, tag = "1")]
    pub question: String,
    #[prost(string, repeated, tag = "2")]
    pub options: Vec<String>,
    #[prost(string, tag = "3")]
    pub timeout: String,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct ApprovalEvent {
    #[prost(string, tag = "1")]
    pub reason: String,
    #[prost(string, repeated, tag = "2")]
    pub approvers: Vec<String>,
    #[prost(string, tag = "3")]
    pub expires_at: String,
}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct Heartbeat {}

#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct StreamEnd {
    #[prost(string, tag = "1")]
    pub reason: String,
}

// ---------------------------------------------------------------------------
// gRPC client wrapper
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ControlPlaneClient {
    channel: Channel,
}

impl ControlPlaneClient {
    pub async fn connect(addr: &str) -> anyhow::Result<Self> {
        let channel = Channel::from_shared(addr.to_string())?
            .connect_lazy();
        tracing::info!(addr = addr, "control-plane channel created (lazy)");
        Ok(Self { channel })
    }


    fn inject_tenant_metadata<T>(
        request: &mut Request<T>,
        claims: &Claims,
    ) {
        let metadata = request.metadata_mut();
        if let Ok(val) = claims.tenant_id.parse() {
            metadata.insert("x-tenant-id", val);
        }
        if let Ok(val) = claims.user_id.parse() {
            metadata.insert("x-user-id", val);
        }
    }

    // -- Agent RPCs --

    pub async fn create_agent(
        &self,
        claims: &Claims,
        req: CreateAgentRequest,
    ) -> Result<Agent, AppError> {
        let mut client = AgentServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .create_agent(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    pub async fn get_agent(
        &self,
        claims: &Claims,
        req: GetAgentRequest,
    ) -> Result<Agent, AppError> {
        let mut client = AgentServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .get_agent(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    pub async fn list_agents(
        &self,
        claims: &Claims,
        req: ListAgentsRequest,
    ) -> Result<ListAgentsResponse, AppError> {
        let mut client = AgentServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .list_agents(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    pub async fn delete_agent(
        &self,
        claims: &Claims,
        req: DeleteAgentRequest,
    ) -> Result<DeleteAgentResponse, AppError> {
        let mut client = AgentServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .delete_agent(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    // -- Run RPCs --

    pub async fn create_run(
        &self,
        claims: &Claims,
        req: CreateRunRequest,
    ) -> Result<Run, AppError> {
        let mut client = RunServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .create_run(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    pub async fn get_run(
        &self,
        claims: &Claims,
        req: GetRunRequest,
    ) -> Result<Run, AppError> {
        let mut client = RunServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .get_run(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    pub async fn list_runs(
        &self,
        claims: &Claims,
        req: ListRunsRequest,
    ) -> Result<ListRunsResponse, AppError> {
        let mut client = RunServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .list_runs(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    pub async fn cancel_run(
        &self,
        claims: &Claims,
        req: CancelRunRequest,
    ) -> Result<Run, AppError> {
        let mut client = RunServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .cancel_run(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    pub async fn stream_run_events(
        &self,
        claims: &Claims,
        req: StreamRunEventsRequest,
    ) -> Result<Streaming<StreamEvent>, AppError> {
        let mut client = RunServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .stream_run_events(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }

    pub async fn signal_run(
        &self,
        claims: &Claims,
        req: SignalRunRequest,
    ) -> Result<SignalRunResponse, AppError> {
        let mut client = RunServiceClient::new(self.channel.clone());
        let mut request = Request::new(req);
        Self::inject_tenant_metadata(&mut request, claims);
        client
            .signal_run(request)
            .await
            .map(|r| r.into_inner())
            .map_err(grpc_status_to_app_error)
    }
}

// ---------------------------------------------------------------------------
// Hand-written tonic service client stubs
// ---------------------------------------------------------------------------
// These mirror what tonic codegen would produce. We define them manually
// because we don't have a build.rs / protoc step wired up yet.

#[derive(Clone)]
struct AgentServiceClient {
    inner: tonic::client::Grpc<Channel>,
}

impl AgentServiceClient {
    fn new(channel: Channel) -> Self {
        Self {
            inner: tonic::client::Grpc::new(channel),
        }
    }

    async fn create_agent(
        &mut self,
        request: Request<CreateAgentRequest>,
    ) -> Result<tonic::Response<Agent>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.AgentService/CreateAgent",
        );
        self.inner.unary(request, path, codec).await
    }

    async fn get_agent(
        &mut self,
        request: Request<GetAgentRequest>,
    ) -> Result<tonic::Response<Agent>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.AgentService/GetAgent",
        );
        self.inner.unary(request, path, codec).await
    }

    async fn list_agents(
        &mut self,
        request: Request<ListAgentsRequest>,
    ) -> Result<tonic::Response<ListAgentsResponse>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.AgentService/ListAgents",
        );
        self.inner.unary(request, path, codec).await
    }

    async fn delete_agent(
        &mut self,
        request: Request<DeleteAgentRequest>,
    ) -> Result<tonic::Response<DeleteAgentResponse>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.AgentService/DeleteAgent",
        );
        self.inner.unary(request, path, codec).await
    }
}

#[derive(Clone)]
struct RunServiceClient {
    inner: tonic::client::Grpc<Channel>,
}

impl RunServiceClient {
    fn new(channel: Channel) -> Self {
        Self {
            inner: tonic::client::Grpc::new(channel),
        }
    }

    async fn create_run(
        &mut self,
        request: Request<CreateRunRequest>,
    ) -> Result<tonic::Response<Run>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.RunService/CreateRun",
        );
        self.inner.unary(request, path, codec).await
    }

    async fn get_run(
        &mut self,
        request: Request<GetRunRequest>,
    ) -> Result<tonic::Response<Run>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.RunService/GetRun",
        );
        self.inner.unary(request, path, codec).await
    }

    async fn list_runs(
        &mut self,
        request: Request<ListRunsRequest>,
    ) -> Result<tonic::Response<ListRunsResponse>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.RunService/ListRuns",
        );
        self.inner.unary(request, path, codec).await
    }

    async fn cancel_run(
        &mut self,
        request: Request<CancelRunRequest>,
    ) -> Result<tonic::Response<Run>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.RunService/CancelRun",
        );
        self.inner.unary(request, path, codec).await
    }

    async fn stream_run_events(
        &mut self,
        request: Request<StreamRunEventsRequest>,
    ) -> Result<tonic::Response<Streaming<StreamEvent>>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.RunService/StreamRunEvents",
        );
        self.inner.server_streaming(request, path, codec).await
    }

    async fn signal_run(
        &mut self,
        request: Request<SignalRunRequest>,
    ) -> Result<tonic::Response<SignalRunResponse>, tonic::Status> {
        self.inner.ready().await.map_err(|e| {
            tonic::Status::unknown(format!("service not ready: {e}"))
        })?;
        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static(
            "/lantern.v1.RunService/SignalRun",
        );
        self.inner.unary(request, path, codec).await
    }
}
