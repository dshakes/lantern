use async_trait::async_trait;
use axum::http::HeaderMap;
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::adapter::SurfaceAdapter;
use crate::error::AppError;
use crate::types::{
    ActionButton, Attachment, ButtonStyle, EventKind, MessageBlock, SurfaceEvent, SurfaceId,
    SurfaceMessage,
};

type HmacSha256 = Hmac<Sha256>;

#[allow(dead_code)]
pub struct SlackAdapter {
    signing_secret: String,
    bot_token: String,
    http: reqwest::Client,
}

#[allow(dead_code)]
impl SlackAdapter {
    pub fn new(signing_secret: String, bot_token: String) -> Self {
        Self {
            signing_secret,
            bot_token,
            http: reqwest::Client::new(),
        }
    }

    /// Build Slack Block Kit blocks from our MessageBlock abstraction.
    fn build_blocks(blocks: &[MessageBlock]) -> Vec<serde_json::Value> {
        blocks
            .iter()
            .map(|block| match block {
                MessageBlock::Text(text) => serde_json::json!({
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": text
                    }
                }),
                MessageBlock::Code { language, code } => serde_json::json!({
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": format!("```{language}\n{code}\n```")
                    }
                }),
                MessageBlock::Image { url, alt } => serde_json::json!({
                    "type": "image",
                    "image_url": url,
                    "alt_text": alt
                }),
                MessageBlock::Actions(buttons) => {
                    let elements: Vec<serde_json::Value> = buttons
                        .iter()
                        .map(|btn| {
                            let style = match btn.style {
                                ButtonStyle::Primary => Some("primary"),
                                ButtonStyle::Danger => Some("danger"),
                                ButtonStyle::Default => None,
                            };
                            let mut el = serde_json::json!({
                                "type": "button",
                                "text": {
                                    "type": "plain_text",
                                    "text": btn.label
                                },
                                "action_id": btn.id,
                                "value": btn.value
                            });
                            if let Some(s) = style {
                                el["style"] = serde_json::Value::String(s.to_string());
                            }
                            el
                        })
                        .collect();
                    serde_json::json!({
                        "type": "actions",
                        "elements": elements
                    })
                }
                MessageBlock::Divider => serde_json::json!({
                    "type": "divider"
                }),
            })
            .collect()
    }
}

#[async_trait]
impl SurfaceAdapter for SlackAdapter {
    fn id(&self) -> SurfaceId {
        SurfaceId::Slack
    }

    fn name(&self) -> &str {
        "Slack"
    }

    async fn verify_webhook(&self, headers: &HeaderMap, body: &[u8]) -> Result<bool, AppError> {
        let timestamp = headers
            .get("x-slack-request-timestamp")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                AppError::WebhookVerification("missing x-slack-request-timestamp".to_string())
            })?;

        let signature = headers
            .get("x-slack-signature")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                AppError::WebhookVerification("missing x-slack-signature".to_string())
            })?;

        // Guard against replay attacks: reject timestamps older than 5 minutes.
        let ts: i64 = timestamp.parse().map_err(|_| {
            AppError::WebhookVerification("invalid timestamp".to_string())
        })?;
        let now = Utc::now().timestamp();
        if (now - ts).unsigned_abs() > 300 {
            return Err(AppError::WebhookVerification(
                "timestamp too old".to_string(),
            ));
        }

        // Slack HMAC: v0=HMAC-SHA256(signing_secret, "v0:{timestamp}:{body}")
        let sig_basestring = format!("v0:{timestamp}:{}", String::from_utf8_lossy(body));
        let mut mac = HmacSha256::new_from_slice(self.signing_secret.as_bytes())
            .map_err(|e| AppError::Internal(format!("hmac init: {e}")))?;
        mac.update(sig_basestring.as_bytes());
        let expected = format!("v0={}", hex::encode(mac.finalize().into_bytes()));

        Ok(expected == signature)
    }

    async fn parse_event(
        &self,
        _headers: &HeaderMap,
        body: &[u8],
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let payload: serde_json::Value = serde_json::from_slice(body)
            .map_err(|e| AppError::BadRequest(format!("invalid JSON: {e}")))?;

        // Slack sends different top-level types. We handle:
        // 1. url_verification (challenge)
        // 2. event_callback (messages, app_mentions)
        // 3. block_actions (interactive payloads, which come form-encoded as "payload=...")

        // Note: url_verification is handled at the route level (returns challenge).
        // Here we only parse event_callback and interactive payloads.

        let event_type = payload["type"].as_str().unwrap_or("");

        match event_type {
            "event_callback" => self.parse_event_callback(&payload),
            "block_actions" => self.parse_block_actions(&payload),
            _ => {
                tracing::debug!(event_type = %event_type, "ignoring slack event type");
                Ok(vec![])
            }
        }
    }

    async fn send_message(
        &self,
        session: &str,
        msg: &SurfaceMessage,
    ) -> Result<String, AppError> {
        // session format for Slack: "slack:{channel_id}" or "slack:{user_id}"
        let channel = session.strip_prefix("slack:").unwrap_or(session);

        let mut body = serde_json::json!({
            "channel": channel,
            "text": msg.text,
        });

        if !msg.blocks.is_empty() {
            body["blocks"] = serde_json::Value::Array(Self::build_blocks(&msg.blocks));
        }

        let resp = self
            .http
            .post("https://slack.com/api/chat.postMessage")
            .bearer_auth(&self.bot_token)
            .json(&body)
            .send()
            .await?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("slack api: {e}")))?;

        if result["ok"].as_bool() != Some(true) {
            let error = result["error"].as_str().unwrap_or("unknown");
            return Err(AppError::Upstream(format!("slack api error: {error}")));
        }

        let ts = result["ts"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        tracing::info!(channel = %channel, ts = %ts, "sent slack message");
        Ok(ts)
    }

    async fn send_approval_card(
        &self,
        session: &str,
        request_id: &str,
        reason: &str,
        approvers: &[String],
    ) -> Result<String, AppError> {
        let approver_text = if approvers.is_empty() {
            "Anyone can approve.".to_string()
        } else {
            format!("Approvers: {}", approvers.join(", "))
        };

        let approval_msg = SurfaceMessage {
            text: format!("Approval requested: {reason}"),
            blocks: vec![
                MessageBlock::Text(format!("*Approval Requested*\n{reason}")),
                MessageBlock::Text(approver_text),
                MessageBlock::Divider,
                MessageBlock::Actions(vec![
                    ActionButton {
                        id: format!("approve:{request_id}"),
                        label: "Approve".to_string(),
                        style: ButtonStyle::Primary,
                        value: format!("approve:{request_id}"),
                    },
                    ActionButton {
                        id: format!("deny:{request_id}"),
                        label: "Deny".to_string(),
                        style: ButtonStyle::Danger,
                        value: format!("deny:{request_id}"),
                    },
                ]),
            ],
            attachments: vec![],
        };

        self.send_message(session, &approval_msg).await
    }

    async fn update_message(
        &self,
        session: &str,
        message_id: &str,
        msg: &SurfaceMessage,
    ) -> Result<(), AppError> {
        let channel = session.strip_prefix("slack:").unwrap_or(session);

        let mut body = serde_json::json!({
            "channel": channel,
            "ts": message_id,
            "text": msg.text,
        });

        if !msg.blocks.is_empty() {
            body["blocks"] = serde_json::Value::Array(Self::build_blocks(&msg.blocks));
        }

        let resp = self
            .http
            .post("https://slack.com/api/chat.update")
            .bearer_auth(&self.bot_token)
            .json(&body)
            .send()
            .await?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("slack api: {e}")))?;

        if result["ok"].as_bool() != Some(true) {
            let error = result["error"].as_str().unwrap_or("unknown");
            return Err(AppError::Upstream(format!(
                "slack chat.update error: {error}"
            )));
        }

        Ok(())
    }
}

impl SlackAdapter {
    fn parse_event_callback(
        &self,
        payload: &serde_json::Value,
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let event = &payload["event"];
        let event_type = event["type"].as_str().unwrap_or("");

        // Ignore bot messages to prevent loops.
        if event["bot_id"].is_string() || event["subtype"].as_str() == Some("bot_message") {
            return Ok(vec![]);
        }

        let team_id = payload["team_id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let user_id = event["user"].as_str().unwrap_or("unknown").to_string();
        let channel = event["channel"].as_str().unwrap_or("unknown").to_string();
        let text = event["text"].as_str().unwrap_or("").to_string();

        let kind = match event_type {
            "message" | "app_mention" => {
                // Check for file attachments.
                let attachments = self.parse_slack_files(event);
                EventKind::Message { text, attachments }
            }
            _ => {
                tracing::debug!(event_type = %event_type, "ignoring slack event subtype");
                return Ok(vec![]);
            }
        };

        Ok(vec![SurfaceEvent {
            id: event["event_ts"]
                .as_str()
                .unwrap_or(&uuid::Uuid::new_v4().to_string())
                .to_string(),
            surface: SurfaceId::Slack,
            tenant_id: team_id,
            user_id,
            session_id: channel,
            kind,
            timestamp: Utc::now(),
        }])
    }

    fn parse_block_actions(
        &self,
        payload: &serde_json::Value,
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let user_id = payload["user"]["id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let team_id = payload["team"]["id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let channel = payload["channel"]["id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        let actions = payload["actions"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        let mut events = Vec::new();
        for action in &actions {
            let action_id = action["action_id"].as_str().unwrap_or("");
            let value = action["value"].as_str().unwrap_or("");

            // Approval buttons have action_id like "approve:{request_id}" or "deny:{request_id}"
            if let Some(request_id) = value.strip_prefix("approve:") {
                events.push(SurfaceEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    surface: SurfaceId::Slack,
                    tenant_id: team_id.clone(),
                    user_id: user_id.clone(),
                    session_id: channel.clone(),
                    kind: EventKind::ApprovalResponse {
                        request_id: request_id.to_string(),
                        approved: true,
                    },
                    timestamp: Utc::now(),
                });
            } else if let Some(request_id) = value.strip_prefix("deny:") {
                events.push(SurfaceEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    surface: SurfaceId::Slack,
                    tenant_id: team_id.clone(),
                    user_id: user_id.clone(),
                    session_id: channel.clone(),
                    kind: EventKind::ApprovalResponse {
                        request_id: request_id.to_string(),
                        approved: false,
                    },
                    timestamp: Utc::now(),
                });
            } else {
                tracing::debug!(action_id = %action_id, value = %value, "unrecognized block action");
            }
        }

        Ok(events)
    }

    fn parse_slack_files(&self, event: &serde_json::Value) -> Vec<Attachment> {
        let Some(files) = event["files"].as_array() else {
            return vec![];
        };

        files
            .iter()
            .filter_map(|f| {
                let url = f["url_private_download"]
                    .as_str()
                    .or_else(|| f["url_private"].as_str())?;
                Some(Attachment {
                    filename: f["name"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string(),
                    content_type: f["mimetype"]
                        .as_str()
                        .unwrap_or("application/octet-stream")
                        .to_string(),
                    url: url.to_string(),
                    size_bytes: f["size"].as_u64(),
                })
            })
            .collect()
    }
}
