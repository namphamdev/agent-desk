/**
 * Agent discovery: read `~/.terminal-react/agents.json` (or the app data dir)
 * so users can point at ACP agent binaries (Claude Code adapter, Grok Build,
 * Factory Droid, …).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentInfo,
  AgentPackageId,
  AgentPackageUpdateResult,
  AgentPackageUpdateStatus,
  AgentSetupStatus,
} from "../shared/rpc";
import { resolveExecutable, buildAugmentedPath } from "./path-env";

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

const CLAUDE_ACP_NPM_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_INSTALL_COMMAND = `npm i -g ${CLAUDE_ACP_NPM_PACKAGE}`;
/** Official Grok Build install (Windows PowerShell). */
const GROK_INSTALL_COMMAND_WIN = "irm https://x.ai/cli/install.ps1 | iex";
/** Official Grok Build install (macOS / Linux / Git Bash). */
const GROK_INSTALL_COMMAND_UNIX =
  "curl -fsSL https://x.ai/cli/install.sh | bash";
/** Official Factory Droid install (Windows PowerShell). */
const DROID_INSTALL_COMMAND_WIN =
  "irm https://app.factory.ai/cli/windows | iex";
/** Official Factory Droid install (macOS / Linux). */
const DROID_INSTALL_COMMAND_UNIX =
  "curl -fsSL https://app.factory.ai/cli | sh";
/** npm package when Droid was installed via npm (auto-update unavailable). */
const DROID_NPM_PACKAGE = "@factory/cli";

const CMD_TIMEOUT_MS = 120_000;

async function runCmd(
  argv: string[],
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeoutMs = opts?.timeoutMs ?? CMD_TIMEOUT_MS;
  const proc = Bun.spawn(argv, {
    cwd: homedir(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      PATH: buildAugmentedPath(process.env.PATH),
      CI: "1",
      npm_config_yes: "true",
    },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return {
        stdout,
        stderr: (stderr || stdout || "timed out").trim() || "timed out",
        exitCode: exitCode === 0 ? 124 : exitCode,
      };
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/** First semver-looking token in a version command's output. */
export function parseVersionToken(raw: string): string | null {
  const m = raw.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return m?.[1] ?? null;
}

/** Compare dotted versions; returns negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/)[0]!
      .split(".")
      .map((p) => parseInt(p.replace(/\D/g, ""), 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

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
  {
    id: "factory-droid",
    name: "Factory Droid (ACP)",
    // Native ACP: https://docs.factory.ai/integrations/zed
    // Install: https://app.factory.ai/cli — often ~/bin or ~/.local/bin
    command: "droid",
    args: ["exec", "--output-format", "acp"],
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

function isDroidCommand(command: string, args: string[] = []): boolean {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  const name = base.replace(/\.exe$/i, "").toLowerCase();
  if (name !== "droid") return false;
  // Bare `droid` is the TUI; ACP needs `exec --output-format acp`.
  if (args.length === 0) return true;
  if (args[0] !== "exec") return false;
  const fmtIdx = args.findIndex(
    (a) => a === "--output-format" || a === "-o",
  );
  if (fmtIdx >= 0 && args[fmtIdx + 1] === "acp") return true;
  // Still treat as Droid agent entry even if format flag is incomplete.
  return true;
}

function grokInstallCommand(): string {
  return process.platform === "win32"
    ? GROK_INSTALL_COMMAND_WIN
    : GROK_INSTALL_COMMAND_UNIX;
}

function droidInstallCommand(): string {
  return process.platform === "win32"
    ? DROID_INSTALL_COMMAND_WIN
    : DROID_INSTALL_COMMAND_UNIX;
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
 * ACP agent binaries (Claude Code adapter, Grok Build, Factory Droid).
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
 * Append a missing default agent entry (idempotent). Does not change defaultAgentId.
 */
async function ensureDefaultAgentEntry(
  agentId: "grok-build" | "factory-droid",
  isMatch: (command: string, args: string[]) => boolean,
): Promise<boolean> {
  const file = Bun.file(AGENTS_PATH);
  if (!(await file.exists())) return false;

  let raw: AgentsFile;
  try {
    raw = (await file.json()) as AgentsFile;
  } catch {
    return false;
  }

  const list = Array.isArray(raw.agents) ? [...raw.agents] : [];
  const has = list.some(
    (a) =>
      a?.id === agentId ||
      (a?.command && isMatch(a.command, a.args ?? [])),
  );
  if (has) return false;

  const entry = DEFAULT_AGENTS.find((a) => a.id === agentId)!;
  list.push({ ...entry, args: [...(entry.args ?? [])] });
  raw.agents = list;
  await Bun.write(AGENTS_PATH, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`[agents] added ${agentId} to ${AGENTS_PATH}`);
  return true;
}

/**
 * If agents.json exists but lacks Grok Build, append it (idempotent).
 * Does not change defaultAgentId.
 */
export async function ensureGrokAgentEntry(): Promise<boolean> {
  return ensureDefaultAgentEntry("grok-build", isGrokCommand);
}

/**
 * If agents.json exists but lacks Factory Droid, append it (idempotent).
 * Does not change defaultAgentId.
 */
export async function ensureDroidAgentEntry(): Promise<boolean> {
  return ensureDefaultAgentEntry("factory-droid", isDroidCommand);
}

/**
 * Diagnose Claude Code / Grok / Droid ACP agent setup for the Settings UI.
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

  const droidFromConfig = entries.find(
    (e) => e.ok && isDroidCommand(e.command, e.args),
  );
  const droidPath =
    droidFromConfig?.resolvedPath ?? resolveExecutable("droid");

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
    droidOk: droidPath != null,
    droidPath,
    droidInstallCommand: droidInstallCommand(),
  };
}

/** Ensure starter agents.json exists (with Grok + Droid entries), then return diagnostics. */
export async function ensureAgentSetup(): Promise<AgentSetupStatus> {
  await ensureAgentsConfig();
  await ensureGrokAgentEntry();
  await ensureDroidAgentEntry();
  return getAgentSetupStatus();
}

async function resolveClaudeAcpPath(): Promise<string | null> {
  const status = await getAgentSetupStatus();
  return status.claudeAcpPath;
}

async function resolveGrokPath(): Promise<string | null> {
  const status = await getAgentSetupStatus();
  return status.grokPath;
}

async function resolveDroidPath(): Promise<string | null> {
  const status = await getAgentSetupStatus();
  return status.droidPath;
}

async function checkClaudePackageUpdate(): Promise<AgentPackageUpdateStatus> {
  const base: AgentPackageUpdateStatus = {
    package: "claude",
    installed: false,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
  };

  const path = await resolveClaudeAcpPath();
  if (!path) {
    return {
      ...base,
      error: "claude-agent-acp not found on PATH",
    };
  }
  base.installed = true;

  const versionCmd = await runCmd([path, "--version"], { timeoutMs: 15_000 });
  const current =
    parseVersionToken(versionCmd.stdout) ??
    parseVersionToken(versionCmd.stderr);
  base.currentVersion = current;

  const npm = resolveExecutable("npm");
  if (!npm) {
    return {
      ...base,
      error: "npm not found on PATH (needed to check latest version)",
    };
  }

  const latestCmd = await runCmd(
    [npm, "view", CLAUDE_ACP_NPM_PACKAGE, "version"],
    { timeoutMs: 30_000 },
  );
  if (latestCmd.exitCode !== 0) {
    const detail = (latestCmd.stderr || latestCmd.stdout).trim();
    return {
      ...base,
      error: detail.slice(0, 400) || "npm view failed",
    };
  }
  const latest =
    parseVersionToken(latestCmd.stdout) ??
    (latestCmd.stdout.trim() || null);
  base.latestVersion = latest;

  if (current && latest) {
    base.updateAvailable = compareVersions(current, latest) < 0;
  } else if (!current && latest) {
    base.updateAvailable = true;
  }

  return base;
}

async function checkGrokPackageUpdate(): Promise<AgentPackageUpdateStatus> {
  const base: AgentPackageUpdateStatus = {
    package: "grok",
    installed: false,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
  };

  const path = await resolveGrokPath();
  if (!path) {
    return {
      ...base,
      error: "grok not found on PATH",
    };
  }
  base.installed = true;

  const check = await runCmd([path, "update", "--check", "--json"], {
    timeoutMs: 45_000,
  });
  const text = (check.stdout || check.stderr).trim();
  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < jsonStart) {
      throw new Error("no JSON in grok update --check output");
    }
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      currentVersion?: string;
      latestVersion?: string;
      updateAvailable?: boolean;
      error?: string | null;
    };
    base.currentVersion = parsed.currentVersion
      ? parseVersionToken(parsed.currentVersion) ?? parsed.currentVersion
      : null;
    base.latestVersion = parsed.latestVersion
      ? parseVersionToken(parsed.latestVersion) ?? parsed.latestVersion
      : null;
    base.updateAvailable = Boolean(parsed.updateAvailable);
    if (parsed.error) {
      base.error = String(parsed.error);
    }
    return base;
  } catch {
    // Fall back to --version + leave latest unknown.
    const ver = await runCmd([path, "--version"], { timeoutMs: 15_000 });
    base.currentVersion =
      parseVersionToken(ver.stdout) ?? parseVersionToken(ver.stderr);
    if (check.exitCode !== 0) {
      base.error =
        (check.stderr || check.stdout || "grok update --check failed")
          .trim()
          .slice(0, 400) || "grok update --check failed";
    } else {
      base.error = "Could not parse grok update --check output";
    }
    return base;
  }
}

async function checkDroidPackageUpdate(): Promise<AgentPackageUpdateStatus> {
  const base: AgentPackageUpdateStatus = {
    package: "droid",
    installed: false,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
  };

  const path = await resolveDroidPath();
  if (!path) {
    return {
      ...base,
      error: "droid not found on PATH",
    };
  }
  base.installed = true;

  const ver = await runCmd([path, "--version"], { timeoutMs: 15_000 });
  base.currentVersion =
    parseVersionToken(ver.stdout) ?? parseVersionToken(ver.stderr);

  const check = await runCmd([path, "update", "--check"], {
    timeoutMs: 45_000,
  });
  const text = (check.stdout || check.stderr).trim();

  // Official SEA installer reports structured availability; npm installs print a hint.
  if (/not available for npm/i.test(text) || /npm update -g/i.test(text)) {
    const npm = resolveExecutable("npm");
    if (!npm) {
      return {
        ...base,
        error:
          text.slice(0, 400) ||
          "npm Droid install: npm not found to check latest version",
      };
    }
    const latestCmd = await runCmd(
      [npm, "view", DROID_NPM_PACKAGE, "version"],
      { timeoutMs: 30_000 },
    );
    if (latestCmd.exitCode !== 0) {
      const detail = (latestCmd.stderr || latestCmd.stdout).trim();
      return {
        ...base,
        error:
          detail.slice(0, 400) ||
          text.slice(0, 400) ||
          "npm view @factory/cli failed",
      };
    }
    const latest =
      parseVersionToken(latestCmd.stdout) ??
      (latestCmd.stdout.trim() || null);
    base.latestVersion = latest;
    if (base.currentVersion && latest) {
      base.updateAvailable = compareVersions(base.currentVersion, latest) < 0;
    } else if (!base.currentVersion && latest) {
      base.updateAvailable = true;
    }
    return base;
  }

  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
        currentVersion?: string;
        latestVersion?: string;
        updateAvailable?: boolean;
        error?: string | null;
      };
      if (parsed.currentVersion) {
        base.currentVersion =
          parseVersionToken(parsed.currentVersion) ?? parsed.currentVersion;
      }
      base.latestVersion = parsed.latestVersion
        ? parseVersionToken(parsed.latestVersion) ?? parsed.latestVersion
        : null;
      base.updateAvailable = Boolean(parsed.updateAvailable);
      if (parsed.error) base.error = String(parsed.error);
      return base;
    }
  } catch {
    /* fall through */
  }

  // Plain text: "Update available: 0.1.0 → 0.2.0" or "Already up to date"
  const arrow = text.match(
    /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*(?:→|->)\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/,
  );
  if (arrow) {
    base.currentVersion = arrow[1] ?? base.currentVersion;
    base.latestVersion = arrow[2] ?? null;
    if (base.currentVersion && base.latestVersion) {
      base.updateAvailable =
        compareVersions(base.currentVersion, base.latestVersion) < 0;
    }
    return base;
  }

  if (/up to date|already latest|no update/i.test(text)) {
    base.latestVersion = base.currentVersion;
    base.updateAvailable = false;
    return base;
  }

  if (/update available/i.test(text)) {
    base.updateAvailable = true;
  }

  if (check.exitCode !== 0 && !base.updateAvailable) {
    base.error =
      text.slice(0, 400) || "droid update --check failed";
  }

  return base;
}

/** Check whether Claude ACP adapter, Grok, or Droid CLI has a newer release. */
export async function checkAgentPackageUpdate(
  pkg: AgentPackageId,
): Promise<AgentPackageUpdateStatus> {
  if (pkg === "claude") return checkClaudePackageUpdate();
  if (pkg === "grok") return checkGrokPackageUpdate();
  if (pkg === "droid") return checkDroidPackageUpdate();
  return {
    package: pkg,
    installed: false,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    error: `Unknown package: ${pkg}`,
  };
}

async function updateClaudePackage(): Promise<AgentPackageUpdateResult> {
  const npm = resolveExecutable("npm");
  if (!npm) {
    return {
      ok: false,
      package: "claude",
      error: "npm not found on PATH",
    };
  }

  const result = await runCmd(
    [npm, "i", "-g", CLAUDE_ACP_NPM_PACKAGE],
    { timeoutMs: 180_000 },
  );
  const status = await checkClaudePackageUpdate();
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      package: "claude",
      error: detail.slice(0, 800) || `npm install failed (exit ${result.exitCode})`,
      status,
    };
  }
  return {
    ok: true,
    package: "claude",
    message: status.currentVersion
      ? `Updated to ${status.currentVersion}`
      : "Updated claude-agent-acp",
    status,
  };
}

async function updateGrokPackage(): Promise<AgentPackageUpdateResult> {
  const path = await resolveGrokPath();
  if (!path) {
    return {
      ok: false,
      package: "grok",
      error: "grok not found on PATH — install Grok Build first",
    };
  }

  const result = await runCmd([path, "update"], { timeoutMs: 180_000 });
  const status = await checkGrokPackageUpdate();
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      package: "grok",
      error: detail.slice(0, 800) || `grok update failed (exit ${result.exitCode})`,
      status,
    };
  }
  return {
    ok: true,
    package: "grok",
    message: status.currentVersion
      ? `Updated to ${status.currentVersion}`
      : "Updated grok",
    status,
  };
}

async function updateDroidPackage(): Promise<AgentPackageUpdateResult> {
  const path = await resolveDroidPath();
  if (!path) {
    return {
      ok: false,
      package: "droid",
      error: "droid not found on PATH — install Factory Droid CLI first",
    };
  }

  // Prefer SEA self-update; fall back to npm when the binary says so.
  const check = await runCmd([path, "update", "--check"], {
    timeoutMs: 45_000,
  });
  const checkText = (check.stdout || check.stderr).trim();
  const npmInstall = /not available for npm/i.test(checkText) ||
    /npm update -g/i.test(checkText);

  if (npmInstall) {
    const npm = resolveExecutable("npm");
    if (!npm) {
      return {
        ok: false,
        package: "droid",
        error:
          "npm not found on PATH (Droid was installed via npm; need npm to update)",
      };
    }
    const result = await runCmd(
      [npm, "i", "-g", DROID_NPM_PACKAGE],
      { timeoutMs: 180_000 },
    );
    const status = await checkDroidPackageUpdate();
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      return {
        ok: false,
        package: "droid",
        error:
          detail.slice(0, 800) ||
          `npm install ${DROID_NPM_PACKAGE} failed (exit ${result.exitCode})`,
        status,
      };
    }
    return {
      ok: true,
      package: "droid",
      message: status.currentVersion
        ? `Updated to ${status.currentVersion}`
        : "Updated droid",
      status,
    };
  }

  const result = await runCmd([path, "update"], { timeoutMs: 180_000 });
  const status = await checkDroidPackageUpdate();
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      package: "droid",
      error:
        detail.slice(0, 800) ||
        `droid update failed (exit ${result.exitCode})`,
      status,
    };
  }
  return {
    ok: true,
    package: "droid",
    message: status.currentVersion
      ? `Updated to ${status.currentVersion}`
      : "Updated droid",
    status,
  };
}

/** Install or update Claude ACP adapter, Grok, or Droid CLI. */
export async function updateAgentPackage(
  pkg: AgentPackageId,
): Promise<AgentPackageUpdateResult> {
  if (pkg === "claude") return updateClaudePackage();
  if (pkg === "grok") return updateGrokPackage();
  if (pkg === "droid") return updateDroidPackage();
  return {
    ok: false,
    package: pkg,
    error: `Unknown package: ${pkg}`,
  };
}
