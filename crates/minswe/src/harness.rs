//! `MinsweHarness` — the `Harness` impl for the in-process mini agent.
//!
//! Mirrors the shape of `MockHarness` (the simplest in-process reference) but
//! with no child process: `run()` resolves the OpenAI-compatible endpoint,
//! spawns a tokio task driving [`crate::agent::run_session`], and returns a
//! stream built with `futures::stream::unfold(rx, …)` exactly as AcpHarness
//! and MockHarness do.

use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::StreamExt;
use tokio::sync::mpsc;

use comet_harness::{Harness, HarnessError, RunControls};
use comet_proto::{
    AgentEvent, DoneStatus, HarnessId, Model, ReasoningLevel, RunRequest, SteeringMode,
};

use crate::agent::run_session;
use crate::config::MinsweConfig;
use crate::environment::LocalEnvironment;
use crate::model::{resolve_endpoint, ModelClient, OpenAiCompatClient};

/// The in-process mini-swe-agent harness.
pub struct MinsweHarness {
    config: MinsweConfig,
    /// Test seam: when set, `run` uses this client instead of building an
    /// `OpenAiCompatClient` from the resolved endpoint. `None` in production.
    #[allow(dead_code)]
    injected_model: Option<Arc<dyn ModelClient>>,
}

impl Default for MinsweHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl MinsweHarness {
    pub fn new() -> Self {
        Self {
            config: MinsweConfig::new(),
            injected_model: None,
        }
    }

    pub fn with_config(config: MinsweConfig) -> Self {
        Self {
            config,
            injected_model: None,
        }
    }

    /// Test seam: inject a canned model client (e.g. `MockModelClient`).
    #[doc(hidden)]
    pub fn with_mock_model(config: MinsweConfig, model: Arc<dyn ModelClient>) -> Self {
        Self {
            config,
            injected_model: Some(model),
        }
    }
}

const REASONING_LEVELS: &[ReasoningLevel] = &[ReasoningLevel::Medium];

#[async_trait]
impl Harness for MinsweHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Minswe
    }

    fn display_name(&self) -> &str {
        "mini"
    }

    fn supports_steering(&self) -> bool {
        true
    }

    fn steering_mode(&self) -> SteeringMode {
        SteeringMode::TurnBoundary
    }

    fn reasoning_levels(&self) -> &[ReasoningLevel] {
        REASONING_LEVELS
    }

    async fn models(&self, _acp_agent_id: Option<&str>) -> Result<Vec<Model>, HarnessError> {
        // Surface a single default model when no provider is configured (the
        // engine fills custom_provider on the run; this list just keeps the
        // picker usable). When a model override is configured, advertise it.
        let id = self
            .config
            .model
            .clone()
            .unwrap_or_else(|| "default".to_string());
        Ok(vec![Model {
            id,
            label: "mini".into(),
            description: Some(
                "Bash-only agent (mini-swe-agent port). OpenAI-compatible providers.".into(),
            ),
            reasoning_levels: REASONING_LEVELS.to_vec(),
            options: vec![],
        }])
    }

    async fn run(
        &self,
        request: RunRequest,
        controls: RunControls,
    ) -> Result<BoxStream<'static, Result<AgentEvent, HarnessError>>, HarnessError> {
        let endpoint = if self.injected_model.is_some() {
            None
        } else {
            resolve_endpoint(
                request.custom_provider.as_ref(),
                self.config.model.as_deref(),
                request.model.as_deref(),
            )
        };
        let config = self.config.clone();
        let harness_id = self.id();
        let injected_model = self.injected_model.clone();
        let (event_tx, event_rx) = mpsc::channel(256);

        // Resolve cwd: RunRequest.cwd (already absolute when set by the
        // engine); fall back to the process cwd.
        let cwd = if request.cwd.is_empty() {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".into())
        } else {
            request.cwd.clone()
        };

        tokio::spawn(async move {
            // Injected (test) model wins; otherwise build from the resolved
            // endpoint. If no endpoint is configured, end the run with a clear
            // error instead of a silent failure.
            let model: std::sync::Arc<dyn ModelClient> = match (injected_model, endpoint) {
                (Some(m), _) => m,
                (_, Some(endpoint)) => Arc::new(OpenAiCompatClient::new(endpoint)) as Arc<dyn ModelClient>,
                (None, None) => {
                    let _ = event_tx
                        .send(Ok(AgentEvent::Done {
                            status: DoneStatus::Errored,
                            result: None,
                            error: Some(
                                "No OpenAI-compatible provider configured. Add a custom provider \
                                 in Settings, or set XAI_API_KEY / OPENAI_API_KEY."
                                    .into(),
                            ),
                            session_id: None,
                        }))
                        .await;
                    return;
                }
            };
            let env = LocalEnvironment::new(cwd);
            run_session(
                request,
                controls,
                config,
                model,
                env,
                event_tx,
                harness_id,
            )
            .await;
        });

        Ok(futures::stream::unfold(event_rx, |mut rx| async move {
            rx.recv().await.map(|event| (event, rx))
        })
        .boxed())
    }
}

/// Test seam retained for symmetry: the harness is cheap to construct.
#[allow(dead_code)]
pub(crate) fn arc(config: MinsweConfig) -> Arc<dyn Harness> {
    Arc::new(MinsweHarness::with_config(config))
}
