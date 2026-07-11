import type { ClaudeModelAlias, ProviderConfig } from "../../../shared/rpc";
import type { SettingsTab } from "./types";

export const THEME_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
] as const;

/** Common ACP thought_level / effort values (Claude Code and similar agents). */
export const EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
] as const;

export const MODEL_ALIAS_OPTIONS: {
  value: ClaudeModelAlias;
  label: string;
}[] = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

export const BASE_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "claude", label: "Claude Code" },
  { id: "remote", label: "Remote Control" },
  { id: "alerts", label: "Alerts" },
];

export function normalizeEffortValue(raw: string | undefined): string {
  if (!raw) return "high";
  const lower = raw.toLowerCase();
  const known = EFFORT_OPTIONS.find((o) => o.value === lower);
  return known?.value ?? lower;
}

export function newProviderLocal(): ProviderConfig {
  return {
    id: `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: "New provider",
    baseUrl: "",
    apiKey: "",
    models: { haiku: "", sonnet: "", opus: "" },
  };
}
