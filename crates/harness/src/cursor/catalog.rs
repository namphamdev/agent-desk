//! Model catalog for the Cursor CLI.
//!
//! Cursor routes to its own hosted instances of frontier models (Claude,
//! GPT, Gemini, Grok) plus its own Composer model. The available set depends
//! on the user's Cursor plan. We provide a curated static list mirroring
//! Cursor's picker; a live discovery call (`cursor-agent --list-models`) can
//! be spliced in later like the Claude harness's `supportedModels()` path.

use comet_proto::{Model, ReasoningLevel};

/// The reasoning ladder Cursor supports through its AgentThinking capability.
/// Most models support the full range; some cheaper models (Haiku) skip
/// deeper reasoning.
const FULL_LADDER: &[ReasoningLevel] = &[
    ReasoningLevel::Low,
    ReasoningLevel::Medium,
    ReasoningLevel::High,
    ReasoningLevel::XHigh,
    ReasoningLevel::Max,
];

const BASIC_LADDER: &[ReasoningLevel] =
    &[ReasoningLevel::Low, ReasoningLevel::Medium, ReasoningLevel::High];

fn model(
    id: &str,
    label: &str,
    description: &str,
    ladder: &[ReasoningLevel],
) -> Model {
    Model {
        id: id.into(),
        label: label.into(),
        description: (!description.is_empty()).then(|| description.into()),
        reasoning_levels: ladder.to_vec(),
        options: Vec::new(),
    }
}

/// Curated model list for Cursor, mirroring the models available in Cursor's
/// CLI picker. These are the model IDs the `--model` flag accepts.
pub(crate) fn static_models() -> Vec<Model> {
    vec![
        model(
            "claude-sonnet-5",
            "Claude Sonnet 5",
            "Balanced speed and intelligence",
            FULL_LADDER,
        ),
        model(
            "claude-opus-5",
            "Claude Opus 5",
            "Most powerful Anthropic model",
            FULL_LADDER,
        ),
        model(
            "claude-fable-5",
            "Claude Fable 5",
            "Most intelligent model for building agents",
            FULL_LADDER,
        ),
        model(
            "gpt-5.6-sol",
            "GPT-5.6 Sol",
            "OpenAI's flagship coding model",
            FULL_LADDER,
        ),
        model(
            "gpt-5.6-luna",
            "GPT-5.6 Luna",
            "Fast OpenAI model for everyday coding",
            FULL_LADDER,
        ),
        model(
            "gemini-3.1-pro",
            "Gemini 3.1 Pro",
            "Google's most capable model",
            FULL_LADDER,
        ),
        model(
            "gemini-3.6-flash",
            "Gemini 3.6 Flash",
            "Fast Google model",
            BASIC_LADDER,
        ),
        model(
            "cursor-composer-2.5",
            "Composer 2.5",
            "Cursor's own coding model",
            FULL_LADDER,
        ),
        model(
            "grok-4.5",
            "Grok 4.5",
            "xAI's coding model",
            FULL_LADDER,
        ),
    ]
}
