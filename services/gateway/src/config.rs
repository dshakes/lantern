use std::net::SocketAddr;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub control_plane_addr: String,
    pub redis_url: String,
    pub jwt_secret: String,
    pub log_level: String,
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

        let log_level =
            std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        Ok(Config {
            listen_addr,
            control_plane_addr,
            redis_url,
            jwt_secret,
            log_level,
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
