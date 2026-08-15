# Plan: Rewrite mini-swe-agent in Rust, embedded in agent-desk

**Status:** Draft for review
**Author:** Grok
**Date:** 2026-08-12
**Goal:** Add a first-class, in-process, bash-only coding agent to agent-desk by porting the core loop of [`mini-swe-agent`](https://github.com/SWE-agent/mini-swe-agent) to Rust — no Python runtime, no second subprocess, no ACP adapter.

---

## 1. Why this, and why now

mini-swe-agent is a deliberately minimal agent (≈100 lines of Python for the agent class) whose entire design is: **bash is the only tool, messages are a linear append-only history, every action runs in a fresh `subprocess.run`.** That maps almost 1:1 onto this app's `Harness` trait and `AgentEvent` stream model — we get a coding agent for the cost of a thin loop plus one model HTTP client.

Two prior options were considered and rejected in favor of this one:

| Option | Verdict |
|---|---|
| **ACP adapter in Python** (Option 1, prior conversation) | Keeps every-model support via litellm, but adds a Python subprocess, JSON-RPC/stdio shim, slower startup, and duplicate lifecycle code. |
| **PyO3 bindings** (Option 2, prior conversation) | Still requires a Python runtime shipped/embedded; heaviest integration; rejected. |
| **Rust port, in-process** (this plan) | Single binary, instant startup, full control over streaming/steering/interrupt. Cost: limit model support to OpenAI-compatible providers. |

The model-support limitation is acceptable because the app's custom-provider system (`crates/engine/src/custom_providers.rs`) is already oriented around OpenAI-compatible `ChatCompletions` endpoints (xAI, OpenAI, OpenRouter, Together, …), which is exactly what this port targets.

---

## 2. Scope

### In scope
- A new workspace crate `crates/minswe/` implementing the `Harness` trait **in-process** (no child agent subprocess).
- A new `HarnessId::Minswe` variant in `comet-proto`.
- An OpenAI-compatible streaming model client (tool-calling over `/chat/completions`) backed by the app's existing custom-provider config + env-var API keys.
- A local bash environment that runs each command in a fresh subshell, captures merged stdout/stderr, enforces a timeout, kills the whole process group on timeout/interrupt, and renders the observation template.
- Faithful ports of mini-swe-agent's system/instance/observation/format-error templates (embedded via `include_str!`, rendered with `minijinja`).
- Steering (turn-boundary), interrupt, step/cost/wall-time limits, and `COMPLETE_TASK_AND_SUBMIT` exit detection — all mapped to existing `AgentEvent` / `RunControls` / `DoneStatus` types.
- Wiring into the engine's harness registry (`crates/engine/src/registry.rs`) and the `LIST_HARNESSES` RPC expansion so it appears in the UI rail.

### Out of scope (deliberately)
- **Anthropic-native features** (prompt caching, interleaved thinking-block reordering, native Anthropic tool format). We speak OpenAI tool-calling only. Anthropic models can still be reached through OpenAI-compatible gateways (OpenRouter, the provider's own OpenAI-compat endpoint) — not via the native Anthropic Messages API. Documented as a known limitation.
- **Litellm cost registry parity.** Token usage is read from the response `usage` field; USD cost tracking is best-effort or omitted (configurable).
- **Multimodal regex expansion** (`multimodal_regex`) — image attachments already arrive as staged file paths in `RunRequest.attachments`; we inline them as OpenAI image content blocks directly. The Python regex path is not ported.
- **Trajectory file output** (`output_path`). The app's own session/doc persistence replaces this; mini's `.traj` JSON is not produced.
- Benchmark/batch harness (`mini-swe-agent`'s SWE-bench runner, Modal/contree/singularity backends). This port is the interactive agent only.

### Non-goals that are easy to add later
- A second model client speaking the Anthropic Messages API natively (pluggable behind the `Model` trait defined below).
- Persisting/loading mini-format trajectories for interchange with upstream tooling.

---

## 3. Architecture

### 3.1 New crate: `crates/minswe/`

```
crates/minswe/
├── Cargo.toml
└── src/
    ├── lib.rs          # MinsweHarness impl Harness; public exports
    ├── agent.rs        # The run loop: query → execute → append → emit AgentEvent
    ├── environment.rs  # LocalEnvironment: fresh subshell per command, kill group, observation
    ├── model.rs        # OpenAI-compat streaming client; tool-call parsing; usage/cost
    ├── prompts.rs      # Embedded system/instance/observation/format templates + render
    ├── config.rs       # AgentConfig (limits, timeout) + MinsweConfig builder
    └── tests.rs        # Unit tests (mock model + fake env)
```

The crate depends only on `comet-proto`, `tokio`, `reqwest`, `serde`/`serde_json`, `minijinja`, `uuid`, `tracing`, `thiserror`, `futures`, `async-trait`. **No `agent-client-protocol`**, no `async-openai` (we hand-roll a streaming SSE client on top of `reqwest::stream` — already a workspace dep — to keep the dependency surface minimal and to control tool-call delta handling precisely).

### 3.2 Module responsibilities

#### `lib.rs` — `MinsweHarness`
Implements `Harness` (the trait at `crates/harness/src/lib.rs:54`). Mirrors the shape of `MockHarness` (`crates/harness/src/mock.rs`) — the simplest in-process reference — and `CursorHarness` (`crates/harness/src/cursor/mod.rs`), but with **no child process**.

```rust
pub struct MinsweHarness {
    config: MinsweConfig,
}

impl MinsweHarness {
    pub fn new() -> Self { ... }
    pub fn with_config(config: MinsweConfig) -> Self { ... }
}

#[async_trait]
impl Harness for MinsweHarness {
    fn id(&self) -> HarnessId { HarnessId::Minswe }
    fn display_name(&self) -> &str { "mini" }
    fn supports_steering(&self) -> bool { true }
    fn steering_mode(&self) -> SteeringMode { SteeringMode::TurnBoundary }
    fn reasoning_levels(&self) -> &[ReasoningLevel] { &[ReasoningLevel::Medium] }
    async fn models(&self, _: Option<&str>) -> Result<Vec<Model>, HarnessError>;
    async fn run(&self, req: RunRequest, controls: RunControls)
        -> Result<BoxStream<'static, Result<AgentEvent, HarnessError>>, HarnessError>;
}
```

`run()` spawns a tokio task, opens an `mpsc::channel(256)`, emits `SessionStarted`, then drives the agent loop (see `agent.rs`). The stream is built with `futures::stream::unfold(rx, …)` exactly as `AcpHarness::run` and `MockHarness::run` do — same pattern, proven in this codebase.

#### `agent.rs` — the run loop
Direct port of `DefaultAgent.run()` / `step()` / `query()` / `execute_actions()` from `src/minisweagent/agents/default.py`, but async and event-emitting. Linear message history lives in a `Vec<ChatMessage>` owned by the task.

```
build system message (rendered) → push
build instance message (rendered, with task + env vars + uname) → push
emit SessionStarted
loop {
    if step_limit / cost_limit / wall_time exceeded → emit Done(Completed), return
    msg = model.query(messages, interrupt)          // streams TextDelta/ReasoningDelta as they arrive
    push msg
    if msg has no bash action (format error) {
        if consecutive_format_errors >= max → emit Done(Errored), return
        push format-error observation; continue
    }
    for each action:
        emit ToolCall(Exec)
        output = env.execute(action, cwd, timeout, interrupt)
        emit ToolResult(is_error = output.returncode != 0)
        if COMPLETE_TASK_ANDMIT detected → push exit; break
        push observation message (rendered)
    if exit → emit Done(Completed), return
    // turn-boundary: drain any queued steers into new user messages
}
```

Steering, interrupt, and limits are handled at the top of each iteration:
- `controls.steering` (`mpsc::Receiver<SteerMessage>`) is polled at turn boundaries; each steer becomes a new user `ContentBlock::Text` appended to `messages`.
- `controls.interrupt` (`CancellationToken`) is select-armed against the model HTTP call and the subprocess wait; firing it cancels the inflight HTTP request and kills the running bash process group, then emits `Done { status: Interrupted }`.
- `report_memory` is a no-op (no child process tree; the agent runs in-process). Called once with `None` at the end, matching the harness contract.

#### `environment.rs` — `LocalEnvironment`
Port of `src/minisweagent/environments/local.py`. Key behaviors preserved exactly:

- **Fresh subshell per command** (`shell=True` semantics): `Command::new(sh).arg("-c").arg(command)` on Unix; `cmd /C <command>` on Windows. No persistent shell state — this is core to mini-swe-agent's design and to sandboxability.
- **Merged stdout/stderr** (`stdout=PIPE, stderr=STDOUT`): single combined stream.
- **Timeout with full-group kill.** Python uses `start_new_session` + `killpg(SIGKILL)`. Rust equivalent:
  - **Unix:** spawn with `pre_exec` calling `setsid()` (creates a new session/process group), then on timeout kill the whole group via `kill(-pgid, SIGKILL)`. The crate already depends on `libc` for Unix (see `crates/harness/Cargo.toml`).
  - **Windows:** assign the child to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so that killing/closing the job tears down the entire descendant tree. `windows-sys` is already a workspace dep with `Win32_System_Threading` etc. The existing `acp/agent.rs` process-tree code is a reference for the Job-Object pattern; factor a small shared helper if it avoids duplication, otherwise keep local to `minswe`.
- **`COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` detection** (`_check_finished`): if the first line of output (stripped) equals the sentinel and returncode is 0, treat the remainder as the submission and end the run with `DoneStatus::Completed`. Preserved verbatim.
- **Observation rendering:** the env produces a raw `{output, returncode, exception_info}`; the model layer renders it through the observation Jinja template (with the 10000-char head/tail elision rule from `config/default.yaml`). Rendering lives in `model.rs`/`prompts.rs` because it needs the template engine.

The environment reads `cwd` from `RunRequest.cwd` (the app already resolves an absolute cwd — see `absolute_cwd` in `acp/session.rs`), and merges `config.env` (the `PAGER`/`MANPAGER`/`LESS`/`PIP_PROGRESS_BAR`/`TQDM_DISABLE` defaults) onto the inherited process env.

#### `model.rs` — OpenAI-compatible streaming client
Port of `LitellmModel` (`src/minisweagent/models/litellm_model.py`), scoped to OpenAI Chat Completions + tool-calling. This is the largest divergence from upstream (see §4).

Responsibilities:
- **Resolve provider config.** If `RunRequest.custom_provider` is present, use its `base_url` + `api_key`. Otherwise resolve from env (`XAI_API_KEY`, `OPENAI_API_KEY`) via `comet_harness::shell_env` (the same login-shell env-var resolver `acp/mod.rs` uses for Grok) so GUI/daemon launches that miss shell init still find the key.
- **Build the request:** `POST {base_url}/chat/completions`, `stream: true`, `tools: [BASH_TOOL]` (one tool, `{"type":"function","function":{"name":"bash","parameters":{"command":"string"}}}` — same as upstream's `BASH_TOOL`). Messages mapped from the internal `ChatMessage` list.
- **Stream the response** (SSE via `reqwest::stream` + a tiny SSE line parser). For each delta:
  - text delta → emit `AgentEvent::TextDelta`
  - reasoning delta (provider-specific: OpenAI `/responses` `reasoning`, xAI reasoning, Anthropic-via-gateway `thinking` blocks serialized as a pseudo-field) → emit `AgentEvent::ReasoningDelta`
  - accumulate `tool_calls[].function.arguments` fragments
- **At stream end:** assemble the assistant message + parsed bash action(s); read `usage` (prompt/completion/total tokens) for the token meter.
- **Tool-call parsing** (`parse_toolcall_actions`): accept only `name == "bash"`; any other tool name raises a `FormatError` (port upstream behavior). Missing tool calls = format error (drives the format-error loop in `agent.rs`).
- **Cost tracking:** best-effort. Read token counts from `usage`. USD cost is omitted by default (`cost_tracking: ignore_errors` equivalent); a future `ModelCost` table can restore it. Configurable via `MinsweConfig`.
- **Retries:** port upstream's `retry` decorator using `backon` (Exponential backoff) on transient HTTP errors (429/5xx) and network errors; abort on `UnsupportedParams`/`NotFound`/`PermissionDenied`/`ContextWindowExceeded`/`Authentication` — same abort list as `LitellmModel.abort_exceptions`.

A `Model` trait is defined locally (`trait ModelClient { async fn query(...) -> AssistantMessage }`) so an Anthropic-native client can be added later without touching `agent.rs`.

#### `prompts.rs` — templates
Embed the three templates from `src/minisweagent/config/default.yaml` verbatim via `include_str!("templates/system.j2")` etc. (copy the files into `crates/minswe/templates/`). Render with `minijinja` (Jinja2-compatible, so the templates work unchanged — including the `{%- if system == "Darwin" -%}` macOS `sed -i ''` branch and the `{{output.output[:5000]}}` slicing). Template variables mirror upstream: `task`, `system`/`release`/`version`/`machine` (from `uname` / Windows equivalent), `n_model_calls`, `model_cost`, `elapsed_seconds`, plus the `output` object for the observation template.

The format-error template (also from `default.yaml`) is rendered when the model returns no valid bash action.

#### `config.rs`
```rust
pub struct MinsweConfig {
    pub step_limit: u32,                  // 0 = unlimited (upstream default 0)
    pub cost_limit: f64,                  // 0 = unlimited (upstream default 0)
    pub wall_time_limit_secs: u32,        // 0 = unlimited
    pub max_consecutive_format_errors: u32, // default 3
    pub command_timeout_secs: u64,        // per-command, default 30
    pub track_cost: bool,                 // default false (best-effort)
    pub model: Option<String>,            // override; else from RunRequest.model
}
```
Defaults match `config/default.yaml`. All fields overridable for tests.

### 3.3 Proto change: `HarnessId::Minswe`

`crates/proto/src/agent.rs`:
```rust
pub enum HarnessId {
    ClaudeCode,
    Codex,
    Acp,
    Cursor,
    Minswe,   // ← new
    Mock,
}
```
Serde is `rename_all = "kebab-case"`, so the wire value is `"minswe"`. Add to the TypeScript `RunRequest.harness` union in `apps/mobile-app/src/models/Entities.ts` (and any UI harness-label maps — see §5.4).

### 3.4 Engine wiring

`crates/engine/src/registry.rs` — register the new harness lazily, exactly like the existing entries (Claude/Codex/Acp/Cursor at lines 200–322):
```rust
registry.register_lazy(
    HarnessDescriptor {
        id: HarnessId::Minswe,
        name: "mini".into(),
        supports_steering: true,
        steering_mode: SteeringMode::TurnBoundary,
        reasoning_levels: vec![ReasoningLevel::Medium],
        acp_agent_id: None,
        icon: None,
    },
    Box::new(move || Ok(Arc::new(comet_minswe::MinsweHarness::new()) as Arc<dyn Harness>)),
);
```
Because it's a plain `HarnessId` (not `Acp`), the `LIST_HARNESSES` expansion in `rpc.rs` (lines 1132–1167) already surfaces it as its own rail entry — no ACP-specific handling needed.

The workspace `Cargo.toml` gains `comet-minswe = { path = "crates/minswe" }` in `[workspace.dependencies]`, and `crates/engine/Cargo.toml` depends on it (engine already depends on `comet-harness`).

`crates/harness/src/lib.rs` re-exports the new harness type for symmetry with `pub use acp::AcpHarness; pub use cursor::CursorHarness;` — **or** the engine depends on `comet-minswe` directly. **Decision:** add a new workspace member `crates/minswe` (keeps `comet-harness` ACP/Cursor-focused and avoids making the `agent-client-protocol` dep mandatory for the mini harness). The engine imports `comet_minswe::MinsweHarness` directly.

---

## 4. The model layer — the one hard part

This is the single biggest design decision and the main place the port diverges from upstream. mini-swe-agent leans on `litellm`, a Python library normalizing 100+ providers. There is no Rust equivalent. We scope to OpenAI-compatible Chat Completions:

| Concern | Upstream (litellm) | This port |
|---|---|---|
| Tool format | OpenAI tools, normalized for each provider | OpenAI tools only — works against any OpenAI-compat endpoint |
| Auth | Per-provider (env/API key/OAuth) | `RunRequest.custom_provider` → `base_url`+`api_key`; else `XAI_API_KEY`/`OPENAI_API_KEY` from env/login-shell |
| Streaming | litellm streaming | SSE parsed from `reqwest::stream` |
| Cost | litellm cost registry | Token counts from `usage`; USD omitted (configurable) |
| Retries | `tenacity`-based `retry` | `backon` exponential backoff |
| Anthropic thinking reorder | `_reorder_anthropic_thinking_blocks` | N/A (no native Anthropic path) |
| Anthropic cache control | `set_cache_control` | N/A |

**Implication:** users wanting Claude/Gemini natively use the existing Claude Code / ACP harnesses. The mini harness is the lightweight baseline for OpenAI-compatible providers. This is documented in the README and the harness `display_name`/description surfaced to the UI.

A `ModelClient` trait keeps the door open for a future native-Anthropic implementation without disturbing `agent.rs` or `environment.rs`.

---

## 5. Implementation plan (phased)

Each phase is independently testable and lands as its own PR-sized commit.

### Phase 0 — Workspace scaffold
- Add `crates/minswe/` with an empty `lib.rs` and `Cargo.toml` (deps: `comet-proto`, `tokio`, `reqwest`, `serde`, `serde_json`, `minijinja`, `uuid`, `tracing`, `thiserror`, `futures`, `async-trait`, `backon`; Unix: `libc`; Windows: `windows-sys` with Threading features).
- Add `comet-minswe` to `[workspace.dependencies]` and to the workspace `members` list.
- `cargo check -p comet-minswe` passes.

### Phase 1 — Proto + registry stub
- Add `HarnessId::Minswe` (`crates/proto/src/agent.rs`).
- Add a `MinsweHarness::new()` that returns a `Harness` impl whose `run()` immediately emits `SessionStarted` then `Done(Completed)` (no model/env yet) — mirroring the mock harness skeleton.
- Register it in `crates/engine/src/registry.rs`.
- **Verify:** the UI rail shows a "mini" entry; selecting it completes an empty run. `cargo test -p comet-engine` (descriptor-stability tests) still pass.

### Phase 2 — Environment (`environment.rs`)
- Port `LocalEnvironment`: fresh subshell, merged stdout/stderr, timeout + full-group kill (Unix `setsid`+`killpg`; Windows Job Object), `COMPLETE_TASK_AND_SUBMIT` detection.
- Copy `templates/*.j2` from upstream `config/default.yaml`.
- Unit tests: run `echo hello`, assert stdout; timeout kills a `sleep 30` child and its descendants (`sleep 30 & sleep 30` — assert both gone); sentinel detection returns the submission.
- **Verify:** `cargo test -p comet-minswe env`.

### Phase 3 — Prompts + render (`prompts.rs`)
- `include_str!` the four templates; render with `minijinja`.
- Unit tests: render system message with `system=Darwin` (assert macOS `sed -i ''` branch present) and `system=Linux`; render observation with a 20000-char output (assert head/tail elision + `characters elided`).
- **Verify:** `cargo test -p comet-minswe prompts`.

### Phase 4 — Model client (`model.rs`) with a mock
- Implement `ModelClient` trait + `OpenAiCompatClient`.
- Add a `MockModelClient` that returns canned assistant messages with/without a bash tool call (to drive the format-error path).
- Hand-rolled SSE parser tested against a fixture stream.
- Unit tests: tool-call delta accumulation; format-error on missing/unknown tool; usage parsing; retry on 429 (use a mock HTTP server or `wiremock`).
- **Verify:** `cargo test -p comet-minswe model`.

### Phase 5 — Agent loop (`agent.rs`)
- Wire environment + model + prompts into the run loop (§3.2).
- Emit the full `AgentEvent` sequence: `SessionStarted`, `TextDelta`/`ReasoningDelta` (streamed), `ToolCall(Exec)`, `ToolResult`, `Done`.
- Steering: drain `controls.steering` at turn boundaries.
- Interrupt: `select` against model HTTP + subprocess wait; on cancel, abort HTTP and kill the process group, emit `Done { status: Interrupted }`.
- Limits: step/cost/wall-time checks at loop top.
- Integration test with `MockModelClient` + real `LocalEnvironment`: a scripted 2-step trajectory (ls → submit) produces the expected event stream end-to-end.
- **Verify:** `cargo test -p comet-minswe`.

### Phase 6 — Real-model wiring + provider resolution
- Resolve provider from `RunRequest.custom_provider` (already populated by the engine for custom-provider runs) or env/login-shell.
- Surface models in `models()`: return the custom provider's known model list, or a single default `{id:"default"}` when no provider is configured (mirrors `default_acp_model` in `acp/models.rs`).
- Manual smoke test against a real OpenAI-compat endpoint (xAI `grok-*` via `XAI_API_KEY`, or OpenAI) — run "list the files in this dir", observe streaming text + a bash tool call + result.
- **Verify:** end-to-end run in the UI.

### Phase 7 — Polish + docs
- README section in `crates/minswe/` documenting the OpenAI-compat scope and the `COMPLETE_TASK_AND_SUBMIT` convention.
- Update `docs/PARITY.md` / feature inventory if one tracks harness coverage.
- `display_name`, description, and (optional) icon for the rail.
- Remove `eprintln!`-style trace prints (match the codebase convention — it uses `tracing`).

---

## 6. Testing strategy

| Layer | Approach |
|---|---|
| Environment | Real subprocesses (`echo`, `sleep`, `seq`) — fast, deterministic, no network. Reuses `tempfile` for cwd. |
| Prompts | Pure-function unit tests over `minijinja` render. |
| Model (unit) | `MockModelClient` + a mock SSE stream fixture; `wiremock` for HTTP-retry tests. |
| Model (integration) | Manual, behind a `--ignored` test, against a real endpoint. Not in CI. |
| Agent loop | `MockModelClient` + real `LocalEnvironment`: deterministic end-to-end event sequences. |
| Registry/descriptor | Existing descriptor-stability tests in `crates/engine/src/registry.rs` — add a case for `Minswe` mirroring the Codex test. |

The existing `crates/harness/tests/fixtures/fake-acp.py` pattern (a scripted fake agent) is the reference for how this codebase tests harnesses; `MockModelClient` plays the same role without needing stdio.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Tool-call streaming delta accumulation is fiddly** across providers (argument fragments, partial JSON). | Pin to OpenAI's documented streaming tool-call contract; accumulate per-index; parse final JSON only after `[DONE]`. Tests with a recorded fixture. |
| **Windows process-group kill** is easy to get wrong (orphaned children). | Job Object with `KILL_ON_JOB_CLOSE`; integration test spawns `cmd /C "start /B sleep"`-style grandchildren and asserts none survive. Reuse the pattern from `acp/agent.rs`. |
| **`minijinja` ≠ Jinja2 edge cases** (the templates use slices, conditionals, `length`). | minijinja targets Jinja2 compatibility; the unit tests in Phase 3 catch any gap. Fallback: minor template adjustment (templates are ours to edit once copied in). |
| **Provider env-var resolution for GUI/daemon launches** (the same problem `acp/mod.rs` solves for Grok). | Reuse `comet_harness::shell_env::login_shell_env_var` — already solves this. |
| **Cost tracking expectations.** Users coming from mini-swe-agent may expect USD costs. | Document clearly; surface token counts (always available); make USD an opt-in future addition behind a cost table. |
| **Drift from upstream prompts.** mini-swe-agent may update `default.yaml`. | Templates are version-pinned in-repo with a header comment noting the upstream commit SHA; a periodic `scripts/` diff check can flag drift. |

---

## 8. Outward-facing changes

- **New workspace member** `crates/minswe` (and `comet-minswe` workspace dep).
- **New proto variant** `HarnessId::Minswe` (wire: `"minswe"`) — additive, serde-defaulted where used in option fields, so older peers ignore it.
- **New engine registry entry** — auto-surfaces in `LIST_HARNESSES` and the UI rail.
- **TypeScript** `RunRequest.harness` union gains `"minswe"`; any harness-label map in the UI gains a display label.
- **No changes** to `RunRequest`/`AgentEvent`/`ToolCall` shape — the port emits existing event types only.
- **No breaking changes** to existing harnesses.

---

## 9. Open questions (need your call)

1. **Crate location:** new workspace member `crates/minswe` (recommended — isolates deps, no `agent-client-protocol` pulled in) **vs.** a module under `crates/harness/src/minswe/` (co-located, but forces `comet-harness` to carry mini's deps). Default: new member.
2. **Model cost tracking:** omit USD entirely for v1 (default), or wire a small `ModelCost` table? Default: omit.
3. **Native Anthropic support:** ship OpenAI-compat-only for v1 (default), or block Phase 6 on a native Anthropic `ModelClient` too? Default: OpenAI-compat-only, documented.
4. **Reasoning levels:** mini has no reasoning-level concept (it's prompt-only). Expose a single `Medium` (default, matches `MockHarness`), or expose the full ladder and map to prompt prefixes? Default: single `Medium`.
5. **Default-on in the rail:** should "mini" appear for all users, or be feature-flagged/gated behind a setting until hardened? Default: appear for all (it's additive; existing harnesses unaffected).

---

## 10. Definition of done

- `cargo test` green across the workspace, including new `comet-minswe` unit + integration tests.
- Selecting "mini" in the UI with a configured OpenAI-compatible provider runs a real bash-agent session: streaming assistant text, visible `Exec` tool calls and results, working interrupt and steering, clean `Done(Completed)` on `COMPLETE_TASK_AND_SUBMIT`.
- Interrupt kills any in-flight bash process and its descendants on both Windows and Unix (verified by the kill-group tests).
- No Python runtime, no second subprocess, no ACP dependency introduced.
- README in `crates/minswe/` documents scope, the OpenAI-compat limitation, and the `COMPLETE_TASK_AND_SUBMIT` convention.
