//! impl Transcript: render_row and per-row-type rendering (markdown blocks,
//! tool groups, user bubbles, error chips).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, ClipboardItem, Context, SharedString, Window, div, prelude::*, px,
};

use comet_doc::MessageRole;

use crate::dev_inspector::{InspectClickExt as _, InspectExt as _};
use crate::markdown::highlight::{Token, lang_for_tag};
use crate::markdown::parser::{Block, BlockTree};
use crate::markdown::render::{self, RenderOptions};
use crate::markdown::veil::RowVeil;
use crate::motion::{self, AnimationExt as _, RESIZE};
use crate::theme::Theme;

use super::parse::{
    chips_height, tool_group_summary, top_gap_for,
};
use super::render_helpers::{
    input_chip, tool_chip, user_mention_text,
};
use super::rows::{RowKind, ToolItem, format_timestamp, frame_stats_enabled, record_live_frame_us, render_cache_disabled};
use super::{
    Transcript, TranscriptEvent,
    CHIP_GAP, CHIPS_TOP_PAD, FOLD_TWEEN_WINDOW, GAP_TURN,
    MAX_CONTENT_WIDTH, single_line,
};

impl Transcript {
    pub(super) fn render_row(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(row) = self.rows.get(ix).cloned() else {
            return gpui::Empty.into_any_element();
        };
        let theme = Theme::of(cx).clone();
        let top_gap = if ix == 0 {
            GAP_TURN + 10.0
        } else {
            top_gap_for(ix.checked_sub(1).and_then(|i| self.rows.get(i)), &row)
        };
        let bottom_pad = if ix + 1 == self.rows.len() { 24.0 } else { 0.0 };

        let inner: AnyElement = match &row.kind {
            RowKind::User {
                text,
                mentions,
                attachments,
                pending,
            } => {
                let attachments = attachments.clone();
                let text = text.clone();
                let mentions = mentions.clone();
                let pending = *pending;
                // Attachment thumbnails ride ABOVE the bubble, right-aligned
                // (chat-view.tsx RowView: UserAttachmentStrip then the text
                // HStack); image-only sends show no bubble at all.
                let mut column = div().w_full().flex().flex_col();
                if !attachments.is_empty() {
                    column = column.child(self.render_user_attachments(&row.id, &attachments, cx));
                }
                if !text.is_empty() {
                    // `min_w_0` is load-bearing: gpui text answers min/max-content
                    // probes with its UNWRAPPED width, so without it the bubble's
                    // automatic min-size is the full single-line width — the flex
                    // item can't shrink, `justify_end` pushes the overflow off the
                    // left edge, and long prompts render as one clipped line
                    // instead of wrapping inside the 80% column cap.
                    column = column.child(
                        div().w_full().flex().justify_end().child(
                            div()
                                .min_w_0()
                                .max_w(px(MAX_CONTENT_WIDTH * 0.8))
                                .bg(theme.surface_raised)
                                .rounded(px(Theme::BUBBLE_RADIUS))
                                .px(px(16.0))
                                .py(px(10.0))
                                .text_size(px(14.0))
                                .line_height(px(22.0))
                                .text_color(theme.text)
                                .when(pending, |el| el.opacity(0.65))
                                .child(if mentions.is_empty() {
                                    text.into_any_element()
                                } else {
                                    user_mention_text(text, mentions, &theme)
                                }),
                        ),
                    );
                }
                column.into_any_element()
            }
            RowKind::Markdown { tree, block_ix } => {
                let opts = RenderOptions {
                    row_key: row.id.clone(),
                    veil: None,
                    cache: (!render_cache_disabled()).then(|| self.render_cache.clone()),
                    now: Instant::now(),
                    copy: Some(self.copy_ui_for(&row.id, cx)),
                    mermaid: Some(self.mermaid_ui_for(&row.id, cx)),
                };
                let highlight = self.code_highlight_for(&row.id, tree, Some(*block_ix), cx);
                let Some(top) = tree.blocks.get(*block_ix) else {
                    return gpui::Empty.into_any_element();
                };
                render::render_block(
                    &top.block,
                    *block_ix,
                    *block_ix,
                    &opts,
                    &theme,
                    window,
                    highlight
                        .get(block_ix)
                        .and_then(|o| o.as_deref())
                        .map(|v| v.as_slice()),
                )
            }
            RowKind::LiveMarkdown { tree, block_ix } => {
                // Per-appended-chunk fade veil (opacity only — layout commits
                // instantly). Reduced motion renders with no veil at all.
                // Baseline rows (text already streamed when the transcript
                // attached) start seeded: the existing reply must not fade in
                // on a session switch — only fresh appends animate.
                let veil = (!motion::reduced_motion(cx)).then(|| {
                    self.veils
                        .entry(row.id.clone())
                        .or_insert_with(|| {
                            if self.veil_baseline.contains(&row.id) {
                                Rc::new(RefCell::new(RowVeil::seeded()))
                            } else {
                                Rc::default()
                            }
                        })
                        .clone()
                });
                let opts = RenderOptions {
                    row_key: row.id.clone(),
                    veil: veil.clone(),
                    cache: (!render_cache_disabled()).then(|| self.render_cache.clone()),
                    now: Instant::now(),
                    copy: Some(self.copy_ui_for(&row.id, cx)),
                    mermaid: Some(self.mermaid_ui_for(&row.id, cx)),
                };
                let highlight = self.code_highlight_for(&row.id, tree, Some(*block_ix), cx);
                let Some(top) = tree.blocks.get(*block_ix) else {
                    return gpui::Empty.into_any_element();
                };
                let timer = frame_stats_enabled().then(Instant::now);
                let el = render::render_block(
                    &top.block,
                    *block_ix,
                    *block_ix,
                    &opts,
                    &theme,
                    window,
                    highlight
                        .get(block_ix)
                        .and_then(|o| o.as_deref())
                        .map(|v| v.as_slice()),
                );
                if let Some(start) = timer {
                    record_live_frame_us(start.elapsed().as_micros() as u64);
                }
                // The attach pass for this row is done (every element rendered
                // above seeded its baseline synchronously): elements appearing
                // from the NEXT pass on are newly streamed and fade normally.
                if let Some(veil) = &veil {
                    veil.borrow_mut().finish_seeding();
                }
                // Drive the veil clock: while any chunk is still dissolving,
                // repaint next frame (self-limiting — one callback per frame).
                if veil.is_some_and(|v| v.borrow().is_fading()) {
                    let id = cx.entity_id();
                    window.on_next_frame(move |_, cx| cx.notify(id));
                }
                el
            }
            RowKind::ToolGroup { tools, auto_open } => {
                self.render_tool_group(&row.id, tools, *auto_open, &theme, cx)
            }
            RowKind::InputChip { header, resolved } => {
                input_chip(header.clone(), *resolved, &theme)
            }
            RowKind::ErrorChip { message } => {
                self.render_error_chip(&row.id, message.clone(), &theme, cx)
            }
        };

        // Hover-revealed timestamp strip (comet chat-view.tsx `Timestamp`):
        // a RESERVED 16px lane under the entry's last row — the label only
        // flips opacity, so revealing it never shifts the virtualizer's
        // layout. User entries align end (under the bubble), assistant start.
        let is_user_row = matches!(row.kind, RowKind::User { .. });
        let hovered = self
            .hovered_entry
            .as_ref()
            .is_some_and(|(_, entry)| entry == &row.entry_id);
        // Vertical breathing room from the source: assistant text blocks sit
        // in a `VStack padding={4}` (chat-view.tsx:183), so the strip starts
        // 4px below the message text — the native markdown column has no such
        // bottom padding, so the strip carries it as top inset (grown into the
        // reserved height: reveal still never shifts layout). User rows are
        // flush: the Timestamp follows the bubble HStack directly (VStack gap
        // defaults to 0 in mugen), the label's centering inside the 16px lane
        // is all the gap the original has.
        let strip = row.timestamp.map(|ms| {
            div()
                .h(px(if is_user_row { 16.0 } else { 20.0 }))
                .when(!is_user_row, |el| el.pt(px(4.0)))
                .w_full()
                .flex()
                .items_center()
                // No horizontal inset: the original's `px-1` netted out flush
                // because its message text was inset by the same amount (group
                // padding 4 + inner VStack 4 = 8 = group 4 + px-1 4). Here the
                // markdown text / user bubble sit AT the content column edges,
                // so the label must too — assistant label's left edge on the
                // text's first-character x, user label's right edge on the
                // bubble's right edge (user-reported 4px drift).
                .when(is_user_row, |el| el.justify_end())
                .when(hovered, |el| {
                    el.child(motion::fade_quick(
                        SharedString::from(format!("ts-{}", row.id)),
                        div()
                            .text_size(px(11.0))
                            .text_color(theme.text_muted.opacity(0.55))
                            .child(SharedString::from(format_timestamp(ms, &chrono::Local))),
                    ))
                })
        });
        let actions = row.raw_text.clone().zip(row.role).map(|(text, role)| {
            let copied = self
                .copied_message
                .as_ref()
                .is_some_and(|id| id == &row.entry_id);
            let copy_text = text.clone();
            let copy_entry = row.entry_id.clone();
            let thread_text = text;
            let align_end = role == MessageRole::User;
            div()
                .w_full()
                .mt(px(8.0))
                .flex()
                .gap(px(6.0))
                .when(align_end, |el| el.justify_end())
                .child(
                    div()
                        .id(SharedString::from(format!("message-copy-{}", row.entry_id)))
                        .inspect_tag("message-copy")
                        .h(px(24.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .rounded(px(Theme::CONTROL_RADIUS))
                        .border_1()
                        .border_color(theme.border)
                        .text_size(px(11.0))
                        .text_color(theme.text_muted)
                        .cursor_pointer()
                        .hover(|el| el.bg(crate::theme::wash(0.11)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_text.to_string()));
                            this.copied_message = Some(copy_entry.clone());
                            this.copied_message_clear = Some(cx.spawn(async move |this, cx| {
                                cx.background_executor()
                                    .timer(Duration::from_millis(1500))
                                    .await;
                                this.update(cx, |this, cx| {
                                    this.copied_message = None;
                                    this.copied_message_clear = None;
                                    cx.notify();
                                })
                                .ok();
                            }));
                            cx.notify();
                        }))
                        .child(
                            crate::icons::icon(if copied {
                                crate::icons::CHECK
                            } else {
                                crate::icons::COPY
                            })
                            .size(px(12.0))
                            .text_color(theme.text_muted),
                        )
                        .child(if copied { "Copied" } else { "Copy" }),
                )
                .child(
                    div()
                        .id(SharedString::from(format!(
                            "message-new-thread-{}",
                            row.entry_id
                        )))
                        .inspect_tag("message-new-thread")
                        .h(px(24.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .rounded(px(Theme::CONTROL_RADIUS))
                        .border_1()
                        .border_color(theme.border)
                        .text_size(px(11.0))
                        .text_color(theme.text_muted)
                        .cursor_pointer()
                        .hover(|el| el.bg(crate::theme::wash(0.11)))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(TranscriptEvent::NewThread {
                                text: thread_text.to_string(),
                                role,
                            });
                        }))
                        .child(
                            crate::icons::icon(crate::icons::CHAT_ROUND_LINE)
                                .size(px(12.0))
                                .text_color(theme.text_muted),
                        )
                        .child("New thread"),
                )
        });
        let entry_id = row.entry_id.clone();
        let row_id = row.id.clone();
        let row_inspect = crate::dev_inspector::inspect_meta("message-row");
        let row_hover_tag = row_inspect.clone();
        div()
            .id(row.id.clone())
            .on_hover(cx.listener(move |this, hovered: &bool, window, cx| {
                if *hovered {
                    let next = Some((row_id.clone(), entry_id.clone()));
                    if this.hovered_entry != next {
                        let entry_changed = this
                            .hovered_entry
                            .as_ref()
                            .is_none_or(|(_, entry)| entry != &entry_id);
                        this.hovered_entry = next;
                        if entry_changed {
                            cx.notify();
                        }
                    }
                } else if this
                    .hovered_entry
                    .as_ref()
                    .is_some_and(|(row, _)| row == &row_id)
                {
                    // Only the row that OWNS the current reveal may clear it —
                    // a stale leave from an earlier row must not blank the
                    // strip the newly entered row just lit.
                    this.hovered_entry = None;
                    cx.notify();
                }
                crate::dev_inspector::report_hover(&row_hover_tag, *hovered, window, cx);
            }))
            .inspect_click(row_inspect)
            .w_full()
            .flex()
            .justify_center()
            .pt(px(top_gap))
            .pb(px(bottom_pad))
            // Wide gutters (comet `px-4 @3xl:px-12`) around the 46rem column.
            .px(px(48.0))
            .child(
                div()
                    .w_full()
                    .max_w(px(MAX_CONTENT_WIDTH))
                    .min_w_0()
                    .child(inner)
                    .children(actions)
                    .children(strip),
            )
            .into_any_element()
    }

    /// Copy-button wiring for one row's code blocks ([`render::CopyUi`]):
    /// click writes the block's code to the clipboard and shows a transient
    /// "Copied" check on that block for ~1.2s (overlay — no layout shift).
    pub(super) fn copy_ui_for(&self, row_id: &SharedString, cx: &mut Context<Self>) -> render::CopyUi {
        let copied_ix = self
            .copied_code
            .as_ref()
            .filter(|(id, _)| id == row_id)
            .map(|(_, ix)| *ix);
        let row_key = row_id.clone();
        let entity = cx.weak_entity();
        let handler: Rc<dyn Fn(usize, SharedString, &mut Window, &mut gpui::App)> =
            Rc::new(move |ix, code, _window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(code.to_string()));
                let row_key = row_key.clone();
                entity
                    .update(cx, |this, cx| {
                        this.copied_code = Some((row_key, ix));
                        this.copied_clear = Some(cx.spawn(async move |this, cx| {
                            cx.background_executor()
                                .timer(Duration::from_millis(1200))
                                .await;
                            this.update(cx, |this, cx| {
                                this.copied_code = None;
                                this.copied_clear = None;
                                cx.notify();
                            })
                            .ok();
                        }));
                        cx.notify();
                    })
                    .ok();
            });
        render::CopyUi { handler, copied_ix }
    }

    /// Mermaid-card Copy + Open-full-screen wiring (mirrors [`copy_ui_for`]):
    /// copy writes the diagram source and flashes "Copied" on that block for
    /// ~1.2s; fullscreen opens the modal (see [`mermaid_fullscreen`]).
    pub(super) fn mermaid_ui_for(&self, row_id: &SharedString, cx: &mut Context<Self>) -> render::MermaidUi {
        let copied_ix = self
            .copied_mermaid
            .as_ref()
            .filter(|(id, _)| id == row_id)
            .map(|(_, ix)| *ix);
        let copy_row_key = row_id.clone();
        let copy_entity = cx.weak_entity();
        let copy: Rc<dyn Fn(usize, SharedString, &mut Window, &mut gpui::App)> =
            Rc::new(move |ix, source, _window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(source.to_string()));
                let row_key = copy_row_key.clone();
                copy_entity
                    .update(cx, |this, cx| {
                        this.copied_mermaid = Some((row_key, ix));
                        this.copied_mermaid_clear = Some(cx.spawn(async move |this, cx| {
                            cx.background_executor()
                                .timer(Duration::from_millis(1200))
                                .await;
                            this.update(cx, |this, cx| {
                                this.copied_mermaid = None;
                                this.copied_mermaid_clear = None;
                                cx.notify();
                            })
                            .ok();
                        }));
                        cx.notify();
                    })
                    .ok();
            });
        let fs_row_key = row_id.clone();
        let fs_entity = cx.weak_entity();
        let fullscreen: Rc<dyn Fn(usize, &mut Window, &mut gpui::App)> =
            Rc::new(move |_ix, _window, cx| {
                let row_key = fs_row_key.clone();
                fs_entity
                    .update(cx, |this, cx| {
                        // Resolve the source from the row's tree on open —
                        // the modal reads it back from `mermaid_fullscreen`.
                        this.mermaid_fullscreen_open(&row_key);
                        cx.notify();
                    })
                    .ok();
            });
        render::MermaidUi {
            copy,
            fullscreen,
            copied_ix,
        }
    }

    /// Look up the mermaid source for `row_id`'s currently-rendered block and
    /// stash it on `mermaid_fullscreen` so the modal can render it. The
    /// inline card's click only carries the block index, so we resolve from
    /// the row's parsed tree here.
    pub(super) fn mermaid_fullscreen_open(&mut self, row_id: &SharedString) {
        let Some(row) = self.rows.iter().find(|r| &r.id == row_id).cloned() else {
            return;
        };
        let tree = match &row.kind {
            RowKind::Markdown { tree, .. } | RowKind::LiveMarkdown { tree, .. } => tree,
            _ => return,
        };
        for top in tree.blocks.iter() {
            if let Block::Mermaid { code } = &top.block {
                self.mermaid_fullscreen = Some((row_id.clone(), code.clone()));
                return;
            }
        }
    }

    /// Request highlights for the code blocks of a tree. `only` limits to one
    /// block index (split rows); `None` covers the whole tree (live rows).
    pub(super) fn code_highlight_for(
        &mut self,
        row_id: &SharedString,
        tree: &Arc<BlockTree>,
        only: Option<usize>,
        cx: &mut Context<Self>,
    ) -> HashMap<usize, Option<Arc<Vec<Vec<Token>>>>> {
        let mut out = HashMap::new();
        for (ix, top) in tree.blocks.iter().enumerate() {
            if only.is_some_and(|o| o != ix) {
                continue;
            }
            if let Block::CodeBlock { language, code } = &top.block
                && let Some(lang) = language.as_deref().and_then(lang_for_tag)
            {
                out.insert(
                    ix,
                    self.highlights.request(row_id.clone(), ix, lang, code, cx),
                );
            }
        }
        out
    }

    pub(super) fn render_tool_group(
        &mut self,
        row_id: &SharedString,
        tools: &Arc<Vec<ToolItem>>,
        auto_open: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let fold = self.folds.get(row_id).copied().unwrap_or_default();
        let open = fold.open.unwrap_or(auto_open);
        let target = if open { chips_height(tools) } else { 0.0 };
        let summary = tool_group_summary(tools);

        let toggle_id = row_id.clone();
        let tools_for_toggle = tools.clone();
        // Header (comet tool-group.tsx): a small chevron tile centered over the
        // chips' guide rail, then the quiet 12px summary.
        let header = div()
            .id(SharedString::from(format!("{row_id}-hdr")))
            .inspect_tag("tool-group-header")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .px(px(4.0))
            .h(px(26.0))
            .cursor_pointer()
            .text_size(px(12.0))
            // Quiet even when children failed: agents routinely have failed
            // probes mid-work, and a red HEADER read as "this whole step
            // broke" (user report). Failures still show on the individual
            // chips (destructive tint, comet tool-chip.tsx) and in the
            // summary's "· N failed" count.
            .text_color(theme.text_muted)
            .hover(|s| s.text_color(theme.text))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.toggle_fold(toggle_id.clone(), &tools_for_toggle, auto_open);
                cx.notify();
            }))
            .child(
                div()
                    .size(px(18.0))
                    .flex_none()
                    .rounded(px(5.0))
                    .bg(crate::theme::ink(0.06))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(10.0))
                    .text_color(theme.text_muted.opacity(0.7))
                    .child(SharedString::from(if open { "▾" } else { "▸" })),
            )
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .child(SharedString::from(summary)),
            );

        let chips = div()
            .pt(px(CHIPS_TOP_PAD))
            .flex()
            .flex_col()
            .gap(px(CHIP_GAP))
            .children(tools.iter().map(|tool| tool_chip(tool, theme)));

        // Fold body: 200ms committed-height tween on a USER toggle only — and
        // only within a short window of the click. Auto-open (streaming) and
        // content growth never tween, and a SETTLED fold renders at its static
        // height: leaving the tween armed replayed it on every remount, which
        // in a virtualized list means every scroll-back-into-view (only `open`
        // toggles animate — composes with the stick spring).
        let animating = fold.epoch > 0
            && fold
                .toggled_at
                .is_some_and(|at| at.elapsed() < FOLD_TWEEN_WINDOW);
        let body: AnyElement = if animating {
            let from = fold.from;
            div()
                .overflow_hidden()
                .child(chips)
                .with_animation(
                    SharedString::from(format!("{row_id}-fold{}", fold.epoch)),
                    RESIZE.animation(),
                    move |el, t| el.h(px(motion::lerp(from, target, t))),
                )
                .into_any_element()
        } else {
            div()
                .overflow_hidden()
                .h(px(target))
                .child(chips)
                .into_any_element()
        };

        div()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
            .into_any_element()
    }

    /// Render a visible run error with a trailing control that copies the full
    /// message, including text hidden by the chip's one-line truncation.
    pub(super) fn render_error_chip(
        &mut self,
        row_id: &SharedString,
        message: SharedString,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let red_300 = crate::theme::oklch(0.808, 0.114, 19.571); // tailwind red-300
        let danger = theme.danger; // red-400
        let copied = self.copied_error.as_ref().is_some_and(|id| id == row_id);
        let copy_id = row_id.clone();
        let copy_message = message.clone();
        let display_message: SharedString = single_line(&message).into();

        div()
            .py(px(4.0))
            .w_full()
            .child(
                div()
                    .id(SharedString::from(format!("error-copy-{row_id}")))
                    .inspect_tag("error-copy")
                    .h(px(34.0))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .overflow_hidden()
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(danger.opacity(0.16))
                    .bg(danger.opacity(0.05))
                    .px(px(8.0))
                    .text_size(px(12.0))
                    .cursor_pointer()
                    .hover(|el| el.bg(danger.opacity(0.1)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(copy_message.to_string()));
                        this.copied_error = Some(copy_id.clone());
                        this.copied_error_clear = Some(cx.spawn(async move |this, cx| {
                            cx.background_executor()
                                .timer(Duration::from_millis(1500))
                                .await;
                            this.update(cx, |this, cx| {
                                this.copied_error = None;
                                this.copied_error_clear = None;
                                cx.notify();
                            })
                            .ok();
                        }));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex_none()
                            .size(px(20.0))
                            .rounded(px(6.0))
                            .bg(danger.opacity(0.12))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                crate::icons::icon(crate::icons::DANGER_TRIANGLE)
                                    .size(px(12.0))
                                    .text_color(red_300.opacity(0.8)),
                            ),
                    )
                    .child(
                        div()
                            .flex_none()
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(red_300.opacity(0.8))
                            .child(SharedString::from("Error")),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_color(theme.text.opacity(0.8))
                            .child(display_message),
                    )
                    .child(
                        div()
                            .flex_none()
                            .size(px(22.0))
                            .rounded(px(6.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_color(theme.text_muted)
                            .child(
                                crate::icons::icon(if copied {
                                    crate::icons::CHECK
                                } else {
                                    crate::icons::COPY
                                })
                                .size(px(12.0)),
                            ),
                    ),
            )
            .into_any_element()
    }
}

