import { basename } from "node:path";
import type { RecentProject, SessionSummary } from "../../shared/rpc";

/**
 * Distinct project folders from recent sessions (most recently used first).
 */
export function buildRecentProjects(
  sessions: SessionSummary[],
  dismissedCwds: string[],
  limit = 12,
): RecentProject[] {
  const dismissed = new Set(dismissedCwds);
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const s of sessions) {
    const cwd = s.cwd?.trim();
    if (!cwd || seen.has(cwd) || dismissed.has(cwd)) continue;
    seen.add(cwd);
    out.push({
      project: s.project || basename(cwd),
      cwd,
      updatedAt: s.updatedAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}
