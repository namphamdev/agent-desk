//! `impl Changes` block #4: the git status panel — branch header, fetch/push
//! buttons, staged/unstaged file lists with per-row actions, and the
//! agent/model selector popover wiring.

use gpui::{AnyElement, Context, SharedString, MouseButton, div, prelude::*, px};


use crate::theme::Theme;

use super::render::{add_color, del_color};
use super::Changes;

impl Changes {
    pub(super) fn render_git_status(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let status = self.git_status.clone();
        let busy = self.git_busy.is_some();
        let generation_controls = self.render_generation_controls(theme, cx);
        let button = |id: &'static str, label: SharedString| {
            div()
                .id(id)
                .h(px(26.0))
                .px(px(8.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .border_1()
                .border_color(theme.border)
                .text_size(px(11.0))
                .text_color(if busy {
                    theme.text_faint
                } else {
                    theme.text_muted
                })
                .when(!busy, |el| {
                    el.cursor_pointer()
                        .hover(|s| s.bg(crate::theme::white_alpha(0.06)))
                })
                .child(label)
        };

        let branch = status
            .as_ref()
            .and_then(|s| s.branch.clone())
            .unwrap_or_else(|| "Git changes".to_string());
        let ahead = status.as_ref().map_or(0, |s| s.ahead);
        let behind = status.as_ref().map_or(0, |s| s.behind);

        let mut sections = Vec::new();
        if let Some(status) = &status {
            for (title, files, stage) in [
                (
                    "Staged",
                    status
                        .files
                        .iter()
                        .filter(|file| file.staged)
                        .cloned()
                        .collect::<Vec<_>>(),
                    false,
                ),
                (
                    "Changes",
                    status
                        .files
                        .iter()
                        .filter(|file| file.unstaged)
                        .cloned()
                        .collect::<Vec<_>>(),
                    true,
                ),
            ] {
                if files.is_empty() {
                    continue;
                }
                let all_paths = files
                    .iter()
                    .map(|file| file.path.clone())
                    .collect::<Vec<_>>();
                let action = if stage { "Stage all" } else { "Unstage all" };
                let selected_paths = files
                    .iter()
                    .filter(|file| self.selected_paths.contains(&file.path))
                    .map(|file| file.path.clone())
                    .collect::<Vec<_>>();
                let mut rows = div().flex().flex_col();
                let mut section = div()
                    .flex()
                    .flex_col()
                    .border_b_1()
                    .border_color(crate::theme::white_alpha(0.05))
                    .child(
                        div()
                            .h(px(28.0))
                            .px(px(Theme::SPACE_MD))
                            .flex()
                            .items_center()
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(10.0))
                                    .text_color(theme.text_faint)
                                    .child(SharedString::from(format!(
                                        "{title} ({})",
                                        files.len()
                                    ))),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!(
                                        "git-{}-all",
                                        title.to_lowercase()
                                    )))
                                    .text_size(px(10.0))
                                    .text_color(if stage {
                                        add_color(theme)
                                    } else {
                                        theme.text_muted
                                    })
                                    .when(!busy, |el| el.cursor_pointer())
                                    .when(!busy, |el| {
                                        let paths = all_paths.clone();
                                        el.on_click(cx.listener(move |this, _, _, cx| {
                                            this.run_paths(paths.clone(), stage, cx);
                                        }))
                                    })
                                    .child(SharedString::from(action)),
                            )
                            .when(!selected_paths.is_empty() && !busy, |el| {
                                let paths = selected_paths.clone();
                                el.child(
                                    div()
                                        .id(SharedString::from(format!(
                                            "git-{}-selected",
                                            title.to_lowercase()
                                        )))
                                        .ml(px(8.0))
                                        .text_size(px(10.0))
                                        .text_color(if stage {
                                            add_color(theme)
                                        } else {
                                            theme.text_muted
                                        })
                                        .cursor_pointer()
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.run_paths(paths.clone(), stage, cx);
                                        }))
                                        .child(SharedString::from(if stage {
                                            "Stage selected"
                                        } else {
                                            "Unstage selected"
                                        })),
                                )
                            }),
                    );
                for (ix, file) in files.iter().enumerate() {
                    let path = file.path.clone();
                    let detail_path = path.clone();
                    let menu_file = file.clone();
                    let checked = self.selected_paths.contains(&path);
                    let kind = match file.kind.as_str() {
                        "added" => "A",
                        "deleted" => "D",
                        "renamed" => "R",
                        "copied" => "C",
                        "untracked" => "U",
                        "conflict" => "!",
                        "typechange" => "T",
                        _ => "M",
                    };
                    let kind_color = match file.kind.as_str() {
                        "added" | "untracked" => add_color(theme),
                        "deleted" => del_color(theme),
                        "conflict" => theme.warning,
                        _ => theme.text_faint,
                    };
                    rows = rows.child(
                        div()
                            .id(SharedString::from(format!("git-file-{title}-{ix}")))
                            .h(px(27.0))
                            .px(px(Theme::SPACE_MD))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .cursor_pointer()
                            .hover(|s| s.bg(crate::theme::white_alpha(0.035)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.select_detail(detail_path.clone(), cx);
                            }))
                            .on_mouse_down(
                                MouseButton::Right,
                                cx.listener(move |this, event: &gpui::MouseDownEvent, _, cx| {
                                    this.file_menu = Some((menu_file.clone(), event.position));
                                    cx.notify();
                                }),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!("git-check-{title}-{ix}")))
                                    .size(px(13.0))
                                    .rounded(px(3.0))
                                    .border_1()
                                    .border_color(if checked {
                                        add_color(theme)
                                    } else {
                                        theme.border
                                    })
                                    .bg(if checked {
                                        add_color(theme).opacity(0.25)
                                    } else {
                                        gpui::transparent_black()
                                    })
                                    .text_size(px(10.0))
                                    .text_color(add_color(theme))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(SharedString::from(if checked { "✓" } else { "" }))
                                    .on_click(cx.listener({
                                        let path = file.path.clone();
                                        move |this, _, _, cx| {
                                            this.toggle_path_selection(path.clone(), cx);
                                        }
                                    })),
                            )
                            .child(
                                div()
                                    .w(px(12.0))
                                    .font_family(theme.font_mono.clone())
                                    .text_size(px(10.0))
                                    .text_color(kind_color)
                                    .child(SharedString::from(kind)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .font_family(theme.font_mono.clone())
                                    .text_size(px(11.0))
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(file.path.clone())),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!("git-file-action-{title}-{ix}")))
                                    .px(px(5.0))
                                    .py(px(2.0))
                                    .rounded(px(4.0))
                                    .text_size(px(10.0))
                                    .text_color(theme.text_faint)
                                    .when(!busy, |el| {
                                        el.cursor_pointer()
                                            .hover(|s| s.bg(crate::theme::white_alpha(0.07)))
                                    })
                                    .when(!busy, |el| {
                                        el.on_click(cx.listener(move |this, _, _, cx| {
                                            this.run_paths(vec![path.clone()], stage, cx);
                                        }))
                                    })
                                    .child(SharedString::from(if stage { "Stage" } else { "−" })),
                            ),
                    );
                }
                // Keep the section title and its bulk actions pinned while
                // only its file rows scroll.
                section = section.child(
                    div()
                        .id(SharedString::from(format!(
                            "git-{}-files",
                            title.to_lowercase()
                        )))
                        .max_h(px(180.0))
                        .overflow_y_scroll()
                        .child(rows),
                );
                sections.push(section.into_any_element());
            }
        }

        div()
            .id("git-status-panel")
            .flex_none()
            .flex()
            .flex_col()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .h(px(38.0))
                    .px(px(Theme::SPACE_MD))
                    .flex()
                    .items_center()
                    .gap(px(7.0))
                    .child(
                        crate::icons::icon(crate::icons::GIT_BRANCH)
                            .size(px(14.0))
                            .text_color(theme.text_muted),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.0))
                            .text_color(theme.text)
                            .child(SharedString::from(branch)),
                    )
                    .when(ahead > 0, |el| {
                        el.child(
                            div()
                                .text_size(px(10.0))
                                .text_color(theme.text_faint)
                                .child(SharedString::from(format!("↑{ahead}"))),
                        )
                    })
                    .when(behind > 0, |el| {
                        el.child(
                            div()
                                .text_size(px(10.0))
                                .text_color(theme.text_faint)
                                .child(SharedString::from(format!("↓{behind}"))),
                        )
                    }),
            )
            .child(
                div()
                    .h(px(38.0))
                    .px(px(Theme::SPACE_MD))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        button(
                            "git-refresh",
                            SharedString::from(if self.git_loading {
                                "Refreshing…"
                            } else {
                                "Refresh"
                            }),
                        )
                        .when(!busy && !self.git_loading, |el| {
                            el.on_click(cx.listener(|this, _, _, cx| this.refresh_git(cx)))
                        }),
                    )
                    .child(button("git-fetch", "Fetch".into()).when(!busy, |el| {
                        el.on_click(cx.listener(|this, _, _, cx| this.run_remote(false, cx)))
                    }))
                    .child(button("git-push", "Push".into()).when(!busy, |el| {
                        el.on_click(cx.listener(|this, _, _, cx| this.run_remote(true, cx)))
                    })),
            )
            .child(generation_controls)
            .when_some(self.git_info.clone(), |el, info| {
                el.child(
                    div()
                        .px(px(Theme::SPACE_MD))
                        .py(px(5.0))
                        .text_size(px(10.0))
                        .text_color(theme.text_muted)
                        .child(info),
                )
            })
            // Only the file rows scroll. Branch, network controls, and the
            // agent/model selector remain pinned above them.
            .child(
                div()
                    .id("git-change-list")
                    .flex_none()
                    .flex()
                    .flex_col()
                    .children(sections),
            )
            .into_any_element()
    }
}
