//! Settings → Notifications: toggles for OS desktop notifications and the
//! session chime. Both flags live in [`UiSettings`] (`notificationsEnabled`,
//! `soundEnabled`); this page edits that file directly and emits
//! [`NotificationsEvent::Changed`] so the shell's in-memory copy stays in sync.

use std::path::PathBuf;

use gpui::{AnyElement, Context, EventEmitter, SharedString, Window, div, prelude::*, px};

use crate::settings::UiSettings;
use crate::settings::widgets;
use crate::theme::{Theme, white_alpha};

#[derive(Debug, Clone)]
pub enum NotificationsEvent {
    /// One of the toggles flipped — the shell updates its working copy.
    Changed {
        notifications_enabled: bool,
        sound_enabled: bool,
    },
}

pub struct NotificationsPage {
    data_dir: PathBuf,
    settings: UiSettings,
    error: Option<SharedString>,
}

impl NotificationsPage {
    pub fn new(data_dir: PathBuf, settings: UiSettings) -> Self {
        Self {
            data_dir,
            settings,
            error: None,
        }
    }

    fn toggle_notifications(&mut self, cx: &mut Context<Self>) {
        self.settings.notifications_enabled = !self.settings.notifications_enabled;
        self.persist_and_emit(cx);
    }

    fn toggle_sound(&mut self, cx: &mut Context<Self>) {
        self.settings.sound_enabled = !self.settings.sound_enabled;
        self.persist_and_emit(cx);
    }

    fn persist_and_emit(&mut self, cx: &mut Context<Self>) {
        match self.settings.save(&self.data_dir) {
            Ok(()) => {
                self.error = None;
                cx.emit(NotificationsEvent::Changed {
                    notifications_enabled: self.settings.notifications_enabled,
                    sound_enabled: self.settings.sound_enabled,
                });
            }
            Err(error) => {
                // Revert both flags to the last-saved state on failure so the
                // UI never shows a value that didn't persist.
                let reloaded = UiSettings::load(&self.data_dir);
                self.settings.notifications_enabled = reloaded.notifications_enabled;
                self.settings.sound_enabled = reloaded.sound_enabled;
                self.error = Some(format!("Could not save setting: {error}").into());
            }
        }
        cx.notify();
    }
}

impl EventEmitter<NotificationsEvent> for NotificationsPage {}

fn toggle_switch(theme: &Theme, on: bool) -> gpui::Div {
    div()
        .flex_none()
        .w(px(32.0))
        .h(px(18.0))
        .rounded_full()
        .bg(if on { theme.text } else { white_alpha(0.15) })
        .relative()
        .child(
            div()
                .absolute()
                .top(px(2.0))
                .left(px(if on { 16.0 } else { 2.0 }))
                .size(px(14.0))
                .rounded_full()
                .bg(if on {
                    crate::theme::grey(0x0e)
                } else {
                    white_alpha(0.7)
                }),
        )
}

impl gpui::Render for NotificationsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let notifications_on = self.settings.notifications_enabled;
        let sound_on = self.settings.sound_enabled;

        let notifications_row = toggle_row(
            &theme,
            "notifications-toggle",
            crate::icons::BELL_MINIMALISTIC,
            "Notifications",
            "Show an OS desktop notification when the agent finishes a task or asks a question.",
            notifications_on,
            cx.listener(|this, _, _, cx| this.toggle_notifications(cx)),
        );

        let sound_row = toggle_row(
            &theme,
            "sound-toggle",
            crate::icons::BELL_MINIMALISTIC,
            "Notification sound",
            "Play a chime when the agent finishes a task or needs your attention.",
            sound_on,
            cx.listener(|this, _, _, cx| this.toggle_sound(cx)),
        );

        div()
            .id("notifications-page")
            .size_full()
            .overflow_y_scroll()
            .child(
                widgets::page_column()
                    .child(widgets::page_header(&theme, "Notifications", None))
                    .child(widgets::page_subtitle(
                        &theme,
                        "Choose how Comet alerts you when an agent completes work or waits for input.",
                    ))
                    .when_some(self.error.clone(), |page, error| {
                        page.child(widgets::error_strip(&theme, error))
                    })
                    .child(
                        widgets::section_card(&theme)
                            .child(notifications_row)
                            .child(sound_row),
                    ),
            )
    }
}

fn toggle_row(
    theme: &Theme,
    id: &'static str,
    icon: &'static str,
    title: &str,
    description: &str,
    on: bool,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    widgets::card_row(theme, true)
        .id(id)
        .cursor_pointer()
        .on_click(listener)
        .child(widgets::row_tile(theme, icon))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .child(widgets::row_title(
                    theme,
                    SharedString::from(title.to_string()),
                ))
                .child(
                    div()
                        .mt(px(4.0))
                        .text_size(px(11.5))
                        .text_color(theme.text_muted.opacity(0.65))
                        .child(SharedString::from(description.to_string())),
                ),
        )
        .child(toggle_switch(theme, on))
        .into_any_element()
}
