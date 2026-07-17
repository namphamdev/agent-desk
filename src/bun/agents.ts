/**
 * Agent discovery: read `~/.terminal-react/agents.json` (or the app data dir)
 * so users can point at ACP agent binaries (Claude Code adapter, Grok Build, …).
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

const CLAUDE_INSTALL_COMMAND =
  "npm i -g @agentclientprotocol/claude-agent-acp";
/** Official Grok Build install (Windows PowerShell). */
const GROK_INSTALL_COMMAND_WIN = "irm https://x.ai/cli/install.ps1 | iex";
/** Official Grok Build install (macOS / Linux / Git Bash). */
const GROK_INSTALL_COMMAND_UNIX =
  "curl -fsSL https://x.ai/cli/install.sh | bash";

export const DEFAULT_AGENTS: AgentsFile["agents"] = [
  {
    id: "claude-code",
    name: "Claude Code (ACP)",
    // Claude Code itself is not ACP-native; use the official adapter.
    // Install: npm i -g @agentclientprotocol/claude-agent-acp
    command: "claude-agent-acp",
    args: [],
  },
  {
    id: "grok-build",
    name: "Grok Build (ACP)",
    // Native ACP over stdio: https://docs.x.ai/build/cli/headless-scripting
    // Install: https://x.ai/cli — binary lives in ~/.grok/bin
    command: "grok",
    args: ["agent", "stdio"],
  },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function isClaudeAcpCommand(command: string): boolean {
  return (
    command === "claude-agent-acp" ||
    command.endsWith("/claude-agent-acp") ||
    command.endsWith("\\claude-agent-acp") ||
    command === "claude-code-acp" ||
    command.endsWith("/claude-code-acp") ||
    command.endsWith("\\claude-code-acp")
  );
}

function isGrokCommand(command: string, args: string[] = []): boolean {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  const name = base.replace(/\.exe$/i, "").toLowerCase();
  if (name !== "grok" && name !== "xai-grok-pager") return false;
  // Bare `grok` may be the TUI; ACP needs `agent stdio`.
  if (args.length === 0) return true;
  return args[0] === "agent" && (args[1] === "stdio" || args.length === 1);
}

function grokInstallCommand(): string {
  return process.platform === "win32"
    ? GROK_INSTALL_COMMAND_WIN
    : GROK_INSTALL_COMMAND_UNIX;
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
 * ACP agent binaries (Claude Code adapter and Grok Build).
 */
export async function ensureAgentsConfig(): Promise<void> {
  const file = Bun.file(AGENTS_PATH);
  if (await file.exists()) return;
  await Bun.write(
    AGENTS_PATH,
    JSON.stringify(
      {
        defaultAgentId: "claude-code",
        agents: DEFAULT_AGENTS,
      },
      null,
      2,
    ),
  );
  console.log(`[agents] wrote starter config at ${AGENTS_PATH}`);
}

/**
 * If agents.json exists but lacks Grok Build, append it (idempotent).
 * Does not change defaultAgentId.
 */
export async function ensureGrokAgentEntry(): Promise<boolean> {
  const file = Bun.file(AGENTS_PATH);
  if (!(await file.exists())) return false;

  let raw: AgentsFile;
  try {
    raw = (await file.json()) as AgentsFile;
  } catch {
    return false;
  }

  const list = Array.isArray(raw.agents) ? [...raw.agents] : [];
  const hasGrok = list.some(
    (a) =>
      a?.id === "grok-build" ||
      (a?.command && isGrokCommand(a.command, a.args ?? [])),
  );
  if (hasGrok) return false;

  const grok = DEFAULT_AGENTS.find((a) => a.id === "grok-build")!;
  list.push({ ...grok, args: [...(grok.args ?? [])] });
  raw.agents = list;
  await Bun.write(AGENTS_PATH, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`[agents] added grok-build to ${AGENTS_PATH}`);
  return true;
}

/**
 * Diagnose Claude Code / Grok / ACP agent setup for the Settings UI.
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

  // Prefer path from a configured agent that targets the Claude ACP adapter.
  const acpFromConfig = entries.find(
    (e) => e.ok && isClaudeAcpCommand(e.command),
  );
  const claudeAcpPath =
    acpFromConfig?.resolvedPath ??
    resolveExecutable("claude-agent-acp") ??
    resolveExecutable("claude-code-acp");
  const claudeCliPath = resolveExecutable("claude");

  const grokFromConfig = entries.find(
    (e) => e.ok && isGrokCommand(e.command, e.args),
  );
  const grokPath =
    grokFromConfig?.resolvedPath ?? resolveExecutable("grok");

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
    installCommand: CLAUDE_INSTALL_COMMAND,
    grokOk: grokPath != null,
    grokPath,
    grokInstallCommand: grokInstallCommand(),
  };
}

/** Ensure starter agents.json exists (with Grok entry), then return diagnostics. */
export async function ensureAgentSetup(): Promise<AgentSetupStatus> {
  await ensureAgentsConfig();
  await ensureGrokAgentEntry();
  return getAgentSetupStatus();
}
