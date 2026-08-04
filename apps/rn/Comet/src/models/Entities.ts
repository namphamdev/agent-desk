// Entity model — TS mirrors of the workspace/session doc rows and the derived
// display state. Field names match the doc schema exactly; derivations
// (indicator, staleness, attention rank) are ports of Entities.swift
// (and crates/ui/src/state.rs, entities.rs).

// MARK: - Workspace doc rows

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  lastSeenAt?: number;
  createdAt?: number;
}

export interface Space {
  id: string;
  deviceId: string;
  path: string;
  name?: string;
  gitDetected: boolean;
  gitCheckedAt?: number;
  checkoutId?: string;
  createdAt: number;
}

export function spaceDisplayName(space: Space): string {
  if (space.name && space.name.length > 0) return space.name;
  return baseName(space.path);
}

export function baseName(path: string): string {
  // NSString.lastPathComponent equivalent.
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export type PermissionModeValue =
  | 'default'
  | 'plan'
  | 'accept-edits'
  | 'full-access';

export interface PermissionModeMeta {
  value: PermissionModeValue;
  label: string;
  description: string;
  sandbox: string;
  autoApprove: boolean;
  iconName: string;
}

export const PERMISSION_MODES: PermissionModeMeta[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Prompts before writing files',
    sandbox: 'workspace-write',
    autoApprove: false,
    iconName: 'shield',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Read-only mode, no file edits',
    sandbox: 'read-only',
    autoApprove: false,
    iconName: 'doc.text',
  },
  {
    value: 'accept-edits',
    label: 'Accept edits',
    description: 'Auto-approves workspace file edits',
    sandbox: 'workspace-write',
    autoApprove: true,
    iconName: 'pencil.line',
  },
  {
    value: 'full-access',
    label: 'Full access',
    description: 'Bypasses all sandbox and approval prompts',
    sandbox: 'danger-full-access',
    autoApprove: true,
    iconName: 'exclamationmark.shield',
  },
];

export function permissionModeMeta(v: PermissionModeValue): PermissionModeMeta {
  return PERMISSION_MODES.find((m) => m.value === v) ?? PERMISSION_MODES[0];
}

export interface ChatConfig {
  harness: string;
  model?: string;
  reasoning?: string;
  sandbox?: string;
  permissionMode?: PermissionModeValue;
  acpAgentId?: string;
}

export function effectivePermissionMode(config?: ChatConfig | null): PermissionModeMeta {
  if (config?.permissionMode) return permissionModeMeta(config.permissionMode);
  if (config?.sandbox) {
    switch (config.sandbox) {
      case 'read-only': return permissionModeMeta('plan');
      case 'danger-full-access': return permissionModeMeta('full-access');
      default: return permissionModeMeta('default');
    }
  }
  return permissionModeMeta('default');
}

export interface Chat {
  id: string;
  deviceId: string;
  title?: string;
  archived: boolean;
  cwd?: string;
  branch?: string;
  checkoutId?: string;
  config?: ChatConfig;
  lastMessagePreview?: string;
  lastMessageAt?: number;
  createdAt: number;
  spaceId?: string;
  lastSeenAt?: number;
  settledAt?: number;
}

export function chatDisplayTitle(chat: Chat): string {
  if (chat.title && chat.title.length > 0) return chat.title;
  return 'New session';
}

export function chatUnseen(chat: Chat): boolean {
  if (!chat.lastMessageAt) return false;
  if (!chat.lastSeenAt) return true;
  return chat.lastMessageAt > chat.lastSeenAt;
}

export type SessionStatusValue = 'idle' | 'working' | 'awaitingInput' | 'errored';

export interface SessionRow {
  chatId: string;
  deviceId: string;
  status: SessionStatusValue;
  startedAt?: number;
  updatedAt: number;
}

// MARK: - Derived display status

export type ChatIndicatorValue =
  | 'awaitingInput'
  | 'errored'
  | 'working'
  | 'completed'
  | 'idle';

export const INDICATOR_ORDER: Record<ChatIndicatorValue, number> = {
  awaitingInput: 0,
  errored: 1,
  working: 2,
  completed: 3,
  idle: 4,
};

export function indicatorLabel(indicator: ChatIndicatorValue): string {
  switch (indicator) {
    case 'awaitingInput': return 'Needs input';
    case 'errored': return 'Needs attention';
    case 'working': return 'Running';
    case 'completed': return 'Completed';
    case 'idle': return 'Seen';
  }
}

// state.rs:277 — Working/AwaitingInput older than this reads as stale.
export const SESSION_STALE_MS = 45_000;
// workspace_host.rs:45 — presence freshness window for device online dots.
export const PRESENCE_FRESH_MS = 45_000;

export function effectiveStatus(
  row: SessionRow | undefined,
  now: number,
): SessionStatusValue | null {
  if (!row) return null;
  switch (row.status) {
    case 'working':
    case 'awaitingInput': {
      const age = now - row.updatedAt;
      // Negative ages (clock skew) are fresh.
      return age > SESSION_STALE_MS ? null : row.status;
    }
    case 'errored':
    case 'idle':
      return row.status;
  }
}

export function chatIndicator(
  chat: Chat,
  live: SessionStatusValue | null,
): ChatIndicatorValue {
  switch (live) {
    case 'working': return 'working';
    case 'awaitingInput': return 'awaitingInput';
    case 'errored': return chatUnseen(chat) ? 'errored' : 'idle';
    default:
      return chatUnseen(chat) ? 'completed' : 'idle';
  }
}

// entities.rs:147 — Sessions list order: PURE RECENCY, id tiebreak.
export function sortActive(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => {
    const ta = a.lastMessageAt ?? a.createdAt;
    const tb = b.lastMessageAt ?? b.createdAt;
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// MARK: - Session doc entries

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatusValue = 'streaming' | 'complete' | 'aborted';

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: string[];
  multiSelect?: boolean;
}

export interface UserInputAnswer {
  questionId: string;
  labels: string[];
}

// Render-only sanitized tool call (packages render-parts policy).
export interface RenderToolCall {
  tag: string;
  fields: Record<string, unknown>;
}

export function toolStringField(call: RenderToolCall, key: string): string | undefined {
  const v = call.fields[key];
  return typeof v === 'string' ? v : undefined;
}

export type MessagePart =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; call: RenderToolCall; isError: boolean; resolved: boolean }
  | { kind: 'input'; id: string; requestId: string; questions: UserInputQuestion[]; resolved: boolean }
  | { kind: 'error'; id: string; message: string };

export interface MessageEntry {
  id: string;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: number;
  deviceId: string;
  status?: MessageStatusValue;
  continuationOf?: string;
}

// MARK: - Folder browsing (add-space palette data)

export interface FolderEntry {
  name: string;
  isDir: boolean;
  isRepo: boolean;
}

export interface FolderListing {
  path: string;
  entries: FolderEntry[];
  truncated: boolean;
}

export function folderParent(listing: FolderListing): string | null {
  if (!listing.path.includes('/') || listing.path === '/') return null;
  const idx = listing.path.lastIndexOf('/');
  const trimmed = idx === 0 ? '' : listing.path.slice(0, idx);
  return trimmed.length === 0 ? '/' : trimmed;
}

export type CheckoutKind = 'local' | 'newWorktree';

export interface RepoRef {
  name: string;
  current: boolean;
  worktreePath?: string;
}

export interface GitFileChange {
  path: string;
  oldPath?: string;
  kind: string;
  staged: boolean;
  unstaged: boolean;
  xy: string;
}

export function gitFileLabel(file: GitFileChange): string {
  switch (file.kind) {
    case 'added': return 'Added';
    case 'deleted': return 'Deleted';
    case 'renamed': return 'Renamed';
    case 'untracked': return 'Untracked';
    default:
      return file.staged && file.unstaged
        ? 'Staged + modified'
        : file.staged
        ? 'Staged'
        : 'Modified';
  }
}

export interface GitStatus {
  branch?: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  isRepo: boolean;
}

// MARK: - ACP agents + custom providers

export interface AcpRegistryAgent {
  id: string;
  name: string;
  description: string;
  version: string;
  distribution?: string;
  supported: boolean;
}

export interface InstalledAcpAgent {
  id: string;
  name: string;
  version: string;
  command: string;
  distribution: string;
}

export interface AcpAgentsSnapshot {
  activeAgentId?: string;
  installed: InstalledAcpAgent[];
  registry: AcpRegistryAgent[];
  registryError?: string;
}

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  formats: string[];
  codexSubagentModel?: string;
}

export interface CustomProviderSnapshot {
  providers: CustomProvider[];
  selection: Record<string, string>;
}

export interface CustomProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  formats: string[];
}

// MARK: - Command ledger (commands.rs port)

export const COMMAND_DEFAULT_TTL_MS = 86_400_000;

// comet-proto RunRequest (agent.rs:81).
export interface RunRequest {
  prompt: string;
  harness?: string;
  model?: string;
  reasoning?: string;
  modelOptions?: Record<string, string>;
  cwd: string;
  sandbox: string;
  autoApprove: boolean;
  permissionMode?: PermissionModeValue;
  resume?: string;
  acpAgentId?: string;
}

export function nowMs(): number {
  return Date.now();
}

// MARK: - Routing

export type Route =
  | { kind: 'space'; spaceId: string }
  | { kind: 'chat'; chatId: string }
  | { kind: 'activity' }
  | { kind: 'newSession'; spaceId: string };
