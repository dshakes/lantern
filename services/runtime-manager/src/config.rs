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
    /// Scheduler REST endpoint for self-registration heartbeat
    /// (POST /v1/nodes/heartbeat). Empty disables auto-register.
    pub scheduler_url: String,
    /// Optional shared token used as `X-Scheduler-Token` on heartbeat.
    pub scheduler_token: String,
    /// Logical node identity reported to the scheduler. Defaults to
    /// `node-` + hostname, which is fine for single-node dev.
    pub node_name: String,
    /// Address other services dial to reach this manager's gRPC port.
    /// Defaults to LISTEN_ADDR. Override in NAT'd / multi-host setups.
    pub node_advertise_addr: String,
    pub node_region: String,
    pub node_zone: String,
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

        let docker_socket =
            std::env::var("DOCKER_SOCKET").unwrap_or_else(|_| "/var/run/docker.sock".to_string());

        let agent_image = std::env::var("AGENT_IMAGE")
            .unwrap_or_else(|_| "ghcr.io/lantern/agent-runner:latest".to_string());

        let bundle_s3_endpoint = std::env::var("BUNDLE_S3_ENDPOINT")
            .unwrap_or_else(|_| "http://localhost:9000".to_string());

        let bundle_s3_bucket =
            std::env::var("BUNDLE_S3_BUCKET").unwrap_or_else(|_| "lantern-bundles".to_string());

        let log_level = std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        let scheduler_url = std::env::var("SCHEDULER_URL").unwrap_or_default();
        let scheduler_token = std::env::var("SCHEDULER_TOKEN").unwrap_or_default();

        let node_name = std::env::var("NODE_NAME").unwrap_or_else(|_| {
            let host = std::env::var("HOSTNAME")
                .or_else(|_| std::env::var("HOST"))
                .unwrap_or_else(|_| "local".to_string());
            format!("node-{host}")
        });

        let node_advertise_addr = std::env::var("NODE_ADVERTISE_ADDR").unwrap_or_else(|_| {
            // Default to LISTEN_ADDR with 0.0.0.0 rewritten to localhost
            // (useful default for single-host dev; multi-host setups override).
            let s = listen_addr.to_string();
            s.replace("0.0.0.0", "localhost")
        });

        let node_region = std::env::var("NODE_REGION").unwrap_or_else(|_| "local".to_string());
        let node_zone = std::env::var("NODE_ZONE").unwrap_or_else(|_| "local-a".to_string());

        Ok(Config {
            listen_addr,
            runtime_backend,
            docker_socket,
            agent_image,
            bundle_s3_endpoint,
            bundle_s3_bucket,
            log_level,
            scheduler_url,
            scheduler_token,
            node_name,
            node_advertise_addr,
            node_region,
            node_zone,
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
