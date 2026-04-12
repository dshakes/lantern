use std::sync::Arc;

use futures::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use tracing::{info, instrument, warn};

use crate::cache::PromptCache;
use crate::proto::{
    CompleteChunk, CompleteRequest, CompleteResponse, EmbedRequest, EmbedResponse, ModelService,
    TokenizeRequest, TokenizeResponse,
};
use crate::router::ModelRouter;

/// The tonic gRPC service implementation for `lantern.v1.ModelService`.
pub struct ModelServiceImpl {
    router: Arc<ModelRouter>,
    cache: Option<Arc<PromptCache>>,
}

impl ModelServiceImpl {
    pub fn new(router: Arc<ModelRouter>, cache: Option<Arc<PromptCache>>) -> Self {
        Self { router, cache }
    }
}

#[tonic::async_trait]
impl ModelService for ModelServiceImpl {
    type CompleteStreamStream = ReceiverStream<Result<CompleteChunk, tonic::Status>>;

    #[instrument(
        skip(self, request),
        fields(
            tenant_id,
            run_id,
            step_id,
        )
    )]
    async fn complete(
        &self,
        request: tonic::Request<CompleteRequest>,
    ) -> Result<tonic::Response<CompleteResponse>, tonic::Status> {
        let req = request.into_inner();
        tracing::Span::current().record("tenant_id", &req.tenant_id.as_str());
        tracing::Span::current().record("run_id", &req.run_id.as_str());
        tracing::Span::current().record("step_id", &req.step_id.as_str());

        // Check cache first.
        if let Some(ref cache) = self.cache {
            if let Some(cached) = cache.get(&req).await {
                info!("returning cached response");
                return Ok(tonic::Response::new(cached));
            }
        }

        let resp = self.router.complete(&req).await.map_err(tonic::Status::from)?;

        // Store in cache (fire-and-forget).
        if let Some(ref cache) = self.cache {
            let cache = cache.clone();
            let req_clone = req.clone();
            let resp_clone = resp.clone();
            tokio::spawn(async move {
                cache.set(&req_clone, &resp_clone).await;
            });
        }

        Ok(tonic::Response::new(resp))
    }

    #[instrument(
        skip(self, request),
        fields(
            tenant_id,
            run_id,
            step_id,
        )
    )]
    async fn complete_stream(
        &self,
        request: tonic::Request<CompleteRequest>,
    ) -> Result<tonic::Response<Self::CompleteStreamStream>, tonic::Status> {
        let req = request.into_inner();
        tracing::Span::current().record("tenant_id", &req.tenant_id.as_str());
        tracing::Span::current().record("run_id", &req.run_id.as_str());
        tracing::Span::current().record("step_id", &req.step_id.as_str());

        let (_model_used, _tier, mut provider_stream) = self
            .router
            .complete_stream(&req)
            .await
            .map_err(tonic::Status::from)?;

        // Bridge the provider stream into a tokio mpsc channel so we get a
        // ReceiverStream that satisfies the tonic streaming response type.
        let (tx, rx) = tokio::sync::mpsc::channel(64);

        tokio::spawn(async move {
            while let Some(result) = provider_stream.next().await {
                let msg = match result {
                    Ok(chunk) => Ok(chunk),
                    Err(e) => {
                        warn!(error = %e, "stream chunk error from provider");
                        Err(tonic::Status::from(e))
                    }
                };
                if tx.send(msg).await.is_err() {
                    // Client disconnected.
                    break;
                }
            }
        });

        Ok(tonic::Response::new(ReceiverStream::new(rx)))
    }

    #[instrument(skip(self, request), fields(tenant_id))]
    async fn embed(
        &self,
        request: tonic::Request<EmbedRequest>,
    ) -> Result<tonic::Response<EmbedResponse>, tonic::Status> {
        let req = request.into_inner();
        tracing::Span::current().record("tenant_id", &req.tenant_id.as_str());

        let resp = self.router.embed(&req).await.map_err(tonic::Status::from)?;
        Ok(tonic::Response::new(resp))
    }

    async fn tokenize(
        &self,
        request: tonic::Request<TokenizeRequest>,
    ) -> Result<tonic::Response<TokenizeResponse>, tonic::Status> {
        let req = request.into_inner();

        // Rough estimate: ~4 characters per token for English text.
        let estimated_tokens = (req.text.len() as f64 / 4.0).ceil() as i32;

        let tokenizer_used = if req.model_hint.is_empty() {
            "estimate-chars/4".to_string()
        } else {
            format!("estimate-chars/4 (hint: {})", req.model_hint)
        };

        Ok(tonic::Response::new(TokenizeResponse {
            token_count: estimated_tokens,
            tokenizer_used,
        }))
    }
}
