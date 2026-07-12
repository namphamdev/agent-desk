/**
 * Built-in browser MCP for Claude Code (and other ACP agents).
 *
 * Spawns a stdio MCP server that drives the **in-app** browser panel via the
 * localhost control plane — not a separate Playwright Chrome window.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import { buildAugmentedPath, resolveExecutable } from "./path-env";

/** Stable server name — tools show as mcp__browser__* / browser_*. */
export const BROWSER_MCP_SERVER_NAME = "browser";

export type BrowserMcpOptions = {
  enabled?: boolean;
  /** Local chat session id this agent session is bound to. */
  sessionId: string;
  /** Project cwd for this chat (token scoping + session_info). */
  projectCwd?: string;
  /** Control plane base URL (http://127.0.0.1:port). */
  controlUrl: string;
  /** Bearer token for the control plane. */
  controlToken: string;
  pathEnv?: string;
};

function resolveBunExecutable(pathEnv: string): string | null {
  return (
    resolveExecutable("bun", pathEnv) ??
    resolveExecutable("bun.exe", pathEnv)
  );
}

/** Locate browser-mcp-stdio.ts next to this module (dev + packaged copy). */
export function resolveBrowserMcpStdioScript(
  fromDir = dirname(fileURLToPath(import.meta.url)),
): string | null {
  const candidates = [
    join(fromDir, "browser-mcp-stdio.ts"),
    join(fromDir, "browser-mcp-stdio.js"),
    // Electrobun packaged resources (if copied)
    join(fromDir, "..", "browser-mcp-stdio.ts"),
    join(fromDir, "..", "app", "bun", "browser-mcp-stdio.ts"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Build the ACP mcpServers list for the in-app browser.
 * Returns [] when disabled, misconfigured, or bun/script cannot be resolved.
 */
export function buildBrowserMcpServers(
  options: BrowserMcpOptions,
): McpServer[] {
  if (options.enabled === false) return [];
  if (!options.sessionId || !options.controlUrl || !options.controlToken) {
    console.warn(
      "[browser-mcp] missing sessionId/controlUrl/token — in-app browser MCP disabled",
    );
    return [];
  }

  const pathEnv = options.pathEnv ?? buildAugmentedPath();
  const bun = resolveBunExecutable(pathEnv);
  if (!bun) {
    console.warn(
      "[browser-mcp] bun not found on PATH — in-app browser MCP disabled",
    );
    return [];
  }

  const script = resolveBrowserMcpStdioScript();
  if (!script) {
    console.warn(
      "[browser-mcp] browser-mcp-stdio.ts not found — in-app browser MCP disabled",
    );
    return [];
  }

  console.log(
    `[browser-mcp] in-app panel MCP for session ${options.sessionId.slice(0, 8)}… via ${script}`,
  );

  const env: Array<{ name: string; value: string }> = [
    { name: "PATH", value: pathEnv },
    { name: "TR_BROWSER_CONTROL_URL", value: options.controlUrl },
    { name: "TR_BROWSER_TOKEN", value: options.controlToken },
    { name: "TR_BROWSER_SESSION_ID", value: options.sessionId },
  ];
  if (options.projectCwd) {
    env.push({ name: "TR_PROJECT_CWD", value: options.projectCwd });
  }

  const server: McpServer = {
    name: BROWSER_MCP_SERVER_NAME,
    command: bun,
    args: [script],
    env,
  };

  return [server];
}
