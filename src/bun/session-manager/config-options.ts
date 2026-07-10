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
 * Apply settings defaults (thought_level / model) via session/set_config_option
 * when the agent exposes matching select options. Matching is case-insensitive
 * on value or display name so stored "High" maps to agent value "high".
 */
export async function applyPreferredConfigDefaults(
  handle: AcpSessionHandle,
  configOptions: SessionConfigOption[],
  settings: Pick<AppSettings, "defaultEffort" | "defaultModel">,
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
      preferred: settings.defaultModel,
      category: "model",
      idFallback: "model",
    },
  ];

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
