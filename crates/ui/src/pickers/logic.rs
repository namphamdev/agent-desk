//! Pure picker logic: default resolution, fuzzy filtering, reasoning
//! ladder helpers, traits summary, and folder-browser path helpers.

use std::path::Path;

use comet_proto::{FolderListing, HarnessId, Model, ReasoningLevel};

use comet_engine::registry::HarnessDescriptor;

use crate::popover;

// ---------------------------------------------------------------------------
// Pure: default resolution (no "Default" placeholders — a concrete pick always)
// ---------------------------------------------------------------------------

/// The harness's default model: the first catalog row (both curated catalogs
/// lead with the flagship — comet's `pickDefaultModel` Opus preference maps to
/// the same row here).
pub fn default_model(models: &[Model]) -> Option<&Model> {
    models.first()
}

/// Model rows matching a picker query, ranked with the same fuzzy matcher as
/// the other searchable pickers. IDs and descriptions are searchable too,
/// since ACP agents may expose a friendly label that omits the provider name.
pub fn filter_models<'a>(query: &str, models: &'a [Model]) -> Vec<&'a Model> {
    let labels = models
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
    popover::filter_indices(query, &labels)
        .into_iter()
        .map(|ix| &models[ix])
        .collect()
}

/// A model's default reasoning: X-High when the ladder offers it (comet
/// `DEFAULT_REASONING = "xhigh"`), else High, else the ladder's first entry.
/// `None` only for ladder-less models (e.g. Haiku's thinking toggle instead).
pub fn default_reasoning(ladder: &[ReasoningLevel]) -> Option<ReasoningLevel> {
    // The recommended default is High (user-corrected — not X-High globally);
    // fall to Medium then the ladder's first entry for shorter ladders.
    if ladder.contains(&ReasoningLevel::High) {
        return Some(ReasoningLevel::High);
    }
    if ladder.contains(&ReasoningLevel::Medium) {
        return Some(ReasoningLevel::Medium);
    }
    ladder.first().copied()
}

/// Clamp a picked/remembered level to what the model actually offers: keep it
/// when the ladder lists it, else fall to the model's default (never a stale
/// or foreign level — comet use-run-config.ts's derived-model discipline).
pub fn clamp_reasoning(
    level: Option<ReasoningLevel>,
    ladder: &[ReasoningLevel],
) -> Option<ReasoningLevel> {
    match level {
        Some(level) if ladder.contains(&level) => Some(level),
        _ => default_reasoning(ladder),
    }
}

// ---------------------------------------------------------------------------
// Pure: labels + traits summary
// ---------------------------------------------------------------------------

pub fn reasoning_label(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Minimal => "Minimal",
        ReasoningLevel::Low => "Low",
        ReasoningLevel::Medium => "Medium",
        ReasoningLevel::High => "High",
        ReasoningLevel::XHigh => "X-High",
        ReasoningLevel::Max => "Max",
        ReasoningLevel::Ultra => "Ultra",
        ReasoningLevel::Ultracode => "Ultracode",
        ReasoningLevel::Ultrathink => "Ultrathink",
    }
}

/// The TraitsPicker trigger summary: non-default reasoning + non-default model
/// option choices, joined with " · " (comet: "High · 1M · Fast"). `None` when
/// everything is at its default.
pub fn traits_summary(
    model: Option<&Model>,
    reasoning: Option<ReasoningLevel>,
    selections: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(level) = reasoning {
        parts.push(reasoning_label(level).to_string());
    }
    if let Some(model) = model {
        for option in &model.options {
            let Some(choice_id) = selections.get(&option.id).and_then(|v| v.as_str()) else {
                continue;
            };
            if choice_id == option.default_choice {
                continue;
            }
            if let Some(choice) = option.choices.iter().find(|c| c.id == choice_id) {
                parts.push(choice.label.clone());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

// ---------------------------------------------------------------------------
// Pure: folder-browser navigation (used by the shell's add-space flow)
// ---------------------------------------------------------------------------

/// Parent of an absolute path; `None` at the filesystem root.
pub fn parent_path(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return None; // was "/" (or empty)
    }
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(at) => Some(trimmed[..at].to_string()),
        None => None,
    }
}

/// Join a listing path and an entry name.
pub fn child_path(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// Whether input should be treated as a direct filesystem path rather than a
/// name filter for the current folder.
pub fn is_absolute_path(path: &str) -> bool {
    Path::new(path.trim()).is_absolute()
}

/// Breadcrumb segments for a path: `(label, full path)`, root first.
pub fn breadcrumbs(path: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![("/".to_string(), "/".to_string())];
    let mut acc = String::new();
    for segment in path.split('/').filter(|s| !s.is_empty()) {
        acc.push('/');
        acc.push_str(segment);
        out.push((segment.to_string(), acc.clone()));
    }
    out
}

/// Directory rows of a listing (files never render in the browser).
pub fn browser_rows(listing: &FolderListing) -> Vec<&comet_proto::FolderEntry> {
    listing.entries.iter().filter(|e| e.is_dir).collect()
}

/// Whether the `COMET_HARNESS=mock` dev switch is set.
pub fn mock_harness_enabled() -> bool {
    std::env::var("COMET_HARNESS").as_deref() == Ok("mock")
}

/// Filter the harness list for display: hide the Mock harness unless
/// `COMET_HARNESS=mock` shows it; otherwise it only remains when it's
/// literally all there is (a dev build with no real harness registered).
pub fn visible_harnesses(list: &[HarnessDescriptor]) -> Vec<HarnessDescriptor> {
    visible_harnesses_impl(list, mock_harness_enabled())
}

pub fn visible_harnesses_impl(list: &[HarnessDescriptor], allow_mock: bool) -> Vec<HarnessDescriptor> {
    if allow_mock {
        return list.to_vec();
    }
    let real: Vec<HarnessDescriptor> = list
        .iter()
        .filter(|d| d.id != HarnessId::Mock)
        .cloned()
        .collect();
    if real.is_empty() { list.to_vec() } else { real }
}

