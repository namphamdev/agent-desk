import { join } from "node:path";
import { homedir } from "node:os";
import type { AppSettings } from "../shared/rpc";
import type { SessionStore } from "./store";
import {
  normalizeModelAlias,
  normalizeProviders,
  resolveActiveProvider,
} from "./providers";
import {
  DEFAULT_WORKTREE_SYMLINK_PATHS,
  normalizeSymlinkPaths,
} from "../shared/worktree-paths";

export const DEFAULT_SETTINGS: AppSettings = {
  editorCommand: process.env.EDITOR || process.env.VISUAL || "code",
  theme: "dark",
  defaultAgentId: null,
  enableFsCapabilities: false,
  enableBrowserMcp: true,
  enableNotifications: true,
  enableSound: true,
  dataDir: join(homedir(), ".terminal-react"),
  defaultModel: undefined,
  /** ACP thought_level value applied when a session opens (e.g. low|medium|high|xhigh|max). */
  defaultEffort: "high",
  /** ACP permission mode applied when a session opens (e.g. default|acceptEdits|plan|bypassPermissions). */
  defaultPermissionMode: "default",
  lastProjectCwd: null,
  dismissedRecentCwds: [],
  providers: [],
  activeProviderId: null,
  activeModelAlias: "sonnet",
  worktreeSymlinkPaths: [...DEFAULT_WORKTREE_SYMLINK_PATHS],
};

const SETTINGS_KEY = "app_settings";

function normalizeSettings(parsed: Partial<AppSettings>): AppSettings {
  const providers = normalizeProviders(parsed.providers);
  let activeProviderId =
    typeof parsed.activeProviderId === "string"
      ? parsed.activeProviderId
      : parsed.activeProviderId === null
        ? null
        : DEFAULT_SETTINGS.activeProviderId ?? null;

  if (
    activeProviderId &&
    providers.length > 0 &&
    !providers.some((p) => p.id === activeProviderId)
  ) {
    activeProviderId = providers[0]?.id ?? null;
  }
  if (providers.length === 0) {
    activeProviderId = null;
  }

  const activeModelAlias = normalizeModelAlias(
    parsed.activeModelAlias ?? DEFAULT_SETTINGS.activeModelAlias,
    "sonnet",
  );

  // When a provider is active, prefer the Claude Code alias (haiku/sonnet/opus)
  // for ACP session/set_config_option matching. The mapped model id is applied
  // via ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL at process spawn.
  const provider = resolveActiveProvider({ providers, activeProviderId });
  const derivedDefaultModel =
    provider != null ? activeModelAlias : parsed.defaultModel;

  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    providers,
    activeProviderId,
    activeModelAlias,
    defaultModel: derivedDefaultModel ?? parsed.defaultModel,
    enableBrowserMcp:
      typeof parsed.enableBrowserMcp === "boolean"
        ? parsed.enableBrowserMcp
        : DEFAULT_SETTINGS.enableBrowserMcp,
    dismissedRecentCwds: Array.isArray(parsed.dismissedRecentCwds)
      ? parsed.dismissedRecentCwds.filter((c): c is string => typeof c === "string")
      : DEFAULT_SETTINGS.dismissedRecentCwds,
    worktreeSymlinkPaths: normalizeSymlinkPaths(
      parsed.worktreeSymlinkPaths ?? DEFAULT_SETTINGS.worktreeSymlinkPaths,
    ),
  };
}

export function loadSettings(store: SessionStore): AppSettings {
  try {
    const raw = store.getSetting(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, providers: [] };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS, providers: [] };
  }
}

export function saveSettings(
  store: SessionStore,
  patch: Partial<AppSettings>,
): AppSettings {
  const current = loadSettings(store);
  const merged: Partial<AppSettings> = { ...current, ...patch };
  // Explicit null for activeProviderId must stick (spread keeps null).
  if ("activeProviderId" in patch) {
    merged.activeProviderId = patch.activeProviderId;
  }
  if ("providers" in patch) {
    merged.providers = patch.providers;
  }
  const next = normalizeSettings(merged);
  store.setSetting(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
