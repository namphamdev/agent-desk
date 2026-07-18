import type { AppSettings, SessionConfigOption } from "../../shared/rpc";
import type { AcpSessionHandle } from "../acp-client";

/**
 * Resolve a preferred settings value to an agent select option's actual value.
 * Returns null when already current, unknown, or no matching select option.
 */
export function resolveSelectOptionValue(
  options: SessionConfigOption[],
  category: string,
  idFallback: string,
  preferred: string,
): { configId: string; value: string } | null {
  const opt = options.find(
    (o) =>
      o.type === "select" &&
      (o.category === category || o.id === idFallback),
  );
  if (!opt || opt.type !== "select") return null;

  const needle = preferred.trim().toLowerCase();
  if (!needle) return null;

  const byValue = opt.options.find((o) => o.value.toLowerCase() === needle);
  const byName = opt.options.find((o) => o.name.toLowerCase() === needle);
  const match = byValue ?? byName;
  if (!match) return null;
  if (match.value === opt.currentValue) return null;
  // Also treat case-only differences in currentValue as already set.
  if (opt.currentValue.toLowerCase() === match.value.toLowerCase()) return null;

  return { configId: opt.id, value: match.value };
}

/**
 * Apply settings defaults (thought_level / mode / model) via
 * session/set_config_option when the agent exposes matching select options.
 * Matching is case-insensitive on value or display name so stored "High"
 * maps to agent value "high". Permission mode uses category/id `mode`
 * (Claude Code ACP; may be routed to session/set_mode by AcpClient).
 */
export async function applyPreferredConfigDefaults(
  handle: AcpSessionHandle,
  configOptions: SessionConfigOption[],
  settings: Pick<
    AppSettings,
    "defaultEffort" | "defaultPermissionMode" | "defaultModel"
  >,
): Promise<SessionConfigOption[]> {
  let options = configOptions;
  const prefs: Array<{
    preferred: string | undefined;
    category: string;
    idFallback: string;
  }> = [
    {
      preferred: settings.defaultEffort,
      category: "thought_level",
      idFallback: "thought_level",
    },
    {
      preferred: settings.defaultPermissionMode,
      category: "mode",
      idFallback: "mode",
    },
    {
      preferred: settings.defaultModel,
      category: "model",
      idFallback: "model",
    },
  ];

  // Prefer Agent Desk BYOK catalog model when exposed and no defaultModel set.
  if (!settings.defaultModel?.trim()) {
    const modelOpt = options.find(
      (o) =>
        o.type === "select" &&
        (o.category === "model" || o.id === "model"),
    );
    if (modelOpt && modelOpt.type === "select") {
      const byok = modelOpt.options.find((o) => o.value === "agent-desk");
      if (byok && modelOpt.currentValue !== byok.value) {
        try {
          options = await handle.setConfigOption(modelOpt.id, byok.value);
        } catch (err) {
          console.warn(
            "[session-manager] failed to pin agent-desk model:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  for (const { preferred, category, idFallback } of prefs) {
    if (!preferred?.trim()) continue;
    const target = resolveSelectOptionValue(options, category, idFallback, preferred);
    if (!target) continue;
    try {
      options = await handle.setConfigOption(target.configId, target.value);
    } catch (err) {
      console.warn(
        `[session-manager] failed to apply default ${category}=${preferred}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return options;
}
