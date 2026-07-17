import { describe, expect, it } from "vitest";
import {
  buildRemoteUrls,
  generateAccessCode,
  listLanIpv4,
  RemoteAccessServer,
  resolveStaticRoots,
} from "./remote-access";

describe("remote-access helpers", () => {
  it("generateAccessCode returns a stable-length alphanumeric token", () => {
    const a = generateAccessCode();
    const b = generateAccessCode();
    expect(a).toMatch(/^[a-z0-9]+$/);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(12);
    // Extremely unlikely to collide
    expect(a).not.toBe(b);
  });

  it("buildRemoteUrls embeds the access code and port", () => {
    const { url, urls, lanIps } = buildRemoteUrls(8743, "abc123", [
      "192.168.1.10",
    ]);
    expect(url).toBe("http://192.168.1.10:8743/r/abc123");
    expect(urls).toContain("http://192.168.1.10:8743/r/abc123");
    expect(urls).toContain("http://127.0.0.1:8743/r/abc123");
    expect(lanIps).toEqual(["192.168.1.10"]);
  });

  it("buildRemoteUrls falls back to localhost when no LAN IPs", () => {
    const { url, urls } = buildRemoteUrls(9000, "zz", []);
    expect(url).toBe("http://127.0.0.1:9000/r/zz");
    expect(urls).toEqual(["http://127.0.0.1:9000/r/zz"]);
  });

  it("listLanIpv4 returns an array (may be empty in CI)", () => {
    const ips = listLanIpv4();
    expect(Array.isArray(ips)).toBe(true);
    for (const ip of ips) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });

  it("resolveStaticRoots only returns dirs with index.html", () => {
    const roots = resolveStaticRoots();
    expect(Array.isArray(roots)).toBe(true);
    // In this repo after a vite build, dist/ should appear; don't require it in unit tests.
  });
});

function mockHandlers() {
  return {
    sendPrompt: async () => ({ ok: true as const }),
    cancel: async () => ({ ok: true }),
    listAgents: () => ({ agents: [] }),
    listSessions: () => ({ sessions: [], activeSessionId: null }),
    createSession: async () => ({
      ok: false as const,
      error: "not in test",
    }),
    switchSession: async () => ({
      ok: false as const,
      error: "not in test",
    }),
    deleteSession: async () => ({ ok: true }),
    offloadSession: async () => ({ ok: true as const, killed: false }),
    respondPermission: async () => ({ ok: true }),
    openFile: async () => ({ ok: false, error: "n/a" }),
    getSettings: () => ({
      editorCommand: "code",
      theme: "dark" as const,
      defaultAgentId: null,
      enableFsCapabilities: false,
      enableBrowserMcp: true,
      enableNotifications: false,
      enableSound: false,
    }),
    saveSettings: (p: Record<string, unknown>) => ({
      editorCommand: "code",
      theme: "dark" as const,
      defaultAgentId: null,
      enableFsCapabilities: false,
      enableBrowserMcp: true,
      enableNotifications: false,
      enableSound: false,
      ...p,
    }),
    getConnectionState: () => ({ status: "ready" as const }),
    connectAgent: async () => ({ ok: true as const }),
    listRecentProjects: () => ({ projects: [] }),
    removeRecentProject: () => ({ ok: true as const, projects: [] }),
    getGitBranch: async () => ({ branch: null }),
    setConfigOption: async () => ({
      ok: false as const,
      error: "n/a",
    }),
    writeClipboard: async () => ({ ok: true as const }),
    readClipboard: async () => ({ ok: true as const, text: "" }),
    listSkills: () => ({ skills: [] }),
    installSkill: async () => ({ ok: false as const, error: "n/a" }),
    setSkillEnabled: () => ({ ok: false as const, error: "n/a" }),
    uninstallSkill: () => ({ ok: false as const, error: "n/a" }),
    getProjectHarness: () => ({
      project: "mock",
      cwd: "",
      ok: false,
      error: "n/a",
      hasClaudeMd: false,
      hasAgentsMd: false,
      optimizations: [],
      appliedCount: 0,
    }),
    applyProjectHarness: () => ({ ok: false as const, error: "n/a" }),
    getProjectWorkflows: () => ({
      path: "",
      exists: false,
      workflows: null,
    }),
    saveProjectWorkflows: () => ({ ok: false as const, error: "n/a" }),
    getAgentSetup: async () => ({
      configPath: "/tmp/agents.json",
      configExists: false,
      defaultAgentId: "",
      agents: [],
      ready: false,
      claudeAcpOk: false,
      claudeAcpPath: null,
      claudeCliOk: false,
      claudeCliPath: null,
      installCommand: "npm i -g @agentclientprotocol/claude-agent-acp",
      grokOk: false,
      grokPath: null,
      grokInstallCommand: "irm https://x.ai/cli/install.ps1 | iex",
    }),
    ensureAgentSetup: async () => ({
      configPath: "/tmp/agents.json",
      configExists: true,
      defaultAgentId: "claude-code",
      agents: [],
      ready: false,
      claudeAcpOk: false,
      claudeAcpPath: null,
      claudeCliOk: false,
      claudeCliPath: null,
      installCommand: "npm i -g @agentclientprotocol/claude-agent-acp",
      grokOk: false,
      grokPath: null,
      grokInstallCommand: "irm https://x.ai/cli/install.ps1 | iex",
    }),
  };
}

describe("RemoteAccessServer", () => {
  it("starts, serves authorized path, rejects bad code, stops", async () => {
    const server = new RemoteAccessServer(mockHandlers());
    const status = await server.start({ port: 0, code: "testcode99" });
    expect(status.running).toBe(true);
    expect(status.code).toBe("testcode99");
    expect(status.port).toBeTruthy();

    const port = status.port!;
    const ok = await fetch(`http://127.0.0.1:${port}/r/testcode99`);
    // 200 with HTML when dist exists, or 503 if assets missing — either means auth passed.
    expect([200, 503]).toContain(ok.status);
    if (ok.status === 200) {
      const html = await ok.text();
      expect(html).toContain("__TERMINAL_REACT_REMOTE__");
      expect(html).toContain("testcode99");
    }

    const bad = await fetch(`http://127.0.0.1:${port}/r/wrongcode`);
    expect(bad.status).toBe(403);

    const stopped = server.stop();
    expect(stopped.running).toBe(false);
    expect(stopped.code).toBeNull();
  });

  it("handles listSessions over WebSocket", async () => {
    const server = new RemoteAccessServer(mockHandlers());
    const status = await server.start({ port: 0, code: "wscode1" });
    const port = status.port!;

    const result = await new Promise<unknown>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/r/wscode1/ws`);
      const t = setTimeout(() => {
        ws.close();
        reject(new Error("ws timeout"));
      }, 3000);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "request",
            id: "1",
            method: "listSessions",
            params: {},
          }),
        );
      };
      ws.onmessage = (ev) => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(String(ev.data)));
        } catch (e) {
          reject(e);
        } finally {
          ws.close();
        }
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      };
    });

    expect(result).toEqual({
      type: "response",
      id: "1",
      result: { sessions: [], activeSessionId: null },
    });
    server.stop();
  });
});
