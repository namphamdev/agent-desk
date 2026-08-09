//! `impl Pickers` part 3: query helpers, traits/checkout resolution, keyboard nav.


use gpui::{App, AppContext, Context, Focusable as _, KeyDownEvent, SharedString, Window};

use comet_proto::{Model, PermissionMode, ReasoningLevel, RepoRef};

use crate::popover::{self, MenuKey};

use super::config::{CheckoutKind, CheckoutPlan};
use super::logic::filter_models;
use super::{PickerKind, Pickers, MAX_REF_ROWS};

impl Pickers {

    /// The traits popover's reasoning ladder (model levels, falling back to
    /// the harness's advertised ladder) — shared by render and keyboard nav.
    pub(super) fn trait_ladder(&self, cx: &App) -> Vec<ReasoningLevel> {
        let Some(model) = self.selected_model(cx) else {
            return Vec::new();
        };
        if !model.reasoning_levels.is_empty() {
            return model.reasoning_levels.clone();
        }
        self.effective_harness(cx)
            .and_then(|h| {
                self.harnesses
                    .ready()
                    .and_then(|list| list.iter().find(|d| d.id == h))
                    .map(|d| d.reasoning_levels.clone())
            })
            .unwrap_or_default()
    }

    /// Whether the selected model advertises ANY trait — a reasoning ladder
    /// (its own or the harness's) or at least one model option. The traits
    /// chip hides entirely when this is false: a dead trigger reads as broken
    /// (comet hides it for Hermes, which exposes no traits over ACP).
    pub(super) fn traits_available(&self, cx: &App) -> bool {
        if !self.trait_ladder(cx).is_empty() {
            return true;
        }
        self.selected_model(cx)
            .is_some_and(|model| !model.options.is_empty())
    }

    /// The viewed harness's filtered model list, when loaded.
    pub(super) fn filtered_model_rows(&self, cx: &App) -> Vec<Model> {
        let Some(models) = self
            .effective_harness(cx)
            .and_then(|h| {
                let acp_agent_id = self.effective_acp_agent_id(cx);
                self.models.get(&(h, acp_agent_id))
            })
            .and_then(|l| l.ready())
        else {
            return Vec::new();
        };
        let query = self.search.read(cx).text().to_string();
        filter_models(&query, models).into_iter().cloned().collect()
    }

    /// The viewed harness's filtered model list (keyboard nav rows).
    pub(super) fn model_rows_len(&self, cx: &App) -> usize {
        self.filtered_model_rows(cx).len()
    }

    /// Enter on the harness/model popover: pick the highlighted model.
    pub(super) fn activate_model_row(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self
            .filtered_model_rows(cx)
            .get(self.active)
            .map(|model| model.id.clone())
        else {
            return;
        };
        self.pick_model(id, cx);
    }

    pub(super) fn filtered_ref_rows(&self, cx: &App) -> Vec<RepoRef> {
        let Some(refs) = self.refs.ready() else {
            return Vec::new();
        };
        let names: Vec<String> = refs.iter().map(|r| r.name.clone()).collect();
        let query = self.search.read(cx).text().to_string();
        popover::filter_indices(&query, &names)
            .into_iter()
            .map(|ix| refs[ix].clone())
            .collect()
    }

    // ---- checkout resolution (the t3code env-mode semantics) ----

    /// Index of the highlighted-by-default row in the (filtered) ref list:
    /// the session's branch on an existing chat, the draft pick on a new one,
    /// else the current branch. Capped to the displayed window.
    pub(super) fn selected_ref_index(&self, cx: &App) -> usize {
        let rows = self.filtered_ref_rows(cx);
        let selected = self
            .state
            .read(cx)
            .selected_chat_row()
            .and_then(|c| c.branch.clone())
            .or_else(|| self.config.branch.clone());
        let index = match selected {
            Some(name) => rows.iter().position(|r| r.name == name).unwrap_or(0),
            None => rows.iter().position(|r| r.current).unwrap_or(0),
        };
        index.min(MAX_REF_ROWS.saturating_sub(1))
    }

    /// The picked ref's row, else the repo's current branch's row.
    pub(super) fn selected_ref(&self) -> Option<&RepoRef> {
        let refs = self.refs.ready()?;
        match self.config.branch.as_deref() {
            Some(name) => refs.iter().find(|r| r.name == name),
            None => refs.iter().find(|r| r.current),
        }
    }

    /// The picked (or current) ref's name.
    pub(super) fn effective_ref_name(&self) -> Option<String> {
        self.config
            .branch
            .clone()
            .or_else(|| self.selected_ref().map(|r| r.name.clone()))
    }

    /// The existing worktree the picked ref is materialized in, if any.
    pub(super) fn selected_ref_worktree(&self) -> Option<String> {
        self.selected_ref().and_then(|r| r.worktree_path.clone())
    }

    /// The resolved on-send checkout action for a new session.
    pub fn checkout_plan(&self) -> CheckoutPlan {
        match self.config.checkout {
            CheckoutKind::NewWorktree => CheckoutPlan::NewWorktree {
                base: self.effective_ref_name(),
            },
            CheckoutKind::Local => match self.selected_ref_worktree() {
                Some(path) => CheckoutPlan::ReuseWorktree {
                    path,
                    branch: self.effective_ref_name().unwrap_or_default(),
                },
                None => CheckoutPlan::CurrentCheckout {
                    branch: self.effective_ref_name(),
                },
            },
        }
    }

    /// Label of the checkout-kind trigger (t3code `resolveEnvModeLabel` /
    /// `resolveCurrentWorkspaceLabel`).
    pub(super) fn checkout_label(&self) -> &'static str {
        match self.config.checkout {
            CheckoutKind::NewWorktree => "New worktree",
            CheckoutKind::Local => {
                if self.selected_ref_worktree().is_some() {
                    "Current worktree"
                } else {
                    "Current checkout"
                }
            }
        }
    }

    /// Label of the ref trigger: `From <ref>` only when a NEW worktree will be
    /// created off it (t3code `getBranchTriggerLabel`); the bare name otherwise.
    pub(super) fn ref_label(&self) -> SharedString {
        match (self.config.checkout, self.effective_ref_name()) {
            (_, None) => SharedString::from("Select ref"),
            (CheckoutKind::NewWorktree, Some(name)) => SharedString::from(format!("From {name}")),
            (CheckoutKind::Local, Some(name)) => SharedString::from(name),
        }
    }

    pub(super) fn on_search_submit(&mut self, cx: &mut Context<Self>) {
        if self.open == Some(PickerKind::Branch)
            && let Some(row) = self.filtered_ref_rows(cx).into_iter().nth(self.active)
        {
            self.pick_ref(row, cx);
        } else if self.open == Some(PickerKind::HarnessModel) {
            self.activate_model_row(cx);
        }
    }

    pub(super) fn on_key_down(&mut self, event: &KeyDownEvent, window: &Window, cx: &mut Context<Self>) {
        let key = popover::classify_key(
            event.keystroke.key.as_str(),
            event.keystroke.modifiers.platform,
            event.keystroke.modifiers.control,
        );
        let search_focused = self.search.read(cx).focus_handle(cx).is_focused(window);
        match key {
            MenuKey::Escape => {
                self.open = None;
                cx.notify();
            }
            MenuKey::Up | MenuKey::Down => {
                let delta = if key == MenuKey::Up { -1 } else { 1 };
                let count = match self.open {
                    Some(PickerKind::Branch) => self.filtered_ref_rows(cx).len().min(MAX_REF_ROWS),
                    Some(PickerKind::Checkout) => 2,
                    // Keyboard nav walks the MODEL list only; traits
                    // (reasoning ladder, model options) live in their own
                    // dropdown and are mouse-only.
                    Some(PickerKind::HarnessModel) => self.model_rows_len(cx),
                    Some(PickerKind::Permission) => 4,
                    Some(PickerKind::Traits) => 0, // chips are mouse-only
                    None => 0,
                };
                self.active = popover::menu_step(Some(self.active), count, delta).unwrap_or(0);
                // Keep the highlighted MODEL row in view (the rows are the
                // scroll container's direct children, so indices map 1:1).
                if self.open == Some(PickerKind::HarnessModel)
                    && self.active < self.model_rows_len(cx)
                {
                    self.model_scroll.scroll_to_item(self.active);
                }
                cx.notify();
            }
            MenuKey::Enter if !search_focused => {
                if self.open == Some(PickerKind::HarnessModel) {
                    self.activate_model_row(cx);
                } else if self.open == Some(PickerKind::Checkout) {
                    let kind = if self.active == 0 {
                        CheckoutKind::Local
                    } else {
                        CheckoutKind::NewWorktree
                    };
                    self.pick_checkout(kind, cx);
                } else if self.open == Some(PickerKind::Permission) {
                    let mode = [
                        PermissionMode::Default,
                        PermissionMode::Plan,
                        PermissionMode::AcceptEdits,
                        PermissionMode::FullAccess,
                    ][self.active.min(3)];
                    self.pick_permission(mode, cx);
                } else {
                    self.on_search_submit(cx);
                }
            }
            _ => {}
        }
    }

}

