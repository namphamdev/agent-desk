//! Free fn render helpers: user_mention_text, input_chip, tool_chip,
//! tool_icon_path, todo_items_list, entry_fingerprint.

use std::sync::Arc;

use gpui::{AnyElement, BorderStyle, SharedString, StyledText, TextRun, canvas, div, prelude::*, px, quad};

use comet_doc::{MessagePart, MessageStatus, SessionMessageEntry};
use comet_proto::ToolCall;

use crate::markdown::render;
use crate::theme::Theme;

use super::parse::tool_chip_height;
use super::rows::{ToolItem, fnv1a};
use super::{CHIP_CARD_HEIGHT, TODO_ITEM_HEIGHT, TODO_ITEMS_PAD, single_line, tool_chip_content};
/// the mono font at `code_text` violet, [`StyledText`] supplies wrapped glyph
/// geometry through its layout handle, and a canvas paints the rounded
/// `code_wash` *beneath* the glyphs — so chips wrap, clip, and scroll exactly
/// like the text they decorate.
///
/// Per-frame cost while an assistant message streams below: shaping hits
/// gpui's line-layout cache (identical text + runs ⇒ reuse) and the underlay
/// repaints O(chips) quads — no layout work, no re-projection (spans were
/// computed once in [`rows_for_entry`]).
pub(crate) fn user_mention_text(
    text: SharedString,
    mentions: Arc<Vec<crate::composer::SentMentionSpan>>,
    theme: &Theme,
) -> AnyElement {
    // Split runs at chip boundaries (spans are in order): body text keeps the
    // sans font, chips read as inline code. Size/line-height flow from the
    // bubble's div like every text child.
    let body_run = |len: usize| TextRun {
        len,
        font: gpui::font(theme.font_sans.clone()),
        color: theme.text,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let chip_run = |len: usize| TextRun {
        len,
        font: gpui::font(theme.font_mono.clone()),
        color: theme.code_text,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let mut runs = Vec::with_capacity(mentions.len() * 2 + 1);
    let mut at = 0;
    for span in mentions.iter() {
        if at < span.range.start {
            runs.push(body_run(span.range.start - at));
        }
        runs.push(chip_run(span.range.len()));
        at = span.range.end;
    }
    if at < text.len() {
        runs.push(body_run(text.len() - at));
    }
    let styled = StyledText::new(text.clone()).with_runs(runs);
    let layout = styled.layout().clone();
    let wash = theme.code_wash;
    let underlay = canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            for span in mentions.iter() {
                for rect in render::range_rects(&layout, &span.range, 0.0, 2.0) {
                    window.paint_quad(quad(
                        rect,
                        px(5.0),
                        wash,
                        px(0.0),
                        gpui::transparent_black(),
                        BorderStyle::default(),
                    ));
                }
            }
        },
    )
    .absolute()
    .size_full();
    div()
        .relative()
        .child(underlay)
        .child(styled)
        .into_any_element()
}

/// A passive one-line chip marking a question the agent asked — the
/// interactive controls live in the composer (chat-view.tsx `InputChip`):
/// 34px row, `rounded-[10px] border-white/[0.08] bg-white/[0.045] px-2
/// text-[12px]`, a 20px `bg-white/[0.09]` icon tile with a 12px
/// ChatRoundLine, the medium "Question" label, then the truncating value —
/// the first question's header once resolved, "Awaiting your answer…" while
/// pending. Neutral tones throughout; resolution never recolors the chip.
pub(crate) fn input_chip(header: SharedString, resolved: bool, theme: &Theme) -> AnyElement {
    let value: SharedString = if resolved {
        header
    } else {
        "Awaiting your answer…".into()
    };
    div()
        .py(px(4.0))
        .w_full()
        .child(
            div()
                .h(px(34.0))
                .w_full()
                .flex()
                .items_center()
                .gap(px(8.0))
                .overflow_hidden()
                .rounded(px(10.0))
                .border_1()
                .border_color(crate::theme::hairline(0.08))
                .bg(crate::theme::ink(0.045))
                .px(px(8.0))
                .text_size(px(12.0))
                .child(
                    div()
                        .flex_none()
                        .size(px(20.0))
                        .rounded(px(6.0))
                        .bg(crate::theme::ink(0.09))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            crate::icons::icon(crate::icons::CHAT_ROUND_LINE)
                                .size(px(12.0))
                                .text_color(theme.text_muted),
                        ),
                )
                .child(
                    div()
                        .flex_none()
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(theme.text_muted)
                        .child(SharedString::from("Question")),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_color(theme.text.opacity(0.9))
                        .child(value),
                ),
        )
        .into_any_element()
}

/// A small glyph standing in for the tool's icon (comet uses an icon set; a
/// quiet monochrome character keeps the tile without shipping SVGs).
/// The glyph for a tool call (comet tool-chip.tsx `toolIcon`, Solar set).
pub(crate) fn tool_icon_path(call: &ToolCall) -> &'static str {
    match call {
        ToolCall::Exec { .. } => crate::icons::COMMAND,
        ToolCall::ReadFile { .. } | ToolCall::ApplyPatch { .. } => crate::icons::DOCUMENT,
        ToolCall::WriteFile { .. } => crate::icons::DOCUMENT_ADD,
        ToolCall::EditFile { .. } => crate::icons::PEN,
        ToolCall::Search { .. } => crate::icons::MAGNIFER,
        ToolCall::Glob { .. } => crate::icons::FOLDER_WITH_FILES,
        ToolCall::WebFetch { .. } | ToolCall::WebSearch { .. } => crate::icons::GLOBAL,
        ToolCall::Todo { .. } => crate::icons::CHECKLIST,
        ToolCall::Mcp { .. } | ToolCall::Unknown { .. } => crate::icons::WIDGET,
    }
}

/// One tool chip row: a guide rail on the left (continuous across stacked
/// chips — the rail spans the row's full height) threading the chips to their
/// group toggle, then the chip card (comet tool-chip.tsx).
///
/// `Todo` chips with items expand below the header to show each todo item
/// inline (checkbox glyph + text), so the agent's task list is visible while
/// it works — not collapsed to a one-line "N/M done" summary.
pub(crate) fn tool_chip(tool: &ToolItem, theme: &Theme) -> AnyElement {
    let (label, detail) = tool_chip_content(&tool.call);
    let tint = if tool.is_error {
        theme.danger
    } else {
        theme.text_muted
    };
    let height = tool_chip_height(&tool.call);

    // Card header row: icon tile + label + one-line detail. Identical to the
    // flat chip's row; the Todo expansion adds item rows BELOW this inside the
    // same card.
    let header_row = div()
        .h(px(CHIP_CARD_HEIGHT))
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .child(
            div()
                .size(px(18.0))
                .flex_none()
                .rounded(px(5.0))
                .bg(crate::theme::ink(0.08))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    crate::icons::icon(tool_icon_path(&tool.call))
                        .size(px(12.0))
                        .text_color(theme.text_muted),
                ),
        )
        .child(
            div()
                .flex_none()
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(tint)
                .child(SharedString::from(label)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(if tool.is_error {
                    theme.danger
                } else {
                    theme.text.opacity(0.85)
                })
                .child(SharedString::from(detail)),
        );

    // Build the card body: header alone for most tools; header + items for
    // Todo chips.
    let card_body: AnyElement = match &tool.call {
        ToolCall::Todo { items } if !items.is_empty() => div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(9.0))
            .border_1()
            .border_color(crate::theme::hairline(0.07))
            .bg(crate::theme::ink(0.03))
            .px(px(8.0))
            .text_size(px(12.0))
            .child(header_row)
            .child(todo_items_list(items, theme))
            .into_any_element(),
        _ => div()
            .h(px(CHIP_CARD_HEIGHT))
            .min_w_0()
            .flex_1()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .overflow_hidden()
            .rounded(px(9.0))
            .border_1()
            .border_color(crate::theme::hairline(0.07))
            .bg(crate::theme::ink(0.03))
            .px(px(8.0))
            .text_size(px(12.0))
            .child(header_row)
            .into_any_element(),
    };

    div()
        .h(px(height))
        .w_full()
        .flex_none()
        .flex()
        .flex_row()
        // Guide rail: hairline centered under the header's chevron tile,
        // spanning the chip's full (possibly expanded) height.
        .child(
            div()
                .ml(px(12.0))
                .h_full()
                .w(px(1.0))
                .flex_none()
                .bg(crate::theme::ink(0.08)),
        )
        .child(div().ml(px(12.0)).child(card_body))
        .into_any_element()
}

/// Inline todo-item list rendered inside an expanded Todo chip. Each item is a
/// checkbox glyph (filled for done, hollow for pending) + single-line text.
pub(crate) fn todo_items_list(items: &[comet_proto::TodoItem], theme: &Theme) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .pt(px(TODO_ITEMS_PAD))
        .pb(px(TODO_ITEMS_PAD))
        .children(items.iter().enumerate().map(|(i, item)| {
            let done = item.done;
            let text = single_line(&item.text);
            let glyph = if done { "☑" } else { "☐" };
            let color = if done {
                theme.text_muted.opacity(0.6)
            } else {
                theme.text.opacity(0.85)
            };
            let glyph_color = if done {
                theme.text_muted.opacity(0.7)
            } else {
                theme.text_muted
            };
            div()
                .id(SharedString::from(format!("todo-{i}")))
                .h(px(TODO_ITEM_HEIGHT))
                .flex_none()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(
                    div()
                        .flex_none()
                        .w(px(16.0))
                        .text_size(px(13.0))
                        .text_color(glyph_color)
                        .child(SharedString::from(glyph)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(color)
                        .child(SharedString::from(text)),
                )
        }))
        .into_any_element()
}

pub(crate) fn entry_fingerprint(entry: &SessionMessageEntry, pending: bool) -> u64 {
    let mut acc: Vec<u8> = Vec::with_capacity(entry.parts.len() * 8 + 16);
    acc.extend_from_slice(entry.id.as_bytes());
    acc.push(match entry.status {
        None => 0,
        Some(MessageStatus::Streaming) => 1,
        Some(MessageStatus::Complete) => 2,
        Some(MessageStatus::Aborted) => 3,
    });
    acc.push(pending as u8);
    for part in &entry.parts {
        acc.extend_from_slice(part.id().as_bytes());
        acc.extend_from_slice(&(part.byte_len() as u64).to_le_bytes());
        if let MessagePart::Tool {
            is_error, resolved, ..
        } = part
        {
            acc.push(*is_error as u8 | (*resolved as u8) << 1);
        }
        if let MessagePart::Input { resolved, .. } = part {
            acc.push(0x10 | *resolved as u8);
        }
    }
    fnv1a(&acc)
}

