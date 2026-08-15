#!/usr/bin/env python3
import json
import os
import sys

selected_model = "acp-fast"
selected_thought_level = "medium"

# Session ids that "exist" and can be loaded via session/load.
# The fixture always mints "acp-session-1" for new sessions, so it is
# pre-seeded here so a standalone session/load test (no prior session/new
# in the same process) can succeed.
known_sessions = {"acp-session-1"}

# When FAKE_ACP_LOAD_FAIL is set, session/load always fails — the harness
# must fall back to session/new.
load_fail = bool(os.environ.get("FAKE_ACP_LOAD_FAIL"))

# When FAKE_ACP_REQUIRE_AUTH is set, the fixture advertises authentication
# methods on initialize (mirroring Grok's `grok agent stdio` server) and
# rejects session/new and session/load until the client sends authenticate.
require_auth = bool(os.environ.get("FAKE_ACP_REQUIRE_AUTH"))
authenticated = not require_auth
# When FAKE_ACP_AUTH_LOG is set, the authenticate request params are recorded
# so tests can assert which method the harness picked.
auth_log = os.environ.get("FAKE_ACP_AUTH_LOG")
# When FAKE_ACP_AUTH_FAIL is set, authenticate returns an error — the harness
# must degrade to the default model instead of surfacing raw protocol errors.
auth_fail = bool(os.environ.get("FAKE_ACP_AUTH_FAIL"))
# When FAKE_ACP_NO_PROMPT_RESPONSE is set, the fixture streams
# agent_message_chunk notifications but never sends the session/prompt
# response — mirroring the grok-build-acp bug where the chat completions
# stream finishes (finish_reason: "stop") but no ACP PromptResponse is
# sent, leaving the session perpetually pending.
no_prompt_response = bool(os.environ.get("FAKE_ACP_NO_PROMPT_RESPONSE"))


def send(message):
    print(json.dumps(message), flush=True)


def read_response(request_id):
    """Read stdin until the response whose id matches `request_id` arrives."""
    while True:
        line = sys.stdin.readline()
        if not line:
            return None
        message = json.loads(line)
        if message.get("id") == request_id:
            return message


while True:
    line = sys.stdin.readline()
    if not line:
        break
    message = json.loads(line)
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": {},
                "authMethods": (
                    [
                        {"id": "cached_token", "name": "Cached token"},
                        {"id": "xai.api_key", "name": "xAI API key"},
                    ]
                    if require_auth
                    else []
                ),
                "agentInfo": {"name": "fake-acp", "version": "1.0"},
            },
        })
    elif method == "authenticate":
        if auth_fail:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32001, "message": "Auth failed"},
            })
            sys.exit(1)
        authenticated = True
        if auth_log:
            with open(auth_log, "w") as log:
                json.dump(message.get("params", {}), log)
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {},
        })
    elif method == "session/new":
        if not authenticated:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32001,
                    "message": "Not authenticated: send authenticate first",
                },
            })
            sys.exit(1)
        if discovery_log := os.environ.get("FAKE_ACP_DISCOVERY_LOG"):
            with open(discovery_log, "a") as log:
                log.write("session/new\n")
        # When FAKE_ACP_ENV_LOG is set, record the provider-related env vars
        # the harness passed so tests can assert they reached the subprocess.
        if env_log := os.environ.get("FAKE_ACP_ENV_LOG"):
            interesting = {
                key: os.environ.get(key, "")
                for key in [
                    "MODEL_PROVIDER",
                    "CODEX_CONFIG",
                    "CODEX_API_KEY",
                    "OPENAI_API_KEY",
                ]
            }
            with open(env_log, "w") as log:
                json.dump(interesting, log)
        if (
            os.environ.get("FAKE_ACP_REJECT_MCP")
            and message.get("params", {}).get("mcpServers")
        ):
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32603, "message": "MCP is unavailable during discovery"},
            })
            sys.exit(1)
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "sessionId": "acp-session-1",
                "configOptions": [
                    {
                        "id": "model",
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": selected_model,
                        "options": [
                            {
                                "value": "acp-fast",
                                "name": "ACP Fast",
                                "description": "Fast model",
                            },
                            {
                                "value": "acp-smart",
                                "name": "ACP Smart",
                                "description": "Smart model",
                            },
                        ],
                    },
                    {
                        "id": "thought-level",
                        "name": "Reasoning",
                        "category": "thought_level",
                        "type": "select",
                        "currentValue": selected_thought_level,
                        "options": [
                            {"value": "low", "name": "Low"},
                            {"value": "medium", "name": "Medium"},
                            {"value": "high", "name": "High"},
                            {"value": "x-high", "name": "Extra High"},
                        ],
                    },
                ],
            },
        })
        known_sessions.add("acp-session-1")
        if os.environ.get("FAKE_ACP_EXIT_AFTER_SESSION_NEW"):
            sys.exit(1)
    elif method == "session/load":
        if not authenticated:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32001,
                    "message": "Not authenticated: send authenticate first",
                },
            })
            sys.exit(1)
        load_session_id = message.get("params", {}).get("sessionId", "")
        if load_fail or load_session_id not in known_sessions:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32602,
                    "message": f"Session not found: {load_session_id}",
                },
            })
        else:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "configOptions": [
                        {
                            "id": "model",
                            "name": "Model",
                            "category": "model",
                            "type": "select",
                            "currentValue": selected_model,
                            "options": [
                                {
                                    "value": "acp-fast",
                                    "name": "ACP Fast",
                                    "description": "Fast model",
                                },
                                {
                                    "value": "acp-smart",
                                    "name": "ACP Smart",
                                    "description": "Smart model",
                                },
                            ],
                        },
                        {
                            "id": "thought-level",
                            "name": "Reasoning",
                            "category": "thought_level",
                            "type": "select",
                            "currentValue": selected_thought_level,
                            "options": [
                                {"value": "low", "name": "Low"},
                                {"value": "medium", "name": "Medium"},
                                {"value": "high", "name": "High"},
                                {"value": "x-high", "name": "Extra High"},
                            ],
                        },
                    ],
                },
            })
    elif method == "session/set_config_option":
        if message["params"]["configId"] == "model":
            selected_model = message["params"]["value"]
        elif message["params"]["configId"] == "thought-level":
            selected_thought_level = message["params"]["value"]
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            # Older ACP agents apply the option but return an empty result.
            "result": {},
        })
    elif method == "session/prompt":
        session_id = message["params"]["sessionId"]
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": {"type": "text", "text": "Thinking"},
                },
            },
        })
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {
                        "type": "text",
                        "text": f"Hello from ACP ({selected_thought_level})",
                    },
                },
            },
        })
        if os.environ.get("FAKE_ACP_ASK_USER_QUESTION"):
            ask_id = 9000
            send({
                "jsonrpc": "2.0",
                "id": ask_id,
                "method": "_x.ai/ask_user_question",
                "params": {
                    "sessionId": session_id,
                    "toolCallId": "tool-ask",
                    "questions": [
                        {
                            "question": "Which database?",
                            "options": [
                                {"label": "Redis", "description": "In-memory store"},
                                {"label": "Postgres", "description": "Relational DB"},
                            ],
                            "multiSelect": False,
                        },
                        {
                            "question": "Which features?",
                            "options": [
                                {"label": "Auth"},
                                {"label": "Logging"},
                            ],
                            "multiSelect": True,
                        },
                    ],
                    "mode": "default",
                },
            })
            response = read_response(ask_id)
            if ask_response_log := os.environ.get("FAKE_ACP_ASK_RESPONSE_LOG"):
                with open(ask_response_log, "w") as log:
                    json.dump(response if response is not None else {}, log)
        if os.environ.get("FAKE_ACP_EXIT_PLAN_MODE"):
            exit_id = 9100
            send({
                "jsonrpc": "2.0",
                "id": exit_id,
                "method": "_x.ai/exit_plan_mode",
                "params": {
                    "sessionId": session_id,
                    "toolCallId": "tool-exit-plan",
                    "plan": "## Plan\n1. Refactor foo\n2. Add tests",
                    "planPath": "plan.md",
                },
            })
            response = read_response(exit_id)
            if exit_plan_response_log := os.environ.get("FAKE_ACP_EXIT_PLAN_RESPONSE_LOG"):
                with open(exit_plan_response_log, "w") as log:
                    json.dump(response if response is not None else {}, log)
        if no_prompt_response:
            # Stream text but never send the prompt response — the harness
            # idle watchdog must synthesize Done(Completed) instead of
            # hanging forever. When FAKE_ACP_STDERR_DONE is set, also log
            # the turn-completion markers codex-acp writes to its stderr
            # (terminal sse_chunk + turn summary), which the harness uses as
            # an early completion signal.
            if os.environ.get("FAKE_ACP_STDERR_DONE"):
                print(
                    'INFO event="sse_chunk" backend="chat_completions" data='
                    '{"id":"x","object":"chat.completion.chunk","created":0,'
                    '"model":"fake","choices":[{"index":0,"finish_reason":"stop",'
                    '"logprobs":null,"delta":{"content":"","reasoning_content":null}}],'
                    '"usage":{"prompt_tokens":10,"completion_tokens":5}}',
                    file=sys.stderr,
                    flush=True,
                )
                print("INFO turn summary generated chars=1", file=sys.stderr, flush=True)
            continue
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-1",
                    "title": "Run tests",
                    "kind": "execute",
                    "status": "in_progress",
                    "rawInput": {"command": "cargo test"},
                },
            },
        })
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-1",
                    "status": "completed",
                },
            },
        })
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"stopReason": "end_turn"},
        })
