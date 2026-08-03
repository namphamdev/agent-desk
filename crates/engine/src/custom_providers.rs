use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, bail};
use comet_proto::{CustomProvider, CustomProviderFormat, CustomProviderSnapshot, HarnessId};
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::doc_host::EdgeConfig;

pub const CUSTOM_PROVIDERS_FILE: &str = "custom-providers.json";

#[derive(Clone)]
pub struct CustomProviders {
    data_dir: Arc<PathBuf>,
    mutation: Arc<tokio::sync::Mutex<()>>,
    edge: Option<EdgeConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CustomProvidersConfig {
    providers: Vec<StoredCustomProvider>,
    selection: HashMap<HarnessId, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AccountSettings {
    custom_providers: CustomProvidersConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    shortcuts: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCustomProvider {
    id: String,
    name: String,
    base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    formats: Vec<CustomProviderFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex_subagent_model: Option<String>,
}

impl CustomProviders {
    pub fn new(data_dir: impl Into<PathBuf>, edge: Option<EdgeConfig>) -> Self {
        Self {
            data_dir: Arc::new(data_dir.into()),
            mutation: Arc::new(tokio::sync::Mutex::new(())),
            edge,
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.data_dir.join(CUSTOM_PROVIDERS_FILE)
    }

    pub async fn list(&self) -> anyhow::Result<CustomProviderSnapshot> {
        let config = self.sync_from_account().await?;
        Ok(snapshot(config))
    }

    pub async fn upsert(
        &self,
        id: String,
        name: String,
        base_url: String,
        api_key: Option<String>,
        formats: Vec<CustomProviderFormat>,
    ) -> anyhow::Result<CustomProviderSnapshot> {
        if id.trim().is_empty() {
            bail!("Provider id cannot be empty");
        }
        if name.trim().is_empty() {
            bail!("Name cannot be empty");
        }
        if base_url.trim().is_empty() {
            bail!("Base URL cannot be empty");
        }
        let url = Url::parse(&base_url).context("Invalid Base URL")?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            bail!("Invalid Base URL");
        }
        if formats.is_empty() {
            bail!("At least one format is required");
        }

        let _guard = self.mutation.lock().await;
        let mut config = self.load_config()?;

        let mut existing_key = None;
        let mut codex_subagent_model = None;
        if let Some(pos) = config.providers.iter().position(|p| p.id == id) {
            existing_key = config.providers[pos].api_key.clone();
            codex_subagent_model = config.providers[pos].codex_subagent_model.clone();
            config.providers.remove(pos);
        }

        let api_key = api_key
            .filter(|key| !key.trim().is_empty())
            .or(existing_key);
        if api_key.is_none() {
            bail!("API key is required");
        }
        let formats = [
            CustomProviderFormat::Anthropic,
            CustomProviderFormat::Responses,
            CustomProviderFormat::ChatCompletions,
        ]
        .into_iter()
        .filter(|format| formats.contains(format))
        .collect();
        config.providers.push(StoredCustomProvider {
            id,
            name: name.trim().to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            formats,
            codex_subagent_model,
        });

        self.save_config(&config)?;
        self.sync_to_account(&config).await?;
        Ok(snapshot(config))
    }

    pub async fn delete(&self, id: &str) -> anyhow::Result<CustomProviderSnapshot> {
        let _guard = self.mutation.lock().await;
        let mut config = self.load_config()?;

        config.providers.retain(|p| p.id != id);
        config.selection.retain(|_, selected_id| selected_id != id);

        self.save_config(&config)?;
        self.sync_to_account(&config).await?;
        Ok(snapshot(config))
    }

    pub async fn select(
        &self,
        harness: HarnessId,
        provider_id: Option<String>,
    ) -> anyhow::Result<CustomProviderSnapshot> {
        let _guard = self.mutation.lock().await;
        let mut config = self.load_config()?;

        if let Some(ref id) = provider_id {
            let provider = config
                .providers
                .iter()
                .find(|p| p.id == *id)
                .ok_or_else(|| anyhow::anyhow!("Provider not found: {}", id))?;

            match harness {
                HarnessId::ClaudeCode => {
                    if !provider.formats.contains(&CustomProviderFormat::Anthropic) {
                        bail!("Claude Code requires a provider supporting the Anthropic format");
                    }
                }
                HarnessId::Codex => {
                    if !provider.formats.contains(&CustomProviderFormat::Responses) {
                        bail!("Codex requires a provider supporting the Responses format");
                    }
                }
                _ => {
                    bail!("Harness {:?} does not support custom providers", harness);
                }
            }
            config.selection.insert(harness, id.clone());
        } else {
            config.selection.remove(&harness);
        }

        self.save_config(&config)?;
        self.sync_to_account(&config).await?;
        Ok(snapshot(config))
    }

    pub async fn set_codex_subagent_model(
        &self,
        provider_id: &str,
        model: Option<String>,
    ) -> anyhow::Result<CustomProviderSnapshot> {
        let _guard = self.mutation.lock().await;
        let mut config = self.load_config()?;
        let provider = config
            .providers
            .iter_mut()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("Provider not found: {provider_id}"))?;
        if !provider.formats.contains(&CustomProviderFormat::Responses) {
            bail!("Codex subagent models require the Responses format");
        }
        provider.codex_subagent_model = model
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty());
        self.save_config(&config)?;
        self.sync_to_account(&config).await?;
        Ok(snapshot(config))
    }

    pub async fn synced_shortcuts(&self) -> anyhow::Result<Option<serde_json::Value>> {
        Ok(self
            .fetch_account_settings()
            .await?
            .and_then(|settings| settings.shortcuts))
    }

    pub async fn set_synced_shortcuts(&self, shortcuts: serde_json::Value) -> anyhow::Result<()> {
        let _guard = self.mutation.lock().await;
        let mut settings = self.fetch_account_settings().await?.unwrap_or_default();
        settings.shortcuts = Some(shortcuts);
        if self.edge.is_some() {
            self.put_account_settings(&settings).await?;
        }
        Ok(())
    }

    /// Fetch an OpenAI-compatible model catalog with the provider's saved
    /// credential. Credentials never cross the RPC boundary.
    pub async fn list_chat_models(&self, provider_id: &str) -> anyhow::Result<Vec<String>> {
        let provider = self.models_provider(provider_id)?;
        let response = reqwest::Client::new()
            .get(openai_endpoint(&provider.base_url, "models")?)
            .bearer_auth(provider.api_key.as_deref().unwrap_or_default())
            .send()
            .await
            .context("request provider models")?
            .error_for_status()
            .context("provider models request failed")?;
        let value: serde_json::Value = response.json().await.context("decode provider models")?;
        let mut models = value
            .get("data")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("id").and_then(serde_json::Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>();
        models.sort();
        models.dedup();
        Ok(models)
    }

    /// Run one non-streaming OpenAI chat-completions request for a desktop
    /// shortcut. The shortcut prompt is the system instruction and the
    /// captured/asked text is the user message.
    pub async fn run_chat_completion(
        &self,
        provider_id: &str,
        model: &str,
        prompt: &str,
        input: &str,
    ) -> anyhow::Result<String> {
        if model.trim().is_empty() {
            bail!("Model is required");
        }
        if prompt.trim().is_empty() {
            bail!("Prompt is required");
        }
        let provider = self.chat_provider(provider_id)?;
        let response = reqwest::Client::new()
            .post(openai_endpoint(&provider.base_url, "chat/completions")?)
            .bearer_auth(provider.api_key.as_deref().unwrap_or_default())
            .json(&serde_json::json!({
                "model": model.trim(),
                "stream": false,
                "messages": [
                    { "role": "system", "content": prompt.trim() },
                    { "role": "user", "content": input },
                ],
            }))
            .send()
            .await
            .context("request chat completion")?
            .error_for_status()
            .context("chat completion request failed")?;
        let value: serde_json::Value = response.json().await.context("decode chat completion")?;
        completion_text(&value)
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("Provider returned an empty chat completion"))
    }

    fn chat_provider(&self, provider_id: &str) -> anyhow::Result<StoredCustomProvider> {
        let config = self.load_config()?;
        let provider = config
            .providers
            .into_iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("Provider not found: {provider_id}"))?;
        if !provider
            .formats
            .contains(&CustomProviderFormat::ChatCompletions)
        {
            bail!("Provider does not support Chat Completions");
        }
        if provider.api_key.as_deref().is_none_or(str::is_empty) {
            bail!("Provider API key is missing");
        }
        Ok(provider)
    }

    fn models_provider(&self, provider_id: &str) -> anyhow::Result<StoredCustomProvider> {
        let config = self.load_config()?;
        let provider = config
            .providers
            .into_iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("Provider not found: {provider_id}"))?;
        if !provider.formats.iter().any(|format| {
            matches!(
                format,
                CustomProviderFormat::Responses | CustomProviderFormat::ChatCompletions
            )
        }) {
            bail!("Provider does not support model discovery");
        }
        if provider.api_key.as_deref().is_none_or(str::is_empty) {
            bail!("Provider API key is missing");
        }
        Ok(provider)
    }

    fn load_config(&self) -> anyhow::Result<CustomProvidersConfig> {
        match std::fs::read_to_string(self.config_path()) {
            Ok(json) => serde_json::from_str(&json).context("decode custom providers settings"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(CustomProvidersConfig::default())
            }
            Err(error) => Err(error).context("read custom providers settings"),
        }
    }

    fn save_config(&self, config: &CustomProvidersConfig) -> anyhow::Result<()> {
        use std::io::Write as _;

        std::fs::create_dir_all(self.data_dir.as_path())?;
        let path = self.config_path();
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(config)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    async fn sync_from_account(&self) -> anyhow::Result<CustomProvidersConfig> {
        let local = self.load_config()?;
        let settings = match self.fetch_account_settings().await {
            Ok(settings) => settings,
            Err(error) => {
                tracing::warn!(%error, "failed to refresh account provider settings");
                return Ok(local);
            }
        };
        let Some(settings) = settings else {
            if self.edge.is_some() && (!local.providers.is_empty() || !local.selection.is_empty()) {
                self.sync_to_account(&local).await?;
            }
            return Ok(local);
        };
        self.save_config(&settings.custom_providers)?;
        Ok(settings.custom_providers)
    }

    async fn sync_to_account(&self, config: &CustomProvidersConfig) -> anyhow::Result<()> {
        let settings = match self.fetch_account_settings().await {
            Ok(settings) => settings,
            Err(error) => {
                tracing::warn!(%error, "failed to load account settings before provider sync");
                return Ok(());
            }
        };
        let Some(mut settings) = settings else {
            if self.edge.is_none() {
                return Ok(());
            }
            if let Err(error) = self
                .put_account_settings(&AccountSettings {
                    custom_providers: config.clone(),
                    ..Default::default()
                })
                .await
            {
                tracing::warn!(%error, "failed to sync account provider settings");
            }
            return Ok(());
        };
        settings.custom_providers = config.clone();
        if let Err(error) = self.put_account_settings(&settings).await {
            tracing::warn!(%error, "failed to sync account provider settings");
        }
        Ok(())
    }

    async fn fetch_account_settings(&self) -> anyhow::Result<Option<AccountSettings>> {
        let Some(edge) = &self.edge else {
            return Ok(None);
        };
        let token = edge.bearer().await.context("not signed in")?;
        let response = reqwest::Client::new()
            .get(format!(
                "{}/account-settings",
                edge.url.trim_end_matches('/')
            ))
            .bearer_auth(token)
            .send()
            .await
            .context("read account settings")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = response
            .error_for_status()
            .context("read account settings")?;
        response
            .json()
            .await
            .context("decode account settings")
            .map(Some)
    }

    async fn put_account_settings(&self, settings: &AccountSettings) -> anyhow::Result<()> {
        let Some(edge) = &self.edge else {
            return Ok(());
        };
        let token = edge.bearer().await.context("not signed in")?;
        reqwest::Client::new()
            .put(format!(
                "{}/account-settings",
                edge.url.trim_end_matches('/')
            ))
            .bearer_auth(token)
            .json(settings)
            .send()
            .await
            .context("write account settings")?
            .error_for_status()
            .context("write account settings")?;
        Ok(())
    }
}

fn openai_endpoint(base_url: &str, path: &str) -> anyhow::Result<reqwest::Url> {
    let base = base_url.trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{base}/{path}")
    } else {
        format!("{base}/v1/{path}")
    };
    reqwest::Url::parse(&url).context("invalid provider endpoint")
}

fn completion_text(value: &serde_json::Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    // A few OpenAI-compatible providers return multimodal content parts even
    // for text-only requests.
    content.as_array().map(|parts| {
        parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>()
            .join("")
    })
}

fn snapshot(config: CustomProvidersConfig) -> CustomProviderSnapshot {
    CustomProviderSnapshot {
        providers: config
            .providers
            .into_iter()
            .map(|p| CustomProvider {
                id: p.id,
                name: p.name,
                base_url: p.base_url,
                has_api_key: p.api_key.as_ref().is_some_and(|key| !key.is_empty()),
                formats: p.formats,
                codex_subagent_model: p.codex_subagent_model,
            })
            .collect(),
        selection: config.selection,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn add_provider(settings: &CustomProviders) -> CustomProviderSnapshot {
        settings
            .upsert(
                "proxy".into(),
                "Proxy".into(),
                "https://api.example.com/".into(),
                Some("secret".into()),
                vec![
                    CustomProviderFormat::Responses,
                    CustomProviderFormat::Responses,
                ],
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn snapshots_never_return_keys_and_edits_preserve_them() {
        let dir = tempfile::tempdir().unwrap();
        let settings = CustomProviders::new(dir.path(), None);
        let snapshot = add_provider(&settings).await;
        assert!(snapshot.providers[0].has_api_key);
        assert_eq!(snapshot.providers[0].base_url, "https://api.example.com");
        assert_eq!(
            snapshot.providers[0].formats,
            vec![CustomProviderFormat::Responses]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(settings.config_path())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        settings
            .upsert(
                "proxy".into(),
                "Renamed".into(),
                "https://api.example.com/v1".into(),
                None,
                vec![CustomProviderFormat::Anthropic],
            )
            .await
            .unwrap();
        let raw = std::fs::read_to_string(settings.config_path()).unwrap();
        assert!(raw.contains("secret"));
        assert!(
            !serde_json::to_string(&settings.list().await.unwrap())
                .unwrap()
                .contains("secret")
        );
    }

    #[tokio::test]
    async fn selection_enforces_harness_formats_and_delete_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let settings = CustomProviders::new(dir.path(), None);
        add_provider(&settings).await;
        assert!(
            settings
                .select(HarnessId::ClaudeCode, Some("proxy".into()))
                .await
                .is_err()
        );
        let selected = settings
            .select(HarnessId::Codex, Some("proxy".into()))
            .await
            .unwrap();
        assert_eq!(
            selected
                .selection
                .get(&HarnessId::Codex)
                .map(String::as_str),
            Some("proxy")
        );
        let configured = settings
            .set_codex_subagent_model("proxy", Some("worker-model".into()))
            .await
            .unwrap();
        assert_eq!(
            configured.providers[0].codex_subagent_model.as_deref(),
            Some("worker-model")
        );
        let deleted = settings.delete("proxy").await.unwrap();
        assert!(deleted.providers.is_empty());
        assert!(deleted.selection.is_empty());
    }

    #[tokio::test]
    async fn rejects_missing_credentials_and_non_http_urls() {
        let dir = tempfile::tempdir().unwrap();
        let settings = CustomProviders::new(dir.path(), None);
        assert!(
            settings
                .upsert(
                    "proxy".into(),
                    "Proxy".into(),
                    "ftp://example.com".into(),
                    Some("secret".into()),
                    vec![CustomProviderFormat::Anthropic],
                )
                .await
                .is_err()
        );
        assert!(
            settings
                .upsert(
                    "proxy".into(),
                    "Proxy".into(),
                    "https://example.com".into(),
                    None,
                    vec![CustomProviderFormat::Anthropic],
                )
                .await
                .is_err()
        );
    }

    #[test]
    fn builds_versioned_endpoints_and_extracts_completion_text() {
        assert_eq!(
            openai_endpoint("https://api.example.com", "chat/completions")
                .unwrap()
                .as_str(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            openai_endpoint("https://api.example.com/v1/", "models")
                .unwrap()
                .as_str(),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            completion_text(&serde_json::json!({
                "choices": [{ "message": { "content": "answer" } }]
            }))
            .as_deref(),
            Some("answer")
        );
        assert_eq!(
            completion_text(&serde_json::json!({
                "choices": [{ "message": { "content": [
                    { "type": "text", "text": "one" },
                    { "type": "text", "text": " two" }
                ] } }]
            }))
            .as_deref(),
            Some("one two")
        );
    }
}
