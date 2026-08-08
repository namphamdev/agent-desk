//! The session tab strip — replaces the chat header (feature spec: spaces
//! overhaul). Every non-archived session of the selected space is a tab:
//! agent brand icon + title + a trailing slot that shows the status dot at
//! rest and swaps to a close button on hover. `+` at the end opens the
//! new-session canvas (the tab materializes on first send). The strip inherits
//! the old header's titlebar duties: 44px tall, drag region, animated
//! window-controls inset, and the toggle-changes button (git spaces only).
//!
//! Tabs are ordered by session creation order (device-local). Overflow scrolls
//! horizontally with edge fades. Click a tab to activate it; middle-click
//! closes it.

use super::*;
use comet_proto::ChatIndicator;

/// Fixed tab width (terminal tabs use 118; session titles get a bit more).
pub(super) const SESSION_TAB_WIDTH: f32 = 140.0;
/// Flex gap between tabs.
const TAB_GAP: f32 = 4.0;
/// Width of the overflow edge fades. Wide enough that per-glyph fade steps
/// (title text fades glyph-by-glyph on glass) stay gentle.
const FADE_WIDTH: f32 = 36.0;

fn format_rss(bytes: Option<u64>) -> Option<String> {
    let bytes = bytes?;
    const MIB: f64 = 1024.0 * 1024.0;
    const GIB: f64 = 1024.0 * MIB;
    if bytes as f64 >= GIB {
        Some(format!("{:.1} GB", bytes as f64 / GIB))
    } else {
        Some(format!("{} MB", (bytes as f64 / MIB).round() as u64))
    }
}

/// Resolve the visual tab order: the manual (drag) order first — skipping
/// entries that no longer exist — then any new items appended in creation
/// order. Shared by session tabs and space rows. Pure.
pub(super) fn resolve_tab_order(created_order: &[String], manual: &[String]) -> Vec<String> {
    let mut out: Vec<String> = manual
        .iter()
        .filter(|id| created_order.contains(id))
        .cloned()
        .collect();
    for id in created_order {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// The neighbor to select after closing `closed`: the next tab, else the
/// previous, else `None` (last tab → new-session canvas). Pure.
pub(super) fn next_after_close(order: &[String], closed: &str) -> Option<String> {
    let ix = order.iter().position(|id| id == closed)?;
    if order.len() <= 1 {
        return None;
    }
    Some(if ix + 1 < order.len() {
        order[ix + 1].clone()
    } else {
        order[ix - 1].clone()
    })
}

impl Shell {
    fn offload_selected_acp(
        &mut self,
        chat_id: String,
        target_device_id: String,
        cx: &mut Context<Self>,
    ) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            self.sidebar_notice = Some("Engine not connected".into());
            cx.notify();
            return;
        };
        self.mutate_task = Some(cx.spawn(async move |this, cx| {
            if let Err(err) = engine
                .client()
                .call(
                    methods::OFFLOAD_SESSION,
                    serde_json::json!({
                        "chatId": chat_id,
                        "targetDeviceId": target_device_id,
                    }),
                )
                .await
            {
                this.update(cx, |shell, cx| {
                    shell.sidebar_notice = Some(format!("Offload failed: {err}").into());
                    cx.notify();
                })
                .ok();
            }
        }));
    }

    /// The space's tabs in visual order (session creation order).
    fn tab_ids(&self, space_id: &str, cx: &App) -> Vec<String> {
        self.state
            .read(cx)
            .chats_in_space(space_id)
            .iter()
            .map(|c| c.id.clone())
            .collect()
    }

    /// Close a tab = archive the session. Selection moves to a neighbor; the
    /// last tab lands on the new-session canvas.
    pub(super) fn close_session_tab(&mut self, chat_id: String, cx: &mut Context<Self>) {
        let (selected, order) = {
            let space = self.state.read(cx).selected_space.clone();
            let order = space
                .as_deref()
                .map(|space| self.tab_ids(space, cx))
                .unwrap_or_default();
            (self.state.read(cx).selected_chat.clone(), order)
        };
        if selected.as_deref() == Some(chat_id.as_str()) {
            let next = next_after_close(&order, &chat_id);
            self.state.update(cx, |s, cx| s.select_chat(next, cx));
        }
        self.archive_chat(chat_id, cx);
    }

    /// Select the tab `delta` positions away from the currently selected one
    /// (Zed-style arrow navigation). Wraps around. The selection-change logic
    /// in [`render_session_tab_strip`] scrolls the newly focused tab into view
    /// via `scroll_to_item`.
    fn select_adjacent_tab(&mut self, delta: i32, cx: &mut Context<Self>) {
        let Some(space) = self.state.read(cx).selected_space.clone() else {
            return;
        };
        let order = self.tab_ids(&space, cx);
        if order.is_empty() {
            return;
        }
        let selected = self.state.read(cx).selected_chat.clone();
        let target = match selected.as_deref() {
            Some(sel) => {
                let ix = order.iter().position(|id| id == sel).unwrap_or(0);
                let len = order.len() as i32;
                let next = ((ix as i32 + delta).rem_euclid(len)) as usize;
                order[next].clone()
            }
            None => order[0].clone(),
        };
        // Clear tabs_scrolled_to so scroll-to-item fires for the new selection.
        self.tabs_scrolled_to = None;
        self.state.update(cx, |s, cx| s.select_chat(Some(target), cx));
    }

    /// The tab strip: [scrollable tabs (edge fades)][+][toggle-changes].
    pub(super) fn render_session_tab_strip(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(cx).clone();
        let now = Utc::now();
        let space_id = self.state.read(cx).selected_space.clone();
        let order: Vec<String> = space_id
            .as_deref()
            .map(|space| self.tab_ids(space, cx))
            .unwrap_or_default();
        let tabs: Vec<(
            String,
            SharedString,
            Option<comet_proto::HarnessId>,
            Option<String>,
            ChatIndicator,
        )> = {
            let state = self.state.read(cx);
            order
                .iter()
                .filter_map(|id| {
                    let chat = state.chats.iter().find(|c| c.id == *id)?;
                    Some((
                        chat.id.clone(),
                        SharedString::from(transcript::single_line(
                            &chat.title.clone().unwrap_or_else(|| "New session".into()),
                        )),
                        chat.config.as_ref().map(|c| c.harness),
                        chat.config
                            .as_ref()
                            .and_then(|c| c.acp_agent_id.clone()),
                        state.display_status_for(chat, now),
                    ))
                })
                .collect()
        };
        let selected = self.state.read(cx).selected_chat.clone();
        let memory_label = {
            let state = self.state.read(cx);
            selected
                .as_deref()
                .and_then(|chat_id| state.session_for(chat_id))
                .filter(|session| session.agent_running)
                .and_then(|session| format_rss(session.memory_rss_bytes))
        };
        let offload_target = {
            let state = self.state.read(cx);
            selected.as_deref().and_then(|chat_id| {
                let chat = state.chats.iter().find(|chat| chat.id == chat_id)?;
                let is_acp = chat
                    .config
                    .as_ref()
                    .is_some_and(|config| config.harness == comet_proto::HarnessId::Acp);
                let running = state
                    .session_for(chat_id)
                    .is_some_and(|session| session.agent_running);
                (is_acp && running).then(|| (chat.id.clone(), chat.device_id.clone()))
            })
        };
        // Keep the selected tab visible: on selection change, scroll it into
        // view. A new session's tab materializes at the far right of an
        // overflowing strip and would otherwise be stranded off-screen.
        //
        // We call `scroll_to_item` every frame until the offset actually
        // reaches the target — on the first frame after a new chat is
        // created, the ScrollHandle's `max_offset` hasn't been updated by
        // layout yet, so a single call scrolls short. By comparing the
        // desired index against a *confirmed* scrolled-to id (reset when the
        // selection changes and only set once the scroll offset stabilizes),
        // we retry on subsequent frames.
        match selected.as_deref() {
            Some(sel) if self.tabs_scrolled_to.as_deref() != Some(sel) => {
                if let Some(ix) = order.iter().position(|id| id == sel) {
                    self.tabs_scroll.scroll_to_item(ix);
                    // Check if scroll has actually reached the target — if
                    // max_offset is still too small (tab not laid out yet),
                    // don't confirm so we retry next frame.
                    let max_x = f32::from(self.tabs_scroll.max_offset().x);
                    let slot = SESSION_TAB_WIDTH + TAB_GAP;
                    let needed = ix as f32 * slot;
                    if max_x + 1.0 >= needed {
                        self.tabs_scrolled_to = Some(sel.to_string());
                    }
                } else {
                    // Tab not in order yet — retry next frame.
                }
                cx.notify();
            }
            Some(_) => {}
            None => self.tabs_scrolled_to = None,
        }
        let has_space = space_id.is_some();
        let git = self.space_git_detected(cx);
        let can_review = selected.as_deref().is_some_and(|chat_id| {
            self.state.read(cx).indicator_for(chat_id, now) == Indicator::None
                && !self.composer.read(cx).is_sending()
                && comet_engine::session_summary::summarize_session_changes(
                    &self.state.read(cx).transcript,
                    None,
                    None,
                )
                .has_reviewable_content
        });
        let hovered = self.tab_hover.clone();
        let on_canvas = selected.is_none();
        // No sessions yet → the canvas already shows; a `+` would be redundant.
        let has_tabs = !tabs.is_empty();
        let count = tabs.len();

        let tab_elements: Vec<AnyElement> =
            tabs.into_iter()
                .map(|(id, title, harness, acp_agent_id, status)| {
                    let is_selected = selected.as_deref() == Some(id.as_str());
                    let is_hovered = hovered.as_deref() == Some(id.as_str());
                    // Hover state lives in Shell (the trailing slot swaps dot ↔
                    // close), so the wash snaps off it too — gpui allows only one
                    // `on_hover` per element, and the state listener wins.
                    let (text_color, bg) = if is_selected {
                        (theme.text, crate::theme::glass_selected_bg())
                    } else if is_hovered {
                        (theme.text_muted.opacity(0.8), theme.glass_hover())
                    } else {
                        (theme.text_muted.opacity(0.6), crate::theme::wash(0.0))
                    };
                    let glyph_alpha = if is_selected { 0.9 } else { 0.6 };
                    let brand = harness.map(|harness| {
                        crate::pickers::harness_brand_icon(harness, acp_agent_id.as_deref())
                    });
                    let select_id = id.clone();
                    let close_id = id.clone();
                    let middle_id = id.clone();
                    let hover_id = id.clone();
                    // The trailing slot is ALWAYS in the tree (stable hit-test
                    // position): the status dot at rest, the close button on
                    // hover.
                    //
                    // The close button uses `on_mouse_down` with
                    // `stop_propagation` to prevent the pointer-down event
                    // from bubbling to the parent tab's click handler, and
                    // `on_click` with `stop_propagation` so the tab's own
                    // click-to-activate never fires when closing.
                    let dot = spaces::status_dot_color(status, &theme);
                    let trailing_hover_id = id.clone();
                    let trailing: AnyElement = div()
                        .id(SharedString::from(format!("session-tab-close-{id}")))
                        .size(px(20.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.0))
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered {
                                this.tab_hover = Some(trailing_hover_id.clone());
                            } else if this.tab_hover.as_deref() == Some(trailing_hover_id.as_str()) {
                                this.tab_hover = None;
                            }
                            cx.notify();
                        }))
                        .when(is_hovered, |el| {
                            el.cursor_pointer()
                                .hover(|s| s.bg(crate::theme::wash(0.14)))
                                .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                    // Stop the down event so the parent
                                    // tab's click handler never sees it.
                                    cx.stop_propagation();
                                })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.close_session_tab(close_id.clone(), cx);
                                }))
                                .child(
                                    icon(icons::CLOSE)
                                        .size(px(12.0))
                                        .text_color(theme.text_muted),
                                )
                        })
                        .when(!is_hovered, |el| {
                            // Working animates (the sidebar's miniaturized gradient
                            // spinner) instead of a static pink dot; every other
                            // non-idle status stays a dot.
                            el.when(status == ChatIndicator::Working, |el| {
                                el.child(loaders::mini_gradient_spinner(
                                    format!("tab-working-{id}"),
                                    2.0,
                                    cx.entity_id(),
                                    cx,
                                ))
                            })
                            .when(
                                !matches!(status, ChatIndicator::Idle | ChatIndicator::Working),
                                |el| el.child(div().size(px(6.0)).rounded_full().bg(dot)),
                            )
                        })
                        .into_any_element();
                    let tab_el = div()
                        .id(SharedString::from(format!("session-tab-{id}")))
                        .w(px(SESSION_TAB_WIDTH))
                        .h(px(28.0))
                        .flex_none()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .pl(px(8.0))
                        .pr(px(4.0))
                        .rounded(px(8.0))
                        .text_size(px(12.0))
                        .text_color(text_color)
                        .bg(bg)
                        .when(is_selected, |el| {
                            el.shadow(crate::theme::glass_selected_shadows())
                        })
                        .cursor_pointer()
                        // Tabs sit inside the titlebar drag strip — carve them
                        // out so the titlebar drag gesture doesn't swallow
                        // clicks. `occlude` creates a `BlockMouse` hitbox so
                        // the tab owns hover/click across its full area
                        // (title text and icon included). BlockMouse is also
                        // required so the titlebar's `WindowControlArea::Drag`
                        // hitbox is excluded from the mouse hit-test — without
                        // it, the OS treats the tab area as a drag region and
                        // swallows click + wheel events at the platform level.
                        //
                        // Because BlockMouse breaks the hit-test chain, the
                        // scroll container's own `on_scroll_wheel` never fires
                        // when the cursor is over a tab. The per-tab
                        // `on_scroll_wheel` handler below fills that gap: each
                        // tab's hitbox IS in the hit-test (it's the topmost),
                        // so `should_handle_scroll` returns true for it.
                        .occlude()
                        // Convert vertical wheel into horizontal scroll.
                        // Attached to each tab (not the scroll container)
                        // because the tab's `occlude()` blocks the scroll
                        // container from receiving scroll-wheel events — but
                        // the tab's own hitbox is the frontmost in the
                        // hit-test, so its listener fires reliably.
                        .on_scroll_wheel(cx.listener(
                            move |this, event: &gpui::ScrollWheelEvent, window, cx| {
                                let dy = match event.delta {
                                    gpui::ScrollDelta::Lines(delta) => {
                                        f32::from(delta.y) * SESSION_TAB_WIDTH
                                    }
                                    gpui::ScrollDelta::Pixels(delta) => f32::from(delta.y),
                                };
                                let dx = match event.delta {
                                    gpui::ScrollDelta::Lines(delta) => {
                                        f32::from(delta.x) * SESSION_TAB_WIDTH
                                    }
                                    gpui::ScrollDelta::Pixels(delta) => f32::from(delta.x),
                                };
                                let total = dx - dy;
                                if total.abs() > 0.0 {
                                    let offset = this.tabs_scroll.offset();
                                    let max = this.tabs_scroll.max_offset();
                                    let new_x =
                                        (f32::from(offset.x) - total).clamp(-f32::from(max.x), 0.0);
                                    this.tabs_scroll
                                        .set_offset(gpui::point(px(new_x), offset.y));
                                    window.refresh();
                                    cx.notify();
                                }
                            },
                        ))
                        // Track hover in Shell state: the trailing slot flips
                        // between dot and close button (hover_blend only fades
                        // colors; child swaps need real state).
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered {
                                this.tab_hover = Some(hover_id.clone());
                            } else if this.tab_hover.as_deref() == Some(hover_id.as_str()) {
                                this.tab_hover = None;
                            }
                            cx.notify();
                        }))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.state
                                .update(cx, |s, cx| s.select_chat(Some(select_id.clone()), cx));
                        }))
                        // Middle-click closes (terminal-tab parity).
                        .on_mouse_down(
                            MouseButton::Middle,
                            cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.close_session_tab(middle_id.clone(), cx);
                            }),
                        )
                        .when_some(brand, |el, (path, tint)| {
                            el.child(
                                icon(path).size(px(14.0)).flex_none().text_color(
                                    tint.unwrap_or(theme.text_muted).opacity(glyph_alpha),
                                ),
                            )
                        })
                        .child(div().flex_1().min_w_0().truncate().child(title))
                        .child(trailing);

                    tab_el.into_any_element()
                })
                .collect();

        // `+` — the new-session canvas "is" the unmaterialized tab, so the
        // button carries the active wash while the canvas shows.
        let new_tab = div()
            .id("session-tab-new")
            .size(px(28.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.0))
            .cursor_pointer()
            .bg(if on_canvas && has_space {
                crate::theme::glass_selected_bg()
            } else {
                motion::hover_blend(
                    "session-tab-new",
                    theme.glass_hover().opacity(0.0),
                    theme.glass_hover(),
                )
            })
            .when(on_canvas && has_space, |el| {
                el.shadow(crate::theme::glass_selected_shadows())
            })
            .on_hover(motion::hover_listener("session-tab-new"))
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                this.route = Route::Chat;
                this.state.update(cx, |s, cx| s.select_chat(None, cx));
                cx.notify();
            }))
            .child(
                icon(icons::PLUS)
                    .size(px(16.0))
                    .text_color(theme.text_muted),
            );

        // Overflow: the tab region scrolls horizontally; edge fades appear on
        // whichever side has hidden tabs (offset from the LAST frame — a
        // one-frame lag is invisible). On GLASS the fades are an EdgeFade
        // scope (per-glyph gradient); painted overlays only exist on opaque
        // platforms, in the SHELL surface tone the strip now sits on.
        let scrolled = -f32::from(self.tabs_scroll.offset().x);
        let max_scroll = f32::from(self.tabs_scroll.max_offset().x);
        let fade_left = scrolled > 1.0;
        let fade_right = scrolled < max_scroll - 1.0;
        let glass = theme.is_glass();
        let bar_bg = theme.surface;
        let tab_region = div()
            .relative()
            .min_w_0()
            .child(
                div()
                    .id("session-tabs-scroll")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(TAB_GAP))
                    .min_w_0()
                    .overflow_x_scroll()
                    .track_scroll(&self.tabs_scroll)
                    .on_scroll_wheel(cx.listener(
                        move |this, event: &gpui::ScrollWheelEvent, window, cx| {
                            // Convert vertical wheel into horizontal scroll so
                            // the tab strip responds to a standard mouse wheel
                            // (GPUI's overflow_x_scroll only scrolls on
                            // horizontal trackpad input by default).
                            let dy = match event.delta {
                                gpui::ScrollDelta::Lines(delta) => {
                                    f32::from(delta.y) * SESSION_TAB_WIDTH
                                }
                                gpui::ScrollDelta::Pixels(delta) => f32::from(delta.y),
                            };
                            let dx = match event.delta {
                                gpui::ScrollDelta::Lines(delta) => {
                                    f32::from(delta.x) * SESSION_TAB_WIDTH
                                }
                                gpui::ScrollDelta::Pixels(delta) => f32::from(delta.x),
                            };
                            let total = dx - dy;
                            if total.abs() > 0.0 {
                                let offset = this.tabs_scroll.offset();
                                let max = this.tabs_scroll.max_offset();
                                let new_x =
                                    (f32::from(offset.x) - total).clamp(-f32::from(max.x), 0.0);
                                this.tabs_scroll
                                    .set_offset(gpui::point(px(new_x), offset.y));
                                window.refresh();
                                cx.notify();
                            }
                        },
                    ))
                    .children(tab_elements),
            )
            .when(fade_left && !glass, |el| {
                el.child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .bottom_0()
                        .w(px(FADE_WIDTH))
                        .bg(gpui::linear_gradient(
                            90.0,
                            gpui::linear_color_stop(bar_bg, 0.0),
                            gpui::linear_color_stop(bar_bg.opacity(0.0), 1.0),
                        )),
                )
            })
            .when(fade_right && !glass, |el| {
                el.child(
                    div()
                        .absolute()
                        .right_0()
                        .top_0()
                        .bottom_0()
                        .w(px(FADE_WIDTH))
                        .bg(gpui::linear_gradient(
                            270.0,
                            gpui::linear_color_stop(bar_bg, 0.0),
                            gpui::linear_color_stop(bar_bg.opacity(0.0), 1.0),
                        )),
                )
            });
        let tab_region: AnyElement = if glass {
            crate::edge_fade::edge_faded(FADE_WIDTH, false, false, tab_region)
                .fade_left(fade_left)
                .fade_right(fade_right)
                .into_any_element()
        } else {
            tab_region.into_any_element()
        };

        // Tabs live above the INSET CARD: sidebar open → they start at the
        // card's left edge (+ its content pad); collapsed → they glide left
        // (on the sidebar width tween) until they sit next to the control
        // cluster.
        let sidebar_now = self.eval_tween(self.sidebar_tween, self.sidebar_target());
        let tabs_left = (sidebar_now + Theme::SPACE_LG).max(self.title_bar_content_start());

        // Zed-style arrow navigation: prev/next buttons flanking the tab strip.
        // Only show when there is more than one tab to navigate.
        let show_arrows = has_space && has_tabs && count > 1;
        let muted = theme.text_muted;
        let prev_arrow = div()
            .id("session-tab-prev")
            .size(px(20.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.0))
            .cursor_pointer()
            .occlude()
            .hover(|s| s.bg(crate::theme::wash(0.11)))
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                this.select_adjacent_tab(-1, cx);
            }))
            .child(icon(icons::ARROW_LEFT).size(px(14.0)).text_color(muted));
        let next_arrow = div()
            .id("session-tab-next")
            .size(px(20.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.0))
            .cursor_pointer()
            .occlude()
            .hover(|s| s.bg(crate::theme::wash(0.11)))
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                this.select_adjacent_tab(1, cx);
            }))
            .child(icon(icons::ARROW_RIGHT).size(px(14.0)).text_color(muted));

        let inner = div()
            .size_full()
            .flex()
            .items_center()
            .pt(px(Theme::TITLEBAR_TOP_PAD))
            .gap(px(6.0))
            .pl(px(tabs_left))
            .pr(px(Theme::SPACE_LG))
            .when(show_arrows, |el| el.child(prev_arrow))
            .child(tab_region)
            .when(has_space && has_tabs, |el| el.child(new_tab))
            .when(show_arrows, |el| el.child(next_arrow))
            .child(div().flex_1())
            .when(can_review, |el| {
                el.child(
                    div()
                        .id("review-session")
                        .h(px(26.0))
                        .px(px(8.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .rounded(px(Theme::CONTROL_RADIUS))
                        .border_1()
                        .border_color(theme.border)
                        .text_size(px(11.0))
                        .text_color(theme.text_muted)
                        .cursor_pointer()
                        .occlude()
                        .hover(|button| button.bg(crate::theme::wash(0.11)))
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            this.start_review_thread(cx);
                        }))
                        .child(
                            icon(icons::DOCUMENT)
                                .size(px(13.0))
                                .text_color(theme.text_muted),
                        )
                        .child("Review"),
                )
            })
            .when_some(memory_label, |el, label| {
                el.child(
                    div()
                        .flex_none()
                        .text_size(px(11.0))
                        .text_color(theme.text_muted.opacity(0.7))
                        .child(SharedString::from(label)),
                )
            })
            .when_some(offload_target, |el, (chat_id, target_device_id)| {
                el.child(header_icon_button(
                    "offload-acp-agent",
                    icons::ARCHIVE_UP_MINIMALISTIC,
                    &theme,
                    cx.listener(move |this, _, _, cx| {
                        this.offload_selected_acp(chat_id.clone(), target_device_id.clone(), cx)
                    }),
                ))
            })
            // Stable location: the toggle shows whether the pane is open or
            // not (the pane's own header is gone).
            .when(git, |el| {
                el.child(header_icon_button(
                    "toggle-changes",
                    icons::SIDEBAR_MINIMALISTIC,
                    &theme,
                    cx.listener(|this, _, _, cx| this.toggle_right_pane(cx)),
                ))
            });

        // The unified window titlebar: full-width on the glass shell, ABOVE
        // the inset card. No bottom border — the card's own hairline is the
        // separation; the glass gutter shows between.
        let bar = div().h(px(Theme::TITLEBAR_HEIGHT)).flex_none().child(inner);
        self.titlebar_drag_region("chat-tabs-titlebar", bar, cx)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{format_rss, next_after_close, resolve_tab_order};

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn close_selects_next_then_previous_then_canvas() {
        let order = ids(&["a", "b", "c"]);
        assert_eq!(next_after_close(&order, "a").as_deref(), Some("b"));
        assert_eq!(next_after_close(&order, "b").as_deref(), Some("c"));
        // Last tab: fall back to the previous one.
        assert_eq!(next_after_close(&order, "c").as_deref(), Some("b"));
        // Only tab: canvas.
        assert_eq!(next_after_close(&ids(&["solo"]), "solo"), None);
        // Unknown id: no opinion.
        assert_eq!(next_after_close(&order, "zz"), None);
    }

    #[test]
    fn manual_order_wins_and_new_chats_append() {
        let created = ids(&["a", "b", "c", "d"]);
        // Manual order covers some chats; "gone" no longer exists.
        let manual = ids(&["c", "gone", "a"]);
        assert_eq!(
            resolve_tab_order(&created, &manual),
            ids(&["c", "a", "b", "d"])
        );
        // No manual order → creation order.
        assert_eq!(resolve_tab_order(&created, &[]), created);
        // Manual covers everything → manual order verbatim.
        assert_eq!(
            resolve_tab_order(&ids(&["a", "b"]), &ids(&["b", "a"])),
            ids(&["b", "a"])
        );
    }

    #[test]
    fn formats_agent_memory_for_titlebar() {
        assert_eq!(
            format_rss(Some(512 * 1024 * 1024)).as_deref(),
            Some("512 MB")
        );
        assert_eq!(
            format_rss(Some(1536 * 1024 * 1024)).as_deref(),
            Some("1.5 GB")
        );
    }
}
