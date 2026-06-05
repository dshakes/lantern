use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::{debug, instrument, warn};

use crate::error::ProviderError;
use crate::proto::{
    self, Capability, ChunkDone, ChunkUsage, CompleteChunk, CompleteRequest, CompleteResponse,
    EmbedRequest, EmbedResponse, Embedding, Message, ToolCallMessage,
};
use crate::provider::{ModelInfo, Provider};

const BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAiProvider {
    client: Client,
    api_key: String,
    models: Vec<ModelInfo>,
}

impl OpenAiProvider {
    pub fn new(api_key: String) -> Self {
        let models = vec![
            ModelInfo {
                model_id: "gpt-4o".into(),
                capability: Capability::ChatLarge,
                cost_per_m_input: 2.50,
                cost_per_m_output: 10.00,
                quality_score: 85,
                latency_p50_ms: 600,
            },
            ModelInfo {
                model_id: "gpt-4o-mini".into(),
                capability: Capability::ChatSmall,
                cost_per_m_input: 0.15,
                cost_per_m_output: 0.60,
                quality_score: 70,
                latency_p50_ms: 350,
            },
            ModelInfo {
                model_id: "o3".into(),
                capability: Capability::ReasoningLarge,
                cost_per_m_input: 10.00,
                cost_per_m_output: 40.00,
                quality_score: 92,
                latency_p50_ms: 2000,
            },
            ModelInfo {
                model_id: "gpt-4o".into(),
                capability: Capability::CodeLarge,
                cost_per_m_input: 2.50,
                cost_per_m_output: 10.00,
                quality_score: 80,
                latency_p50_ms: 600,
            },
            ModelInfo {
                model_id: "text-embedding-3-large".into(),
                capability: Capability::EmbedLarge,
                cost_per_m_input: 0.13,
                cost_per_m_output: 0.0,
                quality_score: 90,
                latency_p50_ms: 200,
            },
            ModelInfo {
                model_id: "text-embedding-3-small".into(),
                capability: Capability::EmbedSmall,
                cost_per_m_input: 0.02,
                cost_per_m_output: 0.0,
                quality_score: 75,
                latency_p50_ms: 150,
            },
        ];

        Self {
            client: Client::new(),
            api_key,
            models,
        }
    }

    fn map_error(&self, status: u16, body: &str) -> ProviderError {
        // Upstream error bodies are untrusted and may carry operator/secret
        // detail; log at debug only, and never surface a raw auth-error body
        // to the caller or into run state.
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
// OpenAI wire types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct OaiChatRequest {
    model: String,
    messages: Vec<OaiMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    stop: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<OaiTool>,
    stream: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct OaiMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OaiToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct OaiToolCall {
    id: String,
    #[serde(rename = "type")]
    call_type: String,
    function: OaiFunction,
}

#[derive(Serialize, Deserialize, Clone)]
struct OaiFunction {
    name: String,
    arguments: String,
}

#[derive(Serialize)]
struct OaiTool {
    #[serde(rename = "type")]
    tool_type: String,
    function: OaiToolFunction,
}

#[derive(Serialize)]
struct OaiToolFunction {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

#[derive(Deserialize)]
struct OaiChatResponse {
    id: String,
    model: String,
    choices: Vec<OaiChoice>,
    usage: Option<OaiUsage>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OaiChoice {
    message: OaiResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OaiResponseMessage {
    role: String,
    content: Option<String>,
    tool_calls: Option<Vec<OaiToolCall>>,
}

#[derive(Deserialize)]
struct OaiUsage {
    prompt_tokens: i64,
    completion_tokens: i64,
}

#[derive(Deserialize)]
struct OaiStreamChunk {
    id: String,
    model: String,
    choices: Vec<OaiStreamChoice>,
    usage: Option<OaiUsage>,
}

#[derive(Deserialize)]
struct OaiStreamChoice {
    delta: OaiStreamDelta,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OaiStreamDelta {
    content: Option<String>,
    tool_calls: Option<Vec<OaiStreamToolCall>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OaiStreamToolCall {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    function: Option<OaiStreamFunction>,
}

#[derive(Deserialize)]
struct OaiStreamFunction {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Serialize)]
struct OaiEmbedRequest {
    model: String,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct OaiEmbedResponse {
    model: String,
    data: Vec<OaiEmbedding>,
    usage: OaiEmbedUsage,
}

#[derive(Deserialize)]
struct OaiEmbedding {
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct OaiEmbedUsage {
    total_tokens: i64,
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

fn to_oai_messages(messages: &[Message]) -> Vec<OaiMessage> {
    messages
        .iter()
        .map(|m| {
            let tool_calls = if m.tool_calls.is_empty() {
                None
            } else {
                Some(
                    m.tool_calls
                        .iter()
                        .map(|tc| OaiToolCall {
                            id: tc.id.clone(),
                            call_type: "function".into(),
                            function: OaiFunction {
                                name: tc.name.clone(),
                                arguments: tc.arguments.clone(),
                            },
                        })
                        .collect(),
                )
            };

            let tool_call_id = if m.tool_call_id.is_empty() {
                None
            } else {
                Some(m.tool_call_id.clone())
            };

            let name = if m.name.is_empty() {
                None
            } else {
                Some(m.name.clone())
            };

            let content = if m.content.is_empty() && tool_calls.is_some() {
                None
            } else {
                Some(m.content.clone())
            };

            OaiMessage {
                role: m.role.clone(),
                content,
                name,
                tool_calls,
                tool_call_id,
            }
        })
        .collect()
}

fn to_oai_tools(tools: &[proto::Tool]) -> Vec<OaiTool> {
    tools
        .iter()
        .map(|t| {
            let parameters = if t.parameters.is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_slice(&t.parameters).unwrap_or(serde_json::json!({}))
            };
            OaiTool {
                tool_type: "function".into(),
                function: OaiToolFunction {
                    name: t.name.clone(),
                    description: t.description.clone(),
                    parameters,
                },
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Provider impl
// ---------------------------------------------------------------------------

#[async_trait]
impl Provider for OpenAiProvider {
    fn name(&self) -> &str {
        "openai"
    }

    fn supports(&self, capability: Capability) -> bool {
        self.models.iter().any(|m| m.capability == capability)
    }

    fn models(&self) -> &[ModelInfo] {
        &self.models
    }

    #[instrument(skip(self, req), fields(provider = "openai", model))]
    async fn complete(
        &self,
        model: &str,
        req: &CompleteRequest,
    ) -> Result<CompleteResponse, ProviderError> {
        tracing::Span::current().record("model", model);

        let oai_req = OaiChatRequest {
            model: model.to_string(),
            messages: to_oai_messages(&req.messages),
            max_tokens: if req.max_tokens > 0 {
                Some(req.max_tokens)
            } else {
                None
            },
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
            stop: req.stop.clone(),
            tools: to_oai_tools(&req.tools),
            stream: false,
        };

        let started = std::time::Instant::now();

        let resp = self
            .client
            .post(format!("{BASE_URL}/chat/completions"))
            .bearer_auth(&self.api_key)
            .json(&oai_req)
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

        let oai: OaiChatResponse =
            serde_json::from_str(&body).map_err(|e| ProviderError::NetworkError {
                provider: self.name().into(),
                detail: format!("failed to parse response: {e}"),
            })?;

        let elapsed = started.elapsed().as_secs_f64() * 1000.0;

        let choice = oai.choices.first().ok_or_else(|| ProviderError::ServerError {
            provider: self.name().into(),
            status: 200,
            message: "no choices in response".into(),
        })?;

        let tool_calls: Vec<ToolCallMessage> = choice
            .message
            .tool_calls
            .as_ref()
            .map(|tcs| {
                tcs.iter()
                    .map(|tc| ToolCallMessage {
                        id: tc.id.clone(),
                        name: tc.function.name.clone(),
                        arguments: tc.function.arguments.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let usage = oai.usage.as_ref();
        let tokens_in = usage.map(|u| u.prompt_tokens).unwrap_or(0);
        let tokens_out = usage.map(|u| u.completion_tokens).unwrap_or(0);

        let model_info = self.models.iter().find(|m| m.model_id == model);
        let cost_usd = model_info
            .map(|m| m.cost(tokens_in, tokens_out))
            .unwrap_or(0.0);

        debug!(
            tokens_in,
            tokens_out,
            cost_usd,
            latency_ms = elapsed,
            "openai complete finished"
        );

        Ok(CompleteResponse {
            id: oai.id,
            model_used: oai.model,
            tier: 0,
            message: Some(Message {
                role: choice.message.role.clone(),
                content: choice.message.content.clone().unwrap_or_default(),
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

    #[instrument(skip(self, req), fields(provider = "openai", model))]
    async fn complete_stream(
        &self,
        model: &str,
        req: &CompleteRequest,
    ) -> Result<BoxStream<'_, Result<CompleteChunk, ProviderError>>, ProviderError> {
        tracing::Span::current().record("model", model);

        let oai_req = OaiChatRequest {
            model: model.to_string(),
            messages: to_oai_messages(&req.messages),
            max_tokens: if req.max_tokens > 0 {
                Some(req.max_tokens)
            } else {
                None
            },
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
            stop: req.stop.clone(),
            tools: to_oai_tools(&req.tools),
            stream: true,
        };

        let resp = self
            .client
            .post(format!("{BASE_URL}/chat/completions"))
            .bearer_auth(&self.api_key)
            .json(&oai_req)
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
        let model_id = model.to_string();
        let byte_stream = resp.bytes_stream();

        let stream = futures::stream::unfold(
            (
                byte_stream,
                String::new(),
                provider_name,
                model_id,
            ),
            |(mut byte_stream, mut buffer, provider_name, model_id)| async move {
                use futures::StreamExt;

                loop {
                    // Try to extract a complete SSE event from the buffer.
                    if let Some(pos) = buffer.find("\n\n") {
                        let event_text = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        let data_line = event_text
                            .lines()
                            .find(|l| l.starts_with("data: "))
                            .map(|l| &l[6..]);

                        let data_line = match data_line {
                            Some(d) => d,
                            None => continue,
                        };

                        if data_line == "[DONE]" {
                            return None;
                        }

                        let chunk: Result<OaiStreamChunk, _> = serde_json::from_str(data_line);
                        let chunk = match chunk {
                            Ok(c) => c,
                            Err(e) => {
                                warn!(error = %e, "failed to parse openai stream chunk");
                                continue;
                            }
                        };

                        // Yield chunks for each choice.
                        if let Some(choice) = chunk.choices.first() {
                            if let Some(ref text) = choice.delta.content {
                                let proto_chunk = CompleteChunk {
                                    id: chunk.id.clone(),
                                    model_used: chunk.model.clone(),
                                    tier: 0,
                                    data: Some(proto::complete_chunk::Data::TextDelta(
                                        text.clone(),
                                    )),
                                };
                                return Some((
                                    Ok(proto_chunk),
                                    (byte_stream, buffer, provider_name, model_id),
                                ));
                            }

                            if let Some(ref tool_calls) = choice.delta.tool_calls
                                && let Some(tc) = tool_calls.first() {
                                    let proto_chunk = CompleteChunk {
                                        id: chunk.id.clone(),
                                        model_used: chunk.model.clone(),
                                        tier: 0,
                                        data: Some(
                                            proto::complete_chunk::Data::ToolCallDelta(
                                                ToolCallMessage {
                                                    id: tc.id.clone().unwrap_or_default(),
                                                    name: tc
                                                        .function
                                                        .as_ref()
                                                        .and_then(|f| f.name.clone())
                                                        .unwrap_or_default(),
                                                    arguments: tc
                                                        .function
                                                        .as_ref()
                                                        .and_then(|f| f.arguments.clone())
                                                        .unwrap_or_default(),
                                                },
                                            ),
                                        ),
                                    };
                                    return Some((
                                        Ok(proto_chunk),
                                        (byte_stream, buffer, provider_name, model_id),
                                    ));
                                }

                            if let Some(ref finish_reason) = choice.finish_reason {
                                // If usage info is present in the final chunk, emit it first.
                                // Then emit the done marker.
                                let done_chunk = CompleteChunk {
                                    id: chunk.id.clone(),
                                    model_used: chunk.model.clone(),
                                    tier: 0,
                                    data: Some(proto::complete_chunk::Data::Done(ChunkDone {
                                        finish_reason: finish_reason.clone(),
                                        escalated: false,
                                    })),
                                };
                                return Some((
                                    Ok(done_chunk),
                                    (byte_stream, buffer, provider_name, model_id),
                                ));
                            }
                        }

                        // Usage-only chunk (OpenAI sends this at the end with stream_options).
                        if let Some(ref usage) = chunk.usage {
                            let usage_chunk = CompleteChunk {
                                id: chunk.id.clone(),
                                model_used: chunk.model.clone(),
                                tier: 0,
                                data: Some(proto::complete_chunk::Data::Usage(ChunkUsage {
                                    tokens_in: usage.prompt_tokens,
                                    tokens_out: usage.completion_tokens,
                                    cost_usd: 0.0,
                                    cache_kind: String::new(),
                                })),
                            };
                            return Some((
                                Ok(usage_chunk),
                                (byte_stream, buffer, provider_name, model_id),
                            ));
                        }

                        continue;
                    }

                    // Need more data from the network.
                    match byte_stream.next().await {
                        Some(Ok(bytes)) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));
                        }
                        Some(Err(e)) => {
                            return Some((
                                Err(ProviderError::NetworkError {
                                    provider: provider_name.clone(),
                                    detail: e.to_string(),
                                }),
                                (byte_stream, buffer, provider_name, model_id),
                            ));
                        }
                        None => {
                            // Stream ended without [DONE] — that's ok.
                            return None;
                        }
                    }
                }
            },
        );

        Ok(Box::pin(stream))
    }

    #[instrument(skip(self, req), fields(provider = "openai", model))]
    async fn embed(
        &self,
        model: &str,
        req: &EmbedRequest,
    ) -> Result<EmbedResponse, ProviderError> {
        tracing::Span::current().record("model", model);

        let oai_req = OaiEmbedRequest {
            model: model.to_string(),
            input: req.texts.clone(),
        };

        let resp = self
            .client
            .post(format!("{BASE_URL}/embeddings"))
            .bearer_auth(&self.api_key)
            .json(&oai_req)
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

        let oai: OaiEmbedResponse =
            serde_json::from_str(&body).map_err(|e| ProviderError::NetworkError {
                provider: self.name().into(),
                detail: format!("failed to parse embed response: {e}"),
            })?;

        let model_info = self.models.iter().find(|m| m.model_id == model);
        let cost_usd = model_info
            .map(|m| m.cost(oai.usage.total_tokens, 0))
            .unwrap_or(0.0);

        let embeddings = oai
            .data
            .iter()
            .map(|e| {
                let dims = e.embedding.len() as i32;
                Embedding {
                    values: e.embedding.clone(),
                    dimensions: dims,
                }
            })
            .collect();

        Ok(EmbedResponse {
            embeddings,
            model_used: oai.model,
            total_tokens: oai.usage.total_tokens,
            cost_usd,
        })
    }
}
