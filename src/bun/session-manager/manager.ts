/**
 * Session manager: multi-session orchestration on the Bun side.
 * Each chat owns its own ACP agent process so sessions can run in parallel.
 */
import { basename } from "node:path";
import type {
  AgentInfo,
  AppSettings,
  CreateSessionWorktree,
  SessionConfigOption,
  UserQuestionDecision,
  UserQuestionRequest,
} from "../../shared/rpc";
import type { SessionUpdate } from "../../session/types";
import { ensureAgentsConfig, ensureGrokAgentEntry, loadAgents } from "../agents";
import { getGitBranch } from "../git-branch";
import { loadSettings, saveSettings } from "../settings";
import { SessionStore } from "../store";
import { createWorktree } from "../worktree";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  toGrokAskUserQuestionResponse,
  type GrokAskUserQuestionParsed,
  type GrokAskUserQuestionResponse,
} from "../user-question";
import { AgentConnection } from "./agent-connection";
import { resolveWorkingDirectory } from "./cwd";
import { openFileInEditor } from "./open-file";
import { toPermissionRequest } from "./permissions";
import { buildRecentProjects } from "./recent-projects";
import { injectBrowserTokensIntoPrompt } from "../browser-tokens";
import { formatSeededPrompt, seedUpdateForRole } from "./seed";
import type { LiveSession, SessionManagerEvents } from "./types";
import type { BrowserTokenRecord } from "../store";

function emptyLive(
  summary: LiveSession["summary"],
  extras?: Partial<LiveSession>,
): LiveSession {
  return {
    summary,
    handle: null,
    client: null,
    connectedAgentId: null,
    connectedProviderKey: null,
    connection: { status: "idle", sessionId: summary.id },
    commands: [],
    mode: "default",
    configOptions: [],
    prompting: false,
    usage: null,
    ...extras,
  };
}

export class SessionManager {
  private store: SessionStore;
  private settings: AppSettings;
  private agents: AgentInfo[] = [];
  private defaultAgentId = "";
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
  private pendingUserQuestions = new Map<
    string,
    {
      resolve: (r: GrokAskUserQuestionResponse) => void;
      params: GrokAskUserQuestionParsed;
    }
  >();
  private conn: AgentConnection;
  /** Serializes background agent prep so rapid session switches don't race. */
  private prepareChain: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    events: SessionManagerEvents,
    options?: {
      getBrowserControl?: () => { url: string; token: string } | null;
    },
  ) {
    this.store = new SessionStore(dataDir);
    this.settings = loadSettings(this.store);
    this.events = events;
    const mgr = this;
    this.conn = new AgentConnection({
      get settings() {
        return mgr.settings;
      },
      get store() {
        return mgr.store;
      },
      get live() {
        return mgr.live;
      },
      get events() {
        return mgr.events;
      },
      get activeSessionId() {
        return mgr.activeSessionId;
      },
      queuePermission: (params) => mgr.queuePermission(params),
      queueUserQuestion: (params) => mgr.queueUserQuestion(params),
      getBrowserControl: options?.getBrowserControl,
    });
  }

  async init() {
    await ensureAgentsConfig();
    await ensureGrokAgentEntry();
    const { agents, defaultAgentId } = await loadAgents();
    this.agents = agents;
    this.defaultAgentId =
      this.settings.defaultAgentId &&
      agents.some((a) => a.id === this.settings.defaultAgentId)
        ? this.settings.defaultAgentId
        : defaultAgentId || agents[0]?.id || "";

    for (const s of this.store.listSessions()) {
      this.live.set(
        s.id,
        emptyLive(s, {
          mode: this.store.getSession(s.id)?.mode ?? "default",
        }),
      );
    }

    this.emitSessionList();
  }

  getAgents() {
    return this.agents;
  }

  listBrowserTokens(projectCwd: string): BrowserTokenRecord[] {
    return this.store.listBrowserTokens(projectCwd);
  }

  upsertBrowserToken(input: {
    key: string;
    value: string;
    projectCwd: string;
    domain?: string;
    label?: string;
    sessionId?: string | null;
  }): BrowserTokenRecord {
    return this.store.upsertBrowserToken(input);
  }

  deleteBrowserToken(projectCwd: string, key: string): boolean {
    return this.store.deleteBrowserToken(projectCwd, key);
  }

  getSessionCwd(sessionId: string): string | null {
    return this.live.get(sessionId)?.summary.cwd ?? null;
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
    return this.conn.getActiveConnection();
  }

  listSessions(): {
    sessions: import("../../shared/rpc").SessionSummary[];
    activeSessionId: string | null;
  } {
    const sessions = [...this.live.values()]
      .map((l) => ({
        ...l.summary,
        // Process up or openSession in flight after spawn.
        agentRunning: l.client != null || l.handle != null,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions, activeSessionId: this.activeSessionId };
  }

  private emitSessionList() {
    const { sessions, activeSessionId } = this.listSessions();
    this.events.onSessionList(sessions, activeSessionId);
  }

  private uid() {
    return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Spawn/reconnect the agent process for a specific chat.
   * No-ops (stays idle) when there is no session — never auto-creates a chat
   * from process.cwd() (that was the packaged-app bin folder on startup).
   */
  async connectAgent(agentId?: string, cwd?: string, sessionId?: string) {
    const resolvedAgentId = agentId ?? this.defaultAgentId;
    const agent = this.agents.find((a) => a.id === resolvedAgentId);
    if (!agent) {
      this.events.onConnectionState({
        status: "error",
        error: `Unknown agent: ${resolvedAgentId}`,
      });
      return { ok: false as const, error: `Unknown agent: ${resolvedAgentId}` };
    }

    const id = sessionId ?? this.activeSessionId;
    if (!id) {
      // Default screen: chat + project picker only; session opens on create/send.
      this.conn.emitActiveConnection();
      return { ok: true as const };
    }

    const live = this.live.get(id);
    if (!live) return { ok: false as const, error: "Session not found" };
    return this.conn.connectSessionAgent(
      id,
      this.agents,
      resolvedAgentId,
      cwd ?? live.summary.cwd,
      () => this.emitSessionList(),
    );
  }

  private ensureHandle(sessionId: string, cwd?: string) {
    return this.conn.ensureHandle(sessionId, cwd, () => this.emitSessionList());
  }

  listRecentProjects(limit = 12) {
    return buildRecentProjects(
      this.listSessions().sessions,
      this.settings.dismissedRecentCwds ?? [],
      limit,
    );
  }

  removeRecentProject(cwd: string) {
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
    worktree?: CreateSessionWorktree;
    seedContext?: {
      text: string;
      role?: "user" | "agent" | "thought";
      purpose?: "continue" | "review";
    };
  }) {
    const rawCwd = (opts.cwd || this.settings.lastProjectCwd || process.cwd()).trim();
    const resolved = resolveWorkingDirectory(rawCwd);
    if (!resolved.ok) {
      return { ok: false as const, error: resolved.error };
    }
    let { cwd } = resolved;
    const mainCwd = cwd;
    const mainProjectName = basename(mainCwd);

    if (opts.worktree?.branch?.trim()) {
      const wt = await createWorktree({
        mainCwd,
        branch: opts.worktree.branch.trim(),
        createBranch: opts.worktree.createBranch,
        path: opts.worktree.path,
        symlinkPaths:
          this.settings.worktreeSymlinkPaths ?? ["node_modules"],
      });
      if (!wt.ok) {
        return { ok: false as const, error: wt.error };
      }
      cwd = wt.path;
    }

    const project = opts.project || mainProjectName;
    const agentId = opts.agentId || this.defaultAgentId;
    const id = this.uid();
    const seedText = opts.seedContext?.text?.trim() ?? "";
    const title =
      opts.title ||
      (seedText
        ? seedText.replace(/\s+/g, " ").slice(0, 60) || "New thread"
        : "New session");

    if (this.settings.lastProjectCwd !== mainCwd) {
      this.settings = saveSettings(this.store, { lastProjectCwd: mainCwd });
    }
    this.undismissRecentProject(mainCwd);

    const stored = this.store.createSession({
      id,
      title,
      project,
      cwd,
      agentId,
    });

    this.live.set(
      id,
      emptyLive(stored, {
        contextSeed: seedText || null,
        contextSeedPurpose: seedText
          ? (opts.seedContext?.purpose ?? "continue")
          : undefined,
      }),
    );
    this.activeSessionId = id;
    this.emitSessionList();

    const seedUpdates = seedText
      ? [seedUpdateForRole(seedText, opts.seedContext?.role ?? "agent")]
      : [];
    for (const u of seedUpdates) {
      this.store.appendEvent(id, u);
    }

    // Always spawn a dedicated agent for this chat (other chats keep running).
    const conn = await this.conn.connectSessionAgent(
      id,
      this.agents,
      agentId,
      cwd,
      () => this.emitSessionList(),
    );
    if (!conn.ok) {
      // Session still exists so the user can retry; surface the error.
      const live = this.live.get(id);
      this.events.onSessionLoaded(
        stored,
        seedUpdates,
        live?.mode ?? "default",
        live?.commands ?? [],
        live?.configOptions ?? [],
        live?.usage ?? null,
      );
      return { ok: false as const, error: conn.error };
    }

    const live = this.live.get(id);
    this.events.onSessionLoaded(
      stored,
      seedUpdates,
      live?.mode ?? "default",
      live?.commands ?? [],
      live?.configOptions ?? [],
      live?.usage ?? null,
    );
    this.conn.setSessionConnection(id, {
      status: "ready",
      agentName: this.agents.find((a) => a.id === agentId)?.name,
      sessionId: id,
    });

    return { ok: true as const, session: stored };
  }

  async switchSession(sessionId: string) {
    const live = this.live.get(sessionId);
    if (!live) return { ok: false as const, error: "Session not found" };

    this.activeSessionId = sessionId;
    const updates = this.store.loadEvents(sessionId);

    this.events.onSessionLoaded(
      live.summary,
      updates,
      live.mode,
      live.commands,
      live.configOptions,
      live.usage,
    );
    this.conn.emitActiveConnection();
    this.emitSessionList();
    this.conn.startMemoryPolling();

    // Ensure this chat has its own agent; never steals another chat's process.
    this.schedulePrepareSession(sessionId);

    return { ok: true as const, session: live.summary };
  }

  private schedulePrepareSession(sessionId: string) {
    this.prepareChain = this.prepareChain
      .then(() => this.prepareSessionAgent(sessionId))
      .catch((err) => {
        console.warn("[session-manager] prepare session agent failed:", err);
      });
  }

  /** Connect this chat's agent + open handle; no-ops if user switched away. */
  private async prepareSessionAgent(sessionId: string) {
    const live = this.live.get(sessionId);
    if (!live) return;
    if (this.activeSessionId !== sessionId) return;

    const conn = await this.conn.connectSessionAgent(
      sessionId,
      this.agents,
      live.summary.agentId,
      live.summary.cwd,
      () => this.emitSessionList(),
    );
    if (!conn.ok) return;
    if (this.activeSessionId !== sessionId) return;

    if (!live.handle && live.client) {
      try {
        await this.ensureHandle(sessionId);
      } catch (err) {
        console.warn("[session-manager] reopen handle failed:", err);
      }
    }

    if (this.activeSessionId !== sessionId) return;

    const refreshed = this.live.get(sessionId);
    if (refreshed && refreshed.configOptions.length > 0) {
      this.events.onConfigOptions(sessionId, refreshed.configOptions);
    }
    this.conn.emitActiveConnection();
    this.emitSessionList();
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

    if (!live.client || live.connectedAgentId !== live.summary.agentId) {
      const conn = await this.conn.connectSessionAgent(
        id,
        this.agents,
        live.summary.agentId,
        live.summary.cwd,
        () => this.emitSessionList(),
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
      await this.conn.killSessionAgent(sessionId, { emit: false });
      this.live.delete(sessionId);
    }
    this.store.deleteSession(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      const next = this.listSessions().sessions[0];
      if (next) await this.switchSession(next.id);
      else this.conn.emitActiveConnection();
    }
    this.emitSessionList();
    return { ok: true };
  }

  /**
   * Free agent memory for a session without deleting chat history.
   * Kills only this chat's ACP process; other sessions keep running.
   */
  async offloadSession(sessionId: string): Promise<
    | { ok: true; killed: boolean }
    | { ok: false; error: string }
  > {
    const live = this.live.get(sessionId);
    if (!live) return { ok: false as const, error: "Session not found" };

    if (live.prompting && live.handle) {
      try {
        await live.handle.cancel();
      } catch {
        /* best-effort */
      }
      live.prompting = false;
    }

    const killed = await this.conn.killSessionAgent(sessionId, { emit: false });

    if (this.activeSessionId === sessionId) {
      this.conn.emitActiveConnection();
    }
    this.emitSessionList();
    return { ok: true as const, killed };
  }

  async sendPrompt(
    text: string,
    sessionId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = sessionId ?? this.activeSessionId;
    if (!id) {
      // Only auto-create when a real project was chosen before (never process.cwd()).
      const projectCwd = this.settings.lastProjectCwd?.trim();
      if (!projectCwd) {
        return {
          ok: false as const,
          error: "Choose a project folder before sending a prompt.",
        };
      }
      const created = await this.createSession({
        title: text.slice(0, 60),
        cwd: projectCwd,
      });
      if (!created.ok) return created;
      return this.sendPrompt(text, created.session.id);
    }

    const live = this.live.get(id);
    if (!live) return { ok: false as const, error: "Session not found" };

    if (!live.client || live.connectedAgentId !== live.summary.agentId) {
      const conn = await this.conn.connectSessionAgent(
        id,
        this.agents,
        live.summary.agentId,
        live.summary.cwd,
        () => this.emitSessionList(),
      );
      if (!conn.ok) return conn;
    }

    if (!live.handle) {
      try {
        await this.ensureHandle(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    }
    if (!live.handle) return { ok: false as const, error: "No session handle" };

    if (live.summary.title === "New session") {
      const title = text.slice(0, 60);
      live.summary = { ...live.summary, title, updatedAt: Date.now() };
      this.store.updateSession(id, { title });
      this.emitSessionList();
    }

    live.prompting = true;
    this.conn.setSessionConnection(id, {
      status: "prompting",
      agentName:
        this.agents.find((a) => a.id === live.summary.agentId)?.name ??
        live.connection.agentName,
      sessionId: id,
    });

    const userUpdate: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    };
    this.store.appendEvent(id, userUpdate);

    let promptText = text;
    if (live.contextSeed) {
      promptText = formatSeededPrompt(
        live.contextSeed,
        text,
        live.contextSeedPurpose ?? "continue",
      );
      live.contextSeed = null;
      live.contextSeedPurpose = undefined;
    }

    try {
      const tokens = this.store.listBrowserTokens(live.summary.cwd);
      promptText = injectBrowserTokensIntoPrompt(promptText, tokens);
    } catch (err) {
      console.warn("[session-manager] browser token inject failed:", err);
    }

    void live.handle
      .prompt(promptText)
      .then((result) => {
        live.prompting = false;
        if (
          result.stopReason === "cancelled" &&
          live.connection.status === "prompting"
        ) {
          this.conn.setSessionConnection(id, {
            status: live.client ? "ready" : "idle",
            agentName: live.connection.agentName,
            sessionId: id,
          });
        }
      })
      .catch((err) => {
        live.prompting = false;
        const message = err instanceof Error ? err.message : String(err);
        if (
          /session disposed|session is not active|a prompt is already in progress/i.test(
            message,
          )
        ) {
          console.warn("[session-manager] prompt interrupted:", message);
          if (live.connection.status === "prompting") {
            this.conn.setSessionConnection(id, {
              status: live.client ? "ready" : "idle",
              agentName: live.connection.agentName,
              sessionId: id,
            });
          }
          return;
        }
        console.error("[session-manager] prompt failed:", message);
        this.conn.setSessionConnection(id, {
          status: "error",
          error: message,
          agentName: live.connection.agentName,
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
    this.conn.setSessionConnection(id, {
      status: "ready",
      agentName: live.connection.agentName,
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
      this.events.onPermissionRequest(toPermissionRequest(params));
    });
  }

  private queueUserQuestion(
    params: GrokAskUserQuestionParsed & { requestId: string },
  ): Promise<GrokAskUserQuestionResponse> {
    const requestId = params.requestId;
    return new Promise((resolve) => {
      this.pendingUserQuestions.set(requestId, { resolve, params });
      const agentSid = params.sessionId;
      const localId = agentSid
        ? (this.conn.agentToLocal.get(agentSid) ?? agentSid)
        : (this.activeSessionId ?? agentSid);
      const req: UserQuestionRequest = {
        requestId,
        sessionId: localId,
        toolCallId: params.toolCallId,
        questions: params.questions,
        annotations: params.annotations,
      };
      this.events.onUserQuestionRequest(req);
    });
  }

  respondPermission(requestId: string, optionId: string) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return { ok: false };
    this.pendingPermissions.delete(requestId);

    const opt = pending.params.options.find((o) => o.optionId === optionId);
    if (opt?.kind === "allow_always" && pending.params.toolCall.kind) {
      const agentSid = pending.params.sessionId;
      const localId = agentSid
        ? (this.conn.agentToLocal.get(agentSid) ?? agentSid)
        : this.activeSessionId;
      if (localId) {
        this.conn
          .clientForSession(localId)
          ?.rememberAlways(pending.params.toolCall.kind);
      }
    }

    pending.resolve({
      outcome: { outcome: "selected", optionId },
    });
    return { ok: true };
  }

  respondUserQuestion(decision: UserQuestionDecision) {
    const pending = this.pendingUserQuestions.get(decision.requestId);
    if (!pending) return { ok: false };
    this.pendingUserQuestions.delete(decision.requestId);

    if (decision.action === "accepted") {
      pending.resolve(
        toGrokAskUserQuestionResponse({
          action: "accepted",
          answers: decision.answers,
          partialAnswers: decision.partialAnswers,
        }),
      );
    } else if (decision.action === "skip_interview") {
      pending.resolve(
        toGrokAskUserQuestionResponse({ action: "skip_interview" }),
      );
    } else {
      pending.resolve(
        toGrokAskUserQuestionResponse({
          action: "chat_about_this",
          message: decision.message,
        }),
      );
    }
    return { ok: true };
  }

  async openFile(path: string, line?: number) {
    return openFileInEditor(this.settings.editorCommand || "code", path, line);
  }

  async getGitBranch(cwd: string) {
    const branch = await getGitBranch(cwd);
    return { branch };
  }

  async dispose() {
    await this.conn.dispose();
    this.live.clear();
    this.store.close();
  }
}
