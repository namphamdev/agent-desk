//! `impl Changes` block #3: virtualized row rendering — file header (chevron,
//! path, +/− counts) + the body wrapper with the 180ms collapse tween.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};

use crate::motion::{self, AnimationExt as _, CHEVRON, COLLAPSE};
use crate::theme::Theme;

use super::entity::FileFold;
use super::patch::{FileDiff, body_height};
use super::render::{add_color, del_color, render_file_body};
use super::FILE_HEADER_HEIGHT;
use super::Changes;

impl Changes {
    pub(super) fn render_row(
        &mut self,
        ix: usize,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(parsed) = &self.parsed else {
            return gpui::Empty.into_any_element();
        };
        let files = parsed.files.clone();
        let parsed_key = parsed.key.clone();
        let Some(file) = files.get(ix) else {
            return gpui::Empty.into_any_element();
        };
        let theme = Theme::of(cx).clone();
        let expanded_height = body_height(file);
        let fold = self.folds.get(&file.path).copied().unwrap_or_default();
        let highlight = self.request_highlight(file, &parsed_key, cx);
        let path = file.path.clone();

        let header = self.render_file_header(ix, file, &fold, expanded_height, &theme, cx);
        let body = render_file_body(file, highlight, &theme);

        // Collapse: 180 ms committed-height tween on toggle (windowed — see
        // FileFold::animating); steady states paint at the target height
        // directly.
        let body: AnyElement = if fold.animating() {
            let (from, to) = (fold.from, fold.to);
            div()
                .overflow_hidden()
                .child(body)
                .with_animation(
                    SharedString::from(format!("fold-{path}-{}", fold.epoch)),
                    COLLAPSE.animation(),
                    move |el, t| el.h(px(motion::lerp(from, to, t))),
                )
                .into_any_element()
        } else {
            let target = if fold.collapsed { 0.0 } else { expanded_height };
            div()
                .overflow_hidden()
                .h(px(target))
                .child(body)
                .into_any_element()
        };

        div()
            .w_full()
            .flex()
            .flex_col()
            .border_b_1()
            .border_color(crate::theme::hairline(0.04))
            .child(header)
            .child(body)
            .into_any_element()
    }

    pub(super) fn render_file_header(
        &mut self,
        ix: usize,
        file: &FileDiff,
        fold: &FileFold,
        expanded_height: f32,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let collapsed = fold.collapsed;
        let path = file.path.clone();
        let adds = file.additions;
        let dels = file.deletions;

        // Chevron (comet checkout-diff-sidebar): chevron-right closed,
        // chevron-down open; gpui divs have no rotation transform at the
        // pinned rev, so the glyph swap crossfades over the same 200 ms.
        let chevron_icon = if collapsed {
            crate::icons::ALT_ARROW_RIGHT
        } else {
            crate::icons::ALT_ARROW_DOWN
        };
        let chevron = div().flex_none().size(px(14.0)).child(
            crate::icons::icon(chevron_icon)
                .size(px(13.0))
                .text_color(theme.text_muted.opacity(0.7)),
        );
        let chevron: AnyElement = if fold.animating() {
            chevron
                .with_animation(
                    SharedString::from(format!("chev-{path}-{}", fold.epoch)),
                    CHEVRON.animation(),
                    |el, t| el.opacity(0.25 + 0.75 * t),
                )
                .into_any_element()
        } else {
            chevron.into_any_element()
        };

        // Header row: chevron + mono path (one quiet tone) + right-aligned
        // +N / −N counts on a slightly raised wash.
        div()
            .id(SharedString::from(format!("file-hdr-{ix}")))
            .h(px(FILE_HEADER_HEIGHT))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .px(px(Theme::SPACE_MD))
            .bg(crate::theme::ink(0.025))
            .cursor_pointer()
            .hover(|s| s.bg(crate::theme::ink(0.05)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.toggle_fold(&path, expanded_height);
                cx.notify();
            }))
            .child(chevron)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .font_family(theme.font_mono.clone())
                    .text_size(px(12.0))
                    .text_color(theme.text_dim)
                    .child(SharedString::from(file.path.clone())),
            )
            .when(file.binary, |el| {
                el.child(
                    div()
                        .flex_none()
                        .text_size(px(10.0))
                        .text_color(theme.text_faint)
                        .child(SharedString::from("BIN")),
                )
            })
            .when(adds > 0 || !file.binary, |el| {
                el.child(
                    div()
                        .flex_none()
                        .font_family(theme.font_mono.clone())
                        .text_size(px(11.0))
                        .text_color(add_color(theme))
                        .child(SharedString::from(format!("+{adds}"))),
                )
            })
            .when(dels > 0 || !file.binary, |el| {
                el.child(
                    div()
                        .flex_none()
                        .font_family(theme.font_mono.clone())
                        .text_size(px(11.0))
                        .text_color(del_color(theme))
                        .child(SharedString::from(format!("−{dels}"))),
                )
            })
            .into_any_element()
    }
}


