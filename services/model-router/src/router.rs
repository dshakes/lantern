use std::collections::HashMap;
use std::sync::Arc;

use futures::stream::BoxStream;
use tracing::{debug, info, warn};

use crate::error::{ProviderError, ProviderFailures, RouterError};
use crate::proto::{
    Capability, CompleteChunk, CompleteRequest, CompleteResponse, EmbedRequest, EmbedResponse,
    OptimizeTarget,
};
use crate::provider::{ModelInfo, Provider};
use crate::providers::{AnthropicProvider, OpenAiProvider};

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

    /// Build the provider set to use for one request.
    ///
    /// When `credentials` is non-empty (the multi-tenant control-plane path),
    /// construct a FRESH provider per supplied (provider id -> API key) entry,
    /// so this single request is served with that tenant's own key. When empty
    /// (single-tenant dev), reuse the startup env providers (cheap Arc clones).
    ///
    /// INVARIANT #10: the credential VALUES are secrets. We never log the keys —
    /// only provider ids (the map keys) appear in the debug line below, and only
    /// at debug level. Unknown provider ids are skipped (no panic).
    fn providers_for_request(
        &self,
        credentials: &HashMap<String, String>,
    ) -> Vec<Arc<dyn Provider>> {
        if credentials.is_empty() {
            return self.providers.clone();
        }
        let mut per_request: Vec<Arc<dyn Provider>> = Vec::with_capacity(credentials.len());
        for (provider_id, api_key) in credentials {
            match provider_id.as_str() {
                "openai" => {
                    per_request.push(Arc::new(OpenAiProvider::new(api_key.clone())));
                }
                "anthropic" => {
                    per_request.push(Arc::new(AnthropicProvider::new(api_key.clone())));
                }
                other => {
                    warn!(
                        provider = other,
                        "unknown provider id in request credentials; skipping"
                    );
                }
            }
        }
        // Defensive: if none of the supplied ids were recognized, fall back to
        // the startup providers rather than serving zero candidates.
        if per_request.is_empty() {
            debug!("no recognized per-request providers; using startup providers");
            return self.providers.clone();
        }
        debug!(
            num_per_request = per_request.len(),
            "built per-request providers from supplied credentials"
        );
        per_request
    }

    /// Rank candidates using an EXPLICIT provider set (per-request or startup).
    fn rank_candidates_in(
        providers: &[Arc<dyn Provider>],
        capability: Capability,
        optimize: OptimizeTarget,
    ) -> Vec<(Arc<dyn Provider>, ModelInfo)> {
        let mut candidates: Vec<(Arc<dyn Provider>, ModelInfo)> = Vec::new();
        for provider in providers {
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
                candidates.sort_by(|a, b| b.1.quality_score.cmp(&a.1.quality_score));
            }
            OptimizeTarget::Balanced | OptimizeTarget::Unspecified => {
                candidates.sort_by(|a, b| {
                    let score_a = default_preference_score(a.0.name(), capability);
                    let score_b = default_preference_score(b.0.name(), capability);
                    score_b.cmp(&score_a)
                });
            }
        }
        candidates
    }

    /// Resolve the AUTO capability to a concrete one. AUTO defaults to CHAT_LARGE.
    fn resolve_capability(&self, cap: Capability) -> Capability {
        if cap == Capability::Auto || cap == Capability::Unspecified {
            Capability::ChatLarge
        } else {
            cap
        }
    }

    /// Rank candidate (provider, model) pairs for a given capability and
    /// optimization target, over the STARTUP provider set. Kept for callers
    /// (and tests) that route against the env providers.
    fn rank_candidates(
        &self,
        capability: Capability,
        optimize: OptimizeTarget,
    ) -> Vec<(Arc<dyn Provider>, ModelInfo)> {
        Self::rank_candidates_in(&self.providers, capability, optimize)
    }

    /// Non-streaming completion with failover.
    pub async fn complete(&self, req: &CompleteRequest) -> Result<CompleteResponse, RouterError> {
        let capability = self.resolve_capability(
            Capability::try_from(req.capability).unwrap_or(Capability::Unspecified),
        );
        let optimize =
            OptimizeTarget::try_from(req.optimize).unwrap_or(OptimizeTarget::Unspecified);

        let providers = self.providers_for_request(&req.provider_credentials);
        let candidates = Self::rank_candidates_in(&providers, capability, optimize);
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
    ) -> Result<
        (
            String,
            i32,
            BoxStream<'static, Result<CompleteChunk, ProviderError>>,
        ),
        RouterError,
    > {
        let capability = self.resolve_capability(
            Capability::try_from(req.capability).unwrap_or(Capability::Unspecified),
        );
        let optimize =
            OptimizeTarget::try_from(req.optimize).unwrap_or(OptimizeTarget::Unspecified);

        let providers = self.providers_for_request(&req.provider_credentials);
        let candidates = Self::rank_candidates_in(&providers, capability, optimize);
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
        let capability = if capability == Capability::Auto || capability == Capability::Unspecified
        {
            Capability::EmbedLarge
        } else {
            capability
        };

        let providers = self.providers_for_request(&req.provider_credentials);
        let candidates = Self::rank_candidates_in(&providers, capability, OptimizeTarget::Balanced);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ProviderError;
    use crate::proto::{CompleteRequest, CompleteResponse, EmbedRequest, EmbedResponse};
    use async_trait::async_trait;
    use futures::stream::{self, BoxStream};

    // --- stub provider helpers ---

    struct StubProvider {
        provider_name: &'static str,
        models: Vec<ModelInfo>,
        /// Error to return from `complete`, or None for success.
        complete_error: Option<ProviderError>,
    }

    impl StubProvider {
        fn new(name: &'static str, models: Vec<ModelInfo>) -> Self {
            Self {
                provider_name: name,
                models,
                complete_error: None,
            }
        }

        fn failing(name: &'static str, models: Vec<ModelInfo>, error: ProviderError) -> Self {
            Self {
                provider_name: name,
                models,
                complete_error: Some(error),
            }
        }
    }

    #[async_trait]
    impl Provider for StubProvider {
        fn name(&self) -> &str {
            self.provider_name
        }

        fn supports(&self, cap: Capability) -> bool {
            self.models.iter().any(|m| m.capability == cap)
        }

        fn models(&self) -> &[ModelInfo] {
            &self.models
        }

        async fn complete(
            &self,
            model: &str,
            _req: &CompleteRequest,
        ) -> Result<CompleteResponse, ProviderError> {
            if let Some(ref e) = self.complete_error {
                // clone via matching — ProviderError doesn't implement Clone
                return Err(match e {
                    ProviderError::ServerError {
                        provider,
                        status,
                        message,
                    } => ProviderError::ServerError {
                        provider: provider.clone(),
                        status: *status,
                        message: message.clone(),
                    },
                    ProviderError::Timeout {
                        provider,
                        elapsed_ms,
                    } => ProviderError::Timeout {
                        provider: provider.clone(),
                        elapsed_ms: *elapsed_ms,
                    },
                    ProviderError::AuthError { provider, message } => ProviderError::AuthError {
                        provider: provider.clone(),
                        message: message.clone(),
                    },
                    _ => ProviderError::NetworkError {
                        provider: self.provider_name.into(),
                        detail: "stub".into(),
                    },
                });
            }
            Ok(CompleteResponse {
                id: "stub-id".into(),
                model_used: model.to_string(),
                tier: 0,
                message: None,
                tokens_in: 10,
                tokens_out: 20,
                cost_usd: 0.001,
                cache_kind: String::new(),
                escalated: false,
                latency_ms: 50.0,
            })
        }

        async fn complete_stream(
            &self,
            _model: &str,
            _req: &CompleteRequest,
        ) -> Result<BoxStream<'_, Result<CompleteChunk, ProviderError>>, ProviderError> {
            Ok(Box::pin(stream::empty()))
        }

        async fn embed(
            &self,
            model: &str,
            _req: &EmbedRequest,
        ) -> Result<EmbedResponse, ProviderError> {
            Ok(EmbedResponse {
                embeddings: vec![],
                model_used: model.to_string(),
                total_tokens: 5,
                cost_usd: 0.0001,
            })
        }
    }

    fn chat_large_model(name: &str, cost: f64, quality: u8, latency: u32) -> ModelInfo {
        ModelInfo {
            model_id: name.to_string(),
            capability: Capability::ChatLarge,
            cost_per_m_input: cost,
            cost_per_m_output: cost * 2.0,
            quality_score: quality,
            latency_p50_ms: latency,
        }
    }

    fn make_complete_req(cap: Capability, optimize: OptimizeTarget) -> CompleteRequest {
        CompleteRequest {
            run_id: "r1".into(),
            step_id: "s1".into(),
            tenant_id: "t1".into(),
            capability: cap as i32,
            optimize: optimize as i32,
            messages: vec![],
            tools: vec![],
            response_format: vec![],
            max_tokens: 256,
            temperature: 0.7,
            top_p: 1.0,
            stop: vec![],
            no_cache: true,
            idempotency_key: String::new(),
            provider_credentials: HashMap::new(),
        }
    }

    // ---- resolve_capability ----

    #[test]
    fn resolve_auto_becomes_chat_large() {
        let router = ModelRouter::new(vec![]);
        assert_eq!(
            router.resolve_capability(Capability::Auto),
            Capability::ChatLarge
        );
    }

    #[test]
    fn resolve_unspecified_becomes_chat_large() {
        let router = ModelRouter::new(vec![]);
        assert_eq!(
            router.resolve_capability(Capability::Unspecified),
            Capability::ChatLarge
        );
    }

    #[test]
    fn resolve_explicit_capability_unchanged() {
        let router = ModelRouter::new(vec![]);
        assert_eq!(
            router.resolve_capability(Capability::ReasoningFrontier),
            Capability::ReasoningFrontier
        );
        assert_eq!(
            router.resolve_capability(Capability::EmbedLarge),
            Capability::EmbedLarge
        );
    }

    // ---- rank_candidates / optimize strategies ----

    #[test]
    fn cheap_strategy_sorts_by_cost_ascending() {
        let cheap = Arc::new(StubProvider::new(
            "cheap-co",
            vec![chat_large_model("cheap-model", 0.5, 60, 500)],
        ));
        let expensive = Arc::new(StubProvider::new(
            "expensive-co",
            vec![chat_large_model("expensive-model", 5.0, 90, 200)],
        ));
        // Insert expensive first to prove sorting overrides insertion order.
        let router = ModelRouter::new(vec![
            expensive as Arc<dyn Provider>,
            cheap as Arc<dyn Provider>,
        ]);
        let candidates = router.rank_candidates(Capability::ChatLarge, OptimizeTarget::Cheap);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].1.model_id, "cheap-model");
        assert_eq!(candidates[1].1.model_id, "expensive-model");
    }

    #[test]
    fn fast_strategy_sorts_by_latency_ascending() {
        let slow = Arc::new(StubProvider::new(
            "slow-co",
            vec![chat_large_model("slow-model", 1.0, 90, 2000)],
        ));
        let fast = Arc::new(StubProvider::new(
            "fast-co",
            vec![chat_large_model("fast-model", 2.0, 70, 100)],
        ));
        let router = ModelRouter::new(vec![slow as Arc<dyn Provider>, fast as Arc<dyn Provider>]);
        let candidates = router.rank_candidates(Capability::ChatLarge, OptimizeTarget::Fast);
        assert_eq!(candidates[0].1.model_id, "fast-model");
        assert_eq!(candidates[1].1.model_id, "slow-model");
    }

    #[test]
    fn best_strategy_sorts_by_quality_descending() {
        let low_q = Arc::new(StubProvider::new(
            "low-q",
            vec![chat_large_model("model-low", 1.0, 50, 300)],
        ));
        let high_q = Arc::new(StubProvider::new(
            "high-q",
            vec![chat_large_model("model-high", 3.0, 99, 800)],
        ));
        let router = ModelRouter::new(vec![
            low_q as Arc<dyn Provider>,
            high_q as Arc<dyn Provider>,
        ]);
        let candidates = router.rank_candidates(Capability::ChatLarge, OptimizeTarget::Best);
        assert_eq!(candidates[0].1.model_id, "model-high");
        assert_eq!(candidates[1].1.model_id, "model-low");
    }

    #[test]
    fn balanced_prefers_anthropic_for_reasoning() {
        let openai = Arc::new(StubProvider::new(
            "openai",
            vec![ModelInfo {
                model_id: "gpt-o3".into(),
                capability: Capability::ReasoningLarge,
                cost_per_m_input: 10.0,
                cost_per_m_output: 40.0,
                quality_score: 92,
                latency_p50_ms: 2000,
            }],
        ));
        let anthropic = Arc::new(StubProvider::new(
            "anthropic",
            vec![ModelInfo {
                model_id: "claude-sonnet".into(),
                capability: Capability::ReasoningLarge,
                cost_per_m_input: 3.0,
                cost_per_m_output: 15.0,
                quality_score: 93,
                latency_p50_ms: 1200,
            }],
        ));
        let router = ModelRouter::new(vec![
            openai as Arc<dyn Provider>,
            anthropic as Arc<dyn Provider>,
        ]);
        let candidates =
            router.rank_candidates(Capability::ReasoningLarge, OptimizeTarget::Balanced);
        assert_eq!(candidates[0].0.name(), "anthropic");
    }

    #[test]
    fn balanced_prefers_openai_for_chat_large() {
        let anthropic = Arc::new(StubProvider::new(
            "anthropic",
            vec![ModelInfo {
                model_id: "claude".into(),
                capability: Capability::ChatLarge,
                cost_per_m_input: 3.0,
                cost_per_m_output: 15.0,
                quality_score: 85,
                latency_p50_ms: 800,
            }],
        ));
        let openai = Arc::new(StubProvider::new(
            "openai",
            vec![ModelInfo {
                model_id: "gpt-4o".into(),
                capability: Capability::ChatLarge,
                cost_per_m_input: 2.5,
                cost_per_m_output: 10.0,
                quality_score: 85,
                latency_p50_ms: 600,
            }],
        ));
        let router = ModelRouter::new(vec![
            anthropic as Arc<dyn Provider>,
            openai as Arc<dyn Provider>,
        ]);
        let candidates = router.rank_candidates(Capability::ChatLarge, OptimizeTarget::Balanced);
        assert_eq!(candidates[0].0.name(), "openai");
    }

    #[test]
    fn no_provider_for_capability_returns_empty() {
        let provider = Arc::new(StubProvider::new(
            "only-chat",
            vec![chat_large_model("chat-model", 1.0, 80, 400)],
        ));
        let router = ModelRouter::new(vec![provider as Arc<dyn Provider>]);
        let candidates = router.rank_candidates(Capability::EmbedLarge, OptimizeTarget::Cheap);
        assert!(candidates.is_empty());
    }

    // ---- complete() with failover ----

    #[tokio::test]
    async fn complete_returns_ok_on_single_provider() {
        let provider = Arc::new(StubProvider::new(
            "openai",
            vec![chat_large_model("gpt-4o", 2.5, 85, 600)],
        ));
        let router = ModelRouter::new(vec![provider as Arc<dyn Provider>]);
        let req = make_complete_req(Capability::ChatLarge, OptimizeTarget::Balanced);
        let result = router.complete(&req).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().model_used, "gpt-4o");
    }

    #[tokio::test]
    async fn complete_no_providers_returns_no_provider_error() {
        let router = ModelRouter::new(vec![]);
        let req = make_complete_req(Capability::ChatLarge, OptimizeTarget::Balanced);
        let result = router.complete(&req).await;
        assert!(matches!(result, Err(RouterError::NoProvider { .. })));
    }

    #[tokio::test]
    async fn complete_fails_over_to_second_provider_on_retryable_error() {
        // First provider always times out (retryable).
        let failing = Arc::new(StubProvider::failing(
            "slow-provider",
            vec![chat_large_model("slow-model", 1.0, 80, 500)],
            ProviderError::Timeout {
                provider: "slow-provider".into(),
                elapsed_ms: 5000,
            },
        ));
        // Second provider works fine.
        let working = Arc::new(StubProvider::new(
            "fast-provider",
            vec![chat_large_model("fast-model", 1.5, 75, 300)],
        ));
        let router = ModelRouter::new(vec![
            failing as Arc<dyn Provider>,
            working as Arc<dyn Provider>,
        ]);
        // Use Cheap so slow-provider (cheaper) is tried first.
        let req = make_complete_req(Capability::ChatLarge, OptimizeTarget::Cheap);
        let result = router.complete(&req).await;
        assert!(result.is_ok(), "should succeed via fallback provider");
        let resp = result.unwrap();
        assert_eq!(resp.model_used, "fast-model");
        assert!(resp.escalated, "escalated must be true after failover");
    }

    #[tokio::test]
    async fn complete_non_retryable_error_returns_immediately() {
        let failing = Arc::new(StubProvider::failing(
            "bad-auth",
            vec![chat_large_model("model-a", 1.0, 80, 500)],
            ProviderError::AuthError {
                provider: "bad-auth".into(),
                message: "invalid api key".into(),
            },
        ));
        let fallback = Arc::new(StubProvider::new(
            "good-provider",
            vec![chat_large_model("model-b", 2.0, 70, 400)],
        ));
        let router = ModelRouter::new(vec![
            failing as Arc<dyn Provider>,
            fallback as Arc<dyn Provider>,
        ]);
        let req = make_complete_req(Capability::ChatLarge, OptimizeTarget::Cheap);
        let result = router.complete(&req).await;
        // AuthError is NOT retryable, so we don't fall over to the second provider.
        assert!(matches!(
            result,
            Err(RouterError::AllProvidersFailed { .. })
        ));
    }

    #[tokio::test]
    async fn complete_all_fail_returns_all_providers_failed() {
        let p1 = Arc::new(StubProvider::failing(
            "p1",
            vec![chat_large_model("m1", 1.0, 80, 500)],
            ProviderError::ServerError {
                provider: "p1".into(),
                status: 500,
                message: "boom".into(),
            },
        ));
        let p2 = Arc::new(StubProvider::failing(
            "p2",
            vec![chat_large_model("m2", 2.0, 75, 400)],
            ProviderError::Timeout {
                provider: "p2".into(),
                elapsed_ms: 3000,
            },
        ));
        let router = ModelRouter::new(vec![p1 as Arc<dyn Provider>, p2 as Arc<dyn Provider>]);
        let req = make_complete_req(Capability::ChatLarge, OptimizeTarget::Cheap);
        let result = router.complete(&req).await;
        assert!(matches!(
            result,
            Err(RouterError::AllProvidersFailed { .. })
        ));
    }

    // ---- ModelInfo::cost ----

    #[test]
    fn model_info_cost_calculation() {
        let m = ModelInfo {
            model_id: "test".into(),
            capability: Capability::ChatLarge,
            cost_per_m_input: 2.0,
            cost_per_m_output: 8.0,
            quality_score: 80,
            latency_p50_ms: 400,
        };
        // 1M input + 1M output: 2.0 + 8.0 = 10.0
        let cost = m.cost(1_000_000, 1_000_000);
        assert!((cost - 10.0).abs() < 1e-9);
    }

    #[test]
    fn model_info_cost_zero_tokens() {
        let m = ModelInfo {
            model_id: "test".into(),
            capability: Capability::ChatLarge,
            cost_per_m_input: 5.0,
            cost_per_m_output: 20.0,
            quality_score: 90,
            latency_p50_ms: 600,
        };
        assert_eq!(m.cost(0, 0), 0.0);
    }

    // ---- default_preference_score ----

    #[test]
    fn anthropic_scores_highest_for_reasoning_frontier() {
        let score = default_preference_score("anthropic", Capability::ReasoningFrontier);
        assert_eq!(score, 100);
    }

    #[test]
    fn openai_scores_highest_for_embed_large() {
        let score = default_preference_score("openai", Capability::EmbedLarge);
        assert_eq!(score, 95);
    }

    #[test]
    fn unknown_provider_gets_default_score() {
        let score = default_preference_score("unknown-provider", Capability::ChatLarge);
        assert_eq!(score, 50);
    }

    #[test]
    fn anthropic_code_large_beats_openai_code_large() {
        let anthropic = default_preference_score("anthropic", Capability::CodeLarge);
        let openai = default_preference_score("openai", Capability::CodeLarge);
        assert!(anthropic > openai, "anthropic should be preferred for code");
    }

    // ---- ProviderError::is_retryable ----

    #[test]
    fn rate_limited_is_retryable() {
        let e = ProviderError::RateLimited {
            provider: "x".into(),
            retry_after_ms: 1000,
        };
        assert!(e.is_retryable());
    }

    #[test]
    fn auth_error_is_not_retryable() {
        let e = ProviderError::AuthError {
            provider: "x".into(),
            message: "bad key".into(),
        };
        assert!(!e.is_retryable());
    }

    #[test]
    fn invalid_request_is_not_retryable() {
        let e = ProviderError::InvalidRequest {
            provider: "x".into(),
            message: "bad input".into(),
        };
        assert!(!e.is_retryable());
    }

    #[test]
    fn server_error_is_retryable() {
        let e = ProviderError::ServerError {
            provider: "x".into(),
            status: 503,
            message: "overloaded".into(),
        };
        assert!(e.is_retryable());
    }

    #[test]
    fn timeout_is_retryable() {
        let e = ProviderError::Timeout {
            provider: "x".into(),
            elapsed_ms: 5000,
        };
        assert!(e.is_retryable());
    }

    #[test]
    fn network_error_is_retryable() {
        let e = ProviderError::NetworkError {
            provider: "x".into(),
            detail: "connection refused".into(),
        };
        assert!(e.is_retryable());
    }

    #[test]
    fn unsupported_is_not_retryable() {
        let e = ProviderError::Unsupported {
            provider: "x".into(),
            message: "no embeddings".into(),
        };
        assert!(!e.is_retryable());
    }

    // ---- per-request provider credentials (cutover P2-B5/6) ----

    #[test]
    fn providers_for_request_empty_creds_uses_startup_providers() {
        let startup = Arc::new(StubProvider::new(
            "openai",
            vec![chat_large_model("gpt-4o", 2.5, 85, 600)],
        ));
        let router = ModelRouter::new(vec![startup as Arc<dyn Provider>]);
        let got = router.providers_for_request(&HashMap::new());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name(), "openai");
    }

    #[test]
    fn providers_for_request_builds_from_credentials() {
        // Startup has only openai; the request supplies an anthropic key, so the
        // per-request set must be built from the credentials (real provider),
        // NOT the startup providers.
        let startup = Arc::new(StubProvider::new(
            "openai",
            vec![chat_large_model("gpt-4o", 2.5, 85, 600)],
        ));
        let router = ModelRouter::new(vec![startup as Arc<dyn Provider>]);

        let mut creds = HashMap::new();
        creds.insert("anthropic".to_string(), "sk-ant-tenant-key".to_string());
        let got = router.providers_for_request(&creds);

        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].name(),
            "anthropic",
            "per-request set must come from credentials, not startup providers"
        );
    }

    #[test]
    fn providers_for_request_unknown_id_falls_back_to_startup() {
        let startup = Arc::new(StubProvider::new(
            "openai",
            vec![chat_large_model("gpt-4o", 2.5, 85, 600)],
        ));
        let router = ModelRouter::new(vec![startup as Arc<dyn Provider>]);

        let mut creds = HashMap::new();
        creds.insert("totally-unknown".to_string(), "secret".to_string());
        let got = router.providers_for_request(&creds);

        // No recognized id → defensive fallback to startup providers.
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name(), "openai");
    }

    #[test]
    fn providers_for_request_builds_both_providers() {
        let router = ModelRouter::new(vec![]);
        let mut creds = HashMap::new();
        creds.insert("openai".to_string(), "sk-oai".to_string());
        creds.insert("anthropic".to_string(), "sk-ant".to_string());
        let got = router.providers_for_request(&creds);
        assert_eq!(got.len(), 2);
        let names: std::collections::HashSet<&str> = got.iter().map(|p| p.name()).collect();
        assert!(names.contains("openai"));
        assert!(names.contains("anthropic"));
    }

    #[test]
    fn provider_credentials_excluded_from_serde() {
        // INVARIANT #10 guard: serializing a request must never emit the
        // credential map (it is #[serde(skip)]). This protects against an
        // accidental debug/JSON render of a request leaking the tenant's key.
        let mut req = make_complete_req(Capability::ChatLarge, OptimizeTarget::Balanced);
        req.provider_credentials
            .insert("openai".to_string(), "sk-super-secret-key".to_string());
        let json = serde_json::to_string(&req).expect("serialize");
        assert!(
            !json.contains("sk-super-secret-key"),
            "credential value leaked into serde output"
        );
        assert!(
            !json.contains("provider_credentials"),
            "credential field name leaked into serde output"
        );
    }
}
