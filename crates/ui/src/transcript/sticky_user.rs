//! impl Transcript: the sticky user-prompt header.
//!
//! When a conversation is long enough that a user message has scrolled ABOVE
//! the viewport top, that previous prompt is pinned as a ~40px-tall sticky bar
//! across the top of the transcript. The text is clipped to one line, and a
//! click smooth-scrolls back to that user message's row.

use gpui::{AnyElement, Context, SharedString, div, prelude::*, px};

use crate::dev_inspector::InspectClickExt as _;
use crate::theme::Theme;

use super::rows::RowKind;
use super::{Transcript, single_line};

/// Sticky header height (px): one line of 14px text with vertical padding.
pub(super) const STICKY_USER_HEIGHT: f32 = 40.0;

impl Transcript {
    /// The user message to pin at the top: the last non-pending `User` row
    /// whose index is strictly above the viewport-top row. Returns `None`
    /// when the topmost user message is still in view (so the sticky bar only
    /// surfaces a message you can no longer see) or that message is empty.
    ///
    /// Carries `(row_index, display_text)` so the renderer can show the prompt
    /// and bind a click that scrolls back to it.
    pub(super) fn sticky_user_message(&self) -> Option<(usize, SharedString)> {
        let top = self.list.logical_scroll_top().item_ix;
        // `logical_scroll_top` can momentarily point past the last row during
        // a bottom-glue; clamp to the rows we actually have.
        let upper = top.min(self.rows.len());
        self.rows.get(..upper)?.iter().enumerate().rev().find_map(|(ix, r)| {
            let text = match &r.kind {
                RowKind::User { text, pending: false, .. } => text.clone(),
                // Pending echoes aren't worth pinning — still being sent.
                RowKind::User { .. } => return None,
                _ => return None,
            };
            let flat = single_line(text.as_ref());
            if flat.trim().is_empty() {
                return None;
            }
            Some((ix, flat.into()))
        })
    }

    /// The sticky user-prompt header overlay. Renders nothing when no previous
    /// user message has scrolled out of view.
    pub(super) fn render_sticky_user(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some((row_ix, text)) = self.sticky_user_message() else {
            return gpui::Empty.into_any_element();
        };
        let theme = Theme::of(cx).clone();
        let bg = theme.bg;
        let hover_tag = crate::dev_inspector::inspect_meta("sticky-user-prompt");
        div()
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(px(STICKY_USER_HEIGHT))
            .bg(bg)
            // Subtle bottom hairline so the bar reads as a header, not a row.
            .border_b_1()
            .border_color(theme.hairline(0.12))
            .id("sticky-user-prompt")
            .cursor_pointer()
            .inspect_click(crate::dev_inspector::inspect_meta("sticky-user-prompt"))
            .on_hover(cx.listener(move |_this, hovered: &bool, window, cx| {
                crate::dev_inspector::report_hover(&hover_tag, *hovered, window, cx);
                cx.notify();
            }))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.scroll_to_row(row_ix, cx);
            }))
            .child(
                div()
                    .h_full()
                    .w_full()
                    .flex()
                    .items_center()
                    .px(px(Theme::SPACE_LG))
                    // Clip the prompt to the bar — anything past one line is cut.
                    .overflow_hidden()
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .text_size(px(14.0))
                            .line_height(px(20.0))
                            .text_color(theme.text)
                            .text_ellipsis()
                            .child(text),
                    ),
            )
            .into_any_element()
    }
}
