#!/usr/bin/env python3
import json
import os
import sys

selected_model = "acp-fast"
selected_thought_level = "medium"


def send(message):
    print(json.dumps(message), flush=True)


for line in sys.stdin:
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
                "authMethods": [],
                "agentInfo": {"name": "fake-acp", "version": "1.0"},
            },
        })
    elif method == "session/new":
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
        if os.environ.get("FAKE_ACP_EXIT_AFTER_SESSION_NEW"):
            sys.exit(1)
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
