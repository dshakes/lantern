use std::fmt;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("rate limited by {provider}: retry after {retry_after_ms}ms")]
    RateLimited {
        provider: String,
        retry_after_ms: u64,
    },

    #[error("server error from {provider}: {status} {message}")]
    ServerError {
        provider: String,
        status: u16,
        message: String,
    },

    #[error("authentication error for {provider}: {message}")]
    AuthError {
        provider: String,
        message: String,
    },

    #[error("invalid request to {provider}: {message}")]
    InvalidRequest {
        provider: String,
        message: String,
    },

    #[error("request to {provider} timed out after {elapsed_ms}ms")]
    Timeout {
        provider: String,
        elapsed_ms: u64,
    },

    #[error("network error communicating with {provider}: {detail}")]
    NetworkError {
        provider: String,
        detail: String,
    },

    #[error("unsupported operation on {provider}: {message}")]
    Unsupported {
        provider: String,
        message: String,
    },
}

impl ProviderError {
    /// Returns true if this error is retryable on a different provider.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            ProviderError::RateLimited { .. }
                | ProviderError::ServerError { .. }
                | ProviderError::Timeout { .. }
                | ProviderError::NetworkError { .. }
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RouterError {
    #[error("no provider available for capability {capability}")]
    NoProvider { capability: String },

    #[error("all providers failed for capability {capability}: {errors}")]
    AllProvidersFailed {
        capability: String,
        errors: ProviderFailures,
    },

    #[error("budget exceeded for tenant {tenant_id}: limit {limit_usd}, used {used_usd}")]
    BudgetExceeded {
        tenant_id: String,
        limit_usd: f64,
        used_usd: f64,
    },
}

/// Collects error messages from multiple failed providers for display.
#[derive(Debug)]
pub struct ProviderFailures(pub Vec<(String, ProviderError)>);

impl fmt::Display for ProviderFailures {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, (name, err)) in self.0.iter().enumerate() {
            if i > 0 {
                write!(f, "; ")?;
            }
            write!(f, "{name}: {err}")?;
        }
        Ok(())
    }
}

impl From<RouterError> for tonic::Status {
    fn from(err: RouterError) -> tonic::Status {
        match &err {
            RouterError::NoProvider { .. } => {
                tonic::Status::not_found(err.to_string())
            }
            RouterError::AllProvidersFailed { .. } => {
                tonic::Status::unavailable(err.to_string())
            }
            RouterError::BudgetExceeded { .. } => {
                tonic::Status::resource_exhausted(err.to_string())
            }
        }
    }
}

impl From<ProviderError> for tonic::Status {
    fn from(err: ProviderError) -> tonic::Status {
        match &err {
            ProviderError::RateLimited { .. } => {
                tonic::Status::resource_exhausted(err.to_string())
            }
            ProviderError::ServerError { .. } => {
                tonic::Status::unavailable(err.to_string())
            }
            ProviderError::AuthError { .. } => {
                tonic::Status::unauthenticated(err.to_string())
            }
            ProviderError::InvalidRequest { .. } => {
                tonic::Status::invalid_argument(err.to_string())
            }
            ProviderError::Timeout { .. } => {
                tonic::Status::deadline_exceeded(err.to_string())
            }
            ProviderError::NetworkError { .. } => {
                tonic::Status::unavailable(err.to_string())
            }
            ProviderError::Unsupported { .. } => {
                tonic::Status::unimplemented(err.to_string())
            }
        }
    }
}
