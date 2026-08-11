
use chrono::Utc;
use gpui::{
    AnyElement, App, Context, IntoElement,
    MouseButton, MouseDownEvent, SharedString, Window, div, prelude::*, px,
};


use crate::dev_inspector::{self, InspectClickExt as _, InspectExt as _};
use crate::icons::{self, icon};
use crate::loaders;
use crate::motion::{self};
use crate::state::format_time_ago;
use crate::theme::Theme;

use super::layout::SettingsSection;
use super::spaces::{self};
use super::Shell;

impl Shell {
    pub(super) fn render_settings_nav(
        &mut self,
        section: SettingsSection,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let section_icon = |item: SettingsSection| match item {
            SettingsSection::Devices => icons::MONITOR,
            SettingsSection::Agents => icons::KEY_MINIMALISTIC,
            SettingsSection::Providers => icons::GLOBAL,
            SettingsSection::AcpAgents => icons::WIDGET,
            SettingsSection::ContextEngine => icons::MAGNIFER,
            SettingsSection::Notifications => icons::BELL_MINIMALISTIC,
            SettingsSection::Appearance => icons::TUNING,
            SettingsSection::Shortcuts => icons::KEYBOARD,
            SettingsSection::Archived => icons::ARCHIVE_MINIMALISTIC,
            SettingsSection::Workflows => icons::DOCUMENT,
        };
        // Match the user's dragged sidebar width — the pane container clips to
        // it, so a hardcoded default here left hover washes stopping short of
        // the sidebar's right edge (user-reported). Device identity lives on
        // the Accounts page now — the one surface where the device matters.
        div()
            .w(px(self.settings.sidebar_width))
            .h_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_1()
                    .px(px(Theme::SPACE_SM))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .px(px(Theme::SPACE_SM))
                            .pt(px(12.0))
                            .pb(px(4.0))
                            .text_size(px(11.0))
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(theme.text_muted.opacity(0.6))
                            .child(SharedString::from("Settings")),
                    )
                    .child(div().flex().flex_col().gap(px(2.0)).children(
                        SettingsSection::ALL.into_iter().map(|item| {
                            let selected = item == section;
                            div()
                                .id(SharedString::from(format!("settings-nav-{}", item.label())))
                                .inspect_tag("settings-nav-item")
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.0))
                                .rounded(px(8.0))
                                .px(px(Theme::SPACE_SM))
                                .py(px(6.0))
                                .text_size(px(13.0))
                                .when(selected, |el| {
                                    el.bg(crate::theme::wash(0.17))
                                        .font_weight(gpui::FontWeight::MEDIUM)
                                })
                                .text_color(if selected {
                                    theme.text
                                } else {
                                    theme.text_muted
                                })
                                .cursor_pointer()
                                .hover(|s| s.bg(crate::theme::wash(0.11)).text_color(theme.text))
                                .on_click(
                                    cx.listener(move |this, _, _, cx| this.open_settings(item, cx)),
                                )
                                .child(
                                    icon(section_icon(item))
                                        .size(px(16.0))
                                        .text_color(theme.text_muted),
                                )
                                .child(SharedString::from(item.label()))
                        }),
                    )),
            )
            // Back pinned to the bottom (comet settings-sidebar.tsx).
            .child(
                div().px(px(Theme::SPACE_SM)).pb(px(12.0)).child(
                    div()
                        .id("settings-back")
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .rounded(px(8.0))
                        .px(px(Theme::SPACE_SM))
                        .py(px(6.0))
                        .text_size(px(13.0))
                        .text_color(theme.text_muted)
                        .cursor_pointer()
                        .hover(|s| s.bg(crate::theme::wash(0.11)).text_color(theme.text))
                        .on_click(cx.listener(|this, _, _, cx| this.close_settings(cx)))
                        .child(
                            // AltArrowLeft chevron (comet settings-sidebar.tsx),
                            // not the straight history arrow.
                            icon(icons::ALT_ARROW_LEFT)
                                .size(px(16.0))
                                .text_color(theme.text_muted),
                        )
                        .child(SharedString::from("Back")),
                ),
            )
            .into_any_element()
    }

    /// One session row (comet session-row.tsx, compact sidebar-tree §3.4):
    /// status rail on the left (a live 2×3 mini spinner while working, a dot
    /// otherwise), title + relative time on the first line, harness mark +
    /// branch underneath — the folder the row belongs to lives on its space
    /// parent in the tree, so it is not repeated here. Click selects;
    /// right-click opens the context menu.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn render_chat_row(
        &self,
        id: String,
        title: SharedString,
        time_ago: SharedString,
        _space_name: SharedString,
        branch: Option<SharedString>,
        harness: Option<comet_proto::HarnessId>,
        acp_agent_id: Option<String>,
        status: comet_proto::ChatIndicator,
        selected: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Status is a rail, not a word (comet session-row.tsx): always present
        // so rows align and state changes read in place. Working animates (the
        // composer-strip spinner, miniaturized); every other status is a dot.
        let dot_color = spaces::status_dot_color(status, theme);
        let status_rail: AnyElement = if status == comet_proto::ChatIndicator::Working {
            div()
                .w(px(6.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(loaders::mini_gradient_spinner(
                    format!("chat-working-{id}"),
                    2.0,
                    cx.entity_id(),
                    cx,
                ))
                .into_any_element()
        } else {
            div()
                .size(px(6.0))
                .rounded_full()
                .flex_none()
                .bg(dot_color)
                .into_any_element()
        };
        let (hover, text) = (theme.glass_hover(), theme.text);
        let selected_wash = crate::theme::glass_selected_bg();
        let subline = theme.text_muted.opacity(0.5);
        let select_id = id.clone();
        let menu_id = id.clone();
        // Hover fades over transition-colors (comet session-row.tsx) — both
        // the wash and the title brighten ride the same 150ms blend.
        let fade_key = format!("chat-row-{id}");
        let rest_bg = if selected {
            selected_wash
        } else {
            crate::theme::wash(0.0)
        };
        // A selected row must NOT drift toward the hover wash: in dark the two
        // fills are identical so the blend is a no-op, but light's hover sits
        // below its near-opaque selected fill, and blending toward it visibly
        // dimmed the active row under the pointer (user report).
        let hover_bg = if selected { selected_wash } else { hover };
        let rest_text = if selected { text } else { text.opacity(0.8) };
        let chat_inspect = crate::dev_inspector::inspect_meta("sidebar-chat-row");
        let chat_hover_tag = chat_inspect.clone();
        div()
            .id(SharedString::from(format!("chat-{id}")))
            .w_full()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .rounded(px(8.0))
            .px(px(Theme::SPACE_SM))
            // 5px, not 6: the compact 2-line row (17 + 2 + 13 + 10) must fit
            // the tree's uniform 44px slot without clipping.
            .py(px(5.0))
            .text_color(motion::hover_blend(&fade_key, rest_text, text))
            .bg(motion::hover_blend(&fade_key, rest_bg, hover_bg))
            .when(selected, |el| {
                el.shadow(crate::theme::glass_selected_shadows())
            })
            .on_hover(move |hovered: &bool, window: &mut Window, cx: &mut App| {
                motion::hover_listener(&fade_key)(&hovered, window, cx);
                crate::dev_inspector::report_hover(&chat_hover_tag, *hovered, window, cx);
            })
            .inspect_click(chat_inspect)
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                let id = select_id.clone();
                this.state.update(cx, |s, cx| s.select_chat(Some(id), cx));
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                    this.chat_menu = Some((menu_id.clone(), event.position));
                    cx.notify();
                }),
            )
            // Line 1: status rail, title, time-ago (the folder line is gone —
            // the space parent above names it).
            .child(
                div()
                    .w_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(Theme::SPACE_SM))
                    .child(status_rail)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.0))
                            .line_height(px(17.0))
                            .child(title),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(11.0))
                            .text_color(subline)
                            .child(time_ago),
                    ),
            )
            // Line 2 (always): harness brand mark; worktree sessions append
            // the branch icon + name.
            .child(
                div()
                    .w_full()
                    .pl(px(14.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .when_some(
                        harness.map(|harness| {
                            let brand = crate::pickers::harness_brand_icon(
                                harness,
                                acp_agent_id.as_deref(),
                            );
                            let logo = crate::acp_logo::harness_logo_for(
                                harness,
                                acp_agent_id.as_deref(),
                                cx,
                            );
                            let (path, tint) = brand;
                            match logo {
                                // ACP agent with a decoded logo: show the image.
                                Some(crate::acp_logo::Logo::Ready(image)) => gpui::img(image)
                                    .size(px(11.0))
                                    .flex_none()
                                    .into_any_element(),
                                // ACP agent without an icon, or still loading,
                                // or a non-ACP harness: fall back to the static mark.
                                _ => icon(path)
                                    .size(px(11.0))
                                    .flex_none()
                                    .text_color(tint.unwrap_or(subline).opacity(0.8))
                                    .into_any_element(),
                            }
                        }),
                        |el, glyph| el.child(glyph),
                    )
                    .when_some(branch, |el, branch| {
                        el.child(
                            icon(icons::GIT_BRANCH)
                                .size(px(11.0))
                                .flex_none()
                                .text_color(subline),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(px(11.0))
                                .line_height(px(13.0))
                                .text_color(subline)
                                .child(branch),
                        )
                    }),
            )
            .into_any_element()
    }

    /// Which sidebar-list edges have hidden overflow (offset from the LAST
    /// frame — the invisible one-frame lag every fade here rides).
    /// In Projects mode the Sessions list is virtualized (uniform_list with
    /// its own scroll handle); in Activity mode the whole region uses a plain
    /// overflow_y_scroll.
    pub(super) fn sidebar_fade_zones(&self) -> (bool, bool) {
        if self.activity_open {
            let scrolled = -f32::from(self.sidebar_scroll.offset().y);
            let max_scroll = f32::from(self.sidebar_scroll.max_offset().y);
            (scrolled > 1.0, scrolled < max_scroll - 1.0)
        } else {
            // Projects mode: the uniform_list manages its own scroll.
            let state = self.sidebar_chat_scroll.0.borrow();
            let handle = &state.base_handle;
            let scrolled = -f32::from(handle.offset().y);
            let max_scroll = f32::from(handle.max_offset().y);
            (scrolled > 1.0, scrolled < max_scroll - 1.0)
        }
    }

    pub(super) fn render_activity_sidebar(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let now = Utc::now();
        let (active, done): (Vec<_>, Vec<_>) = {
            let state = self.state.read(cx);
            let rows: Vec<_> = state
                .activity_chats(now)
                .into_iter()
                .map(|(status, chat)| (status, chat.clone()))
                .collect();
            rows.into_iter()
                .partition(|(_, chat)| chat.settled_at.is_none())
        };
        let has_activity = !active.is_empty() || !done.is_empty();
        let selected = self.state.read(cx).selected_chat.clone();
        let mut column = div().flex().flex_col().gap(px(2.0));
        let groups = [
            (
                "Needs attention",
                active
                    .iter()
                    .filter(|(status, _)| {
                        matches!(
                            status,
                            comet_proto::ChatIndicator::AwaitingInput
                                | comet_proto::ChatIndicator::Errored
                        )
                    })
                    .collect::<Vec<_>>(),
            ),
            (
                "Completed",
                active
                    .iter()
                    .filter(|(status, _)| *status == comet_proto::ChatIndicator::Completed)
                    .collect::<Vec<_>>(),
            ),
            (
                "Running",
                active
                    .iter()
                    .filter(|(status, _)| *status == comet_proto::ChatIndicator::Working)
                    .collect::<Vec<_>>(),
            ),
            (
                "Seen",
                active
                    .iter()
                    .filter(|(status, _)| *status == comet_proto::ChatIndicator::Idle)
                    .collect::<Vec<_>>(),
            ),
        ];
        for (label, rows) in groups {
            if rows.is_empty() {
                continue;
            }
            column = column.child(
                div()
                    .px(px(Theme::SPACE_SM))
                    .pt(px(8.0))
                    .pb(px(2.0))
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.text_muted.opacity(0.6))
                    .child(SharedString::from(label)),
            );
            for (status, chat) in rows {
                let space = self
                    .state
                    .read(cx)
                    .space_for_chat(chat)
                    .map(|s| s.display_name().to_string())
                    .unwrap_or_else(|| "?".into());
                let branch = chat
                    .branch
                    .as_deref()
                    .map(str::trim)
                    .filter(|b| !b.is_empty())
                    .map(SharedString::from);
                let row = self.render_chat_row(
                    chat.id.clone(),
                    chat.title
                        .clone()
                        .unwrap_or_else(|| "New session".into())
                        .into(),
                    format_time_ago(chat.last_message_at.unwrap_or(chat.created_at), now).into(),
                    space.into(),
                    branch,
                    chat.config.as_ref().map(|c| c.harness),
                    chat.config.as_ref().and_then(|c| c.acp_agent_id.clone()),
                    *status,
                    selected.as_deref() == Some(chat.id.as_str()),
                    theme,
                    cx,
                );
                column = column.child(row);
            }
        }
        if !done.is_empty() {
            let done_count = done.len();
            let toggle = self.activity_done_open;
            column = column.child(
                div()
                    .id("activity-done-toggle")
                    .flex()
                    .flex_row()
                    .justify_between()
                    .px(px(Theme::SPACE_SM))
                    .pt(px(10.0))
                    .pb(px(3.0))
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.text_muted.opacity(0.7))
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.activity_done_open = !this.activity_done_open;
                        cx.notify();
                    }))
                    .child(SharedString::from(format!("Done  {done_count}")))
                    .child(
                        icon(if toggle {
                            icons::ALT_ARROW_DOWN
                        } else {
                            icons::ALT_ARROW_RIGHT
                        })
                        .size(px(12.0)),
                    ),
            );
            if self.activity_done_open {
                for (status, chat) in &done {
                    let space = self
                        .state
                        .read(cx)
                        .space_for_chat(chat)
                        .map(|s| s.display_name().to_string())
                        .unwrap_or_else(|| "?".into());
                    let branch = chat
                        .branch
                        .as_deref()
                        .map(str::trim)
                        .filter(|b| !b.is_empty())
                        .map(SharedString::from);
                    column = column.child(
                        div().opacity(0.6).child(
                            self.render_chat_row(
                                chat.id.clone(),
                                chat.title
                                    .clone()
                                    .unwrap_or_else(|| "New session".into())
                                    .into(),
                                format_time_ago(
                                    chat.last_message_at.unwrap_or(chat.created_at),
                                    now,
                                )
                                .into(),
                                space.into(),
                                branch,
                                chat.config.as_ref().map(|c| c.harness),
                                chat.config.as_ref().and_then(|c| c.acp_agent_id.clone()),
                                *status,
                                selected.as_deref() == Some(chat.id.as_str()),
                                theme,
                                cx,
                            ),
                        ),
                    );
                }
            }
        }
        if !has_activity {
            column = column.child(
                div()
                    .px(px(Theme::SPACE_SM))
                    .pt(px(16.0))
                    .text_size(px(12.0))
                    .text_color(theme.text_faint)
                    .child(SharedString::from("No activity yet")),
            );
        }
        column.into_any_element()
    }

}
