//! `impl Changes` block #6: the conflict-resolution modal opened after a
//! conflicting `git pull`. Lists the unmerged paths and offers per-file
//! AI-assisted resolution through the selected harness/model agent.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};

use crate::popover;
use crate::theme::Theme;

use super::Changes;

impl Changes {
    pub(super) fn render_conflict_modal(
        &mut self,
        theme: &Theme,
        viewport: gpui::Size<gpui::Pixels>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let modal = self.conflict_modal.clone()?;
        let busy = self.git_generating;
        let any_resolving = modal.states.values().any(|s| s.resolving);

        let mut rows = div().flex().flex_col().gap(px(4.0));
        for path in &modal.files {
            let state = modal.states.get(path).cloned().unwrap_or_default();
            let resolving = state.resolving;
            let path_for_resolve = path.clone();
            let summary = state.summary.clone();
            let row = div()
                .px(px(10.0))
                .py(px(8.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(theme.border)
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .w(px(14.0))
                                .text_size(px(11.0))
                                .font_family(theme.font_mono.clone())
                                .text_color(theme.warning)
                                .child(SharedString::from("!")),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .font_family(theme.font_mono.clone())
                                .text_size(px(12.0))
                                .text_color(theme.text)
                                .child(SharedString::from(path.clone())),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!(
                                    "git-conflict-resolve-{path}"
                                )))
                                .px(px(10.0))
                                .py(px(4.0))
                                .rounded(px(6.0))
                                .border_1()
                                .border_color(theme.border)
                                .text_size(px(11.0))
                                .text_color(if busy || resolving {
                                    theme.text_faint
                                } else {
                                    theme.text_muted
                                })
                                .when(!busy && !resolving, |el| {
                                    el.cursor_pointer().hover(|s| {
                                        s.bg(crate::theme::white_alpha(0.06))
                                    })
                                })
                                .when(!busy && !resolving, |el| {
                                    el.on_click(cx.listener(move |this, _, _, cx| {
                                        this.resolve_conflict_file(
                                            path_for_resolve.clone(),
                                            cx,
                                        );
                                    }))
                                })
                                .child(SharedString::from(if resolving {
                                    "Resolving…"
                                } else {
                                    "Resolve with AI"
                                })),
                        ),
                )
                .when_some(summary, |el, note| {
                    el.child(
                        div()
                            .pl(px(22.0))
                            .text_size(px(11.0))
                            .text_color(theme.text_muted)
                            .child(note),
                    )
                });
            rows = rows.child(row);
        }

        let card = popover::dialog_card(theme)
            // Widen for long paths; the file list scrolls if it grows tall.
            .w(px(420.0))
            .on_key_down(cx.listener(|this, ev: &gpui::KeyDownEvent, _, cx| {
                if ev.keystroke.key == "escape" && !this.git_generating {
                    this.close_conflict_modal(cx);
                }
            }))
            .child(popover::dialog_title(theme, "Resolve merge conflicts"))
            .child(
                div().mt(px(6.0)).child(popover::dialog_body(
                    theme,
                    "The pull stopped on the conflicts below. Resolve each with AI, \
                     or close to handle them yourself.",
                )),
            )
            .when_some(modal.info.clone(), |el, info| {
                el.child(
                    div()
                        .mt(px(8.0))
                        .text_size(px(11.0))
                        .text_color(theme.text_muted)
                        .child(info),
                )
            })
            .child(
                div()
                    .id("git-conflict-rows")
                    .mt(px(12.0))
                    .max_h(px(320.0))
                    .overflow_y_scroll()
                    .child(rows),
            )
            .child(
                div()
                    .mt(px(16.0))
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap(px(8.0))
                    .child(
                        popover::btn_ghost(theme, "Close", "git-conflict-close")
                            .id("git-conflict-close")
                            .text_color(if any_resolving {
                                theme.text_faint
                            } else {
                                theme.text_muted
                            })
                            .when(!any_resolving, |el| el.cursor_pointer())
                            .when(!any_resolving, |el| {
                                el.on_click(cx.listener(|this, _, _, cx| {
                                    this.close_conflict_modal(cx);
                                }))
                            }),
                    ),
            )
            .into_any_element();

        Some(popover::modal("git-conflict-modal", viewport, card))
    }
}
