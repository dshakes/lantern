use std::net::SocketAddr;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub redis_url: String,
    pub control_plane_addr: String,
    // Slack
    pub slack_signing_secret: Option<String>,
    pub slack_bot_token: Option<String>,
    // WhatsApp Business Cloud API
    pub whatsapp_verify_token: Option<String>,
    pub whatsapp_api_token: Option<String>,
    pub whatsapp_phone_number_id: Option<String>,
    // Telegram
    pub telegram_bot_token: Option<String>,
    // Twilio
    pub twilio_account_sid: Option<String>,
    pub twilio_auth_token: Option<String>,
    pub twilio_phone_number: Option<String>,
    // Discord
    pub discord_bot_token: Option<String>,
    pub discord_public_key: Option<String>,
    pub log_level: String,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let listen_addr = std::env::var("LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8444".to_string())
            .parse::<SocketAddr>()
            .map_err(|e| ConfigError::InvalidAddr(e.to_string()))?;

        let redis_url =
            std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());

        let control_plane_addr = std::env::var("CONTROL_PLANE_ADDR")
            .unwrap_or_else(|_| "http://localhost:50051".to_string());

        let log_level = std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        Ok(Config {
            listen_addr,
            redis_url,
            control_plane_addr,
            slack_signing_secret: std::env::var("SLACK_SIGNING_SECRET").ok(),
            slack_bot_token: std::env::var("SLACK_BOT_TOKEN").ok(),
            whatsapp_verify_token: std::env::var("WHATSAPP_VERIFY_TOKEN").ok(),
            whatsapp_api_token: std::env::var("WHATSAPP_API_TOKEN").ok(),
            whatsapp_phone_number_id: std::env::var("WHATSAPP_PHONE_NUMBER_ID").ok(),
            telegram_bot_token: std::env::var("TELEGRAM_BOT_TOKEN").ok(),
            twilio_account_sid: std::env::var("TWILIO_ACCOUNT_SID").ok(),
            twilio_auth_token: std::env::var("TWILIO_AUTH_TOKEN").ok(),
            twilio_phone_number: std::env::var("TWILIO_PHONE_NUMBER").ok(),
            discord_bot_token: std::env::var("DISCORD_BOT_TOKEN").ok(),
            discord_public_key: std::env::var("DISCORD_PUBLIC_KEY").ok(),
            log_level,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid LISTEN_ADDR: {0}")]
    InvalidAddr(String),
}
