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
        let ts: i64 = timestamp
            .parse()
            .map_err(|_| AppError::WebhookVerification("invalid timestamp".to_string()))?;
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

    async fn send_message(&self, session: &str, msg: &SurfaceMessage) -> Result<String, AppError> {
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

        let ts = result["ts"].as_str().unwrap_or("unknown").to_string();

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

        let team_id = payload["team_id"].as_str().unwrap_or("unknown").to_string();
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

        let actions = payload["actions"].as_array().cloned().unwrap_or_default();

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
                    filename: f["name"].as_str().unwrap_or("unknown").to_string(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_adapter() -> SlackAdapter {
        SlackAdapter::new(
            "signing-secret-abc".to_string(),
            "xoxb-bot-token".to_string(),
        )
    }

    // ---- verify_webhook (HMAC-SHA256) ----

    fn build_slack_headers(secret: &str, timestamp: &str, body: &[u8]) -> HeaderMap {
        let sig_basestring = format!("v0:{timestamp}:{}", String::from_utf8_lossy(body));
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(sig_basestring.as_bytes());
        let sig = format!("v0={}", hex::encode(mac.finalize().into_bytes()));

        let mut headers = HeaderMap::new();
        headers.insert("x-slack-request-timestamp", timestamp.parse().unwrap());
        headers.insert("x-slack-signature", sig.parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn verify_webhook_valid_signature() {
        let adapter = make_adapter();
        let now = chrono::Utc::now().timestamp().to_string();
        let body = b"{\"type\":\"event_callback\"}";
        let headers = build_slack_headers(&adapter.signing_secret, &now, body);
        let result = adapter.verify_webhook(&headers, body).await;
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[tokio::test]
    async fn verify_webhook_wrong_signature_returns_false() {
        let adapter = make_adapter();
        let now = chrono::Utc::now().timestamp().to_string();
        let body = b"{\"type\":\"event_callback\"}";
        let mut headers = build_slack_headers(&adapter.signing_secret, &now, body);
        // overwrite with a bad sig
        headers.insert("x-slack-signature", "v0=badhex".parse().unwrap());
        let result = adapter.verify_webhook(&headers, body).await;
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[tokio::test]
    async fn verify_webhook_missing_timestamp_returns_err() {
        let adapter = make_adapter();
        let mut headers = HeaderMap::new();
        headers.insert("x-slack-signature", "v0=abc".parse().unwrap());
        // no x-slack-request-timestamp
        let result = adapter.verify_webhook(&headers, b"body").await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AppError::WebhookVerification(_)
        ));
    }

    #[tokio::test]
    async fn verify_webhook_missing_signature_returns_err() {
        let adapter = make_adapter();
        let now = chrono::Utc::now().timestamp().to_string();
        let mut headers = HeaderMap::new();
        headers.insert("x-slack-request-timestamp", now.parse().unwrap());
        // no x-slack-signature
        let result = adapter.verify_webhook(&headers, b"body").await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AppError::WebhookVerification(_)
        ));
    }

    #[tokio::test]
    async fn verify_webhook_old_timestamp_rejected() {
        let adapter = make_adapter();
        let stale = "1000000"; // long in the past
        let body = b"{}";
        let headers = build_slack_headers(&adapter.signing_secret, stale, body);
        let result = adapter.verify_webhook(&headers, body).await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AppError::WebhookVerification(_)
        ));
    }

    // ---- parse_event_callback ----

    fn make_event_callback(event_type: &str, text: &str, user: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "event_callback",
            "team_id": "T123",
            "event": {
                "type": event_type,
                "user": user,
                "text": text,
                "channel": "C_GENERAL",
                "event_ts": "1234567890.123"
            }
        })
    }

    #[test]
    fn parse_event_callback_message() {
        let adapter = make_adapter();
        let payload = make_event_callback("message", "Hello!", "U_BOB");
        let events = adapter.parse_event_callback(&payload).unwrap();
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.tenant_id, "T123");
        assert_eq!(ev.user_id, "U_BOB");
        assert_eq!(ev.session_id, "C_GENERAL");
        assert!(matches!(&ev.kind, EventKind::Message { text, .. } if text == "Hello!"));
    }

    #[test]
    fn parse_event_callback_app_mention() {
        let adapter = make_adapter();
        let payload = make_event_callback("app_mention", "hey bot", "U_ALICE");
        let events = adapter.parse_event_callback(&payload).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0].kind, EventKind::Message { .. }));
    }

    #[test]
    fn parse_event_callback_bot_message_ignored() {
        let adapter = make_adapter();
        let payload = serde_json::json!({
            "type": "event_callback",
            "team_id": "T123",
            "event": {
                "type": "message",
                "bot_id": "B_SOME_BOT",
                "text": "I am a bot",
                "channel": "C_GENERAL",
                "event_ts": "111"
            }
        });
        let events = adapter.parse_event_callback(&payload).unwrap();
        assert!(events.is_empty(), "bot messages must be ignored");
    }

    #[test]
    fn parse_event_callback_bot_subtype_ignored() {
        let adapter = make_adapter();
        let payload = serde_json::json!({
            "type": "event_callback",
            "team_id": "T123",
            "event": {
                "type": "message",
                "subtype": "bot_message",
                "text": "bot says hi",
                "channel": "C_X",
                "event_ts": "222"
            }
        });
        let events = adapter.parse_event_callback(&payload).unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn parse_event_callback_unknown_type_ignored() {
        let adapter = make_adapter();
        let payload = serde_json::json!({
            "type": "event_callback",
            "team_id": "T123",
            "event": {
                "type": "reaction_added",
                "user": "U1",
                "channel": "C1",
                "event_ts": "333"
            }
        });
        let events = adapter.parse_event_callback(&payload).unwrap();
        assert!(events.is_empty());
    }

    // ---- parse_block_actions ----

    #[test]
    fn parse_block_actions_approve() {
        let adapter = make_adapter();
        let payload = serde_json::json!({
            "type": "block_actions",
            "team": { "id": "T_TEAM" },
            "user": { "id": "U_USER" },
            "channel": { "id": "C_CHAN" },
            "actions": [
                {
                    "action_id": "approve_btn",
                    "value": "approve:req-55"
                }
            ]
        });
        let events = adapter.parse_block_actions(&payload).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0].kind, EventKind::ApprovalResponse {
            request_id, approved
        } if request_id == "req-55" && *approved));
        assert_eq!(events[0].tenant_id, "T_TEAM");
        assert_eq!(events[0].user_id, "U_USER");
    }

    #[test]
    fn parse_block_actions_deny() {
        let adapter = make_adapter();
        let payload = serde_json::json!({
            "type": "block_actions",
            "team": { "id": "T" },
            "user": { "id": "U" },
            "channel": { "id": "C" },
            "actions": [
                { "action_id": "deny_btn", "value": "deny:req-77" }
            ]
        });
        let events = adapter.parse_block_actions(&payload).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0].kind, EventKind::ApprovalResponse {
            request_id, approved
        } if request_id == "req-77" && !*approved));
    }

    #[test]
    fn parse_block_actions_unrecognized_action_ignored() {
        let adapter = make_adapter();
        let payload = serde_json::json!({
            "type": "block_actions",
            "team": { "id": "T" },
            "user": { "id": "U" },
            "channel": { "id": "C" },
            "actions": [
                { "action_id": "some_other_btn", "value": "other_value" }
            ]
        });
        let events = adapter.parse_block_actions(&payload).unwrap();
        assert!(events.is_empty());
    }

    // ---- parse_slack_files ----

    #[test]
    fn parse_slack_files_empty_array() {
        let adapter = make_adapter();
        let event = serde_json::json!({ "files": [] });
        assert!(adapter.parse_slack_files(&event).is_empty());
    }

    #[test]
    fn parse_slack_files_no_files_key() {
        let adapter = make_adapter();
        let event = serde_json::json!({});
        assert!(adapter.parse_slack_files(&event).is_empty());
    }

    #[test]
    fn parse_slack_files_extracts_url_private_download() {
        let adapter = make_adapter();
        let event = serde_json::json!({
            "files": [{
                "name": "report.pdf",
                "mimetype": "application/pdf",
                "url_private_download": "https://files.slack.com/report.pdf",
                "size": 12345
            }]
        });
        let files = adapter.parse_slack_files(&event);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].filename, "report.pdf");
        assert_eq!(files[0].content_type, "application/pdf");
        assert_eq!(files[0].url, "https://files.slack.com/report.pdf");
        assert_eq!(files[0].size_bytes, Some(12345));
    }

    #[test]
    fn parse_slack_files_falls_back_to_url_private() {
        let adapter = make_adapter();
        let event = serde_json::json!({
            "files": [{
                "name": "image.png",
                "mimetype": "image/png",
                "url_private": "https://files.slack.com/image.png"
            }]
        });
        let files = adapter.parse_slack_files(&event);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].url, "https://files.slack.com/image.png");
    }

    #[test]
    fn parse_slack_files_skips_entries_without_url() {
        let adapter = make_adapter();
        let event = serde_json::json!({
            "files": [
                { "name": "no-url.txt" },
                { "name": "has-url.txt", "url_private_download": "https://x.com/f", "mimetype": "text/plain" }
            ]
        });
        let files = adapter.parse_slack_files(&event);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].filename, "has-url.txt");
    }
}
