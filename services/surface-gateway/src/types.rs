use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Identifies which external surface a message came from or is going to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceId {
    Slack,
    WhatsApp,
    Telegram,
    Discord,
    Twilio,
    Email,
    Web,
}

impl std::fmt::Display for SurfaceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SurfaceId::Slack => write!(f, "slack"),
            SurfaceId::WhatsApp => write!(f, "whatsapp"),
            SurfaceId::Telegram => write!(f, "telegram"),
            SurfaceId::Discord => write!(f, "discord"),
            SurfaceId::Twilio => write!(f, "twilio"),
            SurfaceId::Email => write!(f, "email"),
            SurfaceId::Web => write!(f, "web"),
        }
    }
}

/// A normalized event from any surface, ready for dispatch to the workflow engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurfaceEvent {
    pub id: String,
    pub surface: SurfaceId,
    pub tenant_id: String,
    pub user_id: String,
    pub session_id: String,
    pub kind: EventKind,
    pub timestamp: DateTime<Utc>,
}

/// The payload of a surface event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    Message {
        text: String,
        attachments: Vec<Attachment>,
    },
    Command {
        name: String,
        args: String,
    },
    ApprovalResponse {
        request_id: String,
        approved: bool,
    },
    Reaction {
        emoji: String,
        message_id: String,
    },
}

/// An attachment (file, image, etc.) on a surface message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub url: String,
    pub size_bytes: Option<u64>,
}

/// An outbound message to be rendered on a surface.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurfaceMessage {
    pub text: String,
    pub blocks: Vec<MessageBlock>,
    pub attachments: Vec<Attachment>,
}

/// Rich-content blocks for outbound messages.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MessageBlock {
    Text(String),
    Code {
        language: String,
        code: String,
    },
    Image {
        url: String,
        alt: String,
    },
    Actions(Vec<ActionButton>),
    Divider,
}

/// An interactive button in an outbound message.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionButton {
    pub id: String,
    pub label: String,
    pub style: ButtonStyle,
    pub value: String,
}

/// Visual style for action buttons.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ButtonStyle {
    Primary,
    Danger,
    Default,
}
