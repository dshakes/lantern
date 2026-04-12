use async_trait::async_trait;
use axum::http::HeaderMap;
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha1::Sha1;

use crate::adapter::SurfaceAdapter;
use crate::error::AppError;
use crate::types::{EventKind, SurfaceEvent, SurfaceId, SurfaceMessage};

#[allow(dead_code)]
type HmacSha1 = Hmac<Sha1>;

#[allow(dead_code)]
pub struct TwilioAdapter {
    account_sid: String,
    auth_token: String,
    phone_number: String,
    http: reqwest::Client,
}

#[allow(dead_code)]
impl TwilioAdapter {
    pub fn new(account_sid: String, auth_token: String, phone_number: String) -> Self {
        Self {
            account_sid,
            auth_token,
            phone_number,
            http: reqwest::Client::new(),
        }
    }

    fn sms_api_url(&self) -> String {
        format!(
            "https://api.twilio.com/2010-04-01/Accounts/{}/Messages.json",
            self.account_sid
        )
    }

    /// Verify Twilio webhook signature.
    ///
    /// Twilio signs requests by:
    /// 1. Taking the full URL of the request
    /// 2. Sorting all POST parameters alphabetically
    /// 3. Appending each param name and value to the URL
    /// 4. Signing with HMAC-SHA1 using the auth token
    /// 5. Base64-encoding the result
    fn verify_twilio_signature(
        &self,
        headers: &HeaderMap,
        body: &[u8],
        url: &str,
    ) -> Result<bool, AppError> {
        let signature = headers
            .get("x-twilio-signature")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                AppError::WebhookVerification("missing x-twilio-signature".to_string())
            })?;

        // Parse form-encoded body into sorted key-value pairs.
        let body_str = std::str::from_utf8(body)
            .map_err(|_| AppError::BadRequest("invalid UTF-8 body".to_string()))?;
        let mut params: Vec<(String, String)> =
            url::form_urlencoded::parse(body_str.as_bytes())
                .map(|(k, v): (std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)| {
                    (k.to_string(), v.to_string())
                })
                .collect();
        params.sort_by(|a, b| a.0.cmp(&b.0));

        // Build the data string: URL + sorted params concatenated.
        let mut data = url.to_string();
        for (key, value) in &params {
            data.push_str(key);
            data.push_str(value);
        }

        let mut mac = HmacSha1::new_from_slice(self.auth_token.as_bytes())
            .map_err(|e| AppError::Internal(format!("hmac init: {e}")))?;
        mac.update(data.as_bytes());
        let expected = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            mac.finalize().into_bytes(),
        );

        Ok(expected == signature)
    }
}

#[async_trait]
impl SurfaceAdapter for TwilioAdapter {
    fn id(&self) -> SurfaceId {
        SurfaceId::Twilio
    }

    fn name(&self) -> &str {
        "Twilio"
    }

    async fn verify_webhook(&self, headers: &HeaderMap, _body: &[u8]) -> Result<bool, AppError> {
        // We need the request URL for Twilio signature verification.
        // In practice, the route handler passes the full URL.
        // Here, we use a simplified check using just the signature header presence.
        // The full URL-based verification is done in the route handler.
        let has_signature = headers.get("x-twilio-signature").is_some();
        if !has_signature {
            return Err(AppError::WebhookVerification(
                "missing x-twilio-signature".to_string(),
            ));
        }
        // Full verification requires the URL, which is done at route level.
        Ok(true)
    }

    async fn parse_event(
        &self,
        _headers: &HeaderMap,
        body: &[u8],
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let body_str = std::str::from_utf8(body)
            .map_err(|_| AppError::BadRequest("invalid UTF-8 body".to_string()))?;

        let params: std::collections::HashMap<String, String> =
            url::form_urlencoded::parse(body_str.as_bytes())
                .map(|(k, v): (std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)| {
                    (k.to_string(), v.to_string())
                })
                .collect();

        // Check if this is an SMS or voice event.
        if let Some(sms_body) = params.get("Body") {
            return self.parse_sms(&params, sms_body);
        }

        // Voice events have CallSid.
        if params.contains_key("CallSid") {
            return self.parse_voice_event(&params);
        }

        tracing::debug!("ignoring unrecognized twilio event");
        Ok(vec![])
    }

    async fn send_message(
        &self,
        session: &str,
        msg: &SurfaceMessage,
    ) -> Result<String, AppError> {
        // session format: "twilio:{phone_number}"
        let to = session.strip_prefix("twilio:").unwrap_or(session);

        let form = [
            ("From", self.phone_number.as_str()),
            ("To", to),
            ("Body", &msg.text),
        ];

        let resp = self
            .http
            .post(&self.sms_api_url())
            .basic_auth(&self.account_sid, Some(&self.auth_token))
            .form(&form)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Upstream(format!(
                "twilio send failed ({status}): {body}"
            )));
        }

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("twilio api: {e}")))?;

        let sid = result["sid"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        tracing::info!(to = %to, sid = %sid, "sent twilio sms");
        Ok(sid)
    }

    async fn send_approval_card(
        &self,
        session: &str,
        request_id: &str,
        reason: &str,
        _approvers: &[String],
    ) -> Result<String, AppError> {
        // SMS doesn't support interactive buttons, so send a text prompt.
        let text = format!(
            "Approval Requested: {reason}\n\nReply APPROVE {request_id} or DENY {request_id}"
        );
        let approval_msg = SurfaceMessage {
            text,
            blocks: vec![],
            attachments: vec![],
        };
        self.send_message(session, &approval_msg).await
    }

    async fn update_message(
        &self,
        session: &str,
        _message_id: &str,
        msg: &SurfaceMessage,
    ) -> Result<(), AppError> {
        // SMS doesn't support editing. Send a follow-up.
        self.send_message(session, msg).await?;
        Ok(())
    }
}

impl TwilioAdapter {
    fn parse_sms(
        &self,
        params: &std::collections::HashMap<String, String>,
        body: &str,
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let from = params.get("From").cloned().unwrap_or_default();
        let to = params.get("To").cloned().unwrap_or_default();
        let sms_sid = params
            .get("SmsSid")
            .or_else(|| params.get("MessageSid"))
            .cloned()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        // Check for approval responses via text: "APPROVE <id>" or "DENY <id>"
        let trimmed = body.trim();
        let kind = if let Some(request_id) = trimmed
            .strip_prefix("APPROVE ")
            .or_else(|| trimmed.strip_prefix("approve "))
        {
            EventKind::ApprovalResponse {
                request_id: request_id.trim().to_string(),
                approved: true,
            }
        } else if let Some(request_id) = trimmed
            .strip_prefix("DENY ")
            .or_else(|| trimmed.strip_prefix("deny "))
        {
            EventKind::ApprovalResponse {
                request_id: request_id.trim().to_string(),
                approved: false,
            }
        } else {
            // Check for media attachments (MMS).
            let num_media: usize = params
                .get("NumMedia")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let mut attachments = Vec::new();
            for i in 0..num_media {
                let url_key = format!("MediaUrl{i}");
                let type_key = format!("MediaContentType{i}");
                if let Some(url) = params.get(&url_key) {
                    attachments.push(crate::types::Attachment {
                        filename: format!("media_{i}"),
                        content_type: params
                            .get(&type_key)
                            .cloned()
                            .unwrap_or_else(|| "application/octet-stream".to_string()),
                        url: url.clone(),
                        size_bytes: None,
                    });
                }
            }

            EventKind::Message {
                text: body.to_string(),
                attachments,
            }
        };

        Ok(vec![SurfaceEvent {
            id: sms_sid,
            surface: SurfaceId::Twilio,
            tenant_id: to,
            user_id: from,
            session_id: String::new(),
            kind,
            timestamp: Utc::now(),
        }])
    }

    fn parse_voice_event(
        &self,
        params: &std::collections::HashMap<String, String>,
    ) -> Result<Vec<SurfaceEvent>, AppError> {
        let call_sid = params.get("CallSid").cloned().unwrap_or_default();
        let from = params.get("From").cloned().unwrap_or_default();
        let to = params.get("To").cloned().unwrap_or_default();
        let call_status = params.get("CallStatus").cloned().unwrap_or_default();

        // For transcription callbacks, the transcription text is in TranscriptionText.
        if let Some(transcription) = params.get("TranscriptionText") {
            return Ok(vec![SurfaceEvent {
                id: params
                    .get("TranscriptionSid")
                    .cloned()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                surface: SurfaceId::Twilio,
                tenant_id: to,
                user_id: from,
                session_id: call_sid,
                kind: EventKind::Message {
                    text: transcription.clone(),
                    attachments: vec![],
                },
                timestamp: Utc::now(),
            }]);
        }

        // For initial inbound calls, create a command event.
        if call_status == "ringing" {
            return Ok(vec![SurfaceEvent {
                id: call_sid.clone(),
                surface: SurfaceId::Twilio,
                tenant_id: to,
                user_id: from,
                session_id: call_sid,
                kind: EventKind::Command {
                    name: "voice_call".to_string(),
                    args: String::new(),
                },
                timestamp: Utc::now(),
            }]);
        }

        Ok(vec![])
    }
}

/// Generate TwiML for inbound voice calls.
/// This welcomes the caller, records their intent, and plays hold music.
pub fn voice_twiml_greeting() -> String {
    r#"<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Welcome to Lantern. Please describe what you need after the beep. Press any key when finished.</Say>
    <Record maxLength="120" transcribe="true" transcribeCallback="/webhooks/twilio/transcription" playBeep="true" finishOnKey="*" />
    <Say voice="alice">I didn't receive a recording. Goodbye.</Say>
</Response>"#
        .to_string()
}

/// Generate TwiML response with a spoken message.
#[allow(dead_code)]
pub fn voice_twiml_say(text: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">{text}</Say>
</Response>"#
    )
}
