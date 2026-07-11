/**
 * Project-scoped command panel: save shell commands per project folder,
 * spawn processes in that project cwd, capture logs.
 *
 * Saved commands live in `dataDir/project-commands.json`, keyed by project cwd.
 * Run logs are kept in memory (capped) and mirrored under `dataDir/command-logs/`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  CommandRunStatus,
  CommandRunSummary,
  SavedCommand,
} from "../shared/rpc";

const MAX_LOG_CHARS = 512_000;
const MAX_RUNS = 50;

export type CommandRunRecord = CommandRunSummary & {
  log: string;
  truncated: boolean;
};

/** On-disk shape: commands grouped by absolute project cwd. */
type PersistedStore = {
  byProject: Record<string, SavedCommand[]>;
};

type LiveProc = {
  kill: () => void;
};

/** Normalize project folder for stable map keys. */
export function normalizeProjectCwd(cwd: string): string {
  return resolve(cwd.trim());
}

/** Spawn a shell command; prefers Bun.spawn, falls back to node:child_process. */
function spawnShell(
  command: string,
  cwd: string,
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
  onExit: (code: number | null) => void,
): LiveProc {
  const isWin = process.platform === "win32";
  const file = isWin ? "cmd.exe" : "/bin/zsh";
  const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    const proc = Bun.spawn([file, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env },
    });
    void pumpBunStream(proc.stdout, onStdout);
    void pumpBunStream(proc.stderr, (t) => {
      if (!t) return;
      onStderr(t);
    });
    void (async () => {
      let code: number | null = null;
      try {
        code = await proc.exited;
      } catch {
        code = null;
      }
      onExit(typeof code === "number" ? code : null);
    })();
    return {
      kill: () => {
        try {
          proc.kill();
        } catch {
          /* already dead */
        }
      },
    };
  }

  const child = nodeSpawn(file, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => onStdout(d));
  child.stderr?.on("data", (d: string) => onStderr(d));
  child.on("error", (err) => {
    onStderr(`Failed to spawn: ${err.message}\n`);
    onExit(null);
  });
  child.on("close", (code) => onExit(code));
  return {
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    },
  };
}

async function pumpBunStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk: (text: string) => void,
) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } catch {
    /* stream closed */
  }
}

function storePath(dataDir: string): string {
  return join(dataDir, "project-commands.json");
}

function logsDir(dataDir: string): string {
  return join(dataDir, "command-logs");
}

function logFilePath(dataDir: string, runId: string): string {
  return join(logsDir(dataDir), `${runId}.log`);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDataDir(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
}

function parseCommand(c: unknown, projectCwd: string): SavedCommand | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Partial<SavedCommand>;
  if (
    typeof o.id !== "string" ||
    typeof o.name !== "string" ||
    typeof o.command !== "string"
  ) {
    return null;
  }
  return {
    id: o.id,
    name: o.name,
    command: o.command,
    projectCwd,
    createdAt:
      typeof o.createdAt === "number" && Number.isFinite(o.createdAt)
        ? o.createdAt
        : Date.now(),
  };
}

function loadStore(dataDir: string): PersistedStore {
  try {
    const raw = readFileSync(storePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedStore>;
    if (!parsed.byProject || typeof parsed.byProject !== "object") {
      return { byProject: {} };
    }
    const byProject: Record<string, SavedCommand[]> = {};
    for (const [key, list] of Object.entries(parsed.byProject)) {
      if (!Array.isArray(list)) continue;
      const projectCwd = normalizeProjectCwd(key);
      byProject[projectCwd] = list
        .map((c) => parseCommand(c, projectCwd))
        .filter((c): c is SavedCommand => c != null)
        .sort((a, b) => b.createdAt - a.createdAt);
    }
    return { byProject };
  } catch {
    return { byProject: {} };
  }
}

function saveStore(dataDir: string, store: PersistedStore): void {
  ensureDataDir(dataDir);
  writeFileSync(storePath(dataDir), JSON.stringify(store, null, 2));
}

export function loadCommands(
  dataDir: string,
  projectCwd: string,
): SavedCommand[] {
  const key = normalizeProjectCwd(projectCwd);
  return loadStore(dataDir).byProject[key] ?? [];
}

export function saveCommands(
  dataDir: string,
  projectCwd: string,
  commands: SavedCommand[],
): void {
  const key = normalizeProjectCwd(projectCwd);
  const store = loadStore(dataDir);
  if (commands.length === 0) {
    delete store.byProject[key];
  } else {
    store.byProject[key] = commands.map((c) => ({
      id: c.id,
      name: c.name,
      command: c.command,
      projectCwd: key,
      createdAt: c.createdAt,
    }));
  }
  saveStore(dataDir, store);
}

export function addCommand(
  dataDir: string,
  input: { name: string; command: string; projectCwd: string },
):
  | { ok: true; command: SavedCommand; commands: SavedCommand[] }
  | { ok: false; error: string } {
  const name = input.name?.trim() ?? "";
  const command = input.command?.trim() ?? "";
  const projectCwd = input.projectCwd?.trim() ?? "";
  if (!projectCwd) return { ok: false, error: "Project folder is required" };
  if (!name) return { ok: false, error: "Name is required" };
  if (!command) return { ok: false, error: "Command is required" };

  const key = normalizeProjectCwd(projectCwd);
  const entry: SavedCommand = {
    id: newId("cmd"),
    name,
    command,
    projectCwd: key,
    createdAt: Date.now(),
  };
  const commands = [entry, ...loadCommands(dataDir, key)];
  saveCommands(dataDir, key, commands);
  return { ok: true, command: entry, commands };
}

export function removeCommand(
  dataDir: string,
  projectCwd: string,
  commandId: string,
): { ok: true; commands: SavedCommand[] } | { ok: false; error: string } {
  const key = normalizeProjectCwd(projectCwd);
  const prev = loadCommands(dataDir, key);
  const next = prev.filter((c) => c.id !== commandId);
  if (next.length === prev.length) {
    return { ok: false, error: "Command not found" };
  }
  saveCommands(dataDir, key, next);
  return { ok: true, commands: next };
}

/**
 * In-memory run manager. One instance per app process.
 * Runs always record projectCwd; list can filter by project.
 */
export class CommandRunner {
  private runs = new Map<string, CommandRunRecord>();
  private live = new Map<string, LiveProc>();
  private order: string[] = [];

  constructor(private dataDir: string) {
    ensureDataDir(dataDir);
    mkdirSync(logsDir(dataDir), { recursive: true });
  }

  listRuns(projectCwd?: string | null): CommandRunSummary[] {
    const key = projectCwd?.trim()
      ? normalizeProjectCwd(projectCwd)
      : null;
    return this.order
      .map((id) => this.runs.get(id))
      .filter((r): r is CommandRunRecord => !!r)
      .filter((r) => (key ? r.projectCwd === key : true))
      .map((r) => this.toSummary(r));
  }

  getRun(runId: string): CommandRunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  getLog(
    runId: string,
  ):
    | { ok: true; run: CommandRunSummary; log: string; truncated: boolean }
    | { ok: false; error: string } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: "Run not found" };
    return {
      ok: true,
      run: this.toSummary(run),
      log: run.log,
      truncated: run.truncated,
    };
  }

  async start(
    saved: SavedCommand,
  ): Promise<
    { ok: true; run: CommandRunSummary } | { ok: false; error: string }
  > {
    const cwd = normalizeProjectCwd(saved.projectCwd);
    if (!existsSync(cwd)) {
      return { ok: false, error: `Project folder does not exist: ${cwd}` };
    }

    const runId = newId("run");
    const record: CommandRunRecord = {
      id: runId,
      commandId: saved.id,
      commandName: saved.name,
      command: saved.command,
      projectCwd: cwd,
      cwd,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      log: "",
      truncated: false,
    };

    this.runs.set(runId, record);
    this.order.unshift(runId);
    this.trimRuns();

    try {
      const live = spawnShell(
        saved.command,
        cwd,
        (text) => this.appendLog(runId, text),
        (text) => {
          const labeled = text
            .split("\n")
            .map((line, i, arr) =>
              line === "" && i === arr.length - 1
                ? ""
                : line
                  ? `[stderr] ${line}`
                  : line,
            )
            .join("\n");
          this.appendLog(runId, labeled);
        },
        (code) => this.onExit(runId, code),
      );
      this.live.set(runId, live);
      return { ok: true, run: this.toSummary(record) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.status = "error";
      record.endedAt = Date.now();
      this.appendLog(runId, `Failed to spawn: ${message}\n`);
      this.persistLog(runId);
      return { ok: false, error: message };
    }
  }

  stop(
    runId: string,
  ): { ok: true; run: CommandRunSummary } | { ok: false; error: string } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: "Run not found" };
    if (run.status !== "running") {
      return { ok: true, run: this.toSummary(run) };
    }
    const live = this.live.get(runId);
    if (live) {
      live.kill();
      this.live.delete(runId);
    }
    run.status = "killed";
    run.endedAt = Date.now();
    this.appendLog(runId, "\n[process killed]\n");
    this.persistLog(runId);
    return { ok: true, run: this.toSummary(run) };
  }

  private toSummary(r: CommandRunRecord): CommandRunSummary {
    return {
      id: r.id,
      commandId: r.commandId,
      commandName: r.commandName,
      command: r.command,
      projectCwd: r.projectCwd,
      cwd: r.cwd,
      status: r.status,
      exitCode: r.exitCode,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      logBytes: r.log.length,
    };
  }

  private appendLog(runId: string, chunk: string) {
    const run = this.runs.get(runId);
    if (!run || !chunk) return;
    let next = run.log + chunk;
    if (next.length > MAX_LOG_CHARS) {
      const keep = Math.floor(MAX_LOG_CHARS * 0.85);
      next = `…[log truncated]\n` + next.slice(next.length - keep);
      run.truncated = true;
    }
    run.log = next;
  }

  private persistLog(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    try {
      mkdirSync(logsDir(this.dataDir), { recursive: true });
      writeFileSync(logFilePath(this.dataDir, runId), run.log, "utf8");
    } catch (err) {
      console.warn("[user-commands] failed to write log:", err);
    }
  }

  private onExit(runId: string, code: number | null) {
    const run = this.runs.get(runId);
    if (!run) return;
    this.live.delete(runId);
    if (run.status === "killed") {
      this.persistLog(runId);
      return;
    }
    run.exitCode = code;
    run.status = "exited" as CommandRunStatus;
    this.appendLog(runId, `\n[exit ${code ?? "?"}]\n`);
    run.endedAt = Date.now();
    this.persistLog(runId);
  }

  private trimRuns() {
    while (this.order.length > MAX_RUNS) {
      const oldId = this.order.pop();
      if (!oldId) break;
      const live = this.live.get(oldId);
      if (live) {
        live.kill();
        this.live.delete(oldId);
      }
      this.runs.delete(oldId);
      try {
        rmSync(logFilePath(this.dataDir, oldId), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

let runner: CommandRunner | null = null;

export function getCommandRunner(dataDir: string): CommandRunner {
  if (!runner) runner = new CommandRunner(dataDir);
  return runner;
}

export function _resetCommandRunnerForTests() {
  runner = null;
}
