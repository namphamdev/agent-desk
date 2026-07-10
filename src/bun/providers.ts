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
 * Build env overrides for the Claude Code ACP subprocess.
 * Returns null when no provider is active (caller keeps process.env only).
 */
export function buildProviderEnv(
  provider: ProviderConfig | null,
  modelAlias: ClaudeModelAlias,
): Record<string, string> | null {
  if (!provider) return null;

  const env: Record<string, string> = {};

  if (provider.baseUrl.trim()) {
    env.ANTHROPIC_BASE_URL = provider.baseUrl.trim();
  }

  const key = provider.apiKey.trim();
  if (key) {
    // Direct Anthropic + most gateways accept API_KEY; some gateways prefer
    // AUTH_TOKEN (Bearer). Set both so either style works.
    env.ANTHROPIC_API_KEY = key;
    env.ANTHROPIC_AUTH_TOKEN = key;
  }

  if (provider.models.haiku.trim()) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.models.haiku.trim();
  }
  if (provider.models.sonnet.trim()) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.models.sonnet.trim();
  }
  if (provider.models.opus.trim()) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.models.opus.trim();
  }

  env.ANTHROPIC_MODEL = resolveProviderModel(provider, modelAlias);

  return env;
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
