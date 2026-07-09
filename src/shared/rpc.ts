import type { RPCSchema } from "electrobun";
import type {
  Plan,
  SessionUpdate,
  ToolCall,
  ToolKind,
} from "../session/types";

/** Connection lifecycle as seen by the webview. */
export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "prompting"
  | "error"
  | "disconnected";

export type AgentInfo = {
  id: string;
  name: string;
  command: string;
  args: string[];
};

export type SessionSummary = {
  id: string;
  title: string;
  project: string;
  cwd: string;
  agentId: string;
  updatedAt: number;
  createdAt: number;
};

export type PermissionRequest = {
  requestId: string;
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    kind?: ToolKind;
    status?: string;
    content?: ToolCall["content"];
    locations?: ToolCall["locations"];
  };
  options: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
};

export type PermissionDecision = {
  requestId: string;
  optionId: string;
};

export type AvailableCommand = {
  name: string;
  description?: string;
  input?: { hint?: string };
};

export type AppSettings = {
  editorCommand: string;
  theme: "dark" | "light" | "system";
  defaultAgentId: string | null;
  enableFsCapabilities: boolean;
  dataDir?: string;
  defaultModel?: string;
  defaultEffort?: string;
  /** Last folder chosen for a new session (used as dialog default). */
  lastProjectCwd?: string | null;
};

export type RecentProject = {
  project: string;
  cwd: string;
  updatedAt: number;
};

export type ConnectionStatePayload = {
  status: ConnectionStatus;
  error?: string;
  agentName?: string;
  sessionId?: string | null;
};

export type TurnEndPayload = {
  sessionId: string;
  stopReason: string;
};

export type SessionListPayload = {
  sessions: SessionSummary[];
  activeSessionId: string | null;
};

export type SessionLoadedPayload = {
  session: SessionSummary;
  updates: SessionUpdate[];
  mode: string;
  commands: AvailableCommand[];
};

/**
 * Electrobun typed RPC contract.
 *
 * - bun.requests / bun.messages: handled on the Bun side (webview → bun)
 * - webview.requests / webview.messages: handled on the webview side (bun → webview)
 */
export type TerminalRPC = {
  bun: RPCSchema<{
    requests: {
      sendPrompt: {
        params: { text: string; sessionId?: string };
        response: { ok: true } | { ok: false; error: string };
      };
      cancel: {
        params: { sessionId?: string } | void;
        response: { ok: boolean };
      };
      listAgents: {
        params: void;
        response: { agents: AgentInfo[] };
      };
      listSessions: {
        params: void;
        response: SessionListPayload;
      };
      createSession: {
        params: {
          title?: string;
          project?: string;
          cwd?: string;
          agentId?: string;
        };
        response:
          | { ok: true; session: SessionSummary }
          | { ok: false; error: string };
      };
      switchSession: {
        params: { sessionId: string };
        response:
          | { ok: true; session: SessionSummary }
          | { ok: false; error: string };
      };
      deleteSession: {
        params: { sessionId: string };
        response: { ok: boolean };
      };
      respondPermission: {
        params: PermissionDecision;
        response: { ok: boolean };
      };
      openFile: {
        params: { path: string; line?: number };
        response: { ok: boolean; error?: string };
      };
      getSettings: {
        params: void;
        response: AppSettings;
      };
      saveSettings: {
        params: Partial<AppSettings>;
        response: AppSettings;
      };
      getConnectionState: {
        params: void;
        response: ConnectionStatePayload;
      };
      connectAgent: {
        params: { agentId?: string; cwd?: string } | void;
        response: { ok: true } | { ok: false; error: string };
      };
      pickFolder: {
        params: { startingFolder?: string } | void;
        response:
          | { ok: true; path: string }
          | { ok: false; cancelled?: boolean; error?: string };
      };
      listRecentProjects: {
        params: void;
        response: { projects: RecentProject[] };
      };
    };
    messages: {
      // webview → bun fire-and-forget (unused for now)
    };
  }>;
  webview: RPCSchema<{
    requests: {
      // bun → webview request/response (unused for now)
    };
    messages: {
      onUpdate: { sessionId: string; update: SessionUpdate };
      onTurnEnd: TurnEndPayload;
      onConnectionState: ConnectionStatePayload;
      onPermissionRequest: PermissionRequest;
      onSessionList: SessionListPayload;
      onSessionLoaded: SessionLoadedPayload;
      onCommands: { sessionId: string; commands: AvailableCommand[] };
      onMode: { sessionId: string; mode: string };
      onPlan: { sessionId: string; plan: Plan };
    };
  }>;
};
