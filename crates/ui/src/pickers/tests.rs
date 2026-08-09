use super::config::ResolvedRunConfig;
use super::logic::{breadcrumbs, browser_rows, child_path, clamp_reasoning, default_model, default_reasoning, filter_models, is_absolute_path, parent_path, traits_summary, visible_harnesses_impl};
use super::render_model::harness_brand_icon;
use comet_engine::registry::HarnessDescriptor;
use comet_proto::{FolderEntry, FolderListing, HarnessId, Model, ModelOption, ModelOptionChoice, ReasoningLevel, SandboxLevel};

#[test]
fn traits_summary_formats_non_defaults() {
    let model = Model {
        id: "opus".into(),
        label: "Opus".into(),
        description: None,
        reasoning_levels: vec![ReasoningLevel::Medium, ReasoningLevel::High],
        options: vec![
            ModelOption {
                id: "context".into(),
                label: "Context window".into(),
                choices: vec![
                    ModelOptionChoice {
                        id: "standard".into(),
                        label: "Standard".into(),
                    },
                    ModelOptionChoice {
                        id: "1m".into(),
                        label: "1M".into(),
                    },
                ],
                default_choice: "standard".into(),
            },
            ModelOption {
                id: "speed".into(),
                label: "Speed".into(),
                choices: vec![
                    ModelOptionChoice {
                        id: "normal".into(),
                        label: "Normal".into(),
                    },
                    ModelOptionChoice {
                        id: "fast".into(),
                        label: "Fast".into(),
                    },
                ],
                default_choice: "normal".into(),
            },
        ],
    };
    let mut selections = serde_json::Map::new();
    selections.insert("context".into(), serde_json::Value::String("1m".into()));
    selections.insert("speed".into(), serde_json::Value::String("fast".into()));
    assert_eq!(
        traits_summary(Some(&model), Some(ReasoningLevel::High), &selections),
        Some("High · 1M · Fast".to_string())
    );
    // All defaults → no summary.
    assert_eq!(
        traits_summary(Some(&model), None, &serde_json::Map::new()),
        None
    );
    // Default-choice selections don't count as non-default.
    let mut defaults = serde_json::Map::new();
    defaults.insert("speed".into(), serde_json::Value::String("normal".into()));
    assert_eq!(traits_summary(Some(&model), None, &defaults), None);
    // Reasoning shows without a model too.
    assert_eq!(
        traits_summary(
            None,
            Some(ReasoningLevel::Ultrathink),
            &serde_json::Map::new()
        ),
        Some("Ultrathink".to_string())
    );
}

#[test]
fn folder_paths_and_breadcrumbs() {
    assert_eq!(parent_path("/home/w/dev"), Some("/home/w".to_string()));
    assert_eq!(parent_path("/home"), Some("/".to_string()));
    assert_eq!(parent_path("/home/"), Some("/".to_string()));
    assert_eq!(parent_path("/"), None);
    assert_eq!(parent_path(""), None);
    assert_eq!(child_path("/home", "w"), "/home/w");
    assert_eq!(child_path("/", "home"), "/home");
    assert!(is_absolute_path(
        "/Users/admin/Documents/NP/antigravity-cursor"
    ));
    assert!(!is_absolute_path("antigravity-cursor"));
    let crumbs = breadcrumbs("/home/w/dev");
    let labels: Vec<&str> = crumbs.iter().map(|(l, _)| l.as_str()).collect();
    assert_eq!(labels, ["/", "home", "w", "dev"]);
    assert_eq!(crumbs[2].1, "/home/w");
    assert_eq!(breadcrumbs("/").len(), 1);
}

#[test]
fn browser_navigation_reducer() {
    let listing = FolderListing {
        path: "/home/w".into(),
        entries: vec![
            FolderEntry {
                name: "notes.txt".into(),
                is_dir: false,
                is_repo: false,
            },
            FolderEntry {
                name: "dev".into(),
                is_dir: true,
                is_repo: false,
            },
            FolderEntry {
                name: "comet".into(),
                is_dir: true,
                is_repo: true,
            },
        ],
        truncated: false,
    };
    // Files never show as rows.
    assert_eq!(browser_rows(&listing).len(), 2);
    assert_eq!(browser_rows(&listing)[1].name, "comet");
}

#[test]
fn resolved_chat_config_requires_harness() {
    let mut resolved = ResolvedRunConfig::default();
    assert!(resolved.chat_config().is_none());
    resolved.harness = Some(HarnessId::ClaudeCode);
    resolved.model = Some("opus".into());
    resolved.reasoning = Some(ReasoningLevel::High);
    let config = resolved.chat_config().expect("harness set");
    assert_eq!(config.harness, HarnessId::ClaudeCode);
    assert_eq!(config.model.as_deref(), Some("opus"));
    assert_eq!(config.sandbox, SandboxLevel::WorkspaceWrite);
}

#[test]
fn default_model_is_first_catalog_row() {
    let models = vec![
        Model {
            id: "flagship".into(),
            label: "Flagship".into(),
            description: None,
            reasoning_levels: vec![],
            options: vec![],
        },
        Model {
            id: "fast".into(),
            label: "Fast".into(),
            description: None,
            reasoning_levels: vec![],
            options: vec![],
        },
    ];
    assert_eq!(default_model(&models).map(|m| &*m.id), Some("flagship"));
    assert!(default_model(&[]).is_none());
}

#[test]
fn model_search_matches_labels_ids_and_descriptions() {
    let models = vec![
        Model {
            id: "claude-sonnet-4-5".into(),
            label: "Sonnet 4.5".into(),
            description: Some("Balanced Anthropic model".into()),
            reasoning_levels: vec![],
            options: vec![],
        },
        Model {
            id: "gpt-5-codex".into(),
            label: "GPT-5".into(),
            description: Some("OpenAI coding model".into()),
            reasoning_levels: vec![],
            options: vec![],
        },
    ];

    assert_eq!(
        filter_models("sonnet", &models)
            .into_iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["claude-sonnet-4-5"]
    );
    assert_eq!(filter_models("codex", &models)[0].id, "gpt-5-codex");
    assert_eq!(
        filter_models("anthropic", &models)[0].id,
        "claude-sonnet-4-5"
    );
    assert_eq!(filter_models("", &models).len(), 2);
}

#[test]
fn default_reasoning_prefers_high_then_medium() {
    use ReasoningLevel::*;
    // Recommended default is High (user-corrected), even on full ladders.
    assert_eq!(
        default_reasoning(&[Low, Medium, High, XHigh, Max, Ultracode, Ultrathink]),
        Some(High)
    );
    assert_eq!(default_reasoning(&[Low, Medium, High, Max]), Some(High));
    // No High: Medium.
    assert_eq!(default_reasoning(&[Minimal, Low, Medium]), Some(Medium));
    // Neither offered: first entry.
    assert_eq!(default_reasoning(&[Minimal, Low]), Some(Minimal));
    // Ladder-less model (Haiku): no reasoning at all.
    assert_eq!(default_reasoning(&[]), None);
}

#[test]
fn clamp_reasoning_keeps_offered_levels_and_heals_foreign_ones() {
    use ReasoningLevel::*;
    let ladder = [Low, Medium, High, Max];
    // A pick the ladder offers survives.
    assert_eq!(clamp_reasoning(Some(Max), &ladder), Some(Max));
    // A remembered level the new model doesn't offer heals to its default.
    assert_eq!(clamp_reasoning(Some(XHigh), &ladder), Some(High));
    // No pick at all resolves to the concrete default too.
    assert_eq!(clamp_reasoning(None, &ladder), Some(High));
    assert_eq!(clamp_reasoning(Some(High), &[]), None);
}

#[test]
fn mock_harness_hidden_unless_alone() {
    let descriptor = |id: HarnessId, name: &str| HarnessDescriptor {
        id,
        name: name.into(),
        supports_steering: true,
        steering_mode: comet_proto::SteeringMode::StepBoundary,
        reasoning_levels: vec![],
        acp_agent_id: None,
    };
    let mixed = vec![
        descriptor(HarnessId::Mock, "Mock"),
        descriptor(HarnessId::ClaudeCode, "Claude Code"),
    ];
    // Env-independent core: mock hidden in production…
    let visible = visible_harnesses_impl(&mixed, false);
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].id, HarnessId::ClaudeCode);
    let only_mock = vec![descriptor(HarnessId::Mock, "Mock")];
    assert_eq!(visible_harnesses_impl(&only_mock, false).len(), 1);
    // …and opted back in by COMET_HARNESS=mock (the e2e rig).
    assert_eq!(visible_harnesses_impl(&mixed, true).len(), 2);
    assert_eq!(visible_harnesses_impl(&mixed, true)[0].id, HarnessId::Mock);
}

#[test]
fn acp_brand_icon_uses_per_agent_logo() {
    // Known ACP clients get their own brand mark.
    let (path, _) = harness_brand_icon(HarnessId::Acp, Some("factory-droid"));
    assert_eq!(path, crate::icons::DROID_MARK);
    // Unknown / custom ACP agents fall back to the generic widget icon.
    let (path, _) = harness_brand_icon(HarnessId::Acp, Some("custom:my-agent"));
    assert_eq!(path, crate::icons::WIDGET);
    let (path, _) = harness_brand_icon(HarnessId::Acp, None);
    assert_eq!(path, crate::icons::WIDGET);
    // Non-ACP harnesses ignore the agent id.
    let (path, _) = harness_brand_icon(HarnessId::ClaudeCode, Some("factory-droid"));
    assert_eq!(path, crate::icons::CLAUDE_MARK);
}
