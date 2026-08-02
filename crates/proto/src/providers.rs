use crate::HarnessId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CustomProviderFormat {
    Anthropic,
    Responses,
    ChatCompletions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// Lets settings communicate whether credentials are configured without
    /// ever returning the credential itself.
    #[serde(default)]
    pub has_api_key: bool,
    pub formats: Vec<CustomProviderFormat>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderSnapshot {
    pub providers: Vec<CustomProvider>,
    /// harness_id -> provider_id
    pub selection: HashMap<HarnessId, String>,
}
