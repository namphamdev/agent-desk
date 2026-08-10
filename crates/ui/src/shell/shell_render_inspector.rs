//! Shell render: the agent debug inspector overlay.
//!
//! A fixed bottom-right icon (the magnifier) that toggles "pick mode". In
//! pick mode, hovering any [`crate::dev_inspector::inspected`] element
//! shows its source location; clicking immediately copies the element's
//! agent-ready summary to the clipboard and freezes the selection in a
//! panel (which includes a "Copy for Agent" button to re-copy).
//!
//! Renders only when [`InspectorState::feature_enabled`] is true (debug builds
//! or `COMET_INSPECTOR=1`).
//!
//! Important: the overlay must NOT cover the full window — a full-screen
//! intercepting div would block `on_hover` events from reaching the tagged
//! elements below. Only the trigger icon and info panel are rendered, pinned
//! bottom-right with `occlude()` so they don't pass clicks through.

use gpui::{
    AnyElement, App, ClipboardItem, Context, IntoElement, SharedString,
    Window, div, prelude::*, px,
};

use crate::dev_inspector::{self, InspectorState};
use crate::icons::{self, icon};
use crate::theme::Theme;

use super::Shell;

/// Icon size for the inspector trigger button.
const ICON_SIZE: f32 = 18.0;
/// Button size for the inspector trigger.
const BUTTON_SIZE: f32 = 36.0;

impl Shell {
    /// Render the inspector overlay: just the trigger icon and optional info
    /// panel, pinned bottom-right. No full-screen veil — it would block hover
    /// events from reaching tagged elements.
    pub(crate) fn render_inspector_overlay(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Feature gate: in release without COMET_INSPECTOR, render nothing.
        if !InspectorState::feature_enabled() {
            return div().into_any_element();
        }

        let state = dev_inspector::global_state(cx);
        let picking = state.is_picking();
        let snapshot = state.snapshot();
        let theme = Theme::of(cx).clone();

        let mut overlay = div()
            .absolute()
            .bottom(px(8.0))
            .right(px(8.0))
            .flex()
            .flex_col()
            .items_end()
            .gap(px(8.0))
            .child(Self::render_inspector_trigger(&theme, picking, cx));

        // Info panel: show when hovering (pick mode) or when a selection is frozen.
        let show_panel = picking
            && (snapshot.selected.is_some() || snapshot.hovered.is_some());
        if show_panel {
            let meta = snapshot
                .selected
                .clone()
                .or_else(|| snapshot.hovered.clone());
            if let Some(meta) = meta {
                let is_frozen = snapshot.selected.is_some();
                overlay = overlay.child(Self::render_inspector_panel(
                    &theme,
                    &meta,
                    is_frozen,
                ));
            }
        }

        overlay.into_any_element()
    }

    /// The fixed bottom-right trigger button (the magnifier icon).
    fn render_inspector_trigger(
        theme: &Theme,
        picking: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let accent = if picking {
            theme.accent
        } else {
            theme.text_muted
        };
        let bg = if picking {
            theme.accent.opacity(0.15)
        } else {
            theme.surface.opacity(0.8)
        };
        let border = if picking {
            theme.accent
        } else {
            theme.border
        };

        div()
            .id("inspector-trigger")
            .size(px(BUTTON_SIZE))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.0))
            .bg(bg)
            .border_1()
            .border_color(border)
            .cursor_pointer()
            .occlude()
            .on_click(cx.listener(|_this, _event, _window, cx| {
                let state = dev_inspector::global_state(cx);
                state.toggle_picking();
                state.clear_selection();
                cx.notify();
            }))
            .child(
                icon(icons::MAGNIFER)
                    .size(px(ICON_SIZE))
                    .text_color(accent),
            )
            .when(picking, |el| {
                el.child(
                    // Small dot indicator that pick mode is active.
                    div()
                        .absolute()
                        .top(px(4.0))
                        .right(px(4.0))
                        .size(px(6.0))
                        .rounded_full()
                        .bg(theme.accent),
                )
            })
            .into_any_element()
    }

    /// The info panel showing the inspected element's metadata.
    fn render_inspector_panel(
        theme: &Theme,
        meta: &dev_inspector::ElementMeta,
        is_frozen: bool,
    ) -> AnyElement {
        let file_line = SharedString::from(meta.file_line());
        let label = SharedString::from(meta.label.to_string());
        let module = SharedString::from(meta.module.to_string());
        let copy_text = meta.agent_summary();

        let header_text = if is_frozen {
            "Selected element"
        } else {
            "Hovering element"
        };

        let mut panel = div()
            .id("inspector-panel")
            .w(px(360.0))
            .bg(theme.surface_dialog)
            .border_1()
            .border_color(theme.border)
            .rounded(px(10.0))
            .shadow_md()
            .p(px(12.0))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .occlude()
            // Label
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(theme.text_muted)
                            .child(SharedString::from(header_text.to_string())),
                    )
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(theme.accent)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(label),
                    ),
            )
            // File:line
            .child(inspector_row("File", file_line, theme))
            // Module
            .child(inspector_row("Module", module, theme));

        // Copy button — the info was already copied on click-to-select; this
        // button lets the developer re-copy without re-picking.
        if is_frozen {
            let copy_text = copy_text.clone();
            panel = panel.child(
                div()
                    .id("inspector-copy")
                    .mt(px(4.0))
                    .h(px(30.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(6.0))
                    .rounded(px(6.0))
                    .bg(theme.accent)
                    .cursor_pointer()
                    .on_click(move |_event, _window, cx: &mut App| {
                        cx.write_to_clipboard(ClipboardItem::new_string(copy_text.clone()));
                    })
                    .child(
                        icon(icons::COPY)
                            .size(px(14.0))
                            .text_color(theme.bg),
                    )
                    .child(
                        div()
                            .text_size(px(12.0))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.bg)
                            .child(SharedString::from("Copy for Agent")),
                    ),
            );

            // Hint.
            panel = panel.child(
                div()
                    .text_size(px(10.0))
                    .text_color(theme.text_muted)
                    .child(SharedString::from(
                        "Copied to clipboard — click trigger to exit pick mode",
                    )),
            );
        }

        panel.into_any_element()
    }
}

/// A label + value row in the inspector panel.
fn inspector_row(label: &str, value: SharedString, theme: &Theme) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .gap(px(8.0))
        .child(
            div()
                .w(px(52.0))
                .flex_none()
                .text_size(px(11.0))
                .text_color(theme.text_muted)
                .child(SharedString::from(label.to_string())),
        )
        .child(
            // Monospace for file paths so they align readably.
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(12.0))
                .text_color(theme.text)
                .font_family(theme.font_mono.clone())
                .child(value),
        )
        .into_any_element()
}
