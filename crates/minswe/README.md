# comet-minswe

An in-process, bash-only coding agent ported from
[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) — no Python
runtime, no child agent subprocess, no ACP adapter. The agent loop runs
entirely inside this process: it talks to an OpenAI-compatible Chat
Completions endpoint and executes each bash action in a fresh subshell.

Design record: `docs/research/minswe-rust-port.md`.

## What it is

`MinsweHarness` implements the `Harness` trait **in-process** (the simplest
in-process reference is `MockHarness`; ACP/Cursor harnesses spawn a child
agent). `run()` resolves the OpenAI-compatible endpoint, spawns a tokio task
that drives the agent loop, and returns the `AgentEvent` stream. The loop:

1. Renders the system + instance messages (mini's `default.yaml` templates,
   embedded via `include_str!` and rendered with `minijinja`).
2. Queries the model (streaming text/reasoning deltas + tool calls).
3. Executes each parsed `bash` action in a fresh subshell (`sh -c` / `cmd /C`),
   capturing merged stdout+stderr, enforcing a timeout with full-process-group
   kill, and rendering the observation.
4. Detects `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` to end the run with
   `Done(Completed)`.

Steering (turn-boundary), interrupt, and step/cost/wall-time limits map onto
the existing `AgentEvent` / `RunControls` / `DoneStatus` types — no changes to
those shapes.

## Scope and limitations

This port speaks **OpenAI Chat Completions only**. mini-swe-agent leans on
`litellm` (a Python library normalizing 100+ providers); there is no Rust
equivalent, so we scope to OpenAI-compatible endpoints (xAI, OpenAI,
OpenRouter, Together, …). Anthropic/Gemini are reachable through their
OpenAI-compat gateways — **not** via the native Anthropic Messages API.

- **Auth / endpoint:** reuses the app's existing **custom-provider system**
  (the same one Claude Code and Codex use). Select a `ChatCompletions`-format
  provider for the mini harness in *Settings → Agent provider*; the engine
  injects its `base_url` + API key into the run, and the mini picker merges
  the provider's model catalog. When no provider is explicitly selected but
  exactly one `ChatCompletions` provider is configured, mini auto-resolves
  that provider for both discovery and runs. With no compatible provider at
  all, the client falls back to `XAI_API_KEY` / `OPENAI_API_KEY` in the
  process env, then the login-shell snapshot (so GUI/daemon launches that
  miss shell init still find the key).
- **Cost tracking:** token counts are read from the response `usage` block and
  surfaced via `AgentEvent::Usage`. USD cost is omitted (no cost table); the
  `MinsweConfig::track_cost` flag is reserved for a future table.
- **Multimodal regex expansion** and **`.traj` trajectory output** from
  upstream are not ported (image attachments arrive as staged file paths in
  `RunRequest.attachments` and are inlined as a follow-on user message; the
  app's own session persistence replaces trajectory files).

## The `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` convention

The instance template instructs the model to finish by running:

```
echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT
```

When the first line of a command's output (stripped) equals the sentinel and
the return code is 0, the remainder of the output is treated as the submission
and the run ends with `DoneStatus::Completed` (result = the submission body).
Any command that does not return 0 continues the run, even if it prints the
sentinel.

## Tests

- **Environment** (`environment.rs`): real subprocesses — `echo`, the sentinel,
  and a timeout that kills a long-running command and its descendants in under
  the timeout window (Unix `setsid`/`killpg`; Windows Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
- **Prompts** (`prompts.rs`): pure-function render tests — the macOS
  `sed -i ''` branch, the 10000-char head/tail observation elision, and the
  format-error `finish_reason` branches.
- **Model** (`model.rs`): a hand-built SSE fixture exercising delta
  accumulation, split tool-call fragments, usage parsing, and the format-error
  paths (missing/unknown tool). `MockModelClient` scripts canned turns.
- **Agent loop** (`tests.rs`): end-to-end with `MockModelClient` + a real
  `LocalEnvironment` pointed at a tempdir — a 2-step submit trajectory,
  format-error recovery, repeated-format-error → `Errored`, and step-limit.

## Upstream provenance

The four `templates/*.j2` files are verbatim copies of the templates in
`src/minisweagent/config/default.yaml` at
[SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent). The
agent loop, local environment, and litellm-model ports follow
`agents/default.py`, `environments/local.py`, and `models/litellm_model.py`
respectively, adapted to async + the `Harness` event model.
