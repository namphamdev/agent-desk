/**
 * ACP agent lifecycle: spawn subprocess, initialize, open sessions, stream
 * session/update notifications, handle permissions.
 *
 * Uses `@agentclientprotocol/sdk` under Bun.
 */
import { spawn, type Subprocess } from "bun";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ActiveSession,
  ClientConnection,
  ClientContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate as WireUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentInfo } from "../shared/rpc";
import {
  translateAvailableCommands,
  translateConfigOptions,
  translateSessionUpdate,
} from "./translate";
import type { SessionUpdate } from "../session/types";
import type { SessionConfigOption } from "../shared/rpc";

export type PermissionHandler = (
  req: RequestPermissionRequest & { requestId: string },
) => Promise<RequestPermissionResponse>;

export type AcpClientHandlers = {
  onUpdate: (sessionId: string, update: SessionUpdate) => void;
  onWireUpdate?: (sessionId: string, update: WireUpdate) => void;
  onCommands?: (
    sessionId: string,
    commands: Array<{ name: string; description?: string; input?: { hint?: string } }>,
  ) => void;
  onMode?: (sessionId: string, mode: string) => void;
  onConfigOptions?: (sessionId: string, configOptions: SessionConfigOption[]) => void;
  onTurnEnd?: (sessionId: string, stopReason: string) => void;
  onError?: (error: unknown) => void;
  onPermission: PermissionHandler;
  enableFs?: boolean;
};

export type AcpSessionHandle = {
  sessionId: string;
  /** Initial config options from session/new (model, thought_level, …). */
  configOptions: SessionConfigOption[];
  prompt: (text: string) => Promise<{ stopReason: string }>;
  cancel: () => Promise<void>;
  setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Promise<SessionConfigOption[]>;
  dispose: () => void;
};

export class AcpClient {
  private agent: AgentInfo;
  private handlers: AcpClientHandlers;
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private connection: ClientConnection | null = null;
  private ctx: ClientContext | null = null;
  private active: ActiveSession | null = null;
  private disposed = false;
  private alwaysAllow = new Set<string>();

  constructor(agent: AgentInfo, handlers: AcpClientHandlers) {
    this.agent = agent;
    this.handlers = handlers;
  }

  /** OS pid of the spawned agent process, if still running. */
  getPid(): number | null {
    const proc = this.proc;
    if (!proc || this.disposed) return null;
    // Bun sets exitCode once the process has exited.
    if (proc.exitCode != null) return null;
    return proc.pid ?? null;
  }

  /**
   * Current resident memory of the agent process tree (bytes).
   * Uses `ps` because Bun's resourceUsage() is only available after exit.
   * Includes direct descendants — Claude Code / other ACPs often spawn workers.
   */
  async sampleMemoryRssBytes(): Promise<number | null> {
    const pid = this.getPid();
    if (pid == null) return null;
    try {
      return await sampleProcessTreeRssBytes(pid);
    } catch (err) {
      console.warn("[acp] memory sample failed:", err);
      return null;
    }
  }

  async connect(): Promise<void> {
    this.proc = spawn({
      cmd: [this.agent.command, ...this.agent.args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    // Pipe stderr so agent noise doesn't crash us.
    const stderr = this.proc.stderr;
    if (stderr) {
      (async () => {
        const reader = stderr.getReader();
        const dec = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = dec.decode(value);
            if (text.trim()) console.error(`[agent:${this.agent.id}]`, text.trimEnd());
          }
        } catch {
          /* process ended */
        }
      })();
    }

    // Bridge Bun's FileSink / ReadableStream to web streams for the SDK.
    const stdin = this.proc.stdin;
    if (!stdin) throw new Error("agent stdin not available");

    // Bun Subprocess stdin is a FileSink; use node stream adapters when possible.
    // Prefer writing via FileSink through a WritableStream.
    const output = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        stdin.write(chunk);
      },
      close: async () => {
        try {
          stdin.end();
        } catch {
          /* ignore */
        }
      },
    });

    const stdout = this.proc.stdout;
    if (!stdout) throw new Error("agent stdout not available");
    const input = stdout as ReadableStream<Uint8Array>;

    const stream = acp.ndJsonStream(output, input);
    const self = this;

    const app = acp
      .client({ name: "terminal-react" })
      .onRequest(acp.methods.client.session.requestPermission, async (c) => {
        return self.handlePermission(c.params);
      });

    if (this.handlers.enableFs) {
      app
        .onRequest(acp.methods.client.fs.readTextFile, async (c) => {
          try {
            const file = Bun.file(c.params.path);
            const content = await file.text();
            return { content };
          } catch (err) {
            throw new Error(
              `read failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })
        .onRequest(acp.methods.client.fs.writeTextFile, async (c) => {
          try {
            await Bun.write(c.params.path, c.params.content);
            return {};
          } catch (err) {
            throw new Error(
              `write failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
    }

    // Keep the connection open for the lifetime of this client.
    this.connection = app.connect(stream);
    this.ctx = this.connection.agent;

    const initResult = await this.ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: !!this.handlers.enableFs,
          writeTextFile: !!this.handlers.enableFs,
        },
        // Advertise support so agents may include boolean config options and
        // so we can drive model/thought_level selectors from configOptions.
        session: {
          configOptions: {
            boolean: {},
          },
        },
      },
      clientInfo: {
        name: "terminal-react",
        version: "0.1.0",
      },
    });

    console.log(
      `[acp] connected to ${this.agent.name} (protocol v${initResult.protocolVersion})`,
    );
  }

  async openSession(cwd: string): Promise<AcpSessionHandle> {
    if (!this.ctx) throw new Error("not connected");

    // Dispose previous active session routing if any.
    this.active?.dispose();

    const session = await this.ctx
      .buildSession({ cwd, mcpServers: [] })
      .start();
    this.active = session;

    // Note: do not fire onConfigOptions/onMode here — the agent session id is
    // not mapped to a local id until SessionManager.ensureHandle registers it.
    // Callers apply configOptions from the returned handle.
    const configOptions = translateConfigOptions(
      session.newSessionResponse.configOptions,
    );

    return {
      sessionId: session.sessionId,
      configOptions,
      prompt: (text) => this.promptLive(session, text),
      cancel: () => this.cancelLive(session.sessionId),
      setConfigOption: (configId, value) =>
        this.setConfigOptionLive(session.sessionId, configId, value),
      dispose: () => {
        session.dispose();
        if (this.active === session) this.active = null;
      },
    };
  }

  private async setConfigOptionLive(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<SessionConfigOption[]> {
    if (!this.ctx) throw new Error("not connected");
    const params =
      typeof value === "boolean"
        ? {
            sessionId,
            configId,
            type: "boolean" as const,
            value,
          }
        : {
            sessionId,
            configId,
            value,
          };
    const result = await this.ctx.request<
      { configOptions: Array<Record<string, unknown>> },
      typeof params
    >(acp.methods.agent.session.setConfigOption, params);
    const configOptions = translateConfigOptions(
      result.configOptions as Parameters<typeof translateConfigOptions>[0],
    );
    this.handlers.onConfigOptions?.(sessionId, configOptions);
    return configOptions;
  }

  private async promptLive(
    session: ActiveSession,
    text: string,
  ): Promise<{ stopReason: string }> {
    // Fire prompt without awaiting fully — drain nextUpdate in parallel.
    const promptPromise = session.prompt(text);

    // Drain updates until stop.
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === "stop") {
        const stopReason = message.stopReason;
        this.handlers.onTurnEnd?.(session.sessionId, stopReason);
        // Ensure the prompt promise settles.
        await promptPromise.catch(() => undefined);
        return { stopReason };
      }
      this.dispatchWire(session.sessionId, message.update, message.notification);
    }
  }

  private dispatchWire(
    sessionId: string,
    update: WireUpdate,
    _notification?: SessionNotification,
  ) {
    this.handlers.onWireUpdate?.(sessionId, update);

    if (update.sessionUpdate === "available_commands_update") {
      const commands = translateAvailableCommands(update);
      this.handlers.onCommands?.(sessionId, commands);
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      const configOptions = translateConfigOptions(update.configOptions);
      this.handlers.onConfigOptions?.(sessionId, configOptions);
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      this.handlers.onMode?.(sessionId, update.currentModeId);
    }

    const local = translateSessionUpdate(update);
    if (local) this.handlers.onUpdate(sessionId, local);
  }

  private async cancelLive(sessionId: string): Promise<void> {
    if (!this.ctx) return;
    try {
      await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    } catch (err) {
      console.warn("[acp] cancel failed:", err);
    }
  }

  private async handlePermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const kind = params.toolCall?.kind;
    if (kind && this.alwaysAllow.has(kind)) {
      const always = params.options.find((o) => o.kind === "allow_always");
      const once = params.options.find((o) => o.kind === "allow_once");
      const pick = always ?? once;
      if (pick) {
        return {
          outcome: { outcome: "selected", optionId: pick.optionId },
        };
      }
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await this.handlers.onPermission({
      ...params,
      requestId,
    });

    // Track allow_always choices.
    if (response.outcome.outcome === "selected" && kind) {
      const selectedId = response.outcome.optionId;
      const opt = params.options.find((o) => o.optionId === selectedId);
      if (opt?.kind === "allow_always") this.alwaysAllow.add(kind);
    }

    return response;
  }

  rememberAlways(kind: string) {
    this.alwaysAllow.add(kind);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.active?.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.connection?.close();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Sum RSS for `rootPid` and its descendant processes (KB from `ps` → bytes).
 * Caps the walk so a pathological process tree can't hang the poll loop.
 */
async function sampleProcessTreeRssBytes(rootPid: number): Promise<number | null> {
  const pids = await collectDescendantPids(rootPid, 64);
  if (pids.length === 0) return null;

  // `ps -o rss=` prints one RSS (kilobytes) per pid, space/newline separated.
  const proc = spawn({
    cmd: ["ps", "-o", "rss=", "-p", pids.join(",")],
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  let totalKb = 0;
  let sawAny = false;
  for (const token of out.trim().split(/\s+/)) {
    if (!token) continue;
    const kb = Number.parseInt(token, 10);
    if (!Number.isFinite(kb) || kb < 0) continue;
    totalKb += kb;
    sawAny = true;
  }
  return sawAny ? totalKb * 1024 : null;
}

async function collectDescendantPids(
  rootPid: number,
  maxPids: number,
): Promise<number[]> {
  const result: number[] = [rootPid];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);

  while (queue.length > 0 && result.length < maxPids) {
    const parent = queue.shift()!;
    // Prefer pgrep -P (children of parent). Available on macOS + most Linux.
    const proc = spawn({
      cmd: ["pgrep", "-P", String(parent)],
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const token of out.trim().split(/\s+/)) {
      if (!token) continue;
      const child = Number.parseInt(token, 10);
      if (!Number.isFinite(child) || seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      queue.push(child);
      if (result.length >= maxPids) break;
    }
  }

  return result;
}

// Silence unused import warnings when node stream adapters aren't needed.
void Readable;
void Writable;
