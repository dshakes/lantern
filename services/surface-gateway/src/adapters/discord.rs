use async_trait::async_trait;
use axum::http::HeaderMap;
use chrono::Utc;
use ed25519_dalek::{Signature, VerifyingKey};

use crate::adapter::SurfaceAdapter;
use crate::error::AppError;
use crate::types::{ButtonStyle, EventKind, MessageBlock, SurfaceEvent, SurfaceId, SurfaceMessage};

#[allow(dead_code)]
pub struct DiscordAdapter {
    bot_token: String,
    public_key: String,
    http: reqwest::Client,
}

#[allow(dead_code)]
impl DiscordAdapter {
    pub fn new(bot_token: String, public_key: String) -> Self {
        Self {
            bot_token,
            public_key,
            http: reqwest::Client::new(),
        }
    }

    /// Verify Discord webhook signature using Ed25519.
    ///
    /// Discord sends:
    /// - X-Signature-Ed25519: hex-encoded Ed25519 signature
    /// - X-Signature-Timestamp: timestamp string
    ///
    /// The signed message is `timestamp || body` (bytes concatenated).
    /// Fails closed on any parse or verification error.
    fn verify_ed25519(&self, headers: &HeaderMap, body: &[u8]) -> Result<bool, AppError> {
        let signature_hex = headers
            .get("x-signature-ed25519")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                AppError::WebhookVerification("missing x-signature-ed25519".to_string())
            })?;

        let timestamp = headers
            .get("x-signature-timestamp")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                AppError::WebhookVerification("missing x-signature-timestamp".to_string())
            })?;

        // Decode hex public key → 32-byte array → VerifyingKey.
        let pub_key_bytes = hex::decode(&self.public_key)
            .map_err(|e| AppError::Internal(format!("invalid discord public key hex: {e}")))?;
        let pub_key_arr: [u8; 32] = pub_key_bytes.try_into().map_err(|_| {
            AppError::Internal("discord public key must be exactly 32 bytes".to_string())
        })?;
        let verifying_key = VerifyingKey::from_bytes(&pub_key_arr)
            .map_err(|e| AppError::Internal(format!("invalid discord Ed25519 public key: {e}")))?;

        // Decode hex signature → 64-byte array → Signature.
        let sig_bytes = hex::decode(signature_hex)
            .map_err(|e| AppError::WebhookVerification(format!("invalid signature hex: {e}")))?;
        let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| {
            AppError::WebhookVerification("discord signature must be exactly 64 bytes".to_string())
        })?;
        let signature = Signature::from_bytes(&sig_arr);

        // Signed message = timestamp bytes || body bytes.
        let mut message = Vec::with_capacity(timestamp.len() + body.len());
        message.extend_from_slice(timestamp.as_bytes());
        message.extend_from_slice(body);

        // verify_strict rejects weak/malleable signatures in addition to invalid ones.
        match verifying_key.verify_strict(&message, &signature) {
            Ok(()) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    fn discord_button_style(style: &ButtonStyle) -> u8 {
        match style {
            ButtonStyle::Primary => 1,
            ButtonStyle::Danger => 4,
            ButtonStyle::Default => 2,
        }
    }
}

#[async_trait]
impl SurfaceAdapter for DiscordAdapter {
    fn id(&self) -> SurfaceId {
        SurfaceId::Discord
    }

    fn name(&self) -> &str {
        "Discord"
    }

    async fn verify_webhook(&self, headers: &HeaderMap, body: &[u8]) -> Result<bool, AppError> {
        self.verify_ed25519(headers, body)
    }

    async fn parse_event(
        &self,
        _headers: &HeaderMap,
        body: &[u8],
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let payload: serde_json::Value = serde_json::from_slice(body)
            .map_err(|e| AppError::BadRequest(format!("invalid JSON: {e}")))?;

        let interaction_type = payload["type"].as_u64().unwrap_or(0);

        match interaction_type {
            // Type 1: PING — handled at route level (return type 1 PONG).
            1 => Ok(vec![]),

            // Type 2: APPLICATION_COMMAND (slash commands)
            2 => self.parse_slash_command(&payload),

            // Type 3: MESSAGE_COMPONENT (buttons, select menus)
            3 => self.parse_message_component(&payload),

            // Type 5: MODAL_SUBMIT
            5 => self.parse_modal_submit(&payload),

            _ => {
                tracing::debug!(
                    interaction_type = interaction_type,
                    "ignoring discord interaction type"
                );
                Ok(vec![])
            }
        }
    }

    async fn send_message(&self, session: &str, msg: &SurfaceMessage) -> Result<String, AppError> {
        // session format: "discord:{channel_id}"
        let channel_id = session.strip_prefix("discord:").unwrap_or(session);

        let mut body = serde_json::json!({
            "content": msg.text,
        });

        // Add embeds for rich content.
        let embeds = self.build_embeds(&msg.blocks);
        if !embeds.is_empty() {
            body["embeds"] = serde_json::Value::Array(embeds);
        }

        // Add components for action buttons.
        let components = self.build_components(&msg.blocks);
        if !components.is_empty() {
            body["components"] = serde_json::Value::Array(components);
        }

        let url = format!("https://discord.com/api/v10/channels/{channel_id}/messages");

        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bot {}", self.bot_token))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Upstream(format!(
                "discord api error ({status}): {text}"
            )));
        }

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("discord api: {e}")))?;

        let msg_id = result["id"].as_str().unwrap_or("unknown").to_string();

        tracing::info!(channel_id = %channel_id, message_id = %msg_id, "sent discord message");
        Ok(msg_id)
    }

    async fn send_approval_card(
        &self,
        session: &str,
        request_id: &str,
        reason: &str,
        approvers: &[String],
    ) -> Result<String, AppError> {
        let channel_id = session.strip_prefix("discord:").unwrap_or(session);

        let approver_text = if approvers.is_empty() {
            "Anyone can approve.".to_string()
        } else {
            format!("Approvers: {}", approvers.join(", "))
        };

        let body = serde_json::json!({
            "embeds": [{
                "title": "Approval Requested",
                "description": format!("{reason}\n\n{approver_text}"),
                "color": 16750848,  // Orange
            }],
            "components": [{
                "type": 1,  // ACTION_ROW
                "components": [
                    {
                        "type": 2,  // BUTTON
                        "style": 3, // SUCCESS (green)
                        "label": "Approve",
                        "custom_id": format!("approve:{request_id}"),
                    },
                    {
                        "type": 2,
                        "style": 4, // DANGER (red)
                        "label": "Deny",
                        "custom_id": format!("deny:{request_id}"),
                    }
                ]
            }]
        });

        let url = format!("https://discord.com/api/v10/channels/{channel_id}/messages");

        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bot {}", self.bot_token))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Upstream(format!(
                "discord api error ({status}): {text}"
            )));
        }

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("discord api: {e}")))?;

        let msg_id = result["id"].as_str().unwrap_or("unknown").to_string();

        Ok(msg_id)
    }

    async fn update_message(
        &self,
        session: &str,
        message_id: &str,
        msg: &SurfaceMessage,
    ) -> Result<(), AppError> {
        let channel_id = session.strip_prefix("discord:").unwrap_or(session);

        let mut body = serde_json::json!({
            "content": msg.text,
        });

        let embeds = self.build_embeds(&msg.blocks);
        if !embeds.is_empty() {
            body["embeds"] = serde_json::Value::Array(embeds);
        }

        let components = self.build_components(&msg.blocks);
        body["components"] = serde_json::Value::Array(components);

        let url =
            format!("https://discord.com/api/v10/channels/{channel_id}/messages/{message_id}");

        let resp = self
            .http
            .patch(&url)
            .header("Authorization", format!("Bot {}", self.bot_token))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Upstream(format!(
                "discord edit error ({status}): {text}"
            )));
        }

        Ok(())
    }
}

impl DiscordAdapter {
    fn parse_slash_command(
        &self,
        payload: &serde_json::Value,
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let user_id = payload["member"]["user"]["id"]
            .as_str()
            .or_else(|| payload["user"]["id"].as_str())
            .unwrap_or("unknown")
            .to_string();
        let guild_id = payload["guild_id"].as_str().unwrap_or("dm").to_string();
        let channel_id = payload["channel_id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let interaction_id = payload["id"]
            .as_str()
            .unwrap_or(&uuid::Uuid::new_v4().to_string())
            .to_string();

        let data = &payload["data"];
        let command_name = data["name"].as_str().unwrap_or("unknown").to_string();

        // Collect command options as args.
        let options = data["options"].as_array().cloned().unwrap_or_default();
        let args: Vec<String> = options
            .iter()
            .filter_map(|opt| {
                let name = opt["name"].as_str()?;
                let value = opt.get("value")?;
                Some(format!("{name}={value}"))
            })
            .collect();

        Ok(vec![SurfaceEvent {
            id: interaction_id,
            surface: SurfaceId::Discord,
            tenant_id: guild_id,
            user_id,
            session_id: channel_id,
            kind: EventKind::Command {
                name: command_name,
                args: args.join(" "),
            },
            timestamp: Utc::now(),
        }])
    }

    fn parse_message_component(
        &self,
        payload: &serde_json::Value,
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let user_id = payload["member"]["user"]["id"]
            .as_str()
            .or_else(|| payload["user"]["id"].as_str())
            .unwrap_or("unknown")
            .to_string();
        let guild_id = payload["guild_id"].as_str().unwrap_or("dm").to_string();
        let channel_id = payload["channel_id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let interaction_id = payload["id"]
            .as_str()
            .unwrap_or(&uuid::Uuid::new_v4().to_string())
            .to_string();

        let custom_id = payload["data"]["custom_id"].as_str().unwrap_or("");

        let kind = if let Some(request_id) = custom_id.strip_prefix("approve:") {
            EventKind::ApprovalResponse {
                request_id: request_id.to_string(),
                approved: true,
            }
        } else if let Some(request_id) = custom_id.strip_prefix("deny:") {
            EventKind::ApprovalResponse {
                request_id: request_id.to_string(),
                approved: false,
            }
        } else {
            EventKind::Message {
                text: custom_id.to_string(),
                attachments: vec![],
            }
        };

        Ok(vec![SurfaceEvent {
            id: interaction_id,
            surface: SurfaceId::Discord,
            tenant_id: guild_id,
            user_id,
            session_id: channel_id,
            kind,
            timestamp: Utc::now(),
        }])
    }

    fn parse_modal_submit(
        &self,
        payload: &serde_json::Value,
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let user_id = payload["member"]["user"]["id"]
            .as_str()
            .or_else(|| payload["user"]["id"].as_str())
            .unwrap_or("unknown")
            .to_string();
        let guild_id = payload["guild_id"].as_str().unwrap_or("dm").to_string();
        let channel_id = payload["channel_id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let interaction_id = payload["id"]
            .as_str()
            .unwrap_or(&uuid::Uuid::new_v4().to_string())
            .to_string();

        // Collect modal field values.
        let components = payload["data"]["components"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut text_parts = Vec::new();
        for row in &components {
            let row_components = row["components"].as_array().cloned().unwrap_or_default();
            for component in &row_components {
                if let Some(value) = component["value"].as_str() {
                    text_parts.push(value.to_string());
                }
            }
        }

        Ok(vec![SurfaceEvent {
            id: interaction_id,
            surface: SurfaceId::Discord,
            tenant_id: guild_id,
            user_id,
            session_id: channel_id,
            kind: EventKind::Message {
                text: text_parts.join("\n"),
                attachments: vec![],
            },
            timestamp: Utc::now(),
        }])
    }

    fn build_embeds(&self, blocks: &[MessageBlock]) -> Vec<serde_json::Value> {
        let mut embeds = Vec::new();

        for block in blocks {
            match block {
                MessageBlock::Text(text) => {
                    embeds.push(serde_json::json!({
                        "description": text,
                    }));
                }
                MessageBlock::Code { language, code } => {
                    embeds.push(serde_json::json!({
                        "description": format!("```{language}\n{code}\n```"),
                    }));
                }
                MessageBlock::Image { url, alt } => {
                    embeds.push(serde_json::json!({
                        "image": { "url": url },
                        "description": alt,
                    }));
                }
                // Actions and dividers are handled as components, not embeds.
                _ => {}
            }
        }

        embeds
    }

    fn build_components(&self, blocks: &[MessageBlock]) -> Vec<serde_json::Value> {
        let mut components = Vec::new();

        for block in blocks {
            if let MessageBlock::Actions(buttons) = block {
                let btns: Vec<serde_json::Value> = buttons
                    .iter()
                    .map(|btn| {
                        serde_json::json!({
                            "type": 2,  // BUTTON
                            "style": Self::discord_button_style(&btn.style),
                            "label": btn.label,
                            "custom_id": btn.id,
                        })
                    })
                    .collect();

                components.push(serde_json::json!({
                    "type": 1,  // ACTION_ROW
                    "components": btns,
                }));
            }
        }

        components
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Generate a fresh keypair and return (signing_key, hex_public_key).
    fn make_keypair() -> (SigningKey, String) {
        let signing_key = SigningKey::generate(&mut rand::rngs::OsRng);
        let pub_hex = hex::encode(signing_key.verifying_key().to_bytes());
        (signing_key, pub_hex)
    }

    fn make_adapter(pub_hex: &str) -> DiscordAdapter {
        DiscordAdapter::new("bot-token".to_string(), pub_hex.to_string())
    }

    fn signed_headers(signing_key: &SigningKey, timestamp: &str, body: &[u8]) -> HeaderMap {
        let mut message = Vec::with_capacity(timestamp.len() + body.len());
        message.extend_from_slice(timestamp.as_bytes());
        message.extend_from_slice(body);
        let sig = signing_key.sign(&message);
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-signature-ed25519",
            hex::encode(sig.to_bytes()).parse().unwrap(),
        );
        headers.insert("x-signature-timestamp", timestamp.parse().unwrap());
        headers
    }

    #[test]
    fn valid_signature_accepted() {
        let (sk, pub_hex) = make_keypair();
        let adapter = make_adapter(&pub_hex);
        let body = b"{\"type\":1}";
        let ts = "1700000000";
        let headers = signed_headers(&sk, ts, body);
        let result = adapter.verify_ed25519(&headers, body);
        assert!(result.is_ok());
        assert!(result.unwrap(), "valid Ed25519 signature must be accepted");
    }

    #[test]
    fn forged_signature_rejected() {
        let (sk, pub_hex) = make_keypair();
        let adapter = make_adapter(&pub_hex);
        let body = b"{\"type\":2}";
        let ts = "1700000000";
        // Sign different body content so the signature doesn't match.
        let headers = signed_headers(&sk, ts, b"different body");
        let result = adapter.verify_ed25519(&headers, body);
        assert!(result.is_ok());
        assert!(!result.unwrap(), "mismatched signature must be rejected");
    }

    #[test]
    fn wrong_key_signature_rejected() {
        let (sk_other, _) = make_keypair();
        let (_, pub_hex_real) = make_keypair();
        // Sign with one key but verify against a different public key.
        let adapter = make_adapter(&pub_hex_real);
        let body = b"{\"type\":2}";
        let ts = "1700000000";
        let headers = signed_headers(&sk_other, ts, body);
        let result = adapter.verify_ed25519(&headers, body);
        assert!(result.is_ok());
        assert!(
            !result.unwrap(),
            "signature from wrong key must be rejected"
        );
    }

    #[test]
    fn missing_signature_header_returns_err() {
        let (_, pub_hex) = make_keypair();
        let adapter = make_adapter(&pub_hex);
        let mut headers = HeaderMap::new();
        headers.insert("x-signature-timestamp", "1700000000".parse().unwrap());
        // no x-signature-ed25519
        let result = adapter.verify_ed25519(&headers, b"body");
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AppError::WebhookVerification(_)
        ));
    }

    #[test]
    fn missing_timestamp_header_returns_err() {
        let (sk, pub_hex) = make_keypair();
        let adapter = make_adapter(&pub_hex);
        let body = b"body";
        let sig = sk.sign(body);
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-signature-ed25519",
            hex::encode(sig.to_bytes()).parse().unwrap(),
        );
        // no x-signature-timestamp
        let result = adapter.verify_ed25519(&headers, body);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AppError::WebhookVerification(_)
        ));
    }

    #[test]
    fn invalid_public_key_returns_err() {
        // Adapter configured with a non-hex public key.
        let adapter = make_adapter("notvalidhex!!");
        let mut headers = HeaderMap::new();
        headers.insert("x-signature-ed25519", "aabbcc".parse().unwrap());
        headers.insert("x-signature-timestamp", "1700000000".parse().unwrap());
        let result = adapter.verify_ed25519(&headers, b"body");
        assert!(result.is_err());
    }
}
