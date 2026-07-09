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
  SessionListPayload,
  SessionLoadedPayload,
  TerminalRPC,
  TurnEndPayload,
} from "../shared/rpc";
import type { SessionUpdate } from "../session/types";

export type RpcListeners = {
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  onTurnEnd?: (payload: TurnEndPayload) => void;
  onConnectionState?: (state: ConnectionStatePayload) => void;
  onPermissionRequest?: (req: PermissionRequest) => void;
  onSessionList?: (payload: SessionListPayload) => void;
  onSessionLoaded?: (payload: SessionLoadedPayload) => void;
  onCommands?: (sessionId: string, commands: AvailableCommand[]) => void;
  onMode?: (sessionId: string, mode: string) => void;
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
    listRecentProjects: () => Promise<{ projects: RecentProject[] }>;
  };
};

let client: RpcClient | null = null;
let listeners: RpcListeners = {};

function isElectrobun(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __electrobunWebviewId?: number }).__electrobunWebviewId;
}

export function setRpcListeners(next: RpcListeners) {
  listeners = next;
}

export function initRpc(): RpcClient {
  if (client) return client;

  if (isElectrobun()) {
    // Electrobun default maxRequestTime is 1s — far too short for native
    // folder pickers (and anything else that waits on the user). Match the
    // bun-side budget so pickFolder can complete after the dialog closes.
    const rpc = Electroview.defineRPC<TerminalRPC>({
      maxRequestTime: 600_000,
      handlers: {
        requests: {},
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

export function getRpc(): RpcClient {
  return client ?? initRpc();
}

function createBrowserMock(): RpcClient {
  let status: ConnectionStatePayload = {
    status: "idle",
  };
  const sessions: SessionListPayload["sessions"] = [];
  let activeSessionId: string | null = null;

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
        return { sessions: [...sessions], activeSessionId };
      },
      async createSession({ title, project, cwd, agentId }) {
        const folder = cwd || "/tmp/demo-project";
        const name =
          project ||
          folder.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ||
          "local";
        const session = {
          id: `local-${Date.now()}`,
          title: title || "New session",
          project: name,
          cwd: folder,
          agentId: agentId || "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        sessions.unshift(session);
        activeSessionId = session.id;
        emit.list();
        emit.loaded(session, []);
        return { ok: true as const, session };
      },
      async switchSession({ sessionId }) {
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) return { ok: false as const, error: "not found" };
        activeSessionId = sessionId;
        emit.list();
        emit.loaded(session, []);
        return { ok: true as const, session };
      },
      async deleteSession({ sessionId }) {
        const idx = sessions.findIndex((s) => s.id === sessionId);
        if (idx >= 0) sessions.splice(idx, 1);
        if (activeSessionId === sessionId) activeSessionId = sessions[0]?.id ?? null;
        emit.list();
        return { ok: true };
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
        };
      },
      async saveSettings(patch) {
        return {
          editorCommand: "code",
          theme: "dark" as const,
          defaultAgentId: null,
          enableFsCapabilities: false,
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
      async listRecentProjects() {
        const seen = new Set<string>();
        const projects: RecentProject[] = [];
        for (const s of sessions) {
          if (!s.cwd || seen.has(s.cwd)) continue;
          seen.add(s.cwd);
          projects.push({
            project: s.project,
            cwd: s.cwd,
            updatedAt: s.updatedAt,
          });
        }
        return { projects };
      },
    },
  };
}
