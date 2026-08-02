use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, bail};
use comet_proto::{CustomProvider, CustomProviderFormat, CustomProviderSnapshot, HarnessId};
use reqwest::Url;
use serde::{Deserialize, Serialize};

pub const CUSTOM_PROVIDERS_FILE: &str = "custom-providers.json";

#[derive(Clone)]
pub struct CustomProviders {
    data_dir: Arc<PathBuf>,
    mutation: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CustomProvidersConfig {
    providers: Vec<StoredCustomProvider>,
    selection: HashMap<HarnessId, String>,
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
}

impl CustomProviders {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: Arc::new(data_dir.into()),
            mutation: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.data_dir.join(CUSTOM_PROVIDERS_FILE)
    }

    pub async fn list(&self) -> anyhow::Result<CustomProviderSnapshot> {
        let config = self.load_config()?;
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
        if let Some(pos) = config.providers.iter().position(|p| p.id == id) {
            existing_key = config.providers[pos].api_key.clone();
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
        });

        self.save_config(&config)?;
        Ok(snapshot(config))
    }

    pub async fn delete(&self, id: &str) -> anyhow::Result<CustomProviderSnapshot> {
        let _guard = self.mutation.lock().await;
        let mut config = self.load_config()?;

        config.providers.retain(|p| p.id != id);
        config.selection.retain(|_, selected_id| selected_id != id);

        self.save_config(&config)?;
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
                HarnessId::Acp => {
                    // any format is ok
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
        Ok(snapshot(config))
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
        let settings = CustomProviders::new(dir.path());
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
        let settings = CustomProviders::new(dir.path());
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
        let deleted = settings.delete("proxy").await.unwrap();
        assert!(deleted.providers.is_empty());
        assert!(deleted.selection.is_empty());
    }

    #[tokio::test]
    async fn rejects_missing_credentials_and_non_http_urls() {
        let dir = tempfile::tempdir().unwrap();
        let settings = CustomProviders::new(dir.path());
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
}
