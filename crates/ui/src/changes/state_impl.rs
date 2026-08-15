//! `impl Changes` block #1: constructor + git-context helpers + the harness/model
//! catalogs and commit-message generation RPC plumbing.

use std::collections::{HashMap, HashSet};

use gpui::{App, AppContext, Context, Entity, ListAlignment, ListState, SharedString, px};

use comet_engine::registry::HarnessDescriptor;
use comet_proto::{HarnessId, Model};
use comet_rpc::methods;

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::settings::composer::ComposerDefaults;
use crate::state::AppState;

use super::resolve::{
    ConflictFileState, ConflictModal, GeneratedCommitMessage, GitCommitInfo, GitStatus,
    PullResult, ResolveConflictResult,
};
use super::Changes;

/// Pick the harness descriptor the git-changes "AI message" generator should
/// target, given the catalog and the user's preferred (last-used or
/// chat-configured) harness + ACP agent id.
///
/// This is pure so the ACP-resolution behavior — the bug where every ACP agent
/// collapsed onto `HarnessId::Acp` and the generic slot was targeted — can be
/// regression-tested without a live engine. ACP agents share `HarnessId::Acp`,
/// so the agent id is what distinguishes them; a preferred ACP agent that
/// isn't installed falls back to any ACP descriptor rather than to the first
/// row (which would silently switch the user to a different harness).
pub(super) fn select_generation_descriptor<'a>(
    list: &'a [HarnessDescriptor],
    preferred: Option<HarnessId>,
    preferred_acp_agent: Option<&str>,
) -> Option<&'a HarnessDescriptor> {
    if let Some(preferred) = preferred {
        if preferred == HarnessId::Acp {
            // Match the exact installed agent first.
            if let Some(exact) = list.iter().find(|descriptor| {
                descriptor.id == HarnessId::Acp && descriptor.acp_agent_id.as_deref() == preferred_acp_agent
            }) {
                return Some(exact);
            }
            // Preferred agent no longer installed: any ACP row keeps the user
            // on an ACP agent instead of jumping to Claude/Codex/….
            return list.iter().find(|descriptor| descriptor.id == HarnessId::Acp);
        }
        if let Some(matching) = list.iter().find(|descriptor| descriptor.id == preferred) {
            return Some(matching);
        }
    }
    list.first()
}

impl Changes {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let observe = cx.observe(&state, |this: &mut Self, _, cx| this.sync(cx));
        let subject = cx.new(|cx| ComposerInput::new("Commit subject", cx));
        // The description box is capped at `COMMIT_DESC_MAX_H`; matching the
        // input's internal-scroll cap to the box's content area keeps long
        // messages scrolling inside the box instead of overflowing it.
        let body = cx.new(|cx| {
            ComposerInput::new("Description (optional)", cx)
                .with_max_content_height(super::COMMIT_DESC_INPUT_MAX_H)
        });
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
            |_: &mut Self, _, _: &ComposerInputEvent, cx| cx.notify(),
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
            git_log: None,
            git_log_open: false,
            git_log_loading: false,
            git_log_expanded: None,
            git_log_scroll: gpui::ScrollHandle::new(),
            git_log_task: None,
            git_context_key: None,
            git_loading: false,
            git_busy: None,
            git_generating: false,
            git_info: None,
            generation_loading: false,
            generation_picker: None,
            selected_paths: HashSet::new(),
            selected_detail: None,
            file_menu: None,
            detail_scroll: gpui::ScrollHandle::new(),
            conflict_modal: None,
            generation_defaults,
            generation_defaults_dir,
            harnesses: Vec::new(),
            models: Vec::new(),
            selected_harness: None,
            selected_acp_agent: None,
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

    pub(super) fn git_context(&self, cx: &App) -> Option<(String, Option<String>)> {
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

    pub(super) fn with_git_target(
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

    /// Toggle the commit-history section. Opening it fetches `GitLog`; closing
    /// drops the cached entries (they're only valid for the current context).
    pub(super) fn toggle_log(&mut self, cx: &mut Context<Self>) {
        if self.git_log_open {
            self.git_log_open = false;
            self.git_log = None;
            self.git_log_expanded = None;
            cx.notify();
            return;
        }
        self.git_log_open = true;
        self.load_log(cx);
    }

    /// Fetch the recent commit history for the current git context (cwd +
    /// optional remote device, matching every other git call in the pane).
    pub(super) fn load_log(&mut self, cx: &mut Context<Self>) {
        if self.git_log_loading {
            return;
        }
        let Some((cwd, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.git_log_loading = true;
        self.git_log = None;
        self.git_log_expanded = None;
        let params = Self::with_git_target(&cwd, &target, serde_json::json!({ "count": 50 }));
        self.git_log_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call_as::<Vec<GitCommitInfo>>(methods::GIT_LOG, params)
                .await;
            this.update(cx, |changes, cx| {
                changes.git_log_loading = false;
                match result {
                    Ok(commits) => changes.git_log = Some(commits),
                    Err(error) => changes.error =
                        Some(format!("Git history unavailable: {error}").into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Expand/collapse one commit's details in the history view.
    pub(super) fn toggle_log_commit(&mut self, hash: String, cx: &mut Context<Self>) {
        self.git_log_expanded = if self.git_log_expanded.as_deref() == Some(hash.as_str()) {
            None
        } else {
            Some(hash)
        };
        cx.notify();
    }

    pub(super) fn refresh_git(&mut self, cx: &mut Context<Self>) {
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

    pub(super) fn load_generation_options(&mut self, cx: &mut Context<Self>) {
        if self.generation_loading {
            return;
        }
        let Some((_, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        // The git panel's own "last pick" memory wins over the selected
        // chat's config: the panel is not harness-locked (unlike the
        // composer), so a pick made here must survive app restarts even when
        // boot auto-selects a chat that was created with a different harness
        // (e.g. an ACP agent). The chat config is only the first-run fallback.
        let preferred = self
            .generation_defaults
            .harness
            .or_else(|| {
                self.state
                    .read(cx)
                    .selected_chat_row()
                    .and_then(|chat| chat.config.as_ref())
                    .map(|config| config.harness)
            });
        // A chat configured for an ACP agent carries the agent id on its
        // config; without it the catalog and generation resolve the generic
        // ACP slot instead of the installed agent (e.g. "Grok") the user
        // picked. `generation_defaults` has no per-agent memory, so the chat
        // config is the only source of the preferred agent id on first run.
        let preferred_acp_agent = preferred
            .and_then(|harness| {
                if harness != HarnessId::Acp {
                    return None;
                }
                self.state
                    .read(cx)
                    .selected_chat_row()
                    .and_then(|chat| chat.config.as_ref())
                    .and_then(|config| config.acp_agent_id.clone())
            });
        let preferred_model = preferred.and_then(|harness| {
            self.generation_defaults
                .model_for(harness)
                .map(|model| model.id.clone())
                .or_else(|| {
                    self.state
                        .read(cx)
                        .selected_chat_row()
                        .and_then(|chat| chat.config.as_ref())
                        .and_then(|config| config.model.clone())
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
            // Resolve the selected descriptor: the preferred harness (with its
            // ACP agent id when applicable), else the first row. ACP agents
            // share `HarnessId::Acp`, so the agent id is matched against the
            // descriptor's `acp_agent_id` to land on the exact installed agent
            // (e.g. "Grok") instead of the generic slot. See
            // [`select_generation_descriptor`].
            let selected_descriptor = harnesses
                .as_ref()
                .ok()
                .and_then(|list| select_generation_descriptor(list, preferred, preferred_acp_agent.as_deref()));
            let selected = selected_descriptor.map(|descriptor| descriptor.id);
            let selected_acp_agent = selected_descriptor
                .filter(|descriptor| descriptor.id == HarnessId::Acp)
                .and_then(|descriptor| descriptor.acp_agent_id.clone());
            let models = if let Some(harness) = selected {
                let mut params = serde_json::json!({ "harness": harness });
                if harness == HarnessId::Acp
                    && let Some(object) = params.as_object_mut()
                {
                    if let Some(agent_id) = &selected_acp_agent {
                        object.insert(
                            "acpAgentId".into(),
                            serde_json::Value::String(agent_id.clone()),
                        );
                    }
                }
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
                        changes.selected_acp_agent = selected_acp_agent;
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

    pub(super) fn select_harness(
        &mut self,
        harness: HarnessId,
        acp_agent_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
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
        // Only ACP carries an agent id; clear it for every other harness so a
        // prior ACP pick can't leak into a non-ACP catalog/generation call.
        self.selected_acp_agent = (harness == HarnessId::Acp).then(|| acp_agent_id).flatten();
        self.generation_defaults.harness = Some(harness);
        self.save_generation_defaults();
        self.selected_model = None;
        self.models.clear();
        self.generation_picker = None;
        self.generation_loading = true;
        let mut params = serde_json::json!({ "harness": harness });
        if harness == HarnessId::Acp
            && let Some(object) = params.as_object_mut()
            && let Some(agent_id) = &self.selected_acp_agent
        {
            object.insert(
                "acpAgentId".into(),
                serde_json::Value::String(agent_id.clone()),
            );
        }
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
                            let resolved = remembered_model
                                .filter(|id| models.iter().any(|model| &model.id == id))
                                .or_else(|| models.first().map(|model| model.id.clone()));
                            changes.selected_model = resolved.clone();
                            changes.models = models;
                            // Keep composer-defaults.json in sync with the
                            // actually-selected model: an explicitly clicked
                            // row persists itself, but an auto fallback (the
                            // first model, or a remembered id the catalog no
                            // longer offers) has no click handler — persist it
                            // here so agent + model are always both on disk.
                            if let Some(id) = resolved
                                && changes
                                    .generation_defaults
                                    .model_for(harness)
                                    .is_none_or(|m| m.id != id)
                                && let Some(model) =
                                    changes.models.iter().find(|m| m.id == id)
                            {
                                changes.generation_defaults.remember_model(
                                    harness,
                                    model.id.clone(),
                                    model.label.clone(),
                                );
                                changes.save_generation_defaults();
                            }
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

    pub(super) fn generate_commit_message(&mut self, cx: &mut Context<Self>) {
        if self.git_busy.is_some() || self.git_generating {
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
        // Generation runs on its own flag (not `git_busy`) so staging and the
        // other file actions stay usable while the LLM is working.
        self.git_generating = true;
        self.error = None;
        self.git_info = None;
        let params = Self::with_git_target(
            &cwd,
            &target,
            serde_json::json!({
                "harness": harness,
                "model": self.selected_model,
                "acpAgentId": (harness == HarnessId::Acp).then(|| self.selected_acp_agent.clone()).flatten(),
            }),
        );
        self.generation_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call_as::<GeneratedCommitMessage>(methods::GIT_GENERATE_COMMIT_MESSAGE, params)
                .await;
            this.update(cx, |changes, cx| {
                changes.git_generating = false;
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

    pub(super) fn run_paths(&mut self, paths: Vec<String>, stage: bool, cx: &mut Context<Self>) {
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

    pub(super) fn run_remote(&mut self, push: bool, cx: &mut Context<Self>) {
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

    /// `git pull`: fetches + merges the upstream. On conflict the engine
    /// returns the unmerged paths, which we surface in the AI-assisted
    /// conflict-resolution modal. A clean pull just refreshes the file list.
    pub(super) fn run_pull(&mut self, cx: &mut Context<Self>) {
        if self.git_busy.is_some() {
            return;
        }
        let Some((cwd, target)) = self.git_context(cx) else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.git_busy = Some("pull");
        self.error = None;
        self.git_info = None;
        let params = Self::with_git_target(&cwd, &target, serde_json::json!({}));
        self.git_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call_as::<PullResult>(methods::GIT_PULL, params)
                .await;
            this.update(cx, |changes, cx| {
                changes.git_busy = None;
                match result {
                    Ok(pull) => {
                        if pull.conflicted && !pull.conflicts.is_empty() {
                            // Open the modal keyed to the actual unmerged paths.
                            let mut states = HashMap::new();
                            for path in &pull.conflicts {
                                states.insert(path.clone(), ConflictFileState::default());
                            }
                            changes.conflict_modal = Some(ConflictModal {
                                files: pull.conflicts.clone(),
                                states,
                                info: Some(pull.summary.clone().into()),
                            });
                            changes.git_info = Some(pull.summary.into());
                        } else {
                            changes.git_info = Some(pull.summary.into());
                        }
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

    /// Hand a single conflicted file to the selected harness/model agent for
    /// resolution. Runs under `git_generating` (not `git_busy`) so the rest of
    /// the panel stays usable and other files can resolve in turn.
    pub(super) fn resolve_conflict_file(&mut self, path: String, cx: &mut Context<Self>) {
        if self.git_generating {
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
        // Mark this file as resolving inside the modal (if still open).
        if let Some(modal) = self.conflict_modal.as_mut()
            && let Some(state) = modal.states.get_mut(&path)
        {
            state.resolving = true;
            state.summary = None;
        }
        self.git_generating = true;
        self.error = None;
        let params = Self::with_git_target(
            &cwd,
            &target,
            serde_json::json!({
                "path": path,
                "harness": harness,
                "model": self.selected_model,
                "acpAgentId": (harness == HarnessId::Acp).then(|| self.selected_acp_agent.clone()).flatten(),
            }),
        );
        self.generation_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call_as::<ResolveConflictResult>(methods::GIT_RESOLVE_CONFLICT, params)
                .await;
            this.update(cx, |changes, cx| {
                changes.git_generating = false;
                match result {
                    Ok(out) => {
                        if let Some(modal) = changes.conflict_modal.as_mut()
                            && let Some(state) = modal.states.get_mut(&out.path)
                        {
                            state.resolving = false;
                            state.summary = Some(out.summary.clone().into());
                        }
                        if out.resolved {
                            // Drop the resolved path from the modal; close it
                            // once the last conflict is cleared.
                            let cleared_all = changes.conflict_modal.as_ref().is_some_and(|m| {
                                m.files.iter().filter(|p| *p != &out.path).count() == 0
                            });
                            if let Some(modal) = changes.conflict_modal.as_mut() {
                                modal.files.retain(|p| p != &out.path);
                                modal.states.remove(&out.path);
                            }
                            if cleared_all {
                                changes.conflict_modal = None;
                                changes.git_info = Some("All conflicts resolved.".into());
                            } else {
                                changes.git_info = Some(out.summary.into());
                            }
                            changes.refresh_git(cx);
                        } else {
                            changes.git_info = Some(out.summary.into());
                        }
                    }
                    Err(err) => {
                        if let Some(modal) = changes.conflict_modal.as_mut()
                            && let Some(state) = modal.states.get_mut(&path)
                        {
                            state.resolving = false;
                        }
                        changes.error =
                            Some(format!("Conflict resolution failed: {err}").into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Dismiss the conflict modal without forcing resolution (the merge stays
    /// in progress on disk until the user resolves or aborts).
    pub(super) fn close_conflict_modal(&mut self, cx: &mut Context<Self>) {
        self.conflict_modal = None;
        cx.notify();
    }

    pub(super) fn commit(&mut self, cx: &mut Context<Self>) {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use comet_proto::{ReasoningLevel, SteeringMode};

    fn descriptor(id: HarnessId, name: &str, acp_agent_id: Option<&str>) -> HarnessDescriptor {
        HarnessDescriptor {
            id,
            name: name.into(),
            supports_steering: false,
            steering_mode: SteeringMode::TurnBoundary,
            reasoning_levels: vec![ReasoningLevel::Medium],
            acp_agent_id: acp_agent_id.map(str::to_owned),
            icon: None,
        }
    }

    /// Regression: two installed ACP agents share `HarnessId::Acp`. The git
    /// changes panel used to key its harness picker on `HarnessId` alone, so
    /// "Grok build ACP" was indistinguishable from any other ACP agent and the
    /// generic slot was targeted. The resolver must land on the exact agent id
    /// the chat was configured with.
    #[test]
    fn resolves_acp_agent_by_id_not_just_harness() {
        let list = vec![
            descriptor(HarnessId::ClaudeCode, "Claude Code", None),
            descriptor(HarnessId::Acp, "Grok", Some("grok")),
            descriptor(HarnessId::Acp, "Goose", Some("goose")),
        ];
        let picked = select_generation_descriptor(&list, Some(HarnessId::Acp), Some("grok")).unwrap();
        assert_eq!(picked.id, HarnessId::Acp);
        assert_eq!(picked.name, "Grok");
        assert_eq!(picked.acp_agent_id.as_deref(), Some("grok"));
    }

    /// A different agent id selects a different row — proves we aren't just
    /// returning the first ACP descriptor.
    #[test]
    fn resolves_a_different_acp_agent() {
        let list = vec![
            descriptor(HarnessId::Acp, "Grok", Some("grok")),
            descriptor(HarnessId::Acp, "Goose", Some("goose")),
        ];
        let picked = select_generation_descriptor(&list, Some(HarnessId::Acp), Some("goose")).unwrap();
        assert_eq!(picked.acp_agent_id.as_deref(), Some("goose"));
    }

    /// Preferred ACP agent no longer installed: stay on ACP (any agent) rather
    /// than silently switching harnesses.
    #[test]
    fn preferred_acp_agent_missing_falls_back_to_acp() {
        let list = vec![
            descriptor(HarnessId::ClaudeCode, "Claude Code", None),
            descriptor(HarnessId::Acp, "Grok", Some("grok")),
        ];
        let picked = select_generation_descriptor(&list, Some(HarnessId::Acp), Some("uninstalled")).unwrap();
        assert_eq!(picked.id, HarnessId::Acp);
        assert_eq!(picked.acp_agent_id.as_deref(), Some("grok"));
    }

    /// Non-ACP harnesses are unaffected by the agent-id dimension.
    #[test]
    fn non_acp_harness_resolves_normally() {
        let list = vec![
            descriptor(HarnessId::Acp, "Grok", Some("grok")),
            descriptor(HarnessId::ClaudeCode, "Claude Code", None),
        ];
        let picked = select_generation_descriptor(&list, Some(HarnessId::ClaudeCode), None).unwrap();
        assert_eq!(picked.id, HarnessId::ClaudeCode);
    }
}
