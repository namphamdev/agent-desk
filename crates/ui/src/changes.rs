//! The right-pane "Changes" content (feature-inventory §1.11): a unified-diff
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

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, ListAlignment, ListState, MouseButton,
    SharedString, Subscription, Task, Window, div, font, prelude::*, px,
};
use serde::Deserialize;

use comet_engine::registry::HarnessDescriptor;
use comet_proto::{Chat, CheckoutDiff};
use comet_proto::{HarnessId, Model};
use comet_rpc::methods;

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::markdown::highlight::{Lang, LineCarry, Token, lang_for_tag, tokenize_line};
use crate::markdown::render;
use crate::motion::{self, AnimationExt as _, CHEVRON, COLLAPSE};
use crate::popover;
use crate::settings::composer::ComposerDefaults;
use crate::state::{AppState, EngineHandle};
use crate::theme::Theme;

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
const DIFF_TEXT_SIZE: f32 = 12.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<GitFileChange>,
    is_repo: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitFileChange {
    path: String,
    #[allow(dead_code)]
    old_path: Option<String>,
    kind: String,
    staged: bool,
    unstaged: bool,
    #[allow(dead_code)]
    xy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedCommitMessage {
    subject: String,
    body: String,
    #[allow(dead_code)]
    raw: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitGenerationPicker {
    Harness,
    Model,
}

// ---------------------------------------------------------------------------
// Patch model + parser (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Context,
    Add,
    Del,
    /// `\ No newline at end of file` and friends.
    Meta,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileDiff {
    /// Display path (the post-change side).
    pub path: String,
    /// Pre-rename path, when different.
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
    /// Parser-collected notices (mode changes etc.).
    pub notices: Vec<String>,
    pub hunks: Vec<Hunk>,
    pub additions: u32,
    pub deletions: u32,
}

impl FileDiff {
    fn new(path: String, old_path: Option<String>) -> Self {
        Self {
            path,
            old_path,
            status: FileStatus::Modified,
            binary: false,
            notices: Vec::new(),
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
        }
    }
}

fn strip_git_prefix(path: &str) -> &str {
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
}

/// Split the tail of a `diff --git a/… b/…` line into (old, new) paths.
/// Quoted paths (spaces/unicode) are handled; for unquoted paths with spaces
/// the split favors the last ` b/` separator, which is git's own convention.
fn parse_git_paths(rest: &str) -> (String, String) {
    fn unquote(s: &str) -> String {
        let trimmed = s.trim();
        if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
            trimmed[1..trimmed.len() - 1]
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
        } else {
            trimmed.to_string()
        }
    }
    if let Some(pos) = rest.rfind(" b/").or_else(|| rest.rfind(" \"b/")) {
        let old = unquote(&rest[..pos]);
        let new = unquote(&rest[pos + 1..]);
        (
            strip_git_prefix(&old).to_string(),
            strip_git_prefix(&new).to_string(),
        )
    } else {
        let p = strip_git_prefix(&unquote(rest)).to_string();
        (p.clone(), p)
    }
}

/// Parse one `@@ -a[,b] +c[,d] @@ …` header into starting line numbers.
fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("@@")?;
    let minus = rest.find('-')?;
    let after_minus = &rest[minus + 1..];
    let old: u32 = after_minus
        .split(|c: char| c == ',' || c.is_whitespace())
        .next()?
        .parse()
        .ok()?;
    let plus = rest.find('+')?;
    let after_plus = &rest[plus + 1..];
    let new: u32 = after_plus
        .split(|c: char| c == ',' || c.is_whitespace())
        .next()?
        .parse()
        .ok()?;
    Some((old, new))
}

/// Parse a unified git patch into file sections. Tolerant: unknown header
/// lines are skipped, truncated hunks keep what parsed so far.
pub fn parse_patch(patch: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut in_hunk = false;
    let mut old_no: u32 = 0;
    let mut new_no: u32 = 0;

    for raw in patch.lines() {
        if let Some(rest) = raw.strip_prefix("diff --git ") {
            let (old, new) = parse_git_paths(rest);
            let old_path = (old != new).then_some(old);
            files.push(FileDiff::new(new, old_path));
            in_hunk = false;
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };

        if raw.starts_with("@@") {
            if let Some((o, n)) = parse_hunk_header(raw) {
                old_no = o;
                new_no = n;
                file.hunks.push(Hunk {
                    header: raw.to_string(),
                    lines: Vec::new(),
                });
                in_hunk = true;
            }
            continue;
        }

        if in_hunk {
            let mut chars = raw.chars();
            let marker = chars.next();
            let body: String = chars.collect();
            let line = match marker {
                Some('+') => {
                    file.additions += 1;
                    let l = DiffLine {
                        kind: LineKind::Add,
                        old_no: None,
                        new_no: Some(new_no),
                        text: body,
                    };
                    new_no += 1;
                    Some(l)
                }
                Some('-') => {
                    file.deletions += 1;
                    let l = DiffLine {
                        kind: LineKind::Del,
                        old_no: Some(old_no),
                        new_no: None,
                        text: body,
                    };
                    old_no += 1;
                    Some(l)
                }
                Some(' ') | None => {
                    let l = DiffLine {
                        kind: LineKind::Context,
                        old_no: Some(old_no),
                        new_no: Some(new_no),
                        text: body,
                    };
                    old_no += 1;
                    new_no += 1;
                    Some(l)
                }
                Some('\\') => Some(DiffLine {
                    kind: LineKind::Meta,
                    old_no: None,
                    new_no: None,
                    text: raw.trim_start_matches('\\').trim().to_string(),
                }),
                _ => {
                    // A non-hunk line ends the hunk; reprocess as a header.
                    in_hunk = false;
                    None
                }
            };
            if let Some(line) = line
                && let Some(hunk) = file.hunks.last_mut()
            {
                hunk.lines.push(line);
                continue;
            }
            if in_hunk {
                continue;
            }
        }

        // File header territory.
        if raw.starts_with("new file mode") {
            file.status = FileStatus::Added;
        } else if raw.starts_with("deleted file mode") {
            file.status = FileStatus::Deleted;
        } else if let Some(from) = raw.strip_prefix("rename from ") {
            file.status = FileStatus::Renamed;
            file.old_path = Some(from.trim().to_string());
        } else if let Some(to) = raw.strip_prefix("rename to ") {
            file.status = FileStatus::Renamed;
            file.path = to.trim().to_string();
        } else if raw.starts_with("Binary files") || raw.starts_with("GIT binary patch") {
            file.binary = true;
        } else if let Some(mode) = raw.strip_prefix("new mode ") {
            file.notices
                .push(format!("Mode changed to {}", mode.trim()));
        } else if let Some(new) = raw.strip_prefix("+++ ") {
            let new = new.trim();
            if new == "/dev/null" {
                file.status = FileStatus::Deleted;
            } else if file.old_path.is_none() {
                file.path = strip_git_prefix(new).to_string();
            }
        } else if let Some(old) = raw.strip_prefix("--- ")
            && old.trim() == "/dev/null"
        {
            file.status = FileStatus::Added;
        }
        // "index …", "similarity index …", "old mode …" etc.: skipped.
    }
    files
}

/// Derived per-file notice rows (new/deleted/renamed/binary + parser notices).
pub fn file_notices(file: &FileDiff) -> Vec<String> {
    let mut notices = Vec::new();
    match file.status {
        FileStatus::Added => notices.push("New file".to_string()),
        FileStatus::Deleted => notices.push("Deleted file".to_string()),
        FileStatus::Renamed => {
            let from = file.old_path.as_deref().unwrap_or("?");
            notices.push(format!("Renamed from {from}"));
        }
        FileStatus::Modified => {}
    }
    if file.binary {
        notices.push("Binary file — contents not shown".to_string());
    }
    notices.extend(file.notices.iter().cloned());
    notices
}

/// Analytic expanded-body height — drives the 180 ms fold tween without
/// measurement.
pub fn body_height(file: &FileDiff) -> f32 {
    let notices = file_notices(file).len() as f32 * NOTICE_HEIGHT;
    let hunks = file.hunks.len() as f32 * HUNK_HEADER_HEIGHT;
    let lines: usize = file.hunks.iter().map(|h| h.lines.len()).sum();
    notices + hunks + lines as f32 * DIFF_LINE_HEIGHT + BODY_BOTTOM_PAD
}

// ---------------------------------------------------------------------------
// Resolution + states (pure)
// ---------------------------------------------------------------------------

/// The diff shown for a chat: `checkout_id` match first, then device+cwd,
/// then cwd alone (§1.11).
pub fn resolve_diff<'a>(diffs: &'a [CheckoutDiff], chat: &Chat) -> Option<&'a CheckoutDiff> {
    if let Some(checkout_id) = chat.checkout_id.as_deref()
        && let Some(diff) = diffs.iter().find(|d| d.checkout_id == checkout_id)
    {
        return Some(diff);
    }
    let cwd = chat.cwd.as_deref()?;
    diffs
        .iter()
        .find(|d| d.device_id == chat.device_id && d.cwd == cwd)
        .or_else(|| diffs.iter().find(|d| d.cwd == cwd))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffPhase {
    /// No diff for this checkout yet.
    Preparing,
    /// Diff arrived and it's empty — working tree clean.
    Clean,
    List,
}

pub fn diff_phase(resolved: Option<&CheckoutDiff>) -> DiffPhase {
    match resolved {
        None => DiffPhase::Preparing,
        Some(diff) if diff.patch.trim().is_empty() && diff.files.is_empty() => DiffPhase::Clean,
        Some(_) => DiffPhase::List,
    }
}

/// Header label: "N Uncommitted change(s)".
pub fn uncommitted_label(count: usize) -> String {
    if count == 1 {
        "1 Uncommitted change".to_string()
    } else {
        format!("{count} Uncommitted changes")
    }
}

/// Fold a `WatchCheckoutDiffs` frame into the diff set. Accepts either a full
/// list (replace) or a single `CheckoutDiff` (upsert by checkout id) — the
/// contract streams `CheckoutDiff` items, but list frames cost nothing to
/// support. Returns whether anything changed.
pub fn apply_diff_frame(diffs: &mut Vec<CheckoutDiff>, value: serde_json::Value) -> bool {
    if let Ok(all) = serde_json::from_value::<Vec<CheckoutDiff>>(value.clone()) {
        if *diffs != all {
            *diffs = all;
            return true;
        }
        return false;
    }
    match serde_json::from_value::<CheckoutDiff>(value) {
        Ok(one) => {
            if let Some(existing) = diffs.iter_mut().find(|d| d.checkout_id == one.checkout_id) {
                if *existing == one {
                    return false;
                }
                *existing = one;
            } else {
                diffs.push(one);
            }
            true
        }
        Err(err) => {
            tracing::warn!(error = %err, "changes: dropping malformed diff frame");
            false
        }
    }
}

/// Language for a file path's extension (drives per-line highlighting).
pub fn lang_for_path(path: &str) -> Option<Lang> {
    let ext = path.rsplit('/').next()?.rsplit('.').next()?;
    lang_for_tag(ext)
}

fn hash64(parts: &[&str]) -> u64 {
    let mut hasher = std::hash::DefaultHasher::new();
    for p in parts {
        p.hash(&mut hasher);
    }
    hasher.finish()
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

struct ParsedDiff {
    /// `checkout_id:checksum` — identity of the parsed content.
    key: String,
    files: Arc<Vec<FileDiff>>,
}

#[derive(Default, Clone, Copy)]
struct FileFold {
    collapsed: bool,
    /// Bumped per toggle — keys the height tween + chevron transition.
    epoch: usize,
    from: f32,
    to: f32,
    /// When the toggle happened: the tweens are armed only briefly after the
    /// click — gpui replays an element's animation on remount, and in the
    /// virtualized list a row scrolling back into view is a remount (the
    /// transcript's tool groups had the same flash; user report).
    toggled_at: Option<std::time::Instant>,
}

/// Tween arming window after a fold toggle (COLLAPSE's 180ms plus margin).
const FOLD_TWEEN_WINDOW: Duration = Duration::from_millis(400);

impl FileFold {
    fn animating(&self) -> bool {
        self.epoch > 0
            && self
                .toggled_at
                .is_some_and(|at| at.elapsed() < FOLD_TWEEN_WINDOW)
    }
}

struct HighlightSlot {
    fingerprint: u64,
    lines: Option<Arc<Vec<Vec<Token>>>>,
    _task: Option<Task<()>>,
}

async fn yield_now() {
    let mut yielded = false;
    futures::future::poll_fn(move |cx| {
        if yielded {
            std::task::Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    })
    .await
}

/// The Changes pane entity. Lazy: no RPC until [`Changes::ensure_watch`] runs
/// (the shell calls it when the pane first opens).
pub struct Changes {
    state: Entity<AppState>,
    diffs: Vec<CheckoutDiff>,
    started: bool,
    error: Option<SharedString>,
    /// Device the running watch targets: `None` = the connected engine itself,
    /// `Some(id)` = a remote chat's host (relay-forwarded). The stream only
    /// carries the TARGET device's checkouts, so a selection change onto a
    /// chat hosted elsewhere tears the watch down and re-subscribes.
    watch_target: Option<String>,
    watch_task: Option<Task<()>>,
    parsed: Option<ParsedDiff>,
    parse_task: Option<Task<()>>,
    folds: HashMap<String, FileFold>,
    highlights: HashMap<String, HighlightSlot>,
    list: ListState,
    git_status: Option<GitStatus>,
    git_context_key: Option<String>,
    git_loading: bool,
    git_busy: Option<&'static str>,
    git_info: Option<SharedString>,
    generation_loading: bool,
    generation_picker: Option<GitGenerationPicker>,
    selected_paths: HashSet<String>,
    selected_detail: Option<String>,
    file_menu: Option<(GitFileChange, gpui::Point<gpui::Pixels>)>,
    detail_scroll: gpui::ScrollHandle,
    generation_defaults: ComposerDefaults,
    generation_defaults_dir: Option<std::path::PathBuf>,
    harnesses: Vec<HarnessDescriptor>,
    models: Vec<Model>,
    selected_harness: Option<HarnessId>,
    selected_model: Option<String>,
    generation_scroll: gpui::ScrollHandle,
    model_search: Entity<ComposerInput>,
    _model_search_events: Subscription,
    subject: Entity<ComposerInput>,
    body: Entity<ComposerInput>,
    git_task: Option<Task<()>>,
    generation_task: Option<Task<()>>,
    _subject_events: Subscription,
    _body_events: Subscription,
    _observe: Subscription,
}

impl Changes {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let observe = cx.observe(&state, |this: &mut Self, _, cx| this.sync(cx));
        let subject = cx.new(|cx| ComposerInput::new("Commit subject", cx));
        let body = cx.new(|cx| ComposerInput::new("Description (optional)", cx));
        let model_search = cx.new(|cx| ComposerInput::new("Search models", cx));
        let subject_events = cx
            .subscribe(&subject, |_: &mut Self, _, _: &ComposerInputEvent, cx| {
                cx.notify()
            });
        let body_events = cx.subscribe(&body, |_: &mut Self, _, _: &ComposerInputEvent, cx| {
            cx.notify()
        });
        let model_search_events = cx.subscribe(
            &model_search,
            |_: &mut Self, _, _: &ComposerInputEvent, cx| {
                cx.notify()
            },
        );
        let generation_defaults_dir = state.read(cx).data_dir.clone();
        let generation_defaults = generation_defaults_dir
            .as_deref()
            .map(ComposerDefaults::load)
            .unwrap_or_default();
        Self {
            state,
            diffs: Vec::new(),
            started: false,
            error: None,
            watch_target: None,
            watch_task: None,
            parsed: None,
            parse_task: None,
            folds: HashMap::new(),
            highlights: HashMap::new(),
            list: ListState::new(0, ListAlignment::Top, px(320.0)),
            git_status: None,
            git_context_key: None,
            git_loading: false,
            git_busy: None,
            git_info: None,
            generation_loading: false,
            generation_picker: None,
            selected_paths: HashSet::new(),
            selected_detail: None,
            file_menu: None,
            detail_scroll: gpui::ScrollHandle::new(),
            generation_defaults,
            generation_defaults_dir,
            harnesses: Vec::new(),
            models: Vec::new(),
            selected_harness: None,
            selected_model: None,
            generation_scroll: gpui::ScrollHandle::new(),
            model_search,
            _model_search_events: model_search_events,
            subject,
            body,
            git_task: None,
            generation_task: None,
            _subject_events: subject_events,
            _body_events: body_events,
            _observe: observe,
        }
    }

    fn git_context(&self, cx: &App) -> Option<(String, Option<String>)> {
        let state = self.state.read(cx);
        if let Some(chat) = state.selected_chat_row() {
            let cwd = chat.cwd.clone()?;
            let target = (state.local_device_id.as_deref() != Some(chat.device_id.as_str()))
                .then(|| chat.device_id.clone());
            return Some((cwd, target));
        }

        // The new-session canvas has no chat yet, but the selected Space still
        // identifies the repository whose changes should be shown.
        let space = state.selected_space_row()?;
        let target = (state.local_device_id.as_deref() != Some(space.device_id.as_str()))
            .then(|| space.device_id.clone());
        Some((space.path.clone(), target))
    }

    fn with_git_target(
        cwd: &str,
        target: &Option<String>,
        extra: serde_json::Value,
    ) -> serde_json::Value {
        let mut params = extra.as_object().cloned().unwrap_or_default();
        params.insert("cwd".into(), serde_json::Value::String(cwd.to_string()));
        if let Some(target) = target {
            params.insert(
                "targetDeviceId".into(),
                serde_json::Value::String(target.clone()),
            );
        }
        serde_json::Value::Object(params)
    }

    fn refresh_git(&mut self, cx: &mut Context<Self>) {
        let Some((cwd, target)) = self.git_context(cx) else {
            self.git_status = None;
            self.git_context_key = None;
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let request_key = format!("{}:{cwd}", target.as_deref().unwrap_or("local"));
        self.git_context_key = Some(request_key.clone());
        self.git_loading = true;
        let params = Self::with_git_target(&cwd, &target, serde_json::json!({}));
        // Kick an immediate re-snapshot of the checkout diffs alongside the
        // status poll — the fs watcher may lag, so a manual refresh forces the
        // file-changes list and rendered diffs to reflect the current tree.
        let diff_engine = engine.clone();
        let diff_params = Self::with_git_target(&cwd, &target, serde_json::json!({}));
        cx.spawn(async move |_, _| {
            let _ = diff_engine
                .client()
                .call(methods::REFRESH_DIFFS, diff_params)
                .await;
        })
        .detach();
        self.git_task =
            Some(cx.spawn(async move |this, cx| {
                let result = engine
                    .client()
                    .call_as::<GitStatus>(methods::GIT_STATUS, params)
                    .await;
                this.update(cx, |changes, cx| {
                    if changes.git_context_key.as_deref() != Some(request_key.as_str()) {
                        return;
                    }
                    changes.git_loading = false;
                    match result {
                        Ok(status) => {
                            changes
                                .selected_paths
                                .retain(|path| status.files.iter().any(|file| &file.path == path));
                            if !changes.selected_detail.as_ref().is_some_and(|path| {
                                status.files.iter().any(|file| &file.path == path)
                            }) {
                                changes.selected_detail = status
                                    .files
                                    .iter()
                                    .find(|file| file.unstaged)
                                    .or_else(|| status.files.first())
                                    .map(|file| file.path.clone());
                            }
                            changes.git_status = Some(status);
                        }
                        Err(err) => {
                            changes.error = Some(format!("Git status unavailable: {err}").into())
                        }
                    }
                    cx.notify();
                })
                .ok();
            }));
    }

    fn load_generation_options(&mut self, cx: &mut Context<Self>) {
        if self.generation_loading {
            return;
        }
        let Some((_, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let preferred = self
            .state
            .read(cx)
            .selected_chat_row()
            .and_then(|chat| chat.config.as_ref())
            .map(|config| config.harness)
            .or(self.generation_defaults.harness);
        let preferred_model = self
            .state
            .read(cx)
            .selected_chat_row()
            .and_then(|chat| chat.config.as_ref())
            .and_then(|config| config.model.clone())
            .or_else(|| {
                preferred.and_then(|harness| {
                    self.generation_defaults
                        .model_for(harness)
                        .map(|model| model.id.clone())
                })
            });
        self.generation_loading = true;
        let mut params = serde_json::Map::new();
        if let Some(target) = &target {
            params.insert(
                "targetDeviceId".into(),
                serde_json::Value::String(target.clone()),
            );
        }
        self.generation_task = Some(cx.spawn(async move |this, cx| {
            let listed = engine
                .client()
                .call(methods::LIST_HARNESSES, serde_json::Value::Object(params))
                .await;
            let harnesses = listed
                .and_then(|value| {
                    serde_json::from_value::<Vec<HarnessDescriptor>>(value)
                        .map_err(|error| comet_rpc::RpcError::Failed(error.to_string()))
                })
                .map(|list| {
                    list.into_iter()
                        .filter(|descriptor| descriptor.id != HarnessId::Mock)
                        .collect::<Vec<_>>()
                });
            let selected = harnesses.as_ref().ok().and_then(|list| {
                preferred
                    .filter(|id| list.iter().any(|descriptor| descriptor.id == *id))
                    .or_else(|| list.first().map(|descriptor| descriptor.id))
            });
            let models = if let Some(harness) = selected {
                let mut params = serde_json::json!({ "harness": harness });
                if let (Some(target), Some(object)) = (&target, params.as_object_mut()) {
                    object.insert(
                        "targetDeviceId".into(),
                        serde_json::Value::String(target.clone()),
                    );
                }
                engine.client().call(methods::LIST_MODELS, params).await
            } else {
                Ok(serde_json::json!([]))
            };
            this.update(cx, |changes, cx| {
                changes.generation_loading = false;
                match harnesses {
                    Ok(harnesses) => {
                        changes.harnesses = harnesses;
                        changes.selected_harness = selected;
                        match models {
                            Ok(value) => match serde_json::from_value::<Vec<Model>>(value) {
                                Ok(models) => {
                                    changes.selected_model = preferred_model
                                        .filter(|id| models.iter().any(|model| &model.id == id))
                                        .or_else(|| models.first().map(|model| model.id.clone()));
                                    changes.models = models;
                                }
                                Err(error) => {
                                    changes.error =
                                        Some(format!("Model catalog unavailable: {error}").into())
                                }
                            },
                            Err(error) => {
                                changes.error =
                                    Some(format!("Model catalog unavailable: {error}").into())
                            }
                        }
                    }
                    Err(error) => {
                        changes.error = Some(format!("Agent clients unavailable: {error}").into())
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn select_harness(&mut self, harness: HarnessId, cx: &mut Context<Self>) {
        if self.generation_loading {
            return;
        }
        let Some((_, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.selected_harness = Some(harness);
        self.generation_defaults.harness = Some(harness);
        self.save_generation_defaults();
        self.selected_model = None;
        self.models.clear();
        self.generation_picker = None;
        self.generation_loading = true;
        let mut params = serde_json::json!({ "harness": harness });
        if let (Some(target), Some(object)) = (&target, params.as_object_mut()) {
            object.insert(
                "targetDeviceId".into(),
                serde_json::Value::String(target.clone()),
            );
        }
        // Restore the model last picked for this harness, so switching agents
        // doesn't reset to the catalog's first entry (and the pick survives
        // app restarts via composer-defaults.json).
        let remembered_model = self
            .generation_defaults
            .model_for(harness)
            .map(|model| model.id.clone());
        self.generation_task = Some(cx.spawn(async move |this, cx| {
            let result = engine.client().call(methods::LIST_MODELS, params).await;
            this.update(cx, |changes, cx| {
                changes.generation_loading = false;
                match result {
                    Ok(value) => match serde_json::from_value::<Vec<Model>>(value) {
                        Ok(models) => {
                            changes.selected_model = remembered_model
                                .filter(|id| models.iter().any(|model| &model.id == id))
                                .or_else(|| models.first().map(|model| model.id.clone()));
                            changes.models = models;
                        }
                        Err(error) => {
                            changes.error =
                                Some(format!("Model catalog unavailable: {error}").into())
                        }
                    },
                    Err(error) => {
                        changes.error = Some(format!("Model catalog unavailable: {error}").into())
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn generate_commit_message(&mut self, cx: &mut Context<Self>) {
        if self.git_busy.is_some() {
            return;
        }
        let Some(harness) = self.selected_harness else {
            self.error = Some("Select an agent client.".into());
            cx.notify();
            return;
        };
        let Some((cwd, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.git_busy = Some("generate");
        self.error = None;
        self.git_info = None;
        let params = Self::with_git_target(
            &cwd,
            &target,
            serde_json::json!({
                "harness": harness,
                "model": self.selected_model,
            }),
        );
        self.generation_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call_as::<GeneratedCommitMessage>(methods::GIT_GENERATE_COMMIT_MESSAGE, params)
                .await;
            this.update(cx, |changes, cx| {
                changes.git_busy = None;
                match result {
                    Ok(message) => {
                        changes
                            .subject
                            .update(cx, |input, cx| input.set_text(message.subject, cx));
                        changes
                            .body
                            .update(cx, |input, cx| input.set_text(message.body, cx));
                        changes.git_info = Some("Commit message generated.".into());
                    }
                    Err(error) => {
                        changes.error =
                            Some(format!("Commit message generation failed: {error}").into())
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn run_paths(&mut self, paths: Vec<String>, stage: bool, cx: &mut Context<Self>) {
        if paths.is_empty() || self.git_busy.is_some() {
            return;
        }
        let Some((cwd, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.git_busy = Some(if stage { "stage" } else { "unstage" });
        self.error = None;
        self.git_info = None;
        let params = Self::with_git_target(&cwd, &target, serde_json::json!({ "paths": paths }));
        let method = if stage {
            methods::GIT_STAGE
        } else {
            methods::GIT_UNSTAGE
        };
        self.git_task = Some(cx.spawn(async move |this, cx| {
            let result = engine.client().call(method, params).await;
            this.update(cx, |changes, cx| {
                changes.git_busy = None;
                if let Err(err) = result {
                    changes.error = Some(format!("Git operation failed: {err}").into());
                }
                changes.refresh_git(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn run_remote(&mut self, push: bool, cx: &mut Context<Self>) {
        if self.git_busy.is_some() {
            return;
        }
        let Some((cwd, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.git_busy = Some(if push { "push" } else { "fetch" });
        self.error = None;
        self.git_info = None;
        let params = Self::with_git_target(&cwd, &target, serde_json::json!({}));
        let method = if push {
            methods::GIT_PUSH
        } else {
            methods::GIT_FETCH
        };
        self.git_task = Some(cx.spawn(async move |this, cx| {
            let result = engine.client().call(method, params).await;
            this.update(cx, |changes, cx| {
                changes.git_busy = None;
                match result {
                    Ok(value) => {
                        changes.git_info = value
                            .get("summary")
                            .and_then(|v| v.as_str())
                            .map(|s| SharedString::from(s.to_string()));
                    }
                    Err(err) => changes.error = Some(format!("Git operation failed: {err}").into()),
                }
                changes.refresh_git(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn commit(&mut self, cx: &mut Context<Self>) {
        if self.git_busy.is_some() {
            return;
        }
        let subject = self.subject.read(cx).text().trim().to_string();
        if subject.is_empty() {
            self.error = Some("Enter a commit subject.".into());
            cx.notify();
            return;
        }
        let body = self.body.read(cx).text().trim().to_string();
        let Some((cwd, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.git_busy = Some("commit");
        self.error = None;
        self.git_info = None;
        let params = Self::with_git_target(
            &cwd,
            &target,
            serde_json::json!({
                "subject": subject,
                "body": (!body.is_empty()).then_some(body),
            }),
        );
        self.git_task = Some(cx.spawn(async move |this, cx| {
            let result = engine.client().call(methods::GIT_COMMIT, params).await;
            this.update(cx, |changes, cx| {
                changes.git_busy = None;
                match result {
                    Ok(value) => {
                        let hash = value.get("hash").and_then(|v| v.as_str()).unwrap_or("");
                        changes.git_info = Some(if hash.is_empty() {
                            "Committed.".into()
                        } else {
                            format!("Committed {hash}").into()
                        });
                        changes
                            .subject
                            .update(cx, |input, cx| input.set_text("", cx));
                        changes.body.update(cx, |input, cx| input.set_text("", cx));
                    }
                    Err(err) => changes.error = Some(format!("Commit failed: {err}").into()),
                }
                changes.refresh_git(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// The selected chat's host device when it differs from the connected
    /// engine's own — diffs are produced where the checkout lives, so a
    /// remote chat's watch must relay-forward (`targetDeviceId`) to its host.
    /// Without this the local stream simply never carries the remote checkout
    /// and the pane sits on "Preparing diff…" forever (user report).
    fn desired_target(&self, cx: &App) -> Option<String> {
        let state = self.state.read(cx);
        let device = state
            .selected_chat_row()
            .map(|chat| chat.device_id.clone())
            .or_else(|| {
                state
                    .selected_space_row()
                    .map(|space| space.device_id.clone())
            })?;
        (state.local_device_id.as_deref() != Some(device.as_str())).then_some(device)
    }

    /// Start the `WatchCheckoutDiffs` subscription (idempotent per target).
    /// Retries with a flat 2 s delay if the stream fails or ends; the last
    /// content stays visible under an error banner meanwhile.
    pub fn ensure_watch(&mut self, cx: &mut Context<Self>) {
        let git_key = self
            .git_context(cx)
            .map(|(cwd, target)| format!("{}:{cwd}", target.as_deref().unwrap_or("local")));
        if self.git_context_key != git_key {
            self.harnesses.clear();
            self.models.clear();
            self.selected_harness = None;
            self.selected_model = None;
            self.generation_picker = None;
            self.refresh_git(cx);
            self.load_generation_options(cx);
        }
        let target = self.desired_target(cx);
        if self.started && self.watch_target == target {
            return;
        }
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            // Engine still booting — retry on the next state change via sync().
            return;
        };
        // Retarget: the old task (and its stream) drop; rows from the previous
        // device would resolve against the wrong checkouts, so clear them.
        if self.started {
            self.diffs.clear();
            self.error = None;
        }
        self.started = true;
        self.watch_target = target.clone();
        self.watch_task = Some(Self::spawn_watch(engine, target, cx));
    }

    fn spawn_watch(
        engine: EngineHandle,
        target: Option<String>,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |this, cx| {
            loop {
                let mut params = serde_json::Map::new();
                if let Some(target) = &target {
                    params.insert(
                        "targetDeviceId".into(),
                        serde_json::Value::String(target.clone()),
                    );
                }
                let subscribed = engine
                    .client()
                    .subscribe(
                        methods::WATCH_CHECKOUT_DIFFS,
                        serde_json::Value::Object(params),
                    )
                    .await;
                match subscribed {
                    Ok(mut rx) => {
                        while let Some(value) = rx.recv().await {
                            let alive = this.update(cx, |changes, cx| {
                                changes.error = None;
                                if apply_diff_frame(&mut changes.diffs, value) {
                                    changes.sync(cx);
                                    cx.notify();
                                }
                            });
                            if alive.is_err() {
                                return;
                            }
                        }
                        // Stream ended (engine restart / reconnect): banner + retry.
                        if this
                            .update(cx, |changes, cx| {
                                changes.error = Some("Diff stream interrupted — retrying".into());
                                cx.notify();
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(err) => {
                        if this
                            .update(cx, |changes, cx| {
                                changes.error =
                                    Some(format!("Diff watch unavailable: {err}").into());
                                cx.notify();
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                }
                cx.background_executor().timer(Duration::from_secs(2)).await;
            }
        })
    }

    fn resolved(&self, cx: &App) -> Option<CheckoutDiff> {
        let state = self.state.read(cx);
        if let Some(chat) = state.selected_chat_row() {
            return resolve_diff(&self.diffs, chat).cloned();
        }
        let space = state.selected_space_row()?;
        self.diffs
            .iter()
            .find(|diff| diff.device_id == space.device_id && diff.cwd == space.path)
            .cloned()
    }

    /// Reconcile parsed content with the currently-resolved diff.
    fn sync(&mut self, cx: &mut Context<Self>) {
        // The watch follows the selected chat's host device (idempotent when
        // the target is unchanged); a boot-deferred attempt retries here too.
        self.ensure_watch(cx);
        let next_git_key = self
            .git_context(cx)
            .map(|(cwd, target)| format!("{}:{cwd}", target.as_deref().unwrap_or("local")));
        if self.git_context_key != next_git_key {
            self.git_status = None;
            self.git_info = None;
            self.refresh_git(cx);
        }
        let Some(diff) = self.resolved(cx) else {
            if self.parsed.take().is_some() {
                self.list.reset(0);
                self.folds.clear();
                self.highlights.clear();
                cx.notify();
            }
            return;
        };
        let key = format!("{}:{}", diff.checkout_id, diff.checksum);
        if self.parsed.as_ref().is_some_and(|p| p.key == key) {
            return;
        }
        // Parse off the render path — patches run to megabytes.
        let patch = diff.patch.clone();
        self.parse_task = Some(cx.spawn(async move |this, cx| {
            let files = cx
                .background_executor()
                .spawn(async move { parse_patch(&patch) })
                .await;
            this.update(cx, |changes, cx| {
                // Late results for a superseded diff are re-checked by key.
                let current = changes
                    .resolved(cx)
                    .map(|d| format!("{}:{}", d.checkout_id, d.checksum));
                if current.as_deref() != Some(key.as_str()) {
                    return;
                }
                changes.list.reset(files.len());
                changes.folds.clear();
                changes.highlights.clear();
                changes.parsed = Some(ParsedDiff {
                    key,
                    files: Arc::new(files),
                });
                // Keep the detail pane tied to a real current file. The git
                // list is authoritative for selection, while the checkout
                // patch supplies the rendered diff.
                if !changes.selected_detail.as_ref().is_some_and(|path| {
                    changes
                        .git_status
                        .as_ref()
                        .is_some_and(|status| status.files.iter().any(|file| &file.path == path))
                }) {
                    changes.selected_detail = changes
                        .git_status
                        .as_ref()
                        .and_then(|status| status.files.iter().find(|file| file.unstaged))
                        .map(|file| file.path.clone())
                        .or_else(|| {
                            changes
                                .parsed
                                .as_ref()?
                                .files
                                .first()
                                .map(|file| file.path.clone())
                        });
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn toggle_fold(&mut self, path: &str, expanded_height: f32) {
        let fold = self.folds.entry(path.to_string()).or_default();
        let currently_collapsed = fold.collapsed;
        fold.from = if currently_collapsed {
            0.0
        } else {
            expanded_height
        };
        fold.to = if currently_collapsed {
            expanded_height
        } else {
            0.0
        };
        fold.collapsed = !currently_collapsed;
        fold.epoch += 1;
        fold.toggled_at = Some(std::time::Instant::now());
    }

    fn select_detail(&mut self, path: String, cx: &mut Context<Self>) {
        self.selected_detail = Some(path);
        self.detail_scroll.set_offset(gpui::Point::default());
        cx.notify();
    }

    fn save_generation_defaults(&self) {
        if let Some(dir) = self.generation_defaults_dir.as_deref()
            && let Err(error) = self.generation_defaults.save(dir)
        {
            tracing::warn!(error = %error, "git generation defaults save failed");
        }
    }

    fn toggle_path_selection(&mut self, path: String, cx: &mut Context<Self>) {
        if !self.selected_paths.insert(path.clone()) {
            self.selected_paths.remove(&path);
        }
        cx.notify();
    }

    fn run_file_action(
        &mut self,
        method: &'static str,
        path: String,
        untracked: bool,
        cx: &mut Context<Self>,
    ) {
        if self.git_busy.is_some() {
            return;
        }
        let Some((cwd, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.file_menu = None;
        self.git_busy = Some("file action");
        self.error = None;
        let params = Self::with_git_target(
            &cwd,
            &target,
            serde_json::json!({ "path": path, "untracked": untracked }),
        );
        self.git_task = Some(cx.spawn(async move |this, cx| {
            let result = engine.client().call(method, params).await;
            this.update(cx, |changes, cx| {
                changes.git_busy = None;
                if let Err(error) = result {
                    changes.error = Some(format!("Git operation failed: {error}").into());
                }
                changes.refresh_git(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Tokens for a file's diff lines (paint-only). Kicks a time-sliced
    /// background tokenize when missing; returns the current best.
    fn request_highlight(
        &mut self,
        file: &FileDiff,
        parsed_key: &str,
        cx: &mut Context<Self>,
    ) -> Option<Arc<Vec<Vec<Token>>>> {
        let lang = lang_for_path(&file.path)?;
        let fingerprint = hash64(&[parsed_key, &file.path]);
        if let Some(slot) = self.highlights.get(&file.path)
            && slot.fingerprint == fingerprint
        {
            return slot.lines.clone();
        }
        let texts: Vec<(LineKind, String)> = file
            .hunks
            .iter()
            .flat_map(|h| h.lines.iter().map(|l| (l.kind, l.text.clone())))
            .collect();
        let path = file.path.clone();
        let task = cx.spawn(async move |this, cx| {
            let lines = cx
                .background_executor()
                .spawn(async move {
                    let mut out = Vec::with_capacity(texts.len());
                    for (ix, (kind, text)) in texts.iter().enumerate() {
                        // Diff lines are fragments — no carry across lines.
                        let tokens = match kind {
                            LineKind::Meta => Vec::new(),
                            _ => tokenize_line(lang, text, LineCarry::None).0,
                        };
                        out.push(tokens);
                        if ix % 128 == 127 {
                            yield_now().await;
                        }
                    }
                    out
                })
                .await;
            this.update(cx, |changes, cx| {
                if let Some(slot) = changes.highlights.get_mut(&path)
                    && slot.fingerprint == fingerprint
                {
                    slot.lines = Some(Arc::new(lines));
                    cx.notify();
                }
            })
            .ok();
        });
        self.highlights.insert(
            file.path.clone(),
            HighlightSlot {
                fingerprint,
                lines: None,
                _task: Some(task),
            },
        );
        None
    }

    // ---- rendering ----

    fn render_row(
        &mut self,
        ix: usize,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(parsed) = &self.parsed else {
            return gpui::Empty.into_any_element();
        };
        let files = parsed.files.clone();
        let parsed_key = parsed.key.clone();
        let Some(file) = files.get(ix) else {
            return gpui::Empty.into_any_element();
        };
        let theme = Theme::of(cx).clone();
        let expanded_height = body_height(file);
        let fold = self.folds.get(&file.path).copied().unwrap_or_default();
        let highlight = self.request_highlight(file, &parsed_key, cx);
        let path = file.path.clone();

        let header = self.render_file_header(ix, file, &fold, expanded_height, &theme, cx);
        let body = render_file_body(file, highlight, &theme);

        // Collapse: 180 ms committed-height tween on toggle (windowed — see
        // FileFold::animating); steady states paint at the target height
        // directly.
        let body: AnyElement = if fold.animating() {
            let (from, to) = (fold.from, fold.to);
            div()
                .overflow_hidden()
                .child(body)
                .with_animation(
                    SharedString::from(format!("fold-{path}-{}", fold.epoch)),
                    COLLAPSE.animation(),
                    move |el, t| el.h(px(motion::lerp(from, to, t))),
                )
                .into_any_element()
        } else {
            let target = if fold.collapsed { 0.0 } else { expanded_height };
            div()
                .overflow_hidden()
                .h(px(target))
                .child(body)
                .into_any_element()
        };

        div()
            .w_full()
            .flex()
            .flex_col()
            .border_b_1()
            .border_color(crate::theme::hairline(0.04))
            .child(header)
            .child(body)
            .into_any_element()
    }

    fn render_file_header(
        &mut self,
        ix: usize,
        file: &FileDiff,
        fold: &FileFold,
        expanded_height: f32,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let collapsed = fold.collapsed;
        let path = file.path.clone();
        let adds = file.additions;
        let dels = file.deletions;

        // Chevron (comet checkout-diff-sidebar): chevron-right closed,
        // chevron-down open; gpui divs have no rotation transform at the
        // pinned rev, so the glyph swap crossfades over the same 200 ms.
        let chevron_icon = if collapsed {
            crate::icons::ALT_ARROW_RIGHT
        } else {
            crate::icons::ALT_ARROW_DOWN
        };
        let chevron = div().flex_none().size(px(14.0)).child(
            crate::icons::icon(chevron_icon)
                .size(px(13.0))
                .text_color(theme.text_muted.opacity(0.7)),
        );
        let chevron: AnyElement = if fold.animating() {
            chevron
                .with_animation(
                    SharedString::from(format!("chev-{path}-{}", fold.epoch)),
                    CHEVRON.animation(),
                    |el, t| el.opacity(0.25 + 0.75 * t),
                )
                .into_any_element()
        } else {
            chevron.into_any_element()
        };

        // Header row: chevron + mono path (one quiet tone) + right-aligned
        // +N / −N counts on a slightly raised wash.
        div()
            .id(SharedString::from(format!("file-hdr-{ix}")))
            .h(px(FILE_HEADER_HEIGHT))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .px(px(Theme::SPACE_MD))
            .bg(crate::theme::ink(0.025))
            .cursor_pointer()
            .hover(|s| s.bg(crate::theme::ink(0.05)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.toggle_fold(&path, expanded_height);
                cx.notify();
            }))
            .child(chevron)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .font_family(theme.font_mono.clone())
                    .text_size(px(12.0))
                    .text_color(theme.text_dim)
                    .child(SharedString::from(file.path.clone())),
            )
            .when(file.binary, |el| {
                el.child(
                    div()
                        .flex_none()
                        .text_size(px(10.0))
                        .text_color(theme.text_faint)
                        .child(SharedString::from("BIN")),
                )
            })
            .when(adds > 0 || !file.binary, |el| {
                el.child(
                    div()
                        .flex_none()
                        .font_family(theme.font_mono.clone())
                        .text_size(px(11.0))
                        .text_color(add_color(theme))
                        .child(SharedString::from(format!("+{adds}"))),
                )
            })
            .when(dels > 0 || !file.binary, |el| {
                el.child(
                    div()
                        .flex_none()
                        .font_family(theme.font_mono.clone())
                        .text_size(px(11.0))
                        .text_color(del_color(theme))
                        .child(SharedString::from(format!("−{dels}"))),
                )
            })
            .into_any_element()
    }

    fn render_git_status(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
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

    fn render_generation_controls(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let disabled = self.git_busy.is_some() || self.generation_loading;
        let harness_label = self
            .selected_harness
            .and_then(|selected| {
                self.harnesses
                    .iter()
                    .find(|descriptor| descriptor.id == selected)
            })
            .map(|descriptor| descriptor.name.clone())
            .unwrap_or_else(|| {
                if self.generation_loading {
                    "Loading clients…".into()
                } else {
                    "Select client".into()
                }
            });
        let model_label = self
            .selected_model
            .as_deref()
            .and_then(|selected| self.models.iter().find(|model| model.id == selected))
            .map(|model| model.label.clone())
            .unwrap_or_else(|| {
                if self.generation_loading {
                    "Loading models…".into()
                } else {
                    "Select model".into()
                }
            });
        let selector = |id: &'static str, label: String| {
            div()
                .id(id)
                .h(px(28.0))
                .min_w_0()
                .flex_1()
                .px(px(8.0))
                .flex()
                .items_center()
                .gap(px(5.0))
                .rounded(px(6.0))
                .border_1()
                .border_color(theme.border)
                .text_size(px(10.0))
                .text_color(if disabled {
                    theme.text_faint
                } else {
                    theme.text_muted
                })
                .when(!disabled, |el| {
                    el.cursor_pointer()
                        .hover(|style| style.bg(crate::theme::white_alpha(0.05)))
                })
                .child(div().flex_1().min_w_0().truncate().child(label))
                .child(
                    crate::icons::icon(crate::icons::ALT_ARROW_DOWN)
                        .size(px(10.0))
                        .text_color(theme.text_faint),
                )
        };

        let harness_picker = if self.generation_picker == Some(GitGenerationPicker::Harness) {
            let rows = self
                .harnesses
                .iter()
                .enumerate()
                .map(|(ix, descriptor)| {
                    let harness = descriptor.id;
                    let selected = self.selected_harness == Some(harness);
                    div()
                        .id(SharedString::from(format!("git-harness-{ix}")))
                        .h(px(30.0))
                        .px(px(Theme::SPACE_MD))
                        .flex()
                        .items_center()
                        .text_size(px(11.0))
                        .text_color(if selected {
                            theme.text
                        } else {
                            theme.text_muted
                        })
                        .bg(if selected {
                            crate::theme::white_alpha(0.05)
                        } else {
                            gpui::transparent_black()
                        })
                        .cursor_pointer()
                        .hover(|style| style.bg(crate::theme::white_alpha(0.07)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.select_harness(harness, cx);
                        }))
                        .child(SharedString::from(descriptor.name.clone()))
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let menu = popover::popover_card(theme)
                .w(px(200.0))
                .mt(px(16.0))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.generation_picker = None;
                    cx.notify();
                }))
                .child(
                    div()
                        .id("git-harness-list")
                        .flex()
                        .flex_col()
                        .max_h(px(240.0))
                        .overflow_y_scroll()
                        .track_scroll(&self.generation_scroll)
                        .children(rows),
                );
            Some(popover::anchored_menu(
                "git-harness-popover",
                menu.into_any_element(),
            ))
        } else {
            None
        };

        let model_picker = if self.generation_picker == Some(GitGenerationPicker::Model) {
            let query = self.model_search.read(cx).text().to_string();
            let labels = self
                .models
                .iter()
                .map(|model| {
                    format!(
                        "{} {} {}",
                        model.label,
                        model.id,
                        model.description.as_deref().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>();
            let filtered_indices = popover::filter_indices(&query, &labels);
            let rows = filtered_indices
                .iter()
                .map(|&ix| {
                    let model = &self.models[ix];
                    let model_id = model.id.clone();
                    let model_label = model.label.clone();
                    let selected = self.selected_model.as_deref() == Some(model.id.as_str());
                    div()
                        .id(SharedString::from(format!("git-model-{ix}")))
                        .h(px(30.0))
                        .px(px(Theme::SPACE_MD))
                        .flex()
                        .items_center()
                        .text_size(px(11.0))
                        .text_color(if selected {
                            theme.text
                        } else {
                            theme.text_muted
                        })
                        .bg(if selected {
                            crate::theme::white_alpha(0.05)
                        } else {
                            gpui::transparent_black()
                        })
                        .cursor_pointer()
                        .hover(|style| style.bg(crate::theme::white_alpha(0.07)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.selected_model = Some(model_id.clone());
                            if let Some(harness) = this.selected_harness {
                                this.generation_defaults.remember_model(
                                    harness,
                                    model_id.clone(),
                                    model_label.clone(),
                                );
                                this.save_generation_defaults();
                            }
                            this.generation_picker = None;
                            this.model_search.update(cx, |input, cx| {
                                input.set_text("", cx);
                            });
                            cx.notify();
                        }))
                        .child(SharedString::from(self.models[ix].label.clone()))
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let search = popover::search_input_frame(
                theme,
                self.model_search.clone().into_any_element(),
            );
            let menu = popover::popover_card(theme)
                .w(px(200.0))
                .mt(px(16.0))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.generation_picker = None;
                    this.model_search.update(cx, |input, cx| {
                        input.set_text("", cx);
                    });
                    cx.notify();
                }))
                .child(search)
                .child(
                    div()
                        .id("git-model-list")
                        .flex()
                        .flex_col()
                        .max_h(px(200.0))
                        .overflow_y_scroll()
                        .track_scroll(&self.generation_scroll)
                        .children(rows),
                );
            Some(popover::anchored_menu(
                "git-model-popover",
                menu.into_any_element(),
            ))
        } else {
            None
        };
        let can_generate = !disabled
            && self.selected_harness.is_some()
            && self.selected_model.is_some()
            && self
                .git_status
                .as_ref()
                .is_some_and(|status| !status.files.is_empty());

        div()
            .flex_none()
            .flex()
            .flex_col()
            .border_b_1()
            .border_color(crate::theme::white_alpha(0.05))
            .child(
                div()
                    .h(px(40.0))
                    .px(px(Theme::SPACE_MD))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        selector("git-harness-select", harness_label)
                            .when(!disabled, |el| {
                                el.on_click(cx.listener(|this, _, _, cx| {
                                    this.generation_picker = if this.generation_picker
                                        == Some(GitGenerationPicker::Harness)
                                    {
                                        None
                                    } else {
                                        Some(GitGenerationPicker::Harness)
                                    };
                                    if this.harnesses.is_empty() {
                                        this.load_generation_options(cx);
                                    }
                                    cx.notify();
                                }))
                            })
                            .when_some(harness_picker, |el, menu| el.child(menu)),
                    )
                    .child(
                        selector("git-model-select", model_label)
                            .when(!disabled, |el| {
                                el.on_click(cx.listener(|this, _, _, cx| {
                                    let closing = this.generation_picker
                                        == Some(GitGenerationPicker::Model);
                                    this.generation_picker = if this.generation_picker
                                        == Some(GitGenerationPicker::Model)
                                    {
                                        None
                                    } else {
                                        Some(GitGenerationPicker::Model)
                                    };
                                    if closing {
                                        this.model_search.update(cx, |input, cx| {
                                            input.set_text("", cx);
                                        });
                                    }
                                    cx.notify();
                                }))
                            })
                            .when_some(model_picker, |el, menu| el.child(menu)),
                    )
                    .child(
                        div()
                            .id("git-generate-message")
                            .h(px(28.0))
                            .px(px(9.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(theme.border)
                            .text_size(px(10.0))
                            .text_color(if can_generate {
                                theme.text
                            } else {
                                theme.text_faint
                            })
                            .when(can_generate, |el| {
                                el.cursor_pointer()
                                    .hover(|style| style.bg(crate::theme::white_alpha(0.07)))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.generate_commit_message(cx);
                                    }))
                            })
                            .child(SharedString::from(if self.git_busy == Some("generate") {
                                "Generating…"
                            } else {
                                "AI message"
                            })),
                    ),
            )
            .into_any_element()
    }

    fn render_commit(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let can_commit = self.git_busy.is_none()
            && !self.subject.read(cx).text().trim().is_empty()
            && self.git_status.as_ref().is_some_and(|status| {
                status.is_repo && status.files.iter().any(|file| file.staged)
            });
        div()
            .flex_none()
            .p(px(Theme::SPACE_MD))
            .flex()
            .flex_col()
            .gap(px(7.0))
            .border_t_1()
            .border_color(theme.border)
            .child(
                div()
                    .min_h(px(30.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(crate::theme::white_alpha(0.025))
                    .text_size(px(12.0))
                    .child(self.subject.clone()),
            )
            .child(
                div()
                    .min_h(px(48.0))
                    .max_h(px(82.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(crate::theme::white_alpha(0.025))
                    .text_size(px(12.0))
                    .child(self.body.clone()),
            )
            .child(
                div()
                    .id("git-commit")
                    .h(px(30.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(7.0))
                    .bg(if can_commit {
                        theme.text
                    } else {
                        theme.surface_raised
                    })
                    .text_size(px(12.0))
                    .text_color(if can_commit {
                        theme.bg
                    } else {
                        theme.text_faint
                    })
                    .when(can_commit, |el| {
                        el.cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| this.commit(cx)))
                    })
                    .child(SharedString::from(if self.git_busy == Some("commit") {
                        "Committing…"
                    } else {
                        "Commit staged changes"
                    })),
            )
            .into_any_element()
    }

    fn render_file_menu(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (file, position) = self.file_menu.clone()?;
        let discard = file.clone();
        let ignore = file.clone();
        let reveal = file.clone();
        let copy_absolute = file.clone();
        let copy_relative = file.clone();
        let cwd = self.git_context(cx).map(|(cwd, _)| cwd)?;
        let untracked = file.kind == "untracked";
        let row = |id: String, label: &'static str| {
            popover::menu_row(theme, false, id).child(SharedString::from(label))
        };
        let menu = popover::popover_card(theme)
            .w(px(210.0))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.file_menu = None;
                cx.notify();
            }))
            .flex()
            .flex_col()
            .child(
                row(
                    format!("git-menu-discard-{}", discard.path),
                    "Discard changes",
                )
                .id(SharedString::from(format!(
                    "git-menu-discard-{}",
                    discard.path
                )))
                .text_color(theme.danger)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_file_action(methods::GIT_DISCARD, discard.path.clone(), untracked, cx);
                })),
            )
            .child(
                row(format!("git-menu-ignore-{}", ignore.path), "Ignore file")
                    .id(SharedString::from(format!(
                        "git-menu-ignore-{}",
                        ignore.path
                    )))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.run_file_action(methods::GIT_IGNORE, ignore.path.clone(), false, cx);
                    })),
            )
            .child(popover::menu_separator())
            .child(
                row(
                    format!("git-menu-copy-path-{}", copy_absolute.path),
                    "Copy file path",
                )
                .id(SharedString::from(format!(
                    "git-menu-copy-path-{}",
                    copy_absolute.path
                )))
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        std::path::Path::new(&cwd)
                            .join(&copy_absolute.path)
                            .to_string_lossy()
                            .into_owned(),
                    ));
                    this.file_menu = None;
                    cx.notify();
                })),
            )
            .child(
                row(
                    format!("git-menu-copy-relative-{}", copy_relative.path),
                    "Copy relative file path",
                )
                .id(SharedString::from(format!(
                    "git-menu-copy-relative-{}",
                    copy_relative.path
                )))
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(copy_relative.path.clone()));
                    this.file_menu = None;
                    cx.notify();
                })),
            )
            .child(
                row(
                    format!("git-menu-reveal-{}", reveal.path),
                    "Reveal in Finder",
                )
                .id(SharedString::from(format!(
                    "git-menu-reveal-{}",
                    reveal.path
                )))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_file_action(methods::GIT_REVEAL, reveal.path.clone(), false, cx);
                })),
            )
            .into_any_element();
        Some(popover::menu_at("git-file-context-menu", position, menu))
    }
}

/// Green for additions — sampled from the reference diff (soft emerald).
fn add_color(theme: &Theme) -> gpui::Hsla {
    theme.diff_add // emerald-400
}

/// Red for deletions — softer than the theme danger, per the reference diff.
fn del_color(theme: &Theme) -> gpui::Hsla {
    theme.diff_del // red-400
}

/// Diff syntax palette — since round 9 the transcript's code blocks share the
/// same soft hues, so this simply delegates to [`render::token_color`].
fn diff_token_color(class: crate::markdown::highlight::TokenClass, theme: &Theme) -> gpui::Hsla {
    render::token_color(class, theme)
}

/// The expanded body of one file section: notices, hunk headers, +/-/context
/// lines with a coloured accent bar, dual line-number gutters, a marker
/// column, and paint-only syntax runs (comet checkout-diff-sidebar).
fn render_file_body(
    file: &FileDiff,
    highlight: Option<Arc<Vec<Vec<Token>>>>,
    theme: &Theme,
) -> AnyElement {
    let mono = font(theme.font_mono.clone());
    let mut line_ix = 0usize;
    let mut children: Vec<AnyElement> = Vec::new();

    for notice in file_notices(file) {
        children.push(
            div()
                .h(px(NOTICE_HEIGHT))
                .flex_none()
                .flex()
                .items_center()
                .px(px(Theme::SPACE_LG))
                .text_size(px(11.0))
                .text_color(theme.text_faint)
                .child(SharedString::from(notice))
                .into_any_element(),
        );
    }

    // Row tints sampled from the reference: ~5–6% washes over the pane tone.
    let mut add_bg = add_color(theme);
    add_bg.a = 0.055;
    let mut del_bg = del_color(theme);
    del_bg.a = 0.055;
    // Bluish-grey hunk-header wash.
    let hunk_bg = theme.diff_hunk_bg;

    for hunk in &file.hunks {
        children.push(
            div()
                .h(px(HUNK_HEADER_HEIGHT))
                .flex_none()
                .flex()
                .items_center()
                .px(px(Theme::SPACE_LG))
                .bg(hunk_bg)
                .font_family(theme.font_mono.clone())
                .text_size(px(11.0))
                .text_color(theme.text_faint)
                .child(SharedString::from(hunk.header.clone()))
                .into_any_element(),
        );
        for line in &hunk.lines {
            let tokens = highlight
                .as_ref()
                .and_then(|lines| lines.get(line_ix))
                .map(|t| t.as_slice())
                .unwrap_or(&[]);
            line_ix += 1;

            if line.kind == LineKind::Meta {
                children.push(
                    div()
                        .h(px(DIFF_LINE_HEIGHT))
                        .flex_none()
                        .flex()
                        .items_center()
                        .pl(px(ACCENT_BAR_WIDTH
                            + 2.0 * GUTTER_WIDTH
                            + MARKER_WIDTH
                            + 12.0))
                        .text_size(px(10.5))
                        .text_color(theme.text_faint)
                        .italic()
                        .child(SharedString::from(line.text.clone()))
                        .into_any_element(),
                );
                continue;
            }

            let (marker, marker_color, row_bg, accent, number_color) = match line.kind {
                LineKind::Add => (
                    "+",
                    add_color(theme),
                    Some(add_bg),
                    Some(add_color(theme).opacity(0.55)),
                    add_color(theme).opacity(0.9),
                ),
                LineKind::Del => (
                    "−",
                    del_color(theme),
                    Some(del_bg),
                    Some(del_color(theme).opacity(0.55)),
                    del_color(theme).opacity(0.9),
                ),
                _ => (
                    "·",
                    theme.text_faint.opacity(0.5),
                    None,
                    None,
                    theme.text_faint.opacity(0.8),
                ),
            };
            let gutter = |no: Option<u32>, color: gpui::Hsla| {
                div()
                    .w(px(GUTTER_WIDTH))
                    .flex_none()
                    .font_family(theme.font_mono.clone())
                    .text_size(px(11.0))
                    .text_color(color)
                    .flex()
                    .justify_end()
                    .pr(px(8.0))
                    .child(SharedString::from(
                        no.map(|n| n.to_string()).unwrap_or_default(),
                    ))
            };
            let runs = render::runs_with_palette(
                &line.text,
                tokens,
                &mono,
                theme.text.opacity(0.92),
                |class| diff_token_color(class, theme),
            );
            children.push(
                div()
                    .h(px(DIFF_LINE_HEIGHT))
                    .flex_none()
                    .flex()
                    .flex_row()
                    .items_center()
                    .when_some(row_bg, |el, bg| el.bg(bg))
                    // Accent bar: solid colour on +/− rows, invisible spacer on
                    // context rows so columns always align.
                    .child(
                        div()
                            .w(px(ACCENT_BAR_WIDTH))
                            .h_full()
                            .flex_none()
                            .when_some(accent, |el, color| el.bg(color)),
                    )
                    .child(gutter(
                        line.old_no,
                        if line.kind == LineKind::Del {
                            number_color
                        } else {
                            theme.text_faint.opacity(0.8)
                        },
                    ))
                    .child(gutter(
                        line.new_no,
                        if line.kind == LineKind::Add {
                            number_color
                        } else {
                            theme.text_faint.opacity(0.8)
                        },
                    ))
                    .child(
                        div()
                            .w(px(MARKER_WIDTH))
                            .flex_none()
                            .flex()
                            .justify_center()
                            .text_size(px(DIFF_TEXT_SIZE))
                            .text_color(marker_color)
                            .font_family(theme.font_mono.clone())
                            .child(SharedString::from(marker)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .pl(px(12.0))
                            .font_family(theme.font_mono.clone())
                            .text_size(px(DIFF_TEXT_SIZE))
                            .whitespace_nowrap()
                            .child(gpui::StyledText::new(line.text.clone()).with_runs(runs)),
                    )
                    .into_any_element(),
            );
        }
    }

    div()
        .flex()
        .flex_col()
        .pb(px(BODY_BOTTOM_PAD))
        .children(children)
        .into_any_element()
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    const PATCH: &str = "\
diff --git a/src/main.rs b/src/main.rs
index 111..222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,5 @@ fn main
 fn main() {
-    println!(\"old\");
+    println!(\"new\");
+    let x = 1;
 }
@@ -10,2 +11,2 @@
 // tail
-old_line
+new_line
diff --git a/added.txt b/added.txt
new file mode 100644
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+first
+second
\\ No newline at end of file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
diff --git a/old_name.rs b/new_name.rs
similarity index 90%
rename from old_name.rs
rename to new_name.rs
";

    #[test]
    fn parses_files_hunks_and_lines() {
        let files = parse_patch(PATCH);
        assert_eq!(files.len(), 5);

        let main = &files[0];
        assert_eq!(main.path, "src/main.rs");
        assert_eq!(main.status, FileStatus::Modified);
        assert_eq!(main.hunks.len(), 2);
        assert_eq!(main.additions, 3);
        assert_eq!(main.deletions, 2);
        let h0 = &main.hunks[0];
        assert_eq!(h0.header, "@@ -1,4 +1,5 @@ fn main");
        assert_eq!(h0.lines.len(), 5);
        assert_eq!(h0.lines[0].kind, LineKind::Context);
        assert_eq!(h0.lines[0].old_no, Some(1));
        assert_eq!(h0.lines[0].new_no, Some(1));
        assert_eq!(h0.lines[1].kind, LineKind::Del);
        assert_eq!(h0.lines[1].old_no, Some(2));
        assert_eq!(h0.lines[1].new_no, None);
        assert_eq!(h0.lines[2].kind, LineKind::Add);
        assert_eq!(h0.lines[2].new_no, Some(2));
        assert_eq!(h0.lines[3].kind, LineKind::Add);
        assert_eq!(h0.lines[3].new_no, Some(3));
        // Closing context line: numbering advanced past the add/del block.
        assert_eq!(h0.lines[4].old_no, Some(3));
        assert_eq!(h0.lines[4].new_no, Some(4));
        // Second hunk restarts numbering from its header.
        assert_eq!(main.hunks[1].lines[0].old_no, Some(10));
        assert_eq!(main.hunks[1].lines[0].new_no, Some(11));
    }

    #[test]
    fn detects_new_deleted_binary_and_renamed() {
        let files = parse_patch(PATCH);
        let added = &files[1];
        assert_eq!(added.status, FileStatus::Added);
        assert_eq!(added.additions, 2);
        // The no-newline marker rides as a Meta line.
        let last = added.hunks[0].lines.last().unwrap();
        assert_eq!(last.kind, LineKind::Meta);
        assert!(last.text.contains("No newline"));
        assert!(file_notices(added).iter().any(|n| n == "New file"));

        let deleted = &files[2];
        assert_eq!(deleted.status, FileStatus::Deleted);
        assert_eq!(deleted.deletions, 1);
        assert!(file_notices(deleted).iter().any(|n| n == "Deleted file"));

        let binary = &files[3];
        assert!(binary.binary);
        assert_eq!(binary.status, FileStatus::Added);
        assert!(binary.hunks.is_empty());
        assert!(file_notices(binary).iter().any(|n| n.contains("Binary")));

        let renamed = &files[4];
        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.path, "new_name.rs");
        assert_eq!(renamed.old_path.as_deref(), Some("old_name.rs"));
        assert!(
            file_notices(renamed)
                .iter()
                .any(|n| n.contains("old_name.rs"))
        );
    }

    #[test]
    fn empty_and_garbage_patches_parse_to_nothing() {
        assert!(parse_patch("").is_empty());
        assert!(parse_patch("not a diff\nat all\n").is_empty());
        // Truncated mid-hunk: keeps what parsed.
        let files = parse_patch("diff --git a/x b/x\n@@ -1,9 +1,9 @@\n ctx\n+add");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].hunks[0].lines.len(), 2);
        assert_eq!(files[0].additions, 1);
    }

    #[test]
    fn quoted_and_spaced_paths() {
        let (old, new) = parse_git_paths("a/simple.rs b/simple.rs");
        assert_eq!((old.as_str(), new.as_str()), ("simple.rs", "simple.rs"));
        let (old, new) = parse_git_paths("\"a/with space.rs\" \"b/with space.rs\"");
        assert_eq!(old, "with space.rs");
        assert_eq!(new, "with space.rs");
    }

    #[test]
    fn hunk_headers_parse_with_and_without_counts() {
        assert_eq!(parse_hunk_header("@@ -1,4 +2,5 @@"), Some((1, 2)));
        assert_eq!(parse_hunk_header("@@ -7 +9 @@ fn ctx"), Some((7, 9)));
        assert_eq!(parse_hunk_header("@@ garbage"), None);
    }

    #[test]
    fn body_height_is_analytic() {
        let files = parse_patch(PATCH);
        let main = &files[0];
        let lines: usize = main.hunks.iter().map(|h| h.lines.len()).sum();
        assert_eq!(
            body_height(main),
            2.0 * HUNK_HEADER_HEIGHT + lines as f32 * DIFF_LINE_HEIGHT + BODY_BOTTOM_PAD
        );
        // Notices add height (added file: 1 notice + meta line inside hunk).
        let added = &files[1];
        assert_eq!(
            body_height(added),
            NOTICE_HEIGHT + HUNK_HEADER_HEIGHT + 3.0 * DIFF_LINE_HEIGHT + BODY_BOTTOM_PAD
        );
    }

    fn diff(checkout: &str, device: &str, cwd: &str, patch: &str) -> CheckoutDiff {
        CheckoutDiff {
            checkout_id: checkout.into(),
            device_id: device.into(),
            cwd: cwd.into(),
            patch: patch.into(),
            files: Vec::new(),
            additions: 0,
            deletions: 0,
            truncated: false,
            checksum: format!("sum-{}", patch.len()),
            updated_at: Utc::now(),
        }
    }

    fn chat(checkout: Option<&str>, device: &str, cwd: Option<&str>) -> Chat {
        Chat {
            id: "c1".into(),
            device_id: device.into(),
            title: None,
            archived: false,
            cwd: cwd.map(Into::into),
            branch: None,
            checkout_id: checkout.map(Into::into),
            config: None,
            last_message_preview: None,
            last_message_at: None,
            created_at: Utc::now(),
            harness_session_id: None,
            harness_session_cwd: None,
            space_id: None,
            last_seen_at: None,
            settled_at: None,
        }
    }

    #[test]
    fn diff_resolution_prefers_checkout_id_then_cwd() {
        let diffs = vec![
            diff("co-1", "dev-a", "/repo/one", "x"),
            diff("co-2", "dev-b", "/repo/two", "y"),
        ];
        // checkout_id match wins even when cwd points elsewhere.
        let c = chat(Some("co-2"), "dev-a", Some("/repo/one"));
        assert_eq!(resolve_diff(&diffs, &c).unwrap().checkout_id, "co-2");
        // Unknown checkout falls back to device+cwd.
        let c = chat(Some("co-9"), "dev-a", Some("/repo/one"));
        assert_eq!(resolve_diff(&diffs, &c).unwrap().checkout_id, "co-1");
        // Wrong device still matches by cwd alone.
        let c = chat(None, "dev-z", Some("/repo/two"));
        assert_eq!(resolve_diff(&diffs, &c).unwrap().checkout_id, "co-2");
        // Nothing to go on.
        let c = chat(None, "dev-a", None);
        assert!(resolve_diff(&diffs, &c).is_none());
        let c = chat(None, "dev-a", Some("/elsewhere"));
        assert!(resolve_diff(&diffs, &c).is_none());
    }

    #[test]
    fn phases() {
        assert_eq!(diff_phase(None), DiffPhase::Preparing);
        let clean = diff("co", "d", "/w", "  \n");
        assert_eq!(diff_phase(Some(&clean)), DiffPhase::Clean);
        let full = diff("co", "d", "/w", "diff --git a/x b/x\n");
        assert_eq!(diff_phase(Some(&full)), DiffPhase::List);
        // Engine may report files without patch text (truncation edge).
        let mut summarized = diff("co", "d", "/w", "");
        summarized.files.push(comet_proto::DiffFileSummary {
            path: "x".into(),
            old_path: None,
            status: "modified".into(),
            additions: 1,
            deletions: 0,
            binary: false,
        });
        assert_eq!(diff_phase(Some(&summarized)), DiffPhase::List);
    }

    #[test]
    fn header_label_pluralizes() {
        assert_eq!(uncommitted_label(0), "0 Uncommitted changes");
        assert_eq!(uncommitted_label(1), "1 Uncommitted change");
        assert_eq!(uncommitted_label(4), "4 Uncommitted changes");
    }

    #[test]
    fn diff_frames_replace_lists_and_upsert_singles() {
        let mut diffs = Vec::new();
        let one = diff("co-1", "d", "/w", "p1");
        // Single frame inserts.
        assert!(apply_diff_frame(
            &mut diffs,
            serde_json::to_value(&one).unwrap()
        ));
        assert_eq!(diffs.len(), 1);
        // Identical frame is a no-op.
        assert!(!apply_diff_frame(
            &mut diffs,
            serde_json::to_value(&one).unwrap()
        ));
        // Same checkout upserts in place.
        let mut updated = one.clone();
        updated.patch = "p2".into();
        assert!(apply_diff_frame(
            &mut diffs,
            serde_json::to_value(&updated).unwrap()
        ));
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].patch, "p2");
        // List frame replaces wholesale.
        let two = diff("co-2", "d", "/x", "q");
        assert!(apply_diff_frame(
            &mut diffs,
            serde_json::to_value(vec![two.clone()]).unwrap()
        ));
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].checkout_id, "co-2");
        // Malformed frames change nothing.
        assert!(!apply_diff_frame(
            &mut diffs,
            serde_json::json!({"nope": true})
        ));
        assert_eq!(diffs[0].checkout_id, "co-2");
    }

    #[test]
    fn langs_resolve_from_paths() {
        assert_eq!(lang_for_path("src/main.rs"), Some(Lang::Rust));
        assert_eq!(lang_for_path("a/b/app.tsx"), Some(Lang::Js));
        assert_eq!(lang_for_path("Cargo.toml"), Some(Lang::Toml));
        assert_eq!(lang_for_path("script.sh"), Some(Lang::Bash));
        assert_eq!(lang_for_path("README"), None);
        assert_eq!(lang_for_path("img.png"), None);
    }
}
