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
import type { SessionStore } from "../store";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { applyPreferredConfigDefaults } from "./config-options";
import type { LiveSession, SessionManagerEvents } from "./types";

export type AgentConnectionHost = {
  settings: AppSettings;
  store: SessionStore;
  live: Map<string, LiveSession>;
  events: SessionManagerEvents;
  activeSessionId: string | null;
  queuePermission: (
    params: RequestPermissionRequest & { requestId: string },
  ) => Promise<RequestPermissionResponse>;
};

export class AgentConnection {
  client: AcpClient | null = null;
  connectedAgentId: string | null = null;
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

    if (this.client && this.connectedAgentId === agentId) {
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
      this.agentToLocal.clear();
      for (const live of this.host.live.values()) {
        live.handle = null;
      }
      emitSessionList();
    }

    this.setConnection({ status: "connecting", agentName: agent.name });

    try {
      const client = new AcpClient(agent, {
        enableFs: this.host.settings.enableFsCapabilities,
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
            this.host.store.updateSession(localId, { mode: modeOpt.currentValue });
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
      });

      await client.connect();
      this.client = client;
      this.connectedAgentId = agentId;
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

    const handle = await this.client.openSession(cwd ?? live.summary.cwd);
    // Map agent session id → local id before draining updates so early
    // notifications (available_commands_update, config_option_update, …)
    // land on the correct live session.
    this.agentToLocal.set(handle.sessionId, sessionId);

    // Apply session/new config options now that agent→local mapping is ready.
    let configOptions = handle.configOptions;

    // Push user defaults (thinking level, model) before the UI sees options.
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
    this.agentToLocal.clear();
  }
}
