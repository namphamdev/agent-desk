/**
 * Sidebar project-group ordering helpers.
 *
 * Default discovery order follows session recency (most recent session first).
 * After that, order is sticky: deleting a chat must not reshuffle projects.
 * New projects append in discovery order. Manual reorder (Sidebar) writes the
 * full order array and is preserved the same way.
 */

export type SessionProjectRef = {
  project?: string | null;
  updatedAt: number;
};

/** Project keys in first-seen order over sessions sorted by updatedAt desc. */
export function projectKeysBySessionRecency(
  sessions: SessionProjectRef[],
): string[] {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sorted) {
    const key = s.project || "other";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Keep previous project order for still-present groups; append newcomers.
 * Empty prev seeds from session recency.
 */
export function reconcileProjectOrder(
  prevOrder: string[],
  sessions: SessionProjectRef[],
): string[] {
  const discovered = projectKeysBySessionRecency(sessions);
  if (prevOrder.length === 0) return discovered;

  const present = new Set(discovered);
  const kept = prevOrder.filter((p) => present.has(p));
  const keptSet = new Set(kept);
  const newcomers = discovered.filter((p) => !keptSet.has(p));
  return [...kept, ...newcomers];
}
