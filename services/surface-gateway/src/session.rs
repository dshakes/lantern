use chrono::Utc;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::types::SurfaceId;

/// Persisted session record mapping (surface, external_user_id) to internal identifiers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub tenant_id: String,
    pub session_id: String,
    pub surface: SurfaceId,
    pub external_user_id: String,
    pub active_run_id: Option<String>,
    pub created_at: String,
    pub last_seen: String,
}

/// Redis-backed session store for surface conversations.
///
/// Key schema:
/// - `surface:session:{surface}:{external_user_id}` -> JSON Session
/// - `surface:presence:{surface}:{external_user_id}` -> ISO timestamp (TTL 5 min)
#[derive(Clone)]
pub struct SessionStore {
    redis: redis::Client,
}

impl SessionStore {
    pub fn new(redis: redis::Client) -> Self {
        Self { redis }
    }

    /// Look up or create a session for the given surface user.
    /// If no session exists, creates one with a new session_id and the supplied tenant_id.
    pub async fn get_or_create(
        &self,
        surface: SurfaceId,
        external_user_id: &str,
        tenant_id: &str,
    ) -> Result<Session, AppError> {
        let key = session_key(surface, external_user_id);
        let mut conn = self
            .redis
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| AppError::Internal(format!("redis connection: {e}")))?;

        let existing: Option<String> = conn.get(&key).await?;

        if let Some(json) = existing {
            let mut session: Session = serde_json::from_str(&json)
                .map_err(|e| AppError::Internal(format!("corrupt session: {e}")))?;
            session.last_seen = Utc::now().to_rfc3339();
            let updated =
                serde_json::to_string(&session).map_err(|e| AppError::Internal(e.to_string()))?;
            conn.set::<_, _, ()>(&key, &updated).await?;
            self.update_presence(&mut conn, surface, external_user_id)
                .await?;
            return Ok(session);
        }

        let session = Session {
            tenant_id: tenant_id.to_string(),
            session_id: uuid::Uuid::new_v4().to_string(),
            surface,
            external_user_id: external_user_id.to_string(),
            active_run_id: None,
            created_at: Utc::now().to_rfc3339(),
            last_seen: Utc::now().to_rfc3339(),
        };

        let json =
            serde_json::to_string(&session).map_err(|e| AppError::Internal(e.to_string()))?;
        conn.set::<_, _, ()>(&key, &json).await?;
        self.update_presence(&mut conn, surface, external_user_id)
            .await?;

        tracing::info!(
            surface = %surface,
            external_user_id = %external_user_id,
            session_id = %session.session_id,
            tenant_id = %session.tenant_id,
            "created new surface session"
        );

        Ok(session)
    }

    /// Set the active run for a session.
    pub async fn set_active_run(
        &self,
        surface: SurfaceId,
        external_user_id: &str,
        run_id: &str,
    ) -> Result<(), AppError> {
        let key = session_key(surface, external_user_id);
        let mut conn = self
            .redis
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| AppError::Internal(format!("redis connection: {e}")))?;

        let existing: Option<String> = conn.get(&key).await?;
        let Some(json) = existing else {
            return Err(AppError::NotFound(format!(
                "no session for {surface}:{external_user_id}"
            )));
        };

        let mut session: Session = serde_json::from_str(&json)
            .map_err(|e| AppError::Internal(format!("corrupt session: {e}")))?;
        session.active_run_id = Some(run_id.to_string());
        session.last_seen = Utc::now().to_rfc3339();

        let updated =
            serde_json::to_string(&session).map_err(|e| AppError::Internal(e.to_string()))?;
        conn.set::<_, _, ()>(&key, &updated).await?;
        Ok(())
    }

    /// Clear the active run for a session (run completed or failed).
    #[allow(dead_code)]
    pub async fn clear_active_run(
        &self,
        surface: SurfaceId,
        external_user_id: &str,
    ) -> Result<(), AppError> {
        let key = session_key(surface, external_user_id);
        let mut conn = self
            .redis
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| AppError::Internal(format!("redis connection: {e}")))?;

        let existing: Option<String> = conn.get(&key).await?;
        let Some(json) = existing else {
            return Ok(());
        };

        let mut session: Session = serde_json::from_str(&json)
            .map_err(|e| AppError::Internal(format!("corrupt session: {e}")))?;
        session.active_run_id = None;

        let updated =
            serde_json::to_string(&session).map_err(|e| AppError::Internal(e.to_string()))?;
        conn.set::<_, _, ()>(&key, &updated).await?;
        Ok(())
    }

    /// Retrieve a session by session_id (reverse lookup via scan -- use sparingly).
    #[allow(dead_code)]
    pub async fn get_by_session_id(&self, session_id: &str) -> Result<Option<Session>, AppError> {
        let mut conn = self
            .redis
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| AppError::Internal(format!("redis connection: {e}")))?;

        let keys: Vec<String> = redis::cmd("KEYS")
            .arg("surface:session:*")
            .query_async(&mut conn)
            .await?;

        for key in keys {
            let json: Option<String> = conn.get(&key).await?;
            if let Some(json) = json
                && let Ok(session) = serde_json::from_str::<Session>(&json)
                    && session.session_id == session_id {
                        return Ok(Some(session));
                    }
        }

        Ok(None)
    }

    async fn update_presence(
        &self,
        conn: &mut redis::aio::MultiplexedConnection,
        surface: SurfaceId,
        external_user_id: &str,
    ) -> Result<(), AppError> {
        let presence_key = presence_key(surface, external_user_id);
        let now = Utc::now().to_rfc3339();
        conn.set_ex::<_, _, ()>(&presence_key, &now, 300).await?;
        Ok(())
    }
}

fn session_key(surface: SurfaceId, external_user_id: &str) -> String {
    format!("surface:session:{surface}:{external_user_id}")
}

fn presence_key(surface: SurfaceId, external_user_id: &str) -> String {
    format!("surface:presence:{surface}:{external_user_id}")
}
