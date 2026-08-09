//! `impl Pickers` part 2: catalog loading + selection handlers + chat config update.


use gpui::Context;

use comet_engine::registry::HarnessDescriptor;
use comet_proto::{ChatConfig, HarnessId, Model, PermissionMode, ReasoningLevel, RepoRef};
use comet_rpc::methods;

use crate::popover::Loadable;

use super::config::CheckoutKind;
use super::logic::clamp_reasoning;
use super::{PickerKind, Pickers};

impl Pickers {

    // ---- loads ----

    pub(super) fn ensure_harnesses(&mut self, cx: &mut Context<Self>) {
        // Only load from Idle: `render` re-runs this every frame, so an Error
        // that could re-trigger a load would flip back to Loading before the
        // retry row ever painted (and spam the engine). Retry resets to Idle.
        if !matches!(self.harnesses, Loadable::Idle) {
            return;
        }
        let Some(engine) = self.engine(cx) else {
            return;
        };
        let target = self.space_target(cx);
        self.harnesses = Loadable::Loading;
        self.load_task = Some(cx.spawn(async move |this, cx| {
            let mut params = serde_json::Map::new();
            if let Some(target) = &target {
                params.insert(
                    "targetDeviceId".into(),
                    serde_json::Value::String(target.clone()),
                );
            }
            let result = engine
                .client()
                .call(methods::LIST_HARNESSES, serde_json::Value::Object(params))
                .await;
            this.update(cx, |pickers, cx| {
                pickers.harnesses = match result {
                    Ok(value) => match serde_json::from_value::<Vec<HarnessDescriptor>>(value) {
                        Ok(list) => Loadable::Ready(list),
                        Err(err) => Loadable::Error(err.to_string()),
                    },
                    Err(err) => Loadable::Error(err.to_string()),
                };
                if let Some(harness) = pickers.effective_harness(cx) {
                    let acp_agent_id = pickers.effective_acp_agent_id(cx);
                    pickers.ensure_models(harness, acp_agent_id, cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub(super) fn ensure_models(
        &mut self,
        harness: HarnessId,
        acp_agent_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let cache_key = (harness, acp_agent_id.clone());
        // Absent or Idle only — same render-loop hazard as `ensure_harnesses`;
        // the retry row clears the map to re-arm.
        if self
            .models
            .get(&cache_key)
            .is_some_and(|slot| !matches!(slot, Loadable::Idle))
        {
            return;
        }
        let Some(engine) = self.engine(cx) else {
            return;
        };
        let target = self.space_target(cx);
        self.models.insert(cache_key.clone(), Loadable::Loading);
        cx.spawn(async move |this, cx| {
            let mut params = serde_json::json!({ "harness": harness });
            if let Some(ref id) = acp_agent_id {
                if let Some(object) = params.as_object_mut() {
                    object.insert("acpAgentId".into(), serde_json::Value::String(id.clone()));
                }
            }
            if let (Some(target), Some(object)) = (&target, params.as_object_mut()) {
                object.insert(
                    "targetDeviceId".into(),
                    serde_json::Value::String(target.clone()),
                );
            }
            let result = engine.client().call(methods::LIST_MODELS, params).await;
            this.update(cx, |pickers, cx| {
                let loaded = match result {
                    Ok(value) => match serde_json::from_value::<Vec<Model>>(value) {
                        Ok(models) => Loadable::Ready(models),
                        Err(err) => Loadable::Error(err.to_string()),
                    },
                    Err(err) => Loadable::Error(err.to_string()),
                };
                if let Loadable::Ready(models) = &loaded {
                    let fresh = pickers
                        .defaults
                        .remember_labels(models.iter().map(|m| (m.id.as_str(), m.label.as_str())));
                    if fresh {
                        pickers.save_defaults();
                    }
                }
                pickers.models.insert(cache_key, loaded);
                // Models arrived after the picker was already open: re-center
                // the keyboard highlight on the selected row, otherwise it
                // stays at 0 (set when the list was empty) and reads as a
                // second selection alongside the real pick.
                if pickers.open == Some(PickerKind::HarnessModel) {
                    pickers.active = pickers.selected_model_index(cx);
                    pickers.model_scroll.scroll_to_item(pickers.active);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// ListRefs for the selected SPACE's folder — targeted at the space's
    /// device (relay-forwarded when remote), keyed/invalidated by space id.
    /// Rows carry checkout state (`current`, `worktreePath`) so the picker can
    /// tag refs and the checkout-kind selector can offer worktree reuse.
    pub(super) fn ensure_refs(&mut self, force: bool, cx: &mut Context<Self>) {
        let Some(space) = self.state.read(cx).selected_space_row().cloned() else {
            return;
        };
        if !space.git_detected {
            return;
        }
        let fresh = self.refs_space.as_deref() == Some(space.id.as_str());
        if fresh && matches!(self.refs, Loadable::Loading) {
            return; // a load is already in flight
        }
        // Non-forced (the footer's eager kick, re-run every render) only loads
        // from Idle: an Error must WAIT for an explicit retry/reopen (force),
        // or re-render would flip Error back to Loading before the retry row
        // ever paints — an eternal skeleton plus an RPC storm (user report:
        // "the ref dropdown never loads anything").
        if !force && fresh && !matches!(self.refs, Loadable::Idle) {
            return;
        }
        let Some(engine) = self.engine(cx) else {
            return;
        };
        let local = self.state.read(cx).local_device_id.clone();
        // Stale-while-revalidate: a forced refresh of an already-loaded space
        // keeps the current rows on screen while the reload runs — a send that
        // just minted a worktree (or a terminal-side branch) appears on the
        // popover's next open without the list ever flashing to a skeleton.
        if !(force && fresh && matches!(self.refs, Loadable::Ready(_))) {
            self.refs = Loadable::Loading;
        }
        self.refs_space = Some(space.id.clone());
        self.refs_task = Some(cx.spawn(async move |this, cx| {
            let mut params = serde_json::Map::new();
            params.insert(
                "repoPath".into(),
                serde_json::Value::String(space.path.clone()),
            );
            if local.as_deref() != Some(space.device_id.as_str()) {
                params.insert(
                    "targetDeviceId".into(),
                    serde_json::Value::String(space.device_id.clone()),
                );
            }
            let result = engine
                .client()
                .call(methods::LIST_REFS, serde_json::Value::Object(params))
                .await;
            this.update(cx, |pickers, cx| {
                pickers.refs = match result {
                    Ok(value) => match serde_json::from_value::<Vec<RepoRef>>(value) {
                        Ok(refs) => Loadable::Ready(refs),
                        Err(err) => Loadable::Error(err.to_string()),
                    },
                    Err(err) => Loadable::Error(err.to_string()),
                };
                // Rows landed under an open, un-searched popover: re-home the
                // nav highlight to the selected row.
                if pickers.open == Some(PickerKind::Branch)
                    && pickers.search.read(cx).text().is_empty()
                {
                    pickers.active = pickers.selected_ref_index(cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    // ---- selections ----

    pub(super) fn pick_ref(&mut self, row: RepoRef, cx: &mut Context<Self>) {
        // Existing session: the pick SWITCHES the session's checkout (the
        // t3code mid-session `switchRef`) instead of updating the draft.
        if self.state.read(cx).selected_chat_row().is_some() {
            self.switch_session_ref(row, cx);
            return;
        }
        if row.worktree_path.is_some() {
            // Reuse the ref's existing worktree ("Current worktree") — the
            // t3code `reuseExistingWorktree` path.
            self.config.branch = Some(row.name.clone());
            self.config.checkout = CheckoutKind::Local;
        } else if self.config.checkout == CheckoutKind::NewWorktree || row.current {
            // Base pick for a new worktree, or the already-current ref.
            self.config.branch = Some(row.name.clone());
        } else {
            // Local mode + a plain non-current ref: CHECK OUT the space
            // folder (full t3code `switchRef` — picking `main` means "put my
            // local checkout on main", it must never flip the mode).
            self.switch_draft_ref(row, cx);
            return;
        }
        self.open = None;
        cx.notify();
    }

    /// Draft-mode checkout switch: `git checkout` in the SPACE's folder
    /// (relay-forwarded for remote spaces). Success records the pick and
    /// refreshes tags; failure keeps the popover open with git's message.
    pub(super) fn switch_draft_ref(&mut self, row: RepoRef, cx: &mut Context<Self>) {
        if self.switching.is_some() {
            return; // one switch at a time
        }
        let Some(space) = self.state.read(cx).selected_space_row().cloned() else {
            return;
        };
        let Some(engine) = self.engine(cx) else {
            return;
        };
        let local = self.state.read(cx).local_device_id.clone();
        self.switch_error = None;
        self.switching = Some(row.name.clone());
        let ref_name = row.name.clone();
        self.switch_task = Some(cx.spawn(async move |this, cx| {
            let mut params = serde_json::Map::new();
            params.insert(
                "repoPath".into(),
                serde_json::Value::String(space.path.clone()),
            );
            params.insert(
                "refName".into(),
                serde_json::Value::String(ref_name.clone()),
            );
            if local.as_deref() != Some(space.device_id.as_str()) {
                params.insert(
                    "targetDeviceId".into(),
                    serde_json::Value::String(space.device_id.clone()),
                );
            }
            let result = engine
                .client()
                .call(methods::SWITCH_REF, serde_json::Value::Object(params))
                .await;
            this.update(cx, |pickers, cx| {
                pickers.switching = None;
                match result {
                    Ok(_) => {
                        pickers.config.branch = Some(ref_name);
                        pickers.open = None;
                        pickers.ensure_refs(true, cx);
                    }
                    Err(err) => pickers.switch_error = Some(err.to_string()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Mid-session ref switch, two shapes (both t3code):
    ///
    /// - The picked ref already lives in ANOTHER worktree → RETARGET the
    ///   session onto that worktree (`reuseExistingWorktree`): a `setChatCwd`
    ///   + `setChatBranch` mutate, no git. Resume is cwd-scoped, so the next
    ///   run there starts a fresh harness conversation — the transcript
    ///   itself carries on.
    /// - Otherwise → `git checkout` in the SESSION's own cwd (`SwitchRef`,
    ///   relay-forwarded to the host device). The host's HEAD watcher
    ///   reconciles `chat.branch` to every device. Errors (dirty tree, ref
    ///   held by the MAIN checkout) keep the popover open with git's message.
    pub(super) fn switch_session_ref(&mut self, row: RepoRef, cx: &mut Context<Self>) {
        if self.switching.is_some() {
            return; // one switch at a time
        }
        let Some(chat) = self.state.read(cx).selected_chat_row().cloned() else {
            return;
        };
        let Some(cwd) = chat.cwd.clone() else {
            return;
        };
        let Some(engine) = self.engine(cx) else {
            return;
        };
        if row.worktree_path.as_deref() == Some(cwd.as_str()) {
            // Already this session's worktree — nothing to do.
            self.open = None;
            cx.notify();
            return;
        }
        let local = self.state.read(cx).local_device_id.clone();
        self.switch_error = None;
        self.switching = Some(row.name.clone());
        let ref_name = row.name.clone();
        let retarget = row.worktree_path.clone();
        self.switch_task = Some(cx.spawn(async move |this, cx| {
            let result = match retarget {
                // Reuse the ref's existing worktree: move the session there.
                Some(path) => {
                    let cwd_mutate = serde_json::json!({
                        "op": "setChatCwd",
                        "chatId": chat.id,
                        "cwd": path,
                    });
                    let branch_mutate = serde_json::json!({
                        "op": "setChatBranch",
                        "chatId": chat.id,
                        "branch": ref_name,
                    });
                    match engine.client().call(methods::MUTATE, cwd_mutate).await {
                        Ok(_) => engine.client().call(methods::MUTATE, branch_mutate).await,
                        Err(err) => Err(err),
                    }
                }
                // Plain ref: checkout in place on the chat's HOST device.
                None => {
                    let mut params = serde_json::Map::new();
                    params.insert("repoPath".into(), serde_json::Value::String(cwd));
                    params.insert(
                        "refName".into(),
                        serde_json::Value::String(ref_name.clone()),
                    );
                    if local.as_deref() != Some(chat.device_id.as_str()) {
                        params.insert(
                            "targetDeviceId".into(),
                            serde_json::Value::String(chat.device_id.clone()),
                        );
                    }
                    engine
                        .client()
                        .call(methods::SWITCH_REF, serde_json::Value::Object(params))
                        .await
                }
            };
            this.update(cx, |pickers, cx| {
                pickers.switching = None;
                match result {
                    Ok(_) => {
                        pickers.open = None;
                        // Checkout state changed — refresh tags/current.
                        pickers.ensure_refs(true, cx);
                    }
                    Err(err) => pickers.switch_error = Some(err.to_string()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(super) fn pick_checkout(&mut self, kind: CheckoutKind, cx: &mut Context<Self>) {
        if kind == CheckoutKind::Local
            && self.config.checkout == CheckoutKind::NewWorktree
            && self.selected_ref_worktree().is_none()
            && self.selected_ref().is_some_and(|r| !r.current)
        {
            // Back to "Current checkout" with a non-current plain ref picked:
            // drop the pick (we don't checkout the main folder) — the current
            // branch takes over.
            self.config.branch = None;
        }
        self.config.checkout = kind;
        self.open = None;
        cx.notify();
    }

    pub(super) fn pick_harness(
        &mut self,
        harness: HarnessId,
        acp_agent_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.harness_locked(cx) {
            return;
        }
        if self.config.harness != Some(harness) || self.config.acp_agent_id != acp_agent_id {
            // The remembered model for this harness takes over via the
            // defaults fallback; a foreign pick must not linger.
            self.config.model = None;
            self.config.reasoning = None;
            self.config.model_options.clear();
        }
        self.config.harness = Some(harness);
        self.config.acp_agent_id = acp_agent_id.clone();
        self.defaults.harness = Some(harness);
        self.save_defaults();
        self.active = 0;
        self.model_scroll.set_offset(gpui::Point::default());
        self.models.remove(&(harness, acp_agent_id.clone()));
        self.ensure_models(harness, acp_agent_id, cx);
        cx.notify();
    }

    pub(super) fn pick_model(&mut self, model_id: String, cx: &mut Context<Self>) {
        eprintln!(
            "[pickers:DEBUG] pick_model: called with model_id = {:?}",
            model_id
        );
        self.open = None;
        if self.state.read(cx).selected_chat.is_some() {
            // Existing chat: persist to the chat row (Mutate setChatConfig) —
            // survives restarts and syncs; next runs in this chat use it.
            self.update_chat_config(cx, move |config| config.model = Some(model_id));
        } else {
            // New chat: draft pick + sticky last-used memory for this harness.
            self.config.model = Some(model_id.clone());
            if let Some(harness) = self.effective_harness(cx) {
                let acp_agent_id = self.effective_acp_agent_id(cx);
                let label = self
                    .models
                    .get(&(harness, acp_agent_id))
                    .and_then(|l| l.ready())
                    .and_then(|models| models.iter().find(|m| m.id == model_id))
                    .map(|m| m.label.clone())
                    .unwrap_or_else(|| model_id.clone());
                self.defaults.remember_model(harness, model_id, label);
                self.save_defaults();
            }
        }
        cx.notify();
    }

    pub(super) fn pick_reasoning(&mut self, level: ReasoningLevel, cx: &mut Context<Self>) {
        // Always a concrete selection (no toggle-back-to-default).
        if self.state.read(cx).selected_chat.is_some() {
            self.update_chat_config(cx, move |config| config.reasoning = Some(level));
        } else {
            self.config.reasoning = Some(level);
            self.defaults.reasoning = Some(level);
            self.save_defaults();
        }
        cx.notify();
    }

    pub(super) fn pick_permission(&mut self, mode: PermissionMode, cx: &mut Context<Self>) {
        self.open = None;
        if self.state.read(cx).selected_chat.is_some() {
            self.update_chat_config(cx, move |config| {
                config.permission_mode = mode;
                config.sandbox = mode.sandbox();
            });
        } else {
            self.config.permission_mode = mode;
            self.defaults.permission_mode = Some(mode);
            self.save_defaults();
        }
        cx.notify();
    }

    pub(super) fn pick_option(
        &mut self,
        option_id: String,
        choice_id: String,
        default: bool,
        cx: &mut Context<Self>,
    ) {
        if self.state.read(cx).selected_chat.is_some() {
            self.update_chat_config(cx, move |config| {
                if default {
                    config.model_options.remove(&option_id);
                } else {
                    config
                        .model_options
                        .insert(option_id, serde_json::Value::String(choice_id));
                }
            });
        } else if default {
            self.config.model_options.remove(&option_id);
        } else {
            self.config
                .model_options
                .insert(option_id, serde_json::Value::String(choice_id));
        }
        cx.notify();
    }

    /// Apply `change` to the selected chat's effective config and persist it:
    /// optimistic row stamp (chips update on click) + `Mutate setChatConfig`
    /// (LWW workspace write — restarts and other devices see it). The written
    /// row always carries the CONCRETE resolved model/reasoning, with the
    /// reasoning re-clamped to the (possibly just-changed) model's ladder.
    pub(super) fn update_chat_config(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut ChatConfig)) {
        let Some(chat_id) = self.state.read(cx).selected_chat.clone() else {
            return;
        };
        let resolved = self.resolved(cx);
        let Some(mut config) = resolved.chat_config() else {
            return; // harness unknown (catalog + chat row both missing) — nothing safe to write
        };
        // Preserve fields the pickers don't own.
        if let Some(existing) = self
            .state
            .read(cx)
            .selected_chat_row()
            .and_then(|c| c.config.as_ref())
        {
            config.sandbox = existing.sandbox;
            config.permission_mode = existing.permission_mode;
        }
        change(&mut config);
        // Reasoning must stay concrete for whatever model the row now names —
        // same ladder resolution as [`Self::trait_ladder`] (model levels, else
        // the harness's advertised ladder).
        if let Some(models) = self
            .models
            .get(&(config.harness, config.acp_agent_id.clone()))
            .and_then(|l| l.ready())
        {
            let mut ladder = config
                .model
                .as_deref()
                .and_then(|id| models.iter().find(|m| m.id == id))
                .map(|m| m.reasoning_levels.clone())
                .unwrap_or_default();
            if ladder.is_empty()
                && let Some(descriptor) = self
                    .harnesses
                    .ready()
                    .and_then(|list| list.iter().find(|d| d.id == config.harness))
            {
                ladder = descriptor.reasoning_levels.clone();
            }
            if !ladder.is_empty() {
                config.reasoning = clamp_reasoning(config.reasoning, &ladder);
            }
        }
        self.state.update(cx, |state, cx| {
            state.apply_chat_config(&chat_id, config.clone());
            cx.notify();
        });
        let Some(engine) = self.engine(cx) else {
            return;
        };
        self.mutate_task = Some(cx.spawn(async move |_, _| {
            let params = serde_json::json!({
                "op": "setChatConfig",
                "chatId": chat_id,
                "config": config,
            });
            if let Err(err) = engine.client().call(methods::MUTATE, params).await {
                tracing::warn!(error = %err, "setChatConfig mutate failed");
            }
        }));
    }

    // ---- keyboard ----
}

