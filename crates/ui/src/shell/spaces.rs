//! Spaces sidebar: the sidebar tree (spaces as collapsible parents, their
//! sessions as children), the RECENT section, and the add-space palette
//! (⌘K-style: device tabs + filtered folder browser).
//!
//! A space = a synced (device, folder) pair; the sidebar's job is switching
//! between them and surfacing which sessions want attention. Child module of
//! `shell` so it renders straight off `Shell`'s private state.

use super::*;
use crate::dev_inspector::InspectClickExt as _;
use crate::motion::TAB_SLIDE;
use crate::pickers::{breadcrumbs, browser_rows, is_absolute_path, parent_path};
use crate::terminal::panel::{reorder_tabs, slide_offset};
use comet_proto::{
    ApplyHarnessResult, Chat, ChatIndicator, Device, FolderListing, ProjectHarness, Space,
};
use gpui::FocusHandle;

/// Drag-reorder state for the spaces list; `epoch` keys the 150ms slide
/// animation restarts (the session-tab idiom, vertical). Indices are SPACE
/// ordinals within the flattened tree, not flat node indices.
pub(super) struct SpaceDragState {
    pub(super) from: usize,
    pub(super) over: usize,
    pub(super) epoch: usize,
    pub(super) prev_over: usize,
}

/// The dragged-row payload (gpui drag-and-drop). `from` is the SPACE ordinal
/// within the flattened tree.
pub(crate) struct SpaceDragPayload {
    pub(super) from: usize,
    pub(super) name: SharedString,
}

/// Pre-render data for one session row: everything `render_chat_row` needs
/// except the theme. Collected once for the whole sidebar each frame; element
/// creation is deferred to the virtualized list's visible range so off-screen
/// rows pay zero cost.
#[derive(Clone)]
pub(crate) struct ActiveRowData {
    pub(super) chat_id: String,
    pub(super) title: SharedString,
    pub(super) time_ago: SharedString,
    pub(super) branch: Option<SharedString>,
    pub(super) harness: Option<comet_proto::HarnessId>,
    pub(super) acp_agent_id: Option<String>,
    pub(super) status: ChatIndicator,
}

// ---------------------------------------------------------------------------
// Sidebar tree (Projects mode): spaces as expandable parents, their sessions
// as children, flattened into one virtualized list (sidebar-tree plan §3.1).
//
// A space always appears (collapsed or expanded); an expanded space's
// sessions follow it as child rows; a collapsed space contributes no children;
// an empty space contributes no children either (no "no sessions" filler).
// The flat order is the render order of the uniform_list.
// ---------------------------------------------------------------------------

/// Session children shown under an expanded space before the "View more"
/// disclosure kicks in (the rest stay hidden behind a toggle row).
pub(crate) const MAX_TREE_SESSIONS: usize = 5;

/// One row of the flattened sidebar tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SidebarTreeNode {
    /// Space header row.
    Space {
        /// 0-based space ordinal (drag payloads + drop-slot math).
        ordinal: usize,
        space_id: String,
        expanded: bool,
        /// Visible session count (children of this node when expanded).
        child_count: usize,
        /// Aggregate attention dot (most urgent live member wins).
        attention: Option<ChatIndicator>,
    },
    /// Session child row — only present when its space is expanded.
    Session {
        space_id: String,
        chat_id: String,
        /// Index within the space (tab order), for future per-space ordering.
        in_space_ix: usize,
    },
    /// "View more (N) / Hide more" disclosure row under an expanded space
    /// with more sessions than [`MAX_TREE_SESSIONS`]. `shown` is the visible
    /// child count (== `total` when show-all is on, which renders "Hide more").
    ShowMore {
        space_id: String,
        shown: usize,
        total: usize,
    },
}

/// FLIP key of a tree node: `s:{space_id}` / `c:{chat_id}` / `m:{space_id}` —
/// stable across rebuilds so surviving rows glide (never re-fade) on resort.
pub(crate) fn tree_node_key(node: &SidebarTreeNode) -> String {
    match node {
        SidebarTreeNode::Space { space_id, .. } => format!("s:{space_id}"),
        SidebarTreeNode::Session { chat_id, .. } => format!("c:{chat_id}"),
        SidebarTreeNode::ShowMore { space_id, .. } => format!("m:{space_id}"),
    }
}

/// Build the flattened tree from ordered spaces + per-space sessions.
///
/// Pure — unit-tested (`spaces::tests::tree_*`). `space_order` is the manual
/// drag order (device-local); missing spaces are skipped, new spaces append in
/// creation order (same resolution as the session tabs). `show_all` holds the
/// space ids the user expanded past the [`MAX_TREE_SESSIONS`] cap; capped
/// spaces append a [`SidebarTreeNode::ShowMore`] disclosure row.
pub(crate) fn build_sidebar_tree(
    spaces: &[Space],
    expanded: &std::collections::HashSet<String>,
    sessions_by_space: &std::collections::HashMap<String, Vec<&Chat>>,
    attention: &std::collections::HashMap<String, ChatIndicator>,
    space_order: &[String],
    show_all: &std::collections::HashSet<String>,
) -> Vec<SidebarTreeNode> {
    let created: Vec<String> = spaces.iter().map(|s| s.id.clone()).collect();
    let order = super::tabs::resolve_tab_order(&created, space_order);
    let mut by_id: std::collections::HashMap<&str, &Space> =
        spaces.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut tree = Vec::new();
    for (ordinal, space_id) in order.into_iter().enumerate() {
        let Some(space) = by_id.remove(space_id.as_str()) else {
            continue;
        };
        let children = sessions_by_space
            .get(&space.id)
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        let total = children.len();
        let is_expanded = expanded.contains(&space.id);
        let shown = if show_all.contains(&space.id) {
            total
        } else {
            total.min(MAX_TREE_SESSIONS)
        };
        tree.push(SidebarTreeNode::Space {
            ordinal,
            space_id: space.id.clone(),
            expanded: is_expanded,
            child_count: shown,
            attention: attention.get(&space.id).copied(),
        });
        if is_expanded {
            for (in_space_ix, chat) in children.iter().take(shown).enumerate() {
                tree.push(SidebarTreeNode::Session {
                    space_id: space.id.clone(),
                    chat_id: chat.id.clone(),
                    in_space_ix,
                });
            }
            if total > MAX_TREE_SESSIONS {
                tree.push(SidebarTreeNode::ShowMore {
                    space_id: space.id.clone(),
                    shown,
                    total,
                });
            }
        }
    }
    tree
}

/// Which space row a drag hovering at `content_y` (inside the tree's content,
/// scroll already applied) would land on: the ordinal of the space node whose
/// uniform slot contains the pointer; a pointer over a space's session
/// children counts as its parent. Clamped to the last space ordinal.
pub(crate) fn tree_drop_over(tree: &[SidebarTreeNode], content_y: f32) -> usize {
    let total = tree
        .iter()
        .filter(|n| matches!(n, SidebarTreeNode::Space { .. }))
        .count();
    if total == 0 {
        return 0;
    }
    let node_ix = (content_y / super::nav::CHAT_ROW_HEIGHT)
        .floor()
        .max(0.0) as usize;
    let mut spaces_seen = 0usize;
    for node in tree.iter().take(node_ix.saturating_add(1)) {
        if matches!(node, SidebarTreeNode::Space { .. }) {
            spaces_seen += 1;
        }
    }
    spaces_seen.saturating_sub(1).min(total - 1)
}

/// One RECENT-section row (owned — the renderer needs it after the state
/// borrow ends, so chats are reduced to the few fields the row shows).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecentRow {
    pub chat_id: String,
    pub space_id: Option<String>,
    pub title: SharedString,
    pub time_ago: SharedString,
    pub status: ChatIndicator,
}

/// The 3 most recent sessions across all live spaces, pure recency order
/// (the RECENT section — global discovery above the tree).
pub(crate) fn recent_sessions(
    state: &crate::state::AppState,
    now: chrono::DateTime<chrono::Utc>,
    limit: usize,
) -> Vec<RecentRow> {
    let mut rows: Vec<(ChatIndicator, &Chat)> = state
        .visible_chats()
        .filter(|c| {
            c.space_id
                .as_deref()
                .is_some_and(|id| state.space_row(id).is_some())
        })
        .map(|c| (state.display_status_for(c, now), c))
        .collect();
    rows.sort_by(|(_, a), (_, b)| {
        b.last_message_at
            .or(Some(b.created_at))
            .cmp(&a.last_message_at.or(Some(a.created_at)))
    });
    rows.truncate(limit);
    rows.into_iter()
        .map(|(status, chat)| RecentRow {
            chat_id: chat.id.clone(),
            space_id: chat.space_id.clone(),
            title: transcript::single_line(
                &chat.title.clone().unwrap_or_else(|| "New session".into()),
            )
            .into(),
            time_ago: format_time_ago(chat.last_message_at.unwrap_or(chat.created_at), now).into(),
            status,
        })
        .collect()
}

/// The floating row rendered at the cursor while dragging.
struct SpaceGhost {
    pub(super) name: SharedString,
}

impl Render for SpaceGhost {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx);
        div()
            .w(px(200.0))
            .h(px(29.0))
            .px(px(Theme::SPACE_SM))
            .flex()
            .items_center()
            .gap(px(Theme::SPACE_SM))
            .rounded(px(8.0))
            .bg(theme.surface_raised)
            .border_1()
            .border_color(theme.border_strong)
            .text_size(px(13.0))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(theme.text)
            .opacity(0.85)
            .child(
                icon(icons::FOLDER)
                    .size(px(16.0))
                    .flex_none()
                    .text_color(theme.text_muted),
            )
            .child(div().truncate().child(self.name.clone()))
    }
}

/// The add-space palette (a command-K surface, summoned by ⌘K): search bar
/// across the top, folder browser on the left, a Devices rail on the right,
/// kbd-hint footer. One surface — picking a device in the rail rebrowses in
/// place, no step wizard.
pub(super) struct AddSpaceFlow {
    /// The device currently browsed (the highlighted rail row).
    pub(super) device: Option<Device>,
    /// Filter input; Enter descends into the highlighted folder.
    pub(super) search: Entity<ComposerInput>,
    pub(super) browser: Loadable<FolderListing>,
    /// Requested browser path (`None` = the device's default, i.e. home).
    pub(super) browser_path: Option<String>,
    /// The device's home (the path a `None` browse resolved to) — breadcrumbs
    /// fold everything up to here into the device-name crumb.
    pub(super) home: Option<String>,
    /// Best-effort git seed for the CURRENT browser path (known when we
    /// descended through an entry whose `is_repo` we saw; the owning device's
    /// SpacesSync re-verifies either way).
    pub(super) browser_repo: bool,
    /// Keyboard highlight within the FILTERED folder rows.
    pub(super) active: usize,
    pub(super) submit_busy: bool,
    pub(super) error: Option<SharedString>,
    /// Tracked on the card (`track_focus`) — puts the card on the keyboard
    /// dispatch path so ↑↓/⌫/esc reach `add_space_key` while the search input
    /// holds focus (the structure every working picker uses).
    pub(super) focus: FocusHandle,
    /// Folder-list scroll — keyboard navigation keeps the highlighted row in
    /// view (`scroll_to_item`).
    pub(super) list_scroll: gpui::ScrollHandle,
    /// Reject late responses from a previous path while the user is typing.
    pub(super) load_generation: u64,
    pub(super) focus_pending: bool,
    pub(super) load_task: Option<Task<()>>,
    pub(super) submit_task: Option<Task<()>>,
    pub(super) _search_events: Subscription,
}

/// The space-row Rename dialog (same shape as [`RenameChatDialog`]).
pub(super) struct RenameSpaceDialog {
    pub space_id: String,
    pub input: Entity<ComposerInput>,
    pub focus_pending: bool,
    pub _events: Subscription,
}

pub(super) struct ProjectHarnessFlow {
    pub(super) space_id: String,
    pub(super) project: String,
    pub(super) cwd: String,
    pub(super) device_id: String,
    pub(super) status: Loadable<ProjectHarness>,
    pub(super) busy_id: Option<String>,
    pub(super) flash: Option<SharedString>,
    pub(super) error: Option<SharedString>,
    pub(super) task: Option<Task<()>>,
}

/// Dot color for a chat's display status (tab dots + Sessions rows).
pub(super) fn status_dot_color(status: ChatIndicator, theme: &Theme) -> gpui::Hsla {
    match status {
        // Pink, not amber — the harsh yellow read as a warning; running is
        // routine (user request).
        ChatIndicator::Working => {
            theme.busy.opacity(0.85) // pink-400
        }
        // Blue: "asking you a question" must read differently from "busy
        // working" at a glance.
        ChatIndicator::AwaitingInput => theme.accent.opacity(0.9),
        ChatIndicator::Errored => theme.danger,
        // Green: finished-but-unseen reads as "ready for you".
        ChatIndicator::Completed => {
            theme.success.opacity(0.9) // emerald-400
        }
        ChatIndicator::Idle => crate::theme::ink(0.14),
    }
}

impl Shell {
    // ---- space switching ----

    /// Land in a space: remembered tab if alive, else the most recent chat in
    /// the space, else the new-session canvas. Persists `last_space_id`.
    pub(super) fn activate_space(&mut self, space_id: String, cx: &mut Context<Self>) {
        self.route = Route::Chat;
        self.state.update(cx, |s, cx| {
            s.select_space(Some(space_id.clone()), cx);
        });
        let target = {
            let state = self.state.read(cx);
            let in_space = |id: &str| {
                state
                    .visible_chats()
                    .any(|c| c.id == id && c.space_id.as_deref() == Some(space_id.as_str()))
            };
            self.space_last_chat
                .get(&space_id)
                .filter(|id| in_space(id))
                .cloned()
                .or_else(|| {
                    // `visible_chats` is recency-sorted — first match is the
                    // most recent chat of the space.
                    state
                        .visible_chats()
                        .find(|c| c.space_id.as_deref() == Some(space_id.as_str()))
                        .map(|c| c.id.clone())
                })
        };
        self.state.update(cx, |s, cx| s.select_chat(target, cx));
        self.settings.last_space_id = Some(space_id);
        self.schedule_save(cx);
        // The space you land in shows its sessions — auto-expand.
        self.ensure_active_space_expanded(cx);
        cx.notify();
    }

    // ---- sidebar sections ----

    /// The "Spaces" section header: tracked label + add button, plus the
    /// empty-state ghost row. The space ROWS themselves live in the
    /// virtualized sidebar tree (`build_sidebar_tree` + `render_tree_space_row`),
    /// so the whole tree scrolls as one list.
    pub(super) fn render_spaces_section(
        &mut self,
        theme: &Theme,
        cx: &mut Context<Self>,
        spaces_empty: bool,
    ) -> AnyElement {
        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(Theme::SPACE_SM))
            .pt(px(8.0))
            .pb(px(4.0))
            .child(
                div()
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.text_muted.opacity(0.6))
                    .child(SharedString::from("Spaces")),
            )
            .child({
                let add_space_inspect = crate::dev_inspector::inspect_meta("add-space-button");
                let add_space_hover = add_space_inspect.clone();
                div()
                    .id("add-space")
                    .size(px(20.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.0))
                    .cursor_pointer()
                    .bg(motion::hover_blend(
                        "add-space",
                        crate::theme::wash(0.0),
                        crate::theme::wash(0.14),
                    ))
                    .on_hover(move |hovered: &bool, window: &mut Window, cx: &mut App| {
                        motion::hover_listener("add-space")(&hovered, window, cx);
                        crate::dev_inspector::report_hover(&add_space_hover, *hovered, window, cx);
                    })
                    .inspect_click(add_space_inspect)
                    .on_click(cx.listener(|this, _, _, cx| this.open_add_space(cx)))
                    .child(
                        icon(icons::PLUS)
                            .size(px(14.0))
                            .text_color(theme.text_muted.opacity(0.7)),
                    )
            });

        let mut column = div().flex().flex_col().child(header);
        if spaces_empty {
            // Ghost row: the empty-state affordance mirrors a space row.
            column = column.child(
                div()
                    .id("add-space-ghost")
                    .mx(px(0.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(Theme::SPACE_SM))
                    .rounded(px(8.0))
                    .px(px(Theme::SPACE_SM))
                    .py(px(6.0))
                    .text_size(px(13.0))
                    .text_color(motion::hover_blend(
                        "add-space-ghost",
                        theme.text_muted,
                        theme.text,
                    ))
                    .bg(motion::hover_blend(
                        "add-space-ghost",
                        theme.glass_hover().opacity(0.0),
                        theme.glass_hover(),
                    ))
                    .on_hover(motion::hover_listener("add-space-ghost"))
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| this.open_add_space(cx)))
                    .child(
                        icon(icons::FOLDER)
                            .size(px(16.0))
                            .text_color(theme.text_muted),
                    )
                    .child(SharedString::from("Add space")),
            );
        }
        column.into_any_element()
    }

    /// Aggregate attention dot per space (most urgent live member wins) — the
    /// signal survives on collapsed space rows so a busy session is never
    /// hidden behind a chevron.
    pub(super) fn sidebar_space_attention(&self, cx: &Context<Self>) -> std::collections::HashMap<String, ChatIndicator> {
        let now = Utc::now();
        let state = self.state.read(cx);
        let mut attention: std::collections::HashMap<String, ChatIndicator> =
            std::collections::HashMap::new();
        for chat in state.visible_chats() {
            let status = state.display_status_for(chat, now);
            if !matches!(
                status,
                ChatIndicator::Working | ChatIndicator::AwaitingInput
            ) {
                continue;
            }
            let Some(space_id) = chat.space_id.clone() else {
                continue;
            };
            attention
                .entry(space_id)
                .and_modify(|held| {
                    if crate::state::attention_rank(status)
                        < crate::state::attention_rank(*held)
                    {
                        *held = status;
                    }
                })
                .or_insert(status);
        }
        attention
    }

    // ---- sidebar tree expand/collapse ----

    /// Effective expanded state of a space row: the ACTIVE space is always
    /// expanded (auto-expand override — the user is working there), a space
    /// manually expanded this session is expanded, and everything else follows
    /// the persisted collapse choice (default: expanded).
    pub(super) fn space_expanded(&self, space_id: &str, cx: &Context<Self>) -> bool {
        if self.state.read(cx).selected_space.as_deref() == Some(space_id) {
            return true;
        }
        if self.sidebar_expanded_spaces.contains(space_id) {
            return true;
        }
        !self.settings.sidebar_collapsed_spaces.contains(space_id)
    }

    /// Toggle a space's expand/collapse. Collapsing stashes the current list
    /// scroll offset (restored on expand); both directions persist the manual
    /// choice. The ACTIVE space never visibly collapses — the auto-expand
    /// override keeps it open, so toggling it is a no-op.
    pub(super) fn toggle_space_expand(&mut self, space_id: &str, cx: &mut Context<Self>) {
        let is_active = self
            .state
            .read(cx)
            .selected_space
            .as_deref()
            == Some(space_id);
        if self.space_expanded(space_id, cx) && !is_active {
            // Collapse: record the choice + stash the view.
            self.sidebar_expanded_spaces.remove(space_id);
            self.settings
                .sidebar_collapsed_spaces
                .insert(space_id.to_string());
            let offset = f32::from(self.sidebar_chat_scroll.0.borrow().base_handle.offset().y);
            self.sidebar_space_scroll.insert(space_id.to_string(), offset);
        } else {
            // Expand: clear the persisted collapse + restore the pre-collapse
            // view (a saved offset from an earlier collapse of the same space).
            self.sidebar_expanded_spaces.insert(space_id.to_string());
            self.settings.sidebar_collapsed_spaces.remove(space_id);
            if let Some(saved) = self.sidebar_space_scroll.get(space_id).copied() {
                self.sidebar_chat_scroll
                    .0
                    .borrow_mut()
                    .base_handle
                    .set_offset(gpui::point(px(0.0), px(saved)));
            }
        }
        self.schedule_save(cx);
        cx.notify();
    }

    /// Auto-expand the active space (called on every state change — selecting
    /// a chat implies its space, so this covers boot, space switches, and
    /// chat picks from the tab strip alike). Idempotent.
    pub(super) fn ensure_active_space_expanded(&mut self, cx: &Context<Self>) {
        if let Some(space_id) = self.state.read(cx).selected_space.clone() {
            self.sidebar_expanded_spaces.insert(space_id);
        }
    }

    /// Track the drop slot while a space row is dragged over the tree (150ms
    /// sibling slides restart per committed `over` change). `from`/`over` are
    /// space ordinals.
    pub(super) fn update_space_drag_over(&mut self, from: usize, over: usize, cx: &mut Context<Self>) {
        match &mut self.space_drag {
            Some(drag) if drag.from == from => {
                if drag.over != over {
                    drag.prev_over = drag.over;
                    drag.over = over;
                    drag.epoch += 1;
                    cx.notify();
                }
            }
            _ => {
                self.space_drag = Some(SpaceDragState {
                    from,
                    over,
                    epoch: 0,
                    prev_over: from,
                });
                cx.notify();
            }
        }
    }

    /// Commit a drag: persist the new visual order (device-local).
    pub(super) fn commit_space_reorder(&mut self, from: usize, to: usize, cx: &mut Context<Self>) {
        let created: Vec<String> = self
            .state
            .read(cx)
            .spaces
            .iter()
            .map(|s| s.id.clone())
            .collect();
        let mut order = super::tabs::resolve_tab_order(&created, &self.settings.space_order);
        if from < order.len() {
            reorder_tabs(&mut order, from, to);
            self.settings.space_order = order;
            self.schedule_save(cx);
        }
        self.space_drag = None;
        cx.notify();
    }

    /// One tree space row: chevron + status dot + folder icon + folder name,
    /// device tag. Click activates the space AND toggles its expansion (the
    /// active space's auto-expand override keeps it visible regardless);
    /// right-click opens the context menu; dragging reorders spaces.
    /// `ordinal` is the space's index among spaces (drag payload + slide
    /// math); the row fills the uniform tree slot (`CHAT_ROW_HEIGHT`) so the
    /// virtualized list stays uniform-height (§3.8 option A).
    #[allow(clippy::too_many_arguments)]
    fn render_space_row(
        &self,
        ordinal: usize,
        space: Space,
        device_name: String,
        host_offline: bool,
        selected: bool,
        expanded: bool,
        attention: Option<ChatIndicator>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let id = space.id.clone();
        let name: SharedString = space.display_name().to_string().into();
        let fade_key = format!("space-row-{id}");
        let rest_bg = if selected {
            crate::theme::glass_selected_bg()
        } else {
            crate::theme::wash(0.0)
        };
        let rest_text = if selected {
            theme.text
        } else {
            theme.text.opacity(0.8)
        };
        let select_id = id.clone();
        let menu_id = id.clone();
        // One line: "name @ device" — the folder name carries the weight, the
        // device tag rides along slightly muted. Long names truncate; the
        // device tag stays visible.
        let space_inspect = crate::dev_inspector::inspect_meta("sidebar-space-row");
        let space_hover_tag = space_inspect.clone();
        div()
            .id(SharedString::from(format!("space-{id}")))
            // The uniform tree slot: every node (space or session) is exactly
            // CHAT_ROW_HEIGHT tall so the virtualized list can lay them out at
            // a fixed stride (items_center floats the shorter space row).
            .h(px(super::nav::CHAT_ROW_HEIGHT))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(Theme::SPACE_SM))
            .rounded(px(8.0))
            .px(px(Theme::SPACE_SM))
            .text_color(motion::hover_blend(&fade_key, rest_text, theme.text))
            // Selected rows pin their hover target to the selected fill — see
            // the chat-row comment in shell.rs (light hover sits below the
            // near-opaque selected fill; blending toward it dims the row).
            .bg(motion::hover_blend(
                &fade_key,
                rest_bg,
                if selected {
                    rest_bg
                } else {
                    theme.glass_hover()
                },
            ))
            .when(selected, |el| {
                el.shadow(crate::theme::glass_selected_shadows())
            })
            .on_hover(move |hovered: &bool, window: &mut Window, cx: &mut App| {
                motion::hover_listener(&fade_key)(&hovered, window, cx);
                crate::dev_inspector::report_hover(&space_hover_tag, *hovered, window, cx);
            })
            .inspect_click(space_inspect)
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.activate_space(select_id.clone(), cx);
                this.toggle_space_expand(&select_id, cx);
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    this.space_menu = Some((menu_id.clone(), event.position));
                    cx.notify();
                }),
            )
            .on_drag(
                SpaceDragPayload {
                    from: ordinal,
                    name: name.clone(),
                },
                |payload, _point, _, cx| {
                    let name = payload.name.clone();
                    cx.stop_propagation();
                    cx.new(|_| SpaceGhost { name })
                },
            )
            // Chevron LEADS the row (before the status dot) so its position is
            // stable while toggling — the collapse affordance never moves.
            .child(
                icon(if expanded {
                    icons::ALT_ARROW_DOWN
                } else {
                    icons::ALT_ARROW_RIGHT
                })
                .size(px(12.0))
                .flex_none()
                .text_color(theme.text_muted),
            )
            // Status dot next (like session rows): faint at rest, colored
            // under attention — appearing/disappearing at the right edge made
            // the row jitter (user request).
            .child(
                div().size(px(6.0)).rounded_full().flex_none().bg(attention
                    .map(|status| status_dot_color(status, theme))
                    .unwrap_or_else(|| crate::theme::ink(0.14))),
            )
            .child(
                icon(icons::FOLDER)
                    .size(px(16.0))
                    .flex_none()
                    .text_color(theme.text_muted),
            )
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.0))
                    .line_height(px(17.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(name),
            )
            .child(div().flex_1())
            .child(
                div()
                    .flex_none()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.0))
                    .line_height(px(17.0))
                    .text_color(if host_offline {
                        theme.warning.opacity(0.8)
                    } else {
                        theme.text_muted.opacity(0.6)
                    })
                    .child(SharedString::from(if host_offline {
                        format!("@ {device_name} · offline")
                    } else {
                        format!("@ {device_name}")
                    })),
            )
    }

    /// Render one flattened-tree node (space row, session child, or the
    /// invisible spacer for the row being dragged) inside the virtualized
    /// list. `drag` is the in-flight space drag `(from, over, epoch, prev_over)`
    /// — the dragged space's slot goes empty and siblings slide one slot
    /// toward it (the session-tab idiom, vertical).
    pub(super) fn render_tree_node(
        &self,
        node: &SidebarTreeNode,
        drag: Option<(usize, usize, usize, usize)>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match node {
            SidebarTreeNode::Space { ordinal, space_id, .. } => {
                // The dragged row renders as an invisible spacer; the cursor
                // ghost represents it (its session children stay visible until
                // the drop commits, when the FLIP resort glides everything).
                if drag.is_some_and(|(from, ..)| from == *ordinal) {
                    return div().h(px(super::nav::CHAT_ROW_HEIGHT)).into_any_element();
                }
                let mut row = self.render_tree_space_row(node, theme, cx);
                if let Some((from, over, epoch, prev_over)) = drag {
                    let target =
                        slide_offset(*ordinal, from, over) * super::nav::CHAT_ROW_HEIGHT;
                    let start =
                        slide_offset(*ordinal, from, prev_over) * super::nav::CHAT_ROW_HEIGHT;
                    row = div()
                        .w_full()
                        .child(row)
                        .with_animation(
                            SharedString::from(format!("space-slide-{space_id}-{epoch}")),
                            TAB_SLIDE.animation(),
                            move |el, t| el.relative().top(px(motion::lerp(start, target, t))),
                        )
                        .into_any_element();
                }
                row
            }
            SidebarTreeNode::Session { .. } => self.render_tree_session_row(node, theme, cx),
            SidebarTreeNode::ShowMore {
                space_id,
                shown,
                total,
            } => self.render_tree_show_more_row(space_id, *shown, *total, theme, cx),
        }
    }

    /// The tree's space node: reads the live space row + device presence and
    /// delegates to [`Self::render_space_row`].
    pub(super) fn render_tree_space_row(
        &self,
        node: &SidebarTreeNode,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let SidebarTreeNode::Space {
            ordinal,
            space_id,
            expanded,
            attention,
            ..
        } = node
        else {
            unreachable!("tree session node rendered as a space row")
        };
        let now = Utc::now();
        let (space, device_name, host_offline, selected) = {
            let state = self.state.read(cx);
            let space = state.space_row(space_id);
            let device_name = space
                .and_then(|s| state.device_name(&s.device_id))
                .unwrap_or("Unknown device")
                .to_string();
            let host_offline = space.is_some_and(|s| !state.device_online(&s.device_id, now));
            let selected = state.selected_space.as_deref() == Some(space_id.as_str());
            (space.cloned(), device_name, host_offline, selected)
        };
        let Some(space) = space else {
            // Space vanished mid-frame — inert placeholder keeps the list
            // index-stable for this frame.
            return div().h(px(super::nav::CHAT_ROW_HEIGHT)).into_any_element();
        };
        self.render_space_row(
            *ordinal,
            space,
            device_name,
            host_offline,
            selected,
            *expanded,
            *attention,
            theme,
            cx,
        )
        .into_any_element()
    }

    /// The tree's session child: the compact 2-line chat row, indented under
    /// its space parent (the parent already names the folder — no repeat).
    pub(super) fn render_tree_session_row(
        &self,
        node: &SidebarTreeNode,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let SidebarTreeNode::Session { chat_id, .. } = node else {
            unreachable!("tree space node rendered as a session row")
        };
        let Some(data) = self.sidebar_chat_map.get(chat_id) else {
            return div().h(px(super::nav::CHAT_ROW_HEIGHT)).into_any_element();
        };
        let selected = self.state.read(cx).selected_chat.as_deref() == Some(chat_id.as_str());
        div()
            .h(px(super::nav::CHAT_ROW_HEIGHT))
            .pl(px(super::nav::TREE_INDENT))
            .child(self.render_chat_row(
                chat_id.clone(),
                data.title.clone(),
                data.time_ago.clone(),
                SharedString::from(""),
                data.branch.clone(),
                data.harness,
                data.acp_agent_id.clone(),
                data.status,
                selected,
                theme,
                cx,
            ))
            .into_any_element()
    }

    /// The "View more (N) / Hide more" disclosure row under a space with more
    /// sessions than the [`MAX_TREE_SESSIONS`] cap. Clicking toggles that
    /// space's show-all state (runtime only — restarts return to the capped
    /// view). Indented to align under the session titles.
    fn render_tree_show_more_row(
        &self,
        space_id: &str,
        shown: usize,
        total: usize,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let show_all = self.sidebar_space_show_all.contains(space_id);
        let label = if show_all {
            "Hide more".to_string()
        } else {
            format!("View more ({})", total - shown)
        };
        let select_id = space_id.to_string();
        let fade_key = format!("show-more-{space_id}");
        div()
            .id(SharedString::from(fade_key.clone()))
            .h(px(super::nav::CHAT_ROW_HEIGHT))
            // Align under the session title: TREE_INDENT + row px + rail(6) + gap(8).
            .pl(px(super::nav::TREE_INDENT + Theme::SPACE_SM + 14.0))
            .flex()
            .flex_row()
            .items_center()
            .text_size(px(11.0))
            .text_color(motion::hover_blend(
                &fade_key,
                theme.text_muted.opacity(0.7),
                theme.text_muted,
            ))
            .cursor_pointer()
            .on_hover(motion::hover_listener(&fade_key))
            .on_click(cx.listener(move |this, _, _, cx| {
                if this.sidebar_space_show_all.contains(&select_id) {
                    this.sidebar_space_show_all.remove(&select_id);
                } else {
                    this.sidebar_space_show_all.insert(select_id.clone());
                }
                cx.notify();
            }))
            .child(SharedString::from(label))
            .into_any_element()
    }

    /// Collect the data needed to render the sidebar session rows WITHOUT
    /// building any gpui elements. The virtualized sidebar tree calls this
    /// once per frame (cheap: sort + string formatting) and defers element
    /// creation to only the visible range inside `uniform_list`.
    pub(super) fn collect_active_row_data(
        &self,
        cx: &Context<Self>,
    ) -> Vec<ActiveRowData> {
        let now = Utc::now();
        let rows: Vec<(ChatIndicator, comet_proto::Chat, Option<String>)> = {
            let state = self.state.read(cx);
            state
                .overview_chats(now)
                .into_iter()
                .map(|(status, chat)| {
                    // The branch shows whenever the engine has stamped one —
                    // main-checkout sessions included, not just worktrees.
                    let branch = chat
                        .branch
                        .as_deref()
                        .map(str::trim)
                        .filter(|b| !b.is_empty())
                        .map(str::to_string);
                    (status, chat.clone(), branch)
                })
                .collect()
        };
        rows.into_iter()
            .map(|(status, chat, branch)| {
                let title: SharedString = transcript::single_line(
                    &chat.title.clone().unwrap_or_else(|| "New session".into()),
                )
                .into();
                let time_ago: SharedString =
                    format_time_ago(chat.last_message_at.unwrap_or(chat.created_at), now).into();
                ActiveRowData {
                    chat_id: chat.id.clone(),
                    title,
                    time_ago,
                    branch: branch.map(SharedString::from),
                    harness: chat.config.as_ref().map(|c| c.harness),
                    acp_agent_id: chat.config.as_ref().and_then(|c| c.acp_agent_id.clone()),
                    status,
                }
            })
            .collect()
    }

    // ---- add-space flow (the ⌘K palette) ----

    pub(super) fn open_add_space(&mut self, cx: &mut Context<Self>) {
        let local = self.state.read(cx).local_device_id.clone();
        let devices: Vec<Device> = crate::settings::devices::devices_for_display(
            self.state.read(cx).devices.clone(),
            local.as_deref(),
        );
        // Land on this device's tab (else the first registered device).
        let device = devices
            .iter()
            .find(|d| local.as_deref() == Some(d.id.as_str()))
            .or_else(|| devices.first())
            .cloned();
        // "PaletteSearch" context: navigation keys stay unbound so ↑↓/←/→/⏎
        // bubble to the palette frame (`add_space_key`) instead of moving the
        // text caret — Enter and ⌘Enter are both handled there.
        let search =
            cx.new(|cx| ComposerInput::with_context("Search folders…", "PaletteSearch", cx));
        let search_events = cx.subscribe(&search, |this: &mut Shell, _, event, cx| {
            if matches!(event, ComposerInputEvent::Edited) {
                let direct_path = this
                    .add_space
                    .as_ref()
                    .map(|flow| flow.search.read(cx).text().trim().to_string())
                    .filter(|query| is_absolute_path(query));
                if let Some(flow) = this.add_space.as_mut() {
                    flow.active = 0;
                }
                // An absolute path is navigation input, not a folder-name
                // filter. Browse it directly so `/Users/.../repo` resolves
                // even when the current listing has no matching child name.
                if let Some(path) = direct_path {
                    this.load_space_folders(Some(path), cx);
                }
                cx.notify();
            }
        });
        let has_device = device.is_some();
        self.add_space = Some(AddSpaceFlow {
            device,
            search,
            browser: Loadable::Idle,
            browser_path: None,
            home: None,
            browser_repo: false,
            active: 0,
            submit_busy: false,
            error: None,
            focus: cx.focus_handle(),
            list_scroll: gpui::ScrollHandle::new(),
            load_generation: 0,
            focus_pending: true,
            load_task: None,
            submit_task: None,
            _search_events: search_events,
        });
        if has_device {
            self.load_space_folders(None, cx);
        }
        cx.notify();
    }

    /// Devices-rail click: rebrowse the same palette on another device.
    fn add_space_pick_device(&mut self, device: Device, cx: &mut Context<Self>) {
        let Some(flow) = self.add_space.as_mut() else {
            return;
        };
        if flow.device.as_ref().is_some_and(|d| d.id == device.id) {
            return;
        }
        flow.device = Some(device);
        flow.browser = Loadable::Idle;
        flow.browser_path = None;
        flow.home = None;
        flow.browser_repo = false;
        flow.active = 0;
        flow.error = None;
        let search = flow.search.clone();
        search.update(cx, |input, cx| input.set_text("", cx));
        self.load_space_folders(None, cx);
        cx.notify();
    }

    /// The current listing's folder rows filtered by the search query
    /// (prefix matches first — `popover::filter_indices`).
    fn add_space_filtered(&self, cx: &App) -> Vec<comet_proto::FolderEntry> {
        let Some(flow) = self.add_space.as_ref() else {
            return Vec::new();
        };
        let Some(listing) = flow.browser.ready() else {
            return Vec::new();
        };
        let dirs = browser_rows(listing);
        let raw_query = flow.search.read(cx).text().to_string();
        // Once a direct path has resolved, show that directory's children.
        // The path remains in the input as navigation context, but must not
        // be applied as a child-name filter.
        let query = if is_absolute_path(&raw_query)
            && (listing.path == raw_query.trim()
                || listing.path == raw_query.trim().trim_end_matches('/'))
        {
            String::new()
        } else {
            raw_query
        };
        let names: Vec<&str> = dirs.iter().map(|e| e.name.as_str()).collect();
        popover::filter_indices(&query, &names)
            .into_iter()
            .map(|ix| dirs[ix].clone())
            .collect()
    }

    /// Descend into the highlighted (filtered) folder; clears the query.
    fn add_space_open_active(&mut self, cx: &mut Context<Self>) {
        let rows = self.add_space_filtered(cx);
        let Some(flow) = self.add_space.as_ref() else {
            return;
        };
        let Some(listing) = flow.browser.ready() else {
            return;
        };
        let Some(entry) = rows.get(flow.active) else {
            return;
        };
        let full = crate::pickers::child_path(&listing.path, &entry.name);
        let is_repo = entry.is_repo;
        let search = flow.search.clone();
        if let Some(flow) = self.add_space.as_mut() {
            flow.browser_repo = is_repo;
        }
        search.update(cx, |input, cx| input.set_text("", cx));
        self.load_space_folders(Some(full), cx);
    }

    /// Descend into a specific folder row (mouse path); clears the query.
    fn add_space_descend(&mut self, full: String, is_repo: bool, cx: &mut Context<Self>) {
        let Some(flow) = self.add_space.as_mut() else {
            return;
        };
        flow.browser_repo = is_repo;
        let search = flow.search.clone();
        search.update(cx, |input, cx| input.set_text("", cx));
        self.load_space_folders(Some(full), cx);
    }

    /// ListFolders on the flow's device (relay-forwarded when remote).
    pub(super) fn load_space_folders(&mut self, path: Option<String>, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let local = self.state.read(cx).local_device_id.clone();
        let Some(flow) = self.add_space.as_mut() else {
            return;
        };
        let device_id = flow.device.as_ref().map(|d| d.id.clone());
        let went_home = path.is_none();
        flow.browser_path = path.clone();
        flow.browser = Loadable::Loading;
        flow.active = 0;
        flow.list_scroll.set_offset(gpui::Point::default());
        flow.load_generation = flow.load_generation.wrapping_add(1);
        let load_generation = flow.load_generation;
        flow.load_task = Some(cx.spawn(async move |this, cx| {
            let mut params = serde_json::Map::new();
            if let Some(p) = &path {
                params.insert("path".into(), serde_json::Value::String(p.clone()));
            }
            // Only target remote devices — local calls skip the relay.
            if let (Some(target), local) = (&device_id, &local)
                && local.as_deref() != Some(target.as_str())
            {
                params.insert(
                    "targetDeviceId".into(),
                    serde_json::Value::String(target.clone()),
                );
            }
            let result = engine
                .client()
                .call(methods::LIST_FOLDERS, serde_json::Value::Object(params))
                .await;
            this.update(cx, |shell, cx| {
                if let Some(flow) = shell.add_space.as_mut() {
                    if flow.load_generation != load_generation {
                        return;
                    }
                    flow.browser = match result {
                        Ok(value) => match serde_json::from_value::<FolderListing>(value) {
                            Ok(listing) => {
                                // A pathless browse resolved home — remember it
                                // so the breadcrumbs can fold it into the
                                // device crumb.
                                if went_home {
                                    flow.home = Some(listing.path.clone());
                                }
                                Loadable::Ready(listing)
                            }
                            Err(err) => Loadable::Error(err.to_string()),
                        },
                        Err(err) => Loadable::Error(err.to_string()),
                    };
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Create the space for the browser's current folder.
    fn submit_add_space(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let Some(flow) = self.add_space.as_ref() else {
            return;
        };
        if flow.submit_busy {
            return;
        }
        let Some(device) = flow.device.clone() else {
            return;
        };
        let Some(listing) = flow.browser.ready() else {
            return;
        };
        let path = listing.path.clone();
        let git_detected = flow.browser_repo;
        // Same (device, folder) already has a space → just switch to it. The
        // engine dedupes this case too (a createSpace for a duplicate pair
        // no-ops), so creating would leave the minted id dangling.
        if let Some(existing) = self
            .state
            .read(cx)
            .spaces
            .iter()
            .find(|s| s.device_id == device.id && s.path == path)
            .map(|s| s.id.clone())
        {
            self.add_space = None;
            self.activate_space(existing, cx);
            return;
        }
        let Some(flow) = self.add_space.as_mut() else {
            return;
        };
        flow.submit_busy = true;
        flow.error = None;
        let space_id = uuid::Uuid::new_v4().to_string();
        // Optimistic echo: the watch frame carrying the real row replaces it
        // by id (apply_spaces re-sorts; same-id upsert is idempotent).
        let space = Space {
            id: space_id.clone(),
            device_id: device.id.clone(),
            path: path.clone(),
            name: None,
            git_detected,
            git_checked_at: None,
            checkout_id: None,
            created_at: Utc::now(),
        };
        self.state.update(cx, |s, cx| {
            if !s.spaces.iter().any(|existing| existing.id == space.id) {
                s.spaces.push(space);
            }
            cx.notify();
        });
        let params = serde_json::json!({
            "op": "createSpace",
            "spaceId": space_id,
            "deviceId": device.id,
            "path": path,
            "gitDetected": git_detected,
        });
        let submit_id = space_id.clone();
        let task = cx.spawn(async move |this, cx| {
            let result = engine.client().call(methods::MUTATE, params).await;
            this.update(cx, |shell, cx| {
                match result {
                    Ok(_) => {
                        shell.add_space = None;
                        shell.activate_space(submit_id.clone(), cx);
                    }
                    Err(err) => {
                        // Roll the optimistic row back; surface the error inline.
                        shell.state.update(cx, |s, cx| {
                            s.spaces.retain(|space| space.id != submit_id);
                            cx.notify();
                        });
                        if let Some(flow) = shell.add_space.as_mut() {
                            flow.submit_busy = false;
                            flow.error = Some(format!("{err}").into());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        });
        if let Some(flow) = self.add_space.as_mut() {
            flow.submit_task = Some(task);
        }
        cx.notify();
    }

    /// Go up to the parent folder (←, and ⌫ on an empty query).
    fn add_space_go_up(&mut self, cx: &mut Context<Self>) {
        let parent = self
            .add_space
            .as_ref()
            .and_then(|f| f.browser.ready())
            .and_then(|l| parent_path(&l.path));
        if let Some(parent) = parent {
            if let Some(flow) = self.add_space.as_mut() {
                flow.browser_repo = false; // unknown at the parent
            }
            self.load_space_folders(Some(parent), cx);
        }
    }

    /// Palette keys (bubbling from the focused search input) — every legend
    /// maps to a REAL key: ↑↓ navigate, →/⏎ open the highlighted folder,
    /// ← up a level, ⌘⏎ add the OPEN folder, ⌫ (empty query) also goes up,
    /// esc closes.
    fn add_space_key(&mut self, event: &gpui::KeyDownEvent, cx: &mut Context<Self>) {
        // ←/→ act on the FOLDERS, not the text cursor — the palette is a
        // navigator first; queries are short and edited with ⌫.
        match event.keystroke.key.as_str() {
            "right" => {
                self.add_space_open_active(cx);
                return;
            }
            "left" => {
                self.add_space_go_up(cx);
                return;
            }
            _ => {}
        }
        let key = popover::classify_key(
            event.keystroke.key.as_str(),
            event.keystroke.modifiers.platform,
            event.keystroke.modifiers.control,
        );
        match key {
            popover::MenuKey::Escape => {
                self.add_space = None;
                cx.notify();
            }
            popover::MenuKey::Up | popover::MenuKey::Down => {
                let count = self.add_space_filtered(cx).len();
                let delta = if key == popover::MenuKey::Up { -1 } else { 1 };
                if let Some(flow) = self.add_space.as_mut() {
                    flow.active = popover::menu_step(Some(flow.active), count, delta).unwrap_or(0);
                    // Keep the highlighted row in view as the cursor walks
                    // past the viewport (user-reported: the list didn't
                    // follow the keyboard).
                    flow.list_scroll.scroll_to_item(flow.active);
                    cx.notify();
                }
            }
            // ⏎ opens the highlighted folder (an alias for →); the space is
            // added with ⌘⏎ — and the chord acts on the folder OPEN in the
            // breadcrumbs, not the highlight. The highlight auto-rests on the
            // first row, so a chord that took it would add arbitrary
            // subfolders; the usual target (a repo root full of subfolders)
            // is only ever "the folder you're standing in".
            popover::MenuKey::Enter => self.add_space_open_active(cx),
            popover::MenuKey::ModEnter => self.submit_add_space(cx),
            popover::MenuKey::Backspace => {
                let empty = self
                    .add_space
                    .as_ref()
                    .is_some_and(|f| f.search.read(cx).is_empty());
                if empty {
                    self.add_space_go_up(cx);
                }
            }
            popover::MenuKey::Other => {}
        }
    }

    /// The palette card: ⌘K search bar (with the ⌘⏎ add / esc chips) ·
    /// breadcrumbs + folder list beside the devices rail · kbd-hint footer.
    pub(super) fn render_add_space_overlay(
        &mut self,
        viewport: gpui::Size<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = Theme::of(cx).clone();
        {
            let flow = self.add_space.as_mut()?;
            if std::mem::take(&mut flow.focus_pending) {
                let handle = flow.search.focus_handle(cx);
                window.focus(&handle, cx);
            }
        }
        let (
            device,
            search,
            error,
            submit_busy,
            active,
            loading,
            load_error,
            listing,
            focus,
            list_scroll,
            home,
        ) = {
            let flow = self.add_space.as_ref()?;
            (
                flow.device.clone(),
                flow.search.clone(),
                flow.error.clone(),
                flow.submit_busy,
                flow.active,
                matches!(flow.browser, Loadable::Loading | Loadable::Idle),
                flow.browser.error().map(str::to_string),
                flow.browser.ready().cloned(),
                flow.focus.clone(),
                flow.list_scroll.clone(),
                flow.home.clone(),
            )
        };
        let local_id = self.state.read(cx).local_device_id.clone();
        let devices = crate::settings::devices::devices_for_display(
            self.state.read(cx).devices.clone(),
            local_id.as_deref(),
        );
        let rows = self.add_space_filtered(cx);
        let query_empty = search.read(cx).is_empty();
        let hairline = crate::theme::hairline(0.06);
        let now = Utc::now();
        // (browsed device name, online) per rail row — presence is the same
        // signal the sidebar space rows use.
        let device_presence: Vec<bool> = {
            let state = self.state.read(cx);
            devices
                .iter()
                .map(|d| state.device_online(&d.id, now))
                .collect()
        };
        let device_name: SharedString = device
            .as_ref()
            .map(|d| d.name.clone())
            .unwrap_or_else(|| "This device".to_string())
            .into();

        // A quiet mono key-cap chip ("⌘K" / "esc") for the search bar ends.
        let key_chip = |theme: &Theme| {
            div()
                .h(px(22.0))
                .px(px(6.0))
                .rounded(px(5.0))
                .flex_none()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(2.0))
                .bg(crate::theme::ink(0.05))
                .text_size(px(11.0))
                .font_family(theme.font_mono.clone())
                .text_color(theme.text_muted.opacity(0.7))
        };

        // ── search bar (the ⌘K bar): summon chip · input · "⌘ Enter" add ·
        //    esc. The primary chip leads with the ⌘ glyph, then says "Enter"
        //    in words (user request — the bare return arrow read as noise).
        let submit_chip = popover::btn_primary(&theme, "")
            .id("add-space-submit")
            .h(px(22.0))
            .px(px(8.0))
            .py(px(0.0))
            // Match the key-cap chips beside it (rounded-5) — btn_primary's
            // rounded-8 at this size read as a different component.
            .rounded(px(5.0))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .text_size(px(12.0))
            .when(submit_busy || listing.is_none(), |el| el.opacity(0.6))
            .on_click(cx.listener(|this, _, _, cx| this.submit_add_space(cx)))
            .when(!submit_busy, |el| {
                el.child(
                    icon(icons::COMMAND)
                        .size(px(11.0))
                        .text_color(theme.on_solid.opacity(0.8)),
                )
                .child(SharedString::from("Enter"))
            })
            .when(submit_busy, |el| el.child(SharedString::from("Adding…")));
        // Header and footer sit a shade DEEPER than the body (the shared
        // recessed-band tone) — the bands frame the folder list, which stays
        // on the brighter tint.
        let band = popover::band();
        let input_row = div()
            .h(px(46.0))
            .flex_none()
            .pl(px(12.0))
            .pr(px(10.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .bg(band)
            .border_b_1()
            .border_color(hairline)
            .child(
                key_chip(&theme)
                    .child(
                        icon(icons::COMMAND)
                            .size(px(11.0))
                            .text_color(theme.text_muted.opacity(0.7)),
                    )
                    .child(SharedString::from("K")),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(14.0))
                    .child(search.clone().into_any_element()),
            )
            .child(submit_chip)
            .child(
                key_chip(&theme)
                    .id("add-space-esc")
                    .cursor_pointer()
                    .hover(|s| s.bg(crate::theme::ink(0.09)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.add_space = None;
                        cx.notify();
                    }))
                    .child(SharedString::from("esc")),
            );

        // ── breadcrumbs ("MacBook Pro / Projects / comet"): the quiet mono
        //    path voice, `/` separators. The device crumb stands in for home —
        //    everything up to the resolved home path folds into it; below
        //    home the full path shows. Ancestors (device crumb included) are
        //    clickable.
        let crumbs: AnyElement = match &listing {
            Some(listing) => {
                let segments = breadcrumbs(&listing.path);
                let last = segments.len().saturating_sub(1);
                // Root "/" chip always folds; the home segments fold too when
                // the browsed path sits at/under home.
                let at_home = home.as_deref() == Some(listing.path.as_str());
                let folded = 1 + home
                    .as_deref()
                    .filter(|h| listing.path == *h || listing.path.starts_with(&format!("{h}/")))
                    .map(|h| h.split('/').filter(|s| !s.is_empty()).count())
                    .unwrap_or(0);
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .items_center()
                    .px(px(13.0))
                    .pt(px(10.0))
                    .pb(px(2.0))
                    .text_size(px(11.0))
                    .font_family(theme.font_mono.clone())
                    .child({
                        let crumb = div()
                            .id("add-space-crumb-device")
                            .px(px(3.0))
                            .rounded(px(4.0))
                            .child(device_name.clone());
                        if at_home {
                            // Standing at home — the device crumb IS the
                            // current folder.
                            crumb
                                .text_color(theme.text.opacity(0.85))
                                .into_any_element()
                        } else {
                            crumb
                                .text_color(theme.text_muted.opacity(0.55))
                                .cursor_pointer()
                                .hover(|s| s.text_color(theme.text))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some(flow) = this.add_space.as_mut() {
                                        flow.browser_repo = false;
                                    }
                                    this.load_space_folders(None, cx);
                                }))
                                .into_any_element()
                        }
                    })
                    .children(segments.into_iter().enumerate().skip(folded).map(
                        |(ix, (label, full))| {
                            let is_last = ix == last;
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .child(
                                    div()
                                        .text_color(theme.text_faint.opacity(0.7))
                                        .child(SharedString::from("/")),
                                )
                                .child({
                                    let crumb = div()
                                        .id(("add-space-crumb", ix))
                                        .px(px(3.0))
                                        .rounded(px(4.0))
                                        .text_color(if is_last {
                                            theme.text.opacity(0.85)
                                        } else {
                                            theme.text_muted.opacity(0.55)
                                        })
                                        .child(SharedString::from(label));
                                    if is_last {
                                        crumb.into_any_element()
                                    } else {
                                        crumb
                                            .cursor_pointer()
                                            .hover(|s| s.text_color(theme.text))
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                if let Some(flow) = this.add_space.as_mut() {
                                                    flow.browser_repo = false;
                                                }
                                                this.load_space_folders(Some(full.clone()), cx);
                                            }))
                                            .into_any_element()
                                    }
                                })
                        },
                    ))
                    .into_any_element()
            }
            None => div().pt(px(6.0)).into_any_element(),
        };

        // ── folder list ─────────────────────────────────────────────────────
        let base_path = listing.as_ref().map(|l| l.path.clone()).unwrap_or_default();
        let list: AnyElement = if loading {
            div()
                .px(px(8.0))
                .py(px(6.0))
                .child(popover::skeleton_rows(
                    "add-space-skeleton",
                    &theme,
                    6,
                    cx.entity_id(),
                    cx,
                ))
                .into_any_element()
        } else if let Some(message) = load_error {
            let device_line = device
                .as_ref()
                .map(|d| format!("{} didn't respond — is it online?", d.name))
                .unwrap_or(message);
            popover::error_row(&theme, &device_line)
                .px(px(14.0))
                .py(px(10.0))
                .child(
                    div()
                        .id("add-space-retry")
                        .px(px(Theme::SPACE_SM))
                        .py(px(3.0))
                        .rounded(px(Theme::CONTROL_RADIUS))
                        .border_1()
                        .border_color(theme.border)
                        .text_color(theme.text)
                        .cursor_pointer()
                        .hover(|s| s.bg(theme.element_hover))
                        .on_click(cx.listener(|this, _, _, cx| {
                            let path = this.add_space.as_ref().and_then(|f| f.browser_path.clone());
                            this.load_space_folders(path, cx);
                        }))
                        .child(SharedString::from("Retry")),
                )
                .into_any_element()
        } else if rows.is_empty() {
            div()
                .px(px(14.0))
                .py(px(16.0))
                .text_size(px(12.5))
                .text_color(theme.text_faint)
                .child(SharedString::from(if query_empty {
                    "No folders here"
                } else {
                    "No folders match"
                }))
                .into_any_element()
        } else {
            // The 6px gutters live on a WRAPPER, outside the scroll viewport:
            // in-content padding/spacers can't do it — the wheel's max offset
            // eats bottom padding, and `scroll_to_item` (keyboard) pins the
            // row's bottom to the viewport edge regardless.
            div()
                .flex_1()
                .min_h_0()
                .py(px(6.0))
                .child(
                    div()
                        .id("add-space-folders")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&list_scroll)
                        .px(px(8.0))
                        .flex()
                        .flex_col()
                        // The app-wide list rhythm (sidebar rows, menu rows): 2px.
                        .gap(px(2.0))
                        .children(rows.into_iter().enumerate().map(|(ix, entry)| {
                            let name: SharedString = entry.name.clone().into();
                            let full = crate::pickers::child_path(&base_path, &entry.name);
                            let is_repo = entry.is_repo;
                            popover::menu_row_nav(
                                &theme,
                                false,
                                ix == active,
                                format!("add-space-folder-{ix}"),
                            )
                            // The floating-card selection language: the wash
                            // plus the ring-only inset outline.
                            .when(ix == active, |el| {
                                el.shadow(crate::theme::card_selected_shadows())
                            })
                            .id(("add-space-folder", ix))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.add_space_descend(full.clone(), is_repo, cx);
                            }))
                            .child(
                                icon(icons::FOLDER)
                                    .size(px(15.0))
                                    .flex_none()
                                    .text_color(theme.text_muted.opacity(0.8)),
                            )
                            .child(div().flex_1().min_w_0().truncate().child(name))
                            // Repos get a quiet trailing branch glyph — the row
                            // you're usually hunting for announces itself.
                            .when(is_repo, |el| {
                                el.child(
                                    icon(icons::GIT_BRANCH)
                                        .size(px(13.0))
                                        .flex_none()
                                        .text_color(theme.text_muted.opacity(0.5)),
                                )
                            })
                        })),
                )
                .into_any_element()
        };

        // ── devices rail (mock right column): platform glyph + name +
        //    presence dot per row, an info line naming the browsed device.
        //    Rows are the tab recipe (h-28 rounded-8 washes), vertical.
        let rail = div()
            .w(px(196.0))
            .flex_none()
            .border_l_1()
            .border_color(hairline)
            .px(px(8.0))
            .py(px(8.0))
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(
                div()
                    .px(px(8.0))
                    .pt(px(2.0))
                    .pb(px(4.0))
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.text_muted.opacity(0.6))
                    .child(SharedString::from("Devices")),
            )
            .children(devices.into_iter().enumerate().map(|(ix, dev)| {
                let is_active = device.as_ref().is_some_and(|d| d.id == dev.id);
                let online = device_presence.get(ix).copied().unwrap_or(false);
                // The Devices-page platform mapping (settings::devices).
                let platform_icon = match dev.platform.as_str() {
                    "macos" | "darwin" => icons::LAPTOP,
                    "web" => icons::GLOBAL,
                    "ios" | "android" => icons::SMARTPHONE,
                    _ => icons::MONITOR,
                };
                let name: SharedString = dev.name.clone().into();
                let pick = dev.clone();
                div()
                    .id(("add-space-device", ix))
                    .h(px(28.0))
                    .px(px(8.0))
                    .rounded(px(8.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(12.5))
                    .cursor_pointer()
                    .when(is_active, |el| {
                        // The floating-card selection language: wash +
                        // ring-only inset outline.
                        el.bg(crate::theme::card_selected_bg())
                            .shadow(crate::theme::card_selected_shadows())
                            .text_color(theme.text)
                    })
                    .when(!is_active, |el| {
                        el.text_color(theme.text_muted.opacity(0.7))
                            .hover(|s| s.bg(theme.element_hover))
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.add_space_pick_device(pick.clone(), cx);
                    }))
                    .child(
                        icon(platform_icon)
                            .size(px(14.0))
                            .flex_none()
                            .text_color(theme.text_muted.opacity(0.8)),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(name))
                    .child(
                        div()
                            .size(px(5.0))
                            .rounded_full()
                            .flex_none()
                            .when(online, |el| {
                                // The Devices-page presence emerald, soft glow
                                // included.
                                let emerald = theme.success;
                                el.bg(emerald.opacity(0.9)).shadow(vec![gpui::BoxShadow {
                                    color: emerald.opacity(0.55),
                                    offset: gpui::point(px(0.0), px(0.0)),
                                    blur_radius: px(6.0),
                                    spread_radius: px(0.0),
                                    inset: false,
                                }])
                            })
                            .when(!online, |el| el.bg(crate::theme::ink(0.22))),
                    )
            }))
            .child(div().h(px(1.0)).mx(px(2.0)).my(px(6.0)).bg(hairline))
            .child(
                div()
                    .px(px(8.0))
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(6.0))
                    .text_size(px(11.0))
                    .line_height(px(15.0))
                    .text_color(theme.text_muted.opacity(0.5))
                    .child(
                        icon(icons::INFO_CIRCLE)
                            .size(px(12.0))
                            .flex_none()
                            .mt(px(1.0))
                            .text_color(theme.text_muted.opacity(0.5)),
                    )
                    .child(div().min_w_0().child(SharedString::from(format!(
                        "Showing folders from {device_name} only"
                    )))),
            );

        // ── body: folder column (crumbs + list) beside the devices rail.
        //    FIXED height — sparse folders, loading skeletons, and device
        //    switches must not resize the card (the list fills and scrolls).
        let body = div()
            .h(px(330.0))
            .flex()
            .flex_row()
            .items_stretch()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(crumbs)
                    .child(list),
            )
            .child(rail);

        // ── footer: the shared key-cap legend voice (popover::key_hint).
        let footer = div()
            .flex_none()
            .bg(band)
            .border_t_1()
            .border_color(hairline)
            .px(px(12.0))
            .py(px(8.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.0))
            .child(popover::key_hint_pair(
                &theme,
                icons::ARROW_UP,
                icons::ARROW_DOWN,
                "Navigate",
            ))
            .child(popover::key_hint(&theme, icons::ARROW_LEFT, "Up"))
            .child(popover::key_hint(&theme, icons::ARROW_RIGHT, "Open"))
            .when_some(error, |el, message| {
                el.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(11.0))
                        .text_color(theme.danger)
                        .child(message),
                )
            });

        let card =
            div()
                .id("add-space-palette")
                .w(px(680.0))
                .rounded(px(14.0))
                .border_1()
                .border_color(crate::theme::hairline(0.10))
                // The popover_card glass recipe: a translucent tint over the
                // frosted backdrop blur (`popover::modal` wraps in `frosted`) —
                // an opaque fill here killed the vibrancy every other float has.
                .bg(if theme.is_glass() {
                    theme.glass_overlay()
                } else {
                    theme.surface_overlay
                })
                .shadow_lg()
                .overflow_hidden()
                .flex()
                .flex_col()
                .text_color(theme.text)
                // On the keyboard dispatch path (see `AddSpaceFlow::focus`) — the
                // pickers' proven structure for frame-level keys with a focused
                // child input.
                .track_focus(&focus)
                .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                    this.add_space_key(event, cx)
                }))
                // Clicking the scrim dismisses (user requirement) — same close
                // path as Escape.
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.add_space = None;
                    cx.notify();
                }))
                .child(input_row)
                .child(body)
                .child(footer)
                .into_any_element();
        Some(popover::modal("add-space-dialog", viewport, card))
    }

    // ---- space context menu / rename / delete overlays ----

    pub(super) fn open_rename_space(&mut self, space_id: String, cx: &mut Context<Self>) {
        self.space_menu = None;
        let current = self
            .state
            .read(cx)
            .space_row(&space_id)
            .map(|s| s.display_name().to_string())
            .unwrap_or_default();
        let input = cx.new(|cx| ComposerInput::new("Space name", cx));
        input.update(cx, |input, cx| input.set_text(current, cx));
        let events = cx.subscribe(&input, |this: &mut Shell, _, event, cx| {
            if matches!(event, ComposerInputEvent::Submitted) {
                this.submit_rename_space(cx);
            }
        });
        self.rename_space_dialog = Some(RenameSpaceDialog {
            space_id,
            input,
            focus_pending: true,
            _events: events,
        });
        cx.notify();
    }

    pub(super) fn submit_rename_space(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.rename_space_dialog.take() else {
            return;
        };
        let name = dialog.input.read(cx).text().trim().to_string();
        if !name.is_empty() {
            self.mutate(
                serde_json::json!({ "op": "renameSpace", "spaceId": dialog.space_id, "name": name }),
                cx,
            );
        }
        cx.notify();
    }

    pub(super) fn delete_space(&mut self, space_id: String, cx: &mut Context<Self>) {
        self.delete_space_confirm = None;
        self.mutate(
            serde_json::json!({ "op": "deleteSpace", "spaceId": space_id }),
            cx,
        );
        cx.notify();
    }

    pub(super) fn open_project_harness(&mut self, space_id: String, cx: &mut Context<Self>) {
        self.space_menu = None;
        let Some(space) = self.state.read(cx).space_row(&space_id).cloned() else {
            return;
        };
        self.project_harness = Some(ProjectHarnessFlow {
            space_id,
            project: space.display_name().to_string(),
            cwd: space.path,
            device_id: space.device_id,
            status: Loadable::Loading,
            busy_id: None,
            flash: None,
            error: None,
            task: None,
        });
        self.load_project_harness(cx);
        cx.notify();
    }

    fn project_harness_params(
        &self,
        cx: &Context<Self>,
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        let flow = self.project_harness.as_ref()?;
        let mut params = serde_json::Map::new();
        params.insert("cwd".into(), flow.cwd.clone().into());
        params.insert("projectName".into(), flow.project.clone().into());
        if self.state.read(cx).local_device_id.as_deref() != Some(flow.device_id.as_str()) {
            params.insert("targetDeviceId".into(), flow.device_id.clone().into());
        }
        Some(params)
    }

    fn load_project_harness(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let Some(params) = self.project_harness_params(cx) else {
            return;
        };
        let Some(flow) = self.project_harness.as_mut() else {
            return;
        };
        flow.status = Loadable::Loading;
        flow.error = None;
        let space_id = flow.space_id.clone();
        flow.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::GET_PROJECT_HARNESS, params.into())
                .await;
            this.update(cx, |shell, cx| {
                let Some(flow) = shell
                    .project_harness
                    .as_mut()
                    .filter(|f| f.space_id == space_id)
                else {
                    return;
                };
                flow.status = match result {
                    Ok(value) => serde_json::from_value(value)
                        .map(Loadable::Ready)
                        .unwrap_or_else(|err| Loadable::Error(err.to_string())),
                    Err(err) => Loadable::Error(err.to_string()),
                };
                cx.notify();
            })
            .ok();
        }));
    }

    fn apply_project_harness(&mut self, optimization_id: String, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let Some(mut params) = self.project_harness_params(cx) else {
            return;
        };
        let Some(flow) = self.project_harness.as_mut() else {
            return;
        };
        if flow.busy_id.is_some() {
            return;
        }
        params.insert("optimizationId".into(), optimization_id.clone().into());
        flow.busy_id = Some(optimization_id);
        flow.flash = None;
        flow.error = None;
        let space_id = flow.space_id.clone();
        flow.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::APPLY_PROJECT_HARNESS, params.into())
                .await;
            this.update(cx, |shell, cx| {
                let Some(flow) = shell.project_harness.as_mut().filter(|f| f.space_id == space_id) else {
                    return;
                };
                flow.busy_id = None;
                match result {
                    Ok(value) => match serde_json::from_value::<ApplyHarnessResult>(value) {
                        Ok(applied) if applied.ok => {
                            let count = applied.written.as_ref().map_or(0, Vec::len);
                            if let Some(harness) = applied.harness {
                                flow.status = Loadable::Ready(harness);
                            }
                            flow.flash = Some(if count == 0 {
                                "Already up to date.".into()
                            } else {
                                format!(
                                    "Applied to {count} project file{}. New sessions pick it up automatically.",
                                    if count == 1 { "" } else { "s" }
                                )
                                .into()
                            });
                        }
                        Ok(applied) => {
                            flow.error = Some(
                                applied.error.unwrap_or_else(|| "Could not apply optimization".into()).into(),
                            );
                        }
                        Err(err) => flow.error = Some(err.to_string().into()),
                    },
                    Err(err) => flow.error = Some(err.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Space context menu + rename dialog + delete confirm (appended to the
    /// shell's overlay list).
    pub(super) fn render_space_overlays(
        &mut self,
        viewport: gpui::Size<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let theme = Theme::of(cx).clone();
        let mut overlays: Vec<AnyElement> = Vec::new();

        if let Some((space_id, position)) = self.space_menu.clone() {
            let rename_id = space_id.clone();
            let harness_id = space_id.clone();
            let delete_id = space_id.clone();
            let menu = popover::popover_card(&theme)
                .w(px(170.0))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.space_menu = None;
                    cx.notify();
                }))
                .flex()
                .flex_col()
                .child(
                    popover::menu_row(&theme, false, format!("space-menu-rename-{space_id}"))
                        .id("space-menu-rename")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_rename_space(rename_id.clone(), cx)
                        }))
                        .child(icon(icons::PEN).size(px(16.0)).text_color(theme.text_muted))
                        .child(SharedString::from("Rename…")),
                )
                .child(
                    popover::menu_row(&theme, false, format!("space-menu-harness-{space_id}"))
                        .id("space-menu-harness")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_project_harness(harness_id.clone(), cx)
                        }))
                        .child(
                            icon(icons::SETTINGS_MINIMALISTIC)
                                .size(px(16.0))
                                .text_color(theme.text_muted),
                        )
                        .child(SharedString::from("AI Harness…")),
                )
                .child(popover::menu_separator())
                .child(
                    popover::menu_row(&theme, false, format!("space-menu-delete-{space_id}"))
                        .id("space-menu-delete")
                        .text_color(theme.danger)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.space_menu = None;
                            this.delete_space_confirm = Some(delete_id.clone());
                            cx.notify();
                        }))
                        .child(
                            icon(icons::TRASH_BIN_MINIMALISTIC)
                                .size(px(16.0))
                                .text_color(theme.danger),
                        )
                        .child(SharedString::from("Remove…")),
                )
                .into_any_element();
            overlays.push(popover::menu_at("space-context-menu", position, menu));
        }

        if let Some(dialog) = &mut self.rename_space_dialog {
            if std::mem::take(&mut dialog.focus_pending) {
                window.focus(&dialog.input.focus_handle(cx), cx);
            }
            let input = dialog.input.clone();
            let card = popover::dialog_card(&theme)
                .on_key_down(cx.listener(|this, ev: &gpui::KeyDownEvent, _, cx| {
                    if ev.keystroke.key == "escape" {
                        this.rename_space_dialog = None;
                        cx.notify();
                    }
                }))
                .child(popover::dialog_title(&theme, "Rename space"))
                .child(
                    div()
                        .mt(px(12.0))
                        .child(popover::dialog_field(input.into_any_element())),
                )
                .child(
                    div()
                        .mt(px(16.0))
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap(px(8.0))
                        .child(
                            popover::btn_ghost(&theme, "Cancel", "rename-space-cancel")
                                .id("rename-space-cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.rename_space_dialog = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            popover::btn_primary(&theme, "Rename")
                                .id("rename-space-save")
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.submit_rename_space(cx)),
                                ),
                        ),
                )
                .into_any_element();
            overlays.push(popover::modal("rename-space-dialog", viewport, card));
        }

        if let Some(flow) = self.project_harness.as_ref() {
            let project = flow.project.clone();
            let cwd = flow.cwd.clone();
            let status = flow.status.clone();
            let busy_id = flow.busy_id.clone();
            let flash = flow.flash.clone();
            let error = flow.error.clone();
            let harness = status.ready().cloned();
            let (applied, total) = harness
                .as_ref()
                .map(|h| (h.applied_count, h.optimizations.len()))
                .unwrap_or((0, 0));

            let mut body = div().flex().flex_col().gap(px(10.0));
            if status.is_loading() {
                body = body.child(
                    div()
                        .py(px(36.0))
                        .text_color(theme.text_muted)
                        .text_size(px(13.0))
                        .text_align(gpui::TextAlign::Center)
                        .child("Loading harness…"),
                );
            }
            if let Some(message) = status
                .error()
                .map(str::to_string)
                .or_else(|| error.map(|e| e.to_string()))
            {
                body = body.child(
                    div()
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(theme.danger.opacity(0.35))
                        .bg(theme.danger.opacity(0.08))
                        .p(px(10.0))
                        .text_size(px(12.0))
                        .text_color(theme.danger)
                        .child(message),
                );
            }
            if let Some(message) = flash {
                body = body.child(
                    div()
                        .rounded(px(8.0))
                        .bg(crate::theme::oklch(0.765, 0.177, 163.223).opacity(0.10))
                        .p(px(10.0))
                        .text_size(px(12.0))
                        .text_color(crate::theme::oklch(0.765, 0.177, 163.223))
                        .child(message),
                );
            }
            if let Some(harness) = harness {
                for optimization in harness.optimizations {
                    let id = optimization.id.clone();
                    let is_busy = busy_id.as_deref() == Some(id.as_str());
                    let button_label = if is_busy {
                        "Applying…"
                    } else if optimization.applied {
                        "Re-apply"
                    } else {
                        "Apply"
                    };
                    let badge_color = if optimization.applied {
                        crate::theme::oklch(0.765, 0.177, 163.223)
                    } else {
                        theme.text_muted
                    };
                    let mut copy = div()
                        .min_w_0()
                        .flex_1()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .font_weight(gpui::FontWeight::MEDIUM)
                                        .text_size(px(13.0))
                                        .child(optimization.name),
                                )
                                .child(
                                    div()
                                        .rounded(px(4.0))
                                        .px(px(6.0))
                                        .py(px(2.0))
                                        .bg(badge_color.opacity(0.10))
                                        .text_color(badge_color)
                                        .text_size(px(9.0))
                                        .child(if optimization.applied {
                                            "APPLIED"
                                        } else {
                                            "NOT APPLIED"
                                        }),
                                ),
                        )
                        .child(
                            div()
                                .mt(px(6.0))
                                .text_size(px(12.0))
                                .line_height(gpui::relative(1.45))
                                .text_color(theme.text_muted)
                                .child(optimization.description),
                        )
                        .child(
                            div()
                                .mt(px(7.0))
                                .text_size(px(10.0))
                                .text_color(theme.text_faint)
                                .child(optimization.source_label),
                        );
                    if let Some(details) = optimization.details {
                        copy = copy.child(
                            div()
                                .mt(px(7.0))
                                .text_size(px(10.0))
                                .text_color(theme.text_faint)
                                .child(details),
                        );
                    }
                    body = body.child(
                        div()
                            .rounded(px(10.0))
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.surface)
                            .p(px(14.0))
                            .flex()
                            .items_start()
                            .gap(px(12.0))
                            .child(copy)
                            .child(
                                popover::btn_primary(&theme, button_label)
                                    .id(SharedString::from(format!("apply-harness-{id}")))
                                    .opacity(if busy_id.is_some() { 0.55 } else { 1.0 })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.apply_project_harness(id.clone(), cx)
                                    })),
                            ),
                    );
                }
            }

            let card = popover::dialog_card(&theme)
                .w(px(560.0))
                .max_h(px(640.0))
                .on_key_down(cx.listener(|this, ev: &gpui::KeyDownEvent, _, cx| {
                    if ev.keystroke.key == "escape"
                        && this.project_harness.as_ref().and_then(|f| f.busy_id.as_ref()).is_none()
                    {
                        this.project_harness = None;
                        cx.notify();
                    }
                }))
                .child(
                    div()
                        .flex()
                        .items_start()
                        .justify_between()
                        .gap(px(12.0))
                        .child(
                            div()
                                .min_w_0()
                                .child(popover::dialog_title(&theme, &format!("AI Harness · {project}")))
                                .child(
                                    div()
                                        .mt(px(4.0))
                                        .truncate()
                                        .text_size(px(11.0))
                                        .text_color(theme.text_faint)
                                        .child(cwd),
                                ),
                        )
                        .child(
                            popover::btn_ghost(&theme, "Refresh", "harness-refresh")
                                .id("harness-refresh")
                                .opacity(if busy_id.is_some() { 0.55 } else { 1.0 })
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if this.project_harness.as_ref().and_then(|f| f.busy_id.as_ref()).is_none() {
                                        this.load_project_harness(cx);
                                    }
                                })),
                        ),
                )
                .child(
                    div()
                        .mt(px(12.0))
                        .pb(px(12.0))
                        .border_b_1()
                        .border_color(theme.border)
                        .text_size(px(12.0))
                        .text_color(theme.text_muted)
                        .child(format!(
                            "{applied}/{total} applied · Project-level guidelines, shared memory, architecture docs, commands, and skills."
                        )),
                )
                .child(
                    div()
                        .id("project-harness-list")
                        .mt(px(12.0))
                        .overflow_y_scroll()
                        .child(body),
                )
                .child(
                    div()
                        .mt(px(12.0))
                        .pt(px(12.0))
                        .border_t_1()
                        .border_color(theme.border)
                        .flex()
                        .justify_end()
                        .child(
                            popover::btn_ghost(&theme, "Close", "harness-close")
                                .id("harness-close")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if this.project_harness.as_ref().and_then(|f| f.busy_id.as_ref()).is_none() {
                                        this.project_harness = None;
                                        cx.notify();
                                    }
                                })),
                        ),
                )
                .into_any_element();
            overlays.push(popover::modal("project-harness-dialog", viewport, card));
        }

        if let Some(space_id) = self.delete_space_confirm.clone() {
            let (name, device, count) = {
                let state = self.state.read(cx);
                let space = state.space_row(&space_id);
                (
                    space
                        .map(|s| s.display_name().to_string())
                        .unwrap_or_else(|| "this space".into()),
                    space
                        .and_then(|s| state.device_name(&s.device_id))
                        .unwrap_or("its device")
                        .to_string(),
                    state.chats_in_space(&space_id).len(),
                )
            };
            let copy = if count == 1 {
                format!(
                    "Removing “{name}” permanently deletes its 1 session on {device}. This can’t be undone."
                )
            } else {
                format!(
                    "Removing “{name}” permanently deletes its {count} sessions on {device}. This can’t be undone."
                )
            };
            let card = popover::dialog_card(&theme)
                .child(popover::dialog_title(&theme, "Remove space?"))
                .child(div().mt(px(6.0)).child(popover::dialog_body(&theme, copy)))
                .child(
                    div()
                        .mt(px(16.0))
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap(px(8.0))
                        .child(
                            popover::btn_ghost(&theme, "Cancel", "delete-space-cancel")
                                .id("delete-space-cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.delete_space_confirm = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            popover::btn_danger(&theme, "Remove")
                                .id("delete-space-confirm")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.delete_space(space_id.clone(), cx)
                                })),
                        ),
                )
                .into_any_element();
            overlays.push(popover::modal("delete-space-dialog", viewport, card));
        }

        overlays
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use chrono::{TimeDelta, Utc};
    use comet_proto::Chat;

    fn space(id: &str) -> Space {
        Space {
            id: id.to_string(),
            device_id: "d1".to_string(),
            path: format!("/repo/{id}"),
            name: None,
            git_detected: true,
            git_checked_at: None,
            checkout_id: None,
            created_at: Utc::now(),
        }
    }

    fn chat(id: &str, space_id: &str, last_at: chrono::DateTime<chrono::Utc>) -> Chat {
        Chat {
            id: id.to_string(),
            device_id: "d1".to_string(),
            title: Some(format!("Title {id}")),
            archived: false,
            cwd: None,
            branch: None,
            checkout_id: None,
            config: None,
            last_message_preview: None,
            last_message_at: Some(last_at),
            created_at: last_at,
            harness_session_id: None,
            harness_session_cwd: None,
            space_id: Some(space_id.to_string()),
            last_seen_at: None,
            settled_at: None,
        }
    }

    fn sessions_by_space<'a>(
        spaces: &[Space],
        chats: &'a [Chat],
    ) -> std::collections::HashMap<String, Vec<&'a Chat>> {
        let mut map: std::collections::HashMap<String, Vec<&'a Chat>> =
            std::collections::HashMap::new();
        for space in spaces {
            map.insert(
                space.id.clone(),
                chats
                    .iter()
                    .filter(|c| c.space_id.as_deref() == Some(space.id.as_str()))
                    .collect(),
            );
        }
        map
    }

    fn node_ids(tree: &[SidebarTreeNode]) -> Vec<String> {
        tree.iter()
            .map(|n| match n {
                SidebarTreeNode::Space { space_id, .. } => format!("s:{space_id}"),
                SidebarTreeNode::Session { chat_id, .. } => format!("c:{chat_id}"),
                SidebarTreeNode::ShowMore { space_id, .. } => format!("m:{space_id}"),
            })
            .collect()
    }

    // ---- build_sidebar_tree ----

    #[test]
    fn tree_empty_with_no_spaces() {
        let tree = build_sidebar_tree(
            &[],
            &std::collections::HashSet::new(),
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        assert!(tree.is_empty());
    }

    #[test]
    fn tree_single_space_collapsed_has_no_children() {
        let spaces = vec![space("s1")];
        let chats = vec![chat("c1", "s1", Utc::now())];
        let by_space = sessions_by_space(&spaces, &chats);
        let tree = build_sidebar_tree(
            &spaces,
            &std::collections::HashSet::new(),
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        assert_eq!(node_ids(&tree), vec!["s:s1"]);
        assert_eq!(tree.len(), 1);
    }

    #[test]
    fn tree_expanded_space_lists_children_in_tab_order() {
        let spaces = vec![space("s1")];
        let chats = vec![
            chat("c1", "s1", Utc::now()),
            chat("c2", "s1", Utc::now()),
        ];
        let by_space = sessions_by_space(&spaces, &chats);
        let expanded: std::collections::HashSet<String> = ["s1".to_string()].into();
        let tree = build_sidebar_tree(
            &spaces,
            &expanded,
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        assert_eq!(node_ids(&tree), vec!["s:s1", "c:c1", "c:c2"]);
        // Children carry their in-space index + parent space id.
        assert!(matches!(
            &tree[1],
            SidebarTreeNode::Session {
                space_id,
                chat_id,
                in_space_ix
            } if space_id == "s1" && chat_id == "c1" && *in_space_ix == 0
        ));
    }

    #[test]
    fn tree_mixed_expanded_and_collapsed() {
        let spaces = vec![space("s1"), space("s2")];
        let chats = vec![
            chat("c1", "s1", Utc::now()),
            chat("c2", "s1", Utc::now()),
            chat("c3", "s2", Utc::now()),
        ];
        let by_space = sessions_by_space(&spaces, &chats);
        // Only s1 expanded.
        let expanded: std::collections::HashSet<String> = ["s1".to_string()].into();
        let tree = build_sidebar_tree(
            &spaces,
            &expanded,
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        assert_eq!(node_ids(&tree), vec!["s:s1", "c:c1", "c:c2", "s:s2"]);
        // Space ordinals are contiguous even with children interleaved.
        assert!(matches!(
            &tree[3],
            SidebarTreeNode::Space { ordinal: 1, .. }
        ));
    }

    #[test]
    fn tree_empty_space_has_no_children_even_when_expanded() {
        let spaces = vec![space("s1")];
        let by_space = sessions_by_space(&spaces, &[]);
        let expanded: std::collections::HashSet<String> = ["s1".to_string()].into();
        let tree = build_sidebar_tree(
            &spaces,
            &expanded,
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        assert_eq!(node_ids(&tree), vec!["s:s1"]);
    }

    #[test]
    fn tree_respects_manual_space_order() {
        let spaces = vec![space("a"), space("b")];
        let tree = build_sidebar_tree(
            &spaces,
            &std::collections::HashSet::new(),
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
            &["b".to_string(), "a".to_string()],
            &std::collections::HashSet::new(),
        );
        assert_eq!(node_ids(&tree), vec!["s:b", "s:a"]);
    }

    #[test]
    fn tree_keys_are_unique_and_prefixed() {
        let spaces = vec![space("a"), space("b")];
        let chats = vec![chat("c1", "a", Utc::now())];
        let by_space = sessions_by_space(&spaces, &chats);
        let expanded: std::collections::HashSet<String> = ["a".to_string()].into();
        let tree = build_sidebar_tree(
            &spaces,
            &expanded,
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        let keys: std::collections::HashSet<String> =
            tree.iter().map(tree_node_key).collect();
        assert_eq!(keys.len(), tree.len(), "space and chat keys must not collide");
        // A space named like a chat id must still key distinctly.
        assert!(tree.iter().all(|n| match n {
            SidebarTreeNode::Space { .. } => tree_node_key(n).starts_with("s:"),
            SidebarTreeNode::Session { .. } => tree_node_key(n).starts_with("c:"),
            SidebarTreeNode::ShowMore { .. } => tree_node_key(n).starts_with("m:"),
        }));
    }

    // ---- build_sidebar_tree: session cap + View more/Hide more ----

    #[test]
    fn tree_truncates_sessions_beyond_cap() {
        let spaces = vec![space("s1")];
        let chats: Vec<Chat> = (0..7)
            .map(|ix| chat(&format!("c{ix}"), "s1", Utc::now()))
            .collect();
        let by_space = sessions_by_space(&spaces, &chats);
        let expanded: std::collections::HashSet<String> = ["s1".to_string()].into();
        let tree = build_sidebar_tree(
            &spaces,
            &expanded,
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        // Space + first 5 sessions + disclosure row.
        assert_eq!(
            node_ids(&tree),
            vec!["s:s1", "c:c0", "c:c1", "c:c2", "c:c3", "c:c4", "m:s1"]
        );
        assert!(matches!(
            &tree[6],
            SidebarTreeNode::ShowMore {
                space_id,
                shown,
                total
            } if space_id == "s1" && *shown == 5 && *total == 7
        ));
        // The space node counts only the visible children.
        assert!(matches!(
            &tree[0],
            SidebarTreeNode::Space { child_count, .. } if *child_count == 5
        ));
    }

    #[test]
    fn tree_show_all_lists_every_session() {
        let spaces = vec![space("s1")];
        let chats: Vec<Chat> = (0..7)
            .map(|ix| chat(&format!("c{ix}"), "s1", Utc::now()))
            .collect();
        let by_space = sessions_by_space(&spaces, &chats);
        let expanded: std::collections::HashSet<String> = ["s1".to_string()].into();
        let show_all: std::collections::HashSet<String> = ["s1".to_string()].into();
        let tree = build_sidebar_tree(
            &spaces,
            &expanded,
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &show_all,
        );
        assert_eq!(
            node_ids(&tree),
            vec![
                "s:s1",
                "c:c0",
                "c:c1",
                "c:c2",
                "c:c3",
                "c:c4",
                "c:c5",
                "c:c6",
                "m:s1"
            ]
        );
        // shown == total → the row renders "Hide more".
        assert!(matches!(
            &tree[8],
            SidebarTreeNode::ShowMore { shown, total, .. } if *shown == 7 && *total == 7
        ));
    }

    #[test]
    fn tree_under_cap_has_no_show_more() {
        let spaces = vec![space("s1")];
        let chats: Vec<Chat> = (0..3)
            .map(|ix| chat(&format!("c{ix}"), "s1", Utc::now()))
            .collect();
        let by_space = sessions_by_space(&spaces, &chats);
        let expanded: std::collections::HashSet<String> = ["s1".to_string()].into();
        let tree = build_sidebar_tree(
            &spaces,
            &expanded,
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        assert_eq!(node_ids(&tree), vec!["s:s1", "c:c0", "c:c1", "c:c2"]);
    }

    #[test]
    fn tree_cap_does_not_leak_into_collapsed_spaces() {
        // A collapsed space with > 5 sessions shows only the space row — no
        // children and no disclosure (it would imply children are visible).
        let spaces = vec![space("s1")];
        let chats: Vec<Chat> = (0..7)
            .map(|ix| chat(&format!("c{ix}"), "s1", Utc::now()))
            .collect();
        let by_space = sessions_by_space(&spaces, &chats);
        let tree = build_sidebar_tree(
            &spaces,
            &std::collections::HashSet::new(),
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        assert_eq!(node_ids(&tree), vec!["s:s1"]);
    }

    // ---- tree_drop_over ----

    #[test]
    fn drop_over_maps_children_to_parent_space() {
        let spaces = vec![space("s1"), space("s2"), space("s3")];
        let chats = vec![
            chat("c1", "s1", Utc::now()),
            chat("c2", "s1", Utc::now()),
        ];
        let by_space = sessions_by_space(&spaces, &chats);
        let expanded: std::collections::HashSet<String> = ["s1".to_string()].into();
        let tree = build_sidebar_tree(
            &spaces,
            &expanded,
            &by_space,
            &std::collections::HashMap::new(),
            &[],
            &std::collections::HashSet::new(),
        );
        let slot = super::nav::CHAT_ROW_HEIGHT;
        // Pointer on s1's own row → s1 (0).
        assert_eq!(tree_drop_over(&tree, 0.0), 0);
        // Pointer on s1's session children → still s1 (0).
        assert_eq!(tree_drop_over(&tree, slot * 1.0), 0);
        assert_eq!(tree_drop_over(&tree, slot * 2.0 - 1.0), 0);
        // Pointer on s2's row → s2 (1).
        assert_eq!(tree_drop_over(&tree, slot * 3.0), 1);
        // Pointer on s3's row → s3 (2).
        assert_eq!(tree_drop_over(&tree, slot * 4.0), 2);
        // Past the last row clamps to the last space.
        assert_eq!(tree_drop_over(&tree, slot * 100.0), 2);
    }

    #[test]
    fn drop_over_empty_tree_is_zero() {
        assert_eq!(tree_drop_over(&[], 42.0), 0);
    }

    // ---- recent_sessions ----

    #[test]
    fn recent_sessions_sorts_by_recency_and_limits() {
        let mut state = AppState::new();
        state.spaces = vec![space("s1"), space("s2")];
        let now = Utc::now();
        state.chats = vec![
            chat("old", "s1", now - TimeDelta::hours(2)),
            chat("mid", "s2", now - TimeDelta::hours(1)),
            chat("new", "s1", now - TimeDelta::minutes(5)),
        ];
        let rows = recent_sessions(&state, now, 3);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].chat_id, "new");
        assert_eq!(rows[1].chat_id, "mid");
        assert_eq!(rows[2].chat_id, "old");
        assert_eq!(rows[0].space_id.as_deref(), Some("s1"));
    }

    #[test]
    fn recent_sessions_respects_limit() {
        let mut state = AppState::new();
        state.spaces = vec![space("s1")];
        let now = Utc::now();
        state.chats = (0..5)
            .map(|ix| chat(&format!("c{ix}"), "s1", now - TimeDelta::minutes(ix as i64)))
            .collect();
        let rows = recent_sessions(&state, now, 3);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].chat_id, "c0");
    }

    #[test]
    fn recent_sessions_excludes_archived_and_dangling() {
        let mut state = AppState::new();
        state.spaces = vec![space("s1")];
        let now = Utc::now();
        state.chats = vec![
            chat("ok", "s1", now - TimeDelta::minutes(2)),
            chat("archived", "s1", now - TimeDelta::minutes(1)),
            chat("dangling", "ghost-space", now - TimeDelta::minutes(1)),
        ];
        state.chats[1].archived = true;
        let rows = recent_sessions(&state, now, 5);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].chat_id, "ok");
    }

    #[test]
    fn recent_rows_carry_display_fields() {
        let mut state = AppState::new();
        state.spaces = vec![space("s1")];
        let now = Utc::now();
        state.chats = vec![chat("c1", "s1", now - TimeDelta::minutes(2))];
        let rows = recent_sessions(&state, now, 3);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Title c1");
        assert!(!rows[0].time_ago.is_empty());
        assert_eq!(rows[0].status, ChatIndicator::Completed);
    }
}
