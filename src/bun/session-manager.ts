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
  SessionSummary,
} from "../shared/rpc";
import type { SessionUpdate } from "../session/types";
import { AcpClient, type AcpSessionHandle } from "./acp-client";
import { ensureAgentsConfig, loadAgents } from "./agents";
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
  onSessionLoaded: (
    session: SessionSummary,
    updates: SessionUpdate[],
    mode: string,
    commands: AvailableCommand[],
  ) => void;
};

type LiveSession = {
  summary: SessionSummary;
  handle: AcpSessionHandle | null;
  commands: AvailableCommand[];
  mode: string;
  prompting: boolean;
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
    this.connectionState = state;
    this.events.onConnectionState(state);
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
      return { ok: true as const };
    }

    // Tear down previous client.
    if (this.client) {
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
          this.store.appendEvent(localId, update);
          const live = this.live.get(localId);
          if (live) {
            live.summary = {
              ...live.summary,
              updatedAt: Date.now(),
              title:
                live.summary.title === "New session" &&
                update.sessionUpdate === "user_message_chunk" &&
                update.content.type === "text"
                  ? update.content.text.slice(0, 60)
                  : live.summary.title,
            };
            if (
              live.summary.title !== "New session" &&
              update.sessionUpdate === "user_message_chunk" &&
              update.content.type === "text"
            ) {
              this.store.updateSession(localId, { title: live.summary.title });
            }
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

      // If there's an active session without a handle, open one.
      if (this.activeSessionId) {
        await this.ensureHandle(this.activeSessionId, cwd);
      }

      return { ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[session-manager] connect failed:", message);
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

    live.handle = {
      sessionId,
      prompt: async (text: string) => handle.prompt(text),
      cancel: () => handle.cancel(),
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
    const seen = new Set<string>();
    const out: RecentProject[] = [];
    for (const s of this.listSessions().sessions) {
      const cwd = s.cwd?.trim();
      if (!cwd || seen.has(cwd)) continue;
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

  async createSession(opts: {
    title?: string;
    project?: string;
    cwd?: string;
    agentId?: string;
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
    const title = opts.title || "New session";

    // Remember for next "New task" dialog default.
    if (this.settings.lastProjectCwd !== cwd) {
      this.settings = saveSettings(this.store, { lastProjectCwd: cwd });
    }

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
      prompting: false,
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

    this.events.onSessionLoaded(stored, [], "default", []);
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

    // Connect agent for this session if needed.
    await this.connectAgent(live.summary.agentId, live.summary.cwd);

    if (!live.handle && this.client) {
      try {
        await this.ensureHandle(sessionId);
      } catch (err) {
        console.warn("[session-manager] reopen handle failed:", err);
      }
    }

    this.events.onSessionLoaded(
      live.summary,
      updates,
      live.mode,
      live.commands,
    );
    this.emitSessionList();
    this.setConnection({
      ...this.connectionState,
      sessionId,
    });
    return { ok: true as const, session: live.summary };
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

    // Don't await the full turn — stream via events. But we should catch errors.
    void live.handle
      .prompt(text)
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
      // Common editors: code/cursor take -g file:line; vim/nvim +line file
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
      // Don't await exit — editor may stay open.
      void proc;
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async dispose() {
    for (const live of this.live.values()) {
      live.handle?.dispose();
    }
    await this.client?.dispose();
    this.store.close();
  }
}
