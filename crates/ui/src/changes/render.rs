//! Free-function render helpers for the diff pane: color palette + the
//! expanded body of one file section (notices, hunk headers, +/-/context
//! lines, dual gutters, marker column, paint-only syntax runs).

use std::sync::Arc;

use gpui::{AnyElement, SharedString, div, font, prelude::*, px};

use crate::markdown::highlight::{Token, TokenClass};
use crate::markdown::render;
use crate::theme::Theme;

use super::patch::{FileDiff, LineKind, file_notices};
use super::{
    ACCENT_BAR_WIDTH, BODY_BOTTOM_PAD, DIFF_LINE_HEIGHT, DIFF_TEXT_SIZE, GUTTER_WIDTH,
    HUNK_HEADER_HEIGHT, MARKER_WIDTH, NOTICE_HEIGHT,
};

/// Green for additions — sampled from the reference diff (soft emerald).
pub(super) fn add_color(theme: &Theme) -> gpui::Hsla {
    theme.diff_add // emerald-400
}

/// Red for deletions — softer than the theme danger, per the reference diff.
pub(super) fn del_color(theme: &Theme) -> gpui::Hsla {
    theme.diff_del // red-400
}

/// Diff syntax palette — since round 9 the transcript's code blocks share the
/// same soft hues, so this simply delegates to [`render::token_color`].
pub(super) fn diff_token_color(class: TokenClass, theme: &Theme) -> gpui::Hsla {
    render::token_color(class, theme)
}

/// The expanded body of one file section: notices, hunk headers, +/-/context
/// lines with a coloured accent bar, dual line-number gutters, a marker
/// column, and paint-only syntax runs (comet checkout-diff-sidebar).
pub(super) fn render_file_body(
    file: &FileDiff,
    highlight: Option<Arc<Vec<Vec<Token>>>>,
    theme: &Theme,
) -> AnyElement {
    let mono = font(theme.font_mono.clone());
    let mut line_ix = 0usize;
    let mut children: Vec<AnyElement> = Vec::new();

    for notice in file_notices(file) {
        children.push(
            div()
                .h(px(NOTICE_HEIGHT))
                .flex_none()
                .flex()
                .items_center()
                .px(px(Theme::SPACE_LG))
                .text_size(px(11.0))
                .text_color(theme.text_faint)
                .child(SharedString::from(notice))
                .into_any_element(),
        );
    }

    // Row tints sampled from the reference: ~5–6% washes over the pane tone.
    let mut add_bg = add_color(theme);
    add_bg.a = 0.055;
    let mut del_bg = del_color(theme);
    del_bg.a = 0.055;
    // Bluish-grey hunk-header wash.
    let hunk_bg = theme.diff_hunk_bg;

    for hunk in &file.hunks {
        children.push(
            div()
                .h(px(HUNK_HEADER_HEIGHT))
                .flex_none()
                .flex()
                .items_center()
                .px(px(Theme::SPACE_LG))
                .bg(hunk_bg)
                .font_family(theme.font_mono.clone())
                .text_size(px(11.0))
                .text_color(theme.text_faint)
                .child(SharedString::from(hunk.header.clone()))
                .into_any_element(),
        );
        for line in &hunk.lines {
            let tokens = highlight
                .as_ref()
                .and_then(|lines| lines.get(line_ix))
                .map(|t| t.as_slice())
                .unwrap_or(&[]);
            line_ix += 1;

            if line.kind == LineKind::Meta {
                children.push(
                    div()
                        .h(px(DIFF_LINE_HEIGHT))
                        .flex_none()
                        .flex()
                        .items_center()
                        .pl(px(ACCENT_BAR_WIDTH
                            + 2.0 * GUTTER_WIDTH
                            + MARKER_WIDTH
                            + 12.0))
                        .text_size(px(10.5))
                        .text_color(theme.text_faint)
                        .italic()
                        .child(SharedString::from(line.text.clone()))
                        .into_any_element(),
                );
                continue;
            }

            let (marker, marker_color, row_bg, accent, number_color) = match line.kind {
                LineKind::Add => (
                    "+",
                    add_color(theme),
                    Some(add_bg),
                    Some(add_color(theme).opacity(0.55)),
                    add_color(theme).opacity(0.9),
                ),
                LineKind::Del => (
                    "−",
                    del_color(theme),
                    Some(del_bg),
                    Some(del_color(theme).opacity(0.55)),
                    del_color(theme).opacity(0.9),
                ),
                _ => (
                    "·",
                    theme.text_faint.opacity(0.5),
                    None,
                    None,
                    theme.text_faint.opacity(0.8),
                ),
            };
            let gutter = |no: Option<u32>, color: gpui::Hsla| {
                div()
                    .w(px(GUTTER_WIDTH))
                    .flex_none()
                    .font_family(theme.font_mono.clone())
                    .text_size(px(11.0))
                    .text_color(color)
                    .flex()
                    .justify_end()
                    .pr(px(8.0))
                    .child(SharedString::from(
                        no.map(|n| n.to_string()).unwrap_or_default(),
                    ))
            };
            let runs = render::runs_with_palette(
                &line.text,
                tokens,
                &mono,
                theme.text.opacity(0.92),
                |class| diff_token_color(class, theme),
            );
            children.push(
                div()
                    .h(px(DIFF_LINE_HEIGHT))
                    .flex_none()
                    .flex()
                    .flex_row()
                    .items_center()
                    .when_some(row_bg, |el, bg| el.bg(bg))
                    // Accent bar: solid colour on +/− rows, invisible spacer on
                    // context rows so columns always align.
                    .child(
                        div()
                            .w(px(ACCENT_BAR_WIDTH))
                            .h_full()
                            .flex_none()
                            .when_some(accent, |el, color| el.bg(color)),
                    )
                    .child(gutter(
                        line.old_no,
                        if line.kind == LineKind::Del {
                            number_color
                        } else {
                            theme.text_faint.opacity(0.8)
                        },
                    ))
                    .child(gutter(
                        line.new_no,
                        if line.kind == LineKind::Add {
                            number_color
                        } else {
                            theme.text_faint.opacity(0.8)
                        },
                    ))
                    .child(
                        div()
                            .w(px(MARKER_WIDTH))
                            .flex_none()
                            .flex()
                            .justify_center()
                            .text_size(px(DIFF_TEXT_SIZE))
                            .text_color(marker_color)
                            .font_family(theme.font_mono.clone())
                            .child(SharedString::from(marker)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .pl(px(12.0))
                            .font_family(theme.font_mono.clone())
                            .text_size(px(DIFF_TEXT_SIZE))
                            .whitespace_nowrap()
                            .child(gpui::StyledText::new(line.text.clone()).with_runs(runs)),
                    )
                    .into_any_element(),
            );
        }
    }

    div()
        .flex()
        .flex_col()
        .pb(px(BODY_BOTTOM_PAD))
        .children(children)
        .into_any_element()
}
