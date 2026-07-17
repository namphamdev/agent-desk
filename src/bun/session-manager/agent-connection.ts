/**
 * ACP agent process lifecycle: connect, open session handles, memory polling.
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
 * Grok CLI takes `--always-approve` on `grok agent` (before `stdio`):
 * `grok agent --always-approve stdio`.
 */
/**
 * Insert CLI flags after `agent` for Grok Build ACP spawn:
 * `grok agent [--always-approve] [--effort LEVEL] stdio`
 */
export function withGrokAgentSpawnArgs(
  agent: AgentInfo,
  opts: {
    defaultPermissionMode?: string;
    defaultEffort?: string;
  },
): AgentInfo {
  if (!isGrokStyleAgent(agent)) return agent;
  const args = [...(agent.args ?? [])];
  const agentIdx = args.findIndex((a) => a === "agent");
  const insertAt = agentIdx >= 0 ? agentIdx + 1 : 0;

  // Build flags to insert (order: always-approve then effort).
  const flags: string[] = [];
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
  // Claude-style defaults often store "High" — still map known effort words.
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
  /** Built-in browser control plane (in-app panel MCP). */
  getBrowserControl?: () => { url: string; token: string } | null;
};

export class AgentConnection {
  client: AcpClient | null = null;
  connectedAgentId: string | null = null;
  /**
   * Provider+model fingerprint for the live ACP process. When settings
   * change credentials or model mapping we must respawn, not reuse.
   */
  connectedProviderKey: string | null = null;
  /** Maps ACP agent session ids to our persisted local session ids. */
  agentToLocal = new Map<string, string>();
  connectionState: ConnectionStatePayload = { status: "idle" };

  private memoryPollTimer: ReturnType<typeof setInterval> | null = null;
  private memoryPollInFlight = false;
  private host: AgentConnectionHost;

  constructor(host: AgentConnectionHost) {
    this.host = host;
  }

  setConnection(state: ConnectionStatePayload) {
    // Preserve the last memory sample unless the caller overrides it.
    const next: ConnectionStatePayload = {
      ...state,
      memoryRssBytes:
        state.memoryRssBytes !== undefined
          ? state.memoryRssBytes
          : this.connectionState.memoryRssBytes,
      memorySampledAt:
        state.memorySampledAt !== undefined
          ? state.memorySampledAt
          : this.connectionState.memorySampledAt,
    };
    // Drop stale samples when we're not connected to a live agent.
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
    this.connectionState = next;
    this.host.events.onConnectionState(next);
  }

  startMemoryPolling() {
    this.stopMemoryPolling();
    // Immediate sample so the header isn't blank for a full interval.
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
    const client = this.client;
    if (!client) return;
    // Only show memory while the agent process is up.
    const status = this.connectionState.status;
    if (status !== "ready" && status !== "prompting") return;
    // Tests / stubs may not implement sampling.
    if (typeof client.sampleMemoryRssBytes !== "function") return;

    this.memoryPollInFlight = true;
    try {
      const bytes = await client.sampleMemoryRssBytes();
      // Bail if connection changed under us.
      if (this.client !== client) return;
      const cur = this.connectionState;
      if (cur.status !== "ready" && cur.status !== "prompting") return;
      // Skip no-op updates so we don't thrash the webview.
      if (bytes === cur.memoryRssBytes) return;
      this.setConnection({
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

  async connectAgent(
    agents: AgentInfo[],
    agentId: string,
    cwd: string | undefined,
    emitSessionList: () => void,
  ) {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      this.setConnection({ status: "error", error: `Unknown agent: ${agentId}` });
      return { ok: false as const, error: `Unknown agent: ${agentId}` };
    }

    const desiredProviderKey = providerConnectionKey(this.host.settings);

    // Reuse only when agent AND provider credentials/model match.
    if (
      this.client &&
      this.connectedAgentId === agentId &&
      this.connectedProviderKey === desiredProviderKey
    ) {
      this.setConnection({
        status: "ready",
        agentName: agent.name,
        sessionId: this.host.activeSessionId,
      });
      this.startMemoryPolling();
      emitSessionList();
      return { ok: true as const };
    }

    if (this.client) {
      this.stopMemoryPolling();
      await this.client.dispose();
      this.client = null;
      this.connectedAgentId = null;
      this.connectedProviderKey = null;
      this.agentToLocal.clear();
      for (const live of this.host.live.values()) {
        live.handle = null;
      }
      emitSessionList();
    }

    this.setConnection({ status: "connecting", agentName: agent.name });

    try {
      const provider = resolveActiveProvider(this.host.settings);
      const modelAlias = normalizeModelAlias(
        this.host.settings.activeModelAlias,
        "sonnet",
      );
      // Anthropic-style providers + Claude session _meta only apply to Claude ACP.
      // Grok Build reads ~/.grok/config.toml (+ env_key) — materialize that for BYOK.
      const usesClaudeProvider = isClaudeStyleAgent(agent);
      const usesGrokProvider = isGrokStyleAgent(agent);
      const providerEnv = usesClaudeProvider
        ? buildProviderEnv(provider, modelAlias)
        : usesGrokProvider
          ? buildGrokProviderEnv(provider)
          : null;

      if (usesGrokProvider) {
        const grokCfg = await ensureGrokConfigForProvider(this.host.settings);
        if (!grokCfg.ok) {
          console.warn("[acp] failed to write Grok config.toml:", grokCfg.error);
        } else if (grokCfg.wrote) {
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

      // Always attach Claude meta for Claude agents (browser MCP append + ToolSearch off).
      // Other agents get no claudeCode session _meta (still may register MCP servers).
      const sessionMeta = usesClaudeProvider
        ? buildClaudeCodeSessionMeta(provider, modelAlias)
        : undefined;
      if (usesClaudeProvider && provider) {
        console.log(
          `[acp] spawning with provider "${provider.name}" (${provider.id})` +
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
          "[acp] spawning without app provider (browser MCP still registered per session)",
        );
      } else if (usesGrokProvider) {
        console.log(
          `[acp] spawning agent "${agent.name}" (Grok; config.toml / env_key for provider)`,
        );
      } else {
        console.log(
          `[acp] spawning agent "${agent.name}" (non-Claude; app Anthropic provider env skipped)`,
        );
      }

      const browserControl = this.host.getBrowserControl?.() ?? null;
      if (!browserControl) {
        console.warn(
          "[acp] browser control plane unavailable — in-app browser MCP will not register",
        );
      }
      const spawnAgent = usesGrokProvider
        ? withGrokAgentSpawnArgs(agent, {
            defaultPermissionMode: this.host.settings.defaultPermissionMode,
            defaultEffort: this.host.settings.defaultEffort,
          })
        : agent;
      const client = new AcpClient(
        spawnAgent,
        {
          enableFs: this.host.settings.enableFsCapabilities,
          enableBrowserMcp:
            this.host.settings.enableBrowserMcp !== false && !!browserControl,
          ...(browserControl ? { browserControl } : {}),
          onUpdate: (sessionId, update) => {
            const localId = this.agentToLocal.get(sessionId) ?? sessionId;
            // We persist user messages ourselves in sendPrompt. Skip any the
            // agent echoes back to avoid duplicates on reload.
            if (update.sessionUpdate === "user_message_chunk") return;
            this.host.store.appendEvent(localId, update);
            const live = this.host.live.get(localId);
            if (live) {
              live.summary = {
                ...live.summary,
                updatedAt: Date.now(),
              };
            }
            this.host.events.onUpdate(localId, update);
          },
          onCommands: (sessionId, commands: AvailableCommand[]) => {
            const localId = this.agentToLocal.get(sessionId) ?? sessionId;
            const live = this.host.live.get(localId);
            if (live) live.commands = commands;
            this.host.events.onCommands(localId, commands);
          },
          onMode: (sessionId, mode) => {
            const localId = this.agentToLocal.get(sessionId) ?? sessionId;
            const live = this.host.live.get(localId);
            if (live) {
              live.mode = mode;
              this.host.store.updateSession(localId, { mode });
            }
            this.host.events.onMode(localId, mode);
          },
          onConfigOptions: (sessionId, configOptions: SessionConfigOption[]) => {
            const localId = this.agentToLocal.get(sessionId) ?? sessionId;
            const live = this.host.live.get(localId);
            if (live) live.configOptions = configOptions;
            // Sync mode from configOptions when agent uses category "mode".
            const modeOpt = configOptions.find(
              (o) =>
                o.category === "mode" &&
                o.type === "select" &&
                typeof o.currentValue === "string",
            );
            if (modeOpt && modeOpt.type === "select" && live) {
              live.mode = modeOpt.currentValue;
              this.host.store.updateSession(localId, {
                mode: modeOpt.currentValue,
              });
              this.host.events.onMode(localId, modeOpt.currentValue);
            }
            this.host.events.onConfigOptions(localId, configOptions);
          },
          onUsage: (sessionId, usage: SessionUsage) => {
            const localId = this.agentToLocal.get(sessionId) ?? sessionId;
            const live = this.host.live.get(localId);
            if (live) live.usage = usage;
            this.host.events.onUsage(localId, usage);
          },
          onTurnEnd: (sessionId, stopReason) => {
            const localId = this.agentToLocal.get(sessionId) ?? sessionId;
            const live = this.host.live.get(localId);
            if (live) live.prompting = false;
            this.setConnection({
              status: "ready",
              agentName: agent.name,
              sessionId: this.host.activeSessionId,
            });
            this.host.events.onTurnEnd(localId, stopReason);
          },
          onPermission: async (params) => {
            return this.host.queuePermission(params);
          },
        },
        {
          ...(usesClaudeProvider
            ? {
                // Always surface browser MCP tools (disable deferred tool search).
                env: withBrowserMcpAlwaysLoaded(providerEnv ?? {}),
                sessionMeta,
              }
            : usesGrokProvider && providerEnv
              ? { env: providerEnv }
              : {}),
          // Grok: synthetic Permission dropdown (session/set_mode / --always-approve via spawn).
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
      this.client = client;
      this.connectedAgentId = agentId;
      this.connectedProviderKey = desiredProviderKey;
      this.setConnection({
        status: "ready",
        agentName: agent.name,
        sessionId: this.host.activeSessionId,
      });
      this.startMemoryPolling();
      // Agent process is up — surface offload affordance for the active chat
      // even before openSession finishes.
      emitSessionList();

      if (this.host.activeSessionId) {
        await this.ensureHandle(this.host.activeSessionId, cwd, emitSessionList);
      }

      return { ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[session-manager] connect failed:", message);
      this.stopMemoryPolling();
      this.setConnection({ status: "error", error: message, agentName: agent.name });
      return { ok: false as const, error: message };
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
    if (!this.client) throw new Error("agent not connected");

    // openSession only keeps one active agent session — drop other handles so
    // agentRunning accurately reflects which chat owns the live ACP client.
    for (const [id, other] of this.host.live) {
      if (id === sessionId || !other.handle) continue;
      try {
        other.handle.dispose();
      } catch {
        /* ignore */
      }
      other.handle = null;
    }

    const handle = await this.client.openSession(cwd ?? live.summary.cwd, {
      localSessionId: sessionId,
    });
    // Map agent session id → local id before draining updates so early
    // notifications (available_commands_update, config_option_update, …)
    // land on the correct live session.
    this.agentToLocal.set(handle.sessionId, sessionId);

    // Apply session/new config options now that agent→local mapping is ready.
    let configOptions = handle.configOptions;

    // Push user defaults (thinking level, permission mode, model) before the UI sees options.
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

    // Drain session/update immediately (slash commands, mode, etc.).
    handle.beginUpdates();

    emitSessionList();
    return live.handle;
  }

  /** Kill the agent process and clear all live handles. */
  async killAgent() {
    this.stopMemoryPolling();
    if (this.client) {
      await this.client.dispose();
    }
    this.client = null;
    this.connectedAgentId = null;
    this.connectedProviderKey = null;
    this.agentToLocal.clear();
    for (const l of this.host.live.values()) {
      l.handle = null;
      l.prompting = false;
    }
  }

  async dispose() {
    this.stopMemoryPolling();
    await this.client?.dispose();
    this.client = null;
    this.connectedAgentId = null;
    this.connectedProviderKey = null;
    this.agentToLocal.clear();
  }
}
