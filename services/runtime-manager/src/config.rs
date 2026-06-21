use std::net::SocketAddr;

#[derive(Clone, Debug)]
pub enum RuntimeBackend {
    Docker,
    K8s,
    Firecracker,
    Kata,
    Wasm,
}

impl RuntimeBackend {
    fn from_str(s: &str) -> Result<Self, ConfigError> {
        match s.to_lowercase().as_str() {
            "docker" => Ok(RuntimeBackend::Docker),
            "k8s" | "kubernetes" => Ok(RuntimeBackend::K8s),
            "firecracker" | "fc" => Ok(RuntimeBackend::Firecracker),
            "kata" => Ok(RuntimeBackend::Kata),
            "wasm" | "wasmtime" => Ok(RuntimeBackend::Wasm),
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
    /// `runtimeClassName` for gVisor-isolated pods (UNTRUSTED / STANDARD /
    /// DEVCONTAINER). Set via `LANTERN_RUNTIMECLASS_GVISOR` (e.g. `gvisor`).
    /// When unset, STANDARD and DEVCONTAINER degrade to bare runc (allowed);
    /// UNTRUSTED is refused (fail-closed) — only UNTRUSTED/HOSTILE ever fail closed.
    pub runtimeclass_gvisor: Option<String>,
    /// `runtimeClassName` for Kata microVM pods (HOSTILE).
    /// Set via `LANTERN_RUNTIMECLASS_KATA` (e.g. `kata-qemu`).
    /// When unset, HOSTILE is refused (fail-closed).
    pub runtimeclass_kata: Option<String>,
    /// `runtimeClassName` for Wasm pods. Set via `LANTERN_RUNTIMECLASS_WASM`.
    /// Optional — when unset the Wasm in-process backend is preferred; when
    /// set the K8s backend uses this class for WASM isolation.
    pub runtimeclass_wasm: Option<String>,
    /// Allow STANDARD/UNSPECIFIED/DEVCONTAINER workloads to run on bare runc
    /// (shared-kernel) when gVisor is not configured.
    ///
    /// Set `LANTERN_ALLOW_RUNC_STANDARD=1` to opt in.  Default **false**.
    ///
    /// When false (the safe default): STANDARD/UNSPECIFIED/DEVCONTAINER require
    /// either gVisor (preferred) or this flag — a bare runc pod is refused.
    /// When true: STANDARD/UNSPECIFIED/DEVCONTAINER degrade to runc without
    /// gVisor, emitting a `tracing::warn!`.  Only enable this flag for local
    /// development or staging clusters without gVisor installed.
    pub allow_runc_standard: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let listen_addr = std::env::var("LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:50054".to_string())
            .parse::<SocketAddr>()
            .map_err(|e| ConfigError::InvalidAddr(e.to_string()))?;

        let runtime_backend = RuntimeBackend::from_str(
            &std::env::var("RUNTIME_BACKEND").unwrap_or_else(|_| "k8s".to_string()),
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

        // Filter empty/whitespace values: `LANTERN_RUNTIMECLASS_GVISOR=""` must
        // not produce `Some("")` — an empty runtimeClassName in K8s silently
        // falls back to the cluster's default (runc), bypassing the isolation gate.
        let runtimeclass_gvisor = std::env::var("LANTERN_RUNTIMECLASS_GVISOR")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let runtimeclass_kata = std::env::var("LANTERN_RUNTIMECLASS_KATA")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let runtimeclass_wasm = std::env::var("LANTERN_RUNTIMECLASS_WASM")
            .ok()
            .filter(|s| !s.trim().is_empty());

        // Explicit developer opt-in: set to "1" or "true" to allow bare runc
        // for STANDARD/UNSPECIFIED/DEVCONTAINER without gVisor.  Default false.
        let allow_runc_standard = std::env::var("LANTERN_ALLOW_RUNC_STANDARD")
            .ok()
            .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false);

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
            runtimeclass_gvisor,
            runtimeclass_kata,
            runtimeclass_wasm,
            allow_runc_standard,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid LISTEN_ADDR: {0}")]
    InvalidAddr(String),
    #[error("invalid RUNTIME_BACKEND: {0} (expected docker, k8s, firecracker, kata, or wasm)")]
    InvalidBackend(String),
}

#[cfg(test)]
mod tests {
    // -----------------------------------------------------------------------
    // Empty/whitespace env values must not produce Some("") for RuntimeClass
    // names — an empty runtimeClassName in K8s silently falls back to the
    // cluster default (runc), bypassing the isolation gate.
    // -----------------------------------------------------------------------

    /// Helper: apply the same filter logic used in `Config::from_env` to a
    /// raw env value string. Returns `None` for empty/whitespace strings.
    fn filter_runtimeclass(raw: &str) -> Option<String> {
        let s = raw.to_string();
        Some(s).filter(|v| !v.trim().is_empty())
    }

    #[test]
    fn empty_runtimeclass_env_becomes_none() {
        assert_eq!(filter_runtimeclass(""), None);
    }

    #[test]
    fn whitespace_runtimeclass_env_becomes_none() {
        assert_eq!(filter_runtimeclass("   "), None);
        assert_eq!(filter_runtimeclass("\t"), None);
    }

    #[test]
    fn valid_runtimeclass_env_passes_through() {
        assert_eq!(filter_runtimeclass("gvisor"), Some("gvisor".to_string()));
        assert_eq!(
            filter_runtimeclass("kata-qemu"),
            Some("kata-qemu".to_string())
        );
    }

    /// Regression: an empty gVisor env value must NOT satisfy UNTRUSTED.
    /// This test connects the filter to the k8s capability check so the full
    /// chain is covered: empty env → None config → satisfies_isolation = false.
    #[test]
    fn empty_gvisor_env_does_not_satisfy_untrusted() {
        use crate::backends::k8s::{k8s_satisfies_isolation, RuntimeClassConfig};
        use crate::proto::IsolationClass;

        // Simulate what happens when LANTERN_RUNTIMECLASS_GVISOR="" in env.
        let gvisor_from_env = filter_runtimeclass(""); // → None
        let cfg = RuntimeClassConfig {
            gvisor: gvisor_from_env,
            kata: None,
            wasm: None,
            allow_runc_standard: false,
            ..Default::default()
        };
        assert!(
            !k8s_satisfies_isolation(&cfg, IsolationClass::Untrusted),
            "empty LANTERN_RUNTIMECLASS_GVISOR must not satisfy UNTRUSTED"
        );
    }
}
