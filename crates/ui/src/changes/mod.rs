//! viewer over `WatchCheckoutDiffs`.
//!
//! - pure patch parser: `diff --git` sections → file/hunk/line/notice rows,
//!   with add/delete/rename/binary detection and per-file counts;
//! - resolution: the shown diff matches the selected chat by `checkout_id`
//!   first, then by device+cwd, then cwd alone;
//! - states: *preparing* (no diff yet), *clean* (empty patch), *list*; a watch
//!   error shows a banner while the last content stays;
//! - virtualized with gpui `list()` — one row per file section; each section
//!   collapses with a 180 ms height tween (analytic heights, no measurement)
//!   and a 200 ms chevron transition;
//! - syntax highlight reuses the markdown tokenizer per diff line, computed
//!   time-sliced on the background executor and applied as paint-only run
//!   colors (layout never changes).

mod entity;
mod patch;
mod render;
mod render_file;
mod render_form;
mod render_status;
mod resolve;
mod state_impl;
mod watch_impl;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use gpui::{
    AnyElement, Context, Entity, ListState, SharedString, Subscription, Task,
    Window, div, prelude::*, px,
};

use comet_engine::registry::HarnessDescriptor;
use comet_proto::CheckoutDiff;
use comet_proto::{HarnessId, Model};

use crate::composer::ComposerInput;
use crate::settings::composer::ComposerDefaults;
use crate::state::AppState;
use crate::theme::Theme;

// Re-export the public surface so existing callers (`crate::changes::…`) keep
// working unchanged.
pub(crate) use entity::{FileFold, HighlightSlot, ParsedDiff};
pub use patch::{
    DiffLine, FileDiff, FileStatus, Hunk, LineKind, body_height, file_notices, parse_git_paths,
    parse_hunk_header, parse_patch,
};
pub use resolve::{
    DiffPhase, apply_diff_frame, diff_phase, lang_for_path, resolve_diff, uncommitted_label,
};
pub(crate) use resolve::{GitFileChange, GitGenerationPicker, GitStatus};

// ---------------------------------------------------------------------------
// Layout numbers (analytic — they drive the fold tween)
// ---------------------------------------------------------------------------

pub const FILE_HEADER_HEIGHT: f32 = 36.0;
pub const HUNK_HEADER_HEIGHT: f32 = 28.0;
pub const DIFF_LINE_HEIGHT: f32 = 21.0;
pub const NOTICE_HEIGHT: f32 = 24.0;
pub const BODY_BOTTOM_PAD: f32 = 8.0;
/// Gutter width per line-number column.
pub const GUTTER_WIDTH: f32 = 36.0;
/// The +/−/· marker column between the gutters and the code.
pub const MARKER_WIDTH: f32 = 28.0;
/// Width of the coloured accent bar on the left edge of +/− rows.
pub const ACCENT_BAR_WIDTH: f32 = 3.0;
pub(super) const DIFF_TEXT_SIZE: f32 = 12.0;

// ---------------------------------------------------------------------------
// Entity (struct definition — the impl blocks live in sibling files)
// ---------------------------------------------------------------------------

/// The Changes pane entity. Lazy: no RPC until [`Changes::ensure_watch`] runs
/// (the shell calls it when the pane first opens).
pub struct Changes {
    pub(super) state: Entity<AppState>,
    pub(super) diffs: Vec<CheckoutDiff>,
    pub(super) started: bool,
    pub(super) error: Option<SharedString>,
    /// Device the running watch targets: `None` = the connected engine itself,
    /// `Some(id)` = a remote chat's host (relay-forwarded). The stream only
    /// carries the TARGET device's checkouts, so a selection change onto a
    /// chat hosted elsewhere tears the watch down and re-subscribes.
    pub(super) watch_target: Option<String>,
    pub(super) watch_task: Option<Task<()>>,
    pub(super) parsed: Option<ParsedDiff>,
    pub(super) parse_task: Option<Task<()>>,
    pub(super) folds: HashMap<String, FileFold>,
    pub(super) highlights: HashMap<String, HighlightSlot>,
    pub(super) list: ListState,
    pub(super) git_status: Option<GitStatus>,
    pub(super) git_context_key: Option<String>,
    pub(super) git_loading: bool,
    pub(super) git_busy: Option<&'static str>,
    pub(super) git_info: Option<SharedString>,
    pub(super) generation_loading: bool,
    pub(super) generation_picker: Option<GitGenerationPicker>,
    pub(super) selected_paths: HashSet<String>,
    pub(super) selected_detail: Option<String>,
    pub(super) file_menu: Option<(GitFileChange, gpui::Point<gpui::Pixels>)>,
    pub(super) detail_scroll: gpui::ScrollHandle,
    pub(super) generation_defaults: ComposerDefaults,
    pub(super) generation_defaults_dir: Option<std::path::PathBuf>,
    pub(super) harnesses: Vec<HarnessDescriptor>,
    pub(super) models: Vec<Model>,
    pub(super) selected_harness: Option<HarnessId>,
    pub(super) selected_model: Option<String>,
    pub(super) generation_scroll: gpui::ScrollHandle,
    pub(super) model_search: Entity<ComposerInput>,
    pub(super) _model_search_events: Subscription,
    pub(super) subject: Entity<ComposerInput>,
    pub(super) body: Entity<ComposerInput>,
    pub(super) git_task: Option<Task<()>>,
    pub(super) generation_task: Option<Task<()>>,
    pub(super) _subject_events: Subscription,
    pub(super) _body_events: Subscription,
    pub(super) _observe: Subscription,
}

impl Render for Changes {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let resolved = self.resolved(cx);
        let phase = diff_phase(resolved.as_ref());
        let error = self.error.clone();

        let content: AnyElement = match phase {
            DiffPhase::Preparing => div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(Theme::SPACE_SM))
                .child(crate::loaders::gradient_spinner(
                    "changes-preparing",
                    &theme,
                    3.0,
                    cx.entity_id(),
                    cx,
                ))
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(theme.text_faint)
                        .child(SharedString::from("Preparing diff…")),
                )
                .into_any_element(),
            DiffPhase::Clean => div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(12.0))
                .text_color(theme.text_faint)
                .child(SharedString::from("No uncommitted changes"))
                .into_any_element(),
            DiffPhase::List => {
                if let Some(parsed) = &self.parsed {
                    let selected = self
                        .selected_detail
                        .as_deref()
                        .and_then(|path| parsed.files.iter().position(|file| file.path == path));
                    if let Some(ix) = selected {
                        div()
                            .id("git-selected-file-diff")
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .flex_col()
                            .overflow_y_scroll()
                            .track_scroll(&self.detail_scroll)
                            .child(self.render_row(ix, window, cx))
                            .into_any_element()
                    } else {
                        div()
                            .flex_1()
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(12.0))
                            .text_color(theme.text_faint)
                            .child(SharedString::from("Select a changed file to view its diff"))
                            .into_any_element()
                    }
                } else {
                    // Diff known, parse still running.
                    div()
                        .flex_1()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(crate::loaders::gradient_spinner(
                            "changes-parsing",
                            &theme,
                            3.0,
                            cx.entity_id(),
                            cx,
                        ))
                        .into_any_element()
                }
            }
        };

        let root = div()
            .size_full()
            .min_h_0()
            .flex()
            .flex_col()
            .child(self.render_git_status(&theme, cx))
            .when_some(error, |el, message| {
                el.child(
                    div()
                        .flex_none()
                        .px(px(Theme::SPACE_MD))
                        .py(px(4.0))
                        .border_b_1()
                        .border_color(theme.border)
                        .text_size(px(11.0))
                        .text_color(theme.warning)
                        .child(message),
                )
            })
            .child(content)
            .child(self.render_commit(&theme, cx));
        if let Some(menu) = self.render_file_menu(&theme, cx) {
            root.child(menu)
        } else {
            root
        }
    }
}
