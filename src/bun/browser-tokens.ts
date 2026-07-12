/**
 * Format stored browser tokens for injection into agent prompts.
 * Values go to the model so multi-step browser auth does not need repeating.
 */
import type { BrowserTokenRecord } from "./store";

/** Always prepended so agents use MCP tools instead of reverse-engineering. */
export const BROWSER_MCP_USAGE_HINT =
  `[Built-in browser] MCP server "browser" is registered for THIS chat. Prefer browser_session_info, browser_open, browser_navigate, browser_snapshot, browser_click, browser_fill, browser_store_token / browser_list_tokens. Panel auto-opens. Do not curl localhost or invent control tokens.\n`;

export function formatBrowserTokensForPrompt(
  tokens: BrowserTokenRecord[],
): string | null {
  if (tokens.length === 0) return null;
  const lines = tokens.map((t) => {
    const label = t.label ? ` (${t.label})` : "";
    const domain = t.domain ? ` [domain=${t.domain}]` : "";
    return `- ${t.key}${label}${domain}: ${t.value}`;
  });
  return (
    `[Stored browser tokens for this project — reuse these instead of re-running multi-step browser login]\n` +
    lines.join("\n") +
    `\n[End stored browser tokens]\n`
  );
}

/**
 * Prepend browser usage hint (+ optional stored tokens) so the agent always
 * sees the simple path. User-visible chat still shows only `userText`.
 */
export function injectBrowserTokensIntoPrompt(
  userText: string,
  tokens: BrowserTokenRecord[],
  opts?: { includeUsageHint?: boolean },
): string {
  const parts: string[] = [];
  if (opts?.includeUsageHint !== false) {
    parts.push(BROWSER_MCP_USAGE_HINT);
  }
  const block = formatBrowserTokensForPrompt(tokens);
  if (block) parts.push(block);
  if (parts.length === 0) return userText;
  return `${parts.join("\n")}${userText}`;
}
