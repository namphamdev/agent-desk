//! Text selection: paint selection wash + drag-select listeners for
//! paragraph and heading rows in the transcript.

use std::cell::RefCell;
use std::ops::Range;

use gpui::{
    Bounds, Hsla, SharedString, Window, canvas, point,
    prelude::*, px, size,
};

use crate::theme::Theme;

/// Selection tint: the accent hue under the glyphs, dark-panel strength.
pub fn selection_wash(theme: &Theme) -> Hsla {
    theme.accent.opacity(0.35) // indigo-400
}

/// One painted text element, registered per frame in document order — the
/// continuity model that lets a drag span paragraphs/list items (Zed gets
/// this for free from its single-element markdown; our tree rebuilds it).
pub struct RegEntry {
    pub(crate) key: std::sync::Arc<str>,
    pub(crate) text: SharedString,
    pub(crate) layout: gpui::TextLayout,
}

thread_local! {
    pub(crate) static REGISTRY: RefCell<Vec<RegEntry>> = const { RefCell::new(Vec::new()) };
}

/// A zero-size canvas that clears the selection registry — paint it FIRST in
/// the transcript root (before any markdown), so each frame's registry holds
/// exactly that frame's visible text elements in paint order.
pub fn selection_frame_reset() -> impl IntoElement {
    canvas(
        |_, _, _| (),
        |_, _, _, _| REGISTRY.with(|r| r.borrow_mut().clear()),
    )
    .absolute()
    .w(px(0.0))
    .h(px(0.0))
}

/// `(element index, byte offset)` for a window position: the registered
/// element whose vertical band contains it, else the nearest by vertical
/// distance (a drag past the gutter or between blocks clamps sensibly).
pub fn registry_point(position: gpui::Point<gpui::Pixels>) -> Option<(usize, usize)> {
    REGISTRY.with(|r| {
        let reg = r.borrow();
        let mut best: Option<(usize, f32)> = None;
        for (ei, entry) in reg.iter().enumerate() {
            let b = entry.layout.bounds();
            let dy = if position.y < b.top() {
                f32::from(b.top() - position.y)
            } else if position.y > b.bottom() {
                f32::from(position.y - b.bottom())
            } else {
                0.0
            };
            if best.is_none_or(|(_, d)| dy < d) {
                best = Some((ei, dy));
            }
            if dy == 0.0 {
                break;
            }
        }
        let (ei, _) = best?;
        let ix = match reg[ei].layout.index_for_position(position) {
            Ok(ix) | Err(ix) => ix,
        };
        Some((ei, ix))
    })
}

/// Resolve the anchor + head into document-ordered spans over the frame's
/// registry and store them; true if the selection changed.
pub fn resolve_drag(anchor_key: &str, anchor_ix: usize, head: (usize, usize)) -> bool {
    REGISTRY.with(|r| {
        let reg = r.borrow();
        let Some(anchor_ei) = reg.iter().position(|e| e.key.as_ref() == anchor_key) else {
            return false; // anchor scrolled out of the frame — keep spans
        };
        let elements: Vec<(&str, &str)> = reg
            .iter()
            .map(|e| (e.key.as_ref(), e.text.as_ref()))
            .collect();
        let spans = crate::markdown::selection::resolve_spans(&elements, (anchor_ei, anchor_ix), head);
        crate::markdown::selection::update_spans(spans)
    })
}

/// Register this frame's window-level mouse listeners for one text element's
/// selection (Zed-markdown mechanics: window-level so a drag keeps tracking
/// outside the element's bounds; frame-scoped, so paint re-registers).
pub fn register_selection_listeners(
    window: &mut Window,
    key: &std::sync::Arc<str>,
    text: &SharedString,
    layout: &gpui::TextLayout,
) {
    use gpui::{DispatchPhase, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent};
    {
        let (key, text, layout) = (key.clone(), text.clone(), layout.clone());
        window.on_mouse_event(move |e: &MouseDownEvent, phase, window, _cx| {
            if phase != DispatchPhase::Bubble || e.button != MouseButton::Left {
                return;
            }
            if layout.bounds().contains(&e.position) {
                let ix = match layout.index_for_position(e.position) {
                    Ok(ix) | Err(ix) => ix,
                };
                match e.click_count {
                    2 => {
                        let range = crate::markdown::selection::word_range(&text, ix);
                        crate::markdown::selection::begin_with_span(&key, &text, range);
                    }
                    n if n >= 3 => {
                        crate::markdown::selection::begin_with_span(&key, &text, 0..text.len());
                    }
                    _ => crate::markdown::selection::begin(&key, ix),
                }
                window.refresh();
            } else if crate::markdown::selection::clear_if_owner(&key) {
                window.refresh();
            }
        });
    }
    {
        let key = key.clone();
        window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, _cx| {
            if phase != DispatchPhase::Bubble || !e.dragging() {
                return;
            }
            // Only the anchor element's listener drives the drag.
            let Some(anchor_ix) = crate::markdown::selection::drag_anchor(&key) else {
                return;
            };
            let Some(head) = registry_point(e.position) else {
                return;
            };
            if resolve_drag(&key, anchor_ix, head) {
                window.refresh();
            }
        });
    }
    {
        let key = key.clone();
        window.on_mouse_event(move |_: &MouseUpEvent, phase, _window, _cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            if let Some(_text) = crate::markdown::selection::end_drag(&key) {
                // X11 middle-click paste parity (Zed does the same).
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                _cx.write_to_primary(gpui::ClipboardItem::new_string(_text));
            }
        });
    }
}

/// The wash boxes for one byte range: one box per visual line the range
/// covers (soft wraps split it), in window coordinates from the laid-out
/// text's own geometry. `pad_x` overhangs the box horizontally (inline code);
/// `inset_y` shrinks it vertically — both 0 for a selection wash, which wants
/// full-line-height boxes that tile seamlessly across wrapped rows.
pub(crate) fn range_rects(
    layout: &gpui::TextLayout,
    range: &Range<usize>,
    pad_x: f32,
    inset_y: f32,
) -> Vec<Bounds<gpui::Pixels>> {
    let mut rects = Vec::new();
    let line_height = layout.line_height();
    let mut cur = range.start;
    // Walk the range one visual row at a time: find the furthest index that
    // still sits on the current row (binary search over glyph positions).
    let mut guard = 0;
    while cur < range.end && guard < 256 {
        guard += 1;
        let Some(p1) = layout.position_for_index(cur) else {
            break;
        };
        // `seg_end` closes the wash on this row; `next` is the first index on
        // the following row (strict progress even though a row-end index's
        // position still reports the earlier row).
        let (seg_end, next) = match layout.position_for_index(range.end) {
            Some(pe) if pe.y == p1.y => (range.end, range.end),
            _ => {
                // Largest ix on this row (probes stay on char boundaries only
                // at the ends; intermediate probes just need a y).
                let (mut lo, mut hi) = (cur, range.end);
                while hi - lo > 1 {
                    let mid = lo + (hi - lo) / 2;
                    match layout.position_for_index(mid) {
                        Some(pm) if pm.y == p1.y => lo = mid,
                        _ => hi = mid,
                    }
                }
                (lo, hi)
            }
        };
        if let Some(p2) = layout.position_for_index(seg_end)
            && p2.x > p1.x
        {
            rects.push(Bounds::new(
                point(p1.x - px(pad_x), p1.y + px(inset_y)),
                size(
                    p2.x - p1.x + px(2.0 * pad_x),
                    line_height - px(2.0 * inset_y),
                ),
            ));
        }
        if next <= cur {
            break;
        }
        cur = next;
    }
    rects
}
