use comet_proto::{AcpAgentsSnapshot, AcpRegistryAgent, InstalledAcpAgent};
use comet_rpc::methods;
use gpui::{
    AnyElement, Context, Entity, SharedString, Subscription, Task, Window, div, prelude::*, px,
};

use crate::popover::Loadable;
use crate::settings::widgets;
use crate::state::AppState;
use crate::theme::Theme;

pub struct AcpAgentsPage {
    state: Entity<AppState>,
    snapshot: Loadable<AcpAgentsSnapshot>,
    busy_agent: Option<String>,
    error: Option<SharedString>,
    load_task: Option<Task<()>>,
    action_task: Option<Task<()>>,
    _observe: Subscription,
}

impl AcpAgentsPage {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let observe = cx.observe(&state, |_, _, cx| cx.notify());
        let mut page = Self {
            state,
            snapshot: Loadable::Idle,
            busy_agent: None,
            error: None,
            load_task: None,
            action_task: None,
            _observe: observe,
        };
        page.load(cx);
        page
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            self.snapshot = Loadable::Error("Engine not connected".into());
            return;
        };
        self.snapshot = Loadable::Loading;
        self.load_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::LIST_ACP_AGENTS, serde_json::json!({}))
                .await;
            this.update(cx, |page, cx| {
                page.snapshot = decode_snapshot(result);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn action(&mut self, method: &'static str, agent_id: String, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.busy_agent = Some(agent_id.clone());
        self.error = None;
        self.action_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(method, serde_json::json!({ "agentId": agent_id }))
                .await;
            this.update(cx, |page, cx| {
                page.busy_agent = None;
                match result {
                    Ok(value) => match serde_json::from_value::<AcpAgentsSnapshot>(value) {
                        Ok(snapshot) => page.snapshot = Loadable::Ready(snapshot),
                        Err(error) => page.error = Some(error.to_string().into()),
                    },
                    Err(error) => page.error = Some(error.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn installed_row(
        &self,
        agent: &InstalledAcpAgent,
        active: bool,
        first: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = agent.id.clone();
        let busy = self.busy_agent.as_deref() == Some(agent.id.as_str());
        let activate_id = id.clone();
        let remove_id = id.clone();
        widgets::card_row(theme, first)
            .child(widgets::row_tile(theme, crate::icons::WIDGET))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(theme, agent.name.clone()))
                    .child(widgets::meta_line(
                        theme,
                        vec![
                            div()
                                .child(SharedString::from(format!("v{}", agent.version)))
                                .into_any_element(),
                            div()
                                .child(SharedString::from(agent.distribution.clone()))
                                .into_any_element(),
                        ],
                    )),
            )
            .when(active, |row| {
                row.child(widgets::badge_active(&theme, "Default"))
            })
            .when(!active, |row| {
                row.child(
                    widgets::ghost_action(theme)
                        .id(SharedString::from(format!("activate-acp-{id}")))
                        .when(busy, |button| button.opacity(0.5))
                        .hover(|s| widgets::ghost_hover(&theme, s))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if this.busy_agent.is_none() {
                                this.action(methods::ACTIVATE_ACP_AGENT, activate_id.clone(), cx);
                            }
                        }))
                        .child("Set default"),
                )
            })
            .child(
                widgets::ghost_action(theme)
                    .id(SharedString::from(format!("remove-acp-{id}")))
                    .when(busy, |button| button.opacity(0.5))
                    .hover(|s| widgets::ghost_hover(&theme, s))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.busy_agent.is_none() {
                            this.action(methods::REMOVE_ACP_AGENT, remove_id.clone(), cx);
                        }
                    }))
                    .child(if busy { "Working…" } else { "Remove" }),
            )
            .into_any_element()
    }

    fn registry_row(
        &self,
        agent: &AcpRegistryAgent,
        installed: bool,
        first: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = agent.id.clone();
        let busy = self.busy_agent.as_deref() == Some(agent.id.as_str());
        let supported = agent.supported;
        widgets::card_row(theme, first)
            .child(widgets::row_tile(theme, crate::icons::ADD_CIRCLE))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(theme, agent.name.clone()))
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_size(px(11.5))
                            .line_height(px(17.0))
                            .text_color(theme.text_muted.opacity(0.65))
                            .child(SharedString::from(agent.description.clone())),
                    )
                    .child(widgets::meta_line(
                        theme,
                        vec![
                            div()
                                .child(SharedString::from(format!("v{}", agent.version)))
                                .into_any_element(),
                            div()
                                .child(SharedString::from(
                                    agent
                                        .distribution
                                        .clone()
                                        .unwrap_or_else(|| "Unavailable on this device".into()),
                                ))
                                .into_any_element(),
                        ],
                    )),
            )
            .when(installed, |row| row.child(widgets::badge(theme, "Added")))
            .when(!installed, |row| {
                row.child(
                    widgets::ghost_action(theme)
                        .id(SharedString::from(format!("install-acp-{id}")))
                        .when(!supported || busy, |button| button.opacity(0.45))
                        .hover(|s| widgets::ghost_hover(&theme, s))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if supported && this.busy_agent.is_none() {
                                this.action(methods::INSTALL_ACP_AGENT, id.clone(), cx);
                            }
                        }))
                        .child(if busy { "Adding…" } else { "Add" }),
                )
            })
            .into_any_element()
    }
}

fn decode_snapshot(
    result: Result<serde_json::Value, comet_rpc::RpcError>,
) -> Loadable<AcpAgentsSnapshot> {
    match result {
        Ok(value) => serde_json::from_value(value)
            .map(Loadable::Ready)
            .unwrap_or_else(|error| Loadable::Error(error.to_string())),
        Err(error) => Loadable::Error(error.to_string()),
    }
}

impl gpui::Render for AcpAgentsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let snapshot = self.snapshot.ready().cloned();
        let refreshing = self.snapshot.is_loading();
        let count = snapshot
            .as_ref()
            .map(|snapshot| snapshot.installed.len())
            .filter(|count| *count > 0);

        let content: Vec<AnyElement> = match snapshot {
            Some(snapshot) => {
                let installed_rows = snapshot
                    .installed
                    .iter()
                    .enumerate()
                    .map(|(index, agent)| {
                        self.installed_row(
                            agent,
                            snapshot.active_agent_id.as_deref() == Some(agent.id.as_str()),
                            index == 0,
                            &theme,
                            cx,
                        )
                    })
                    .collect::<Vec<_>>();
                let registry_rows = snapshot
                    .registry
                    .iter()
                    .enumerate()
                    .map(|(index, agent)| {
                        self.registry_row(
                            agent,
                            snapshot
                                .installed
                                .iter()
                                .any(|installed| installed.id == agent.id),
                            index == 0,
                            &theme,
                            cx,
                        )
                    })
                    .collect::<Vec<_>>();
                vec![
                    div()
                        .mt(px(24.0))
                        .child(widgets::row_title(&theme, "Added on this device"))
                        .child(
                            widgets::section_card(&theme)
                                .mt(px(8.0))
                                .when(installed_rows.is_empty(), |card| {
                                    card.child(
                                        div()
                                            .px(px(20.0))
                                            .py(px(28.0))
                                            .text_size(px(13.0))
                                            .text_color(theme.text_muted)
                                            .child("No ACP agents added yet."),
                                    )
                                })
                                .children(installed_rows),
                        )
                        .into_any_element(),
                    div()
                        .mt(px(24.0))
                        .child(widgets::row_title(&theme, "Official ACP registry"))
                        .when_some(snapshot.registry_error, |section, error| {
                            section.child(widgets::warning_strip(
                                &theme,
                                format!("Could not refresh the registry: {error}"),
                            ))
                        })
                        .child(
                            widgets::section_card(&theme)
                                .mt(px(8.0))
                                .children(registry_rows),
                        )
                        .into_any_element(),
                ]
            }
            None if refreshing => vec![
                widgets::section_card(&theme)
                    .child(
                        div()
                            .px(px(20.0))
                            .py(px(28.0))
                            .text_size(px(13.0))
                            .text_color(theme.text_muted)
                            .child("Loading the ACP registry…"),
                    )
                    .into_any_element(),
            ],
            None => vec![],
        };

        div()
            .id("acp-agents-page")
            .size_full()
            .overflow_y_scroll()
            .child(
                widgets::page_column()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .child(widgets::page_header(&theme, "ACP agents", count))
                            .child(div().flex_1())
                            .child(
                                widgets::ghost_action(&theme)
                                    .id("refresh-acp-registry")
                                    .when(refreshing, |button| button.opacity(0.5))
                                    .hover(|s| widgets::ghost_hover(&theme, s))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if !this.snapshot.is_loading() {
                                            this.load(cx);
                                        }
                                    }))
                                    .child(crate::icons::icon(crate::icons::REFRESH).size(px(14.0)))
                                    .child("Refresh"),
                            ),
                    )
                    .child(widgets::page_subtitle(
                        &theme,
                        "Add ACP-compatible coding agents. Any installed agent can be selected when starting a session; one is the default.",
                    ))
                    .when_some(self.snapshot.error().map(str::to_string), |page, error| {
                        page.child(
                            widgets::error_strip(&theme, error)
                                .id("acp-load-error")
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                        )
                    })
                    .when_some(self.error.clone(), |page, error| {
                        page.child(
                            widgets::error_strip(&theme, error)
                                .id("acp-action-error")
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.error = None;
                                    cx.notify();
                                })),
                        )
                    })
                    .children(content),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_snapshot_rejects_invalid_payload() {
        assert!(matches!(
            decode_snapshot(Ok(serde_json::json!({"installed": "bad"}))),
            Loadable::Error(_)
        ));
    }
}
