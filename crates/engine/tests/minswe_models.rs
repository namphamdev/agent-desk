//! Regression test: `ListModels` for the mini harness must surface models
//! discovered from the app's custom provider, not just the static `default`
//! entry.

use comet_engine::EngineCore;
use comet_proto::HarnessId;
use comet_rpc::methods;

fn assemble(dir: &std::path::Path) -> EngineCore {
    EngineCore::assemble(
        dir,
        std::sync::Arc::new(comet_engine::default_registry()),
        HarnessId::ClaudeCode,
        None,
    )
    .expect("engine core assembles")
}

/// Spawn a fake OpenAI-compatible `/v1/models` server returning `body`.
fn fake_models_server(body: &'static str) -> (std::net::SocketAddr, tokio::task::JoinHandle<String>) {
    let listener = futures::executor::block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .expect("bind fake server");
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let read = socket.read(&mut chunk).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
        }
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
    (address, server)
}

async fn upsert_chat_provider(
    client: &comet_rpc::RpcClient,
    id: &str,
    address: std::net::SocketAddr,
) {
    let snapshot = client
        .call(
            methods::UPSERT_CUSTOM_PROVIDER,
            serde_json::json!({
                "id": id,
                "name": "Local Proxy",
                "baseUrl": format!("http://{address}"),
                "apiKey": "test-secret",
                "formats": ["chat-completions"]
            }),
        )
        .await
        .unwrap();
    eprintln!("upsert snapshot: {snapshot}");
}

#[tokio::test]
async fn minswe_list_models_uses_explicitly_selected_provider() {
    let (address, server) =
        fake_models_server(r#"{"data":[{"id":"grok-4"},{"id":"grok-5"}]}"#);

    let dir = tempfile::tempdir().unwrap();
    let core = assemble(dir.path());
    let client = comet_rpc::memory_client(core.rpc_service());
    upsert_chat_provider(&client, "proxy", address).await;

    let selected = client
        .call(
            methods::SELECT_CUSTOM_PROVIDER,
            serde_json::json!({ "harness": "minswe", "providerId": "proxy" }),
        )
        .await
        .unwrap();
    eprintln!("select snapshot: {selected}");

    let models = client
        .call(
            methods::LIST_MODELS,
            serde_json::json!({ "harness": "minswe" }),
        )
        .await
        .unwrap();
    eprintln!("LIST_MODELS result: {models}");

    let ids: Vec<String> = models
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_string())
        .collect();
    assert!(ids.contains(&"grok-4".to_string()), "ids: {ids:?}");
    assert!(ids.contains(&"grok-5".to_string()), "ids: {ids:?}");
    // When a provider is selected and discovery succeeds, mini must surface
    // the provider's catalog directly — not the static `default` fallback.
    assert!(!ids.contains(&"default".to_string()), "ids: {ids:?}");

    let request = server.await.unwrap().to_ascii_lowercase();
    assert!(request.starts_with("get /v1/models "), "request: {request}");
}

#[tokio::test]
async fn minswe_list_models_auto_uses_single_compatible_provider() {
    let (address, server) =
        fake_models_server(r#"{"data":[{"id":"grok-auto"}]}"#);

    let dir = tempfile::tempdir().unwrap();
    let core = assemble(dir.path());
    let client = comet_rpc::memory_client(core.rpc_service());
    // No SELECT_CUSTOM_PROVIDER call: mini must auto-resolve the single
    // ChatCompletions provider the app has configured.
    upsert_chat_provider(&client, "proxy", address).await;

    let models = client
        .call(
            methods::LIST_MODELS,
            serde_json::json!({ "harness": "minswe" }),
        )
        .await
        .unwrap();
    eprintln!("LIST_MODELS result: {models}");

    let ids: Vec<String> = models
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["grok-auto".to_string()]);

    let request = server.await.unwrap().to_ascii_lowercase();
    assert!(request.starts_with("get /v1/models "), "request: {request}");
}
