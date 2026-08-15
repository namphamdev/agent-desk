//! Transcript view, scrollable message list with stick-to-bottom spring,
//! per-row fold/unfold, markdown rendering, and tool-group chips.

mod spring;
mod rows;
mod parse;
mod highlight;
mod impl_core;
mod impl_rows;
mod impl_scroll;
mod render_helpers;
mod sticky_user;
#[cfg(test)]
mod tests;

pub use parse::ParseOutcome;
pub use rows::{Row, RowKind, ToolItem, rows_for_entry};
pub use comet_proto::view::{single_line, tool_chip_content};
pub(crate) use parse::{flavour_seed, flavour_word, format_elapsed};

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use gpui::{
    Context, Entity, EventEmitter,
    ListState, SharedString, Subscription, Task, Window, canvas, div, list, prelude::*,
};

use comet_doc::MessageRole;

use crate::markdown::parser::{BlockTree, IncrementalParser};
use crate::markdown::render::RenderCache;
use crate::markdown::veil::RowVeil;
use crate::motion::{self};
use crate::state::AppState;
use crate::theme::Theme;

use highlight::HighlightStore;
use spring::StickSpring;

pub const STICK_THRESHOLD_PX: f32 = 70.0;
pub const OVERDRAW_PX: f32 = 320.0;
pub const SCROLL_BUTTON_THRESHOLD_PX: f32 = 320.0;
pub const GAP_TURN: f32 = 14.0;
pub const GAP_BLOCK: f32 = 8.0;
pub const MAX_CONTENT_WIDTH: f32 = 736.0;
pub const CHIP_HEIGHT: f32 = 38.0;
pub const CHIP_GAP: f32 = 0.0;
pub const CHIP_CARD_HEIGHT: f32 = 30.0;
pub(crate) const CHIPS_TOP_PAD: f32 = 2.0;
pub(crate) const TODO_ITEM_HEIGHT: f32 = 22.0;
pub(crate) const TODO_ITEMS_PAD: f32 = 4.0;
pub(crate) const FOLD_TWEEN_WINDOW: std::time::Duration = std::time::Duration::from_millis(400);
pub const ATT_THUMB_W: f32 = 112.0;
pub const ATT_THUMB_H: f32 = 80.0;
pub const ATT_STRIP_H: f32 = ATT_THUMB_H + 10.0;

// Spring constants
pub(crate) const SPRING_DAMPING: f32 = 0.7;
pub(crate) const SPRING_STIFFNESS: f32 = 0.05;
pub(crate) const SPRING_MASS: f32 = 1.25;
pub(crate) const SPRING_FRAME_MS: f32 = 1000.0 / 60.0;
pub(crate) const SPRING_MAX_CATCHUP_FRAMES: f32 = 8.0;
pub(crate) const SPRING_GROWTH_EMA: f32 = 0.12;
pub(crate) const SPRING_CHASE_MAX_LEAD: f32 = 32.0;
pub(crate) const AT_BOTTOM_PX: f32 = 2.0;
pub(crate) const SPRING_SETTLE_GRACE_MS: u64 = 500;
pub(crate) const GLIDE_MAX_VIEWPORTS: f32 = 2.5;

pub(super) struct CachedRows {
    pub(super) fingerprint: u64,
    pub(super) rows: Vec<Row>,
}

#[derive(Default, Clone, Copy)]
pub(super) struct FoldState {
    /// User pin (click); `None` follows the auto-open rule.
    pub(super) open: Option<bool>,
    /// Bumped per toggle — keys the 200ms height tween.
    pub(super) epoch: usize,
    /// Height at the moment of the toggle (the tween's start). The destination
    /// is always the *current* target height, so content growth after a toggle
    /// snaps instead of replaying a stale tween.
    pub(super) from: f32,
    /// When the toggle happened. The tween is armed only for a short window
    /// after the click: gpui replays an element's animation on REMOUNT, and a
    /// virtualized row scrolling back into view is a remount — an armed-forever
    /// tween made every once-collapsed group flash open→closed on each
    /// reappearance (user report).
    pub(super) toggled_at: Option<Instant>,
}

#[derive(Clone)]
pub enum TranscriptEvent {
    NewThread { text: String, role: MessageRole },
}

pub struct Transcript {
    pub(super) state: Entity<AppState>,
    pub(super) list: ListState,
    pub(super) rows: Vec<Row>,
    pub(super) chat_id: Option<String>,
    pub(super) row_cache: HashMap<String, CachedRows>,
    pub(super) live_parsers: HashMap<String, IncrementalParser>,
    pub(super) tree_cache: HashMap<String, (usize, Arc<BlockTree>)>,
    pub(super) folds: HashMap<SharedString, FoldState>,
    /// Streaming fade veils, one per live markdown row (dropped on completion).
    pub(super) veils: HashMap<SharedString, Rc<RefCell<RowVeil>>>,
    /// Live rows present in the transcript's REPLAY after (re)attaching to a
    /// chat: their veils are created pre-seeded, so text that was already
    /// streamed before the switch never fades in — only appends after it do
    /// (mugen's `FadePainter.attach` baseline; user report: switching back to
    /// a streaming session dissolved the entire reply).
    pub(super) veil_baseline: std::collections::HashSet<SharedString>,
    /// Armed at attach, disarmed on the first sync whose transcript is
    /// non-empty: the baseline must be captured from the doc REPLAY frame,
    /// not the attach-time sync — selection clears the transcript and the
    /// replay lands async, so capturing at attach seeded nothing and the
    /// still-streaming reply faded in whole on every session switch (user
    /// report, round 2).
    pub(super) veil_attach_pending: bool,
    /// Cross-frame flatten/shape-input cache (see [`RenderCache`]): fade
    /// frames reuse settled blocks' text+runs; the incremental parser's stable
    /// boundary invalidates only the live tail per commit.
    pub(super) render_cache: Rc<RefCell<RenderCache>>,
    pub(super) highlights: HighlightStore,
    pub(super) show_jump_button: bool,
    /// Distance from the bottom at the last observation (wheel event or spring
    /// tick) — restick and escape are direction-aware
    /// (see [`Transcript::should_restick`]).
    pub(super) last_scroll_distance: f32,
    /// The stick-to-bottom pin. Broken only by user input (wheel/touch up);
    /// re-engaged inside the 70px band, on own-send, and on the jump button.
    pub(super) pinned: bool,
    pub(super) spring: StickSpring,
    /// Wall-clock of the previous spring tick (`None` = parked).
    pub(super) spring_last_tick: Option<Instant>,
    /// When the spring last landed on the bottom (settle-grace bookkeeping).
    pub(super) spring_settled_at: Option<Instant>,
    /// A doc commit / wake happened before layout measured it — run at least
    /// one spring tick even though the pre-layout distance still reads 0.
    pub(super) spring_kick: bool,
    /// One `on_next_frame` callback in flight at most.
    pub(super) spring_scheduled: bool,
    pub(super) scroll_anim: Option<Task<()>>,
    /// MessageRail width gate (set by the shell from the container width).
    pub(super) rail_enabled: bool,
    /// Hovered rail tick (grows + shows the preview card).
    pub(super) rail_hover: Option<usize>,
    /// `(row id, entry id)` under the pointer — reveals the entry's timestamp
    /// strip (comet chat-view.tsx `group-hover`; the rows report hover
    /// themselves). Keyed by ROW so a row→row move within one entry can't
    /// clear the reveal when the old row's leave event arrives after the new
    /// row's enter (enter/leave order across rows is not guaranteed).
    pub(super) hovered_entry: Option<(SharedString, SharedString)>,
    /// Code block showing "Copied" feedback: `(row id, block ix)`, cleared by
    /// the companion task after ~1.2s.
    pub(super) copied_code: Option<(SharedString, usize)>,
    pub(super) copied_clear: Option<Task<()>>,
    /// Message footer showing transient "Copied" feedback.
    pub(super) copied_message: Option<SharedString>,
    pub(super) copied_message_clear: Option<Task<()>>,
    /// Error chip showing transient copied feedback.
    pub(super) copied_error: Option<SharedString>,
    pub(super) copied_error_clear: Option<Task<()>>,
    /// Mermaid card showing "Copied" feedback: `(row id, block ix)`, cleared
    /// by the companion task after ~1.2s (mirrors `copied_code`).
    pub(super) copied_mermaid: Option<(SharedString, usize)>,
    pub(super) copied_mermaid_clear: Option<Task<()>>,
    /// Mermaid diagram open in the full-screen modal: `(row id, source)`.
    /// `None` renders no modal.
    pub(super) mermaid_fullscreen: Option<(SharedString, String)>,
    /// Transcript attachment being viewed full-size (click a user thumbnail).
    pub(super) attachment_preview: Option<crate::attachments::PreviewImage>,
    /// In-flight ReadAttachmentChunk loads, keyed `(deviceId, path)` — one per
    /// source; results land in the global attachment cache.
    pub(super) attachment_loads: HashMap<(String, String), Task<()>>,
    /// Scheduled retry wake-ups for errored sources (the 2s→15s ladder).
    pub(super) attachment_retries: HashMap<(String, String), Task<()>>,
    /// Scrollbar drag anchor: the thumb-top pixel offset captured at
    /// mouse-down, used to compute the delta for each drag-move.
    pub(super) scrollbar_drag_anchor: Option<f32>,
    /// Scrollbar thumb / track hovered (rest-state auto-hide).
    pub(super) scrollbar_hover: bool,
    pub(super) _observe: Subscription,
}


impl EventEmitter<TranscriptEvent> for Transcript {}

impl Render for Transcript {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Release gpui-side decoded copies of any images the attachment LRU
        // evicted since the last frame (no-op when nothing was evicted).
        crate::attachments::flush_evicted(Some(window), cx);
        // Spring driver: one on_next_frame callback at a time; each tick
        // notifies, which re-enters render and schedules the next frame until
        // the spring parks. Reduced motion never schedules (sync snaps).
        if self.pinned
            && !motion::reduced_motion(cx)
            && !self.spring_scheduled
            && self.spring_should_run()
        {
            self.spring_scheduled = true;
            let entity = cx.weak_entity();
            window.on_next_frame(move |_, cx| {
                entity
                    .update(cx, |this: &mut Transcript, cx| {
                        this.spring_scheduled = false;
                        this.step_spring(cx);
                    })
                    .ok();
            });
        }
        // Re-register window-level mouse-move/up listeners each frame while
        // a scrollbar drag is in progress. Must be called from a paint
        // callback (canvas), NOT from render() or an event handler — gpui
        // asserts that on_mouse_event runs during paint.
        let drag_listeners = if self.scrollbar_drag_anchor.is_some() {
            let weak = cx.weak_entity();
            let weak_move = weak.clone();
            let weak_up = weak.clone();
            Some(canvas(
                move |_, _, _| (),
                move |_, _, window, _| {
                    window.on_mouse_event(move |e: &gpui::MouseMoveEvent, phase, _window, cx| {
                        if phase != gpui::DispatchPhase::Bubble || !e.dragging() {
                            return;
                        }
                        weak_move
                            .update(cx, |this, cx| {
                                this.scrollbar_drag_move(f32::from(e.position.y), cx);
                            })
                            .ok();
                    });
                    window.on_mouse_event(move |_: &gpui::MouseUpEvent, phase, _window, cx| {
                        if phase != gpui::DispatchPhase::Bubble {
                            return;
                        }
                        weak_up
                            .update(cx, |this, cx| {
                                if this.scrollbar_drag_anchor.is_some() {
                                    this.scrollbar_drag_anchor = None;
                                    cx.notify();
                                }
                            })
                            .ok();
                    });
                },
            ))
        } else {
            None
        };
        let rail = self.render_rail(cx);
        // The scroll-to-bottom pill is rendered by the SHELL (conversation
        // region overlay): it must float just above the composer and paint
        // OVER the bottom fade gradient, which is a later sibling of this
        // outlet — an overlay here would be tinted by the fade.
        let root = div()
            .relative()
            .size_full()
            .min_h_0()
            // FIRST child ⇒ paints first: clears the frame's markdown text-
            // selection registry before any row's text elements re-register
            // (document paint order = selection order; see markdown/render.rs).
            .child(crate::markdown::render::selection_frame_reset())
            .child(
                list(self.list.clone(), cx.processor(Self::render_row))
                    .size_full()
                    .with_sizing_behavior(gpui::ListSizingBehavior::Auto),
            )
            .child(rail)
            .child(self.render_sticky_user(cx))
            .child(self.render_scrollbar(cx))
            .when_some(drag_listeners, |el, c| el.child(c));
        // Full-size viewer for a clicked user-bubble thumbnail
        // (AttachmentPreviewDialog: bare lightbox, click closes).
        if let Some(preview) = self.attachment_preview.clone() {
            let weak = cx.weak_entity();
            return root.child(crate::attachments::lightbox(
                window.viewport_size(),
                &preview,
                move |_, cx| {
                    weak.update(cx, |this, cx| {
                        this.attachment_preview = None;
                        cx.notify();
                    })
                    .ok();
                },
            ));
        }
        // Full-screen mermaid modal (Open-full-screen affordance on a mermaid
        // card). Independent zoom/scroll/pan state via a fixed viewer key.
        if let Some((_, source)) = self.mermaid_fullscreen.clone() {
            let theme = Theme::of(cx).clone();
            let weak = cx.weak_entity();
            return root.child(crate::markdown::render::mermaid_fullscreen(
                window.viewport_size(),
                &source,
                &theme,
                move |_, cx| {
                    weak.update(cx, |this, cx| {
                        this.mermaid_fullscreen = None;
                        cx.notify();
                    })
                    .ok();
                },
            ));
        }
        root
    }
}

