//! Navigation history (back/forward) and the DragGhost overlay.

use gpui::{Context, Empty, Entity, IntoElement, SharedString, Subscription, Task, Window, prelude::*};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::composer::ComposerInput;
use crate::motion::{self, MotionSpec};
use crate::popover::Loadable;
use crate::settings::{AiShortcut, KeymapConfig};
use crate::state::OrgRow;
use super::layout::SettingsSection;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavEntry {
    /// A chat route; the id of the selected chat ("" = the new-chat canvas).
    Chat(String),
    Settings(SettingsSection),
}

/// Browser-style navigation history for the titlebar back/forward buttons
/// (comet window-controls.tsx semantics): every route change pushes an entry;
/// Back/Forward walk the stack without changing it; pushing while behind the
/// tip truncates the entries ahead (a new branch, exactly like a browser).
#[derive(Debug)]
pub struct NavHistory {
    pub(crate) entries: Vec<NavEntry>,
    pub(crate) index: usize,
}

impl NavHistory {
    pub fn new(initial: NavEntry) -> Self {
        Self {
            entries: vec![initial],
            index: 0,
        }
    }

    pub fn current(&self) -> &NavEntry {
        &self.entries[self.index]
    }

    /// Record a route change. Re-navigating to the current route is a no-op
    /// (selecting the already-selected chat never happened as a navigation);
    /// otherwise any forward branch is truncated and the entry appended.
    pub fn push(&mut self, entry: NavEntry) {
        if *self.current() == entry {
            return;
        }
        self.entries.truncate(self.index + 1);
        self.entries.push(entry);
        self.index += 1;
    }

    /// Swap the current entry in place without growing the stack — the native
    /// equivalent of a `replace: true` navigation (comet's boot redirect from
    /// `/` into the last-used chat leaves no dead Back target behind).
    pub fn replace(&mut self, entry: NavEntry) {
        self.entries[self.index] = entry;
    }

    pub fn can_back(&self) -> bool {
        self.index > 0
    }

    /// Memory history keeps every entry, so "behind the last entry" is exactly
    /// "can go forward" (comet window-controls.tsx).
    pub fn can_forward(&self) -> bool {
        self.index + 1 < self.entries.len()
    }

    pub fn back(&mut self) -> Option<NavEntry> {
        if !self.can_back() {
            return None;
        }
        self.index -= 1;
        Some(self.current().clone())
    }

    pub fn forward(&mut self) -> Option<NavEntry> {
        if !self.can_forward() {
            return None;
        }
        self.index += 1;
        Some(self.current().clone())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Sidebar resort glide (feature-inventory §1.6): 260ms
/// `cubic-bezier(0.22,1,0.36,1)` per-row translate, the View Transitions
/// equivalent.
pub(crate) const RESORT: MotionSpec = MotionSpec::new(260, motion::EASE_RESORT);

/// FLIP diff for a keyed list: given the previously rendered order and the new
/// order (key + row height), return each surviving key's paint-only start
/// offset `old_y - new_y` (only keys whose position actually moved). `gap` is
/// the flex gap between rows. Pure — drives the sidebar resort glide.
pub fn resort_offsets(
    old: &[(String, f32)],
    new: &[(String, f32)],
    gap: f32,
) -> std::collections::HashMap<String, f32> {
    let mut old_y = std::collections::HashMap::new();
    let mut y = 0.0_f32;
    for (key, height) in old {
        old_y.insert(key.as_str(), y);
        y += height + gap;
    }
    let mut offsets = std::collections::HashMap::new();
    let mut y = 0.0_f32;
    for (key, height) in new {
        if let Some(prev) = old_y.get(key.as_str()) {
            let dy = prev - y;
            if dy.abs() > 0.5 {
                offsets.insert(key.clone(), dy);
            }
        }
        y += height + gap;
    }
    offsets
}

/// Estimated sidebar session-row height (sidebar tree §3.4): the compact
/// 2-line row — title line 17px + 2px gap + meta line 13px inside 5px
/// vertical padding. Also the uniform slot height for the virtualized tree
/// list (space rows fill the same slot, §3.8 option A).
pub(crate) const CHAT_ROW_HEIGHT: f32 = 44.0;
/// Session-child indent under a space parent (px of left padding).
pub(crate) const TREE_INDENT: f32 = 14.0;
/// Flex gap between sidebar list items.
pub(crate) const SIDEBAR_LIST_GAP: f32 = 2.0;

/// Ramp height of the glass sidebar's scroll-edge fade (the gpui
/// [`gpui::EdgeFade`] scope — per-primitive, so text fades per glyph).
pub(crate) const SIDEBAR_GLASS_FADE_BAND: f32 = 32.0;

/// Drag marker for the sidebar resize handle.
pub(crate) struct SidebarResize;
/// Drag marker for the right-pane resize handle.
pub(crate) struct RightPaneResize;
/// Drag marker for the terminal-panel height handle.
pub(crate) struct TerminalResize;

/// Invisible drag ghost — resize drags render nothing at the cursor.
pub(crate) struct DragGhost;

impl Render for DragGhost {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

/// A oneshot width tween (200ms ease-out), driven MANUALLY from render via
/// [`Shell::eval_tween`] — never through a `with_animation` wrapper. gpui keys
/// an animation element's start time by its full global element-id path, so a
/// wrapper that mounts/remounts (route swap, or an ancestor animation keyed by
/// a fresh epoch) silently REPLAYS the tween from t=0. Manual evaluation keeps
/// the element tree's shape constant: a finished or stale tween is exactly the
/// steady state, no matter how the tree around it remounts (round-6 §1–3).
#[derive(Debug, Clone, Copy)]
pub(crate) struct WidthTween {
    pub(crate) from: f32,
    pub(crate) to: f32,
    pub(crate) started: std::time::Instant,
}

impl WidthTween {
    pub(super) fn new(from: f32, to: f32) -> Self {
        Self {
            from,
            to,
            started: std::time::Instant::now(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SplashPhase {
    Visible,
    FadingOut,
    Gone,
}

/// The chat-row Rename dialog.
pub(crate) struct RenameChatDialog {
    pub(crate) chat_id: String,
    pub(crate) input: Entity<ComposerInput>,
    /// Focus the input on the dialog's first paint (opened without window access).
    pub(crate) focus_pending: bool,
    pub(crate) _events: Subscription,
}

/// In-app update lifecycle (macOS bundle installs; see `render_update_strip`).
pub(crate) enum UpdateFlow {
    Idle,
    Downloading,
    /// Staged bundle ready to swap in — one click restarts into it.
    Ready(PathBuf),
    Failed(SharedString),
}

/// The "Create your workspace" gate (feature-inventory §1.2 OrgGate).
pub(crate) struct OrgGateUi {
    pub(crate) name_input: Entity<ComposerInput>,
    pub(crate) orgs: Loadable<Vec<OrgRow>>,
    pub(crate) submitting: bool,
    pub(crate) error: Option<SharedString>,
    pub(crate) task: Option<Task<()>>,
    pub(crate) _events: Subscription,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncedShortcuts {
    pub(crate) keymap: KeymapConfig,
    pub(crate) ai_shortcuts: Vec<AiShortcut>,
}

