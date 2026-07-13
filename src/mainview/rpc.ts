/**
 * Webview-side Electrobun RPC client. When running in the browser (dev:web)
 * without Electrobun, we fall back to a local mock so the UI still works.
 */
import { Electroview } from "electrobun/view";
import type {
  AgentInfo,
  AppSettings,
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  RecentProject,
  AgentSetupStatus,
  RemoteAccessStatus,
  SessionConfigOption,
  SessionListPayload,
  SessionLoadedPayload,
  SessionUsage,
  SkillInfo,
  ProjectHarness,
  SavedCommand,
  CommandRunSummary,
  TerminalRPC,
  TurnEndPayload,
} from "../shared/rpc";
import type { SessionUpdate } from "../session/types";
import type {
  BrowserControlRequest,
  BrowserControlResponse,
} from "../shared/browser-control";
import { waitForBrowserPanel } from "./browser/registry";

export type RpcListeners = {
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  onTurnEnd?: (payload: TurnEndPayload) => void;
  onConnectionState?: (state: ConnectionStatePayload) => void;
  onPermissionRequest?: (req: PermissionRequest) => void;
  onSessionList?: (payload: SessionListPayload) => void;
  onSessionLoaded?: (payload: SessionLoadedPayload) => void;
  onCommands?: (sessionId: string, commands: AvailableCommand[]) => void;
  onMode?: (sessionId: string, mode: string) => void;
  onConfigOptions?: (
    sessionId: string,
    configOptions: SessionConfigOption[],
  ) => void;
  onUsage?: (sessionId: string, usage: SessionUsage) => void;
  onBrowserOpen?: (payload: {
    sessionId: string;
    url?: string;
  }) => void;
};

type RpcClient = {
  request: {
    sendPrompt: (p: {
      text: string;
      sessionId?: string;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
    cancel: (p?: { sessionId?: string }) => Promise<{ ok: boolean }>;
    listAgents: () => Promise<{ agents: AgentInfo[] }>;
    listSessions: () => Promise<SessionListPayload>;
    createSession: (p: {
      title?: string;
      project?: string;
      cwd?: string;
      agentId?: string;
      worktree?: {
        branch: string;
        createBranch?: boolean;
        path?: string;
      };
      seedContext?: {
        text: string;
        role?: "user" | "agent" | "thought";
        purpose?: "continue" | "review";
      };
    }) => Promise<
      | { ok: true; session: SessionListPayload["sessions"][number] }
      | { ok: false; error: string }
    >;
    switchSession: (
      p: { sessionId: string },
    ) => Promise<
      | { ok: true; session: SessionListPayload["sessions"][number] }
      | { ok: false; error: string }
    >;
    deleteSession: (p: { sessionId: string }) => Promise<{ ok: boolean }>;
    offloadSession: (
      p: { sessionId: string },
    ) => Promise<
      { ok: true; killed: boolean } | { ok: false; error: string }
    >;
    respondPermission: (p: {
      requestId: string;
      optionId: string;
    }) => Promise<{ ok: boolean }>;
    openFile: (p: {
      path: string;
      line?: number;
    }) => Promise<{ ok: boolean; error?: string }>;
    getSettings: () => Promise<AppSettings>;
    saveSettings: (p: Partial<AppSettings>) => Promise<AppSettings>;
    getConnectionState: () => Promise<ConnectionStatePayload>;
    connectAgent: (p?: {
      agentId?: string;
      cwd?: string;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
    pickFolder: (p?: {
      startingFolder?: string;
    }) => Promise<
      | { ok: true; path: string }
      | { ok: false; cancelled?: boolean; error?: string }
    >;
    saveTextFile: (p: {
      content: string;
      defaultName: string;
      startingFolder?: string;
      prompt?: string;
    }) => Promise<
      | { ok: true; path: string }
      | { ok: false; cancelled?: boolean; error?: string }
    >;
    listRecentProjects: () => Promise<{ projects: RecentProject[] }>;
    removeRecentProject: (p: {
      cwd: string;
    }) => Promise<{ ok: boolean; projects: RecentProject[] }>;
    writeClipboard: (p: {
      text: string;
    }) => Promise<{ ok: boolean; error?: string }>;
    readClipboard: () => Promise<
      { ok: true; text: string } | { ok: false; error?: string }
    >;
    getGitBranch: (p: {
      cwd: string;
    }) => Promise<{ branch: string | null }>;
    windowControl: (p: {
      action: "close" | "minimize" | "maximize";
    }) => Promise<{ ok: true } | { ok: false; error?: string }>;
    setConfigOption: (p: {
      sessionId?: string;
      configId: string;
      value: string | boolean;
    }) => Promise<
      | { ok: true; configOptions: SessionConfigOption[] }
      | { ok: false; error: string }
    >;
    showDesktopNotification: (p: {
      title: string;
      body?: string;
      subtitle?: string;
      silent?: boolean;
    }) => Promise<{ ok: boolean; error?: string }>;
    getRemoteAccess: () => Promise<RemoteAccessStatus>;
    startRemoteAccess: () => Promise<RemoteAccessStatus>;
    stopRemoteAccess: () => Promise<RemoteAccessStatus>;
    regenerateRemoteAccess: () => Promise<RemoteAccessStatus>;
    getAgentSetup: () => Promise<AgentSetupStatus>;
    ensureAgentSetup: () => Promise<AgentSetupStatus>;
    listSkills: (p?: {
      projectCwd?: string | null;
    }) => Promise<{ skills: SkillInfo[] }>;
    installSkill: (p: {
      package: string;
    }) => Promise<
      { ok: true; skills: SkillInfo[] } | { ok: false; error: string }
    >;
    setSkillEnabled: (p: {
      skillId: string;
      enabled: boolean;
    }) => Promise<
      | { ok: true; skill: SkillInfo; skills: SkillInfo[] }
      | { ok: false; error: string }
    >;
    uninstallSkill: (p: {
      skillId: string;
    }) => Promise<
      { ok: true; skills: SkillInfo[] } | { ok: false; error: string }
    >;
    getProjectHarness: (p: {
      cwd: string;
      project?: string;
    }) => Promise<ProjectHarness>;
    applyProjectHarness: (p: {
      cwd: string;
      optimizationId: string;
      project?: string;
    }) => Promise<
      | {
          ok: true;
          harness: ProjectHarness;
          written: string[];
        }
      | { ok: false; error: string }
    >;
    listUserCommands: (p: {
      projectCwd: string;
    }) => Promise<{ commands: SavedCommand[] }>;
    addUserCommand: (p: {
      projectCwd: string;
      name: string;
      command: string;
    }) => Promise<
      | { ok: true; command: SavedCommand; commands: SavedCommand[] }
      | { ok: false; error: string }
    >;
    removeUserCommand: (p: {
      projectCwd: string;
      commandId: string;
    }) => Promise<
      { ok: true; commands: SavedCommand[] } | { ok: false; error: string }
    >;
    runUserCommand: (p: {
      projectCwd: string;
      commandId: string;
    }) => Promise<
      { ok: true; run: CommandRunSummary } | { ok: false; error: string }
    >;
    stopUserCommandRun: (p: {
      runId: string;
    }) => Promise<
      { ok: true; run: CommandRunSummary } | { ok: false; error: string }
    >;
    listUserCommandRuns: (p: {
      projectCwd: string;
    }) => Promise<{ runs: CommandRunSummary[] }>;
    getUserCommandRunLog: (p: {
      runId: string;
    }) => Promise<
      | {
          ok: true;
          run: CommandRunSummary;
          log: string;
          truncated: boolean;
        }
      | { ok: false; error: string }
    >;
  };
};

let client: RpcClient | null = null;
let listeners: RpcListeners = {};

function isElectrobun(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __electrobunWebviewId?: number }).__electrobunWebviewId;
}

/** Access code injected by the remote-access HTTP server, or parsed from /r/<code>. */
export function detectRemoteAccessCode(): string | null {
  if (typeof window === "undefined") return null;
  const injected = (
    window as unknown as { __TERMINAL_REACT_REMOTE__?: { code?: string } }
  ).__TERMINAL_REACT_REMOTE__?.code;
  if (injected && typeof injected === "string") return injected;
  const m = window.location.pathname.match(/^\/r\/([^/]+)/);
  return m?.[1] ?? null;
}

export function isRemoteAccessClient(): boolean {
  return detectRemoteAccessCode() != null;
}

export function setRpcListeners(next: RpcListeners) {
  listeners = next;
}

export function initRpc(): RpcClient {
  if (client) return client;

  // Phone/browser remote mirror: talk to the desktop over WebSocket.
  const remoteCode = detectRemoteAccessCode();
  if (remoteCode) {
    console.info("[rpc] remote access mode, code=", remoteCode.slice(0, 4) + "…");
    client = createRemoteWsClient(remoteCode);
    return client;
  }

  if (isElectrobun()) {
    // Electrobun default maxRequestTime is 1s — far too short for native
    // folder pickers (and anything else that waits on the user). Match the
    // bun-side budget so pickFolder can complete after the dialog closes.
    const rpc = Electroview.defineRPC<TerminalRPC>({
      maxRequestTime: 600_000,
      handlers: {
        requests: {
          browserControl: async (
            params: BrowserControlRequest,
          ): Promise<BrowserControlResponse> => {
            // onBrowserOpen is sent just before this RPC; give React a moment
            // to mount BrowserPanel and register the handler.
            const handler = await waitForBrowserPanel(params.sessionId, 8000);
            if (!handler) {
              return {
                ok: false,
                error:
                  `Built-in browser panel did not mount for session ${params.sessionId.slice(0, 12)}… ` +
                  "It should open automatically on browser_navigate; " +
                  "click the globe icon if it stays closed.",
              };
            }
            return handler(params);
          },
        },
        messages: {
          onUpdate: ({ sessionId, update }) => {
            listeners.onUpdate?.(sessionId, update);
          },
          onTurnEnd: (payload) => {
            listeners.onTurnEnd?.(payload);
          },
          onConnectionState: (state) => {
            listeners.onConnectionState?.(state);
          },
          onPermissionRequest: (req) => {
            listeners.onPermissionRequest?.(req);
          },
          onSessionList: (payload) => {
            listeners.onSessionList?.(payload);
          },
          onSessionLoaded: (payload) => {
            listeners.onSessionLoaded?.(payload);
          },
          onCommands: ({ sessionId, commands }) => {
            listeners.onCommands?.(sessionId, commands);
          },
          onMode: ({ sessionId, mode }) => {
            listeners.onMode?.(sessionId, mode);
          },
          onConfigOptions: ({ sessionId, configOptions }) => {
            listeners.onConfigOptions?.(sessionId, configOptions);
          },
          onUsage: ({ sessionId, usage }) => {
            listeners.onUsage?.(sessionId, usage);
          },
          onBrowserOpen: (payload) => {
            listeners.onBrowserOpen?.(payload);
          },
        },
      },
    });
    new Electroview({ rpc });
    client = { request: rpc.request as RpcClient["request"] };
    return client;
  }

  console.info("[rpc] Electrobun not detected — using browser RPC stub");
  client = createBrowserMock();
  return client;
}

function createRemoteWsClient(code: string): RpcClient {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${window.location.host}/r/${code}/ws`;

  type Pending = {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  };
  const pending = new Map<string, Pending>();
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reqSeq = 0;
  let openPromise: Promise<void> | null = null;

  const dispatchMessage = (name: string, params: Record<string, unknown>) => {
    switch (name) {
      case "onUpdate":
        listeners.onUpdate?.(
          params.sessionId as string,
          params.update as SessionUpdate,
        );
        break;
      case "onTurnEnd":
        listeners.onTurnEnd?.(params as unknown as TurnEndPayload);
        break;
      case "onConnectionState":
        listeners.onConnectionState?.(
          params as unknown as ConnectionStatePayload,
        );
        break;
      case "onPermissionRequest":
        listeners.onPermissionRequest?.(
          params as unknown as PermissionRequest,
        );
        break;
      case "onSessionList":
        listeners.onSessionList?.(params as unknown as SessionListPayload);
        break;
      case "onSessionLoaded":
        listeners.onSessionLoaded?.(params as unknown as SessionLoadedPayload);
        break;
      case "onCommands":
        listeners.onCommands?.(
          params.sessionId as string,
          params.commands as AvailableCommand[],
        );
        break;
      case "onMode":
        listeners.onMode?.(params.sessionId as string, params.mode as string);
        break;
      case "onConfigOptions":
        listeners.onConfigOptions?.(
          params.sessionId as string,
          params.configOptions as SessionConfigOption[],
        );
        break;
      case "onUsage":
        listeners.onUsage?.(
          params.sessionId as string,
          params.usage as SessionUsage,
        );
        break;
      default:
        console.warn("[rpc/remote] unknown message", name);
    }
  };

  const connect = (): Promise<void> => {
    if (ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        openPromise = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      ws.onopen = () => {
        openPromise = null;
        resolve();
      };
      ws.onerror = () => {
        openPromise = null;
        reject(new Error("WebSocket connection failed"));
      };
      ws.onclose = () => {
        openPromise = null;
        ws = null;
        // Reject in-flight requests.
        for (const [id, p] of pending) {
          p.reject(new Error("WebSocket closed"));
          pending.delete(id);
        }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          void connect().catch(() => {
            /* retry later on next request */
          });
        }, 1500);
      };
      ws.onmessage = (ev) => {
        let msg: {
          type?: string;
          id?: string;
          result?: unknown;
          error?: string;
          name?: string;
          params?: Record<string, unknown>;
        };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "response" && msg.id) {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
          return;
        }
        if (msg.type === "message" && msg.name) {
          dispatchMessage(msg.name, msg.params ?? {});
        }
      };
    });
    return openPromise;
  };

  const request = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    await connect();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Remote access WebSocket not connected");
    }
    const id = `r${++reqSeq}-${Date.now().toString(36)}`;
    const result = await new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws!.send(JSON.stringify({ type: "request", id, method, params: params ?? {} }));
      // Safety timeout (folder pick etc. can be long; remote doesn't pick folders).
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Remote request timed out: ${method}`));
        }
      }, 120_000);
    });
    return result as T;
  };

  // Kick off connection early.
  void connect().catch((err) => {
    console.warn("[rpc/remote] initial connect failed:", err);
  });

  const idleRemote: RemoteAccessStatus = {
    running: true,
    code,
    port: null,
    url: window.location.href,
    urls: [window.location.href],
    lanIps: [],
  };

  return {
    request: {
      sendPrompt: (p) => request("sendPrompt", p as Record<string, unknown>),
      cancel: (p) => request("cancel", (p ?? {}) as Record<string, unknown>),
      listAgents: () => request("listAgents"),
      listSessions: () => request("listSessions"),
      createSession: (p) =>
        request("createSession", p as Record<string, unknown>),
      switchSession: (p) =>
        request("switchSession", p as Record<string, unknown>),
      deleteSession: (p) =>
        request("deleteSession", p as Record<string, unknown>),
      offloadSession: (p) =>
        request("offloadSession", p as Record<string, unknown>),
      respondPermission: (p) =>
        request("respondPermission", p as Record<string, unknown>),
      openFile: (p) => request("openFile", p as Record<string, unknown>),
      getSettings: () => request("getSettings"),
      saveSettings: (p) =>
        request("saveSettings", p as Record<string, unknown>),
      getConnectionState: () => request("getConnectionState"),
      connectAgent: (p) =>
        request("connectAgent", (p ?? {}) as Record<string, unknown>),
      pickFolder: (p) =>
        request("pickFolder", (p ?? {}) as Record<string, unknown>),
      saveTextFile: (p) =>
        request("saveTextFile", p as Record<string, unknown>),
      listRecentProjects: () => request("listRecentProjects"),
      removeRecentProject: (p) =>
        request("removeRecentProject", p as Record<string, unknown>),
      writeClipboard: (p) =>
        request("writeClipboard", p as Record<string, unknown>),
      readClipboard: () =>
        request("readClipboard", {}) as Promise<
          { ok: true; text: string } | { ok: false; error?: string }
        >,
      getGitBranch: (p) =>
        request("getGitBranch", p as Record<string, unknown>),
      windowControl: async () => ({
        ok: false as const,
        error: "No window control on remote",
      }),
      setConfigOption: (p) =>
        request("setConfigOption", p as Record<string, unknown>),
      showDesktopNotification: async () => ({ ok: true }),
      getRemoteAccess: async () => idleRemote,
      startRemoteAccess: async () => idleRemote,
      stopRemoteAccess: async () => idleRemote,
      regenerateRemoteAccess: async () => idleRemote,
      getAgentSetup: () => request("getAgentSetup") as Promise<AgentSetupStatus>,
      ensureAgentSetup: () =>
        request("ensureAgentSetup") as Promise<AgentSetupStatus>,
      listSkills: (p) =>
        request("listSkills", (p ?? {}) as Record<string, unknown>),
      installSkill: (p) =>
        request("installSkill", p as Record<string, unknown>),
      setSkillEnabled: (p) =>
        request("setSkillEnabled", p as Record<string, unknown>),
      uninstallSkill: (p) =>
        request("uninstallSkill", p as Record<string, unknown>),
      getProjectHarness: (p) =>
        request("getProjectHarness", p as Record<string, unknown>),
      applyProjectHarness: (p) =>
        request("applyProjectHarness", p as Record<string, unknown>),
      listUserCommands: (p) =>
        request("listUserCommands", p as Record<string, unknown>),
      addUserCommand: (p) =>
        request("addUserCommand", p as Record<string, unknown>),
      removeUserCommand: (p) =>
        request("removeUserCommand", p as Record<string, unknown>),
      runUserCommand: (p) =>
        request("runUserCommand", p as Record<string, unknown>),
      stopUserCommandRun: (p) =>
        request("stopUserCommandRun", p as Record<string, unknown>),
      listUserCommandRuns: (p) =>
        request("listUserCommandRuns", p as Record<string, unknown>),
      getUserCommandRunLog: (p) =>
        request("getUserCommandRunLog", p as Record<string, unknown>),
    },
  };
}

export function getRpc(): RpcClient {
  return client ?? initRpc();
}

function createBrowserMock(): RpcClient {
  let status: ConnectionStatePayload = {
    status: "idle",
  };
  const sessions: SessionListPayload["sessions"] = [];
  let activeSessionId: string | null = null;
  /** sessionId → recorded session/update stream (for browser demo reload). */
  const sessionUpdates = new Map<string, SessionUpdate[]>();
  const dismissedRecentCwds = new Set<string>();
  let demoSeedPromise: Promise<void> | null = null;

  const emit = {
    update: (sessionId: string, update: SessionUpdate) =>
      listeners.onUpdate?.(sessionId, update),
    turnEnd: (sessionId: string, stopReason: string) =>
      listeners.onTurnEnd?.({ sessionId, stopReason }),
    conn: (s: ConnectionStatePayload) => {
      status = s;
      listeners.onConnectionState?.(s);
    },
    list: () =>
      listeners.onSessionList?.({ sessions: [...sessions], activeSessionId }),
    loaded: (
      session: SessionListPayload["sessions"][number],
      updates: SessionUpdate[],
    ) =>
      listeners.onSessionLoaded?.({
        session,
        updates,
        mode: "default",
        commands: [],
      }),
  };

  async function ensureDemoSession() {
    if (sessions.length > 0) return;
    if (!demoSeedPromise) {
      demoSeedPromise = (async () => {
        if (sessions.length > 0) return;
        const { demoUpdates } = await import("../fixtures/demo");
        const session = {
          id: "demo-session",
          title: "Demo session",
          project: "demo",
          cwd: "/tmp/demo-project",
          agentId: "demo",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        sessions.push(session);
        activeSessionId = session.id;
        sessionUpdates.set(session.id, demoUpdates);
        // Defer so App's setRpcListeners has run before we push state.
        setTimeout(() => {
          emit.list();
          emit.loaded(session, demoUpdates);
          emit.conn({ status: "ready", agentName: "Demo (browser)" });
        }, 0);
      })();
    }
    await demoSeedPromise;
  }

  // Kick ready state.
  setTimeout(() => emit.conn(status), 0);

  return {
    request: {
      async sendPrompt() {
        return {
          ok: false as const,
          error: "Run the desktop app (bun run dev) to connect to an ACP agent.",
        };
      },
      async cancel() {
        emit.conn({ ...status, status: "ready" });
        return { ok: true };
      },
      async listAgents() {
        return { agents: [] };
      },
      async listSessions() {
        // Browser-only: seed one demo chat so Timeline/LegendList is testable.
        await ensureDemoSession();
        return { sessions: [...sessions], activeSessionId };
      },
      async createSession({ title, project, cwd, agentId, seedContext }) {
        const folder = cwd || "/tmp/demo-project";
        const name =
          project ||
          folder.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ||
          "local";
        const seedText = seedContext?.text?.trim() ?? "";
        const session = {
          id: `local-${Date.now()}`,
          title:
            title ||
            (seedText
              ? seedText.replace(/\s+/g, " ").slice(0, 60) || "New thread"
              : "New session"),
          project: name,
          cwd: folder,
          agentId: agentId || "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        sessions.unshift(session);
        activeSessionId = session.id;
        const seedUpdates: SessionUpdate[] = [];
        if (seedText) {
          const content = { type: "text" as const, text: seedText };
          const role = seedContext?.role ?? "agent";
          if (role === "user") {
            seedUpdates.push({ sessionUpdate: "user_message_chunk", content });
          } else if (role === "thought") {
            seedUpdates.push({
              sessionUpdate: "thought_sequence_chunk",
              content,
            });
          } else {
            seedUpdates.push({ sessionUpdate: "agent_message_chunk", content });
          }
        }
        sessionUpdates.set(session.id, seedUpdates);
        emit.list();
        emit.loaded(session, seedUpdates);
        emit.conn({ status: "ready", agentName: "Demo (browser)" });
        return { ok: true as const, session };
      },
      async switchSession({ sessionId }) {
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) return { ok: false as const, error: "not found" };
        activeSessionId = sessionId;
        emit.list();
        emit.loaded(session, sessionUpdates.get(sessionId) ?? []);
        return { ok: true as const, session };
      },
      async deleteSession({ sessionId }) {
        const idx = sessions.findIndex((s) => s.id === sessionId);
        if (idx >= 0) sessions.splice(idx, 1);
        if (activeSessionId === sessionId) activeSessionId = sessions[0]?.id ?? null;
        emit.list();
        return { ok: true };
      },
      async offloadSession({ sessionId }) {
        if (!sessions.some((s) => s.id === sessionId)) {
          return { ok: false as const, error: "Session not found" };
        }
        // Browser mock has no real agent process; mark connection idle.
        emit.conn({ status: "idle" });
        return { ok: true as const, killed: true };
      },
      async respondPermission() {
        return { ok: true };
      },
      async openFile() {
        return { ok: false, error: "openFile only available in desktop app" };
      },
      async getSettings() {
        return {
          editorCommand: "code",
          theme: "dark" as const,
          defaultAgentId: null,
          enableFsCapabilities: false,
          enableBrowserMcp: true,
          enableNotifications: true,
          enableSound: true,
        };
      },
      async saveSettings(patch) {
        return {
          editorCommand: "code",
          theme: "dark" as const,
          defaultAgentId: null,
          enableFsCapabilities: false,
          enableBrowserMcp: true,
          enableNotifications: true,
          enableSound: true,
          ...patch,
        };
      },
      async getConnectionState() {
        return status;
      },
      async connectAgent() {
        emit.conn({
          status: "error",
          error: "No agent available in browser-only mode.",
        });
        return {
          ok: false as const,
          error: "Use the Electrobun desktop app to connect to an agent.",
        };
      },
      async pickFolder() {
        // Browser mock: no native dialog — caller should fall back to typed path.
        const path = window.prompt(
          "Project folder path (browser mock — no native picker):",
          "/tmp/demo-project",
        );
        if (!path?.trim()) return { ok: false as const, cancelled: true };
        return { ok: true as const, path: path.trim() };
      },
      async saveTextFile(params: {
        content: string;
        defaultName: string;
        startingFolder?: string;
        prompt?: string;
      }) {
        // Browser mock: trigger a download (no native Save As in pure web).
        const blob = new Blob([params.content ?? ""], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = params.defaultName || "export.json";
        a.click();
        URL.revokeObjectURL(url);
        return {
          ok: true as const,
          path: params.defaultName || "export.json",
        };
      },
      async listRecentProjects() {
        const seen = new Set<string>();
        const projects: RecentProject[] = [];
        for (const s of sessions) {
          if (!s.cwd || seen.has(s.cwd) || dismissedRecentCwds.has(s.cwd)) continue;
          seen.add(s.cwd);
          projects.push({
            project: s.project,
            cwd: s.cwd,
            updatedAt: s.updatedAt,
          });
        }
        return { projects };
      },
      async removeRecentProject({ cwd }) {
        const trimmed = cwd.trim();
        if (trimmed) dismissedRecentCwds.add(trimmed);
        const seen = new Set<string>();
        const projects: RecentProject[] = [];
        for (const s of sessions) {
          if (!s.cwd || seen.has(s.cwd) || dismissedRecentCwds.has(s.cwd)) continue;
          seen.add(s.cwd);
          projects.push({
            project: s.project,
            cwd: s.cwd,
            updatedAt: s.updatedAt,
          });
        }
        return { ok: true, projects };
      },
      async writeClipboard({ text }) {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return { ok: true };
          }
          return { ok: false, error: "Clipboard API unavailable" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, error: message };
        }
      },
      async readClipboard() {
        try {
          if (navigator.clipboard?.readText) {
            const text = await navigator.clipboard.readText();
            return { ok: true as const, text };
          }
          return { ok: false as const, error: "Clipboard API unavailable" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false as const, error: message };
        }
      },
async getGitBranch() {
        return { branch: null };
      },
      async windowControl() {
        // Browser mock — no native window to control.
        return { ok: true as const };
      },
      async setConfigOption() {
        return {
          ok: false as const,
          error: "Config options only available in the desktop app with an ACP agent.",
        };
      },
      async showDesktopNotification({ title, body, silent }) {
        if (typeof window !== "undefined" && "Notification" in window) {
          try {
            let permission = Notification.permission;
            if (permission === "default") {
              permission = await Notification.requestPermission();
            }
            if (permission === "granted") {
              new Notification(title, {
                body: body ?? "",
                silent: silent ?? true,
              });
              return { ok: true };
            }
          } catch {
            /* ignore */
          }
        }
        console.info("[rpc] showDesktopNotification (mock):", title, body);
        return { ok: true };
      },
      async getRemoteAccess() {
        return {
          running: false,
          code: null,
          port: null,
          url: null,
          urls: [],
          lanIps: [],
        };
      },
      async startRemoteAccess() {
        return {
          running: false,
          code: null,
          port: null,
          url: null,
          urls: [],
          lanIps: [],
        };
      },
      async stopRemoteAccess() {
        return {
          running: false,
          code: null,
          port: null,
          url: null,
          urls: [],
          lanIps: [],
        };
      },
      async regenerateRemoteAccess() {
        return {
          running: false,
          code: null,
          port: null,
          url: null,
          urls: [],
          lanIps: [],
        };
      },
      async getAgentSetup() {
        return {
          configPath: "~/.terminal-react/agents.json",
          configExists: true,
          defaultAgentId: "claude-code",
          agents: [
            {
              id: "claude-code",
              name: "Claude Code (ACP)",
              command: "claude-agent-acp",
              args: [],
              resolvedPath: null,
              ok: false,
            },
          ],
          ready: false,
          claudeAcpOk: false,
          claudeAcpPath: null,
          claudeCliOk: false,
          claudeCliPath: null,
          installCommand: "npm i -g @agentclientprotocol/claude-agent-acp",
        };
      },
      async ensureAgentSetup() {
        return this.getAgentSetup();
      },
      async listSkills() {
        return { skills: [...mockSkills] };
      },
      async installSkill({ package: pkg }) {
        const id =
          pkg.split("@").pop()?.split("/").pop()?.replace(/[^a-z0-9_-]/gi, "-") ||
          `skill-${Date.now()}`;
        if (!mockSkills.some((s) => s.id === id)) {
          mockSkills.push({
            id,
            name: id,
            description: `Installed from ${pkg} (browser mock)`,
            path: `/mock/skills/${id}`,
            enabled: true,
            scope: "global",
          });
          mockSkills.sort((a, b) => a.name.localeCompare(b.name));
        }
        return { ok: true as const, skills: [...mockSkills] };
      },
      async setSkillEnabled({ skillId, enabled }) {
        const skill = mockSkills.find((s) => s.id === skillId);
        if (!skill) return { ok: false as const, error: "Skill not found" };
        skill.enabled = enabled;
        return {
          ok: true as const,
          skill: { ...skill },
          skills: [...mockSkills],
        };
      },
      async uninstallSkill({ skillId }) {
        const idx = mockSkills.findIndex((s) => s.id === skillId);
        if (idx < 0) return { ok: false as const, error: "Skill not found" };
        mockSkills.splice(idx, 1);
        return { ok: true as const, skills: [...mockSkills] };
      },
      async getProjectHarness({ cwd, project }) {
        return mockHarness(cwd, project, mockHarnessApplied);
      },
      async applyProjectHarness({ cwd, optimizationId, project }) {
        if (optimizationId !== "karpathy-guidelines") {
          return { ok: false as const, error: `Unknown optimization: ${optimizationId}` };
        }
        mockHarnessApplied = true;
        const harness = mockHarness(cwd, project, true);
        return {
          ok: true as const,
          harness,
          written: [
            "AGENTS.md",
            "CLAUDE.md",
            ".agents/skills/karpathy-guidelines/SKILL.md",
          ],
        };
      },
      async listUserCommands({ projectCwd }) {
        const key = projectCwd?.trim() || "";
        return {
          commands: mockUserCommands.filter((c) => c.projectCwd === key),
        };
      },
      async addUserCommand({ projectCwd, name, command }) {
        const key = projectCwd?.trim() || "";
        if (!key) {
          return { ok: false as const, error: "Project folder is required" };
        }
        const n = name.trim();
        const c = command.trim();
        if (!n) return { ok: false as const, error: "Name is required" };
        if (!c) return { ok: false as const, error: "Command is required" };
        const entry: SavedCommand = {
          id: `cmd_mock_${Date.now().toString(36)}`,
          name: n,
          command: c,
          projectCwd: key,
          createdAt: Date.now(),
        };
        mockUserCommands.unshift(entry);
        return {
          ok: true as const,
          command: entry,
          commands: mockUserCommands.filter((x) => x.projectCwd === key),
        };
      },
      async removeUserCommand({ projectCwd, commandId }) {
        const key = projectCwd?.trim() || "";
        const idx = mockUserCommands.findIndex(
          (c) => c.id === commandId && c.projectCwd === key,
        );
        if (idx < 0) return { ok: false as const, error: "Command not found" };
        mockUserCommands.splice(idx, 1);
        return {
          ok: true as const,
          commands: mockUserCommands.filter((c) => c.projectCwd === key),
        };
      },
      async runUserCommand({ projectCwd, commandId }) {
        const key = projectCwd?.trim() || "";
        const saved = mockUserCommands.find(
          (c) => c.id === commandId && c.projectCwd === key,
        );
        if (!saved) return { ok: false as const, error: "Command not found" };
        const run: CommandRunSummary = {
          id: `run_mock_${Date.now().toString(36)}`,
          commandId: saved.id,
          commandName: saved.name,
          command: saved.command,
          projectCwd: key,
          cwd: key,
          status: "running",
          exitCode: null,
          startedAt: Date.now(),
          endedAt: null,
          logBytes: 0,
        };
        const logLines = [
          `$ ${saved.command}\n`,
          `(browser mock — no real process)\n`,
          `project: ${run.projectCwd}\n`,
        ];
        mockUserRuns.unshift({
          run,
          log: logLines.join(""),
          truncated: false,
        });
        setTimeout(() => {
          const entry = mockUserRuns.find((r) => r.run.id === run.id);
          if (!entry || entry.run.status !== "running") return;
          entry.log += "mock output: ok\n[exit 0]\n";
          entry.run.status = "exited";
          entry.run.exitCode = 0;
          entry.run.endedAt = Date.now();
          entry.run.logBytes = entry.log.length;
        }, 400);
        return { ok: true as const, run: { ...run } };
      },
      async stopUserCommandRun({ runId }) {
        const entry = mockUserRuns.find((r) => r.run.id === runId);
        if (!entry) return { ok: false as const, error: "Run not found" };
        if (entry.run.status === "running") {
          entry.run.status = "killed";
          entry.run.endedAt = Date.now();
          entry.log += "\n[process killed]\n";
          entry.run.logBytes = entry.log.length;
        }
        return { ok: true as const, run: { ...entry.run } };
      },
      async listUserCommandRuns({ projectCwd }) {
        const key = projectCwd?.trim() || "";
        return {
          runs: mockUserRuns
            .filter((r) => r.run.projectCwd === key)
            .map((r) => ({
              ...r.run,
              logBytes: r.log.length,
            })),
        };
      },
      async getUserCommandRunLog({ runId }) {
        const entry = mockUserRuns.find((r) => r.run.id === runId);
        if (!entry) return { ok: false as const, error: "Run not found" };
        return {
          ok: true as const,
          run: { ...entry.run, logBytes: entry.log.length },
          log: entry.log,
          truncated: entry.truncated,
        };
      },
    },
  };
}

type MockUserRun = {
  run: CommandRunSummary;
  log: string;
  truncated: boolean;
};

const mockUserCommands: SavedCommand[] = [
  {
    id: "cmd_mock_echo",
    name: "Echo hello",
    command: "echo hello from command panel",
    projectCwd: "/tmp/demo-project",
    createdAt: Date.now() - 60_000,
  },
];

const mockUserRuns: MockUserRun[] = [];

let mockHarnessApplied = false;

function mockHarness(
  cwd: string,
  project: string | undefined,
  applied: boolean,
): ProjectHarness {
  return {
    project: project || "demo",
    cwd: cwd || "/mock/project",
    ok: true,
    hasClaudeMd: applied,
    hasAgentsMd: applied,
    appliedCount: applied ? 2 : 0,
    optimizations: [
      {
        id: "karpathy-guidelines",
        name: "Karpathy guidelines",
        description:
          "Think before coding, simplicity first, surgical changes, goal-driven execution.",
        sourceLabel: "andrej-karpathy-skills",
        sourceUrl: "https://github.com/multica-ai/andrej-karpathy-skills",
        applied,
        details: applied
          ? "AGENTS.md · CLAUDE.md → @AGENTS.md · skill (mock)"
          : null,
      },
      {
        id: "project-memory",
        name: "Project memory + arc42",
        description:
          "Sharded git-synced team memory, arc42 scaffold, Claude /remember and /memory-promote.",
        sourceLabel: "arc42 · team memory",
        sourceUrl: "https://arc42.org/",
        applied,
        details: applied
          ? "docs/memory/INDEX.md · topics/ · docs/architecture/ (mock)"
          : null,
      },
    ],
  };
}

/** In-memory skills for browser mock / dev:web. */
const mockSkills: SkillInfo[] = [
  {
    id: "frontend-design",
    name: "frontend-design",
    description: "Create distinctive, production-grade frontend interfaces",
    path: "/mock/skills/frontend-design",
    enabled: true,
    scope: "global",
  },
  {
    id: "find-skills",
    name: "find-skills",
    description: "Discover and install agent skills from the ecosystem",
    path: "/mock/skills/find-skills",
    enabled: true,
    scope: "global",
  },
];
