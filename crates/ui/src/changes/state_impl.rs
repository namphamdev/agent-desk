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

use super::resolve::{GeneratedCommitMessage, GitStatus};
use super::Changes;

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

    pub(super) fn select_harness(&mut self, harness: HarnessId, cx: &mut Context<Self>) {
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

