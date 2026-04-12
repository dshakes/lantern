use std::net::SocketAddr;

#[derive(Clone, Debug)]
pub enum RuntimeBackend {
    Docker,
    K8s,
    Firecracker,
}

impl RuntimeBackend {
    fn from_str(s: &str) -> Result<Self, ConfigError> {
        match s.to_lowercase().as_str() {
            "docker" => Ok(RuntimeBackend::Docker),
            "k8s" | "kubernetes" => Ok(RuntimeBackend::K8s),
            "firecracker" | "fc" => Ok(RuntimeBackend::Firecracker),
            other => Err(ConfigError::InvalidBackend(other.to_string())),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub runtime_backend: RuntimeBackend,
    pub docker_socket: String,
    pub agent_image: String,
    pub bundle_s3_endpoint: String,
    pub bundle_s3_bucket: String,
    pub log_level: String,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let listen_addr = std::env::var("LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:50054".to_string())
            .parse::<SocketAddr>()
            .map_err(|e| ConfigError::InvalidAddr(e.to_string()))?;

        let runtime_backend = RuntimeBackend::from_str(
            &std::env::var("RUNTIME_BACKEND").unwrap_or_else(|_| "docker".to_string()),
        )?;

        let docker_socket = std::env::var("DOCKER_SOCKET")
            .unwrap_or_else(|_| "/var/run/docker.sock".to_string());

        let agent_image = std::env::var("AGENT_IMAGE")
            .unwrap_or_else(|_| "ghcr.io/lantern/agent-runner:latest".to_string());

        let bundle_s3_endpoint = std::env::var("BUNDLE_S3_ENDPOINT")
            .unwrap_or_else(|_| "http://localhost:9000".to_string());

        let bundle_s3_bucket = std::env::var("BUNDLE_S3_BUCKET")
            .unwrap_or_else(|_| "lantern-bundles".to_string());

        let log_level =
            std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        Ok(Config {
            listen_addr,
            runtime_backend,
            docker_socket,
            agent_image,
            bundle_s3_endpoint,
            bundle_s3_bucket,
            log_level,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid LISTEN_ADDR: {0}")]
    InvalidAddr(String),
    #[error("invalid RUNTIME_BACKEND: {0} (expected docker, k8s, or firecracker)")]
    InvalidBackend(String),
}
