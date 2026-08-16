use std::path::PathBuf;
use std::time::Duration;

use chrono::Utc;
use gpui::{
    AnyElement, App, Context, IntoElement, SharedString, Window, div, prelude::*, px,
    uniform_list,
};

use gpui_tokio::Tokio;

use crate::icons::{self, icon};
use crate::dev_inspector::{self, InspectClickExt as _, InspectExt as _};
use crate::motion::{self, AnimationExt as _};
use crate::popover::{self};
use crate::theme::Theme;

use super::layout::SettingsSection;
use super::nav::{
    UpdateFlow,
    resort_offsets, SIDEBAR_LIST_GAP, SIDEBAR_GLASS_FADE_BAND, RESORT,
};
use super::Shell;

impl Shell {
    pub(super) fn render_chat_sidebar(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let user = self.state.read(cx).auth_user().cloned();

        // A drag that ended off-list (no drop event) must not strand the
        // sibling slide offsets.
        if self.space_drag.is_some() && !cx.has_active_drag() {
            self.space_drag = None;
        }

        // Collect row data (no element creation — cheap). Element creation is
        // deferred into the virtualized list's visible range so off-screen rows
        // cost nothing during scroll.
        let row_data = if self.activity_open {
            Vec::new()
        } else {
            self.collect_active_row_data(cx)
        };
        // Store on self so the uniform_list closure (which receives &mut Self)
        // can access it without a separate borrow.
        self.sidebar_row_data = row_data.clone();
        // Same data keyed by chat id — the tree's session children look their
        // rows up by id (only expanded spaces' children are in the tree).
        self.sidebar_chat_map = row_data
            .iter()
            .map(|r| (r.chat_id.clone(), r.clone()))
            .collect();

        // Build the flattened tree (Projects mode): space nodes + the session
        // children of expanded spaces. Activity mode keeps its flat grouped
        // feed and builds nothing here.
        let recent = if self.activity_open {
            // Clear the stale tree so a mode switch back to Projects fills
            // fresh (first fill never animates — the resort baseline resets).
            self.sidebar_tree = Vec::new();
            Vec::new()
        } else {
            let now = Utc::now();
            let attention = self.sidebar_space_attention(cx);
            // Spaces device filter: `Some(device_id)` narrows the tree to that
            // device's spaces (the chip row above the tree). `effective_…`
            // clears a filter whose device vanished, so this can't strand an
            // empty tree behind a dead chip.
            let device_filter = self.effective_space_device_filter(cx);
            let (tree, recent) = {
                let state = self.state.read(cx);
                let filtered_spaces: Vec<comet_proto::Space> = state
                    .spaces
                    .iter()
                    .filter(|s| {
                        device_filter
                            .as_deref()
                            .is_none_or(|device_id| s.device_id == device_id)
                    })
                    .cloned()
                    .collect();
                let expanded: std::collections::HashSet<String> = filtered_spaces
                    .iter()
                    .filter(|s| self.space_expanded(&s.id, cx))
                    .map(|s| s.id.clone())
                    .collect();
                let sessions_by_space: std::collections::HashMap<
                    String,
                    Vec<&comet_proto::Chat>,
                > = filtered_spaces
                    .iter()
                    .map(|s| (s.id.clone(), state.chats_in_space(&s.id)))
                    .collect();
                let tree = super::spaces::build_sidebar_tree(
                    &filtered_spaces,
                    &expanded,
                    &sessions_by_space,
                    &attention,
                    &self.settings.space_order,
                    &self.sidebar_space_show_all,
                );
                let recent = super::spaces::recent_sessions(state, now, 3);
                (tree, recent)
            };
            self.sidebar_tree = tree;
            recent
        };

        // Resort glide (§1.6 View Transitions parity): when the ORDER of a live
        // list changes (new activity resort, grouping flip, tree expand/
        // collapse), surviving rows glide from their old y to the new one —
        // layout is already at the new position; the offset is a paint-only
        // relative inset animated to 0 over 260ms cubic-bezier(0.22,1,0.36,1).
        // New rows fade in; removals just go (matching the original). First
        // fill and chat switches (which don't reorder) never animate.
        let order: Vec<(String, f32)> = self
            .sidebar_tree
            .iter()
            .map(|n| {
                (
                    super::spaces::tree_node_key(n),
                    super::nav::CHAT_ROW_HEIGHT,
                )
            })
            .collect();
        if self.sidebar_prev_order != order {
            if !self.sidebar_prev_order.is_empty() {
                let offsets = resort_offsets(&self.sidebar_prev_order, &order, SIDEBAR_LIST_GAP);
                let prev_keys: std::collections::HashSet<&str> = self
                    .sidebar_prev_order
                    .iter()
                    .map(|(k, _)| k.as_str())
                    .collect();
                let new_keys: std::collections::HashSet<String> = order
                    .iter()
                    .filter(|(k, _)| !prev_keys.contains(k.as_str()))
                    .map(|(k, _)| k.clone())
                    .collect();
                if !offsets.is_empty() || !new_keys.is_empty() {
                    self.resort_epoch += 1;
                    self.sidebar_resort = offsets;
                    self.sidebar_new_keys = new_keys;
                }
            }
            self.sidebar_prev_order = order;
        }

        // Overflow edge fades for the lists scroll region — the tab strip's
        // idiom, vertical (offset from the LAST frame; the lag is invisible).
        let (lists_fade_top, lists_fade_bottom) = self.sidebar_fade_zones();
        // Opaque platforms melt overflow into the surface tone with painted
        // gradient overlays. Over GLASS no overlay can work — the backdrop is
        // see-through blur, so tone stacks into a smudge and black reads as a
        // shadow (user reports). Instead the ROWS fade themselves: prepaint-
        // measured bounds drive per-row opacity toward the viewport edges
        // ([`Shell::sidebar_row_alpha`]), dissolving the edge to pure glass.
        let glass = theme.is_glass();
        let sidebar_fade = theme.surface;

        let user_line: SharedString = user
            .as_ref()
            .map(|u| u.name.clone().unwrap_or_else(|| u.email.clone()).into())
            .unwrap_or_else(|| SharedString::from("Not signed in"));
        let user_email: Option<SharedString> = user.as_ref().map(|u| u.email.clone().into());
        let user_menu = self.render_user_menu(user_line.clone(), user_email.clone(), theme, cx);

        let activity_open = self.activity_open;
        let surface_header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(Theme::SPACE_SM))
            .py(px(6.0))
            .child(
                div()
                    .text_size(px(13.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(SharedString::from(if activity_open {
                        "Activity"
                    } else {
                        "Projects"
                    })),
            )
            .child(
                div()
                    .id("sidebar-activity-toggle")
                    .inspect_tag("sidebar-activity-toggle")
                    .size(px(24.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .bg(if activity_open {
                        theme.element_active
                    } else {
                        crate::theme::wash(0.0)
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.activity_open = !this.activity_open;
                        this.sidebar_scroll = gpui::ScrollHandle::new();
                        this.sidebar_chat_scroll = gpui::UniformListScrollHandle::new();
                        cx.notify();
                    }))
                    .child(
                        icon(icons::BELL_MINIMALISTIC)
                            .size(px(15.0))
                            .text_color(theme.text_muted),
                    ),
            );
        let sidebar_scroll_region = if activity_open {
            // Activity mode: keep the original single overflow_y_scroll — the
            // activity feed is typically short (grouped by status) and doesn't
            // need virtualization.
            crate::edge_fade::edge_faded(
                SIDEBAR_GLASS_FADE_BAND,
                glass && lists_fade_top,
                glass && lists_fade_bottom,
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("sidebar-lists")
                            .inspect_tag("sidebar-lists")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.sidebar_scroll)
                            .px(px(Theme::SPACE_SM))
                            .flex()
                            .flex_col()
                            .child(surface_header)
                            .child(self.render_activity_sidebar(theme, cx)),
                    )
                    .when(lists_fade_top && !glass, |el| {
                        el.child(div().absolute().top_0().left_0().right_0().h(px(24.0)).bg(
                            gpui::linear_gradient(
                                180.0,
                                gpui::linear_color_stop(sidebar_fade, 0.0),
                                gpui::linear_color_stop(sidebar_fade.opacity(0.0), 1.0),
                            ),
                        ))
                    })
                    .when(lists_fade_bottom && !glass, |el| {
                        el.child(
                            div()
                                .absolute()
                                .bottom_0()
                                .left_0()
                                .right_0()
                                .h(px(24.0))
                                .bg(gpui::linear_gradient(
                                    0.0,
                                    gpui::linear_color_stop(sidebar_fade, 0.0),
                                    gpui::linear_color_stop(sidebar_fade.opacity(0.0), 1.0),
                                )),
                        )
                    }),
            )
        } else {
            // Projects mode: surface header + RECENT section + SPACES header
            // stay fixed at the top; the flattened tree (space nodes + the
            // session children of expanded spaces) scrolls virtualized via
            // uniform_list so off-screen rows cost zero per frame.
            let tree_count = self.sidebar_tree.len();
            let epoch = self.resort_epoch;
            let resort_map = self.sidebar_resort.clone();
            let new_keys = self.sidebar_new_keys.clone();
            let theme_clone = theme.clone();
            let selected = self.state.read(cx).selected_chat.clone();
            // Scroll the tree to the selected chat once per selection change
            // (a chat picked from the tab strip while its space was collapsed
            // auto-expands — the tree then scrolls it into view).
            if self.sidebar_tree_scrolled_to.as_deref() != selected.as_deref() {
                if let Some(chat_id) = &selected
                    && let Some(ix) = self.sidebar_tree.iter().position(|n| {
                        matches!(
                            n,
                            super::spaces::SidebarTreeNode::Session { chat_id: cid, .. }
                                if cid == chat_id
                        )
                    })
                {
                    self.sidebar_chat_scroll
                        .scroll_to_item(ix, gpui::ScrollStrategy::Nearest);
                }
                self.sidebar_tree_scrolled_to = selected.clone();
            }
            let drag = self
                .space_drag
                .as_ref()
                .map(|d| (d.from, d.over, d.epoch, d.prev_over));
            let chat_list: AnyElement = if tree_count > 0 {
                uniform_list(
                    "sidebar-tree-list",
                    tree_count,
                    cx.processor(move |this: &mut Shell, range: std::ops::Range<usize>, _window, cx| {
                        let theme = theme_clone.clone();
                        let resort_map = resort_map.clone();
                        let new_keys = new_keys.clone();
                        range
                            .map(|ix| {
                                let node = this.sidebar_tree[ix].clone();
                                let key = super::spaces::tree_node_key(&node);
                                let element = this.render_tree_node(&node, drag, &theme, cx);
                                if let Some(dy) = resort_map.get(&key).copied() {
                                    let id =
                                        SharedString::from(format!("resort-{epoch}-{key}"));
                                    div()
                                        .w_full()
                                        .child(element)
                                        .with_animation(
                                            id,
                                            RESORT.animation(),
                                            move |el, t| {
                                                el.relative().top(px(dy * (1.0 - t)))
                                            },
                                        )
                                        .into_any_element()
                                } else if new_keys.contains(&key) {
                                    let id =
                                        SharedString::from(format!("row-in-{epoch}-{key}"));
                                    motion::fade_quick(id, div().w_full().child(element)).into_any_element()
                                } else {
                                    element
                                }
                            })
                            .collect::<Vec<_>>()
                    }),
                )
                .track_scroll(&self.sidebar_chat_scroll)
                .with_sizing_behavior(gpui::ListSizingBehavior::Auto)
                .flex_1()
                .min_h_0()
                // Space drag-reorder: the LIST owns the drop surface (space
                // ordinals are derived from the pointer's position in the
                // flattened tree, scroll applied).
                .on_drag_move::<super::spaces::SpaceDragPayload>(cx.listener(
                    move |this, event: &gpui::DragMoveEvent<super::spaces::SpaceDragPayload>, _, cx| {
                        let from = event.drag(cx).from;
                        let rel_y =
                            f32::from(event.event.position.y) - f32::from(event.bounds.top());
                        let scroll_y = -f32::from(
                            this.sidebar_chat_scroll.0.borrow().base_handle.offset().y,
                        );
                        let over = super::spaces::tree_drop_over(&this.sidebar_tree, rel_y + scroll_y);
                        this.update_space_drag_over(from, over, cx);
                    },
                ))
                .on_drop::<super::spaces::SpaceDragPayload>(cx.listener(
                    move |this, payload: &super::spaces::SpaceDragPayload, _, cx| {
                        let to = this
                            .space_drag
                            .as_ref()
                            .map(|d| d.over)
                            .unwrap_or(payload.from);
                        this.commit_space_reorder(payload.from, to, cx);
                    },
                ))
                .into_any_element()
            } else {
                // Empty tree: the SPACES header above carries the "Add space"
                // ghost row when there are no spaces; otherwise there's always
                // at least one space node. Nothing else to show.
                div().into_any_element()
            };

            let spaces_empty = self.state.read(cx).spaces.is_empty();
            // The chip row: devices that own at least one space (the filter
            // target set — a device with no spaces can't hide anything), plus
            // the currently filtered device if it owns none right now (so its
            // chip stays visible and can be cleared).
            let filter_devices = {
                let filter = self.effective_space_device_filter(cx);
                let state = self.state.read(cx);
                let owned: std::collections::HashSet<&str> = state
                    .spaces
                    .iter()
                    .map(|s| s.device_id.as_str())
                    .collect();
                let local = state.local_device_id.clone();
                let mut devices = crate::settings::devices::devices_for_display(
                    state.devices.clone(),
                    local.as_deref(),
                );
                // The filtered device always gets a chip (so its filter can
                // be cleared), even when display merging collapsed its
                // registry row into a same-name representative.
                if let Some(filter) = &filter
                    && !devices.iter().any(|d| d.id == *filter)
                    && let Some(raw) = state.devices.iter().find(|d| d.id == *filter)
                {
                    devices.push(raw.clone());
                }
                devices
                    .into_iter()
                    .filter(|d| {
                        owned.contains(d.id.as_str())
                            || filter.as_deref() == Some(d.id.as_str())
                    })
                    .collect::<Vec<_>>()
            };
            let spaces_section =
                self.render_spaces_section(theme, cx, spaces_empty, filter_devices);
            let recent_section = self.render_recent_section(&recent, theme, cx);

            crate::edge_fade::edge_faded(
                SIDEBAR_GLASS_FADE_BAND,
                glass && lists_fade_top,
                glass && lists_fade_bottom,
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .px(px(Theme::SPACE_SM))
                    .child(surface_header)
                    .child(recent_section)
                    .child(spaces_section)
                    .child(chat_list)
                    .when(lists_fade_top && !glass, |el| {
                        el.child(div().absolute().top_0().left_0().right_0().h(px(24.0)).bg(
                            gpui::linear_gradient(
                                180.0,
                                gpui::linear_color_stop(sidebar_fade, 0.0),
                                gpui::linear_color_stop(sidebar_fade.opacity(0.0), 1.0),
                            ),
                        ))
                    })
                    .when(lists_fade_bottom && !glass, |el| {
                        el.child(
                            div()
                                .absolute()
                                .bottom_0()
                                .left_0()
                                .right_0()
                                .h(px(24.0))
                                .bg(gpui::linear_gradient(
                                    0.0,
                                    gpui::linear_color_stop(sidebar_fade, 0.0),
                                    gpui::linear_color_stop(sidebar_fade.opacity(0.0), 1.0),
                                )),
                        )
                    }),
            )
        };

        div()
            .w(px(self.settings.sidebar_width))
            .h_full()
            .flex()
            .flex_col()
            .child(sidebar_scroll_region)
            // Update strip (above the user menu; below the lists).
            .when_some(self.render_update_strip(theme, cx), |el, strip| {
                el.child(strip)
            })
            // Inline mutation-failure notice.
            .when_some(self.sidebar_notice.clone(), |el, notice| {
                el.child(
                    div()
                        .id("sidebar-notice")
                        .inspect_tag("sidebar-notice")
                        .mx(px(Theme::SPACE_SM))
                        .mb(px(Theme::SPACE_SM))
                        .px(px(Theme::SPACE_SM))
                        .py(px(4.0))
                        .rounded(px(Theme::CONTROL_RADIUS))
                        .border_1()
                        .border_color(theme.danger)
                        .text_size(px(11.0))
                        .text_color(theme.danger)
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.sidebar_notice = None;
                            cx.notify();
                        }))
                        .child(notice),
                )
            })
            .child(div().p(px(Theme::SPACE_SM)).flex_none().child(user_menu))
            .into_any_element()
    }

    /// Update strip: shown above the user menu whenever the engine's
    /// UpdateStatus stream reports a newer release. On a macOS bundle install
    /// it drives the whole flow — click to download, then click to restart into
    /// the staged bundle. Elsewhere (managed/source installs) it is advisory
    /// (`comet update`); click dismisses it for that version.
    pub(super) fn render_update_strip(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let status = self.state.read(cx).update.clone()?;
        if !status.update_available {
            return None;
        }
        let latest = status.latest_version.clone()?;
        if self.update_dismissed.as_deref() == Some(latest.as_str()) {
            return None;
        }
        let mac_app = matches!(self.install, comet_update::InstallKind::MacApp { .. });

        let (label, clickable): (SharedString, bool) = if mac_app {
            match &self.update_flow {
                UpdateFlow::Idle => (format!("Update available — v{latest}").into(), true),
                UpdateFlow::Downloading => (format!("Downloading v{latest}…").into(), false),
                UpdateFlow::Ready(_) => ("Update ready — restart to apply".into(), true),
                UpdateFlow::Failed(message) => (format!("Update failed: {message}").into(), true),
            }
        } else {
            (
                format!("Update available — v{latest} · run `comet update`").into(),
                true,
            )
        };
        let failed = matches!(self.update_flow, UpdateFlow::Failed(_));
        let tone = if failed { theme.danger } else { theme.accent };
        // The chip fill is the sidebar's WHITE wash language, not an accent
        // tint: an indigo fill over the glass composited into a dark slab that
        // blocked the blur (user report) — the accent lives in the icon/text.
        let (chip_bg, chip_bg_hover) = if failed {
            (theme.danger.opacity(0.14), theme.danger.opacity(0.22))
        } else {
            (crate::theme::wash(0.11), crate::theme::wash(0.16))
        };

        let mut strip = div()
            .id("update-strip")
            .inspect_tag("update-strip")
            .mx(px(Theme::SPACE_SM))
            // No bottom margin: the user-menu block below carries its own
            // SPACE_SM padding — doubling it read as a hole (user report).
            .px(px(Theme::SPACE_SM))
            .py(px(6.0))
            .rounded(px(Theme::CONTROL_RADIUS))
            .bg(chip_bg)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .text_size(px(11.0))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(tone)
            .child(
                icon(if failed {
                    icons::DANGER_TRIANGLE
                } else {
                    icons::RESTART
                })
                .size(px(14.0))
                .text_color(tone),
            )
            .child(div().flex_1().min_w_0().child(label));
        if clickable {
            strip = strip
                .cursor_pointer()
                .hover(move |s| s.bg(chip_bg_hover))
                .on_click(cx.listener(move |this, _, _, cx| this.on_update_strip_click(cx)));
        }
        Some(strip.into_any_element())
    }

    /// Idle → download; Ready → swap + relaunch; Failed → retry; advisory
    /// installs → dismiss for this version.
    pub(super) fn on_update_strip_click(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.install, comet_update::InstallKind::MacApp { .. }) {
            self.update_dismissed = self
                .state
                .read(cx)
                .update
                .as_ref()
                .and_then(|s| s.latest_version.clone());
            cx.notify();
            return;
        }
        match std::mem::replace(&mut self.update_flow, UpdateFlow::Idle) {
            UpdateFlow::Idle | UpdateFlow::Failed(_) => self.begin_update_download(cx),
            UpdateFlow::Downloading => self.update_flow = UpdateFlow::Downloading,
            UpdateFlow::Ready(staged) => self.apply_staged_update(staged, cx),
        }
    }

    /// Fetch the manifest and stage the new `Comet.app` under the data dir
    /// (tokio — reqwest); the strip flips to "restart to apply" when done.
    pub(super) fn begin_update_download(&mut self, cx: &mut Context<Self>) {
        let edge_url = self.boot.edge_url.clone();
        let data_dir = self.data_dir.clone();
        self.update_flow = UpdateFlow::Downloading;
        let download = Tokio::spawn(cx, async move {
            let manifest = comet_update::fetch_latest(&edge_url).await?;
            comet_update::stage_mac_app(&edge_url, &manifest, &data_dir).await
        });
        self.update_task = Some(cx.spawn(async move |this, cx| {
            let outcome = match download.await {
                Ok(Ok(staged)) => Ok(staged),
                Ok(Err(err)) => Err(format!("{err:#}")),
                Err(join_err) => Err(join_err.to_string()),
            };
            this.update(cx, |shell, cx| {
                shell.update_flow = match outcome {
                    Ok(staged) => UpdateFlow::Ready(staged),
                    Err(message) => {
                        tracing::warn!(%message, "update download failed");
                        UpdateFlow::Failed(message.into())
                    }
                };
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Swap the staged bundle over the installed one, arm the detached
    /// relauncher, and quit — the relauncher `open`s the new bundle once this
    /// process (and its engine lock / IPC port) is gone.
    pub(super) fn apply_staged_update(&mut self, staged: PathBuf, cx: &mut Context<Self>) {
        let comet_update::InstallKind::MacApp { bundle } = self.install.clone() else {
            return;
        };
        match comet_update::apply_mac_app(&staged, &bundle) {
            Ok(()) => {
                comet_update::relaunch_app_after_exit(&bundle);
                cx.quit();
            }
            Err(err) => {
                tracing::error!(error = %err, "update apply failed");
                self.update_flow = UpdateFlow::Failed(format!("{err:#}").into());
                cx.notify();
            }
        }
    }

    /// UserMenu (§1.6): name/email trigger row; menu with plan badge, Open
    /// settings, Sign out.
    pub(super) fn render_user_menu(
        &mut self,
        user_line: SharedString,
        user_email: Option<SharedString>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let open = self.user_menu_open;
        // Bottom-of-sidebar identity (comet user-menu.tsx): avatar circle +
        // name with the plan label underneath, Alpha badge chip on the right.
        let initial: SharedString = user_line
            .chars()
            .next()
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_else(|| "?".into())
            .into();
        let user_menu_inspect = crate::dev_inspector::inspect_meta("user-menu");
        let user_menu_hover_tag = user_menu_inspect.clone();
        let mut trigger = div()
            .id("user-menu")
            .flex_none()
            .rounded(px(8.0))
            .px(px(Theme::SPACE_SM))
            .py(px(Theme::SPACE_SM))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .cursor_pointer()
            // user-menu.tsx trigger: hover `bg-white/[0.04]`, open state
            // (`data-[state=open]`) the slightly stronger `bg-white/[0.06]`;
            // the hover wash fades over `transition-colors`.
            .bg(if open {
                theme.glass_hover()
            } else {
                motion::hover_blend(
                    "user-menu-trigger",
                    theme.glass_hover().opacity(0.0),
                    theme.glass_hover().opacity(0.8),
                )
            })
            .on_hover(move |hovered: &bool, window: &mut gpui::Window, cx: &mut gpui::App| {
                motion::hover_listener("user-menu-trigger")(&hovered, window, cx);
                crate::dev_inspector::report_hover(&user_menu_hover_tag, *hovered, window, cx);
            })
            .inspect_click(user_menu_inspect)
            .on_click(cx.listener(|this, _, _, cx| {
                // A click that just dismissed the menu (outside-click on the
                // trigger) must not instantly reopen it.
                let just_dismissed = this
                    .user_menu_dismissed_at
                    .is_some_and(|at| at.elapsed() < Duration::from_millis(400));
                this.user_menu_open = !this.user_menu_open && !just_dismissed;
                this.user_menu_dismissed_at = None;
                cx.notify();
            }))
            .child(
                // Avatar: white circle, initial in near-black (comet user-menu.tsx).
                div()
                    .size(px(28.0))
                    .flex_none()
                    .rounded_full()
                    .bg(theme.text)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(12.0))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(theme.bg)
                    .child(initial),
            )
            .child(
                // Name with the plan label underneath — no chip on the right.
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(13.0))
                            .line_height(px(17.0))
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .truncate()
                            .child(user_line.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .line_height(px(15.0))
                            .text_color(theme.text_muted)
                            .child(SharedString::from("Alpha")),
                    ),
            );
        if open {
            // user-menu.tsx content: `w-[--radix-dropdown-menu-trigger-width]`
            // (exactly as wide as the trigger row — sidebar minus its p-2
            // gutters), `flex-col gap-0.5`, then: one small muted email line
            // (`px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground/70`),
            // "Settings", separator, "Sign out". Both rows are plain
            // `menuItem`s with muted 16px icons — sign-out carries NO
            // destructive tone in the original.
            let menu = popover::popover_card(theme)
                .w(px(self.settings.sidebar_width - 2.0 * Theme::SPACE_SM))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.user_menu_open = false;
                    this.user_menu_dismissed_at = Some(std::time::Instant::now());
                    cx.notify();
                }))
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .px(px(8.0))
                        .pt(px(6.0))
                        .pb(px(4.0))
                        .text_size(px(11.0))
                        .text_color(theme.text_muted.opacity(0.7))
                        .truncate()
                        .child(user_email.unwrap_or(user_line)),
                )
                .child(
                    popover::menu_row(theme, false, "user-menu-settings")
                        .id("user-menu-settings")
                        .inspect_click(dev_inspector::inspect_meta("user-menu-settings"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.open_settings(SettingsSection::Devices, cx)
                        }))
                        .child(
                            icon(icons::SETTINGS_MINIMALISTIC)
                                .size(px(16.0))
                                .text_color(theme.text_muted),
                        )
                        .child(SharedString::from("Settings")),
                )
                .child(popover::menu_separator())
                .child(
                    popover::menu_row(theme, false, "user-menu-signout")
                        .id("user-menu-signout")
                        .inspect_click(dev_inspector::inspect_meta("user-menu-signout"))
                        .on_click(cx.listener(|this, _, _, cx| this.sign_out(cx)))
                        .child(
                            icon(icons::LOGOUT_2)
                                .size(px(16.0))
                                .text_color(theme.text_muted),
                        )
                        .child(SharedString::from("Sign out")),
                )
                .into_any_element();
            trigger = trigger.child(popover::anchored_menu_above("user-menu-popover", menu));
        }
        trigger.into_any_element()
    }

    /// The RECENT section: up to 3 cross-space sessions by recency, pinned
    /// above the Spaces tree so global discovery survives the tree. Hidden
    /// until there are at least 3 sessions total (the tree already shows
    /// everything when the list is that short).
    pub(super) fn render_recent_section(
        &mut self,
        recent: &[super::spaces::RecentRow],
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if recent.len() < 3 {
            return div().into_any_element();
        }
        let mut column = div()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(
                div()
                    .px(px(Theme::SPACE_SM))
                    .pt(px(8.0))
                    .pb(px(4.0))
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.text_muted.opacity(0.6))
                    .child(SharedString::from("Recent")),
            );
        for row in recent {
            let selected = self.state.read(cx).selected_chat.as_deref() == Some(row.chat_id.as_str());
            column = column.child(self.render_recent_row(row, selected, theme, cx));
        }
        column.into_any_element()
    }

    /// One RECENT row: status dot + title + relative time on a single line —
    /// no folder (its space is the tree context below) and no harness/branch
    /// (compact). Click selects the chat and expands its space.
    fn render_recent_row(
        &self,
        row: &super::spaces::RecentRow,
        selected: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let dot_color = super::spaces::status_dot_color(row.status, theme);
        let select_id = row.chat_id.clone();
        let space_id = row.space_id.clone();
        let (hover, text) = (theme.glass_hover(), theme.text);
        let selected_wash = crate::theme::glass_selected_bg();
        let subline = theme.text_muted.opacity(0.5);
        let rest_bg = if selected {
            selected_wash
        } else {
            crate::theme::wash(0.0)
        };
        let hover_bg = if selected { selected_wash } else { hover };
        let rest_text = if selected { text } else { text.opacity(0.8) };
        let fade_key = format!("recent-row-{}", row.chat_id);
        div()
            .id(SharedString::from(format!("recent-{}", row.chat_id)))
            .w_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(Theme::SPACE_SM))
            .rounded(px(8.0))
            .px(px(Theme::SPACE_SM))
            .py(px(4.0))
            .text_color(motion::hover_blend(&fade_key, rest_text, text))
            .bg(motion::hover_blend(&fade_key, rest_bg, hover_bg))
            .when(selected, |el| {
                el.shadow(crate::theme::glass_selected_shadows())
            })
            .on_hover(move |hovered: &bool, window: &mut Window, cx: &mut App| {
                motion::hover_listener(&fade_key)(&hovered, window, cx);
            })
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.state.update(cx, |s, cx| s.select_chat(Some(select_id.clone()), cx));
                if let Some(space_id) = &space_id {
                    this.sidebar_expanded_spaces.insert(space_id.clone());
                }
                cx.notify();
            }))
            .child(
                div()
                    .size(px(6.0))
                    .rounded_full()
                    .flex_none()
                    .bg(dot_color),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.0))
                    .line_height(px(15.0))
                    .child(row.title.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(10.0))
                    .text_color(subline)
                    .child(row.time_ago.clone()),
            )
            .into_any_element()
    }

}
