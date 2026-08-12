//! Resolution + states (pure): how a `CheckoutDiff` is selected for a chat,
//! the lifecycle phases the pane shows, and frame-application for the diff
//! watch stream. Pure logic with unit tests; no gpui.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use comet_proto::{Chat, CheckoutDiff};
use gpui::SharedString;
use serde::Deserialize;

use crate::markdown::highlight::{Lang, lang_for_tag};

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

/// 64-bit hash of a string slice join — fingerprint key for highlight slots.
pub fn hash64(parts: &[&str]) -> u64 {
    let mut hasher = std::hash::DefaultHasher::new();
    for p in parts {
        p.hash(&mut hasher);
    }
    hasher.finish()
}

// ---------------------------------------------------------------------------
// Wire types (engine → pane)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStatus {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileChange>,
    pub is_repo: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileChange {
    pub path: String,
    #[allow(dead_code)]
    pub old_path: Option<String>,
    pub kind: String,
    pub staged: bool,
    pub unstaged: bool,
    #[allow(dead_code)]
    pub xy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedCommitMessage {
    pub subject: String,
    pub body: String,
    #[allow(dead_code)]
    pub raw: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitGenerationPicker {
    Harness,
    Model,
}

/// Engine reply to `GitPull`: a status line plus, on conflict, the unmerged
/// paths the modal lists for AI-assisted resolution.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullResult {
    pub summary: String,
    pub conflicted: bool,
    #[serde(default)]
    pub conflicts: Vec<String>,
}

/// Engine reply to `GitResolveConflict`: whether the agent cleared the markers
/// (and staged the file) plus a short note for the info banner.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveConflictResult {
    pub path: String,
    pub resolved: bool,
    pub summary: String,
}

/// Per-file resolution progress inside the conflict modal.
#[derive(Debug, Clone, Default)]
pub(crate) struct ConflictFileState {
    /// Last agent summary, shown under the path once resolution finishes.
    pub summary: Option<SharedString>,
    /// `true` while the agent is working on this file.
    pub resolving: bool,
}

/// The open conflict-resolution modal: the conflicted paths surfaced by the
/// pull, per-file agent state, and an overall banner message. `None` ⇒ the
/// modal is closed (all files resolved or dismissed).
#[derive(Debug, Clone, Default)]
pub(crate) struct ConflictModal {
    pub files: Vec<String>,
    pub states: HashMap<String, ConflictFileState>,
    pub info: Option<SharedString>,
}
