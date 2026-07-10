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

/** Selectable value for an ACP session config option (flattened groups). */
export type SessionConfigSelectValue = {
  value: string;
  name: string;
  description?: string;
};

/**
 * Session configuration option from ACP (`session/new` / `config_option_update`
 * / `session/set_config_option`). Categories like `model` and `thought_level`
 * drive the prompt bar selectors.
 */
export type SessionConfigOption = {
  id: string;
  name: string;
  description?: string;
  /** Semantic category: mode | model | model_config | thought_level | … */
  category?: string | null;
} & (
  | {
      type: "select";
      currentValue: string;
      options: SessionConfigSelectValue[];
    }
  | {
      type: "boolean";
      currentValue: boolean;
    }
);

export type AppSettings = {
  editorCommand: string;
  theme: "dark" | "light" | "system";
  defaultAgentId: string | null;
  enableFsCapabilities: boolean;
  /** System notification when an agent turn completes. */
  enableNotifications: boolean;
  /** Play a sound when an agent turn completes. */
  enableSound: boolean;
  dataDir?: string;
  defaultModel?: string;
  defaultEffort?: string;
  /** Last folder chosen for a new session (used as dialog default). */
  lastProjectCwd?: string | null;
  /** Project folders hidden from the New Session recent list. */
  dismissedRecentCwds?: string[];
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
  /** Resident set size of the ACP agent process tree, in bytes. */
  memoryRssBytes?: number | null;
  /** When memoryRssBytes was sampled (epoch ms). */
  memorySampledAt?: number | null;
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
  configOptions?: SessionConfigOption[];
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
          /**
           * Optional starting context (e.g. forked from a message). Shown in the
           * timeline and prepended to the first prompt so the agent sees it.
           */
          seedContext?: {
            text: string;
            role?: "user" | "agent" | "thought";
          };
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
      removeRecentProject: {
        params: { cwd: string };
        response: { ok: boolean; projects: RecentProject[] };
      };

      writeClipboard: {
        params: { text: string };
        response: { ok: boolean; error?: string };
      };
      /** Current git branch for a project folder (null if not a repo). */
getGitBranch: {
        params: { cwd: string };
        response: { branch: string | null };
      };
      windowControl: {
        params: { action: "close" | "minimize" | "maximize" };
        response: { ok: true } | { ok: false; error?: string };
      };
      /** Set an ACP session config option (model, thought_level, mode, …). */
      setConfigOption: {
        params: {
          sessionId?: string;
          configId: string;
          value: string | boolean;
        };
        response:
          | { ok: true; configOptions: SessionConfigOption[] }
          | { ok: false; error: string };
      };
      /**
       * Native OS notification (Electrobun Utils.showNotification).
       * Prefer this over the Web Notification API — WKWebView does not prompt
       * for permission or deliver banners reliably.
       */
      showDesktopNotification: {
        params: {
          title: string;
          body?: string;
          subtitle?: string;
          silent?: boolean;
        };
        response: { ok: boolean; error?: string };
      };
    };
    messages: {

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
      onConfigOptions: {
        sessionId: string;
        configOptions: SessionConfigOption[];
      };
      onPlan: { sessionId: string; plan: Plan };
    };
  }>;
};
