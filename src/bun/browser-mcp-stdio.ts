/**
 * MCP stdio server for the built-in browser panel.
 *
 * Spawned by Claude Code via session/new mcpServers. Talks JSON-RPC (MCP)
 * over stdin/stdout and forwards tool calls to the app's localhost control
 * plane (TR_BROWSER_CONTROL_URL + TR_BROWSER_TOKEN + TR_BROWSER_SESSION_ID).
 *
 * No npm deps — plain Bun/Node-compatible script so packaging stays simple.
 */
type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const CONTROL_URL = process.env.TR_BROWSER_CONTROL_URL ?? "";
const TOKEN = process.env.TR_BROWSER_TOKEN ?? "";
const SESSION_ID = process.env.TR_BROWSER_SESSION_ID ?? "";
const PROJECT_CWD = process.env.TR_PROJECT_CWD ?? "";

const TOOLS = [
  {
    name: "browser_session_info",
    description:
      "Return binding for THIS chat: session id, project cwd, whether the right-side browser panel is open, and stored tokens for the project. Call first when you need context. This MCP is already bound to the current chat — do not invent session ids.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_open",
    description:
      "Open the built-in right-side browser panel for this chat if it is closed. Safe to call before navigate/snapshot. Does not load a URL by itself.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_navigate",
    description:
      "Open/navigate the built-in right-side browser panel to a URL. Panel opens automatically if closed. Prefer this over external browsers. Do not curl localhost or invent control tokens.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Capture an accessibility snapshot of the built-in browser page with element refs (e1, e2, …) for click/type. Call after browser_navigate.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click an element in the built-in browser by snapshot ref.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from browser_snapshot, e.g. e3" },
        element: { type: "string", description: "Human-readable element description" },
      },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description: "Type text into an element (by ref) in the built-in browser.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        element: { type: "string" },
        submit: {
          type: "boolean",
          description: "If true, press Enter after typing",
        },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_fill",
    description: "Clear and fill an input (by ref) in the built-in browser.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string" },
        element: { type: "string" },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "browser_press_key",
    description: "Press a key in the built-in browser (e.g. Enter, Escape, Tab).",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "browser_navigate_back",
    description: "Go back in the built-in browser history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_navigate_forward",
    description: "Go forward in the built-in browser history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_reload",
    description: "Reload the current page in the built-in browser.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_get_url",
    description: "Return the current URL and title of the built-in browser.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_evaluate",
    description:
      "Run a JavaScript expression in the built-in browser page and return the result. " +
      "Use to read localStorage, cookies, or tokens after a multi-step login. " +
      "Example: localStorage.getItem('access_token') or document.cookie",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "JS expression that returns a JSON-serializable value",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "browser_store_token",
    description:
      "Save a token/secret (OAuth access token, API key, cookie, etc.) to the app SQLite DB " +
      "for this project. Future prompts automatically include stored tokens so you do NOT " +
      "need to re-run multi-step browser login. Prefer this after browser_evaluate finds a token.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Stable name, e.g. oauth_access_token or github_pat",
        },
        value: { type: "string", description: "Token value to store" },
        label: {
          type: "string",
          description: "Optional human label, e.g. GitHub OAuth",
        },
        domain: {
          type: "string",
          description: "Optional domain hint, e.g. github.com",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "browser_list_tokens",
    description:
      "List tokens already stored in SQLite for this project (keys and values).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_delete_token",
    description: "Delete a stored token by key for this project.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
      },
      required: ["key"],
    },
  },
] as const;

async function control(
  action: string,
  extra: Record<string, unknown> = {},
): Promise<{ ok: boolean; [k: string]: unknown }> {
  if (!CONTROL_URL || !TOKEN || !SESSION_ID) {
    return {
      ok: false,
      error:
        "Built-in browser control is not configured (missing TR_BROWSER_* env). Restart the desktop app session.",
    };
  }
  const res = await fetch(`${CONTROL_URL}/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ sessionId: SESSION_ID, action, ...extra }),
  });
  return (await res.json()) as { ok: boolean; [k: string]: unknown };
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof textResult>> {
  try {
    switch (name) {
      case "browser_session_info": {
        const r = await control("session_info");
        if (!r.ok) return textResult(String(r.error ?? "session_info failed"), true);
        const tokens = (r.tokens as Array<Record<string, unknown>>) ?? [];
        const tokenLines =
          tokens.length === 0
            ? "(none stored yet — use browser_store_token after login)"
            : tokens
                .map((t) => {
                  const key = String(t.key ?? "");
                  const val = String(t.value ?? "");
                  const label = t.label ? ` (${t.label})` : "";
                  const domain = t.domain ? ` [${t.domain}]` : "";
                  return `  - ${key}${label}${domain}: ${val}`;
                })
                .join("\n");
        return textResult(
          [
            "Built-in browser binding (this chat only):",
            `  chatSessionId: ${r.sessionId ?? SESSION_ID}`,
            `  projectCwd: ${r.projectCwd ?? (PROJECT_CWD || "(unknown)")}`,
            `  panelOpen: ${r.panelOpen === true ? "yes" : r.panelOpen === false ? "no" : "unknown"}`,
            `  mcpServer: browser`,
            `  message: ${r.message ?? ""}`,
            "Stored tokens for this project:",
            tokenLines,
            "Next: browser_open (if panel closed) → browser_navigate → browser_snapshot.",
          ].join("\n"),
        );
      }
      case "browser_open": {
        const r = await control("open");
        if (!r.ok) return textResult(String(r.error ?? "open failed"), true);
        return textResult(
          String(
            r.message ??
              "Browser panel open for this chat. Use browser_navigate with a URL.",
          ),
        );
      }
      case "browser_navigate": {
        const r = await control("navigate", { url: args.url });
        if (!r.ok) return textResult(String(r.error ?? "navigate failed"), true);
        return textResult(
          `Navigated built-in browser to ${r.url ?? args.url}` +
            (r.title ? `\nTitle: ${r.title}` : ""),
        );
      }
      case "browser_snapshot": {
        const r = await control("snapshot");
        if (!r.ok) return textResult(String(r.error ?? "snapshot failed"), true);
        const header = `URL: ${r.url ?? "?"}\nTitle: ${r.title ?? "?"}\n\n`;
        return textResult(header + String(r.snapshot ?? "(empty)"));
      }
      case "browser_click": {
        const r = await control("click", { ref: args.ref });
        if (!r.ok) return textResult(String(r.error ?? "click failed"), true);
        return textResult(String(r.message ?? `Clicked ${args.ref}`));
      }
      case "browser_type": {
        const r = await control("type", {
          ref: args.ref,
          text: args.text,
          submit: args.submit,
        });
        if (!r.ok) return textResult(String(r.error ?? "type failed"), true);
        return textResult(String(r.message ?? `Typed into ${args.ref}`));
      }
      case "browser_fill": {
        const r = await control("fill", {
          ref: args.ref,
          text: args.value ?? args.text,
        });
        if (!r.ok) return textResult(String(r.error ?? "fill failed"), true);
        return textResult(String(r.message ?? `Filled ${args.ref}`));
      }
      case "browser_press_key": {
        const r = await control("press", { key: args.key });
        if (!r.ok) return textResult(String(r.error ?? "press failed"), true);
        return textResult(String(r.message ?? `Pressed ${args.key}`));
      }
      case "browser_navigate_back": {
        const r = await control("back");
        if (!r.ok) return textResult(String(r.error ?? "back failed"), true);
        return textResult(`Back → ${r.url ?? "ok"}`);
      }
      case "browser_navigate_forward": {
        const r = await control("forward");
        if (!r.ok) return textResult(String(r.error ?? "forward failed"), true);
        return textResult(`Forward → ${r.url ?? "ok"}`);
      }
      case "browser_reload": {
        const r = await control("reload");
        if (!r.ok) return textResult(String(r.error ?? "reload failed"), true);
        return textResult(`Reloaded ${r.url ?? ""}`.trim());
      }
      case "browser_get_url": {
        const r = await control("url");
        if (!r.ok) return textResult(String(r.error ?? "url failed"), true);
        return textResult(`URL: ${r.url ?? "?"}\nTitle: ${r.title ?? "?"}`);
      }
      case "browser_evaluate": {
        const r = await control("evaluate", { expression: args.expression });
        if (!r.ok) return textResult(String(r.error ?? "evaluate failed"), true);
        return textResult(
          `Result:\n${r.result ?? "null"}` +
            (r.url ? `\nURL: ${r.url}` : ""),
        );
      }
      case "browser_store_token": {
        const r = await control("store_token", {
          tokenKey: args.key,
          tokenValue: args.value,
          tokenLabel: args.label,
          tokenDomain: args.domain,
        });
        if (!r.ok) return textResult(String(r.error ?? "store failed"), true);
        return textResult(
          String(
            r.message ??
              `Stored token "${args.key}" in SQLite for this project. ` +
                `It will be injected into future prompts automatically.`,
          ),
        );
      }
      case "browser_list_tokens": {
        const r = await control("list_tokens");
        if (!r.ok) return textResult(String(r.error ?? "list failed"), true);
        const tokens = (r.tokens as Array<Record<string, unknown>>) ?? [];
        if (tokens.length === 0) {
          return textResult("No tokens stored for this project yet.");
        }
        const lines = tokens.map((t) => {
          const key = String(t.key ?? "");
          const val = String(t.value ?? "");
          const label = t.label ? ` (${t.label})` : "";
          const domain = t.domain ? ` [${t.domain}]` : "";
          return `- ${key}${label}${domain}: ${val}`;
        });
        return textResult(`Stored tokens (${tokens.length}):\n${lines.join("\n")}`);
      }
      case "browser_delete_token": {
        const r = await control("delete_token", { tokenKey: args.key });
        if (!r.ok) return textResult(String(r.error ?? "delete failed"), true);
        return textResult(String(r.message ?? `Deleted token "${args.key}"`));
      }
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err), true);
  }
}

/** Versions the MCP TS SDK (and Claude Code) accept. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

/**
 * MCP stdio transport uses newline-delimited JSON (one JSON-RPC message per
 * line). Content-Length framing is for LSP — Claude's MCP client never parses
 * it, which made WaitForMcpServers report "Failed to connect: browser".
 */
function send(
  msg: JsonRpcResponse | { jsonrpc: "2.0"; method: string; params?: unknown },
) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg: JsonRpcRequest) {
  const id = msg.id ?? null;
  const method = msg.method;
  const params = msg.params ?? {};

  // Notifications (no id) — ignore after init.
  if (msg.id === undefined && method.startsWith("notifications/")) {
    return;
  }

  try {
    if (method === "initialize") {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = (
        SUPPORTED_PROTOCOL_VERSIONS as readonly string[]
      ).includes(requested)
        ? requested
        : "2024-11-05";
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: "browser",
            version: "0.2.0",
            title: "AgentDesk built-in browser",
          },
          instructions:
            `MCP server "browser" is bound to chat session ${SESSION_ID || "?"} ` +
            `project ${PROJECT_CWD || "?"}. ` +
            `Tools drive the right-side in-app panel for THIS chat only. ` +
            `Start with browser_session_info or browser_open + browser_navigate. ` +
            `Store secrets with browser_store_token after browser_evaluate. ` +
            `Do not curl localhost or use external browsers.`,
        },
      });
      return;
    }

    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }

    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(name, args);
      send({ jsonrpc: "2.0", id, result });
      return;
    }

    // Common no-ops
    if (
      method === "resources/list" ||
      method === "prompts/list" ||
      method === "completion/complete"
    ) {
      send({
        jsonrpc: "2.0",
        id,
        result:
          method === "resources/list"
            ? { resources: [] }
            : method === "prompts/list"
              ? { prompts: [] }
              : { completion: { values: [] } },
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

// MCP stdio framing: newline-delimited JSON (not LSP Content-Length).
let buffer = Buffer.alloc(0);

function consumeNdjson(): void {
  while (true) {
    const nl = buffer.indexOf("\n");
    if (nl === -1) break;
    const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
    buffer = buffer.subarray(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as JsonRpcRequest;
      void handle(msg);
    } catch (err) {
      console.error("[browser-mcp-stdio] parse error", err);
    }
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  consumeNdjson();
});

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
