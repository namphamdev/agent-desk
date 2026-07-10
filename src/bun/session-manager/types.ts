import type {
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  SessionConfigOption,
  SessionSummary,
  SessionUsage,
} from "../../shared/rpc";
import type { SessionUpdate } from "../../session/types";
import type { AcpSessionHandle } from "../acp-client";

export type SessionManagerEvents = {
  onUpdate: (sessionId: string, update: SessionUpdate) => void;
  onTurnEnd: (sessionId: string, stopReason: string) => void;
  onConnectionState: (state: ConnectionStatePayload) => void;
  onPermissionRequest: (req: PermissionRequest) => void;
  onSessionList: (sessions: SessionSummary[], activeSessionId: string | null) => void;
  onCommands: (sessionId: string, commands: AvailableCommand[]) => void;
  onMode: (sessionId: string, mode: string) => void;
  onConfigOptions: (sessionId: string, configOptions: SessionConfigOption[]) => void;
  onUsage: (sessionId: string, usage: SessionUsage) => void;
  onSessionLoaded: (
    session: SessionSummary,
    updates: SessionUpdate[],
    mode: string,
    commands: AvailableCommand[],
    configOptions?: SessionConfigOption[],
    usage?: SessionUsage | null,
  ) => void;
};

export type LiveSession = {
  summary: SessionSummary;
  handle: AcpSessionHandle | null;
  commands: AvailableCommand[];
  mode: string;
  configOptions: SessionConfigOption[];
  prompting: boolean;
  /** Latest context window usage from ACP `usage_update`. */
  usage: SessionUsage | null;
  /**
   * Context text to prepend once on the first user prompt (seeded threads).
   * Cleared after the first send so follow-ups stay normal.
   */
  contextSeed?: string | null;
};
