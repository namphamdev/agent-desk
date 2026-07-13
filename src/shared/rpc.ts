import type { RPCSchema } from "electrobun";
import type {
  Plan,
  SessionUpdate,
  ToolCall,
  ToolKind,
} from "../session/types";
import type {
  BrowserControlRequest,
  BrowserControlResponse,
  BrowserOpenMessage,
} from "./browser-control";

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
  /**
   * Runtime-only: true when this session has a live ACP agent process/handle.
   * Not persisted to SQLite.
   */
  agentRunning?: boolean;
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

/** Claude Code model aliases used for provider mapping + chat selection. */
export type ClaudeModelAlias = "haiku" | "sonnet" | "opus";

/**
 * An LLM provider (Anthropic-compatible gateway or direct API).
 * Credentials and model mappings are injected as env vars when spawning
 * Claude Code ACP (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_MODEL`).
 */
export type ProviderConfig = {
  id: string;
  name: string;
  /** API base URL (e.g. https://api.anthropic.com or a gateway URL). */
  baseUrl: string;
  /** API key sent as ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN. */
  apiKey: string;
  /**
   * Map Claude Code aliases to provider-specific model IDs.
   * Empty string = let Claude Code resolve the alias itself.
   */
  models: {
    haiku: string;
    sonnet: string;
    opus: string;
  };
};

export type AppSettings = {
  editorCommand: string;
  theme: "dark" | "light" | "system";
  defaultAgentId: string | null;
  enableFsCapabilities: boolean;
  /**
   * Inject Playwright MCP on session/new so Claude Code can control a real
   * browser (navigate, snapshot, click, fill, screenshot). On by default.
   */
  enableBrowserMcp: boolean;
  /** System notification when an agent turn completes. */
  enableNotifications: boolean;
  /** Play a sound when an agent turn completes. */
  enableSound: boolean;
  dataDir?: string;
  defaultModel?: string;
  /**
   * Default thinking / effort level applied when an ACP session opens.
   * Matched case-insensitively against the agent's `thought_level` options
   * (typical values: low, medium, high, xhigh, max).
   */
  defaultEffort?: string;
  /**
   * Default permission / session mode applied when an ACP session opens.
   * Matched case-insensitively against the agent's `mode` options
   * (typical values: default, acceptEdits, plan, bypassPermissions).
   */
  defaultPermissionMode?: string;
  /** Last folder chosen for a new session (used as dialog default). */
  lastProjectCwd?: string | null;
  /** Project folders hidden from the New Session recent list. */
  dismissedRecentCwds?: string[];
  /** User-configured LLM providers (base URL, key, model maps). */
  providers?: ProviderConfig[];
  /**
   * Active provider for agent spawn. Null = system / Claude Code defaults
   * (process env only, no override).
   */
  activeProviderId?: string | null;
  /**
   * Active Claude Code model alias (haiku / sonnet / opus) used when spawning
   * and as the preferred ACP model config default.
   */
  activeModelAlias?: ClaudeModelAlias;
  /**
   * Relative paths symlinked from the main project into new git worktrees
   * (e.g. node_modules) so large installs are not duplicated per worktree.
   */
  worktreeSymlinkPaths?: string[];
};

/** Options for opening a new session inside a git worktree. */
export type CreateSessionWorktree = {
  /** Branch to check out in the worktree. */
  branch: string;
  /**
   * Create the branch when it does not exist (default true).
   * If false, the branch must already exist.
   */
  createBranch?: boolean;
  /** Optional explicit worktree path; default is next to the main repo. */
  path?: string;
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

/** Context window usage for a session (from ACP `usage_update`). */
export type SessionUsage = {
  /** Tokens currently in context. */
  used: number;
  /** Total context window size in tokens. */
  size: number;
  /** Cumulative session cost, if the agent reports it. */
  cost?: { amount: number; currency: string } | null;
};

export type SessionLoadedPayload = {
  session: SessionSummary;
  updates: SessionUpdate[];
  mode: string;
  commands: AvailableCommand[];
  configOptions?: SessionConfigOption[];
  /** Latest context usage for this session, if known. */
  usage?: SessionUsage | null;
};

/** LAN remote-access server status (phone/browser mirror of the desktop UI). */
export type RemoteAccessStatus = {
  running: boolean;
  code: string | null;
  port: number | null;
  /** Preferred LAN URL (first non-internal IPv4). */
  url: string | null;
  /** All candidate URLs (every non-internal IPv4 + localhost). */
  urls: string[];
  lanIps: string[];
};

/** One configured agent and whether its command resolves on PATH. */
export type AgentSetupEntry = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Absolute path when found; null if not on PATH. */
  resolvedPath: string | null;
  ok: boolean;
};

/**
 * Claude Code / ACP agent setup diagnostics for Settings → Claude Code.
 * Claude Code is not ACP-native; this app uses `claude-agent-acp`.
 */
export type AgentSetupStatus = {
  configPath: string;
  configExists: boolean;
  defaultAgentId: string;
  agents: AgentSetupEntry[];
  /** Config present and at least one agent command resolves. */
  ready: boolean;
  /** `claude-agent-acp` (or agents.json entry for it) resolves. */
  claudeAcpOk: boolean;
  claudeAcpPath: string | null;
  /** Optional: Claude Code CLI (`claude`) if present. */
  claudeCliOk: boolean;
  claudeCliPath: string | null;
  installCommand: string;
};

/** An installed agent skill (SKILL.md package under ~/.agents/skills). */
export type SkillInfo = {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  scope: "global" | "project";
};

/** One AI-agent optimization available for a project harness. */
export type HarnessOptimization = {
  id: string;
  name: string;
  description: string;
  sourceLabel: string;
  sourceUrl: string;
  applied: boolean;
  details: string | null;
};

/** Project AI harness status (optimizations applied to a folder). */
export type ProjectHarness = {
  project: string;
  cwd: string;
  ok: boolean;
  error?: string;
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
  optimizations: HarnessOptimization[];
  appliedCount: number;
};

/** A project-scoped user-saved shell command (Command panel). */
export type SavedCommand = {
  id: string;
  name: string;
  /** Shell command string (run via zsh -c / cmd /c). */
  command: string;
  /** Absolute project folder this command belongs to (also the run cwd). */
  projectCwd: string;
  createdAt: number;
};

export type CommandRunStatus = "running" | "exited" | "error" | "killed";

/** One process invocation of a saved command. */
export type CommandRunSummary = {
  id: string;
  commandId: string;
  commandName: string;
  command: string;
  /** Project this run belongs to. */
  projectCwd: string;
  /** Working directory used for the process (project cwd). */
  cwd: string;
  status: CommandRunStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Current captured log size in characters. */
  logBytes?: number;
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
           * When set, create (or reuse) a git worktree under the project and
           * open the session there. Shared paths from settings are symlinked
           * from the main tree (e.g. node_modules).
           */
          worktree?: CreateSessionWorktree;
          /**
           * Optional starting context (e.g. forked from a message or a session
           * change summary for review). Shown in the timeline and prepended to
           * the first prompt so the agent sees it.
           */
          seedContext?: {
            text: string;
            role?: "user" | "agent" | "thought";
            /** Framing for the first prompt (default: continue). */
            purpose?: "continue" | "review";
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
      /** Kill ACP agent for a session to free memory; keeps chat history. */
      offloadSession: {
        params: { sessionId: string };
        response:
          | { ok: true; killed: boolean }
          | { ok: false; error: string };
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
      /**
       * Native Save As dialog, then write text to the chosen path.
       * Desktop only (remote clients get an error).
       */
      saveTextFile: {
        params: {
          content: string;
          defaultName: string;
          startingFolder?: string;
          /** Dialog title / prompt when supported. */
          prompt?: string;
        };
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
      /** Read system clipboard text (native bridge — WKWebView paste can be flaky). */
      readClipboard: {
        params: void;
        response:
          | { ok: true; text: string }
          | { ok: false; error?: string };
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
      /** Current LAN remote-access server status (may be stopped). */
      getRemoteAccess: {
        params: void;
        response: RemoteAccessStatus;
      };
      /** Start (or return existing) remote-access HTTP/WS server. */
      startRemoteAccess: {
        params: void;
        response: RemoteAccessStatus;
      };
      /** Stop the remote-access server. */
      stopRemoteAccess: {
        params: void;
        response: RemoteAccessStatus;
      };
      /** Rotate the access code (restarts the server if running). */
      regenerateRemoteAccess: {
        params: void;
        response: RemoteAccessStatus;
      };
      /**
       * Diagnose Claude Code ACP setup: agents.json + PATH resolution for
       * configured agent binaries (and common claude / claude-agent-acp names).
       */
      getAgentSetup: {
        params: void;
        response: AgentSetupStatus;
      };
      /**
       * Write the starter `~/.terminal-react/agents.json` if missing, then
       * re-run diagnostics.
       */
      ensureAgentSetup: {
        params: void;
        response: AgentSetupStatus;
      };
      /** List installed agent skills (global + optional project). */
      listSkills: {
        params: { projectCwd?: string | null } | void;
        response: { skills: SkillInfo[] };
      };
      /** Install a skill via Skills CLI (`owner/repo` or `owner/repo@skill`). */
      installSkill: {
        params: { package: string };
        response:
          | { ok: true; skills: SkillInfo[] }
          | { ok: false; error: string };
      };
      /** Enable or disable a skill (moves under .disabled when off). */
      setSkillEnabled: {
        params: { skillId: string; enabled: boolean };
        response:
          | { ok: true; skill: SkillInfo; skills: SkillInfo[] }
          | { ok: false; error: string };
      };
      /** Remove an installed skill from disk. */
      uninstallSkill: {
        params: { skillId: string };
        response:
          | { ok: true; skills: SkillInfo[] }
          | { ok: false; error: string };
      };
      /** Inspect AI harness optimizations for a project folder. */
      getProjectHarness: {
        params: { cwd: string; project?: string };
        response: ProjectHarness;
      };
      /** Apply a harness optimization (e.g. Karpathy guidelines → AGENTS.md + skills). */
      applyProjectHarness: {
        params: {
          cwd: string;
          optimizationId: string;
          project?: string;
        };
        response:
          | {
              ok: true;
              harness: ProjectHarness;
              written: string[];
            }
          | { ok: false; error: string };
      };
      /** List shell commands saved for a project folder. */
      listUserCommands: {
        params: { projectCwd: string };
        response: { commands: SavedCommand[] };
      };
      /** Add a shell command for a project folder. */
      addUserCommand: {
        params: { projectCwd: string; name: string; command: string };
        response:
          | { ok: true; command: SavedCommand; commands: SavedCommand[] }
          | { ok: false; error: string };
      };
      /** Remove a saved shell command from a project. */
      removeUserCommand: {
        params: { projectCwd: string; commandId: string };
        response:
          | { ok: true; commands: SavedCommand[] }
          | { ok: false; error: string };
      };
      /** Spawn a project's saved command in that project folder. */
      runUserCommand: {
        params: { projectCwd: string; commandId: string };
        response:
          | { ok: true; run: CommandRunSummary }
          | { ok: false; error: string };
      };
      /** Kill a running command process. */
      stopUserCommandRun: {
        params: { runId: string };
        response:
          | { ok: true; run: CommandRunSummary }
          | { ok: false; error: string };
      };
      /** Recent command runs for a project. */
      listUserCommandRuns: {
        params: { projectCwd: string };
        response: { runs: CommandRunSummary[] };
      };
      /** Captured stdout/stderr for a run. */
      getUserCommandRunLog: {
        params: { runId: string };
        response:
          | {
              ok: true;
              run: CommandRunSummary;
              log: string;
              truncated: boolean;
            }
          | { ok: false; error: string };
      };
    };
    messages: {

    };
  }>;
  webview: RPCSchema<{
    requests: {
      /**
       * Agent MCP → Bun control plane → webview: drive the built-in browser
       * panel for a chat session (navigate, snapshot, click, …).
       */
      browserControl: {
        params: BrowserControlRequest;
        response: BrowserControlResponse;
      };
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
      onUsage: {
        sessionId: string;
        usage: SessionUsage;
      };
      onPlan: { sessionId: string; plan: Plan };
      /** Open the built-in browser panel for a session (agent is driving it). */
      onBrowserOpen: BrowserOpenMessage;
    };
  }>;
};
