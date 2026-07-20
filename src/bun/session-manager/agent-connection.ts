/**
 * ACP agent process lifecycle: one client process per chat session.
 * Connect, open session handles, memory polling for the active chat.
 */
import type {
  AgentInfo,
  AppSettings,
  AvailableCommand,
  ConnectionStatePayload,
  SessionConfigOption,
  SessionUsage,
} from "../../shared/rpc";
import {
  AcpClient,
  type AcpSessionHandle,
} from "../acp-client";
import {
  buildClaudeCodeSessionMeta,
  buildProviderEnv,
  normalizeModelAlias,
  providerConnectionKey,
  resolveActiveProvider,
  withBrowserMcpAlwaysLoaded,
} from "../providers";
import {
  buildGrokProviderEnv,
  ensureGrokConfigForProvider,
  GROK_PROVIDER_MODEL_ID,
  isGrokStyleAgent,
} from "../grok-config";
import type { SessionStore } from "../store";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { applyPreferredConfigDefaults } from "./config-options";
import type { LiveSession, SessionManagerEvents } from "./types";

/** Claude Code ACP adapter (and aliases). Other agents skip Anthropic provider env/meta. */
function isClaudeStyleAgent(agent: Pick<AgentInfo, "id" | "command" | "name">): boolean {
  const id = agent.id.toLowerCase();
  if (id === "claude-code" || id === "claude" || id.startsWith("claude-")) {
    return true;
  }
  const cmd = agent.command.replace(/\\/g, "/").split("/").pop() ?? agent.command;
  const base = cmd.replace(/\.exe$/i, "").toLowerCase();
  return (
    base === "claude-agent-acp" ||
    base === "claude-code-acp" ||
    base === "claude"
  );
}

function isGrokYoloMode(defaultPermissionMode: string | undefined): boolean {
  const mode = (defaultPermissionMode ?? "").trim().toLowerCase();
  return (
    mode === "bypasspermissions" ||
    mode === "always-approve" ||
    mode === "always_approve" ||
    mode === "yolo" ||
    mode === "auto"
  );
}

/**
 * Insert CLI flags after `agent` for Grok Build ACP spawn:
 * `grok agent [--always-approve] [--effort LEVEL] stdio`
 */
export function withGrokAgentSpawnArgs(
  agent: AgentInfo,
  opts: {
    defaultPermissionMode?: string;
    defaultEffort?: string;
    /** Catalog model id (e.g. agent-desk) → `grok agent -m <id> stdio`. */
    modelId?: string;
  },
): AgentInfo {
  if (!isGrokStyleAgent(agent)) return agent;
  const args = [...(agent.args ?? [])];
  const agentIdx = args.findIndex((a) => a === "agent");
  const insertAt = agentIdx >= 0 ? agentIdx + 1 : 0;

  const flags: string[] = [];

  const modelId = opts.modelId?.trim();
  const hasModelFlag = args.includes("-m") || args.includes("--model");
  if (modelId && !hasModelFlag) {
    flags.push("-m", modelId);
  }

  if (
    isGrokYoloMode(opts.defaultPermissionMode) &&
    !args.includes("--always-approve")
  ) {
    flags.push("--always-approve");
  }

  const effort = normalizeGrokEffort(opts.defaultEffort);
  const hasEffortFlag =
    args.includes("--effort") || args.includes("--reasoning-effort");
  if (effort && !hasEffortFlag) {
    flags.push("--effort", effort);
  }

  if (flags.length === 0) return agent;
  args.splice(insertAt, 0, ...flags);
  return { ...agent, args };
}

/** @deprecated Use {@link withGrokAgentSpawnArgs}. */
export function withGrokAlwaysApproveArgs(
  agent: AgentInfo,
  defaultPermissionMode: string | undefined,
): AgentInfo {
  return withGrokAgentSpawnArgs(agent, { defaultPermissionMode });
}

function normalizeGrokEffort(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const v = raw.trim().toLowerCase();
  if (v === "max") return "xhigh";
  if (v === "extra high" || v === "extra-high") return "xhigh";
  if (
    v === "minimal" ||
    v === "low" ||
    v === "medium" ||
    v === "high" ||
    v === "xhigh"
  ) {
    return v;
  }
  return null;
}

/** Mode id for Grok session/set_mode / synthetic Permission dropdown. */
function grokInitialModeId(
  defaultPermissionMode: string | undefined,
): string {
  const raw = (defaultPermissionMode ?? "default").trim() || "default";
  const lower = raw.toLowerCase();
  if (isGrokYoloMode(raw)) return "bypassPermissions";
  if (lower === "acceptedits" || lower === "accept_edits") return "acceptEdits";
  if (lower === "plan") return "plan";
  if (lower === "default") return "default";
  return raw;
}

export type AgentConnectionHost = {
  settings: AppSettings;
  store: SessionStore;
  live: Map<string, LiveSession>;
  events: SessionManagerEvents;
  activeSessionId: string | null;
  queuePermission: (
    params: RequestPermissionRequest & { requestId: string },
  ) => Promise<RequestPermissionResponse>;
  queueUserQuestion: (
    params: import("../user-question").GrokAskUserQuestionParsed & {
      requestId: string;
    },
  ) => Promise<import("../user-question").GrokAskUserQuestionResponse>;
  /** Built-in browser control plane (in-app panel MCP). */
  getBrowserControl?: () => { url: string; token: string } | null;
  /** Reset idle-offload clock when the agent is active for a chat. */
  touchAgentActivity?: (sessionId: string) => void;
  now?: () => number;
};

function idleConnection(sessionId?: string | null): ConnectionStatePayload {
  return sessionId
    ? { status: "idle", sessionId }
    : { status: "idle" };
}

function mergeConnection(
  prev: ConnectionStatePayload,
  state: ConnectionStatePayload,
): ConnectionStatePayload {
  const next: ConnectionStatePayload = {
    ...state,
    memoryRssBytes:
      state.memoryRssBytes !== undefined
        ? state.memoryRssBytes
        : prev.memoryRssBytes,
    memorySampledAt:
      state.memorySampledAt !== undefined
        ? state.memorySampledAt
        : prev.memorySampledAt,
  };
  if (
    next.status === "idle" ||
    next.status === "disconnected" ||
    next.status === "error" ||
    next.status === "connecting"
  ) {
    if (state.memoryRssBytes === undefined) {
      next.memoryRssBytes = null;
      next.memorySampledAt = null;
    }
  }
  return next;
}

export class AgentConnection {
  /**
   * ACP agent session id → local chat id (permissions / update routing).
   * Multiple agent processes may be live; ids are unique per openSession.
   */
  agentToLocal = new Map<string, string>();

  private memoryPollTimer: ReturnType<typeof setInterval> | null = null;
  private memoryPollInFlight = false;
  private host: AgentConnectionHost;

  constructor(host: AgentConnectionHost) {
    this.host = host;
  }

  /** Connection payload for a chat (or idle if unknown). */
  getSessionConnection(sessionId: string | null | undefined): ConnectionStatePayload {
    if (!sessionId) return { status: "idle" };
    return this.host.live.get(sessionId)?.connection ?? idleConnection(sessionId);
  }

  /** UI connection state for the currently viewed chat. */
  getActiveConnection(): ConnectionStatePayload {
    return this.getSessionConnection(this.host.activeSessionId);
  }

  /**
   * Update a session's connection snapshot. Always emits for sessionActivity
   * tracking; the webview scopes the main banner to the active chat.
   */
  setSessionConnection(sessionId: string, state: ConnectionStatePayload) {
    const live = this.host.live.get(sessionId);
    if (!live) return;
    const next = mergeConnection(live.connection, {
      ...state,
      sessionId,
    });
    live.connection = next;
    this.host.events.onConnectionState(next);
  }

  /** Re-emit the active chat's connection (e.g. after switch). */
  emitActiveConnection() {
    const id = this.host.activeSessionId;
    if (!id) {
      this.host.events.onConnectionState({ status: "idle" });
      return;
    }
    this.host.events.onConnectionState(this.getSessionConnection(id));
  }

  startMemoryPolling() {
    this.stopMemoryPolling();
    void this.sampleAndPushMemory();
    this.memoryPollTimer = setInterval(() => {
      void this.sampleAndPushMemory();
    }, 2_000);
  }

  stopMemoryPolling() {
    if (this.memoryPollTimer != null) {
      clearInterval(this.memoryPollTimer);
      this.memoryPollTimer = null;
    }
    this.memoryPollInFlight = false;
  }

  private async sampleAndPushMemory() {
    if (this.memoryPollInFlight) return;
    const sessionId = this.host.activeSessionId;
    if (!sessionId) return;
    const live = this.host.live.get(sessionId);
    const client = live?.client;
    if (!client || !live) return;
    const status = live.connection.status;
    if (status !== "ready" && status !== "prompting") return;
    if (typeof client.sampleMemoryRssBytes !== "function") return;

    this.memoryPollInFlight = true;
    try {
      const bytes = await client.sampleMemoryRssBytes();
      if (this.host.activeSessionId !== sessionId) return;
      if (live.client !== client) return;
      const cur = live.connection;
      if (cur.status !== "ready" && cur.status !== "prompting") return;
      if (bytes === cur.memoryRssBytes) return;
      this.setSessionConnection(sessionId, {
        ...cur,
        memoryRssBytes: bytes,
        memorySampledAt: Date.now(),
      });
    } catch (err) {
      console.warn("[session-manager] memory sample failed:", err);
    } finally {
      this.memoryPollInFlight = false;
    }
  }

  /**
   * Spawn / reuse this chat's dedicated ACP process.
   * Does not touch other sessions' agents.
   */
  async connectSessionAgent(
    sessionId: string,
    agents: AgentInfo[],
    agentId: string,
    cwd: string | undefined,
    emitSessionList: () => void,
  ) {
    const live = this.host.live.get(sessionId);
    if (!live) {
      return { ok: false as const, error: "Session not found" };
    }

    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      this.setSessionConnection(sessionId, {
        status: "error",
        error: `Unknown agent: ${agentId}`,
        sessionId,
      });
      return { ok: false as const, error: `Unknown agent: ${agentId}` };
    }

    const desiredProviderKey = providerConnectionKey(this.host.settings);

    // Reuse this chat's process when agent + provider fingerprint still match.
    if (
      live.client &&
      live.connectedAgentId === agentId &&
      live.connectedProviderKey === desiredProviderKey
    ) {
      await this.ensureGrokProviderConfig(agent);
      this.host.touchAgentActivity?.(sessionId);
      if (!live.prompting) {
        this.setSessionConnection(sessionId, {
          status: "ready",
          agentName: agent.name,
          sessionId,
        });
      }
      this.startMemoryPolling();
      emitSessionList();
      return { ok: true as const };
    }

    // Provider/agent change for this chat only — replace its process.
    if (live.client) {
      await this.killSessionAgent(sessionId, { emit: false });
    }

    this.setSessionConnection(sessionId, {
      status: "connecting",
      agentName: agent.name,
      sessionId,
    });

    try {
      const provider = resolveActiveProvider(this.host.settings);
      const modelAlias = normalizeModelAlias(
        this.host.settings.activeModelAlias,
        "sonnet",
      );
      const usesClaudeProvider = isClaudeStyleAgent(agent);
      const usesGrokProvider = isGrokStyleAgent(agent);
      const providerEnv = usesClaudeProvider
        ? buildProviderEnv(provider, modelAlias)
        : usesGrokProvider
          ? buildGrokProviderEnv(provider)
          : null;

      if (usesGrokProvider) {
        await this.ensureGrokProviderConfig(agent);
      }

      const sessionMeta = usesClaudeProvider
        ? buildClaudeCodeSessionMeta(provider, modelAlias)
        : undefined;
      if (usesClaudeProvider && provider) {
        console.log(
          `[acp] session ${sessionId.slice(0, 8)}… provider "${provider.name}"` +
            ` model=${modelAlias}` +
            (providerEnv?.ANTHROPIC_MODEL
              ? ` → ${providerEnv.ANTHROPIC_MODEL}`
              : "") +
            (providerEnv?.ANTHROPIC_BASE_URL
              ? ` base=${providerEnv.ANTHROPIC_BASE_URL}`
              : ""),
        );
      } else if (usesClaudeProvider) {
        console.log(
          `[acp] session ${sessionId.slice(0, 8)}… Claude without app provider`,
        );
      } else if (usesGrokProvider) {
        console.log(
          `[acp] session ${sessionId.slice(0, 8)}… Grok agent "${agent.name}"`,
        );
      } else {
        console.log(
          `[acp] session ${sessionId.slice(0, 8)}… agent "${agent.name}"`,
        );
      }

      const browserControl = this.host.getBrowserControl?.() ?? null;
      if (!browserControl) {
        console.warn(
          "[acp] browser control plane unavailable — in-app browser MCP will not register",
        );
      }
      const pinGrokModel =
        usesGrokProvider && !!provider?.baseUrl?.trim();
      if (usesGrokProvider && provider && !provider.apiKey.trim()) {
        console.warn(
          "[acp] Grok BYOK provider has no API key — set Providers → API key " +
            `or Grok will fail auth for model ${GROK_PROVIDER_MODEL_ID}`,
        );
      }
      const spawnAgent = usesGrokProvider
        ? withGrokAgentSpawnArgs(agent, {
            defaultPermissionMode: this.host.settings.defaultPermissionMode,
            defaultEffort: this.host.settings.defaultEffort,
            modelId: pinGrokModel ? GROK_PROVIDER_MODEL_ID : undefined,
          })
        : agent;

      // Capture local id in closures so this process only ever feeds one chat.
      const localSessionId = sessionId;
      const client = new AcpClient(
        spawnAgent,
        {
          enableFs: this.host.settings.enableFsCapabilities,
          enableBrowserMcp:
            this.host.settings.enableBrowserMcp !== false && !!browserControl,
          ...(browserControl ? { browserControl } : {}),
          onUpdate: (agentSessionId, update) => {
            const localId =
              this.agentToLocal.get(agentSessionId) ?? localSessionId;
            if (update.sessionUpdate === "user_message_chunk") return;
            this.host.store.appendEvent(localId, update);
            const target = this.host.live.get(localId);
            if (target) {
              target.summary = {
                ...target.summary,
                updatedAt: Date.now(),
              };
            }
            this.host.events.onUpdate(localId, update);
          },
          onCommands: (agentSessionId, commands: AvailableCommand[]) => {
            const localId =
              this.agentToLocal.get(agentSessionId) ?? localSessionId;
            const target = this.host.live.get(localId);
            if (target) target.commands = commands;
            this.host.events.onCommands(localId, commands);
          },
          onMode: (agentSessionId, mode) => {
            const localId =
              this.agentToLocal.get(agentSessionId) ?? localSessionId;
            const target = this.host.live.get(localId);
            if (target) {
              target.mode = mode;
              this.host.store.updateSession(localId, { mode });
            }
            this.host.events.onMode(localId, mode);
          },
          onConfigOptions: (
            agentSessionId,
            configOptions: SessionConfigOption[],
          ) => {
            const localId =
              this.agentToLocal.get(agentSessionId) ?? localSessionId;
            const target = this.host.live.get(localId);
            if (target) target.configOptions = configOptions;
            const modeOpt = configOptions.find(
              (o) =>
                o.category === "mode" &&
                o.type === "select" &&
                typeof o.currentValue === "string",
            );
            if (modeOpt && modeOpt.type === "select" && target) {
              target.mode = modeOpt.currentValue;
              this.host.store.updateSession(localId, {
                mode: modeOpt.currentValue,
              });
              this.host.events.onMode(localId, modeOpt.currentValue);
            }
            this.host.events.onConfigOptions(localId, configOptions);
          },
          onUsage: (agentSessionId, usage: SessionUsage) => {
            const localId =
              this.agentToLocal.get(agentSessionId) ?? localSessionId;
            const target = this.host.live.get(localId);
            if (target) target.usage = usage;
            this.host.events.onUsage(localId, usage);
          },
          onTurnEnd: (agentSessionId, stopReason) => {
            const localId =
              this.agentToLocal.get(agentSessionId) ?? localSessionId;
            const target = this.host.live.get(localId);
            if (target) target.prompting = false;
            this.host.touchAgentActivity?.(localId);
            this.setSessionConnection(localId, {
              status: "ready",
              agentName: agent.name,
              sessionId: localId,
            });
            this.host.events.onTurnEnd(localId, stopReason);
          },
          onPermission: async (params) => {
            return this.host.queuePermission(params);
          },
          onUserQuestion: async (params) => {
            return this.host.queueUserQuestion(params);
          },
        },
        {
          ...(usesClaudeProvider
            ? {
                env: withBrowserMcpAlwaysLoaded(providerEnv ?? {}),
                sessionMeta,
              }
            : usesGrokProvider
              ? {
                  env: providerEnv ?? {
                    GROK_DEFAULT_MODEL: GROK_PROVIDER_MODEL_ID,
                    GROK_IMAGE_GEN: "0",
                  },
                }
              : {}),
          ...(usesGrokProvider
            ? {
                fallbackPermissionMode: grokInitialModeId(
                  this.host.settings.defaultPermissionMode,
                ),
                fallbackEffort:
                  normalizeGrokEffort(this.host.settings.defaultEffort) ??
                  "high",
              }
            : {}),
        },
      );

      await client.connect();
      // Drop if session deleted while connecting.
      if (!this.host.live.has(sessionId)) {
        await client.dispose();
        return { ok: false as const, error: "Session not found" };
      }
      live.client = client;
      live.connectedAgentId = agentId;
      live.connectedProviderKey = desiredProviderKey;
      this.host.touchAgentActivity?.(sessionId);
      this.setSessionConnection(sessionId, {
        status: "ready",
        agentName: agent.name,
        sessionId,
      });
      this.startMemoryPolling();
      emitSessionList();

      if (!live.handle) {
        await this.ensureHandle(sessionId, cwd, emitSessionList);
      }

      return { ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[session-manager] connect failed:", message);
      live.client = null;
      live.connectedAgentId = null;
      live.connectedProviderKey = null;
      live.handle = null;
      this.setSessionConnection(sessionId, {
        status: "error",
        error: message,
        agentName: agent.name,
        sessionId,
      });
      return { ok: false as const, error: message };
    }
  }

  /**
   * Materialize ~/.grok/config.toml from the active app provider.
   */
  private async ensureGrokProviderConfig(agent: AgentInfo): Promise<void> {
    if (!isGrokStyleAgent(agent)) return;
    const provider = resolveActiveProvider(this.host.settings);
    const modelAlias = normalizeModelAlias(
      this.host.settings.activeModelAlias,
      "sonnet",
    );
    const grokCfg = await ensureGrokConfigForProvider(this.host.settings);
    if (!grokCfg.ok) {
      console.warn("[acp] failed to write Grok config.toml:", grokCfg.error);
      return;
    }
    if (grokCfg.wrote) {
      console.log(
        `[acp] wrote Grok config.toml at ${grokCfg.path}` +
          (provider
            ? ` provider="${provider.name}" model=${modelAlias}` +
              (provider.baseUrl ? ` base=${provider.baseUrl}` : "")
            : ""),
      );
    } else {
      console.log(
        `[acp] Grok config.toml not rewritten (${grokCfg.reason}) — using existing ~/.grok setup`,
      );
    }
  }

  async ensureHandle(
    sessionId: string,
    cwd: string | undefined,
    emitSessionList: () => void,
  ): Promise<AcpSessionHandle> {
    const live = this.host.live.get(sessionId);
    if (!live) throw new Error("session not found");
    if (live.handle) return live.handle;
    if (!live.client) throw new Error("agent not connected");

    const sessionAgent: AgentInfo = {
      id: live.summary.agentId,
      name: live.summary.agentId,
      command: "",
      args: [],
    };
    if (isGrokStyleAgent(sessionAgent)) {
      await this.ensureGrokProviderConfig(sessionAgent);
    }

    const handle = await live.client.openSession(cwd ?? live.summary.cwd, {
      localSessionId: sessionId,
    });
    this.agentToLocal.set(handle.sessionId, sessionId);

    let configOptions = handle.configOptions;
    configOptions = await applyPreferredConfigDefaults(
      handle,
      configOptions,
      this.host.settings,
    );

    live.configOptions = configOptions;
    if (configOptions.length > 0) {
      const modeOpt = configOptions.find(
        (o) =>
          o.category === "mode" &&
          o.type === "select" &&
          typeof o.currentValue === "string",
      );
      if (modeOpt && modeOpt.type === "select") {
        live.mode = modeOpt.currentValue;
        this.host.store.updateSession(sessionId, { mode: modeOpt.currentValue });
        this.host.events.onMode(sessionId, modeOpt.currentValue);
      }
      this.host.events.onConfigOptions(sessionId, configOptions);
    }

    live.handle = {
      sessionId,
      configOptions,
      beginUpdates: () => handle.beginUpdates(),
      prompt: async (text: string) => handle.prompt(text),
      cancel: () => handle.cancel(),
      setConfigOption: (configId, value) =>
        handle.setConfigOption(configId, value),
      dispose: () => {
        this.agentToLocal.delete(handle.sessionId);
        handle.dispose();
      },
    };

    handle.beginUpdates();

    emitSessionList();
    return live.handle;
  }

  /** Kill one chat's agent process and clear its handle. */
  async killSessionAgent(
    sessionId: string,
    opts?: { emit?: boolean },
  ): Promise<boolean> {
    const live = this.host.live.get(sessionId);
    if (!live) return false;

    const hadClient = live.client != null;
    try {
      live.handle?.dispose();
    } catch {
      /* ignore */
    }
    live.handle = null;
    live.prompting = false;

    for (const [agentSessionId, localId] of [...this.agentToLocal.entries()]) {
      if (localId === sessionId) this.agentToLocal.delete(agentSessionId);
    }

    if (live.client) {
      try {
        await live.client.dispose();
      } catch {
        /* ignore */
      }
    }
    live.client = null;
    live.connectedAgentId = null;
    live.connectedProviderKey = null;
    this.setSessionConnection(sessionId, idleConnection(sessionId));

    if (opts?.emit !== false) {
      // no-op marker for callers that also emitSessionList
    }
    return hadClient;
  }

  clientForSession(sessionId: string): AcpClient | null {
    return this.host.live.get(sessionId)?.client ?? null;
  }

  async dispose() {
    this.stopMemoryPolling();
    for (const id of [...this.host.live.keys()]) {
      await this.killSessionAgent(id, { emit: false });
    }
    this.agentToLocal.clear();
  }
}
