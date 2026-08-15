//! comet-minswe — an in-process, bash-only coding agent ported from
//! [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent).
//!
//! No Python runtime, no child agent subprocess, no ACP adapter: the agent
//! loop runs entirely inside this process, talking to an OpenAI-compatible
//! Chat Completions endpoint and executing each bash action in a fresh
//! subshell. See `docs/research/minswe-rust-port.md` for the design record.
//!
//! The implementation is split into focused submodules:
//! - [`agent`]: the run loop (query → execute → append → emit `AgentEvent`)
//! - [`environment`]: `LocalEnvironment` — fresh subshell, merged stdout/stderr,
//!   timeout + full-process-group kill, `COMPLETE_TASK_AND_SUBMIT` detection
//! - [`model`]: the OpenAI-compatible streaming client + `ModelClient` trait
//! - [`prompts`]: embedded system/instance/observation/format templates
//! - [`config`]: `MinsweConfig` (limits, timeout, cost tracking)

pub mod agent;
pub mod config;
pub mod environment;
pub mod model;
pub mod prompts;

mod harness;
mod messages;

#[cfg(test)]
mod tests;

pub use agent::run_session;
pub use config::{AgentConfig, MinsweConfig};
pub use environment::{EnvOutput, LocalEnvironment};
pub use harness::MinsweHarness;
pub use messages::{ChatMessage, MessageRole};
pub use model::{AssistantMessage, ModelClient, OpenAiCompatClient, TokenUsage};
