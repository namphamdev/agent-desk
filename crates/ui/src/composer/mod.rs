//! Composer: the message input with file mentions, context, and send.

mod flip;
mod wizard;
mod mention;
mod input_state;
mod input_actions;
mod input_element;
mod composer_lifecycle;
mod composer_mentions;
mod composer_send;
mod composer_wizard;
mod composer_render;
mod composer_render_workflows;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_extras;

pub(crate) use flip::{
    FlipMorph, SendButtonMode, flip_morph_step, send_button_mode,
    pending_input_request, input_request_resolved,
    collapse_text_glide, morph_text_pad, morph_cluster_dy, morph_cluster_inset,
};
pub(crate) use mention::*;
pub(crate) use wizard::{Wizard, WizardStep};
pub(crate) use input_element::{
    ComposerTextElement, ComposerTextPrepaint, MentionPathTooltip,
};

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    AnyTooltip, App, BorderStyle, Bounds, ClipboardEntry, ClipboardItem, Context, CursorStyle,
    DispatchPhase, ElementInputHandler, Entity, EntityInputHandler, EventEmitter, FocusHandle,
    Focusable, GlobalElementId, KeyBinding, KeyDownEvent, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ObjectFit, PaintQuad, PathPromptOptions, Pixels, Point,
    ScrollWheelEvent, SharedString, Style, StyledImage as _, Subscription, Task, TextRun,
    TextStyle, UTF16Selection, UnderlineStyle, Window, WrappedLine, actions, div, fill, img, point,
    prelude::*, px, quad, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

use comet_doc::{MessagePart, MessageRole, SessionCommandPayload, SessionMessageEntry};
use comet_proto::{FileSearchMatch, RunRequest, SteeringMode, UserInputAnswer, UserInputQuestion};
use comet_rpc::{RpcError, methods};

use crate::attachments::{self, StagedAttachment};
use crate::motion;
use crate::pickers::Pickers;
use crate::state::{AppState, Indicator};
use crate::theme::Theme;

actions!(
    composer,
    [
        Backspace,
        Delete,
        Left,
        Right,
        Up,
        Down,
        Home,
        End,
        DocStart,
        DocEnd,
        WordLeft,
        WordRight,
        DeleteWordLeft,
        DeleteWordRight,
        DeleteToLineStart,
        DeleteToLineEnd,
        SelectAll,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectHome,
        SelectEnd,
        SelectDocStart,
        SelectDocEnd,
        SelectWordLeft,
        SelectWordRight,
        Copy,
        Cut,
        Paste,
        Undo,
        Redo,
        MentionAccept,
        MentionEscape,
        MentionTab,
        ShowDebug,
        Newline,
        Submit,
    ]
);

// ---------------------------------------------------------------------------
// Constants + pure decision logic
// ---------------------------------------------------------------------------

pub(crate) const MENTION_PREFIX: char = '@';
pub(crate) const MENTION_SIDE_PAD: &str = "\u{00A0}";
pub(crate) const FILE_MENTION_SCHEME: &str = "comet-file:";
pub(crate) const UNDO_COALESCE: Duration = Duration::from_millis(700);
pub(crate) const UNDO_LIMIT: usize = 128;
pub(crate) const ROUTE_SNAP_MS: u64 = 250;
pub(crate) const MENTION_TOOLTIP_DELAY: Duration = Duration::from_millis(420);
pub(crate) const MENTION_TOOLTIP_HEIGHT: f32 = 24.0;
pub(crate) const CLUSTER_X_DELTA: f32 = 4.0;
pub(crate) const CLUSTER_Y_DELTA: f32 = 2.5;
// (morph constants are functions in flip.rs)

/// Expanded-mode textarea vertical padding: `pt-4 pb-1` (comet composer.tsx
/// line 578) = 16 + 4.
pub const TEXTAREA_PAD_V: f32 = 20.0;
/// The expanded textarea BOX (content + padding) is clamped by the original's
/// auto-grow effect: `ta.style.height = Math.min(Math.max(scrollHeight, 76),
/// 260)` (comet composer.tsx line 235). The 76px floor applies even when
/// empty — it's what makes the always-expanded new-chat composer tall.
pub const TEXTAREA_MIN: f32 = 76.0;
pub const TEXTAREA_MAX: f32 = 260.0;
/// Expanded actions row: `pt-1` (4) + h-8 picker chips (32 — the tallest
/// children; composer/styles.tsx pickerChip) + `pb-2.5` (10) — comet
/// composer-actions.tsx line 60.
pub const ACTIONS_ROW_HEIGHT: f32 = 46.0;
/// The pill's 1px hairline, top + bottom (`rounded-[26px] border`).
pub const PILL_BORDER_V: f32 = 2.0;
/// Expanded composer bounds, border-box: 76 + 46 + 2 = 124 when empty (the
/// new-chat canvas), 260 + 46 + 2 = 308 at the content cap.
pub const COMPOSER_MIN_HEIGHT: f32 = TEXTAREA_MIN + ACTIONS_ROW_HEIGHT + PILL_BORDER_V;
pub const COMPOSER_MAX_HEIGHT: f32 = TEXTAREA_MAX + ACTIONS_ROW_HEIGHT + PILL_BORDER_V;
/// Compact pill, border-box: one-line textarea `py-3` (24) + one 22.75px line
/// (scrollHeight rounds to 47 in the original) + the 2px hairline = 49. The
/// compact cluster (`py-1.5` + h-8 = 44) is shorter, so the textarea wins.
pub const COMPACT_TOTAL_HEIGHT: f32 = 49.0;
/// Below this pill input width the composer always expands.
pub const MIN_COMPACT_INPUT_WIDTH: f32 = 200.0;
/// Input text metrics: `text-[14px] leading-relaxed` = 14 × 1.625 = 22.75.
pub const INPUT_LINE_HEIGHT: f32 = 22.75;
pub const INPUT_TEXT_SIZE: f32 = 14.0;
/// Single-select questions auto-advance after this long.
pub const AUTO_ADVANCE_MS: u64 = 220;
/// Drag-selection autoscroll runs at the display-friendly 60fps cadence.
pub const DRAG_SCROLL_FRAME_MS: u64 = 16;

/// Hysteresis slack for the expanded→compact flip: once expanded, the composer
/// only collapses when the text is comfortably narrower than the compact
/// capacity — expanding and collapsing share no boundary, so a width right at
/// the flip threshold can't oscillate between the two layouts.
pub const COLLAPSE_HYSTERESIS: f32 = 32.0;
/// During an interactive window resize the current mode is frozen until the
/// measured widths have been stable this long.
pub const RESIZE_SETTLE_MS: u64 = 150;

/// Compact↔expanded flip with hysteresis. `capacity` is the *compact-mode*
/// input capacity (a layout-stable width: measured while compact, tracked by
/// container-width deltas while expanded — never the post-flip measured width,
/// which differs per mode and would feed back into the decision):
/// - a focused input always expands (and stays expanded while focused);
/// - a newline always expands;
/// - while `resizing`, the current mode is kept (no flip until sizes settle);
/// - a too-narrow pill (`capacity < MIN_COMPACT_INPUT_WIDTH`) always expands;
/// - compact expands only when `text_width > capacity`; expanded collapses
///   only when `text_width < capacity - COLLAPSE_HYSTERESIS`.
pub fn composer_flip(
    expanded: bool,
    text_width: f32,
    capacity: f32,
    has_newline: bool,
    resizing: bool,
    focused: bool,
) -> bool {
    // A focused input always expands and stays expanded — the blur→collapse
    // is decided by the width/newline rules below (`focused = false`).
    if focused {
        return true;
    }
    if has_newline {
        return true;
    }
    // No width-based collapse while a resize is still settling: an unfocused
    // input that was force-expanded by focus keeps its mode until sizes rest.
    if resizing {
        return expanded;
    }
    if capacity < MIN_COMPACT_INPUT_WIDTH {
        return true;
    }
    if expanded {
        text_width >= capacity - COLLAPSE_HYSTERESIS
    } else {
        text_width > capacity
    }
}

/// Whether a mode change from [`composer_flip`] may be committed this pass.
/// Width/newline decisions read measurements, so they may only drive the next
/// flip after the input has been laid out in the current mode again (at most
/// one flip per layout pass — a flip invalidates the widths). A focus-GAIN is
/// measurement-independent: a focused input always expands (`composer_flip`'s
/// first rule), and the input only re-shapes on text/width/font/placeholder
/// changes — focusing an empty, already-measured pill re-shapes nothing, so
/// gating it on a fresh measurement would deadlock the expand (compact +
/// focused forever) until the user types. Blur stays gated: its collapse
/// decision reads the measured text width.
pub fn flip_commits(next: bool, expanded: bool, measured_since_flip: bool, focus_gained: bool) -> bool {
    next != expanded && (measured_since_flip || focus_gained)
}

/// Caret blink half-period (standard textarea cadence: ~500ms on / 500ms off).
pub const CARET_BLINK_MS: u64 = 500;

/// Caret blink phase for a time since the last keystroke/caret move: solid
/// through the first half-period (typing bursts never blink — each keystroke
/// resets the phase), then alternating.
pub fn caret_visible(ms_since_activity: u64) -> bool {
    (ms_since_activity / CARET_BLINK_MS) % 2 == 0
}

/// Auto-grow: content height for a wrapped-line count.
pub fn input_content_height(wrapped_lines: usize) -> f32 {
    wrapped_lines.max(1) as f32 * INPUT_LINE_HEIGHT
}

/// Total expanded composer height (border-box) for a content height: the
/// textarea BOX (content + `pt-4 pb-1`) clamps to 76–260 exactly like the
/// original's auto-grow effect, then the 46px actions row and the hairline
/// ride on top. Range 124–308.
pub fn composer_total_height(content_height: f32) -> f32 {
    (content_height + TEXTAREA_PAD_V).clamp(TEXTAREA_MIN, TEXTAREA_MAX)
        + ACTIONS_ROW_HEIGHT
        + PILL_BORDER_V
}

/// Byte range of the word containing `offset` for double-click selection.
/// Uses the same word-boundary notion as the cursor-motion helpers
/// (alphanumeric / underscore runs). If the offset lands on whitespace the
/// adjacent word is NOT crossed — the range collapses to the offset, matching
/// standard editor behavior where double-clicking between words selects
/// nothing until the pointer is over a word character.
fn word_range_for_offset(text: &str, offset: usize) -> Range<usize> {
    let mut ix = offset.min(text.len());
    while ix > 0 && !text.is_char_boundary(ix) {
        ix -= 1;
    }
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let before = text[..ix].chars().next_back();
    let at = text[ix..].chars().next();
    // Off a word boundary entirely: select the single non-whitespace char
    // (e.g. `=`, `(`) under the cursor, or nothing at whitespace.
    if !at.is_some_and(is_word) && !before.is_some_and(is_word) {
        return match at {
            Some(c) if !c.is_whitespace() => ix..ix + c.len_utf8(),
            _ => ix..ix,
        };
    }
    let start = text[..ix]
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map(|(i, _)| i)
        .unwrap_or(ix);
    let end = text[ix..]
        .char_indices()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map(|(i, c)| ix + i + c.len_utf8())
        .unwrap_or(ix);
    start..end
}

fn input_max_scroll(content_height: f32, viewport_height: f32) -> f32 {
    (content_height - viewport_height).max(0.0)
}

/// Apply GPUI's wheel delta to a top-origin input offset. Positive deltas mean
/// scrolling toward the start, matching gpui's built-in list/div behavior.
fn input_scroll_offset(
    current: f32,
    delta_y: f32,
    content_height: f32,
    viewport_height: f32,
) -> f32 {
    (current - delta_y).clamp(0.0, input_max_scroll(content_height, viewport_height))
}

/// Minimally adjust the viewport so the caret row is fully visible.
fn input_scroll_offset_for_cursor(
    current: f32,
    cursor_top: f32,
    cursor_height: f32,
    content_height: f32,
    viewport_height: f32,
) -> f32 {
    let mut next = current;
    if cursor_top < next {
        next = cursor_top;
    } else if cursor_top + cursor_height > next + viewport_height {
        next = cursor_top + cursor_height - viewport_height;
    }
    next.clamp(0.0, input_max_scroll(content_height, viewport_height))
}

/// Per-frame drag-selection scroll. Distance increases speed, capped at one
/// text row per frame so crossing the input boundary never causes a jump.
fn input_drag_scroll_delta(
    pointer_y: f32,
    viewport_top: f32,
    viewport_bottom: f32,
    line_height: f32,
) -> f32 {
    let distance = if pointer_y < viewport_top {
        pointer_y - viewport_top
    } else if pointer_y > viewport_bottom {
        pointer_y - viewport_bottom
    } else {
        return 0.0;
    };
    distance.signum() * (distance.abs() * 0.2).clamp(1.0, line_height)
}

/// Staged-attachment strip metrics (comet attachment-ui.tsx AttachmentStrip:
/// `flex flex-wrap gap-2 px-4 pt-3`, `size-14` thumbs).
pub const STRIP_THUMB: f32 = 56.0;
pub const STRIP_GAP: f32 = 8.0;
pub const STRIP_PAD_TOP: f32 = 12.0;
pub const STRIP_PAD_X: f32 = 16.0;

/// Height the wrap strip adds to the pill for `count` staged thumbnails at an
/// `inner_width` pill content width (0 when empty). Mirrors flex-wrap: as many
/// 56px thumbs per row as fit with 8px gaps inside the 16px side insets.
pub fn attachment_strip_height(count: usize, inner_width: f32) -> f32 {
    if count == 0 {
        return 0.0;
    }
    let usable = (inner_width - 2.0 * STRIP_PAD_X).max(STRIP_THUMB);
    let per_row = (((usable + STRIP_GAP) / (STRIP_THUMB + STRIP_GAP)).floor() as usize).max(1);
    let rows = count.div_ceil(per_row);
    STRIP_PAD_TOP + rows as f32 * STRIP_THUMB + (rows - 1) as f32 * STRIP_GAP
}

/// Compact↔expanded flip morph (round 9): the flip used to snap between the
/// two pill layouts. The original has no height transition (its shell carries
/// only `transition-colors`), so this is a native nicety: ONE committed flip
/// starts exactly one 180ms ease-out morph ([`motion::COLLAPSE`], the same
/// manual-drive pattern as shell.rs `WidthTween` — never `with_animation`,
/// whose element-id keying replays tweens on remount, round-6 §1–3).
///
/// The morph animates the pill's COMMITTED height: the flip commits its final
/// layout immediately (the input entity never remounts — the caret survives,
/// exactly as before) while the pill clips toward the live target. The pill's
/// bottom edge is stationary on screen, so the controls stay pinned to it
/// (constant screen-y; see the anchoring helpers below) and only the text
/// glides with the sweeping top edge. [`composer_flip`]'s hysteresis already
/// guarantees no oscillation at the boundary, and [`flip_morph_step`] never
/// restarts a morph while the committed mode holds. Reduced motion snaps: no
/// morph is ever created.
pub enum ComposerInputEvent {
    Submitted,
    Edited,
    CursorMoved,
    ViewportChanged,
    MentionNavigate(isize),
    MentionAccept,
    MentionDismiss,
    /// Images pasted from the clipboard (screenshots / copied image data) —
    /// the wrapper stages them as attachments (use-attachments.ts onPaste).
    PastedImages(Vec<gpui::Image>),
    /// File paths pasted from the clipboard (a file manager "Copy").
    PastedPaths(Vec<PathBuf>),
}

/// Multiline input entity: content + selection + IME marked text + measured
/// layout (wrapped lines) for mouse mapping and auto-grow.
pub struct ComposerInput {
    /// Key context for the binding map ("Composer", or "PaletteSearch" for
    /// palette filters whose navigation keys must bubble).
    pub(crate) key_context: &'static str,
    pub(crate) focus_handle: FocusHandle,
    pub(crate) content: String,
    pub(crate) placeholder: SharedString,
    pub(crate) selected_range: Range<usize>,
    pub(crate) selection_reversed: bool,
    pub(crate) marked_range: Option<Range<usize>>,
    pub(crate) is_selecting: bool,
    pub(crate) drag_position: Option<Point<Pixels>>,
    pub(crate) drag_generation: u64,
    pub(crate) drag_autoscroll_active: bool,
    /// Vertical scroll inside the input once content exceeds the max height.
    pub(crate) scroll_top: f32,
    /// Normally keeps the caret visible through edits and rewraps. Manual
    /// wheel scrolling pauses it until the next caret move or edit.
    pub(crate) follow_cursor: bool,
    /// Max content height before internal scrolling kicks in. Defaults to the
    /// expanded composer cap; compact inputs (e.g. the git commit description
    /// box) lower it so long text scrolls inside their fixed-height box
    /// instead of painting past its border.
    pub(crate) max_content_height: f32,
    // -- measured state (written during layout/paint) --
    pub(crate) last_lines: Vec<WrappedLine>,
    pub(crate) line_starts: Vec<usize>,
    pub(crate) last_bounds: Option<Bounds<Pixels>>,
    pub(crate) line_height: Pixels,
    pub(crate) content_height: f32,
    pub(crate) max_line_width: f32,
    pub(crate) last_width: f32,
    /// Cache key for the last shape_text pass. Shaping (glyph shaping +
    /// soft-wrapping) is the single most expensive thing the input does, and
    /// the caret blink loop + per-keystroke notifies drive repeated layout
    /// passes even when nothing changed, so a long draft (tens of thousands
    /// of characters) was re-shaped over and over, freezing the input.
    pub(crate) shaped_display: String,
    pub(crate) shaped_width: f32,
    pub(crate) shaped_font_size: Pixels,
    pub(crate) shaped_is_placeholder: bool,
    pub(crate) shaped_marked: Option<Range<usize>>,
    /// Raw Markdown → chip display projection from the last layout pass.
    pub(crate) projection: TextProjection,
    /// Whether `content` changed since the last `refresh_projection` pass.
    /// Every edit sets this; `refresh_projection` clears it, so the redundant
    /// call at the top of `layout_text` (after `replace_text_in_range` already
    /// rebuilt the projection) becomes an O(1) no-op instead of re-scanning
    /// the whole draft for mention links on every keystroke.
    pub(crate) projection_dirty: bool,
    /// File mentions are a composer feature, not a behavior of generic inputs
    /// (picker searches and rename fields also use this type).
    pub(crate) mentions_enabled: bool,
    /// Bumped once per `layout_text` pass — the flip logic uses it to apply at
    /// most one compact↔expanded flip per layout (a flip is only re-evaluated
    /// after the input has been measured in the new mode).
    pub(crate) layout_epoch: u64,
    pub(crate) display_is_placeholder: bool,
    /// Caret blink anchor: reset on every keystroke/caret move so the caret is
    /// solid while typing and blinks at [`CARET_BLINK_MS`] when idle.
    pub(crate) blink_anchor: Instant,
    /// Half-period repaint driver, alive only while the input is focused.
    pub(crate) blink_task: Option<Task<()>>,
    // -- undo history --
    pub(crate) undo_stack: Vec<EditSnapshot>,
    pub(crate) redo_stack: Vec<EditSnapshot>,
    /// Kind, trailing offset, and time of the last edit — the merge test that
    /// decides whether the next edit extends the current undo step.
    pub(crate) last_edit: Option<(EditKind, usize, Instant)>,
    /// The wrapper owns mention state; this only redirects bound keys while a
    /// mention token is active, keeping input focus and native text editing.
    pub(crate) mention_open: bool,
    pub(crate) mention_has_selection: bool,
    /// Last prepainted chip bounds; the paint-phase pointer listener uses
    /// these instead of attempting to infer text geometry from the cursor.
    pub(crate) mention_hits: Vec<MentionHit>,
    pub(crate) mention_tooltip: MentionTooltipPhase,
    pub(crate) mention_tooltip_generation: u64,
    pub(crate) mention_tooltip_popup: Option<Bounds<Pixels>>,
    pub(crate) mention_tooltip_task: Option<Task<()>>,
    /// Created once when Waiting promotes; retaining this entity preserves
    /// GPUI's global animation state across prepaint frames.
    pub(crate) mention_tooltip_view: Option<Entity<MentionPathTooltip>>,
}


pub enum ComposerEvent {
    /// A prompt was sent (optimistically) — re-engage the transcript pin.
    Sent { chat_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MentionToken {
    pub(crate) range: Range<usize>,
    pub(crate) query: String,
}

/// The `@` must begin a token. This intentionally excludes `name@example.com`
/// and ordinary words while allowing punctuation such as `(@src`.
pub(crate) fn mention_token(text: &str, cursor: usize) -> Option<MentionToken> {
    if cursor > text.len() || !text.is_char_boundary(cursor) {
        return None;
    }
    let token_start = text[..cursor]
        .char_indices()
        .rev()
        .find_map(|(at, ch)| ch.is_whitespace().then_some(at + ch.len_utf8()))
        .unwrap_or(0);
    let Some(relative_at) = text[token_start..cursor].rfind('@') else {
        return None;
    };
    let at = token_start + relative_at;
    let valid_boundary = at == 0
        || text[..at]
            .chars()
            .next_back()
            .is_some_and(|ch| ch.is_whitespace() || matches!(ch, '(' | '[' | '{'));
    if text[at + 1..cursor].contains('@') || !valid_boundary {
        return None;
    }
    let end = text[cursor..]
        .char_indices()
        .find_map(|(at, ch)| ch.is_whitespace().then_some(cursor + at))
        .unwrap_or(text.len());
    Some(MentionToken {
        range: at..end,
        query: text[at + 1..cursor].to_string(),
    })
}

#[derive(Debug, Clone, Default)]
pub(crate) struct FileMentionState {
    pub(crate) token: Option<MentionToken>,
    pub(crate) results: Vec<FileSearchMatch>,
    pub(crate) active: Option<usize>,
    pub(crate) request: u64,
    pub(crate) loading: bool,
    /// Why the last search failed, for the popup. A failure MUST NOT render
    /// as "No matching files": cross-device searches fail for reasons the
    /// user can act on (host daemon too old for `SearchFiles`, device
    /// offline), and the empty state hid them (user report).
    pub(crate) error: Option<SharedString>,
    /// Full token text, not just the cursor-relative query: moving within a
    /// dismissed token keeps it closed, while any edit re-enables completion.
    pub(crate) dismissed: Option<(Range<usize>, String)>,
}

pub(crate) fn mention_response_is_current(state: &FileMentionState, request: u64) -> bool {
    state.request == request && state.token.is_some()
}

/// A failed file search, translated for the popup. `UnknownMethod` is the
/// version-skew case: `SearchFiles` shipped after v0.1.9, so a session hosted
/// by a device on an older daemon answers "unknown method" while the same
/// search works for local sessions.
fn mention_error_message(err: &RpcError) -> SharedString {
    match err {
        RpcError::UnknownMethod(_) => {
            "The session's device runs an older comet — update it to search its files".into()
        }
        RpcError::Transport(_) | RpcError::Closed => "The session's device is unreachable".into(),
        RpcError::BadParams(_) | RpcError::Failed(_) => "File search failed".into(),
    }
}

pub struct Composer {
    state: Entity<AppState>,
    input: Entity<ComposerInput>,
    /// Composer actions row: repo/branch/harness-model/traits (§1.7).
    pickers: Entity<Pickers>,
    /// Draft text per chat key ("" = new-chat canvas), surviving navigation.
    drafts: HashMap<String, String>,
    /// Staged-but-unsent attachments per chat key (use-attachments.ts `stash`):
    /// navigating away and back restores them; memory-only, like the original.
    attachments: HashMap<String, Vec<StagedAttachment>>,
    /// The staged attachment being viewed full-size (click a thumbnail).
    preview: Option<attachments::PreviewImage>,
    /// In-flight file-picker prompt (paperclip).
    picker_task: Option<Task<()>>,
    mention_task: Option<Task<()>>,
    mention: FileMentionState,
    current_key: String,
    selected_workflow_id: Option<String>,
    workflow_space_id: Option<String>,
    pr_ref_input: Entity<ComposerInput>,
    sending: bool,
    failure: Option<SharedString>,
    wizard: Option<Wizard>,
    wizard_focus: FocusHandle,
    /// Requests already answered locally (suppresses the panel until the doc
    /// frame marks them resolved).
    answered_requests: HashSet<String>,
    advance_task: Option<Task<()>>,
    send_task: Option<Task<()>>,
    // -- compact/expanded flip state (hysteresis; see `composer_flip`) --
    /// Current layout mode (persisted across frames — never derived fresh).
    expanded_mode: bool,
    /// Whether the input was focused last frame — a focus change must drive a
    /// flip (focus expands, blur may collapse), so its transition notifies.
    input_focused: bool,
    /// `layout_epoch` of the measurement that caused the last flip: the flip is
    /// re-evaluated only after the input has been laid out in the new mode, so
    /// at most one flip can happen per layout pass.
    flip_epoch: u64,
    /// Compact-mode input capacity, learned while compact (layout-stable).
    compact_capacity: f32,
    /// Input width first measured after expanding — container-width deltas
    /// while expanded shift `compact_capacity` by the same amount.
    expanded_anchor: f32,
    /// Last input width seen in the current mode (resize detection).
    last_seen_width: f32,
    /// Set while an interactive resize is in flight; mode is frozen until
    /// widths have settled for [`RESIZE_SETTLE_MS`].
    width_changed_at: Option<Instant>,
    settle_task: Option<Task<()>>,
    /// In-flight compact↔expanded morph (one per committed flip; manual
    /// drive — see [`FlipMorph`]).
    flip_morph: Option<FlipMorph>,
    /// Pill height actually rendered last frame — a committed flip morphs
    /// from here, so mid-flight reversals hand off without a jump.
    last_rendered_height: f32,
    /// Monotonic clock anchor for the morph timeline.
    morph_clock: Instant,
    /// Set on every session/route change: flips committed before this instant
    /// SNAP instead of morphing (see [`ROUTE_SNAP_MS`]).
    route_snap_until: Option<Instant>,
    _observe: Subscription,
    _pickers_observe: Subscription,
    _input_events: Subscription,
    _pr_ref_events: Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

