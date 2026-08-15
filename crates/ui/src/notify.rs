//! OS-level desktop notifications — a thin wrapper over gpui's platform
//! notification center so a toast click can deep-link back to the chat that
//! triggered it.
//!
//! The notification `tag` is `chat:<chat_id>`. `run_app` registers an
//! `on_system_notification_response` handler (see `crate::lib.rs`) that strips
//! that prefix and selects the chat, so clicking a notification opens the
//! correct session.
//!
//! `COMET_DISABLE_NOTIFICATIONS` env kill-switch mirrors `COMET_DISABLE_SOUND`.
//! gpui swallows per-platform failures (missing notifier / denied permission /
//! no notification center) internally, so posting here is always safe.

use gpui::{App, SystemNotification};

const DISABLE_ENV: &str = "COMET_DISABLE_NOTIFICATIONS";

/// Which event triggered the notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    /// A run finished (Working → Idle).
    Done,
    /// The agent is waiting on a question (→ AwaitingInput).
    Request,
}

impl NotificationKind {
    fn title(self) -> &'static str {
        match self {
            NotificationKind::Done => "Comet — task complete",
            NotificationKind::Request => "Comet — input needed",
        }
    }

    fn body(self) -> &'static str {
        match self {
            NotificationKind::Done => "The agent finished its work.",
            NotificationKind::Request => "The agent is waiting for your response.",
        }
    }
}

/// Post a desktop notification for `chat_id`. When the user activates it, the
/// app's notification-response handler opens that chat.
pub fn show(cx: &App, kind: NotificationKind, chat_id: &str) {
    if std::env::var_os(DISABLE_ENV).is_some() {
        return;
    }
    cx.show_system_notification(SystemNotification {
        tag: format!("chat:{chat_id}").into(),
        title: kind.title().into(),
        body: kind.body().into(),
        actions: Vec::new(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_titles_and_bodies_are_nonempty() {
        for kind in [NotificationKind::Done, NotificationKind::Request] {
            assert!(!kind.title().is_empty());
            assert!(!kind.body().is_empty());
        }
    }
}
