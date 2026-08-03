use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use comet_proto::{HarnessId, Model, ReasoningLevel};
use serde::Deserialize;

use crate::HarnessError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    #[serde(default)]
    providers: Vec<StoredProvider>,
    #[serde(default)]
    selection: std::collections::HashMap<HarnessId, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProvider {
    id: String,
    name: String,
    base_url: String,
    api_key: Option<String>,
}

#[derive(Deserialize)]
struct ModelRow {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ModelsResponse {
    Data { data: Vec<ModelRow> },
    Models { models: Vec<ModelRow> },
    Rows(Vec<ModelRow>),
}

impl ModelsResponse {
    fn into_rows(self) -> Vec<ModelRow> {
        match self {
            Self::Data { data } => data,
            Self::Models { models } => models,
            Self::Rows(rows) => rows,
        }
    }
}

pub(crate) async fn discover_selected_provider_models(
    settings_path: Option<&Path>,
    harness: HarnessId,
    reasoning_levels: &[ReasoningLevel],
) -> Result<Option<Vec<Model>>, HarnessError> {
    let Some(path) = settings_path else {
        return Ok(None);
    };
    let config = match std::fs::read_to_string(path) {
        Ok(json) => serde_json::from_str::<ProviderConfig>(&json).map_err(|error| {
            HarnessError::Protocol(format!("invalid custom provider settings: {error}"))
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(HarnessError::Io(error)),
    };
    let Some(provider_id) = config.selection.get(&harness) else {
        return Ok(None);
    };
    let provider = config
        .providers
        .into_iter()
        .find(|provider| &provider.id == provider_id)
        .ok_or_else(|| {
            HarnessError::Protocol(format!(
                "selected custom provider {provider_id:?} no longer exists"
            ))
        })?;
    let api_key = provider
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| HarnessError::Protocol(format!("{} has no API key", provider.name)))?;
    let url = models_url(&provider.base_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| HarnessError::Protocol(error.to_string()))?;
    let response = client
        .get(url.clone())
        // OpenAI-compatible servers use Bearer; Anthropic-compatible servers
        // use x-api-key. Sending both makes discovery work for either format
        // and is harmless for compatible proxies.
        .bearer_auth(api_key)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|error| {
            HarnessError::Protocol(format!(
                "could not discover models from {} ({url}): {error}",
                provider.name
            ))
        })?;
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        HarnessError::Protocol(format!(
            "could not read model response from {}: {error}",
            provider.name
        ))
    })?;
    if !status.is_success() {
        let detail: String = body.chars().take(300).collect();
        return Err(HarnessError::Protocol(format!(
            "{} model discovery failed ({status}): {detail}",
            provider.name
        )));
    }
    let rows = serde_json::from_str::<ModelsResponse>(&body).map_err(|error| {
        HarnessError::Protocol(format!(
            "{} returned an invalid /models response: {error}",
            provider.name
        ))
    })?;
    let mut seen = HashSet::new();
    let models = rows
        .into_rows()
        .into_iter()
        .filter_map(|row| {
            let raw = row.id.trim().to_string();
            if raw.is_empty() || !seen.insert(raw.clone()) {
                return None;
            }
            // Preserve the full model id as the provider's /models endpoint
            // returns it. Some providers namespace ids with a provider prefix
            // (`codex:gpt-5.6-luna`); the upstream needs that full id to
            // route correctly, so the picker id (what the user selects) must
            // be exactly what we send on the wire.
            let id = raw.clone();
            let label = row
                .display_name
                .or(row.name)
                .filter(|label| !label.trim().is_empty())
                .unwrap_or_else(|| id.clone());
            Some(Model {
                id,
                label,
                description: row
                    .description
                    .filter(|description| !description.trim().is_empty())
                    .or_else(|| Some(format!("Discovered from {}", provider.name))),
                reasoning_levels: reasoning_levels.to_vec(),
                options: Vec::new(),
            })
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Err(HarnessError::Protocol(format!(
            "{} returned no models",
            provider.name
        )));
    }
    Ok(Some(models))
}

fn models_url(base_url: &str) -> Result<reqwest::Url, HarnessError> {
    let mut url = normalized_api_base_url(base_url)?;
    let path = format!("{}/models", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

pub(crate) fn normalized_api_base_url(base_url: &str) -> Result<reqwest::Url, HarnessError> {
    let mut url = reqwest::Url::parse(base_url.trim()).map_err(|error| {
        HarnessError::Protocol(format!("invalid custom provider base URL: {error}"))
    })?;
    let path = url.path().trim_end_matches('/');
    let path = if path.is_empty() {
        "/v1".to_string()
    } else if let Some(path) = path.strip_suffix("/models") {
        path.to_string()
    } else {
        path.to_string()
    };
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_url_handles_host_api_root_and_existing_path() {
        assert_eq!(
            models_url("https://example.com").unwrap().as_str(),
            "https://example.com/v1/models"
        );
        assert_eq!(
            models_url("https://example.com/v1/").unwrap().as_str(),
            "https://example.com/v1/models"
        );
        assert_eq!(
            models_url("https://example.com/openai/v1/models")
                .unwrap()
                .as_str(),
            "https://example.com/openai/v1/models"
        );
        assert_eq!(
            normalized_api_base_url("https://example.com")
                .unwrap()
                .as_str(),
            "https://example.com/v1"
        );
    }

    #[test]
    fn accepts_common_model_response_shapes() {
        let data: ModelsResponse =
            serde_json::from_str(r#"{"data":[{"id":"one","display_name":"One"}]}"#).unwrap();
        assert_eq!(data.into_rows()[0].id, "one");
        let models: ModelsResponse =
            serde_json::from_str(r#"{"models":[{"id":"two","name":"Two"}]}"#).unwrap();
        assert_eq!(models.into_rows()[0].id, "two");
        let rows: ModelsResponse = serde_json::from_str(r#"[{"id":"three"}]"#).unwrap();
        assert_eq!(rows.into_rows()[0].id, "three");
    }

    #[tokio::test]
    async fn no_selection_uses_the_builtin_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("custom-providers.json");
        std::fs::write(&settings, r#"{"providers":[],"selection":{}}"#).unwrap();
        assert!(
            discover_selected_provider_models(
                Some(&settings),
                HarnessId::Codex,
                &[ReasoningLevel::High],
            )
            .await
            .unwrap()
            .is_none()
        );
    }

    #[tokio::test]
    async fn discovers_models_with_both_auth_headers() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let body = r#"{"data":[
                {"id":"custom-large","display_name":"Custom Large"},
                {"id":"custom-small"},
                {"id":"custom-large"}
            ]}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            String::from_utf8(request).unwrap()
        });

        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("custom-providers.json");
        std::fs::write(
            &settings,
            serde_json::json!({
                "providers": [{
                    "id": "proxy",
                    "name": "Local Proxy",
                    "baseUrl": format!("http://{address}"),
                    "apiKey": "test-secret",
                    "formats": ["responses"]
                }],
                "selection": {"codex": "proxy"}
            })
            .to_string(),
        )
        .unwrap();
        let models = discover_selected_provider_models(
            Some(&settings),
            HarnessId::Codex,
            &[ReasoningLevel::High],
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["custom-large", "custom-small"]
        );
        assert_eq!(models[0].label, "Custom Large");
        assert_eq!(models[1].label, "custom-small");
        assert_eq!(models[0].reasoning_levels, vec![ReasoningLevel::High]);

        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /v1/models "));
        assert!(request.contains("authorization: bearer test-secret"));
        assert!(request.contains("x-api-key: test-secret"));
    }

    #[tokio::test]
    async fn provider_namespaced_model_ids_are_stripped() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        // A provider whose /models returns `antigravity:gemini-2.5-flash` must
        // surface as the BARE `gemini-2.5-flash` — codex resolves the model
        // against the engine-configured `custom` provider, which knows
        // the bare name only.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let body = r#"{"data":[
                {"id":"antigravity:gemini-2.5-flash","display_name":"Gemini 2.5 Flash"},
                {"id":"plain-model"}
            ]}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("custom-providers.json");
        std::fs::write(
            &settings,
            serde_json::json!({
                "providers": [{
                    "id": "proxy",
                    "name": "Antigravity",
                    "baseUrl": format!("http://{address}"),
                    "apiKey": "test-secret",
                    "formats": ["responses"]
                }],
                "selection": {"codex": "proxy"}
            })
            .to_string(),
        )
        .unwrap();
        let models = discover_selected_provider_models(
            Some(&settings),
            HarnessId::Codex,
            &[ReasoningLevel::High],
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["antigravity:gemini-2.5-flash", "plain-model"]
        );
        server.await.unwrap();
    }
}
