import { join } from "node:path";
import { homedir } from "node:os";
import type { AppSettings } from "../shared/rpc";
import type { SessionStore } from "./store";

export const DEFAULT_SETTINGS: AppSettings = {
  editorCommand: process.env.EDITOR || process.env.VISUAL || "code",
  theme: "dark",
  defaultAgentId: null,
  enableFsCapabilities: false,
  enableNotifications: true,
  enableSound: true,
  dataDir: join(homedir(), ".terminal-react"),
  defaultModel: undefined,
  /** ACP thought_level value applied when a session opens (e.g. low|medium|high|xhigh|max). */
  defaultEffort: "high",
  lastProjectCwd: null,
  dismissedRecentCwds: [],
};

const SETTINGS_KEY = "app_settings";

export function loadSettings(store: SessionStore): AppSettings {
  try {
    const raw = store.getSetting(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(
  store: SessionStore,
  patch: Partial<AppSettings>,
): AppSettings {
  const current = loadSettings(store);
  const next = { ...current, ...patch };
  store.setSetting(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
