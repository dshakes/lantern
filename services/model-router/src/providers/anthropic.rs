use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::{debug, instrument, warn};

use crate::error::ProviderError;
use crate::proto::{
    self, Capability, ChunkDone, ChunkUsage, CompleteChunk, CompleteRequest, CompleteResponse,
    EmbedRequest, EmbedResponse, Message, ToolCallMessage,
};
use crate::provider::{ModelInfo, Provider};

const BASE_URL: &str = "https://api.anthropic.com/v1";
const API_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    client: Client,
    api_key: String,
    models: Vec<ModelInfo>,
}

impl AnthropicProvider {
    pub fn new(api_key: String) -> Self {
        let models = vec![
            ModelInfo {
                model_id: "claude-opus-4-6".into(),
                capability: Capability::ReasoningFrontier,
                cost_per_m_input: 15.00,
                cost_per_m_output: 75.00,
                quality_score: 98,
                latency_p50_ms: 3000,
            },
            ModelInfo {
                model_id: "claude-sonnet-4-6".into(),
                capability: Capability::ReasoningLarge,
                cost_per_m_input: 3.00,
                cost_per_m_output: 15.00,
                quality_score: 93,
                latency_p50_ms: 1200,
            },
            ModelInfo {
                model_id: "claude-haiku-4-5".into(),
                capability: Capability::ReasoningSmall,
                cost_per_m_input: 0.80,
                cost_per_m_output: 4.00,
                quality_score: 78,
                latency_p50_ms: 500,
            },
            ModelInfo {
                model_id: "claude-sonnet-4-6".into(),
                capability: Capability::CodeLarge,
                cost_per_m_input: 3.00,
                cost_per_m_output: 15.00,
                quality_score: 95,
                latency_p50_ms: 1200,
            },
        ];

        Self {
            client: Client::new(),
            api_key,
            models,
        }
    }

    fn map_error(&self, status: u16, body: &str) -> ProviderError {
        // Untrusted upstream body: log at debug only, never surface a raw
        // auth-error body to the caller or into run state.
        tracing::debug!(provider = self.name(), status, body, "provider error response");
        if status == 429 {
            ProviderError::RateLimited {
                provider: self.name().into(),
                retry_after_ms: 1000,
            }
        } else if status == 401 || status == 403 {
            ProviderError::AuthError {
                provider: self.name().into(),
                message: "upstream authentication failed (check the provider API key)".into(),
            }
        } else if status == 400 {
            ProviderError::InvalidRequest {
                provider: self.name().into(),
                message: body.to_string(),
            }
        } else if status >= 500 {
            ProviderError::ServerError {
                provider: self.name().into(),
                status,
                message: body.to_string(),
            }
        } else {
            ProviderError::NetworkError {
                provider: self.name().into(),
                detail: format!("unexpected status {status}: {body}"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Anthropic wire types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct AnthropicChatRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    stop_sequences: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<AnthropicTool>,
    stream: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct AnthropicMessage {
    role: String,
    content: AnthropicContent,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(untagged)]
enum AnthropicContent {
    Text(String),
    Blocks(Vec<AnthropicContentBlock>),
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
enum AnthropicContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: String,
    },
}

#[derive(Serialize)]
struct AnthropicTool {
    name: String,
    description: String,
    input_schema: serde_json::Value,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct AnthropicChatResponse {
    id: String,
    model: String,
    content: Vec<AnthropicResponseBlock>,
    stop_reason: Option<String>,
    usage: AnthropicUsage,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum AnthropicResponseBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: i64,
    output_tokens: i64,
}

// Streaming event types
#[derive(Deserialize)]
#[allow(dead_code)]
struct AnthropicStreamEvent {
    #[serde(rename = "type")]
    event_type: String,
    message: Option<AnthropicStreamMessage>,
    index: Option<usize>,
    content_block: Option<AnthropicStreamContentBlock>,
    delta: Option<AnthropicStreamDelta>,
    usage: Option<AnthropicUsage>,
}

#[derive(Deserialize)]
struct AnthropicStreamMessage {
    id: String,
    model: String,
    usage: AnthropicUsage,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
#[allow(dead_code)]
enum AnthropicStreamContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },
}

#[derive(Deserialize)]
#[serde(tag = "type")]
#[allow(clippy::enum_variant_names)]
enum AnthropicStreamDelta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
    #[serde(rename = "message_delta")]
    MessageDelta {
        stop_reason: Option<String>,
        usage: Option<AnthropicDeltaUsage>,
    },
}

#[derive(Deserialize)]
struct AnthropicDeltaUsage {
    output_tokens: i64,
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/// Converts Lantern messages to Anthropic format, extracting the system message separately.
fn to_anthropic_messages(messages: &[Message]) -> (Option<String>, Vec<AnthropicMessage>) {
    let mut system: Option<String> = None;
    let mut out = Vec::new();

    for m in messages {
        if m.role == "system" {
            system = Some(m.content.clone());
            continue;
        }

        if m.role == "tool" {
            // Tool result message — wrap as Anthropic tool_result block.
            out.push(AnthropicMessage {
                role: "user".into(),
                content: AnthropicContent::Blocks(vec![AnthropicContentBlock::ToolResult {
                    tool_use_id: m.tool_call_id.clone(),
                    content: m.content.clone(),
                }]),
            });
            continue;
        }

        if !m.tool_calls.is_empty() {
            // Assistant message with tool calls.
            let mut blocks: Vec<AnthropicContentBlock> = Vec::new();
            if !m.content.is_empty() {
                blocks.push(AnthropicContentBlock::Text {
                    text: m.content.clone(),
                });
            }
            for tc in &m.tool_calls {
                let input: serde_json::Value =
                    serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                blocks.push(AnthropicContentBlock::ToolUse {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    input,
                });
            }
            out.push(AnthropicMessage {
                role: "assistant".into(),
                content: AnthropicContent::Blocks(blocks),
            });
            continue;
        }

        out.push(AnthropicMessage {
            role: m.role.clone(),
            content: AnthropicContent::Text(m.content.clone()),
        });
    }

    (system, out)
}

fn to_anthropic_tools(tools: &[proto::Tool]) -> Vec<AnthropicTool> {
    tools
        .iter()
        .map(|t| {
            let input_schema = if t.parameters.is_empty() {
                serde_json::json!({"type": "object", "properties": {}})
            } else {
                serde_json::from_slice(&t.parameters)
                    .unwrap_or(serde_json::json!({"type": "object", "properties": {}}))
            };
            AnthropicTool {
                name: t.name.clone(),
                description: t.description.clone(),
                input_schema,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Provider impl
// ---------------------------------------------------------------------------

#[async_trait]
impl Provider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    fn supports(&self, capability: Capability) -> bool {
        self.models.iter().any(|m| m.capability == capability)
    }

    fn models(&self) -> &[ModelInfo] {
        &self.models
    }

    #[instrument(skip(self, req), fields(provider = "anthropic", model))]
    async fn complete(
        &self,
        model: &str,
        req: &CompleteRequest,
    ) -> Result<CompleteResponse, ProviderError> {
        tracing::Span::current().record("model", model);

        let (system, messages) = to_anthropic_messages(&req.messages);

        let max_tokens = if req.max_tokens > 0 {
            req.max_tokens
        } else {
            4096
        };

        let anthropic_req = AnthropicChatRequest {
            model: model.to_string(),
            messages,
            max_tokens,
            system,
            temperature: if req.temperature > 0.0 {
                Some(req.temperature)
            } else {
                None
            },
            top_p: if req.top_p > 0.0 {
                Some(req.top_p)
            } else {
                None
            },
            stop_sequences: req.stop.clone(),
            tools: to_anthropic_tools(&req.tools),
            stream: false,
        };

        let started = std::time::Instant::now();

        let resp = self
            .client
            .post(format!("{BASE_URL}/messages"))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .json(&anthropic_req)
            .send()
            .await
            .map_err(|e| ProviderError::NetworkError {
                provider: self.name().into(),
                detail: e.to_string(),
            })?;

        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(|e| ProviderError::NetworkError {
            provider: self.name().into(),
            detail: e.to_string(),
        })?;

        if status != 200 {
            return Err(self.map_error(status, &body));
        }

        let anthropic: AnthropicChatResponse =
            serde_json::from_str(&body).map_err(|e| ProviderError::NetworkError {
                provider: self.name().into(),
                detail: format!("failed to parse response: {e}"),
            })?;

        let elapsed = started.elapsed().as_secs_f64() * 1000.0;

        let mut content = String::new();
        let mut tool_calls = Vec::new();

        for block in &anthropic.content {
            match block {
                AnthropicResponseBlock::Text { text } => {
                    content.push_str(text);
                }
                AnthropicResponseBlock::ToolUse { id, name, input } => {
                    tool_calls.push(ToolCallMessage {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: serde_json::to_string(input).unwrap_or_default(),
                    });
                }
            }
        }

        let tokens_in = anthropic.usage.input_tokens;
        let tokens_out = anthropic.usage.output_tokens;

        let model_info = self.models.iter().find(|m| m.model_id == model);
        let cost_usd = model_info
            .map(|m| m.cost(tokens_in, tokens_out))
            .unwrap_or(0.0);

        debug!(
            tokens_in,
            tokens_out,
            cost_usd,
            latency_ms = elapsed,
            "anthropic complete finished"
        );

        Ok(CompleteResponse {
            id: anthropic.id,
            model_used: anthropic.model,
            tier: 0,
            message: Some(Message {
                role: "assistant".into(),
                content,
                name: String::new(),
                tool_calls,
                tool_call_id: String::new(),
                parts: vec![],
            }),
            tokens_in,
            tokens_out,
            cost_usd,
            cache_kind: String::new(),
            escalated: false,
            latency_ms: elapsed,
        })
    }

    #[instrument(skip(self, req), fields(provider = "anthropic", model))]
    async fn complete_stream(
        &self,
        model: &str,
        req: &CompleteRequest,
    ) -> Result<BoxStream<'_, Result<CompleteChunk, ProviderError>>, ProviderError> {
        tracing::Span::current().record("model", model);

        let (system, messages) = to_anthropic_messages(&req.messages);

        let max_tokens = if req.max_tokens > 0 {
            req.max_tokens
        } else {
            4096
        };

        let anthropic_req = AnthropicChatRequest {
            model: model.to_string(),
            messages,
            max_tokens,
            system,
            temperature: if req.temperature > 0.0 {
                Some(req.temperature)
            } else {
                None
            },
            top_p: if req.top_p > 0.0 {
                Some(req.top_p)
            } else {
                None
            },
            stop_sequences: req.stop.clone(),
            tools: to_anthropic_tools(&req.tools),
            stream: true,
        };

        let resp = self
            .client
            .post(format!("{BASE_URL}/messages"))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .json(&anthropic_req)
            .send()
            .await
            .map_err(|e| ProviderError::NetworkError {
                provider: self.name().into(),
                detail: e.to_string(),
            })?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(self.map_error(status, &body));
        }

        let provider_name: String = self.name().into();
        let byte_stream = resp.bytes_stream();

        // Track current tool_use state across stream chunks.
        struct StreamState {
            buffer: String,
            provider_name: String,
            msg_id: String,
            model_used: String,
            current_tool_id: String,
            current_tool_name: String,
            input_tokens: i64,
        }

        let state = StreamState {
            buffer: String::new(),
            provider_name,
            msg_id: String::new(),
            model_used: model.to_string(),
            current_tool_id: String::new(),
            current_tool_name: String::new(),
            input_tokens: 0,
        };

        let stream = futures::stream::unfold(
            (byte_stream, state),
            |(mut byte_stream, mut state)| async move {
                use futures::StreamExt;

                loop {
                    // Try to extract a complete SSE event from the buffer.
                    if let Some(pos) = state.buffer.find("\n\n") {
                        let event_text = state.buffer[..pos].to_string();
                        state.buffer = state.buffer[pos + 2..].to_string();

                        // Parse event type and data.
                        let mut event_type = String::new();
                        let mut data_str = String::new();

                        for line in event_text.lines() {
                            if let Some(et) = line.strip_prefix("event: ") {
                                event_type = et.to_string();
                            } else if let Some(d) = line.strip_prefix("data: ") {
                                data_str = d.to_string();
                            }
                        }

                        if data_str.is_empty() {
                            continue;
                        }

                        let event: Result<AnthropicStreamEvent, _> =
                            serde_json::from_str(&data_str);
                        let event = match event {
                            Ok(e) => e,
                            Err(e) => {
                                warn!(
                                    error = %e,
                                    event_type = %event_type,
                                    "failed to parse anthropic stream event"
                                );
                                continue;
                            }
                        };

                        match event.event_type.as_str() {
                            "message_start" => {
                                if let Some(ref msg) = event.message {
                                    state.msg_id = msg.id.clone();
                                    state.model_used = msg.model.clone();
                                    state.input_tokens = msg.usage.input_tokens;
                                }
                                continue;
                            }
                            "content_block_start" => {
                                if let Some(ref block) = event.content_block {
                                    match block {
                                        AnthropicStreamContentBlock::ToolUse { id, name } => {
                                            state.current_tool_id = id.clone();
                                            state.current_tool_name = name.clone();
                                            // Emit an initial tool call delta with the name.
                                            let chunk = CompleteChunk {
                                                id: state.msg_id.clone(),
                                                model_used: state.model_used.clone(),
                                                tier: 0,
                                                data: Some(
                                                    proto::complete_chunk::Data::ToolCallDelta(
                                                        ToolCallMessage {
                                                            id: id.clone(),
                                                            name: name.clone(),
                                                            arguments: String::new(),
                                                        },
                                                    ),
                                                ),
                                            };
                                            return Some((Ok(chunk), (byte_stream, state)));
                                        }
                                        AnthropicStreamContentBlock::Text { .. } => {
                                            continue;
                                        }
                                    }
                                }
                                continue;
                            }
                            "content_block_delta" => {
                                if let Some(ref delta) = event.delta {
                                    match delta {
                                        AnthropicStreamDelta::TextDelta { text } => {
                                            let chunk = CompleteChunk {
                                                id: state.msg_id.clone(),
                                                model_used: state.model_used.clone(),
                                                tier: 0,
                                                data: Some(
                                                    proto::complete_chunk::Data::TextDelta(
                                                        text.clone(),
                                                    ),
                                                ),
                                            };
                                            return Some((Ok(chunk), (byte_stream, state)));
                                        }
                                        AnthropicStreamDelta::InputJsonDelta {
                                            partial_json,
                                        } => {
                                            let chunk = CompleteChunk {
                                                id: state.msg_id.clone(),
                                                model_used: state.model_used.clone(),
                                                tier: 0,
                                                data: Some(
                                                    proto::complete_chunk::Data::ToolCallDelta(
                                                        ToolCallMessage {
                                                            id: state.current_tool_id.clone(),
                                                            name: state
                                                                .current_tool_name
                                                                .clone(),
                                                            arguments: partial_json.clone(),
                                                        },
                                                    ),
                                                ),
                                            };
                                            return Some((Ok(chunk), (byte_stream, state)));
                                        }
                                        _ => continue,
                                    }
                                }
                                continue;
                            }
                            "content_block_stop" => {
                                state.current_tool_id.clear();
                                state.current_tool_name.clear();
                                continue;
                            }
                            "message_delta" => {
                                if let Some(ref delta) = event.delta
                                    && let AnthropicStreamDelta::MessageDelta {
                                        stop_reason,
                                        usage,
                                    } = delta
                                    {
                                        let output_tokens = usage
                                            .as_ref()
                                            .map(|u| u.output_tokens)
                                            .unwrap_or(0);

                                        // Emit usage chunk.
                                        let usage_chunk = CompleteChunk {
                                            id: state.msg_id.clone(),
                                            model_used: state.model_used.clone(),
                                            tier: 0,
                                            data: Some(proto::complete_chunk::Data::Usage(
                                                ChunkUsage {
                                                    tokens_in: state.input_tokens,
                                                    tokens_out: output_tokens,
                                                    cost_usd: 0.0,
                                                    cache_kind: String::new(),
                                                },
                                            )),
                                        };

                                        // We return usage first; done will come at message_stop
                                        // or we pack both here since message_stop has no data.
                                        if stop_reason.is_some() {
                                            // We'll emit usage now, done on next iteration.
                                            // Actually, let's just return usage and let
                                            // message_stop handle the done signal.
                                            return Some((
                                                Ok(usage_chunk),
                                                (byte_stream, state),
                                            ));
                                        }

                                        return Some((
                                            Ok(usage_chunk),
                                            (byte_stream, state),
                                        ));
                                    }
                                continue;
                            }
                            "message_stop" => {
                                let done_chunk = CompleteChunk {
                                    id: state.msg_id.clone(),
                                    model_used: state.model_used.clone(),
                                    tier: 0,
                                    data: Some(proto::complete_chunk::Data::Done(ChunkDone {
                                        finish_reason: "end_turn".into(),
                                        escalated: false,
                                    })),
                                };
                                return Some((Ok(done_chunk), (byte_stream, state)));
                            }
                            "ping" => continue,
                            _ => continue,
                        }
                    }

                    // Need more data from the network.
                    match byte_stream.next().await {
                        Some(Ok(bytes)) => {
                            state.buffer.push_str(&String::from_utf8_lossy(&bytes));
                        }
                        Some(Err(e)) => {
                            return Some((
                                Err(ProviderError::NetworkError {
                                    provider: state.provider_name.clone(),
                                    detail: e.to_string(),
                                }),
                                (byte_stream, state),
                            ));
                        }
                        None => return None,
                    }
                }
            },
        );

        Ok(Box::pin(stream))
    }

    async fn embed(
        &self,
        _model: &str,
        _req: &EmbedRequest,
    ) -> Result<EmbedResponse, ProviderError> {
        Err(ProviderError::Unsupported {
            provider: self.name().into(),
            message: "Anthropic does not provide an embeddings API".into(),
        })
    }
}
