//! impl Transcript: scrollbar rendering and drag interaction.

use gpui::{AnyElement, Context, div, prelude::*, px};


use super::Transcript;
impl Transcript {
    // ---- scrollbar ----

    /// Scrollbar layout constants.
    const SCROLLBAR_WIDTH: f32 = 10.0;
    const SCROLLBAR_THUMB_MIN: f32 = 30.0;
    const SCROLLBAR_TRACK_INSET: f32 = 4.0;

    /// Render the vertical scrollbar overlaid on the right edge of the
    /// transcript. The thumb is invisible when the content fits the viewport
    /// (no scrollable range) and auto-hides shortly after the pointer leaves
    /// unless actively dragged.
    pub(super) fn render_scrollbar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let max = f32::from(self.list.max_offset_for_scrollbar().y).max(0.0);
        let viewport = f32::from(self.list.viewport_bounds().size.height);
        // No scrollable range or pre-layout (viewport 0): render nothing.
        let scrollable = max > 1.0 && viewport > 0.0;
        if !scrollable {
            return gpui::Empty.into_any_element();
        }

        // Thumb geometry: proportional to the visible fraction of the content,
        // clamped to a minimum so it stays grabbable on very long transcripts.
        let thumb_ratio = (viewport / (max + viewport)).clamp(0.05, 1.0);
        let thumb_h = (thumb_ratio * viewport).max(Self::SCROLLBAR_THUMB_MIN);

        // Thumb position from the scroll offset.
        let distance = self.distance_from_bottom();
        let scroll_from_top = (max - distance).max(0.0);
        let track_h = viewport - Self::SCROLLBAR_TRACK_INSET * 2.0;
        let thumb_travel = (track_h - thumb_h).max(0.0);
        let thumb_top = if max > 0.0 {
            (scroll_from_top / max) * thumb_travel + Self::SCROLLBAR_TRACK_INSET
        } else {
            Self::SCROLLBAR_TRACK_INSET
        };

        let dragging = self.scrollbar_drag_anchor.is_some();
        let active = self.scrollbar_hover || dragging;
        let thumb_color = if active {
            crate::theme::ink(0.38)
        } else {
            crate::theme::ink(0.22)
        };

        // Capture the current thumb-top for the mouse-down anchor: the
        // closure fires once at click time, and at that moment the rendered
        // thumb_top IS the thumb's position on screen.
        let thumb_top_for_down = thumb_top;

        div()
            .id("transcript-scrollbar-track")
            .absolute()
            .top_0()
            .right_0()
            .bottom_0()
            .w(px(Self::SCROLLBAR_WIDTH))
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                if this.scrollbar_hover != *hovered {
                    this.scrollbar_hover = *hovered;
                    cx.notify();
                }
            }))
            .child(
                div()
                    .id("transcript-scrollbar-thumb")
                    .absolute()
                    .top(px(thumb_top))
                    .left(px(Self::SCROLLBAR_TRACK_INSET))
                    .w(px(Self::SCROLLBAR_WIDTH - Self::SCROLLBAR_TRACK_INSET * 2.0))
                    .h(px(thumb_h))
                    .rounded_full()
                    .bg(thumb_color)
                    .cursor_pointer()
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if this.scrollbar_hover != *hovered {
                            this.scrollbar_hover = *hovered;
                            cx.notify();
                        }
                    }))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, event: &gpui::MouseDownEvent, _, cx| {
                            let mouse_y = f32::from(event.position.y);
                            // Anchor = offset of the click within the thumb
                            // (from its top), so the thumb doesn't jump.
                            this.scrollbar_drag_anchor = Some(mouse_y - thumb_top_for_down);
                            // Dragging always breaks the stick pin.
                            this.pinned = false;
                            this.spring.reset();
                            this.spring_last_tick = None;
                            cx.notify();
                        }),
                    ),
            )
            .into_any_element()
    }

    /// Process a scrollbar drag-move: convert the mouse Y to a target scroll
    /// offset and scroll the list accordingly.
    pub(super) fn scrollbar_drag_move(&mut self, mouse_y: f32, cx: &mut Context<Self>) {
        let Some(anchor) = self.scrollbar_drag_anchor else {
            return;
        };
        let max = f32::from(self.list.max_offset_for_scrollbar().y).max(0.0);
        let viewport = f32::from(self.list.viewport_bounds().size.height);
        if max < 1.0 || viewport < 1.0 {
            return;
        }
        let thumb_ratio = (viewport / (max + viewport)).clamp(0.05, 1.0);
        let thumb_h = (thumb_ratio * viewport).max(Self::SCROLLBAR_THUMB_MIN);
        let track_h = viewport - Self::SCROLLBAR_TRACK_INSET * 2.0;
        let thumb_travel = (track_h - thumb_h).max(0.0);
        let new_top = (mouse_y - anchor).clamp(
            Self::SCROLLBAR_TRACK_INSET,
            Self::SCROLLBAR_TRACK_INSET + thumb_travel,
        );
        let new_scroll_top = if thumb_travel > 0.0 {
            ((new_top - Self::SCROLLBAR_TRACK_INSET) / thumb_travel) * max
        } else {
            0.0
        };
        let current_scroll_top = (max - self.distance_from_bottom()).max(0.0);
        let delta = new_scroll_top - current_scroll_top;
        if delta.abs() > 0.5 {
            self.list.scroll_by(px(-delta));
            cx.notify();
        }
    }
}
