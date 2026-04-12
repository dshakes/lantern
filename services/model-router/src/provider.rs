use async_trait::async_trait;
use futures::stream::BoxStream;

use crate::error::ProviderError;
use crate::proto::{
    Capability, CompleteChunk, CompleteRequest, CompleteResponse, EmbedRequest, EmbedResponse,
};

/// A concrete model that a provider exposes.
#[derive(Clone, Debug)]
pub struct ModelInfo {
    pub model_id: String,
    pub capability: Capability,
    /// Cost per 1M input tokens, USD.
    pub cost_per_m_input: f64,
    /// Cost per 1M output tokens, USD.
    pub cost_per_m_output: f64,
    /// Relative quality score (0-100). Higher is better.
    pub quality_score: u8,
    /// Typical p50 latency to first token in ms.
    pub latency_p50_ms: u32,
}

impl ModelInfo {
    /// Compute the cost for a given number of input and output tokens.
    pub fn cost(&self, tokens_in: i64, tokens_out: i64) -> f64 {
        (tokens_in as f64 * self.cost_per_m_input / 1_000_000.0)
            + (tokens_out as f64 * self.cost_per_m_output / 1_000_000.0)
    }
}

#[allow(dead_code)]
#[async_trait]
pub trait Provider: Send + Sync {
    /// Human-readable provider name (e.g. "openai", "anthropic").
    fn name(&self) -> &str;

    /// Returns true if this provider can serve the given capability.
    fn supports(&self, capability: Capability) -> bool;

    /// Returns the list of models this provider offers.
    fn models(&self) -> &[ModelInfo];

    /// Pick the best model for the given capability, or None.
    fn model_for(&self, capability: Capability) -> Option<&ModelInfo> {
        self.models().iter().find(|m| m.capability == capability)
    }

    /// Non-streaming completion.
    async fn complete(
        &self,
        model: &str,
        req: &CompleteRequest,
    ) -> Result<CompleteResponse, ProviderError>;

    /// Streaming completion. Returns a stream of chunks.
    async fn complete_stream(
        &self,
        model: &str,
        req: &CompleteRequest,
    ) -> Result<BoxStream<'_, Result<CompleteChunk, ProviderError>>, ProviderError>;

    /// Embedding. Providers that don't support embeddings should return `Unsupported`.
    async fn embed(
        &self,
        model: &str,
        req: &EmbedRequest,
    ) -> Result<EmbedResponse, ProviderError>;
}
