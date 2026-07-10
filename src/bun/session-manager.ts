/**
 * Session manager: multi-session orchestration on the Bun side.
 * Owns the active ACP client, permission queue, and persistence.
 */
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  AgentInfo,
  AppSettings,
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  RecentProject,
  SessionConfigOption,
  SessionSummary,
} from "../shared/rpc";
import type { SessionUpdate } from "../session/types";
import { AcpClient, type AcpSessionHandle } from "./acp-client";
import { ensureAgentsConfig, loadAgents } from "./agents";
import { getGitBranch } from "./git-branch";
import { loadSettings, saveSettings } from "./settings";
import { SessionStore } from "./store";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export type SessionManagerEvents = {
  onUpdate: (sessionId: string, update: SessionUpdate) => void;
  onTurnEnd: (sessionId: string, stopReason: string) => void;
  onConnectionState: (state: ConnectionStatePayload) => void;
  onPermissionRequest: (req: PermissionRequest) => void;
  onSessionList: (sessions: SessionSummary[], activeSessionId: string | null) => void;
  onCommands: (sessionId: string, commands: AvailableCommand[]) => void;
  onMode: (sessionId: string, mode: string) => void;
  onConfigOptions: (sessionId: string, configOptions: SessionConfigOption[]) => void;
  onSessionLoaded: (
    session: SessionSummary,
    updates: SessionUpdate[],
    mode: string,
    commands: AvailableCommand[],
    configOptions?: SessionConfigOption[],
  ) => void;
};

type LiveSession = {
  summary: SessionSummary;
  handle: AcpSessionHandle | null;
  commands: AvailableCommand[];
  mode: string;
  configOptions: SessionConfigOption[];
  prompting: boolean;
  /**
   * Context text to prepend once on the first user prompt (seeded threads).
   * Cleared after the first send so follow-ups stay normal.
   */
  contextSeed?: string | null;
};

export class SessionManager {
  private store: SessionStore;
  private settings: AppSettings;
  private agents: AgentInfo[] = [];
  private defaultAgentId = "";
  private client: AcpClient | null = null;
  private connectedAgentId: string | null = null;
  private live = new Map<string, LiveSession>();
  private activeSessionId: string | null = null;
  private events: SessionManagerEvents;
  private pendingPermissions = new Map<
    string,
    {
      resolve: (r: RequestPermissionResponse) => void;
      params: RequestPermissionRequest;
    }
  >();
  private connectionState: ConnectionStatePayload = { status: "idle" };
  /** Maps ACP agent session ids to our persisted local session ids. */
  private agentToLocal = new Map<string, string>();
  private memoryPollTimer: ReturnType<typeof setInterval> | null = null;
  private memoryPollInFlight = false;
  /** Serializes background agent prep so rapid session switches don't race. */
  private prepareChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, events: SessionManagerEvents) {
    this.store = new SessionStore(dataDir);
    this.settings = loadSettings(this.store);
    this.events = events;
  }

  async init() {
    await ensureAgentsConfig();
    const { agents, defaultAgentId } = await loadAgents();
    this.agents = agents;
    this.defaultAgentId =
      this.settings.defaultAgentId &&
      agents.some((a) => a.id === this.settings.defaultAgentId)
        ? this.settings.defaultAgentId
        : defaultAgentId || agents[0]?.id || "";

    // Hydrate summaries from store (no live handles yet).
    for (const s of this.store.listSessions()) {
      this.live.set(s.id, {
        summary: s,
        handle: null,
        commands: [],
        mode: this.store.getSession(s.id)?.mode ?? "default",
        configOptions: [],
        prompting: false,
      });
    }

    this.emitSessionList();
  }

  getAgents() {
    return this.agents;
  }

  getSettings() {
    return this.settings;
  }

  saveSettings(patch: Partial<AppSettings>) {
    this.settings = saveSettings(this.store, patch);
    if (patch.defaultAgentId) this.defaultAgentId = patch.defaultAgentId;
    return this.settings;
  }

  getConnectionState() {
    return this.connectionState;
  }

  listSessions(): { sessions: SessionSummary[]; activeSessionId: string | null } {
    const sessions = [...this.live.values()]
      .map((l) => l.summary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions, activeSessionId: this.activeSessionId };
  }

  private setConnection(state: ConnectionStatePayload) {
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
    this.events.onConnectionState(next);
  }

  private startMemoryPolling() {
    this.stopMemoryPolling();
    // Immediate sample so the header isn't blank for a full interval.
    void this.sampleAndPushMemory();
    this.memoryPollTimer = setInterval(() => {
      void this.sampleAndPushMemory();
    }, 2_000);
  }

  private stopMemoryPolling() {
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

  private emitSessionList() {
    const { sessions, activeSessionId } = this.listSessions();
    this.events.onSessionList(sessions, activeSessionId);
  }

  private uid() {
    return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async connectAgent(agentId?: string, cwd?: string) {
    const id = agentId ?? this.defaultAgentId;
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) {
      this.setConnection({ status: "error", error: `Unknown agent: ${id}` });
      return { ok: false as const, error: `Unknown agent: ${id}` };
    }

    if (this.client && this.connectedAgentId === id) {
      this.setConnection({
        status: "ready",
        agentName: agent.name,
        sessionId: this.activeSessionId,
      });
      this.startMemoryPolling();
      return { ok: true as const };
    }


    if (this.client) {
      this.stopMemoryPolling();
      await this.client.dispose();
      this.client = null;
      this.connectedAgentId = null;
      this.agentToLocal.clear();
      for (const live of this.live.values()) {
        live.handle = null;
      }
    }

    this.setConnection({ status: "connecting", agentName: agent.name });

    try {
      const client = new AcpClient(agent, {
        enableFs: this.settings.enableFsCapabilities,
        onUpdate: (sessionId, update) => {
          const localId = this.agentToLocal.get(sessionId) ?? sessionId;
          // We persist user messages ourselves in sendPrompt. Skip any the
          // agent echoes back to avoid duplicates on reload.
          if (update.sessionUpdate === "user_message_chunk") return;
          this.store.appendEvent(localId, update);
          const live = this.live.get(localId);
          if (live) {
            live.summary = {
              ...live.summary,
              updatedAt: Date.now(),
            };
          }
          this.events.onUpdate(localId, update);
        },
        onCommands: (sessionId, commands) => {
          const localId = this.agentToLocal.get(sessionId) ?? sessionId;
          const live = this.live.get(localId);
          if (live) live.commands = commands;
          this.events.onCommands(localId, commands);
        },
        onMode: (sessionId, mode) => {
          const localId = this.agentToLocal.get(sessionId) ?? sessionId;
          const live = this.live.get(localId);
          if (live) {
            live.mode = mode;
            this.store.updateSession(localId, { mode });
          }
          this.events.onMode(localId, mode);
        },
        onConfigOptions: (sessionId, configOptions) => {
          const localId = this.agentToLocal.get(sessionId) ?? sessionId;
          const live = this.live.get(localId);
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
            this.store.updateSession(localId, { mode: modeOpt.currentValue });
            this.events.onMode(localId, modeOpt.currentValue);
          }
          this.events.onConfigOptions(localId, configOptions);
        },
        onTurnEnd: (sessionId, stopReason) => {
          const localId = this.agentToLocal.get(sessionId) ?? sessionId;
          const live = this.live.get(localId);
          if (live) live.prompting = false;
          this.setConnection({
            status: "ready",
            agentName: agent.name,
            sessionId: this.activeSessionId,
          });
          this.events.onTurnEnd(localId, stopReason);
        },
        onPermission: async (params) => {
          return this.queuePermission(params);
        },
      });

      await client.connect();
      this.client = client;
      this.connectedAgentId = id;
      this.setConnection({
        status: "ready",
        agentName: agent.name,
        sessionId: this.activeSessionId,
      });
      this.startMemoryPolling();

      if (this.activeSessionId) {
        await this.ensureHandle(this.activeSessionId, cwd);
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

  private async ensureHandle(sessionId: string, cwd?: string) {
    const live = this.live.get(sessionId);
    if (!live) throw new Error("session not found");
    if (live.handle) return live.handle;
    if (!this.client) throw new Error("agent not connected");

    const handle = await this.client.openSession(cwd ?? live.summary.cwd);
    this.agentToLocal.set(handle.sessionId, sessionId);

    // Apply session/new config options now that agent→local mapping is ready.
    live.configOptions = handle.configOptions;
    if (handle.configOptions.length > 0) {
      const modeOpt = handle.configOptions.find(
        (o) =>
          o.category === "mode" &&
          o.type === "select" &&
          typeof o.currentValue === "string",
      );
      if (modeOpt && modeOpt.type === "select") {
        live.mode = modeOpt.currentValue;
        this.store.updateSession(sessionId, { mode: modeOpt.currentValue });
        this.events.onMode(sessionId, modeOpt.currentValue);
      }
      this.events.onConfigOptions(sessionId, handle.configOptions);
    }

    live.handle = {
      sessionId,
      configOptions: handle.configOptions,
      prompt: async (text: string) => handle.prompt(text),
      cancel: () => handle.cancel(),
      setConfigOption: (configId, value) =>
        handle.setConfigOption(configId, value),
      dispose: () => {
        this.agentToLocal.delete(handle.sessionId);
        handle.dispose();
      },
    };

    return live.handle;
  }

  /**
   * Distinct project folders from recent sessions (most recently used first).
   */
  listRecentProjects(limit = 12): RecentProject[] {
    const dismissed = new Set(this.settings.dismissedRecentCwds ?? []);
    const seen = new Set<string>();
    const out: RecentProject[] = [];
    for (const s of this.listSessions().sessions) {
      const cwd = s.cwd?.trim();
      if (!cwd || seen.has(cwd) || dismissed.has(cwd)) continue;
      seen.add(cwd);
      out.push({
        project: s.project || basename(cwd),
        cwd,
        updatedAt: s.updatedAt,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  removeRecentProject(cwd: string): RecentProject[] {
    const trimmed = cwd.trim();
    if (!trimmed) return this.listRecentProjects();
    const current = this.settings.dismissedRecentCwds ?? [];
    if (!current.includes(trimmed)) {
      this.settings = saveSettings(this.store, {
        dismissedRecentCwds: [...current, trimmed],
      });
    }
    return this.listRecentProjects();
  }

  private undismissRecentProject(cwd: string) {
    const current = this.settings.dismissedRecentCwds ?? [];
    if (!current.includes(cwd)) return;
    this.settings = saveSettings(this.store, {
      dismissedRecentCwds: current.filter((c) => c !== cwd),
    });
  }

  async createSession(opts: {
    title?: string;
    project?: string;
    cwd?: string;
    agentId?: string;
    seedContext?: {
      text: string;
      role?: "user" | "agent" | "thought";
    };
  }) {
    const rawCwd = (opts.cwd || this.settings.lastProjectCwd || process.cwd()).trim();
    let cwd: string;
    try {
      cwd = resolve(rawCwd);
    } catch {
      return { ok: false as const, error: `Invalid folder path: ${rawCwd}` };
    }
    if (!existsSync(cwd)) {
      return { ok: false as const, error: `Folder does not exist: ${cwd}` };
    }
    try {
      if (!statSync(cwd).isDirectory()) {
        return { ok: false as const, error: `Not a folder: ${cwd}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }

    const project = opts.project || basename(cwd);
    const agentId = opts.agentId || this.defaultAgentId;
    const id = this.uid();
    const seedText = opts.seedContext?.text?.trim() ?? "";
    const title =
      opts.title ||
      (seedText
        ? seedText.replace(/\s+/g, " ").slice(0, 60) || "New thread"
        : "New session");

    // Remember for next "New task" dialog default.
    if (this.settings.lastProjectCwd !== cwd) {
      this.settings = saveSettings(this.store, { lastProjectCwd: cwd });
    }
    // Re-using a project restores it if it was removed from recents.
    this.undismissRecentProject(cwd);

    const stored = this.store.createSession({
      id,
      title,
      project,
      cwd,
      agentId,
    });

    this.live.set(id, {
      summary: stored,
      handle: null,
      commands: [],
      mode: "default",
      configOptions: [],
      prompting: false,
      contextSeed: seedText || null,
    });
    this.activeSessionId = id;
    this.emitSessionList();

    // Ensure agent connected.
    const conn = await this.connectAgent(agentId, cwd);
    if (!conn.ok) {
      return { ok: false as const, error: conn.error };
    }

    try {
      // For demo client, openSession generates id; we want local id.
      // Open and if demo, wrap to use our id for updates already keyed by demo id.
      // Simpler: dispose and use a custom path.
      await this.ensureHandle(id, cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }

    const seedUpdates = seedText
      ? [seedUpdateForRole(seedText, opts.seedContext?.role ?? "agent")]
      : [];
    for (const u of seedUpdates) {
      this.store.appendEvent(id, u);
    }

    const live = this.live.get(id);
    this.events.onSessionLoaded(
      stored,
      seedUpdates,
      live?.mode ?? "default",
      live?.commands ?? [],
      live?.configOptions ?? [],
    );
    this.setConnection({
      ...this.connectionState,
      status: "ready",
      sessionId: id,
    });

    return { ok: true as const, session: stored };
  }

  async switchSession(sessionId: string) {
    const live = this.live.get(sessionId);
    if (!live) return { ok: false as const, error: "Session not found" };

    this.activeSessionId = sessionId;
    const updates = this.store.loadEvents(sessionId);

    // Push history to the UI immediately. Agent connect + openSession can take
    // several seconds; reading chat should not wait on that.
    this.events.onSessionLoaded(
      live.summary,
      updates,
      live.mode,
      live.commands,
      live.configOptions,
    );
    this.emitSessionList();

    // Prepare agent in the background so the RPC returns as soon as history is
    // loaded (and rapid switches don't queue behind agent spawn/openSession).
    this.prepareChain = this.prepareChain
      .then(() => this.prepareSessionAgent(sessionId))
      .catch((err) => {
        console.warn("[session-manager] prepare session agent failed:", err);
      });

    return { ok: true as const, session: live.summary };
  }

  /** Connect agent + open handle for a session; no-ops if user switched away. */
  private async prepareSessionAgent(sessionId: string) {
    const live = this.live.get(sessionId);
    if (!live) return;
    if (this.activeSessionId !== sessionId) return;

    await this.connectAgent(live.summary.agentId, live.summary.cwd);

    if (this.activeSessionId !== sessionId) return;

    if (!live.handle && this.client) {
      try {
        await this.ensureHandle(sessionId);
      } catch (err) {
        console.warn("[session-manager] reopen handle failed:", err);
      }
    }

    if (this.activeSessionId !== sessionId) return;

    // Re-push config options after the agent handle is ready (may have been
    // empty on the initial history load).
    const refreshed = this.live.get(sessionId);
    if (refreshed && refreshed.configOptions.length > 0) {
      this.events.onConfigOptions(sessionId, refreshed.configOptions);
    }

    this.setConnection({
      ...this.connectionState,
      sessionId,
    });
  }

  async setConfigOption(
    configId: string,
    value: string | boolean,
    sessionId?: string,
  ): Promise<
    | { ok: true; configOptions: SessionConfigOption[] }
    | { ok: false; error: string }
  > {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return { ok: false as const, error: "No active session" };
    const live = this.live.get(id);
    if (!live) return { ok: false as const, error: "Session not found" };

    if (!this.client || this.connectedAgentId !== live.summary.agentId) {
      const conn = await this.connectAgent(
        live.summary.agentId,
        live.summary.cwd,
      );
      if (!conn.ok) return { ok: false as const, error: conn.error };
    }
    if (!live.handle) {
      try {
        await this.ensureHandle(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    }
    if (!live.handle) {
      return { ok: false as const, error: "No session handle" };
    }

    try {
      const configOptions = await live.handle.setConfigOption(configId, value);
      live.configOptions = configOptions;
      this.events.onConfigOptions(id, configOptions);
      return { ok: true as const, configOptions };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  }

  async deleteSession(sessionId: string) {
    const live = this.live.get(sessionId);
    if (live) {
      live.handle?.dispose();
      this.live.delete(sessionId);
    }
    this.store.deleteSession(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      const next = this.listSessions().sessions[0];
      if (next) await this.switchSession(next.id);
    }
    this.emitSessionList();
    return { ok: true };
  }

  async sendPrompt(
    text: string,
    sessionId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = sessionId ?? this.activeSessionId;
    if (!id) {
      const created = await this.createSession({
        title: text.slice(0, 60),
      });
      if (!created.ok) return created;
      return this.sendPrompt(text, created.session.id);
    }

    const live = this.live.get(id);
    if (!live) return { ok: false as const, error: "Session not found" };

    if (!this.client || this.connectedAgentId !== live.summary.agentId) {
      const conn = await this.connectAgent(live.summary.agentId, live.summary.cwd);
      if (!conn.ok) return conn;
    }

    if (!live.handle) {
      await this.ensureHandle(id);
    }
    if (!live.handle) return { ok: false as const, error: "No session handle" };

    if (live.summary.title === "New session") {
      const title = text.slice(0, 60);
      live.summary = { ...live.summary, title, updatedAt: Date.now() };
      this.store.updateSession(id, { title });
      this.emitSessionList();
    }

    live.prompting = true;
    this.setConnection({
      status: "prompting",
      agentName: this.connectionState.agentName,
      sessionId: id,
    });

    // Persist the user's own message ourselves. We can't rely on the agent
    // echoing it back via user_message_chunk — many don't, which meant user
    // messages vanished on reload. The UI already shows this optimistically
    // (handlePrompt), so we only persist here — not re-emit — to avoid a
    // duplicate that the reducer would concatenate into "hellohello".
    const userUpdate: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    };
    this.store.appendEvent(id, userUpdate);

    // Seeded threads: give the agent the prior message as context once.
    let promptText = text;
    if (live.contextSeed) {
      promptText = formatSeededPrompt(live.contextSeed, text);
      live.contextSeed = null;
    }

    // Don't await the full turn — stream via events. But we should catch errors.
    void live.handle
      .prompt(promptText)
      .then(() => {
        live.prompting = false;
      })
      .catch((err) => {
        live.prompting = false;
        const message = err instanceof Error ? err.message : String(err);
        console.error("[session-manager] prompt failed:", message);
        this.setConnection({
          status: "error",
          error: message,
          agentName: this.connectionState.agentName,
          sessionId: id,
        });
      });

    return { ok: true as const };
  }

  async cancel(sessionId?: string) {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return { ok: false };
    const live = this.live.get(id);
    if (!live?.handle) return { ok: false };
    await live.handle.cancel();
    live.prompting = false;
    this.setConnection({
      status: "ready",
      agentName: this.connectionState.agentName,
      sessionId: id,
    });
    return { ok: true };
  }

  private queuePermission(
    params: RequestPermissionRequest & { requestId: string },
  ): Promise<RequestPermissionResponse> {
    const requestId = params.requestId;
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, params });

      const toolCall = params.toolCall;
      const req: PermissionRequest = {
        requestId,
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: toolCall.toolCallId ?? "unknown",
          title: toolCall.title ?? "Tool permission",
          kind: (toolCall.kind ?? undefined) as PermissionRequest["toolCall"]["kind"],
          status: toolCall.status ?? undefined,
          content: undefined,
          locations: toolCall.locations?.map((l) => ({
            path: l.path,
            line: l.line ?? undefined,
          })),
        },
        options: params.options.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
      };
      this.events.onPermissionRequest(req);
    });
  }

  respondPermission(requestId: string, optionId: string) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return { ok: false };
    this.pendingPermissions.delete(requestId);

    const opt = pending.params.options.find((o) => o.optionId === optionId);
    if (opt?.kind === "allow_always" && pending.params.toolCall.kind) {
      this.client?.rememberAlways(pending.params.toolCall.kind);
    }

    pending.resolve({
      outcome: { outcome: "selected", optionId },
    });
    return { ok: true };
  }

  async openFile(path: string, line?: number) {
    const editor = this.settings.editorCommand || "code";
    try {

      const args =
        editor === "code" || editor === "cursor" || editor.endsWith("code")
          ? ["-g", line ? `${path}:${line}` : path]
          : line
            ? [`+${line}`, path]
            : [path];
      const proc = Bun.spawn([editor, ...args], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });

      void proc;
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getGitBranch(cwd: string) {
    const branch = await getGitBranch(cwd);
    return { branch };
  }

  async dispose() {
    this.stopMemoryPolling();
    for (const live of this.live.values()) {
      live.handle?.dispose();
    }
    await this.client?.dispose();
    this.store.close();
  }
}

/** Persist seed context as a timeline message of the original role. */
function seedUpdateForRole(
  text: string,
  role: "user" | "agent" | "thought",
): SessionUpdate {
  const content = { type: "text" as const, text };
  if (role === "user") {
    return { sessionUpdate: "user_message_chunk", content };
  }
  if (role === "thought") {
    return { sessionUpdate: "thought_sequence_chunk", content };
  }
  return { sessionUpdate: "agent_message_chunk", content };
}

/**
 * Wrap the user's first prompt so the agent receives forked message context.
 * The seed is already shown in the UI timeline; this is for the model only.
 */
function formatSeededPrompt(seed: string, userText: string): string {
  return [
    "The following is starting context for this thread (from a prior message). Continue from it.",
    "",
    "---",
    seed,
    "---",
    "",
    userText,
  ].join("\n");
}
