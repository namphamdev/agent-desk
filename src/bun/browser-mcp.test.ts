import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  BROWSER_MCP_SERVER_NAME,
  buildBrowserMcpServers,
  resolveBrowserMcpStdioScript,
} from "./browser-mcp";
import { buildAugmentedPath, resolveExecutable } from "./path-env";

describe("resolveBrowserMcpStdioScript", () => {
  it("finds the stdio MCP script next to this module", () => {
    const script = resolveBrowserMcpStdioScript();
    expect(script).toBeTruthy();
    expect(existsSync(script!)).toBe(true);
  });
});

describe("buildBrowserMcpServers", () => {
  it("returns empty list when disabled", () => {
    expect(
      buildBrowserMcpServers({
        enabled: false,
        sessionId: "s1",
        controlUrl: "http://127.0.0.1:9",
        controlToken: "t",
      }),
    ).toEqual([]);
  });

  it("returns empty list when session/control missing", () => {
    expect(
      buildBrowserMcpServers({
        enabled: true,
        sessionId: "",
        controlUrl: "",
        controlToken: "",
      }),
    ).toEqual([]);
  });

  it("builds stdio MCP pointing at in-app control plane", () => {
    const pathEnv = buildAugmentedPath();
    const bun = resolveExecutable("bun", pathEnv);
    if (!bun) return;

    const servers = buildBrowserMcpServers({
      enabled: true,
      sessionId: "session-abc",
      projectCwd: "/tmp/project",
      controlUrl: "http://127.0.0.1:12345",
      controlToken: "secret-token",
      pathEnv,
    });
    expect(servers).toHaveLength(1);
    const server = servers[0]!;
    expect(server).toMatchObject({
      name: BROWSER_MCP_SERVER_NAME,
      command: bun,
    });
    expect("type" in server).toBe(false);
    if (!("args" in server)) throw new Error("expected stdio server");
    expect(server.args.some((a) => a.includes("browser-mcp-stdio"))).toBe(true);
    expect(server.env).toEqual(
      expect.arrayContaining([
        { name: "TR_BROWSER_CONTROL_URL", value: "http://127.0.0.1:12345" },
        { name: "TR_BROWSER_TOKEN", value: "secret-token" },
        { name: "TR_BROWSER_SESSION_ID", value: "session-abc" },
        { name: "TR_PROJECT_CWD", value: "/tmp/project" },
      ]),
    );
    // Must not use Playwright package anymore.
    expect(server.args.join(" ")).not.toContain("@playwright/mcp");
  });
});
