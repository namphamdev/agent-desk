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
 * Keep in-app browser MCP tools always listed (not deferred behind ToolSearch).
 * Agents otherwise reverse-engineer the control plane when tools are hidden.
 */
export function withBrowserMcpAlwaysLoaded(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  // Empty string is falsy in Claude Code env bool parsing (not "1"/"true"/"yes"/"on").
  out.ENABLE_TOOL_SEARCH = "";
  return out;
}

/**
 * Appended to Claude Code system prompt so the model discovers the registered
 * `browser` MCP and uses it for the current chat's panel + tokens.
 */
export const BROWSER_MCP_SYSTEM_APPEND = `
## Built-in browser (AgentDesk / terminal-react)
This session has a registered MCP server named **browser** bound to THIS chat.
- Tools: browser_session_info, browser_open, browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill, browser_evaluate, browser_store_token, browser_list_tokens, browser_delete_token, browser_get_url, browser_navigate_back, browser_navigate_forward, browser_reload, browser_press_key
- The panel is the right-side in-app browser for this chat only (not a separate Chrome window).
- browser_open / browser_navigate auto-open the panel if closed.
- browser_session_info returns this chat's session id, project cwd, panel state, and stored tokens.
- After multi-step login: browser_evaluate → browser_store_token. Tokens are SQLite-backed per project and injected into later prompts.
- Do NOT curl localhost, invent control tokens, or use Playwright/external browsers for this.
`.trim();

/**
 * ACP session/new `_meta.claudeCode.options` so credentials win over
 * ~/.claude/settings.json (claude-agent-acp merges options.env over process.env
 * and loads user settings via settingSources).
 *
 * When no provider is configured, still returns meta so browser MCP tools stay
 * always-loaded and system prompt documents the `browser` server.
 */
export function buildClaudeCodeSessionMeta(
  provider: ProviderConfig | null,
  modelAlias: ClaudeModelAlias,
): Record<string, unknown> {
  const providerEnv = buildProviderEnv(provider, modelAlias) ?? {};
  const env = withBrowserMcpAlwaysLoaded(providerEnv);

  return {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: BROWSER_MCP_SYSTEM_APPEND,
    },
    claudeCode: {
      options: {
        env,
        ...(provider
          ? {
              model: modelAlias,
              // Skip user settings that re-enable ToolSearch / hide MCP tools.
              settingSources: ["project", "local"],
            }
          : {
              // Keep user settings when no app provider, but env still clears ToolSearch.
              settingSources: ["user", "project", "local"],
            }),
      },
    },
  };
}

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

/** Portable JSON schema for export/import of provider configs. */
export type ProvidersExportFile = {
  version: 1;
  providers: ProviderConfig[];
  activeProviderId?: string | null;
  activeModelAlias?: ClaudeModelAlias;
};

/**
 * Build a versioned export payload (includes API keys — treat the file as secret).
 */
export function buildProvidersExport(
  settings: Pick<
    AppSettings,
    "providers" | "activeProviderId" | "activeModelAlias"
  >,
): ProvidersExportFile {
  const providers = normalizeProviders(settings.providers);
  let activeProviderId =
    typeof settings.activeProviderId === "string"
      ? settings.activeProviderId
      : settings.activeProviderId === null
        ? null
        : null;
  if (
    activeProviderId &&
    !providers.some((p) => p.id === activeProviderId)
  ) {
    activeProviderId = providers[0]?.id ?? null;
  }
  if (providers.length === 0) activeProviderId = null;

  return {
    version: 1,
    providers,
    activeProviderId,
    activeModelAlias: normalizeModelAlias(
      settings.activeModelAlias,
      "sonnet",
    ),
  };
}

export function serializeProvidersExport(
  settings: Pick<
    AppSettings,
    "providers" | "activeProviderId" | "activeModelAlias"
  >,
): string {
  return `${JSON.stringify(buildProvidersExport(settings), null, 2)}\n`;
}

export type ProvidersImportResult =
  | {
      ok: true;
      providers: ProviderConfig[];
      activeProviderId: string | null;
      activeModelAlias: ClaudeModelAlias;
    }
  | { ok: false; error: string };

/**
 * Parse a providers export file or a bare provider array.
 * Accepts missing ids (assigns new ones) so partial hand-edited JSON still works.
 */
export function parseProvidersImport(raw: unknown): ProvidersImportResult {
  let list: unknown;
  let activeProviderId: string | null | undefined;
  let activeModelAlias: unknown;

  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.providers)) {
      return {
        ok: false,
        error: "Invalid file: expected { providers: [...] } or a provider array",
      };
    }
    if (
      obj.version !== undefined &&
      obj.version !== 1 &&
      obj.version !== "1"
    ) {
      return { ok: false, error: `Unsupported export version: ${String(obj.version)}` };
    }
    list = obj.providers;
    if (typeof obj.activeProviderId === "string") {
      activeProviderId = obj.activeProviderId;
    } else if (obj.activeProviderId === null) {
      activeProviderId = null;
    }
    activeModelAlias = obj.activeModelAlias;
  } else {
    return { ok: false, error: "Invalid file: not JSON object or array" };
  }

  // Assign ids before normalizeProviders (which drops entries without id).
  const withIds = (Array.isArray(list) ? list : []).map((item) => {
    if (!item || typeof item !== "object") return item;
    const p = item as Partial<ProviderConfig>;
    if (typeof p.id === "string" && p.id.trim()) return item;
    return { ...p, id: newProviderId() };
  });

  const providers = normalizeProviders(withIds);
  if (providers.length === 0) {
    return { ok: false, error: "No valid providers found in file" };
  }

  let resolvedActive: string | null =
    activeProviderId === undefined ? providers[0]?.id ?? null : activeProviderId;
  if (
    resolvedActive &&
    !providers.some((p) => p.id === resolvedActive)
  ) {
    resolvedActive = providers[0]?.id ?? null;
  }

  return {
    ok: true,
    providers,
    activeProviderId: resolvedActive,
    activeModelAlias: normalizeModelAlias(activeModelAlias, "sonnet"),
  };
}

/**
 * Parse JSON text from an import file.
 */
export function parseProvidersImportText(text: string): ProvidersImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  return parseProvidersImport(raw);
}
