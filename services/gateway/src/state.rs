use std::sync::Arc;

use crate::config::Config;
use crate::grpc::ControlPlaneClient;

#[derive(Clone)]
#[allow(dead_code)]
pub struct AppState {
    pub config: Arc<Config>,
    pub control_plane: ControlPlaneClient,
    pub redis: Option<redis::Client>,
}

impl AppState {
    pub async fn new(config: Config) -> anyhow::Result<Self> {
        let control_plane = ControlPlaneClient::connect(&config.control_plane_addr).await?;

        let redis = match redis::Client::open(config.redis_url.as_str()) {
            Ok(client) => {
                tracing::info!(url = %config.redis_url, "redis client created");
                Some(client)
            }
            Err(e) => {
                tracing::warn!(error = %e, "failed to create redis client, rate limiting disabled");
                None
            }
        };

        Ok(Self {
            config: Arc::new(config),
            control_plane,
            redis,
        })
    }
}
