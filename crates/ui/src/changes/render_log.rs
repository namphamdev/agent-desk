//! `impl Changes` block #7: the commit-history section of the git status
//! panel. Toggled by the "History" button — fetches `GitLog` (engine-side
//! `git log -z --name-only`) and lists newest-first commits. Each row expands
//! to reveal the full hash, author, ISO date, message body, and the touched
//! files.

use gpui::{AnyElement, ClipboardItem, Context, SharedString, div, prelude::*, px};

use crate::theme::Theme;

use super::render::{add_color, del_color};
use super::resolve::relative_time;
use super::Changes;

impl Changes {
    /// The history section shown between the network buttons and the file
    /// lists while `git_log_open` is true. `None` when closed.
    pub(super) fn render_log(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.git_log_open {
            return None;
        }
        let commits = self.git_log.clone().unwrap_or_default();
        let count = commits.len();
        let expanded = self.git_log_expanded.clone();
        let now = chrono::Utc::now();

        let header = div()
            .h(px(30.0))
            .px(px(Theme::SPACE_MD))
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(10.0))
                    .text_color(theme.text_faint)
                    .child(SharedString::from(format!(
                        "Commit history ({count})"
                    ))),
            )
            .child(
                div()
                    .id("git-log-refresh")
                    .text_size(px(10.0))
                    .text_color(theme.text_faint)
                    .cursor_pointer()
                    .hover(|s| s.text_color(theme.text_muted))
                    .on_click(cx.listener(|this, _, _, cx| this.load_log(cx)))
                    .child(SharedString::from("Refresh")),
            )
            .child(
                div()
                    .id("git-log-close")
                    .text_size(px(12.0))
                    .text_color(theme.text_faint)
                    .cursor_pointer()
                    .hover(|s| s.text_color(theme.text_muted))
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_log(cx)))
                    .child(SharedString::from("×")),
            );

        let body: AnyElement = if self.git_log_loading && self.git_log.is_none() {
            div()
                .h(px(56.0))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(8.0))
                .child(crate::loaders::gradient_spinner(
                    "git-log-loading",
                    theme,
                    2.5,
                    cx.entity_id(),
                    cx,
                ))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.text_faint)
                        .child(SharedString::from("Loading history…")),
                )
                .into_any_element()
        } else if commits.is_empty() {
            div()
                .h(px(40.0))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(11.0))
                .text_color(theme.text_faint)
                .child(SharedString::from("No commits yet"))
                .into_any_element()
        } else {
            let mut rows = div().flex().flex_col();
            for (ix, commit) in commits.iter().enumerate() {
                let hash = commit.hash.clone();
                let short = commit.short_hash.clone();
                let subject = commit.subject.clone();
                let author = commit.author.clone();
                let date = commit.date.clone();
                let relative = relative_time(&date, now);
                let is_expanded = expanded.as_deref() == Some(hash.as_str());
                let body_lines = commit.body.lines().map(str::to_owned).collect::<Vec<_>>();
                let files = commit.files.clone();

                let mut row = div()
                    .id(SharedString::from(format!("git-log-commit-{ix}")))
                    .flex_none()
                    .flex()
                    .flex_col()
                    .cursor_pointer()
                    .hover(|s| s.bg(crate::theme::white_alpha(0.035)))
                    .on_click({
                        let click_hash = hash.clone();
                        cx.listener(move |this, _, _, cx| {
                            this.toggle_log_commit(click_hash.clone(), cx);
                        })
                    })
                    .child(
                        div()
                            .h(px(34.0))
                            .px(px(Theme::SPACE_MD))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .w(px(52.0))
                                    .font_family(theme.font_mono.clone())
                                    .text_size(px(10.0))
                                    .text_color(add_color(theme))
                                    .child(SharedString::from(short)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(11.0))
                                    .text_color(theme.text)
                                    .child(SharedString::from(subject)),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .text_size(px(10.0))
                                    .text_color(theme.text_faint)
                                    .child(SharedString::from(relative)),
                            ),
                    );

                if is_expanded {
                    let copy_hash = hash.clone();
                    let mut detail = div()
                        .px(px(Theme::SPACE_MD))
                        .pb(px(8.0))
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .font_family(theme.font_mono.clone())
                                        .text_size(px(10.0))
                                        .text_color(theme.text_muted)
                                        .child(SharedString::from(hash.clone())),
                                )
                                .child(
                                    div()
                                        .id(SharedString::from(format!(
                                            "git-log-copy-{ix}"
                                        )))
                                        .text_size(px(10.0))
                                        .text_color(theme.text_faint)
                                        .cursor_pointer()
                                        .hover(|s| s.text_color(theme.text_muted))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                copy_hash.clone(),
                                            ));
                                            this.git_info =
                                                Some("Commit hash copied.".into());
                                            cx.notify();
                                        }))
                                        .child(SharedString::from("Copy")),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(10.0))
                                .text_color(theme.text_faint)
                                .child(SharedString::from(format!("{author}  ·  {date}"))),
                        );

                    if !body_lines.is_empty() {
                        let mut body = div().flex().flex_col().gap(px(2.0));
                        for line in body_lines {
                            body = body.child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(line)),
                            );
                        }
                        detail = detail.child(body);
                    }
                    if !files.is_empty() {
                        let mut files_div = div().mt(px(2.0)).flex().flex_col().gap(px(1.0));
                        for file in files {
                            files_div = files_div.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .w(px(8.0))
                                            .text_size(px(10.0))
                                            .text_color(del_color(theme))
                                            .child(SharedString::from("•")),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .font_family(theme.font_mono.clone())
                                            .text_size(px(10.0))
                                            .text_color(theme.text_dim)
                                            .child(SharedString::from(file)),
                                    ),
                            );
                        }
                        detail = detail.child(files_div);
                    }
                    row = row.child(
                        div()
                            .border_l_2()
                            .border_color(theme.border)
                            .ml(px(Theme::SPACE_MD))
                            .pl(px(8.0))
                            .child(detail),
                    );
                }
                rows = rows.child(row);
                if ix + 1 < commits.len() {
                    rows = rows.child(
                        div()
                            .h(px(1.0))
                            .mx(px(Theme::SPACE_MD))
                            .bg(crate::theme::white_alpha(0.04)),
                    );
                }
            }
            div()
                .id("git-log-list")
                .max_h(px(280.0))
                .overflow_y_scroll()
                .track_scroll(&self.git_log_scroll)
                .child(rows)
                .into_any_element()
        };

        Some(
            div()
                .id("git-log-panel")
                .flex_none()
                .flex()
                .flex_col()
                .border_b_1()
                .border_color(crate::theme::white_alpha(0.05))
                .child(header)
                .child(body)
                .into_any_element(),
        )
    }
}
