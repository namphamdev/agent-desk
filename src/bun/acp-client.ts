/**
 * ACP agent lifecycle: spawn subprocess, initialize, open sessions, stream
 * session/update notifications, handle permissions.
 *
 * Uses `@agentclientprotocol/sdk` under Bun.
 */
import { spawn, type Subprocess } from "bun";
import { buildAugmentedPath, resolveExecutable } from "./path-env";
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
import type { AgentInfo, SessionConfigOption, SessionUsage } from "../shared/rpc";
import {
  mergeSessionModesIntoConfigOptions,
  translateAvailableCommands,
  translateConfigOptions,
  translateSessionUpdate,
  translateUsageUpdate,
  withModeCurrentValue,
} from "./translate";
import type { SessionUpdate } from "../session/types";
import { buildBrowserMcpServers } from "./browser-mcp";

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
  onUsage?: (sessionId: string, usage: SessionUsage) => void;
  onTurnEnd?: (sessionId: string, stopReason: string) => void;
  onError?: (error: unknown) => void;
  onPermission: PermissionHandler;
  enableFs?: boolean;
  /** Inject in-app browser MCP on session/new (default false if omitted). */
  enableBrowserMcp?: boolean;
  /**
   * Localhost control plane for the built-in browser panel.
   * Required when enableBrowserMcp is true.
   */
  browserControl?: {
    url: string;
    token: string;
  };
};

/** Optional spawn / session overrides (e.g. provider credentials for Claude Code). */
export type AcpClientOptions = {
  /**
   * Extra env vars merged over `process.env` when spawning the agent.
   * Used for ANTHROPIC_BASE_URL / API_KEY / model mappings from Providers.
   */
  env?: Record<string, string | undefined>;
  /**
   * Passed as `session/new` `_meta` (e.g. `_meta.claudeCode.options.env`).
   * claude-agent-acp applies `options.env` when starting the SDK query so
   * credentials survive past ~/.claude/settings.json loading.
   */
  sessionMeta?: Record<string, unknown>;
};

export type AcpSessionHandle = {
  sessionId: string;
  /** Initial config options from session/new (model, thought_level, …). */
  configOptions: SessionConfigOption[];
  /**
   * Start draining `session/update` notifications for this session.
   * Call only after the agent session id is mapped to a local session id
   * so early updates (e.g. `available_commands_update`) route correctly.
   */
  beginUpdates: () => void;
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
  private options: AcpClientOptions;
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private connection: ClientConnection | null = null;
  private ctx: ClientContext | null = null;
  private active: ActiveSession | null = null;
  private disposed = false;
  private alwaysAllow = new Set<string>();
  /**
   * True when the active session's mode select was synthesized from
   * session/new `modes` (must use session/set_mode, not set_config_option).
   */
  private modeViaSetMode = false;
  /** Latest config options for the active session (keeps mode UI in sync). */
  private activeConfigOptions: SessionConfigOption[] = [];
  /** Bumped to cancel the background `nextUpdate` pump. */
  private pumpToken = 0;
  /** In-flight prompt resolved when the pump sees a `stop` message. */
  private pendingPrompt: {
    resolve: (value: { stopReason: string }) => void;
    reject: (error: unknown) => void;
  } | null = null;

  constructor(
    agent: AgentInfo,
    handlers: AcpClientHandlers,
    options: AcpClientOptions = {},
  ) {
    this.agent = agent;
    this.handlers = handlers;
    this.options = options;
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
    // Merge provider credentials / model maps over the host environment.
    // Explicit undefined values are omitted so we never blank a parent var
    // unintentionally; buildProviderEnv only sets defined strings.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (this.options.env) {
      for (const [k, v] of Object.entries(this.options.env)) {
        if (v !== undefined) env[k] = v;
      }
    }
    // Packaged GUI apps start with a minimal PATH; include Homebrew/npm/bun.
    env.PATH = buildAugmentedPath(env.PATH);

    const resolved = resolveExecutable(this.agent.command, env.PATH);
    if (!resolved) {
      throw new Error(
        `Executable not found in $PATH: "${this.agent.command}". ` +
          `Install it (e.g. npm i -g @agentclientprotocol/claude-agent-acp) ` +
          `or set an absolute path in ~/.terminal-react/agents.json. ` +
          `GUI apps may not see shell PATH — common bins (Homebrew, bun, npm) are auto-added.`,
      );
    }
    if (resolved !== this.agent.command) {
      console.log(`[acp] resolved "${this.agent.command}" → ${resolved}`);
    }

    this.proc = spawn({
      cmd: [resolved, ...this.agent.args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
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

  async openSession(
    cwd: string,
    opts?: { localSessionId?: string },
  ): Promise<AcpSessionHandle> {
    if (!this.ctx) throw new Error("not connected");

    // Stop prior pump + session routing before opening a new one.
    this.stopUpdatePump();
    try {
      this.active?.dispose();
    } catch {
      /* ignore */
    }
    this.active = null;

    const localSessionId = opts?.localSessionId;
    const ctrl = this.handlers.browserControl;
    const mcpServers =
      this.handlers.enableBrowserMcp && localSessionId && ctrl
        ? buildBrowserMcpServers({
            enabled: true,
            sessionId: localSessionId,
            projectCwd: cwd,
            controlUrl: ctrl.url,
            controlToken: ctrl.token,
          })
        : [];
    if (mcpServers.length > 0) {
      console.log(
        `[acp] registered MCP: ${mcpServers.map((s) => s.name).join(", ")} ` +
          `→ chat ${localSessionId?.slice(0, 8)}… cwd=${cwd}`,
      );
    } else if (this.handlers.enableBrowserMcp) {
      console.warn(
        "[acp] browser MCP NOT registered " +
          `(sessionId=${localSessionId ? "ok" : "missing"}, ` +
          `control=${ctrl ? "ok" : "missing"})`,
      );
    }

    // Always pass session meta when present so ENABLE_TOOL_SEARCH stays off and
    // system prompt documents the browser MCP — even if mcpServers is empty.
    const session = await this.ctx
      .buildSession({
        cwd,
        mcpServers,
        ...(this.options.sessionMeta
          ? { _meta: this.options.sessionMeta }
          : {}),
      })
      .start();
    this.active = session;

    // Note: do not fire onConfigOptions/onMode here — the agent session id is
    // not mapped to a local id until SessionManager.ensureHandle registers it.
    // Callers apply configOptions from the returned handle, then beginUpdates().
    const fromConfig = translateConfigOptions(
      session.newSessionResponse.configOptions,
    );
    const modes =
      session.modes ?? session.newSessionResponse.modes ?? null;
    const hadModeInConfig = fromConfig.some(
      (o) =>
        o.type === "select" &&
        (o.category === "mode" || o.id === "mode"),
    );
    const configOptions = mergeSessionModesIntoConfigOptions(fromConfig, modes);
    // Claude Code ACP often only exposes permission modes via SessionModeState.
    this.modeViaSetMode = !hadModeInConfig && !!modes?.availableModes?.length;
    this.activeConfigOptions = configOptions;

    let updatesStarted = false;

    return {
      sessionId: session.sessionId,
      configOptions,
      beginUpdates: () => {
        if (updatesStarted || this.active !== session || this.disposed) return;
        updatesStarted = true;
        this.startUpdatePump(session);
      },
      prompt: (text) => this.promptLive(session, text),
      cancel: () => this.cancelLive(session.sessionId),
      setConfigOption: (configId, value) =>
        this.setConfigOptionLive(session.sessionId, configId, value),
      dispose: () => {
        this.stopUpdatePump();
        try {
          session.dispose();
        } catch {
          /* ignore */
        }
        if (this.active === session) this.active = null;
        this.modeViaSetMode = false;
        this.activeConfigOptions = [];
      },
    };
  }

  /**
   * Continuously drain `ActiveSession.nextUpdate()` so pre-prompt notifications
   * (especially `available_commands_update`) reach the UI as soon as the agent
   * sends them — not only after the first prompt turn.
   */
  private startUpdatePump(session: ActiveSession) {
    const token = ++this.pumpToken;
    void this.pumpUpdates(session, token);
  }

  private stopUpdatePump() {
    this.pumpToken++;
    const pending = this.pendingPrompt;
    this.pendingPrompt = null;
    if (pending) {
      // Session was switched/offloaded/disposed while a prompt was open.
      // Resolve as cancelled so callers don't surface a fake connection error.
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  private async pumpUpdates(session: ActiveSession, token: number) {
    while (
      this.pumpToken === token &&
      this.active === session &&
      !this.disposed
    ) {
      try {
        const message = await session.nextUpdate();
        if (this.pumpToken !== token || this.active !== session) return;

        if (message.kind === "stop") {
          const stopReason = message.stopReason;
          this.handlers.onTurnEnd?.(session.sessionId, stopReason);
          const pending = this.pendingPrompt;
          this.pendingPrompt = null;
          pending?.resolve({ stopReason });
          continue;
        }

        this.dispatchWire(
          session.sessionId,
          message.update,
          message.notification,
        );
      } catch (err) {
        if (this.pumpToken !== token || this.active !== session || this.disposed) {
          return;
        }
        const pending = this.pendingPrompt;
        this.pendingPrompt = null;
        pending?.reject(err);
        this.handlers.onError?.(err);
        return;
      }
    }
  }

  private async setConfigOptionLive(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<SessionConfigOption[]> {
    if (!this.ctx) throw new Error("not connected");

    // Synthesized Permission mode from session/new `modes` → session/set_mode.
    if (
      this.modeViaSetMode &&
      (configId === "mode" || configId === "permission") &&
      typeof value === "string"
    ) {
      await this.ctx.request(acp.methods.agent.session.setMode, {
        sessionId,
        modeId: value,
      });
      const configOptions = withModeCurrentValue(
        this.activeConfigOptions,
        value,
      );
      this.activeConfigOptions = configOptions;
      this.handlers.onMode?.(sessionId, value);
      this.handlers.onConfigOptions?.(sessionId, configOptions);
      return configOptions;
    }

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
    let configOptions = translateConfigOptions(
      result.configOptions as Parameters<typeof translateConfigOptions>[0],
    );
    // Preserve synthesized mode option if agent response omits it.
    if (this.modeViaSetMode) {
      const modeOpt = this.activeConfigOptions.find(
        (o) => o.type === "select" && (o.category === "mode" || o.id === "mode"),
      );
      if (
        modeOpt &&
        modeOpt.type === "select" &&
        !configOptions.some(
          (o) =>
            o.type === "select" &&
            (o.category === "mode" || o.id === "mode"),
        )
      ) {
        configOptions = [...configOptions, modeOpt];
      }
    }
    this.activeConfigOptions = configOptions;
    this.handlers.onConfigOptions?.(sessionId, configOptions);
    return configOptions;
  }

  private async promptLive(
    session: ActiveSession,
    text: string,
  ): Promise<{ stopReason: string }> {
    if (this.active !== session) {
      throw new Error("session is not active");
    }
    if (this.pendingPrompt) {
      throw new Error("a prompt is already in progress");
    }

    // The background pump owns nextUpdate(); resolve when it sees `stop`.
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.pendingPrompt = { resolve, reject };
      void session.prompt(text).catch((err) => {
        if (this.pendingPrompt?.reject === reject) {
          this.pendingPrompt = null;
          reject(err);
        }
      });
    });
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
      let configOptions = translateConfigOptions(update.configOptions);
      // Keep synthesized Permission mode if agent updates other options only.
      if (this.modeViaSetMode) {
        const modeOpt = this.activeConfigOptions.find(
          (o) =>
            o.type === "select" &&
            (o.category === "mode" || o.id === "mode"),
        );
        if (
          modeOpt &&
          modeOpt.type === "select" &&
          !configOptions.some(
            (o) =>
              o.type === "select" &&
              (o.category === "mode" || o.id === "mode"),
          )
        ) {
          configOptions = [...configOptions, modeOpt];
        }
      }
      this.activeConfigOptions = configOptions;
      this.handlers.onConfigOptions?.(sessionId, configOptions);
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      const usage = translateUsageUpdate(update);
      if (usage) this.handlers.onUsage?.(sessionId, usage);
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      const modeId = update.currentModeId;
      this.handlers.onMode?.(sessionId, modeId);
      // Keep Permission selector in sync when the agent switches modes.
      const configOptions = withModeCurrentValue(
        this.activeConfigOptions,
        modeId,
      );
      if (configOptions !== this.activeConfigOptions) {
        this.activeConfigOptions = configOptions;
        this.handlers.onConfigOptions?.(sessionId, configOptions);
      }
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
    this.stopUpdatePump();
    try {
      this.active?.dispose();
    } catch {
      /* ignore */
    }
    this.active = null;
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
export async function sampleProcessTreeRssBytes(rootPid: number): Promise<number | null> {
  const pids = await collectDescendantPids(rootPid, 64);
  if (pids.length === 0) return null;

  if (process.platform === "win32") {
    // Get-Process emits WorkingSet64 (bytes). SilentlyContinue so a pid that
    // exited between the tree walk and this sample doesn't fail the whole call.
    const proc = spawn({
      cmd: [
        "powershell",
        "-NoProfile",
        "-Command",
        `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum`,
      ],
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const bytes = Number.parseInt(out.trim(), 10);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  }

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

export async function collectDescendantPids(
  rootPid: number,
  maxPids: number,
): Promise<number[]> {
  const result: number[] = [rootPid];
  const queue: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  const onWindows = process.platform === "win32";

  while (queue.length > 0 && result.length < maxPids) {
    const parent = queue.shift()!;
    // Windows has no pgrep/ps; use CIM via PowerShell. macOS/Linux use pgrep -P.
    const proc = onWindows
      ? spawn({
          cmd: [
            "powershell",
            "-NoProfile",
            "-Command",
            `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId`,
          ],
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
        })
      : spawn({
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
