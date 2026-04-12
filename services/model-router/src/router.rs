use std::sync::Arc;

use futures::stream::BoxStream;
use tracing::{debug, info, warn};

use crate::error::{ProviderError, ProviderFailures, RouterError};
use crate::proto::{
    Capability, CompleteChunk, CompleteRequest, CompleteResponse, EmbedRequest, EmbedResponse,
    OptimizeTarget,
};
use crate::provider::{ModelInfo, Provider};

/// The core routing engine. Selects providers and models based on capability and
/// optimization target, with transparent failover on retryable errors.
pub struct ModelRouter {
    providers: Vec<Arc<dyn Provider>>,
}

impl ModelRouter {
    pub fn new(providers: Vec<Arc<dyn Provider>>) -> Self {
        let provider_names: Vec<&str> = providers.iter().map(|p| p.name()).collect();
        info!(?provider_names, "model router initialized");
        Self { providers }
    }

    /// Resolve the AUTO capability to a concrete one. AUTO defaults to CHAT_LARGE.
    fn resolve_capability(&self, cap: Capability) -> Capability {
        if cap == Capability::Auto || cap == Capability::Unspecified {
            Capability::ChatLarge
        } else {
            cap
        }
    }

    /// Rank candidate (provider, model) pairs for a given capability and optimization target.
    fn rank_candidates(
        &self,
        capability: Capability,
        optimize: OptimizeTarget,
    ) -> Vec<(Arc<dyn Provider>, ModelInfo)> {
        let mut candidates: Vec<(Arc<dyn Provider>, ModelInfo)> = Vec::new();

        for provider in &self.providers {
            if let Some(model_info) = provider.model_for(capability) {
                candidates.push((provider.clone(), model_info.clone()));
            }
        }

        match optimize {
            OptimizeTarget::Cheap => {
                candidates.sort_by(|a, b| {
                    let cost_a = a.1.cost_per_m_input + a.1.cost_per_m_output;
                    let cost_b = b.1.cost_per_m_input + b.1.cost_per_m_output;
                    cost_a
                        .partial_cmp(&cost_b)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            OptimizeTarget::Fast => {
                candidates.sort_by_key(|c| c.1.latency_p50_ms);
            }
            OptimizeTarget::Best => {
                // Highest quality first.
                candidates.sort_by(|a, b| b.1.quality_score.cmp(&a.1.quality_score));
            }
            OptimizeTarget::Balanced | OptimizeTarget::Unspecified => {
                // Apply default preference: Anthropic for reasoning/code, OpenAI for chat/embed.
                candidates.sort_by(|a, b| {
                    let score_a = default_preference_score(a.0.name(), capability);
                    let score_b = default_preference_score(b.0.name(), capability);
                    score_b.cmp(&score_a)
                });
            }
        }

        candidates
    }

    /// Non-streaming completion with failover.
    pub async fn complete(
        &self,
        req: &CompleteRequest,
    ) -> Result<CompleteResponse, RouterError> {
        let capability = self.resolve_capability(
            Capability::try_from(req.capability).unwrap_or(Capability::Unspecified),
        );
        let optimize =
            OptimizeTarget::try_from(req.optimize).unwrap_or(OptimizeTarget::Unspecified);

        let candidates = self.rank_candidates(capability, optimize);
        if candidates.is_empty() {
            return Err(RouterError::NoProvider {
                capability: capability.as_str().into(),
            });
        }

        debug!(
            capability = capability.as_str(),
            optimize = ?optimize,
            num_candidates = candidates.len(),
            "routing complete request"
        );

        let mut errors: Vec<(String, ProviderError)> = Vec::new();

        for (provider, model_info) in &candidates {
            debug!(
                provider = provider.name(),
                model = %model_info.model_id,
                "trying provider"
            );

            match provider.complete(&model_info.model_id, req).await {
                Ok(mut resp) => {
                    resp.tier = model_info.quality_score as i32;
                    if !errors.is_empty() {
                        resp.escalated = true;
                    }
                    info!(
                        provider = provider.name(),
                        model = %model_info.model_id,
                        tokens_in = resp.tokens_in,
                        tokens_out = resp.tokens_out,
                        cost_usd = resp.cost_usd,
                        latency_ms = resp.latency_ms,
                        escalated = resp.escalated,
                        "complete succeeded"
                    );
                    return Ok(resp);
                }
                Err(e) => {
                    if e.is_retryable() {
                        warn!(
                            provider = provider.name(),
                            model = %model_info.model_id,
                            error = %e,
                            "provider failed, trying next"
                        );
                        errors.push((provider.name().into(), e));
                    } else {
                        // Non-retryable errors are returned immediately.
                        return Err(RouterError::AllProvidersFailed {
                            capability: capability.as_str().into(),
                            errors: ProviderFailures(vec![(provider.name().into(), e)]),
                        });
                    }
                }
            }
        }

        Err(RouterError::AllProvidersFailed {
            capability: capability.as_str().into(),
            errors: ProviderFailures(errors),
        })
    }

    /// Streaming completion with failover (failover only on connection-level errors,
    /// not mid-stream).
    pub async fn complete_stream(
        &self,
        req: &CompleteRequest,
    ) -> Result<(String, i32, BoxStream<'static, Result<CompleteChunk, ProviderError>>), RouterError>
    {
        let capability = self.resolve_capability(
            Capability::try_from(req.capability).unwrap_or(Capability::Unspecified),
        );
        let optimize =
            OptimizeTarget::try_from(req.optimize).unwrap_or(OptimizeTarget::Unspecified);

        let candidates = self.rank_candidates(capability, optimize);
        if candidates.is_empty() {
            return Err(RouterError::NoProvider {
                capability: capability.as_str().into(),
            });
        }

        debug!(
            capability = capability.as_str(),
            optimize = ?optimize,
            num_candidates = candidates.len(),
            "routing stream request"
        );

        let mut errors: Vec<(String, ProviderError)> = Vec::new();

        for (provider, model_info) in &candidates {
            debug!(
                provider = provider.name(),
                model = %model_info.model_id,
                "trying provider for stream"
            );

            match provider.complete_stream(&model_info.model_id, req).await {
                Ok(stream) => {
                    info!(
                        provider = provider.name(),
                        model = %model_info.model_id,
                        escalated = !errors.is_empty(),
                        "stream connected"
                    );
                    // We need to convert the stream to 'static lifetime.
                    // The provider is behind an Arc, so it lives long enough.
                    // SAFETY: The stream borrows from provider which is Arc'd and lives
                    // in self.providers. We transmute the lifetime to 'static. This is
                    // safe because the ModelRouter (and its Arc<dyn Provider>) outlive
                    // any individual RPC.
                    let static_stream: BoxStream<'static, Result<CompleteChunk, ProviderError>> =
                        unsafe { std::mem::transmute(stream) };
                    return Ok((
                        model_info.model_id.clone(),
                        model_info.quality_score as i32,
                        static_stream,
                    ));
                }
                Err(e) => {
                    if e.is_retryable() {
                        warn!(
                            provider = provider.name(),
                            model = %model_info.model_id,
                            error = %e,
                            "stream provider failed, trying next"
                        );
                        errors.push((provider.name().into(), e));
                    } else {
                        return Err(RouterError::AllProvidersFailed {
                            capability: capability.as_str().into(),
                            errors: ProviderFailures(vec![(provider.name().into(), e)]),
                        });
                    }
                }
            }
        }

        Err(RouterError::AllProvidersFailed {
            capability: capability.as_str().into(),
            errors: ProviderFailures(errors),
        })
    }

    /// Embedding with failover.
    pub async fn embed(&self, req: &EmbedRequest) -> Result<EmbedResponse, RouterError> {
        let capability = Capability::try_from(req.capability).unwrap_or(Capability::EmbedLarge);
        let capability = if capability == Capability::Auto || capability == Capability::Unspecified {
            Capability::EmbedLarge
        } else {
            capability
        };

        let candidates = self.rank_candidates(capability, OptimizeTarget::Balanced);
        if candidates.is_empty() {
            return Err(RouterError::NoProvider {
                capability: capability.as_str().into(),
            });
        }

        let mut errors: Vec<(String, ProviderError)> = Vec::new();

        for (provider, model_info) in &candidates {
            match provider.embed(&model_info.model_id, req).await {
                Ok(resp) => return Ok(resp),
                Err(e) => {
                    if e.is_retryable() {
                        warn!(
                            provider = provider.name(),
                            error = %e,
                            "embed provider failed, trying next"
                        );
                        errors.push((provider.name().into(), e));
                    } else if matches!(e, ProviderError::Unsupported { .. }) {
                        // Skip providers that don't support embeddings.
                        errors.push((provider.name().into(), e));
                    } else {
                        return Err(RouterError::AllProvidersFailed {
                            capability: capability.as_str().into(),
                            errors: ProviderFailures(vec![(provider.name().into(), e)]),
                        });
                    }
                }
            }
        }

        Err(RouterError::AllProvidersFailed {
            capability: capability.as_str().into(),
            errors: ProviderFailures(errors),
        })
    }
}

/// Default preference scoring. Higher = preferred.
/// Anthropic is preferred for reasoning and code; OpenAI for chat and embeddings.
fn default_preference_score(provider_name: &str, capability: Capability) -> u8 {
    match (provider_name, capability) {
        ("anthropic", Capability::ReasoningFrontier) => 100,
        ("anthropic", Capability::ReasoningLarge) => 90,
        ("anthropic", Capability::ReasoningSmall) => 85,
        ("anthropic", Capability::CodeLarge) => 95,
        ("openai", Capability::ChatLarge) => 90,
        ("openai", Capability::ChatSmall) => 90,
        ("openai", Capability::ChatEdge) => 90,
        ("openai", Capability::EmbedLarge) => 95,
        ("openai", Capability::EmbedSmall) => 95,
        ("openai", Capability::ReasoningLarge) => 80,
        ("openai", Capability::CodeLarge) => 75,
        _ => 50,
    }
}
