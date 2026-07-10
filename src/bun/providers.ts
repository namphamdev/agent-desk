/**
 * Provider helpers: normalize stored provider configs and build env vars
 * for Claude Code ACP (`ANTHROPIC_*`).
 */
import type {
  AppSettings,
  ClaudeModelAlias,
  ProviderConfig,
} from "../shared/rpc";

export const CLAUDE_MODEL_ALIASES: ClaudeModelAlias[] = [
  "haiku",
  "sonnet",
  "opus",
];

export const EMPTY_PROVIDER_MODELS: ProviderConfig["models"] = {
  haiku: "",
  sonnet: "",
  opus: "",
};

export function newProviderId(): string {
  return `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createEmptyProvider(
  partial?: Partial<ProviderConfig>,
): ProviderConfig {
  return {
    id: partial?.id || newProviderId(),
    name: partial?.name?.trim() || "New provider",
    baseUrl: partial?.baseUrl?.trim() || "",
    apiKey: partial?.apiKey ?? "",
    models: {
      haiku: partial?.models?.haiku?.trim() ?? "",
      sonnet: partial?.models?.sonnet?.trim() ?? "",
      opus: partial?.models?.opus?.trim() ?? "",
    },
  };
}

/** Coerce untrusted / partial JSON into a clean ProviderConfig list. */
export function normalizeProviders(
  raw: unknown,
): ProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Partial<ProviderConfig>;
    if (!p.id || typeof p.id !== "string") continue;
    const models =
      p.models && typeof p.models === "object" ? p.models : EMPTY_PROVIDER_MODELS;
    out.push({
      id: p.id,
      name:
        typeof p.name === "string" && p.name.trim()
          ? p.name.trim()
          : "Provider",
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl.trim() : "",
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      models: {
        haiku: typeof models.haiku === "string" ? models.haiku.trim() : "",
        sonnet: typeof models.sonnet === "string" ? models.sonnet.trim() : "",
        opus: typeof models.opus === "string" ? models.opus.trim() : "",
      },
    });
  }
  return out;
}

export function normalizeModelAlias(
  raw: unknown,
  fallback: ClaudeModelAlias = "sonnet",
): ClaudeModelAlias {
  if (typeof raw !== "string") return fallback;
  const lower = raw.trim().toLowerCase();
  if (lower === "haiku" || lower === "sonnet" || lower === "opus") {
    return lower;
  }
  return fallback;
}

export function resolveActiveProvider(
  settings: Pick<AppSettings, "providers" | "activeProviderId">,
): ProviderConfig | null {
  const providers = settings.providers ?? [];
  if (providers.length === 0) return null;
  const id = settings.activeProviderId;
  if (id) {
    const found = providers.find((p) => p.id === id);
    if (found) return found;
  }
  return providers[0] ?? null;
}

/**
 * Resolve the model id / alias Claude Code should start with.
 * Prefers the provider's mapped id for the alias; falls back to the alias.
 */
export function resolveProviderModel(
  provider: ProviderConfig | null,
  alias: ClaudeModelAlias,
): string {
  if (!provider) return alias;
  const mapped = provider.models[alias]?.trim();
  return mapped || alias;
}

/**
 * Env keys Claude Code / ACP read for routing + auth. When a provider is
 * active we force these so ~/.claude/settings.json cannot leave stale values.
 */
export const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_MODEL",
] as const;

/**
 * Build env overrides for Claude Code ACP.
 *
 * Returns null when no provider is active. When a provider is set, every
 * routing/auth key is present (empty string clears a parent value) so the
 * selected provider fully replaces host env and user settings.env.
 */
export function buildProviderEnv(
  provider: ProviderConfig | null,
  modelAlias: ClaudeModelAlias,
): Record<string, string> | null {
  if (!provider) return null;

  const baseUrl = provider.baseUrl.trim();
  const key = provider.apiKey.trim();
  const haiku = provider.models.haiku.trim();
  const sonnet = provider.models.sonnet.trim();
  const opus = provider.models.opus.trim();
  const model = resolveProviderModel(provider, modelAlias);

  // Always set the full set — empty string unsets inheritance from the
  // Electrobun process / prior provider when a field is blank.
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    // Gateways often want AUTH_TOKEN (Bearer); direct Anthropic uses API_KEY.
    // Set both to the same value so either path works.
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
    ANTHROPIC_MODEL: model,
  };

  return env;
}

/**
 * ACP session/new `_meta.claudeCode.options` so credentials win over
 * ~/.claude/settings.json (claude-agent-acp merges options.env over process.env
 * and loads user settings via settingSources).
 */
export function buildClaudeCodeSessionMeta(
  provider: ProviderConfig | null,
  modelAlias: ClaudeModelAlias,
): Record<string, unknown> | undefined {
  const env = buildProviderEnv(provider, modelAlias);
  if (!env) return undefined;

  return {
    claudeCode: {
      options: {
        env,
        // Prefer alias so ACP model picker + ANTHROPIC_DEFAULT_* maps work.
        // Mapped id is still applied via env.ANTHROPIC_MODEL.
        model: modelAlias,
        // Skip user settings.env (~/.claude/settings.json) which would
        // otherwise overwrite the selected provider's base_url / api_key.
        // Project + local settings still apply (repo permissions, etc.).
        settingSources: ["project", "local"],
      },
    },
  };
}

/**
 * Stable key for "would a reconnect pick up different credentials/model?"
 * Used to force-respawn the ACP process when the active provider changes.
 */
export function providerConnectionKey(
  settings: Pick<
    AppSettings,
    "providers" | "activeProviderId" | "activeModelAlias"
  >,
): string {
  const provider = resolveActiveProvider(settings);
  const alias = normalizeModelAlias(settings.activeModelAlias, "sonnet");
  if (!provider) return `none:${alias}`;
  // Include fields that affect spawn env (not display name).
  return [
    provider.id,
    provider.baseUrl.trim(),
    provider.apiKey.trim() ? "key" : "nokey",
    // Length-only so we don't embed secrets in logs; full key is used in env.
    String(provider.apiKey.trim().length),
    provider.models.haiku.trim(),
    provider.models.sonnet.trim(),
    provider.models.opus.trim(),
    alias,
  ].join("|");
}
