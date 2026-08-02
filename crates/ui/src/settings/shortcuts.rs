//! Settings → Shortcuts (feature-inventory §1.4): a table of the rebindable
//! bindings — click a combo to record (Esc cancels), live conflict detection,
//! per-row Reset and Restore defaults. Changes emit [`ShortcutsEvent::Changed`];
//! the shell persists them and re-applies the app keymap.

use comet_proto::{CustomProvider, CustomProviderFormat, CustomProviderSnapshot};
use comet_rpc::methods;
use gpui::{
    AnyElement, Context, Entity, EventEmitter, FocusHandle, Focusable as _, KeyDownEvent,
    SharedString, Subscription, Task, Window, div, prelude::*, px,
};

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::popover::Loadable;
use crate::settings::widgets;
use crate::settings::{AiShortcut, KeymapConfig, ShortcutId, combo_from_keystroke, display_combo};
use crate::state::AppState;
use crate::theme::Theme;

/// Outcome of one keystroke while recording. Pure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordOutcome {
    /// Esc — abandon recording, keep the old combo.
    Cancelled,
    /// A bare modifier (or unusable key) — stay recording.
    Ignored,
    /// A full combo landed.
    Set(String),
}

pub fn record_key(key: &str, ctrl: bool, alt: bool, shift: bool, cmd: bool) -> RecordOutcome {
    if key.eq_ignore_ascii_case("escape") {
        return RecordOutcome::Cancelled;
    }
    match combo_from_keystroke(ctrl, alt, shift, cmd, key) {
        Some(combo) => RecordOutcome::Set(combo),
        None => RecordOutcome::Ignored,
    }
}

#[derive(Debug, Clone)]
pub enum ShortcutsEvent {
    /// The keymap changed — persist + re-apply.
    Changed {
        keymap: KeymapConfig,
        ai_shortcuts: Vec<AiShortcut>,
    },
}

struct AiShortcutEditor {
    id: String,
    name: Entity<ComposerInput>,
    model: Entity<ComposerInput>,
    model_search: Entity<ComposerInput>,
    model_dropdown_open: bool,
    prompt: Entity<ComposerInput>,
    combo: String,
    provider_id: String,
    use_clipboard: bool,
    enabled: bool,
    _inputs: Vec<Subscription>,
}

pub struct ShortcutsPage {
    /// Working copy (kept in sync with the shell via `Changed` events).
    keymap: KeymapConfig,
    ai_shortcuts: Vec<AiShortcut>,
    recording: Option<ShortcutId>,
    recording_ai: bool,
    ai_editor: Option<AiShortcutEditor>,
    providers: Loadable<CustomProviderSnapshot>,
    models: Loadable<Vec<String>>,
    task: Option<Task<()>>,
    /// A rejected record attempt ("{Combo} is already assigned to {label}.") —
    /// conflicts never persist; they're refused at record time, as in comet.
    conflict_notice: Option<SharedString>,
    focus: FocusHandle,
    // The page never talks RPC; state is kept for parity with sibling pages
    // (and future per-device keymaps).
    state: Entity<AppState>,
}

impl EventEmitter<ShortcutsEvent> for ShortcutsPage {}

impl ShortcutsPage {
    pub fn new(
        state: Entity<AppState>,
        keymap: KeymapConfig,
        ai_shortcuts: Vec<AiShortcut>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut page = Self {
            keymap,
            ai_shortcuts,
            recording: None,
            recording_ai: false,
            ai_editor: None,
            providers: Loadable::Idle,
            models: Loadable::Idle,
            task: None,
            conflict_notice: None,
            focus: cx.focus_handle(),
            state,
        };
        page.load_providers(cx);
        page
    }

    fn commit(&mut self, cx: &mut Context<Self>) {
        cx.emit(ShortcutsEvent::Changed {
            keymap: self.keymap.clone(),
            ai_shortcuts: self.ai_shortcuts.clone(),
        });
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        if self.recording.is_none() && !self.recording_ai {
            return;
        }
        let mods = &event.keystroke.modifiers;
        match record_key(
            &event.keystroke.key,
            mods.control,
            mods.alt,
            mods.shift,
            mods.platform,
        ) {
            RecordOutcome::Cancelled => {
                self.recording = None;
                self.recording_ai = false;
                cx.notify();
            }
            RecordOutcome::Ignored => {}
            RecordOutcome::Set(combo) => {
                if self.recording_ai {
                    if self.combo_in_use(&combo) {
                        self.conflict_notice =
                            Some(format!("{} is already assigned.", display_combo(&combo)).into());
                    } else if let Some(editor) = self.ai_editor.as_mut() {
                        editor.combo = combo;
                        self.conflict_notice = None;
                    }
                    self.recording_ai = false;
                    cx.notify();
                    cx.stop_propagation();
                    return;
                }
                let Some(recording) = self.recording else {
                    return;
                };
                // A combo already bound elsewhere is REFUSED, naming the owner
                // (comet settings.shortcuts.tsx: "… is already assigned to …").
                if let Some(owner) = conflict_owner(&self.keymap, recording, &combo) {
                    self.conflict_notice = Some(
                        format!(
                            "{} is already assigned to {}.",
                            display_combo(&combo),
                            owner.label()
                        )
                        .into(),
                    );
                    self.recording = None;
                    cx.notify();
                } else if let Some(owner) = self
                    .ai_shortcuts
                    .iter()
                    .find(|shortcut| shortcut.combo == combo)
                {
                    self.conflict_notice = Some(
                        format!(
                            "{} is already assigned to {}.",
                            display_combo(&combo),
                            owner.name
                        )
                        .into(),
                    );
                    self.recording = None;
                    cx.notify();
                } else {
                    self.keymap.set(recording, combo);
                    self.recording = None;
                    self.conflict_notice = None;
                    self.commit(cx);
                }
            }
        }
        cx.stop_propagation();
    }

    fn engine(&self, cx: &gpui::App) -> Option<crate::state::EngineHandle> {
        self.state.read(cx).engine().cloned()
    }

    fn load_providers(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.engine(cx) else {
            self.providers = Loadable::Error("Engine not connected".into());
            return;
        };
        self.providers = Loadable::Loading;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::GET_CUSTOM_PROVIDERS, serde_json::json!({}))
                .await;
            let _ = this.update(cx, |page, cx| {
                page.providers = match result {
                    Ok(value) => serde_json::from_value(value)
                        .map(Loadable::Ready)
                        .unwrap_or_else(|error| Loadable::Error(error.to_string())),
                    Err(error) => Loadable::Error(error.to_string()),
                };
                cx.notify();
            });
        }));
    }

    fn load_models(&mut self, provider_id: String, cx: &mut Context<Self>) {
        let Some(engine) = self.engine(cx) else {
            return;
        };
        self.models = Loadable::Loading;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(
                    methods::LIST_CUSTOM_PROVIDER_MODELS,
                    serde_json::json!({ "providerId": provider_id }),
                )
                .await;
            let _ = this.update(cx, |page, cx| {
                page.models = match result {
                    Ok(value) => serde_json::from_value(value)
                        .map(Loadable::Ready)
                        .unwrap_or_else(|error| Loadable::Error(error.to_string())),
                    Err(error) => Loadable::Error(error.to_string()),
                };
                cx.notify();
            });
        }));
    }

    fn open_ai_editor(&mut self, shortcut: Option<AiShortcut>, cx: &mut Context<Self>) {
        let shortcut = shortcut.unwrap_or_default();
        let name = cx.new(|cx| ComposerInput::new("Shortcut name", cx));
        let model = cx.new(|cx| ComposerInput::new("Model id", cx));
        let model_search = cx.new(|cx| {
            ComposerInput::with_context("Search discovered models…", "PaletteSearch", cx)
        });
        let prompt = cx.new(|cx| ComposerInput::new("System prompt", cx));
        name.update(cx, |input, cx| input.set_text(shortcut.name, cx));
        model.update(cx, |input, cx| input.set_text(shortcut.model, cx));
        prompt.update(cx, |input, cx| input.set_text(shortcut.prompt, cx));
        let inputs = [&name, &model, &model_search, &prompt]
            .into_iter()
            .map(|input| {
                cx.subscribe(input, |_, _, event: &ComposerInputEvent, cx| {
                    if matches!(event, ComposerInputEvent::Edited) {
                        cx.notify();
                    }
                })
            })
            .collect();
        let provider_id = shortcut.provider_id;
        self.ai_editor = Some(AiShortcutEditor {
            id: shortcut.id,
            name,
            model,
            model_search,
            model_dropdown_open: false,
            prompt,
            combo: shortcut.combo,
            provider_id: provider_id.clone(),
            use_clipboard: shortcut.use_clipboard,
            enabled: shortcut.enabled,
            _inputs: inputs,
        });
        self.models = Loadable::Idle;
        if !provider_id.is_empty() {
            self.load_models(provider_id, cx);
        }
        self.conflict_notice = None;
        cx.notify();
    }

    fn select_provider(&mut self, provider_id: String, cx: &mut Context<Self>) {
        if let Some(editor) = self.ai_editor.as_mut() {
            editor.provider_id = provider_id.clone();
            editor.model.update(cx, |input, cx| input.set_text("", cx));
            editor
                .model_search
                .update(cx, |input, cx| input.set_text("", cx));
            editor.model_dropdown_open = false;
        }
        self.load_models(provider_id, cx);
        cx.notify();
    }

    fn toggle_model_dropdown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.ai_editor.as_mut() else {
            return;
        };
        editor.model_dropdown_open = !editor.model_dropdown_open;
        editor
            .model_search
            .update(cx, |input, cx| input.set_text("", cx));
        if editor.model_dropdown_open {
            let focus = editor.model_search.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        }
        cx.notify();
    }

    fn select_model(&mut self, model: String, cx: &mut Context<Self>) {
        let Some(editor) = self.ai_editor.as_mut() else {
            return;
        };
        editor
            .model
            .update(cx, |input, cx| input.set_text(model.clone(), cx));
        editor.model_dropdown_open = false;
        editor
            .model_search
            .update(cx, |input, cx| input.set_text("", cx));
        cx.notify();
    }

    fn combo_in_use(&self, combo: &str) -> bool {
        let editing_id = self.ai_editor.as_ref().map(|editor| editor.id.as_str());
        ShortcutId::ALL
            .into_iter()
            .any(|id| self.keymap.get(id) == combo)
            || self
                .ai_shortcuts
                .iter()
                .any(|shortcut| Some(shortcut.id.as_str()) != editing_id && shortcut.combo == combo)
    }

    fn save_ai_editor(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.ai_editor.as_ref() else {
            return;
        };
        let shortcut = AiShortcut {
            id: editor.id.clone(),
            name: editor.name.read(cx).text().trim().to_string(),
            combo: editor.combo.clone(),
            provider_id: editor.provider_id.clone(),
            model: editor.model.read(cx).text().trim().to_string(),
            prompt: editor.prompt.read(cx).text().trim().to_string(),
            use_clipboard: editor.use_clipboard,
            enabled: editor.enabled,
        };
        if !shortcut.is_valid() {
            self.conflict_notice =
                Some("Name, shortcut, provider, model, and prompt are all required.".into());
            cx.notify();
            return;
        }
        if self.combo_in_use(&shortcut.combo) {
            self.conflict_notice =
                Some(format!("{} is already assigned.", display_combo(&shortcut.combo)).into());
            cx.notify();
            return;
        }
        if let Some(existing) = self
            .ai_shortcuts
            .iter_mut()
            .find(|existing| existing.id == shortcut.id)
        {
            *existing = shortcut;
        } else {
            self.ai_shortcuts.push(shortcut);
        }
        self.ai_editor = None;
        self.models = Loadable::Idle;
        self.commit(cx);
    }

    fn delete_ai_shortcut(&mut self, id: String, cx: &mut Context<Self>) {
        self.ai_shortcuts.retain(|shortcut| shortcut.id != id);
        self.commit(cx);
    }

    fn ai_editor(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let editor = self.ai_editor.as_ref()?;
        let providers = self
            .providers
            .ready()
            .map(|snapshot| chat_providers(&snapshot.providers))
            .unwrap_or_default();
        let valid = !editor.name.read(cx).text().trim().is_empty()
            && !editor.combo.trim().is_empty()
            && !editor.provider_id.trim().is_empty()
            && !editor.model.read(cx).text().trim().is_empty()
            && !editor.prompt.read(cx).text().trim().is_empty();
        let combo_text: SharedString = if self.recording_ai {
            "Press keys…".into()
        } else {
            display_combo(&editor.combo).into()
        };
        let model_query = editor.model_search.read(cx).text().to_string();
        let filtered_models = self
            .models
            .ready()
            .map(|models| filter_model_ids(&model_query, models))
            .unwrap_or_default();
        let selected_model = editor.model.read(cx).text().to_string();
        let mut model_rows = Vec::<AnyElement>::new();
        for model in filtered_models {
            let active = selected_model == model;
            let value = model.clone();
            model_rows.push(
                crate::popover::menu_row(
                    theme,
                    active,
                    SharedString::from(format!("shortcut-model-row-{model}")),
                )
                .id(SharedString::from(format!("shortcut-model-row-{model}")))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.select_model(value.clone(), cx);
                }))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .child(SharedString::from(model)),
                )
                .into_any_element(),
            );
        }
        if model_rows.is_empty() {
            model_rows.push(
                div()
                    .px(px(10.0))
                    .py(px(12.0))
                    .text_size(px(11.5))
                    .text_color(theme.text_muted)
                    .child("No discovered models match this search.")
                    .into_any_element(),
            );
        }
        let model_menu = crate::popover::popover_card(theme)
            .id("shortcut-model-menu")
            .w(px(420.0))
            // `anchored_menu` pins its content's top-left to the trigger.
            // Keep the trigger visible and place the menu below it.
            .mt(px(42.0))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                if let Some(editor) = this.ai_editor.as_mut() {
                    editor.model_dropdown_open = false;
                    editor
                        .model_search
                        .update(cx, |input, cx| input.set_text("", cx));
                    cx.notify();
                }
            }))
            .child(crate::popover::search_input_frame(
                theme,
                editor.model_search.clone().into_any_element(),
            ))
            .child(
                div()
                    .id("shortcut-model-options")
                    .max_h(px(260.0))
                    .overflow_y_scroll()
                    .children(model_rows),
            )
            .into_any_element();
        let model_selected = !selected_model.trim().is_empty();
        let model_trigger = div()
            .id("shortcut-model-trigger")
            .relative()
            .mt(px(7.0))
            .w(px(420.0))
            .h(px(36.0))
            .px(px(11.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(theme.border)
            .bg(crate::theme::white_alpha(0.025))
            .flex()
            .items_center()
            .cursor_pointer()
            .on_click(cx.listener(|this, _, window, cx| {
                this.toggle_model_dropdown(window, cx);
            }))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .text_size(px(12.0))
                    .text_color(if model_selected {
                        theme.text
                    } else {
                        theme.text_muted
                    })
                    .child(SharedString::from(if model_selected {
                        selected_model
                    } else {
                        "Select model".into()
                    })),
            )
            .child(
                crate::icons::icon(crate::icons::ALT_ARROW_DOWN)
                    .size(px(14.0))
                    .text_color(theme.text_muted),
            )
            .when(editor.model_dropdown_open, |trigger| {
                trigger.child(crate::popover::anchored_menu(
                    "shortcut-model-dropdown",
                    model_menu,
                ))
            });

        Some(
            div()
                .mt(px(16.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.surface)
                .p(px(20.0))
                .child(
                    div()
                        .text_size(px(13.0))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child("Configure AI shortcut"),
                )
                .child(shortcut_field(theme, "Name", editor.name.clone(), false))
                .child(
                    div()
                        .mt(px(12.0))
                        .child(
                            div()
                                .mb(px(5.0))
                                .text_size(px(11.5))
                                .text_color(theme.text_muted)
                                .child("Global hotkey"),
                        )
                        .child(
                            div()
                                .id("ai-shortcut-record")
                                .min_w(px(110.0))
                                .px(px(12.0))
                                .py(px(7.0))
                                .rounded(px(8.0))
                                .border_1()
                                .border_color(theme.border)
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.recording = None;
                                    this.recording_ai = true;
                                    window.focus(&this.focus, cx);
                                    cx.notify();
                                }))
                                .child(combo_text),
                        ),
                )
                .child(
                    div()
                        .mt(px(14.0))
                        .child(
                            div()
                                .text_size(px(11.5))
                                .text_color(theme.text_muted)
                                .child("Provider"),
                        )
                        .child(div().mt(px(7.0)).flex().flex_wrap().gap(px(6.0)).children(
                            providers.into_iter().map(|provider| {
                                let id = provider.id.clone();
                                shortcut_chip(
                                    theme,
                                    format!("shortcut-provider-{}", provider.id),
                                    provider.name.clone(),
                                    editor.provider_id == provider.id,
                                    cx.listener(move |this, _, _, cx| {
                                        this.select_provider(id.clone(), cx)
                                    }),
                                )
                            }),
                        )),
                )
                .child(
                    div()
                        .mt(px(12.0))
                        .child(
                            div()
                                .mb(px(5.0))
                                .text_size(px(11.5))
                                .text_color(theme.text_muted)
                                .child("Model"),
                        )
                        .when(self.models.ready().is_some(), |field| {
                            field.child(model_trigger)
                        }),
                )
                .when(self.models.is_loading(), |panel| {
                    panel.child(
                        div()
                            .mt(px(6.0))
                            .text_size(px(11.0))
                            .text_color(theme.text_muted)
                            .child("Discovering models…"),
                    )
                })
                .when_some(self.models.error().map(str::to_string), |panel, error| {
                    panel.child(
                        div()
                            .mt(px(6.0))
                            .text_size(px(11.0))
                            .text_color(theme.warning)
                            .child(SharedString::from(format!(
                                "{error} You can enter a model id manually below."
                            ))),
                    )
                })
                .when(self.models.error().is_some(), |panel| {
                    panel.child(shortcut_field(
                        theme,
                        "Manual model id",
                        editor.model.clone(),
                        false,
                    ))
                })
                .child(shortcut_field(theme, "Prompt", editor.prompt.clone(), true))
                .child(
                    div()
                        .mt(px(14.0))
                        .flex()
                        .gap(px(7.0))
                        .child(shortcut_chip(
                            theme,
                            "shortcut-input-clipboard",
                            "Selected text / clipboard",
                            editor.use_clipboard,
                            cx.listener(|this, _, _, cx| {
                                if let Some(editor) = this.ai_editor.as_mut() {
                                    editor.use_clipboard = true;
                                    cx.notify();
                                }
                            }),
                        ))
                        .child(shortcut_chip(
                            theme,
                            "shortcut-input-ask",
                            "Ask every time",
                            !editor.use_clipboard,
                            cx.listener(|this, _, _, cx| {
                                if let Some(editor) = this.ai_editor.as_mut() {
                                    editor.use_clipboard = false;
                                    cx.notify();
                                }
                            }),
                        )),
                )
                .child(
                    div()
                        .mt(px(18.0))
                        .flex()
                        .gap(px(8.0))
                        .child(
                            crate::popover::btn_primary(theme, "Save")
                                .id("save-ai-shortcut")
                                .when(!valid, |button| button.opacity(0.4))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if valid {
                                        this.save_ai_editor(cx);
                                    }
                                })),
                        )
                        .child(
                            widgets::ghost_action(theme)
                                .id("cancel-ai-shortcut")
                                .hover(widgets::ghost_hover)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.ai_editor = None;
                                    this.recording_ai = false;
                                    this.conflict_notice = None;
                                    cx.notify();
                                }))
                                .child("Cancel"),
                        ),
                )
                .into_any_element(),
        )
    }
}

fn chat_providers(providers: &[CustomProvider]) -> Vec<&CustomProvider> {
    providers
        .iter()
        .filter(|provider| {
            provider
                .formats
                .contains(&CustomProviderFormat::ChatCompletions)
        })
        .collect()
}

fn filter_model_ids(query: &str, models: &[String]) -> Vec<String> {
    crate::popover::filter_indices(query, models)
        .into_iter()
        .map(|index| models[index].clone())
        .collect()
}

fn shortcut_field(
    theme: &Theme,
    label: &'static str,
    input: Entity<ComposerInput>,
    multiline: bool,
) -> gpui::Div {
    div()
        .mt(px(12.0))
        .child(
            div()
                .mb(px(5.0))
                .text_size(px(11.5))
                .text_color(theme.text_muted)
                .child(label),
        )
        .child(
            div()
                .min_h(px(if multiline { 92.0 } else { 38.0 }))
                .flex()
                .items_start()
                .rounded(px(8.0))
                .border_1()
                .border_color(theme.border)
                .bg(crate::theme::white_alpha(0.02))
                .p(px(9.0))
                .child(input),
        )
}

fn shortcut_chip(
    theme: &Theme,
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    active: bool,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> impl IntoElement {
    div()
        .id(id.into())
        .px(px(9.0))
        .py(px(5.0))
        .rounded(px(7.0))
        .border_1()
        .border_color(if active {
            theme.text_muted
        } else {
            theme.border
        })
        .bg(if active {
            crate::theme::white_alpha(0.09)
        } else {
            crate::theme::white_alpha(0.02)
        })
        .text_size(px(11.5))
        .text_color(if active { theme.text } else { theme.text_muted })
        .cursor_pointer()
        .on_click(listener)
        .child(label.into())
}

/// The shortcut (other than `id`) already bound to `combo`, if any. Pure.
pub fn conflict_owner(keymap: &KeymapConfig, id: ShortcutId, combo: &str) -> Option<ShortcutId> {
    ShortcutId::ALL
        .into_iter()
        .find(|&other| other != id && keymap.get(other) == combo)
}

/// One-line purpose copy per shortcut (comet lib/shortcuts.ts
/// `SHORTCUT_DEFINITIONS` descriptions, verbatim).
fn description(id: ShortcutId) -> &'static str {
    match id {
        ShortcutId::ToggleSidebar => "Show or hide sessions and settings navigation.",
        ShortcutId::ToggleChanges => "Show or hide changes for the current session.",
        ShortcutId::ToggleTerminal => "Show or hide the terminal for the current session.",
    }
}

impl Render for ShortcutsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::settings::widgets;
        let theme = Theme::of(cx).clone();
        let recording = self.recording;
        let customized = self.keymap != KeymapConfig::default();
        let ai_editor = self.ai_editor(&theme, cx);

        let rows = ShortcutId::ALL.into_iter().enumerate().map(|(ix, id)| {
            let combo = self.keymap.get(id).to_string();
            let is_recording = recording == Some(id);
            let non_default = combo != id.default_combo();
            let chip_text: SharedString = if is_recording {
                "Press keys…".into()
            } else {
                display_combo(&combo).into()
            };
            // comet settings.shortcuts.tsx row: min-h-[72px] px-5 gap-5, label
            // + description left, Reset (only when modified), then the combo
            // chip — recording inverts it to white-on-black.
            div()
                .min_h(px(72.0))
                .px(px(20.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(20.0))
                .when(ix > 0, |el| el.border_t_1().border_color(theme.border))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(13.0))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .child(SharedString::from(id.label())),
                        )
                        .child(
                            div()
                                .mt(px(2.0))
                                .text_size(px(12.0))
                                .text_color(theme.text_muted)
                                .child(SharedString::from(description(id))),
                        ),
                )
                .when(non_default && !is_recording, |el| {
                    el.child(
                        div()
                            .id(("shortcut-reset", ix))
                            .text_size(px(11.0))
                            .text_color(theme.text_muted.opacity(0.7))
                            .cursor_pointer()
                            .hover(|s| s.text_color(Theme::dark().text))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.keymap.reset(id);
                                this.recording = None;
                                this.commit(cx);
                            }))
                            .child(SharedString::from("Reset")),
                    )
                })
                .child(
                    div()
                        .id(("shortcut-combo", ix))
                        .min_w(px(96.0))
                        .px(px(12.0))
                        .py(px(6.0))
                        .rounded(px(8.0))
                        .border_1()
                        .flex()
                        .justify_center()
                        .font_family(theme.font_mono.clone())
                        .text_size(px(12.0))
                        .cursor_pointer()
                        .map(|el| {
                            if is_recording {
                                el.border_color(theme.text.opacity(0.3))
                                    .bg(theme.text)
                                    .text_color(crate::theme::grey(0x0e))
                            } else {
                                el.border_color(theme.border)
                                    .bg(theme.bg)
                                    .text_color(theme.text)
                                    .hover(|s| {
                                        // `hover:border-foreground/20` — the
                                        // neutral foreground, not pure white.
                                        s.border_color(theme.text.opacity(0.2))
                                            .bg(crate::theme::white_alpha(0.03))
                                    })
                            }
                        })
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.recording = Some(id);
                            this.conflict_notice = None;
                            window.focus(&this.focus, cx);
                            cx.notify();
                        }))
                        .child(chip_text),
                )
        });

        // Helper line stays in the muted tone even for a rejected conflict —
        // the message names the specific clash (comet settings.shortcuts.tsx).
        let helper: SharedString = if recording.is_some() {
            "Press Escape to cancel.".into()
        } else if self.recording_ai {
            "Press Escape to cancel.".into()
        } else if let Some(notice) = self.conflict_notice.clone() {
            notice
        } else {
            "Shortcuts must be unique.".into()
        };

        div()
            .id("shortcuts-page")
            .size_full()
            .overflow_y_scroll()
            .track_focus(&self.focus)
            .on_key_down(
                cx.listener(|this, event: &KeyDownEvent, _, cx| this.on_key_down(event, cx)),
            )
            .child(
                widgets::page_column()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .justify_between()
                            .gap(px(24.0))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .child(widgets::page_header(&theme, "Keyboard shortcuts", None))
                                    .child(
                                        widgets::page_subtitle(
                                            &theme,
                                            "Customize Comet bindings and create global AI \
                                             shortcuts that work while other apps have focus.",
                                        )
                                        .max_w(px(512.0))
                                        .line_height(px(20.0)),
                                    ),
                            )
                            .child({
                                // `disabled:opacity-35` when nothing is
                                // customized or while recording.
                                let disabled = !customized || recording.is_some();
                                widgets::ghost_action(&theme)
                                    .id("shortcuts-restore-defaults")
                                    .flex_none()
                                    .when(disabled, |el| el.opacity(0.35))
                                    .when(!disabled, |el| {
                                        el.hover(|s| {
                                            s.bg(crate::theme::white_alpha(0.04))
                                                .text_color(Theme::dark().text)
                                        })
                                        .on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.keymap = KeymapConfig::default();
                                                this.recording = None;
                                                this.conflict_notice = None;
                                                this.commit(cx);
                                            }),
                                        )
                                    })
                                    .child(
                                        crate::icons::icon(crate::icons::RESTART)
                                            .size(px(14.0))
                                            .text_color(theme.text_muted),
                                    )
                                    .child(SharedString::from("Restore defaults"))
                            }),
                    )
                    .child(widgets::section_card(&theme).mt(px(32.0)).children(rows))
                    .child(
                        div()
                            .mt(px(12.0))
                            .px(px(4.0))
                            .min_h(px(20.0))
                            .text_size(px(12.0))
                            .text_color(theme.text_muted)
                            .child(helper),
                    )
                    .child(
                        div()
                            .mt(px(30.0))
                            .flex()
                            .items_center()
                            .child(widgets::row_title(&theme, "AI shortcuts"))
                            .child(div().flex_1())
                            .child(
                                widgets::ghost_action(&theme)
                                    .id("add-ai-shortcut")
                                    .when(self.ai_editor.is_some(), |button| button.opacity(0.4))
                                    .hover(widgets::ghost_hover)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if this.ai_editor.is_none() {
                                            this.open_ai_editor(None, cx);
                                        }
                                    }))
                                    .child(
                                        crate::icons::icon(crate::icons::ADD_CIRCLE)
                                            .size(px(15.0))
                                            .text_color(theme.text_muted),
                                    )
                                    .child("Add shortcut"),
                            ),
                    )
                    .child(
                        div()
                            .mt(px(5.0))
                            .text_size(px(12.0))
                            .line_height(px(18.0))
                            .text_color(theme.text_muted)
                            .child(
                                "Each shortcut calls the selected provider's \
                                 /v1/chat/completions endpoint. Add a provider with Chat \
                                 Completions support in Settings → Providers first.",
                            ),
                    )
                    .when_some(self.providers.error().map(str::to_string), |page, error| {
                        page.child(
                            widgets::error_strip(error)
                                .id("shortcut-provider-error")
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.load_providers(cx))),
                        )
                    })
                    .children(ai_editor)
                    .child(
                        widgets::section_card(&theme)
                            .mt(px(12.0))
                            .when(self.ai_shortcuts.is_empty(), |card| {
                                card.child(
                                    div()
                                        .px(px(20.0))
                                        .py(px(25.0))
                                        .text_size(px(13.0))
                                        .text_color(theme.text_muted)
                                        .child("No AI shortcuts configured yet."),
                                )
                            })
                            .children(self.ai_shortcuts.iter().enumerate().map(
                                |(index, shortcut)| {
                                    let edit = shortcut.clone();
                                    let delete_id = shortcut.id.clone();
                                    let input_mode = if shortcut.use_clipboard {
                                        "Selected text / clipboard"
                                    } else {
                                        "Ask every time"
                                    };
                                    widgets::card_row(&theme, index == 0)
                                        .child(
                                            div()
                                                .min_w_0()
                                                .flex_1()
                                                .child(widgets::row_title(
                                                    &theme,
                                                    shortcut.name.clone(),
                                                ))
                                                .child(
                                                    div()
                                                        .mt(px(3.0))
                                                        .text_size(px(11.5))
                                                        .text_color(theme.text_muted)
                                                        .child(SharedString::from(format!(
                                                            "{} · {} · {}",
                                                            shortcut.model,
                                                            input_mode,
                                                            display_combo(&shortcut.combo)
                                                        ))),
                                                ),
                                        )
                                        .child(
                                            widgets::ghost_action(&theme)
                                                .id(SharedString::from(format!(
                                                    "edit-ai-shortcut-{}",
                                                    shortcut.id
                                                )))
                                                .hover(widgets::ghost_hover)
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_ai_editor(Some(edit.clone()), cx)
                                                }))
                                                .child("Edit"),
                                        )
                                        .child(
                                            widgets::ghost_action(&theme)
                                                .id(SharedString::from(format!(
                                                    "delete-ai-shortcut-{}",
                                                    shortcut.id
                                                )))
                                                .hover(widgets::ghost_hover)
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.delete_ai_shortcut(delete_id.clone(), cx)
                                                }))
                                                .child("Delete"),
                                        )
                                },
                            )),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_outcomes() {
        assert_eq!(
            record_key("escape", false, false, false, false),
            RecordOutcome::Cancelled
        );
        assert_eq!(
            record_key("Escape", true, false, false, false),
            RecordOutcome::Cancelled
        );
        assert_eq!(
            record_key("s", true, false, false, false),
            RecordOutcome::Set("mod-s".into())
        );
        assert_eq!(
            record_key("k", false, true, true, true),
            RecordOutcome::Set("mod-alt-shift-k".into())
        );
        // Bare modifiers stay recording.
        assert_eq!(
            record_key("shift", false, false, true, false),
            RecordOutcome::Ignored
        );
        assert_eq!(
            record_key("ctrl", true, false, false, false),
            RecordOutcome::Ignored
        );
    }

    #[test]
    fn conflicting_records_are_refused() {
        // comet parity: a combo bound elsewhere is refused at record time (the
        // helper names the owner) — conflicts never persist into the keymap.
        let keymap = KeymapConfig::default();
        let RecordOutcome::Set(combo) = record_key("b", true, false, false, false) else {
            panic!("expected Set");
        };
        assert_eq!(
            conflict_owner(&keymap, ShortcutId::ToggleSidebar, &combo),
            Some(ShortcutId::ToggleChanges)
        );
        // Re-recording a shortcut's own combo is not a conflict.
        assert_eq!(
            conflict_owner(&keymap, ShortcutId::ToggleChanges, &combo),
            None
        );
        // A free combo conflicts with nothing.
        assert_eq!(
            conflict_owner(&keymap, ShortcutId::ToggleSidebar, "mod-shift-x"),
            None
        );
    }

    #[test]
    fn discovered_model_search_is_uncapped_and_case_insensitive() {
        let models = (0..35)
            .map(|index| format!("provider-model-{index:02}"))
            .collect::<Vec<_>>();
        assert_eq!(filter_model_ids("", &models).len(), 35);
        assert_eq!(
            filter_model_ids("model-24", &models),
            vec!["provider-model-24"]
        );
        assert_eq!(
            filter_model_ids("MODEL-07", &models),
            vec!["provider-model-07"]
        );
    }
}
