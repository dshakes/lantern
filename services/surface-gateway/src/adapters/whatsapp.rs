use async_trait::async_trait;
use axum::http::HeaderMap;
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::adapter::SurfaceAdapter;
use crate::error::AppError;
use crate::types::{Attachment, EventKind, SurfaceEvent, SurfaceId, SurfaceMessage};

type HmacSha256 = Hmac<Sha256>;

#[allow(dead_code)]
pub struct WhatsAppAdapter {
    verify_token: String,
    api_token: String,
    phone_number_id: String,
    http: reqwest::Client,
}

#[allow(dead_code)]
impl WhatsAppAdapter {
    pub fn new(verify_token: String, api_token: String, phone_number_id: String) -> Self {
        Self {
            verify_token,
            api_token,
            phone_number_id,
            http: reqwest::Client::new(),
        }
    }

    fn api_url(&self) -> String {
        format!(
            "https://graph.facebook.com/v18.0/{}/messages",
            self.phone_number_id
        )
    }

    /// Verify the webhook signature from Meta using HMAC-SHA256.
    fn verify_signature(&self, headers: &HeaderMap, body: &[u8]) -> Result<bool, AppError> {
        let signature = headers
            .get("x-hub-signature-256")
            .and_then(|v| v.to_str().ok());

        let Some(signature) = signature else {
            // GET verification challenges don't have a signature.
            return Ok(true);
        };

        let expected_prefix = "sha256=";
        let hex_sig = signature.strip_prefix(expected_prefix).ok_or_else(|| {
            AppError::WebhookVerification("invalid signature format".to_string())
        })?;

        let mut mac = HmacSha256::new_from_slice(self.verify_token.as_bytes())
            .map_err(|e| AppError::Internal(format!("hmac init: {e}")))?;
        mac.update(body);
        let expected = hex::encode(mac.finalize().into_bytes());

        Ok(expected == hex_sig)
    }
}

#[async_trait]
impl SurfaceAdapter for WhatsAppAdapter {
    fn id(&self) -> SurfaceId {
        SurfaceId::WhatsApp
    }

    fn name(&self) -> &str {
        "WhatsApp"
    }

    async fn verify_webhook(&self, headers: &HeaderMap, body: &[u8]) -> Result<bool, AppError> {
        self.verify_signature(headers, body)
    }

    async fn parse_event(
        &self,
        _headers: &HeaderMap,
        body: &[u8],
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let payload: serde_json::Value = serde_json::from_slice(body)
            .map_err(|e| AppError::BadRequest(format!("invalid JSON: {e}")))?;

        let mut events = Vec::new();

        // WhatsApp Cloud API wraps everything in entry[].changes[].value.messages[]
        let entries = payload["entry"].as_array().cloned().unwrap_or_default();
        for entry in &entries {
            let changes = entry["changes"].as_array().cloned().unwrap_or_default();
            for change in &changes {
                let value = &change["value"];
                let metadata = &value["metadata"];
                let phone_number_id = metadata["phone_number_id"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();

                // Parse incoming messages.
                let messages = value["messages"].as_array().cloned().unwrap_or_default();
                for message in &messages {
                    let from = message["from"].as_str().unwrap_or("unknown").to_string();
                    let msg_id = message["id"]
                        .as_str()
                        .unwrap_or(&uuid::Uuid::new_v4().to_string())
                        .to_string();
                    let msg_type = message["type"].as_str().unwrap_or("text");

                    let kind = match msg_type {
                        "text" => {
                            let text = message["text"]["body"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();
                            EventKind::Message {
                                text,
                                attachments: vec![],
                            }
                        }
                        "image" | "document" | "audio" | "video" => {
                            let media = &message[msg_type];
                            let caption = media["caption"].as_str().unwrap_or("").to_string();
                            let mime_type = media["mime_type"]
                                .as_str()
                                .unwrap_or("application/octet-stream")
                                .to_string();
                            let media_id = media["id"].as_str().unwrap_or("").to_string();

                            EventKind::Message {
                                text: caption,
                                attachments: vec![Attachment {
                                    filename: format!("{msg_type}_{media_id}"),
                                    content_type: mime_type,
                                    url: format!(
                                        "https://graph.facebook.com/v18.0/{media_id}"
                                    ),
                                    size_bytes: None,
                                }],
                            }
                        }
                        "location" => {
                            let lat = message["location"]["latitude"]
                                .as_f64()
                                .unwrap_or(0.0);
                            let lon = message["location"]["longitude"]
                                .as_f64()
                                .unwrap_or(0.0);
                            EventKind::Message {
                                text: format!("Location: {lat}, {lon}"),
                                attachments: vec![],
                            }
                        }
                        "interactive" => {
                            // Interactive button/list replies (approval responses).
                            let reply_type = message["interactive"]["type"]
                                .as_str()
                                .unwrap_or("");
                            match reply_type {
                                "button_reply" => {
                                    let button_id = message["interactive"]["button_reply"]["id"]
                                        .as_str()
                                        .unwrap_or("");
                                    if let Some(request_id) = button_id.strip_prefix("approve:") {
                                        EventKind::ApprovalResponse {
                                            request_id: request_id.to_string(),
                                            approved: true,
                                        }
                                    } else if let Some(request_id) =
                                        button_id.strip_prefix("deny:")
                                    {
                                        EventKind::ApprovalResponse {
                                            request_id: request_id.to_string(),
                                            approved: false,
                                        }
                                    } else {
                                        EventKind::Message {
                                            text: message["interactive"]["button_reply"]["title"]
                                                .as_str()
                                                .unwrap_or("")
                                                .to_string(),
                                            attachments: vec![],
                                        }
                                    }
                                }
                                "list_reply" => {
                                    let list_id = message["interactive"]["list_reply"]["id"]
                                        .as_str()
                                        .unwrap_or("");
                                    if let Some(request_id) = list_id.strip_prefix("approve:") {
                                        EventKind::ApprovalResponse {
                                            request_id: request_id.to_string(),
                                            approved: true,
                                        }
                                    } else if let Some(request_id) =
                                        list_id.strip_prefix("deny:")
                                    {
                                        EventKind::ApprovalResponse {
                                            request_id: request_id.to_string(),
                                            approved: false,
                                        }
                                    } else {
                                        EventKind::Message {
                                            text: message["interactive"]["list_reply"]["title"]
                                                .as_str()
                                                .unwrap_or("")
                                                .to_string(),
                                            attachments: vec![],
                                        }
                                    }
                                }
                                _ => {
                                    tracing::debug!(reply_type = %reply_type, "ignoring interactive reply type");
                                    continue;
                                }
                            }
                        }
                        "reaction" => {
                            let emoji = message["reaction"]["emoji"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();
                            let reacted_msg_id = message["reaction"]["message_id"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();
                            EventKind::Reaction {
                                emoji,
                                message_id: reacted_msg_id,
                            }
                        }
                        _ => {
                            tracing::debug!(msg_type = %msg_type, "ignoring whatsapp message type");
                            continue;
                        }
                    };

                    events.push(SurfaceEvent {
                        id: msg_id,
                        surface: SurfaceId::WhatsApp,
                        // Use the WhatsApp Business Account phone_number_id as tenant
                        // until resolved by session store.
                        tenant_id: phone_number_id.clone(),
                        user_id: from,
                        session_id: String::new(), // Filled by dispatcher via session store.
                        kind,
                        timestamp: Utc::now(),
                    });
                }

                // Handle statuses (delivered, read) — we acknowledge but don't create events.
                let statuses = value["statuses"].as_array().cloned().unwrap_or_default();
                for status in &statuses {
                    let s = status["status"].as_str().unwrap_or("unknown");
                    let recipient = status["recipient_id"].as_str().unwrap_or("unknown");
                    tracing::debug!(status = %s, recipient = %recipient, "whatsapp status update");
                }
            }
        }

        Ok(events)
    }

    async fn send_message(
        &self,
        session: &str,
        msg: &SurfaceMessage,
    ) -> Result<String, AppError> {
        // session format: "whatsapp:{phone_number}"
        let to = session.strip_prefix("whatsapp:").unwrap_or(session);

        let body = serde_json::json!({
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": {
                "body": msg.text
            }
        });

        let resp = self
            .http
            .post(self.api_url())
            .bearer_auth(&self.api_token)
            .json(&body)
            .send()
            .await?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("whatsapp api: {e}")))?;

        if let Some(error) = result["error"].as_object() {
            let msg = error
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(AppError::Upstream(format!("whatsapp api error: {msg}")));
        }

        let msg_id = result["messages"][0]["id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        tracing::info!(to = %to, msg_id = %msg_id, "sent whatsapp message");
        Ok(msg_id)
    }

    async fn send_approval_card(
        &self,
        session: &str,
        request_id: &str,
        reason: &str,
        _approvers: &[String],
    ) -> Result<String, AppError> {
        let to = session.strip_prefix("whatsapp:").unwrap_or(session);

        // WhatsApp interactive button message (max 3 buttons).
        let body = serde_json::json!({
            "messaging_product": "whatsapp",
            "to": to,
            "type": "interactive",
            "interactive": {
                "type": "button",
                "body": {
                    "text": format!("Approval Requested\n\n{reason}\n\nPlease approve or deny this action.")
                },
                "action": {
                    "buttons": [
                        {
                            "type": "reply",
                            "reply": {
                                "id": format!("approve:{request_id}"),
                                "title": "Approve"
                            }
                        },
                        {
                            "type": "reply",
                            "reply": {
                                "id": format!("deny:{request_id}"),
                                "title": "Deny"
                            }
                        }
                    ]
                }
            }
        });

        let resp = self
            .http
            .post(self.api_url())
            .bearer_auth(&self.api_token)
            .json(&body)
            .send()
            .await?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("whatsapp api: {e}")))?;

        if let Some(error) = result["error"].as_object() {
            let msg = error
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(AppError::Upstream(format!("whatsapp api error: {msg}")));
        }

        let msg_id = result["messages"][0]["id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        Ok(msg_id)
    }

    async fn update_message(
        &self,
        session: &str,
        _message_id: &str,
        msg: &SurfaceMessage,
    ) -> Result<(), AppError> {
        // WhatsApp doesn't support editing messages. Send a follow-up instead.
        self.send_message(session, msg).await?;
        Ok(())
    }
}

/// Check the GET verification challenge for WhatsApp webhook setup.
/// This is called from the route handler, not the adapter trait.
pub fn verify_challenge(
    verify_token: &str,
    mode: &str,
    token: &str,
    challenge: &str,
) -> Result<String, AppError> {
    if mode == "subscribe" && token == verify_token {
        tracing::info!("whatsapp webhook verification succeeded");
        Ok(challenge.to_string())
    } else {
        Err(AppError::WebhookVerification(
            "invalid verify token".to_string(),
        ))
    }
}
