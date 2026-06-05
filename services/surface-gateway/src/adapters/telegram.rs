use async_trait::async_trait;
use axum::http::HeaderMap;
use chrono::Utc;
use subtle::ConstantTimeEq;

use crate::adapter::SurfaceAdapter;
use crate::error::AppError;
use crate::types::{Attachment, EventKind, MessageBlock, SurfaceEvent, SurfaceId, SurfaceMessage};

pub struct TelegramAdapter {
    bot_token: String,
    /// Secret token set via Telegram's setWebhook API (`secret_token` field).
    /// Telegram sends this back in every update as X-Telegram-Bot-Api-Secret-Token.
    /// When `None`, webhook verification is disabled and all requests are accepted —
    /// only appropriate when the webhook URL itself is kept secret (not recommended
    /// for production). Set TELEGRAM_SECRET_TOKEN to enable verification.
    secret_token: Option<String>,
    http: reqwest::Client,
}

#[allow(dead_code)]
impl TelegramAdapter {
    pub fn new(bot_token: String, secret_token: Option<String>) -> Self {
        Self {
            bot_token,
            secret_token,
            http: reqwest::Client::new(),
        }
    }

    fn api_url(&self, method: &str) -> String {
        format!("https://api.telegram.org/bot{}/{}", self.bot_token, method)
    }
}

#[async_trait]
impl SurfaceAdapter for TelegramAdapter {
    fn id(&self) -> SurfaceId {
        SurfaceId::Telegram
    }

    fn name(&self) -> &str {
        "Telegram"
    }

    /// C3: verify the X-Telegram-Bot-Api-Secret-Token header using a
    /// constant-time comparison against the configured secret_token.
    ///
    /// - If `secret_token` is configured: the header MUST be present and match.
    ///   Missing or mismatched → fail closed (Ok(false)).
    /// - If `secret_token` is not configured: accept all requests (degraded
    ///   mode — log a warning so operators know verification is off).
    async fn verify_webhook(&self, headers: &HeaderMap, _body: &[u8]) -> Result<bool, AppError> {
        let Some(expected) = &self.secret_token else {
            tracing::warn!("telegram webhook verification disabled: TELEGRAM_SECRET_TOKEN not set");
            return Ok(true);
        };

        let presented = headers
            .get("x-telegram-bot-api-secret-token")
            .and_then(|v| v.to_str().ok());

        let Some(presented) = presented else {
            // Header absent — fail closed.
            return Ok(false);
        };

        // Constant-time comparison to avoid timing oracle.
        let expected_bytes = expected.as_bytes();
        let presented_bytes = presented.as_bytes();
        // ConstantTimeEq requires equal lengths; a length mismatch is itself
        // information, but leaking "wrong length" is unavoidable and acceptable
        // compared to the full timing oracle. We still use ct_eq for the
        // same-length case.
        if expected_bytes.len() != presented_bytes.len() {
            return Ok(false);
        }
        let matches: bool = expected_bytes.ct_eq(presented_bytes).into();
        Ok(matches)
    }

    async fn parse_event(
        &self,
        _headers: &HeaderMap,
        body: &[u8],
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let update: serde_json::Value = serde_json::from_slice(body)
            .map_err(|e| AppError::BadRequest(format!("invalid JSON: {e}")))?;

        // Handle regular messages.
        if let Some(message) = update.get("message") {
            return self.parse_message(message);
        }

        // Handle callback queries (inline keyboard button presses, e.g. approvals).
        if let Some(callback) = update.get("callback_query") {
            return self.parse_callback_query(callback);
        }

        tracing::debug!("ignoring unhandled telegram update type");
        Ok(vec![])
    }

    async fn send_message(&self, session: &str, msg: &SurfaceMessage) -> Result<String, AppError> {
        // session format: "telegram:{chat_id}"
        let chat_id = session.strip_prefix("telegram:").unwrap_or(session);

        // Use MarkdownV2 for code blocks, plain text otherwise.
        let text = format_telegram_text(&msg.text, &msg.blocks);
        let parse_mode = if msg
            .blocks
            .iter()
            .any(|b| matches!(b, MessageBlock::Code { .. }))
        {
            "MarkdownV2"
        } else {
            "HTML"
        };

        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": parse_mode,
        });

        let resp = self
            .http
            .post(self.api_url("sendMessage"))
            .json(&body)
            .send()
            .await?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("telegram api: {e}")))?;

        if result["ok"].as_bool() != Some(true) {
            let desc = result["description"].as_str().unwrap_or("unknown error");
            return Err(AppError::Upstream(format!("telegram api error: {desc}")));
        }

        let msg_id = result["result"]["message_id"]
            .as_i64()
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unknown".to_string());

        tracing::info!(chat_id = %chat_id, message_id = %msg_id, "sent telegram message");
        Ok(msg_id)
    }

    async fn send_approval_card(
        &self,
        session: &str,
        request_id: &str,
        reason: &str,
        approvers: &[String],
    ) -> Result<String, AppError> {
        let chat_id = session.strip_prefix("telegram:").unwrap_or(session);

        let approver_text = if approvers.is_empty() {
            "Anyone can approve.".to_string()
        } else {
            format!("Approvers: {}", approvers.join(", "))
        };

        let text = format!("<b>Approval Requested</b>\n\n{reason}\n\n{approver_text}");

        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "reply_markup": {
                "inline_keyboard": [[
                    {
                        "text": "Approve",
                        "callback_data": format!("approve:{request_id}")
                    },
                    {
                        "text": "Deny",
                        "callback_data": format!("deny:{request_id}")
                    }
                ]]
            }
        });

        let resp = self
            .http
            .post(self.api_url("sendMessage"))
            .json(&body)
            .send()
            .await?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("telegram api: {e}")))?;

        if result["ok"].as_bool() != Some(true) {
            let desc = result["description"].as_str().unwrap_or("unknown error");
            return Err(AppError::Upstream(format!("telegram api error: {desc}")));
        }

        let msg_id = result["result"]["message_id"]
            .as_i64()
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unknown".to_string());

        Ok(msg_id)
    }

    async fn update_message(
        &self,
        session: &str,
        message_id: &str,
        msg: &SurfaceMessage,
    ) -> Result<(), AppError> {
        let chat_id = session.strip_prefix("telegram:").unwrap_or(session);

        let text = format_telegram_text(&msg.text, &msg.blocks);

        let body = serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id.parse::<i64>().unwrap_or(0),
            "text": text,
            "parse_mode": "HTML",
        });

        let resp = self
            .http
            .post(self.api_url("editMessageText"))
            .json(&body)
            .send()
            .await?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("telegram api: {e}")))?;

        if result["ok"].as_bool() != Some(true) {
            let desc = result["description"].as_str().unwrap_or("unknown error");
            return Err(AppError::Upstream(format!(
                "telegram editMessageText error: {desc}"
            )));
        }

        Ok(())
    }
}

impl TelegramAdapter {
    fn parse_message(&self, message: &serde_json::Value) -> Result<Vec<SurfaceEvent>, AppError> {
        let chat_id = message["chat"]["id"]
            .as_i64()
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let user_id = message["from"]["id"]
            .as_i64()
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let msg_id = message["message_id"]
            .as_i64()
            .map(|id| id.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        // Check for commands (messages starting with /).
        if let Some(entities) = message["entities"].as_array() {
            for entity in entities {
                if entity["type"].as_str() == Some("bot_command")
                    && entity["offset"].as_i64() == Some(0)
                {
                    let text = message["text"].as_str().unwrap_or("");
                    let parts: Vec<&str> = text.splitn(2, ' ').collect();
                    let command = parts[0].trim_start_matches('/');
                    let args = parts.get(1).unwrap_or(&"").to_string();

                    return Ok(vec![SurfaceEvent {
                        id: msg_id,
                        surface: SurfaceId::Telegram,
                        tenant_id: chat_id.clone(),
                        user_id,
                        session_id: chat_id,
                        kind: EventKind::Command {
                            name: command.to_string(),
                            args,
                        },
                        timestamp: Utc::now(),
                    }]);
                }
            }
        }

        // Regular text message.
        let text = message["text"].as_str().unwrap_or("").to_string();

        // Check for media attachments.
        let mut attachments = Vec::new();
        if let Some(photos) = message["photo"].as_array() {
            // Take the largest photo (last in array).
            if let Some(photo) = photos.last() {
                let file_id = photo["file_id"].as_str().unwrap_or("").to_string();
                attachments.push(Attachment {
                    filename: format!("photo_{file_id}"),
                    content_type: "image/jpeg".to_string(),
                    url: format!("telegram:file:{file_id}"),
                    size_bytes: photo["file_size"].as_u64(),
                });
            }
        }
        if let Some(doc) = message.get("document") {
            let file_id = doc["file_id"].as_str().unwrap_or("").to_string();
            attachments.push(Attachment {
                filename: doc["file_name"].as_str().unwrap_or("document").to_string(),
                content_type: doc["mime_type"]
                    .as_str()
                    .unwrap_or("application/octet-stream")
                    .to_string(),
                url: format!("telegram:file:{file_id}"),
                size_bytes: doc["file_size"].as_u64(),
            });
        }
        if let Some(voice) = message.get("voice") {
            let file_id = voice["file_id"].as_str().unwrap_or("").to_string();
            attachments.push(Attachment {
                filename: format!("voice_{file_id}.ogg"),
                content_type: voice["mime_type"]
                    .as_str()
                    .unwrap_or("audio/ogg")
                    .to_string(),
                url: format!("telegram:file:{file_id}"),
                size_bytes: voice["file_size"].as_u64(),
            });
        }

        let caption = message["caption"].as_str().unwrap_or("");
        let final_text = if text.is_empty() && !caption.is_empty() {
            caption.to_string()
        } else {
            text
        };

        Ok(vec![SurfaceEvent {
            id: msg_id,
            surface: SurfaceId::Telegram,
            tenant_id: chat_id.clone(),
            user_id,
            session_id: chat_id,
            kind: EventKind::Message {
                text: final_text,
                attachments,
            },
            timestamp: Utc::now(),
        }])
    }

    fn parse_callback_query(
        &self,
        callback: &serde_json::Value,
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let user_id = callback["from"]["id"]
            .as_i64()
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let chat_id = callback["message"]["chat"]["id"]
            .as_i64()
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let data = callback["data"].as_str().unwrap_or("");
        let callback_id = callback["id"].as_str().unwrap_or("").to_string();

        let kind = if let Some(request_id) = data.strip_prefix("approve:") {
            EventKind::ApprovalResponse {
                request_id: request_id.to_string(),
                approved: true,
            }
        } else if let Some(request_id) = data.strip_prefix("deny:") {
            EventKind::ApprovalResponse {
                request_id: request_id.to_string(),
                approved: false,
            }
        } else {
            // Treat other callback data as a message.
            EventKind::Message {
                text: data.to_string(),
                attachments: vec![],
            }
        };

        // Answer the callback query to dismiss the loading indicator.
        let answer_url = format!(
            "https://api.telegram.org/bot{}/answerCallbackQuery",
            self.bot_token
        );
        let http = self.http.clone();
        let answer_body = serde_json::json!({ "callback_query_id": callback_id });
        tokio::spawn(async move {
            let _ = http.post(&answer_url).json(&answer_body).send().await;
        });

        Ok(vec![SurfaceEvent {
            id: callback_id,
            surface: SurfaceId::Telegram,
            tenant_id: chat_id.clone(),
            user_id,
            session_id: chat_id,
            kind,
            timestamp: Utc::now(),
        }])
    }
}

/// Format message text with blocks for Telegram's parse mode.
fn format_telegram_text(text: &str, blocks: &[MessageBlock]) -> String {
    if blocks.is_empty() {
        return text.to_string();
    }

    let mut parts = Vec::new();
    for block in blocks {
        match block {
            MessageBlock::Text(t) => parts.push(t.clone()),
            MessageBlock::Code { language, code } => {
                parts.push(format!(
                    "<pre><code class=\"language-{language}\">{code}</code></pre>"
                ));
            }
            MessageBlock::Image { url, alt } => {
                parts.push(format!("[{alt}]({url})"));
            }
            MessageBlock::Actions(buttons) => {
                // Buttons are sent as inline keyboard, so just add text labels.
                let labels: Vec<String> = buttons.iter().map(|b| b.label.clone()).collect();
                parts.push(format!("Actions: {}", labels.join(" | ")));
            }
            MessageBlock::Divider => parts.push("---".to_string()),
        }
    }

    parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter_with_token(token: &str) -> TelegramAdapter {
        TelegramAdapter::new("bot123".to_string(), Some(token.to_string()))
    }

    fn adapter_no_token() -> TelegramAdapter {
        TelegramAdapter::new("bot123".to_string(), None)
    }

    fn headers_with_secret(secret: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-telegram-bot-api-secret-token", secret.parse().unwrap());
        h
    }

    // C3: secret present + header matches → accept.
    #[tokio::test]
    async fn correct_secret_accepted() {
        let adapter = adapter_with_token("my-secret");
        let headers = headers_with_secret("my-secret");
        let result = adapter.verify_webhook(&headers, b"{}").await;
        assert!(result.is_ok());
        assert!(result.unwrap(), "matching secret must be accepted");
    }

    // C3: secret present + header wrong → reject.
    #[tokio::test]
    async fn wrong_secret_rejected() {
        let adapter = adapter_with_token("my-secret");
        let headers = headers_with_secret("evil-secret");
        let result = adapter.verify_webhook(&headers, b"{}").await;
        assert!(result.is_ok());
        assert!(!result.unwrap(), "wrong secret must be rejected");
    }

    // C3: secret present + header absent → reject.
    #[tokio::test]
    async fn missing_secret_header_rejected() {
        let adapter = adapter_with_token("my-secret");
        let headers = HeaderMap::new();
        let result = adapter.verify_webhook(&headers, b"{}").await;
        assert!(result.is_ok());
        assert!(!result.unwrap(), "missing header must be rejected");
    }

    // Degraded mode: no secret configured → accept (with warning).
    #[tokio::test]
    async fn no_token_configured_accepts_all() {
        let adapter = adapter_no_token();
        let headers = HeaderMap::new();
        let result = adapter.verify_webhook(&headers, b"{}").await;
        assert!(result.is_ok());
        assert!(
            result.unwrap(),
            "no-token mode should accept (degraded — logged as warning)"
        );
    }

    // C3: length-mismatch must not leak via timing (returns false, not panic/error).
    #[tokio::test]
    async fn different_length_secret_rejected() {
        let adapter = adapter_with_token("short");
        let headers = headers_with_secret("this-is-much-longer-secret");
        let result = adapter.verify_webhook(&headers, b"{}").await;
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }
}
