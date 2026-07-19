import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  agentsConfigDir,
  agentsConfigPath,
  compareVersions,
  DEFAULT_AGENTS,
  ensureAgentsConfig,
  getAgentSetupStatus,
  loadAgents,
  parseVersionToken,
} from "./agents";

describe("agents", () => {
  it("parseVersionToken extracts semver from CLI output", () => {
    expect(parseVersionToken("0.57.0")).toBe("0.57.0");
    expect(parseVersionToken("grok 0.2.103 (abc) [stable]")).toBe("0.2.103");
    expect(parseVersionToken("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseVersionToken("no version here")).toBeNull();
  });

  it("compareVersions orders dotted versions", () => {
    expect(compareVersions("0.57.0", "0.59.0")).toBeLessThan(0);
    expect(compareVersions("0.59.0", "0.57.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.103", "0.2.103")).toBe(0);
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
  });

  it("DEFAULT_AGENTS includes Claude and Grok Build entries", () => {
    const ids = DEFAULT_AGENTS.map((a) => a.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("grok-build");
    const grok = DEFAULT_AGENTS.find((a) => a.id === "grok-build")!;
    expect(grok.command).toBe("grok");
    expect(grok.args).toEqual(["agent", "stdio"]);
  });
  it("exposes config path under the home data dir", () => {
    expect(agentsConfigPath()).toBe(join(agentsConfigDir(), "agents.json"));
    expect(agentsConfigDir()).toContain(".terminal-react");
  });

  it("loadAgents returns agents from config when present", async () => {
    const { agents, defaultAgentId } = await loadAgents();
    expect(Array.isArray(agents)).toBe(true);
    if (agents.length > 0) {
      expect(agents.some((a) => a.id === defaultAgentId)).toBe(true);
    }
  });

  it("ensureAgentsConfig is idempotent when a config already exists", async () => {
    await ensureAgentsConfig();
    const before = await Bun.file(agentsConfigPath()).text();
    await ensureAgentsConfig();
    const after = await Bun.file(agentsConfigPath()).text();
    expect(after).toBe(before);

    const parsed = JSON.parse(after) as {
      defaultAgentId?: string;
      agents?: Array<{ id?: string; name: string; command: string }>;
    };
    expect(parsed.agents?.length).toBeGreaterThanOrEqual(1);
  });

  it("getAgentSetupStatus reports config path and agent resolution", async () => {
    await ensureAgentsConfig();
    const status = await getAgentSetupStatus();
    expect(status.configPath).toBe(agentsConfigPath());
    expect(status.configExists).toBe(true);
    expect(status.installCommand).toContain("claude-agent-acp");
    expect(status.grokInstallCommand.length).toBeGreaterThan(0);
    expect(Array.isArray(status.agents)).toBe(true);
    // Each entry has ok + resolvedPath fields (may or may not resolve on CI).
    for (const a of status.agents) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.command).toBe("string");
      expect(typeof a.ok).toBe("boolean");
      if (a.ok) expect(a.resolvedPath).toBeTruthy();
      else expect(a.resolvedPath).toBeNull();
    }
    expect(typeof status.claudeAcpOk).toBe("boolean");
    expect(typeof status.grokOk).toBe("boolean");
    expect(typeof status.ready).toBe("boolean");
  });
});

describe("agents config parsing (isolated tmp home)", () => {
  const scratch = join(tmpdir(), `tr-agents-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(scratch, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function parseAgentsFile(raw: {
    agents?: Array<{
      id?: string;
      name?: string;
      command?: string;
      args?: string[];
    }>;
    defaultAgentId?: string;
  }) {
    const agents: Array<{
      id: string;
      name: string;
      command: string;
      args: string[];
    }> = [];
    let defaultAgentId = "";
    for (const a of raw.agents ?? []) {
      if (!a?.name || !a?.command) continue;
      const id =
        a.id ||
        a.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40);
      agents.push({
        id,
        name: a.name,
        command: a.command,
        args: a.args ?? [],
      });
    }
    if (raw.defaultAgentId && agents.some((x) => x.id === raw.defaultAgentId)) {
      defaultAgentId = raw.defaultAgentId;
    } else if (agents.length > 0) {
      defaultAgentId = agents[0]!.id;
    }
    return { agents, defaultAgentId };
  }

  it("skips incomplete agent entries and slugifies missing ids", () => {
    const { agents, defaultAgentId } = parseAgentsFile({
      agents: [
        { name: "Claude Code", command: "claude-code", args: ["--acp"] },
        { name: "Broken" },
        { id: "codex", name: "Codex", command: "codex" },
      ],
    });
    expect(agents.map((a) => a.id)).toEqual(["claude-code", "codex"]);
    expect(defaultAgentId).toBe("claude-code");
  });

  it("honors an explicit defaultAgentId when present", () => {
    const { defaultAgentId } = parseAgentsFile({
      defaultAgentId: "codex",
      agents: [
        { id: "claude", name: "Claude", command: "claude" },
        { id: "codex", name: "Codex", command: "codex" },
      ],
    });
    expect(defaultAgentId).toBe("codex");
  });

  it("falls back to empty default when no agents", () => {
    const { defaultAgentId } = parseAgentsFile({
      defaultAgentId: "nope",
      agents: [],
    });
    expect(defaultAgentId).toBe("");
  });

  it("can write and read a JSON agents file from disk", async () => {
    const path = join(scratch, "agents.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultAgentId: "x",
        agents: [{ id: "x", name: "X", command: "x" }],
      }),
    );
    expect(existsSync(path)).toBe(true);
    const parsed = (await Bun.file(path).json()) as {
      agents: Array<{ id: string }>;
    };
    expect(parsed.agents[0]!.id).toBe("x");
  });
});