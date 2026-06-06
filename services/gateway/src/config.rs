use std::net::SocketAddr;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub control_plane_addr: String,
    pub redis_url: String,
    pub jwt_secret: String,
    pub log_level: String,
    /// Comma-separated list of allowed CORS origins, e.g.
    /// "https://app.lantern.run,http://localhost:3001".
    /// Defaults to "http://localhost:3001" when unset.
    pub allowed_origins: Vec<String>,
    /// Optional path to a PEM CA bundle used to verify the control-plane's
    /// gRPC server cert (`LANTERN_CONTROL_PLANE_TLS_CA`).  When set the
    /// gateway→control-plane channel upgrades to TLS.  When absent (the
    /// default) the channel stays plaintext so the existing Go↔Rust link is
    /// not broken.  This is opt-in and NOT fail-closed — the control-plane
    /// gRPC server side is Go and needs a paired follow-up to serve TLS.
    pub control_plane_tls_ca: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let listen_addr = std::env::var("LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8443".to_string())
            .parse::<SocketAddr>()
            .map_err(|e| ConfigError::InvalidAddr(e.to_string()))?;

        let control_plane_addr = std::env::var("CONTROL_PLANE_ADDR")
            .unwrap_or_else(|_| "http://localhost:50051".to_string());

        let redis_url =
            std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());

        let jwt_secret = std::env::var("JWT_SECRET").map_err(|_| ConfigError::MissingJwtSecret)?;

        let log_level = std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        let allowed_origins = std::env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:3001".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let control_plane_tls_ca = std::env::var("LANTERN_CONTROL_PLANE_TLS_CA").ok();

        Ok(Config {
            listen_addr,
            control_plane_addr,
            redis_url,
            jwt_secret,
            log_level,
            allowed_origins,
            control_plane_tls_ca,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid LISTEN_ADDR: {0}")]
    InvalidAddr(String),
    #[error("JWT_SECRET environment variable is required")]
    MissingJwtSecret,
}
