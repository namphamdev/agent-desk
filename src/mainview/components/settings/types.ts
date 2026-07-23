import type {
  AgentInfo,
  AppSettings,
  RemoteAccessStatus,
} from "../../../shared/rpc";

export type SettingsTab =
  | "general"
  | "providers"
  | "claude"
  | "remote"
  | "alerts"
  | "workflows"
  | "speech";

export type SettingsPanelProps = {
  settings: AppSettings;
  agents: AgentInfo[];
  onClose: () => void;
  onSave: (patch: Partial<AppSettings>) => void | Promise<void>;
  /** When false, hide the Remote Control tab (e.g. already on a phone client). */
  showRemoteControl?: boolean;
  remoteAccess?: RemoteAccessStatus | null;
  remoteAccessLoading?: boolean;
  remoteAccessError?: string | null;
  onRemoteStart?: () => void | Promise<void>;
  onRemoteStop?: () => void | Promise<void>;
  onRemoteRegenerate?: () => void | Promise<void>;
  /** Load status without auto-starting (settings tab open). */
  onRemoteRefresh?: () => void | Promise<void>;
  /** Active/last project folder for project-scoped workflow edits. */
  projectCwd?: string | null;
  projectName?: string | null;
};
