/**
 * Pure helpers for worktree shared-path config (safe for webview + Bun).
 */

export const DEFAULT_WORKTREE_SYMLINK_PATHS = ["node_modules"] as const;

/**
 * Normalize a user-configured relative path for sharing.
 * Rejects empty, absolute, and `..` escapes.
 * Always uses `/` as separator in the returned string for stable storage.
 */
export function normalizeSharedPath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return null;
  const parts = trimmed.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

export function normalizeSymlinkPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    return [...DEFAULT_WORKTREE_SYMLINK_PATHS];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const norm = normalizeSharedPath(p);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/** Parse multi-line / comma-separated settings text into shared paths. */
export function parseSymlinkPathsText(text: string): string[] {
  const parts = text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return normalizeSymlinkPaths(parts);
}

export function formatSymlinkPathsText(paths: string[]): string {
  return (paths.length > 0 ? paths : [...DEFAULT_WORKTREE_SYMLINK_PATHS]).join(
    "\n",
  );
}
