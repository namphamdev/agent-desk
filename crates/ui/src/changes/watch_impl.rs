//! `impl Changes` block #2: watch lifecycle (subscribe/retry), diff reconciliation,
//! per-file fold state, selection, and the time-sliced highlight tokenizer.

use std::sync::Arc;
use std::time::Duration;

use gpui::{App, Context, Task};

use comet_proto::CheckoutDiff;
use comet_rpc::methods;

use crate::markdown::highlight::{LineCarry, Token, tokenize_line};
use crate::state::EngineHandle;

use super::entity::{HighlightSlot, ParsedDiff, yield_now};
use super::patch::{FileDiff, LineKind, parse_patch};
use super::resolve::{apply_diff_frame, hash64, lang_for_path, resolve_diff};
use super::Changes;

impl Changes {
    /// The selected chat's host device when it differs from the connected
    /// engine's own — diffs are produced where the checkout lives, so a
    /// remote chat's watch must relay-forward (`targetDeviceId`) to its host.
    /// Without this the local stream simply never carries the remote checkout
    /// and the pane sits on "Preparing diff…" forever (user report).
    pub(super) fn desired_target(&self, cx: &App) -> Option<String> {
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

    pub(super) fn spawn_watch(
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

    pub(super) fn resolved(&self, cx: &App) -> Option<CheckoutDiff> {
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
    pub(super) fn sync(&mut self, cx: &mut Context<Self>) {
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

    pub(super) fn toggle_fold(&mut self, path: &str, expanded_height: f32) {
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

    pub(super) fn select_detail(&mut self, path: String, cx: &mut Context<Self>) {
        self.selected_detail = Some(path);
        self.detail_scroll.set_offset(gpui::Point::default());
        cx.notify();
    }

    pub(super) fn save_generation_defaults(&self) {
        if let Some(dir) = self.generation_defaults_dir.as_deref()
            && let Err(error) = self.generation_defaults.save(dir)
        {
            tracing::warn!(error = %error, "git generation defaults save failed");
        }
    }

    pub(super) fn toggle_path_selection(&mut self, path: String, cx: &mut Context<Self>) {
        if !self.selected_paths.insert(path.clone()) {
            self.selected_paths.remove(&path);
        }
        cx.notify();
    }

    pub(super) fn run_file_action(
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
    pub(super) fn request_highlight(
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
}

