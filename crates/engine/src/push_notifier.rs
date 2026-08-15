//! Edge push notifier — calls the edge `/push/send` endpoint when sessions
//! transition, so mobile devices receive real push notifications even when
//! their WebSocket is suspended.
//!
//! Fires on a background tokio task; failures are logged and swallowed (push
//! is best-effort — the workspace doc still syncs on the next reconnect).

use std::sync::Arc;

use comet_proto::SessionStatus;
use reqwest::Client;

use crate::sessions::{PushNotifier, StatusTransition};

/// Configuration for the edge push relay.
#[derive(Debug, Clone)]
pub struct PushConfig {
    /// Edge base URL (`https://…`).
    pub edge_url: String,
    /// Shared secret matching the edge's `PUSH_INTERNAL_SECRET`.
    pub secret: String,
    /// The user id whose push token to look up. On a multi-device workspace,
    /// the engine sends to its own user (the one who owns the workspace room).
    pub user_id: String,
}

pub struct EdgePushNotifier {
    config: PushConfig,
    client: Client,
    runtime: tokio::runtime::Handle,
}

impl EdgePushNotifier {
    pub fn new(config: PushConfig, runtime: tokio::runtime::Handle) -> Self {
        Self {
            config,
            client: Client::new(),
            runtime,
        }
    }
}

impl PushNotifier for EdgePushNotifier {
    fn notify(&self, transition: StatusTransition) {
        let (title, body, kind) = match (transition.from, transition.to) {
            (SessionStatus::Working, SessionStatus::Idle) => (
                "Task complete".to_string(),
                transition
                    .chat_title
                    .clone()
                    .map(|t| format!("{t} finished its work."))
                    .unwrap_or_else(|| "The agent finished its work.".to_string()),
                "done",
            ),
            (SessionStatus::Working, SessionStatus::Errored) => (
                "Task failed".to_string(),
                transition
                    .chat_title
                    .clone()
                    .map(|t| format!("{t} ran into an error."))
                    .unwrap_or_else(|| "The agent encountered an error.".to_string()),
                "error",
            ),
            (_, SessionStatus::AwaitingInput) => (
                "Input needed".to_string(),
                transition
                    .chat_title
                    .clone()
                    .map(|t| format!("{t} is waiting for your response."))
                    .unwrap_or_else(|| "The agent is waiting for your response.".to_string()),
                "input",
            ),
            _ => return,
        };

        let config = self.config.clone();
        let client = self.client.clone();
        let chat_id = transition.chat_id.clone();
        let deep_link = format!("agentdeski://chat/{chat_id}");

        self.runtime.spawn(async move {
            let url = format!("{}/push/send", config.edge_url.trim_end_matches('/'));
            let payload = serde_json::json!({
                "userId": config.user_id,
                "title": title,
                "body": body,
                "chatId": chat_id,
                "deepLink": deep_link,
                "kind": kind,
            });
            match client
                .post(&url)
                .header("x-internal-secret", &config.secret)
                .json(&payload)
                .send()
                .await
            {
                Ok(res) => {
                    if !res.status().is_success() {
                        tracing::debug!(status = %res.status(), "push send non-2xx");
                    }
                }
                Err(err) => {
                    tracing::debug!(error = %err, "push send failed");
                }
            }
        });
    }
}

/// No-op notifier for when push is not configured.
pub struct NoopPushNotifier;

impl PushNotifier for NoopPushNotifier {
    fn notify(&self, _transition: StatusTransition) {}
}

/// Convenience: create an Arc<dyn PushNotifier> from an optional config.
pub fn make_notifier(config: Option<PushConfig>) -> Arc<dyn PushNotifier> {
    match config {
        Some(cfg) => {
            let runtime = tokio::runtime::Handle::current();
            Arc::new(EdgePushNotifier::new(cfg, runtime))
        }
        None => Arc::new(NoopPushNotifier),
    }
}
