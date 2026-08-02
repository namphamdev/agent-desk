use std::collections::HashSet;

use comet_proto::{CustomProvider, CustomProviderFormat, CustomProviderSnapshot, HarnessId};
use comet_rpc::methods;
use gpui::{
    AnyElement, Context, Entity, EventEmitter, SharedString, Subscription, Task, Window, div,
    prelude::*, px,
};

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::popover::Loadable;
use crate::settings::widgets;
use crate::state::AppState;
use crate::theme::{Theme, white_alpha};

#[derive(Debug, Clone)]
pub enum ProvidersEvent {
    Changed,
}

pub struct ProvidersPage {
    state: Entity<AppState>,
    snapshot: Loadable<CustomProviderSnapshot>,
    editor: Option<ProviderEditor>,
    busy: bool,
    error: Option<SharedString>,
    task: Option<Task<()>>,
    _observe: Subscription,
}

impl EventEmitter<ProvidersEvent> for ProvidersPage {}

struct ProviderEditor {
    id: String,
    existing: bool,
    name: Entity<ComposerInput>,
    base_url: Entity<ComposerInput>,
    api_key: Entity<ComposerInput>,
    formats: HashSet<CustomProviderFormat>,
    _inputs: Vec<Subscription>,
}

impl ProvidersPage {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let observe = cx.observe(&state, |_, _, cx| cx.notify());
        let mut page = Self {
            state,
            snapshot: Loadable::Idle,
            editor: None,
            busy: false,
            error: None,
            task: None,
            _observe: observe,
        };
        page.load(cx);
        page
    }

    fn engine(&self, cx: &gpui::App) -> Option<crate::state::EngineHandle> {
        self.state.read(cx).engine().cloned()
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.engine(cx) else {
            self.snapshot = Loadable::Error("Engine not connected".into());
            return;
        };
        self.snapshot = Loadable::Loading;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::GET_CUSTOM_PROVIDERS, serde_json::json!({}))
                .await;
            this.update(cx, |page, cx| {
                page.snapshot = decode_snapshot(result);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn open_editor(&mut self, provider: Option<CustomProvider>, cx: &mut Context<Self>) {
        let name = cx.new(|cx| ComposerInput::new("Provider name", cx));
        let base_url = cx.new(|cx| ComposerInput::new("https://api.example.com", cx));
        let api_key = cx.new(|cx| ComposerInput::new("API key", cx));
        let mut formats = HashSet::new();
        let (id, existing) = if let Some(provider) = provider {
            name.update(cx, |input, cx| input.set_text(provider.name, cx));
            base_url.update(cx, |input, cx| input.set_text(provider.base_url, cx));
            formats.extend(provider.formats);
            (provider.id, true)
        } else {
            formats.insert(CustomProviderFormat::Anthropic);
            (uuid::Uuid::new_v4().to_string(), false)
        };
        let inputs = [&name, &base_url, &api_key]
            .into_iter()
            .map(|input| {
                cx.subscribe(input, |_, _, event: &ComposerInputEvent, cx| {
                    if matches!(event, ComposerInputEvent::Edited) {
                        cx.notify();
                    }
                })
            })
            .collect();
        self.editor = Some(ProviderEditor {
            id,
            existing,
            name,
            base_url,
            api_key,
            formats,
            _inputs: inputs,
        });
        self.error = None;
        cx.notify();
    }

    fn toggle_format(&mut self, format: CustomProviderFormat, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.as_mut() else {
            return;
        };
        if !editor.formats.remove(&format) {
            editor.formats.insert(format);
        }
        cx.notify();
    }

    fn save_editor(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.as_ref() else {
            return;
        };
        let name = editor.name.read(cx).text().trim().to_string();
        let base_url = editor.base_url.read(cx).text().trim().to_string();
        if let Err(error) = validate_draft(&name, &base_url, &editor.formats) {
            self.error = Some(error.into());
            cx.notify();
            return;
        }
        let Some(engine) = self.engine(cx) else {
            return;
        };
        let api_key = editor.api_key.read(cx).text().trim().to_string();
        if !editor.existing && api_key.is_empty() {
            self.error = Some("API key is required.".into());
            cx.notify();
            return;
        }
        let params = serde_json::json!({
            "id": editor.id,
            "name": name,
            "baseUrl": base_url,
            "apiKey": (!api_key.is_empty()).then_some(api_key),
            "formats": sorted_formats(&editor.formats),
        });
        self.busy = true;
        self.error = None;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::UPSERT_CUSTOM_PROVIDER, params)
                .await;
            this.update(cx, |page, cx| {
                page.busy = false;
                match decode_result(result) {
                    Ok(snapshot) => {
                        page.snapshot = Loadable::Ready(snapshot);
                        page.editor = None;
                        cx.emit(ProvidersEvent::Changed);
                    }
                    Err(error) => page.error = Some(error.into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn delete(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(engine) = self.engine(cx) else {
            return;
        };
        self.busy = true;
        self.error = None;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(
                    methods::DELETE_CUSTOM_PROVIDER,
                    serde_json::json!({ "id": id }),
                )
                .await;
            this.update(cx, |page, cx| {
                page.busy = false;
                match decode_result(result) {
                    Ok(snapshot) => {
                        page.snapshot = Loadable::Ready(snapshot);
                        cx.emit(ProvidersEvent::Changed);
                    }
                    Err(error) => page.error = Some(error.into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn select(&mut self, harness: HarnessId, provider_id: Option<String>, cx: &mut Context<Self>) {
        let Some(engine) = self.engine(cx) else {
            return;
        };
        self.busy = true;
        self.error = None;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(
                    methods::SELECT_CUSTOM_PROVIDER,
                    serde_json::json!({
                        "harness": harness,
                        "providerId": provider_id,
                    }),
                )
                .await;
            this.update(cx, |page, cx| {
                page.busy = false;
                match decode_result(result) {
                    Ok(snapshot) => {
                        page.snapshot = Loadable::Ready(snapshot);
                        cx.emit(ProvidersEvent::Changed);
                    }
                    Err(error) => page.error = Some(error.into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn provider_row(
        &self,
        provider: &CustomProvider,
        first: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let edit = provider.clone();
        let delete_id = provider.id.clone();
        widgets::card_row(theme, first)
            .child(widgets::row_tile(theme, crate::icons::GLOBAL))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(theme, provider.name.clone()))
                    .child(widgets::meta_line(
                        theme,
                        [
                            div()
                                .child(SharedString::from(provider.base_url.clone()))
                                .into_any_element(),
                            div()
                                .child(SharedString::from(format_labels(&provider.formats)))
                                .into_any_element(),
                            div()
                                .child(if provider.has_api_key {
                                    "API key saved"
                                } else {
                                    "API key missing"
                                })
                                .into_any_element(),
                        ]
                        .into_iter()
                        .collect(),
                    )),
            )
            .child(
                widgets::ghost_action(theme)
                    .id(SharedString::from(format!("edit-provider-{}", provider.id)))
                    .hover(widgets::ghost_hover)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.busy {
                            this.open_editor(Some(edit.clone()), cx);
                        }
                    }))
                    .child("Edit"),
            )
            .child(
                widgets::ghost_action(theme)
                    .id(SharedString::from(format!(
                        "delete-provider-{}",
                        provider.id
                    )))
                    .when(self.busy, |button| button.opacity(0.45))
                    .hover(widgets::ghost_hover)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.busy {
                            this.delete(delete_id.clone(), cx);
                        }
                    }))
                    .child("Delete"),
            )
            .into_any_element()
    }

    fn selection_row(
        &self,
        snapshot: &CustomProviderSnapshot,
        harness: HarnessId,
        label: &'static str,
        first: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let selected = snapshot.selection.get(&harness).map(String::as_str);
        let providers = compatible_providers(&snapshot.providers, harness);
        let builtin_selected = selected.is_none();
        let mut options = div().mt(px(8.0)).flex().flex_row().flex_wrap().gap(px(6.0));
        options = options.child(selection_button(
            theme,
            format!("provider-{harness:?}-builtin"),
            "Built-in",
            builtin_selected,
            self.busy,
            cx.listener(move |this, _, _, cx| {
                if !this.busy {
                    this.select(harness, None, cx);
                }
            }),
        ));
        for provider in providers {
            let id = provider.id.clone();
            let active = selected == Some(provider.id.as_str());
            options = options.child(selection_button(
                theme,
                format!("provider-{harness:?}-{}", provider.id),
                provider.name.clone(),
                active,
                self.busy,
                cx.listener(move |this, _, _, cx| {
                    if !this.busy {
                        this.select(harness, Some(id.clone()), cx);
                    }
                }),
            ));
        }
        widgets::card_row(theme, first)
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(theme, label))
                    .child(options),
            )
            .into_any_element()
    }

    fn editor(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let editor = self.editor.as_ref()?;
        let valid = validate_draft(
            editor.name.read(cx).text(),
            editor.base_url.read(cx).text(),
            &editor.formats,
        )
        .is_ok()
            && (editor.existing || !editor.api_key.read(cx).text().trim().is_empty());
        let formats = [
            (CustomProviderFormat::Anthropic, "Anthropic"),
            (CustomProviderFormat::Responses, "Responses"),
            (CustomProviderFormat::ChatCompletions, "Chat completions"),
        ];
        Some(
            div()
                .mt(px(16.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.surface)
                .p(px(20.0))
                .child(widgets::row_title(
                    theme,
                    if editor.existing {
                        "Edit provider"
                    } else {
                        "Add provider"
                    },
                ))
                .child(field(theme, "Name", editor.name.clone()))
                .child(field(theme, "Base URL", editor.base_url.clone()))
                .child(field(theme, "API key", editor.api_key.clone()))
                .when(editor.existing, |panel| {
                    panel.child(
                        div()
                            .mt(px(4.0))
                            .text_size(px(11.0))
                            .text_color(theme.text_muted)
                            .child("Leave the API key blank to keep the saved key."),
                    )
                })
                .child(
                    div()
                        .mt(px(14.0))
                        .text_size(px(12.0))
                        .text_color(theme.text_muted)
                        .child("Supported API formats"),
                )
                .child(
                    div()
                        .mt(px(7.0))
                        .flex()
                        .flex_row()
                        .flex_wrap()
                        .gap(px(6.0))
                        .children(formats.into_iter().map(|(format, label)| {
                            let active = editor.formats.contains(&format);
                            selection_button(
                                theme,
                                format!("provider-format-{format:?}"),
                                label,
                                active,
                                self.busy,
                                cx.listener(move |this, _, _, cx| {
                                    if !this.busy {
                                        this.toggle_format(format, cx);
                                    }
                                }),
                            )
                        })),
                )
                .child(
                    div()
                        .mt(px(18.0))
                        .flex()
                        .gap(px(8.0))
                        .child(
                            crate::popover::btn_primary(theme, "Save")
                                .id("save-custom-provider")
                                .when(!valid || self.busy, |button| button.opacity(0.45))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if valid && !this.busy {
                                        this.save_editor(cx);
                                    }
                                })),
                        )
                        .child(
                            widgets::ghost_action(theme)
                                .id("cancel-custom-provider")
                                .hover(widgets::ghost_hover)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if !this.busy {
                                        this.editor = None;
                                        this.error = None;
                                        cx.notify();
                                    }
                                }))
                                .child("Cancel"),
                        ),
                )
                .into_any_element(),
        )
    }
}

fn field(theme: &Theme, label: &'static str, input: Entity<ComposerInput>) -> gpui::Div {
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
                .h(px(38.0))
                .flex()
                .items_center()
                .overflow_hidden()
                .rounded(px(8.0))
                .border_1()
                .border_color(theme.border)
                .bg(white_alpha(0.02))
                .px(px(9.0))
                .child(input),
        )
}

fn selection_button(
    theme: &Theme,
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    active: bool,
    disabled: bool,
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
            white_alpha(0.09)
        } else {
            white_alpha(0.02)
        })
        .text_size(px(11.5))
        .text_color(if active { theme.text } else { theme.text_muted })
        .when(disabled, |button| button.opacity(0.45))
        .cursor_pointer()
        .on_click(listener)
        .child(label.into())
}

fn decode_result(
    result: Result<serde_json::Value, comet_rpc::RpcError>,
) -> Result<CustomProviderSnapshot, String> {
    result
        .map_err(|error| error.to_string())
        .and_then(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
}

fn decode_snapshot(
    result: Result<serde_json::Value, comet_rpc::RpcError>,
) -> Loadable<CustomProviderSnapshot> {
    match decode_result(result) {
        Ok(snapshot) => Loadable::Ready(snapshot),
        Err(error) => Loadable::Error(error),
    }
}

fn validate_draft(
    name: &str,
    base_url: &str,
    formats: &HashSet<CustomProviderFormat>,
) -> Result<(), &'static str> {
    if name.trim().is_empty() {
        return Err("Provider name is required.");
    }
    let url = base_url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Base URL must start with http:// or https://.");
    }
    if formats.is_empty() {
        return Err("Select at least one API format.");
    }
    Ok(())
}

fn compatible_providers(providers: &[CustomProvider], harness: HarnessId) -> Vec<&CustomProvider> {
    providers
        .iter()
        .filter(|provider| match harness {
            HarnessId::ClaudeCode => provider.formats.contains(&CustomProviderFormat::Anthropic),
            HarnessId::Codex => provider.formats.contains(&CustomProviderFormat::Responses),
            HarnessId::Acp => !provider.formats.is_empty(),
            _ => false,
        })
        .collect()
}

fn sorted_formats(formats: &HashSet<CustomProviderFormat>) -> Vec<CustomProviderFormat> {
    [
        CustomProviderFormat::Anthropic,
        CustomProviderFormat::Responses,
        CustomProviderFormat::ChatCompletions,
    ]
    .into_iter()
    .filter(|format| formats.contains(format))
    .collect()
}

fn format_labels(formats: &[CustomProviderFormat]) -> String {
    formats
        .iter()
        .map(|format| match format {
            CustomProviderFormat::Anthropic => "Anthropic",
            CustomProviderFormat::Responses => "Responses",
            CustomProviderFormat::ChatCompletions => "Chat completions",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

impl gpui::Render for ProvidersPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let snapshot = self.snapshot.ready().cloned();
        let editor = self.editor(&theme, cx);

        div()
            .id("providers-page")
            .size_full()
            .overflow_y_scroll()
            .child(
                widgets::page_column()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .child(widgets::page_header(
                                &theme,
                                "Providers",
                                snapshot.as_ref().map(|snapshot| snapshot.providers.len()),
                            ))
                            .child(div().flex_1())
                            .child(
                                widgets::ghost_action(&theme)
                                    .id("add-custom-provider")
                                    .when(self.editor.is_some() || self.busy, |button| {
                                        button.opacity(0.45)
                                    })
                                    .hover(widgets::ghost_hover)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if this.editor.is_none() && !this.busy {
                                            this.open_editor(None, cx);
                                        }
                                    }))
                                    .child(
                                        crate::icons::icon(crate::icons::ADD_CIRCLE)
                                            .size(px(16.0))
                                            .text_color(theme.text_muted),
                                    )
                                    .child("Add provider"),
                            ),
                    )
                    .child(widgets::page_subtitle(
                        &theme,
                        "Connect OpenAI-compatible or Anthropic-compatible endpoints and choose which coding agents use them.",
                    ))
                    .when_some(self.snapshot.error().map(str::to_string), |page, error| {
                        page.child(
                            widgets::error_strip(error)
                                .id("providers-load-error")
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                        )
                    })
                    .when_some(self.error.clone(), |page, error| {
                        page.child(widgets::error_strip(error))
                    })
                    .children(editor)
                    .when_some(snapshot, |page, snapshot| {
                        page.child(
                            div()
                                .mt(px(24.0))
                                .child(widgets::row_title(&theme, "Agent provider"))
                                .child(
                                    widgets::section_card(&theme)
                                        .mt(px(8.0))
                                        .child(self.selection_row(
                                            &snapshot,
                                            HarnessId::ClaudeCode,
                                            "Claude Code",
                                            true,
                                            &theme,
                                            cx,
                                        ))
                                        .child(self.selection_row(
                                            &snapshot,
                                            HarnessId::Codex,
                                            "Codex",
                                            false,
                                            &theme,
                                            cx,
                                        ))
                                        .child(self.selection_row(
                                            &snapshot,
                                            HarnessId::Acp,
                                            "ACP",
                                            false,
                                            &theme,
                                            cx,
                                        )),
                                ),
                        )
                        .child(
                            div()
                                .mt(px(24.0))
                                .child(widgets::row_title(&theme, "Custom providers"))
                                .child(
                                    widgets::section_card(&theme)
                                        .mt(px(8.0))
                                        .when(snapshot.providers.is_empty(), |card| {
                                            card.child(
                                                div()
                                                    .px(px(20.0))
                                                    .py(px(28.0))
                                                    .text_size(px(13.0))
                                                    .text_color(theme.text_muted)
                                                    .child("No custom providers added yet."),
                                            )
                                        })
                                        .children(snapshot.providers.iter().enumerate().map(
                                            |(index, provider)| {
                                                self.provider_row(
                                                    provider,
                                                    index == 0,
                                                    &theme,
                                                    cx,
                                                )
                                            },
                                        )),
                                ),
                        )
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, formats: Vec<CustomProviderFormat>) -> CustomProvider {
        CustomProvider {
            id: id.into(),
            name: id.into(),
            base_url: "https://example.com".into(),
            has_api_key: true,
            formats,
        }
    }

    #[test]
    fn compatibility_matches_harness_contracts() {
        let providers = vec![
            provider("anthropic", vec![CustomProviderFormat::Anthropic]),
            provider("responses", vec![CustomProviderFormat::Responses]),
            provider("chat", vec![CustomProviderFormat::ChatCompletions]),
        ];
        assert_eq!(
            compatible_providers(&providers, HarnessId::ClaudeCode)[0].id,
            "anthropic"
        );
        assert_eq!(
            compatible_providers(&providers, HarnessId::Codex)[0].id,
            "responses"
        );
        assert_eq!(compatible_providers(&providers, HarnessId::Acp).len(), 3);
    }

    #[test]
    fn draft_requires_name_http_url_and_format() {
        let mut formats = HashSet::new();
        assert!(validate_draft("", "https://example.com", &formats).is_err());
        formats.insert(CustomProviderFormat::Anthropic);
        assert!(validate_draft("Proxy", "example.com", &formats).is_err());
        assert!(validate_draft("Proxy", "https://example.com", &formats).is_ok());
    }
}
