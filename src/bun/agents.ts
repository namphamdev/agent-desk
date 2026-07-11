/**
 * Agent discovery: read `~/.terminal-react/agents.json` (or the app data dir)
 * so users can point at their own Claude Code (ACP) binary.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentInfo, AgentSetupStatus } from "../shared/rpc";
import { resolveExecutable } from "./path-env";

export type AgentsFile = {
  agents: Array<{
    id?: string;
    name: string;
    command: string;
    args?: string[];
  }>;
  defaultAgentId?: string;
};

const CONFIG_DIR = join(homedir(), ".terminal-react");
const AGENTS_PATH = join(CONFIG_DIR, "agents.json");

const INSTALL_COMMAND = "npm i -g @agentclientprotocol/claude-agent-acp";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export async function loadAgents(): Promise<{
  agents: AgentInfo[];
  defaultAgentId: string;
}> {
  const agents: AgentInfo[] = [];
  let defaultAgentId = "";

  try {
    const file = Bun.file(AGENTS_PATH);
    if (await file.exists()) {
      const raw = (await file.json()) as AgentsFile;
      for (const a of raw.agents ?? []) {
        if (!a?.name || !a?.command) continue;
        const id = a.id || slugify(a.name);
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
    }
  } catch (err) {
    console.warn("[agents] failed to read agents.json:", err);
  }

  return { agents, defaultAgentId };
}

export function agentsConfigPath(): string {
  return AGENTS_PATH;
}

export function agentsConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Write a starter agents.json if none exists, so users know where to put
 * their Claude Code (ACP) binary.
 */
export async function ensureAgentsConfig(): Promise<void> {
  const file = Bun.file(AGENTS_PATH);
  if (await file.exists()) return;
  await Bun.write(
    AGENTS_PATH,
    JSON.stringify(
      {
        defaultAgentId: "claude-code",
        agents: [
          {
            id: "claude-code",
            name: "Claude Code (ACP)",
            // Claude Code itself is not ACP-native; use the official adapter.
            // Install: npm i -g @agentclientprotocol/claude-agent-acp
            command: "claude-agent-acp",
            args: [],
          },
        ],
      },
      null,
      2,
    ),
  );
  console.log(`[agents] wrote starter config at ${AGENTS_PATH}`);
}

/**
 * Diagnose Claude Code / ACP agent setup for the Settings UI.
 * Resolves each agents.json command against the augmented PATH used for spawn.
 */
export async function getAgentSetupStatus(): Promise<AgentSetupStatus> {
  const configExists = existsSync(AGENTS_PATH);
  const { agents, defaultAgentId } = await loadAgents();

  const entries = agents.map((a) => {
    const resolvedPath = resolveExecutable(a.command);
    return {
      id: a.id,
      name: a.name,
      command: a.command,
      args: a.args,
      resolvedPath,
      ok: resolvedPath != null,
    };
  });

  // Prefer path from a configured agent that targets the ACP adapter.
  const acpFromConfig = entries.find(
    (e) =>
      e.ok &&
      (e.command === "claude-agent-acp" ||
        e.command.endsWith("/claude-agent-acp") ||
        e.command.endsWith("\\claude-agent-acp") ||
        e.command === "claude-code-acp"),
  );
  const claudeAcpPath =
    acpFromConfig?.resolvedPath ??
    resolveExecutable("claude-agent-acp") ??
    resolveExecutable("claude-code-acp");
  const claudeCliPath = resolveExecutable("claude");

  const ready = configExists && entries.some((e) => e.ok);

  return {
    configPath: AGENTS_PATH,
    configExists,
    defaultAgentId,
    agents: entries,
    ready,
    claudeAcpOk: claudeAcpPath != null,
    claudeAcpPath,
    claudeCliOk: claudeCliPath != null,
    claudeCliPath,
    installCommand: INSTALL_COMMAND,
  };
}

/** Ensure starter agents.json exists, then return fresh diagnostics. */
export async function ensureAgentSetup(): Promise<AgentSetupStatus> {
  await ensureAgentsConfig();
  return getAgentSetupStatus();
}