//! Settings → Code context: controls Comet's managed vibervn context-engine.

use std::path::PathBuf;

use comet_engine::context_engine::{
    ContextEngineSettings, DASHBOARD_URL, MCP_URL, environment_override,
};
use gpui::{Context, SharedString, Window, div, prelude::*, px};

use crate::settings::widgets;
use crate::theme::Theme;

pub struct ContextEnginePage {
    data_dir: PathBuf,
    settings: ContextEngineSettings,
    environment_override: Option<bool>,
    saved_enabled: bool,
    error: Option<SharedString>,
}

impl ContextEnginePage {
    pub fn new(data_dir: PathBuf) -> Self {
        let settings = ContextEngineSettings::load(&data_dir);
        let saved_enabled = settings.enabled;
        Self {
            data_dir,
            settings,
            environment_override: environment_override(),
            saved_enabled,
            error: None,
        }
    }

    fn effective_enabled(&self) -> bool {
        self.environment_override.unwrap_or(self.settings.enabled)
    }

    fn toggle(&mut self, cx: &mut Context<Self>) {
        if self.environment_override.is_some() {
            return;
        }
        self.settings.enabled = !self.settings.enabled;
        match self.settings.save(&self.data_dir) {
            Ok(()) => self.error = None,
            Err(error) => {
                self.settings.enabled = !self.settings.enabled;
                self.error = Some(format!("Could not save setting: {error}").into());
            }
        }
        cx.notify();
    }
}

fn toggle_switch(theme: &Theme, on: bool) -> gpui::Div {
    div()
        .flex_none()
        .w(px(32.0))
        .h(px(18.0))
        .rounded_full()
        .bg(if on { theme.text } else { theme.ink(0.15) })
        .relative()
        .child(
            div()
                .absolute()
                .top(px(2.0))
                .left(px(if on { 16.0 } else { 2.0 }))
                .size(px(14.0))
                .rounded_full()
                .bg(if on { theme.on_solid } else { theme.ink(0.7) }),
        )
}

impl gpui::Render for ContextEnginePage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let enabled = self.effective_enabled();
        let locked = self.environment_override.is_some();
        let changed = self.saved_enabled != self.settings.enabled;

        let toggle_row = widgets::card_row(&theme, true)
            .id("context-engine-toggle")
            .when(!locked, |row| {
                row.cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| this.toggle(cx)))
            })
            .child(widgets::row_tile(&theme, crate::icons::MAGNIFER))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(&theme, "Semantic code retrieval"))
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_size(px(11.5))
                            .text_color(theme.text_muted.opacity(0.65))
                            .child(SharedString::from(
                                "Automatically run vibervn-context-engine and register its MCP tools with Claude Code and Codex.",
                            )),
                    ),
            )
            .when(locked, |row| {
                row.child(widgets::badge(&theme, "Environment override"))
            })
            .child(toggle_switch(&theme, enabled));

        let dashboard_row = widgets::card_row(&theme, false)
            .child(widgets::row_tile(&theme, crate::icons::GLOBAL))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(&theme, "Context engine dashboard"))
                    .child(widgets::meta_line(
                        &theme,
                        vec![
                            div().child(SharedString::from(MCP_URL)).into_any_element(),
                            div()
                                .child(SharedString::from("Configure embeddings and repositories"))
                                .into_any_element(),
                        ],
                    )),
            )
            .child(
                widgets::ghost_action(&theme)
                    .id("context-engine-open-dashboard")
                    .hover(|s| widgets::ghost_hover(&theme, s))
                    .on_click(cx.listener(|_, _, _, cx| cx.open_url(DASHBOARD_URL)))
                    .child(crate::icons::icon(crate::icons::GLOBAL).size(px(14.0)))
                    .child("Open dashboard"),
            );

        div()
            .id("context-engine-page")
            .size_full()
            .overflow_y_scroll()
            .child(
                widgets::page_column()
                    .child(widgets::page_header(&theme, "Code context", None))
                    .child(widgets::page_subtitle(
                        &theme,
                        "Local semantic indexing for coding-agent sessions.",
                    ))
                    .when_some(self.error.clone(), |page, error| {
                        page.child(widgets::error_strip(&theme, error))
                    })
                    .when(changed && !locked, |page| {
                        page.child(widgets::warning_strip(
                            &theme,
                            "Restart the Comet engine to apply this change.",
                        ))
                    })
                    .child(
                        widgets::section_card(&theme)
                            .child(toggle_row)
                            .child(dashboard_row),
                    ),
            )
    }
}
