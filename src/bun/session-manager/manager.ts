/**
 * Session manager: multi-session orchestration on the Bun side.
 * Owns the active ACP client, permission queue, and persistence.
 */
import { basename } from "node:path";
import type {
  AgentInfo,
  AppSettings,
  CreateSessionWorktree,
  SessionConfigOption,
} from "../../shared/rpc";
import type { SessionUpdate } from "../../session/types";
import { ensureAgentsConfig, loadAgents } from "../agents";
import { getGitBranch } from "../git-branch";
import { loadSettings, saveSettings } from "../settings";
import { SessionStore } from "../store";
import { createWorktree } from "../worktree";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { AgentConnection } from "./agent-connection";
import { resolveWorkingDirectory } from "./cwd";
import { openFileInEditor } from "./open-file";
import { toPermissionRequest } from "./permissions";
import { buildRecentProjects } from "./recent-projects";
import { injectBrowserTokensIntoPrompt } from "../browser-tokens";
import { formatSeededPrompt, seedUpdateForRole } from "./seed";
import type { LiveSession, SessionManagerEvents } from "./types";
import type { BrowserTokenRecord } from "../store";

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
    // Live getters so AgentConnection always sees current SessionManager state.
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
      getBrowserControl: options?.getBrowserControl,
    });
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
        usage: null,
      });
    }

    this.emitSessionList();
  }

  getAgents() {
    return this.agents;
  }

  /** Project-scoped browser tokens stored in SQLite. */
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

  /** Resolve project cwd for a chat session (for token scoping). */
  getSessionCwd(sessionId: string): string | null {
    return this.live.get(sessionId)?.summary.cwd ?? null;
  }

  getSettings() {
    return this.settings;
  }

  saveSettings(patch: Partial<AppSettings>) {
    this.settings = saveSettings(this.store, patch);
    if (patch.defaultAgentId) this.defaultAgentId = patch.defaultAgentId;
    // Provider credentials/model mapping live in process env. connectAgent
    // compares providerConnectionKey and respawns when they diverge.
    return this.settings;
  }

  getConnectionState() {
    return this.conn.connectionState;
  }

  listSessions(): {
    sessions: import("../../shared/rpc").SessionSummary[];
    activeSessionId: string | null;
  } {
    const clientUp = this.conn.client != null;
    const sessions = [...this.live.values()]
      .map((l) => {
        // Agent process is up for this chat when we have a live handle, or
        // this is the active session and its agent process is currently connected
        // (openSession may still be in flight after history loads).
        const ownsHandle = l.handle != null;
        const activeAgentConnected =
          l.summary.id === this.activeSessionId &&
          clientUp &&
          this.conn.connectedAgentId === l.summary.agentId;
        return {
          ...l.summary,
          agentRunning: clientUp && (ownsHandle || activeAgentConnected),
        };
      })
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

  async connectAgent(agentId?: string, cwd?: string) {
    const id = agentId ?? this.defaultAgentId;
    return this.conn.connectAgent(
      this.agents,
      id,
      cwd,
      () => this.emitSessionList(),
    );
  }

  private ensureHandle(sessionId: string, cwd?: string) {
    return this.conn.ensureHandle(sessionId, cwd, () => this.emitSessionList());
  }

  /**
   * Distinct project folders from recent sessions (most recently used first).
   */
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
      /** How the seed is framed on the first prompt (default: continue). */
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

    // Optional: open the session inside a git worktree (shared heavy dirs
    // like node_modules are symlinked from the main tree per settings).
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

    // Prefer the main repo folder name even when cwd is a worktree path.
    const project = opts.project || mainProjectName;
    const agentId = opts.agentId || this.defaultAgentId;
    const id = this.uid();
    const seedText = opts.seedContext?.text?.trim() ?? "";
    const title =
      opts.title ||
      (seedText
        ? seedText.replace(/\s+/g, " ").slice(0, 60) || "New thread"
        : "New session");

    // Remember the main project for the next "New task" dialog (not the worktree).
    if (this.settings.lastProjectCwd !== mainCwd) {
      this.settings = saveSettings(this.store, { lastProjectCwd: mainCwd });
    }
    // Re-using a project restores it if it was removed from recents.
    this.undismissRecentProject(mainCwd);

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
      usage: null,
      contextSeed: seedText || null,
      contextSeedPurpose: seedText
        ? (opts.seedContext?.purpose ?? "continue")
        : undefined,
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
      live?.usage ?? null,
    );
    this.conn.setConnection({
      ...this.conn.connectionState,
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
      live.usage,
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

    if (!live.handle && this.conn.client) {
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

    this.conn.setConnection({
      ...this.conn.connectionState,
      sessionId,
    });
    // Ensure sidebar gets agentRunning even if ensureHandle was a no-op
    // (handle already present from a prior open).
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

    if (!this.conn.client || this.conn.connectedAgentId !== live.summary.agentId) {
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

  /**
   * Free agent memory for a session without deleting chat history.
   * Disposes the session handle and kills the shared ACP agent process when
   * nothing else is mid-turn. The agent respawns on next prompt / switch.
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

    live.handle?.dispose();
    live.handle = null;
    for (const [agentSessionId, localId] of [...this.conn.agentToLocal.entries()]) {
      if (localId === sessionId) this.conn.agentToLocal.delete(agentSessionId);
    }

    // Keep the agent alive if another session is actively prompting.
    const otherPrompting = [...this.live.entries()].some(
      ([id, l]) => id !== sessionId && l.prompting,
    );
    if (otherPrompting || !this.conn.client) {
      if (this.activeSessionId === sessionId) {
        this.conn.setConnection({
          status: this.conn.client ? "ready" : "idle",
          agentName: this.conn.connectionState.agentName,
          sessionId,
        });
      }
      this.emitSessionList();
      return { ok: true as const, killed: false };
    }

    await this.conn.killAgent();
    // Drop unresolved permission prompts tied to the dead agent.
    this.pendingPermissions.clear();
    this.conn.setConnection({ status: "idle" });
    this.emitSessionList();
    return { ok: true as const, killed: true };
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

    if (!this.conn.client || this.conn.connectedAgentId !== live.summary.agentId) {
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
    this.conn.setConnection({
      status: "prompting",
      agentName: this.conn.connectionState.agentName,
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
      promptText = formatSeededPrompt(
        live.contextSeed,
        text,
        live.contextSeedPurpose ?? "continue",
      );
      live.contextSeed = null;
      live.contextSeedPurpose = undefined;
    }

    // Inject project browser tokens into the agent prompt only (UI/history keep
    // the clean user text). Lets multi-step OAuth tokens skip re-login.
    try {
      const tokens = this.store.listBrowserTokens(live.summary.cwd);
      promptText = injectBrowserTokensIntoPrompt(promptText, tokens);
    } catch (err) {
      console.warn("[session-manager] browser token inject failed:", err);
    }

    // Don't await the full turn — stream via events. But we should catch errors.
    void live.handle
      .prompt(promptText)
      .then((result) => {
        live.prompting = false;
        // If the session was disposed mid-prompt, stopUpdatePump resolves with
        // cancelled and onTurnEnd may not run — restore a non-error state.
        if (
          result.stopReason === "cancelled" &&
          this.activeSessionId === id &&
          this.conn.connectionState.status === "prompting"
        ) {
          this.conn.setConnection({
            status: this.conn.client ? "ready" : "idle",
            agentName: this.conn.connectionState.agentName,
            sessionId: id,
          });
        }
      })
      .catch((err) => {
        live.prompting = false;
        const message = err instanceof Error ? err.message : String(err);
        // Benign lifecycle races (switch/offload/dispose while prompting).
        // Do not paint the connection banner as if the agent binary is broken.
        if (
          /session disposed|session is not active|a prompt is already in progress/i.test(
            message,
          )
        ) {
          console.warn("[session-manager] prompt interrupted:", message);
          if (
            this.activeSessionId === id &&
            this.conn.connectionState.status === "prompting"
          ) {
            this.conn.setConnection({
              status: this.conn.client ? "ready" : "idle",
              agentName: this.conn.connectionState.agentName,
              sessionId: id,
            });
          }
          return;
        }
        console.error("[session-manager] prompt failed:", message);
        this.conn.setConnection({
          status: "error",
          error: message,
          agentName: this.conn.connectionState.agentName,
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
    this.conn.setConnection({
      status: "ready",
      agentName: this.conn.connectionState.agentName,
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

  respondPermission(requestId: string, optionId: string) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return { ok: false };
    this.pendingPermissions.delete(requestId);

    const opt = pending.params.options.find((o) => o.optionId === optionId);
    if (opt?.kind === "allow_always" && pending.params.toolCall.kind) {
      this.conn.client?.rememberAlways(pending.params.toolCall.kind);
    }

    pending.resolve({
      outcome: { outcome: "selected", optionId },
    });
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
    for (const live of this.live.values()) {
      live.handle?.dispose();
    }
    await this.conn.dispose();
    this.store.close();
  }
}
