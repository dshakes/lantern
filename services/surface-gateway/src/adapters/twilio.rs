use async_trait::async_trait;
use axum::http::HeaderMap;
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use subtle::ConstantTimeEq;

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
    /// Base URL of this surface-gateway as seen by Twilio, e.g.
    /// "https://hooks.example.com". Used to reconstruct the absolute URL
    /// for per-route signature verification. Set SURFACE_GATEWAY_BASE_URL.
    /// When None, per-route verification is skipped with a warning.
    pub webhook_base_url: Option<String>,
    http: reqwest::Client,
}

#[allow(dead_code)]
impl TwilioAdapter {
    pub fn new(
        account_sid: String,
        auth_token: String,
        phone_number: String,
        webhook_base_url: Option<String>,
    ) -> Self {
        Self {
            account_sid,
            auth_token,
            phone_number,
            webhook_base_url,
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
        let mut params: Vec<(String, String)> = url::form_urlencoded::parse(body_str.as_bytes())
            .map(
                |(k, v): (std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)| {
                    (k.to_string(), v.to_string())
                },
            )
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

        // H5: constant-time compare to avoid timing oracle on the base64 HMAC.
        let expected_bytes = expected.as_bytes();
        let presented_bytes = signature.as_bytes();
        if expected_bytes.len() != presented_bytes.len() {
            return Ok(false);
        }
        let matches: bool = expected_bytes.ct_eq(presented_bytes).into();
        Ok(matches)
    }

    /// Called by route handlers with the full absolute URL for that route.
    /// This is the correct entry-point for production traffic.
    ///
    /// When `webhook_base_url` is set, builds the URL as
    /// `{base_url}{path}` and calls `verify_twilio_signature`.
    /// When not set, falls back to header-presence check with a warning.
    pub fn verify_for_route(
        &self,
        headers: &HeaderMap,
        body: &[u8],
        path: &str,
    ) -> Result<bool, AppError> {
        match &self.webhook_base_url {
            Some(base) => {
                let url = format!("{}{}", base.trim_end_matches('/'), path);
                self.verify_twilio_signature(headers, body, &url)
            }
            None => {
                // Degraded: no base URL configured — fall back to header-presence.
                tracing::warn!(
                    path = %path,
                    "Twilio URL-aware signature verification disabled: \
                     SURFACE_GATEWAY_BASE_URL not set"
                );
                if headers.get("x-twilio-signature").is_some() {
                    Ok(true)
                } else {
                    Err(AppError::WebhookVerification(
                        "missing x-twilio-signature".to_string(),
                    ))
                }
            }
        }
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

    /// `verify_webhook` is called by the generic adapter trait path.
    /// For Twilio the URL is required for a complete verification; routes
    /// should call `verify_for_route` directly. This implementation delegates
    /// to `verify_for_route` with an empty path — it will produce a correct
    /// result when `webhook_base_url` already encodes the full URL, and a
    /// degraded (header-presence) result otherwise — which is the same
    /// behaviour as before. All three Twilio routes now call `verify_for_route`
    /// with the exact path so this branch is not reached in production.
    async fn verify_webhook(&self, headers: &HeaderMap, body: &[u8]) -> Result<bool, AppError> {
        self.verify_for_route(headers, body, "")
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
                .map(
                    |(k, v): (std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)| {
                        (k.to_string(), v.to_string())
                    },
                )
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

    async fn send_message(&self, session: &str, msg: &SurfaceMessage) -> Result<String, AppError> {
        // session format: "twilio:{phone_number}"
        let to = session.strip_prefix("twilio:").unwrap_or(session);

        let form = [
            ("From", self.phone_number.as_str()),
            ("To", to),
            ("Body", &msg.text),
        ];

        let resp = self
            .http
            .post(self.sms_api_url())
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

        let sid = result["sid"].as_str().unwrap_or("unknown").to_string();

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_adapter() -> TwilioAdapter {
        TwilioAdapter::new(
            "AC_test_sid".to_string(),
            "auth_token_secret".to_string(),
            "+15005550006".to_string(),
            Some("https://example.com".to_string()),
        )
    }

    // ---- verify_twilio_signature ----

    #[test]
    fn verify_signature_valid() {
        let adapter = make_adapter();
        let url = "https://example.com/webhooks/twilio";
        // Sorted params: Body=hello, From=+1234, To=+5678
        // data = url + "Body" + "hello" + "From" + "+1234" + "To" + "+5678"
        let params_sorted = [("Body", "hello"), ("From", "+1234"), ("To", "+5678")];
        let mut data = url.to_string();
        for (k, v) in &params_sorted {
            data.push_str(k);
            data.push_str(v);
        }
        let mut mac = HmacSha1::new_from_slice(adapter.auth_token.as_bytes()).unwrap();
        mac.update(data.as_bytes());
        let expected_sig = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            mac.finalize().into_bytes(),
        );

        let mut headers = HeaderMap::new();
        headers.insert("x-twilio-signature", expected_sig.parse().unwrap());

        // body is the URL-encoded form with the same params (url::form_urlencoded will parse them)
        let body = "Body=hello&From=%2B1234&To=%2B5678";
        let result = adapter.verify_twilio_signature(&headers, body.as_bytes(), url);
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[test]
    fn verify_signature_wrong_sig_returns_false() {
        let adapter = make_adapter();
        let mut headers = HeaderMap::new();
        headers.insert("x-twilio-signature", "wrongsig==".parse().unwrap());
        let result = adapter.verify_twilio_signature(
            &headers,
            b"Body=hi",
            "https://example.com/webhooks/twilio",
        );
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[test]
    fn verify_signature_missing_header_returns_err() {
        let adapter = make_adapter();
        let headers = HeaderMap::new();
        let result = adapter.verify_twilio_signature(
            &headers,
            b"Body=hi",
            "https://example.com/webhooks/twilio",
        );
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AppError::WebhookVerification(_)
        ));
    }

    // ---- parse_sms ----

    fn sms_params(extra: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        let mut m: std::collections::HashMap<String, String> = [
            ("From", "+15125551234"),
            ("To", "+15005550006"),
            ("SmsSid", "SM123"),
            ("NumMedia", "0"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        for (k, v) in extra {
            m.insert(k.to_string(), v.to_string());
        }
        m
    }

    #[test]
    fn parse_sms_plain_message() {
        let adapter = make_adapter();
        let params = sms_params(&[]);
        let events = adapter.parse_sms(&params, "Hello world").unwrap();
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.id, "SM123");
        assert!(matches!(&ev.kind, EventKind::Message { text, attachments }
            if text == "Hello world" && attachments.is_empty()));
    }

    #[test]
    fn parse_sms_approve_uppercase() {
        let adapter = make_adapter();
        let params = sms_params(&[]);
        let events = adapter.parse_sms(&params, "APPROVE req-42").unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0].kind, EventKind::ApprovalResponse {
            request_id, approved
        } if request_id == "req-42" && *approved));
    }

    #[test]
    fn parse_sms_approve_lowercase() {
        let adapter = make_adapter();
        let params = sms_params(&[]);
        let events = adapter.parse_sms(&params, "approve req-7").unwrap();
        assert!(
            matches!(&events[0].kind, EventKind::ApprovalResponse { approved, .. } if *approved)
        );
    }

    #[test]
    fn parse_sms_deny_uppercase() {
        let adapter = make_adapter();
        let params = sms_params(&[]);
        let events = adapter.parse_sms(&params, "DENY req-99").unwrap();
        assert!(matches!(&events[0].kind, EventKind::ApprovalResponse {
            request_id, approved
        } if request_id == "req-99" && !*approved));
    }

    #[test]
    fn parse_sms_deny_lowercase() {
        let adapter = make_adapter();
        let params = sms_params(&[]);
        let events = adapter.parse_sms(&params, "deny req-5  ").unwrap();
        assert!(
            matches!(&events[0].kind, EventKind::ApprovalResponse { approved, .. } if !*approved)
        );
    }

    #[test]
    fn parse_sms_with_media_attachments() {
        let adapter = make_adapter();
        let params = sms_params(&[
            ("NumMedia", "2"),
            ("MediaUrl0", "https://example.com/img.jpg"),
            ("MediaContentType0", "image/jpeg"),
            ("MediaUrl1", "https://example.com/doc.pdf"),
            ("MediaContentType1", "application/pdf"),
        ]);
        let events = adapter.parse_sms(&params, "picture").unwrap();
        let EventKind::Message { attachments, .. } = &events[0].kind else {
            panic!("expected Message kind");
        };
        assert_eq!(attachments.len(), 2);
        assert_eq!(attachments[0].content_type, "image/jpeg");
        assert_eq!(attachments[1].content_type, "application/pdf");
    }

    #[test]
    fn parse_sms_uses_message_sid_fallback() {
        let adapter = make_adapter();
        let mut params = sms_params(&[("MessageSid", "MSG_FALLBACK")]);
        params.remove("SmsSid");
        let events = adapter.parse_sms(&params, "hi").unwrap();
        assert_eq!(events[0].id, "MSG_FALLBACK");
    }

    // ---- parse_voice_event ----

    fn voice_params(extra: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        let mut m: std::collections::HashMap<String, String> = [
            ("CallSid", "CA_123"),
            ("From", "+15125551234"),
            ("To", "+15005550006"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        for (k, v) in extra {
            m.insert(k.to_string(), v.to_string());
        }
        m
    }

    #[test]
    fn parse_voice_ringing_emits_command() {
        let adapter = make_adapter();
        let params = voice_params(&[("CallStatus", "ringing")]);
        let events = adapter.parse_voice_event(&params).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0].kind, EventKind::Command { name, .. } if name == "voice_call"));
        assert_eq!(events[0].session_id, "CA_123");
    }

    #[test]
    fn parse_voice_non_ringing_produces_no_events() {
        let adapter = make_adapter();
        let params = voice_params(&[("CallStatus", "completed")]);
        let events = adapter.parse_voice_event(&params).unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn parse_voice_transcription_emits_message() {
        let adapter = make_adapter();
        let params = voice_params(&[
            ("TranscriptionText", "Book me a flight"),
            ("TranscriptionSid", "TR_001"),
        ]);
        let events = adapter.parse_voice_event(&params).unwrap();
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0].kind, EventKind::Message { text, .. } if text == "Book me a flight")
        );
    }

    // ---- TwiML helpers ----

    #[test]
    fn voice_twiml_greeting_is_valid_xml() {
        let xml = voice_twiml_greeting();
        assert!(xml.contains("<Response>"));
        assert!(xml.contains("<Say"));
        assert!(xml.contains("<Record"));
    }

    #[test]
    fn voice_twiml_say_embeds_text() {
        let xml = voice_twiml_say("Hello, world!");
        assert!(xml.contains("Hello, world!"));
        assert!(xml.contains("<Say voice=\"alice\">"));
    }
}
