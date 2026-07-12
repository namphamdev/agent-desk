import { useCallback, useState } from "react";

export const DEFAULT_BROWSER_URL = "https://example.com";

export type SessionBrowserState = {
  /** Whether the right-side browser panel is open for this session. */
  open: boolean;
  /** Last committed URL for this session's browser. */
  url: string;
};

export type SessionBrowserMap = Record<string, SessionBrowserState>;

export const DEFAULT_BROWSER_STATE: SessionBrowserState = {
  open: false,
  url: DEFAULT_BROWSER_URL,
};

/** Read state for a session (defaults when missing). */
export function getSessionBrowserState(
  map: SessionBrowserMap,
  sessionId: string | null,
): SessionBrowserState {
  if (!sessionId) return DEFAULT_BROWSER_STATE;
  return map[sessionId] ?? DEFAULT_BROWSER_STATE;
}

/** Toggle open for a session; no-op when sessionId is null. */
export function toggleSessionBrowser(
  map: SessionBrowserMap,
  sessionId: string | null,
): SessionBrowserMap {
  if (!sessionId) return map;
  const cur = map[sessionId] ?? DEFAULT_BROWSER_STATE;
  return { ...map, [sessionId]: { ...cur, open: !cur.open } };
}

/** Patch open/url for a session; no-op when sessionId is null. */
export function patchSessionBrowser(
  map: SessionBrowserMap,
  sessionId: string | null,
  next: Partial<SessionBrowserState>,
): SessionBrowserMap {
  if (!sessionId) return map;
  const cur = map[sessionId] ?? DEFAULT_BROWSER_STATE;
  return {
    ...map,
    [sessionId]: {
      open: next.open ?? cur.open,
      url: next.url ?? cur.url,
    },
  };
}

/** Keep only sessions still present in the sidebar list. */
export function pruneSessionBrowserMap(
  map: SessionBrowserMap,
  keepIds: Set<string>,
): SessionBrowserMap {
  let changed = false;
  const next: SessionBrowserMap = {};
  for (const [id, s] of Object.entries(map)) {
    if (keepIds.has(id)) next[id] = s;
    else changed = true;
  }
  return changed ? next : map;
}

/**
 * Which session's browser panel should be mounted.
 * Prefer an agent-driven open (may not be the active chat yet), else the
 * active chat when its panel is open.
 */
export function resolveBrowserPanelSession(
  map: SessionBrowserMap,
  activeSessionId: string | null,
  agentSessionId: string | null,
): string | null {
  if (agentSessionId && (map[agentSessionId]?.open ?? false)) {
    return agentSessionId;
  }
  if (activeSessionId && (map[activeSessionId]?.open ?? false)) {
    return activeSessionId;
  }
  return null;
}

/**
 * Per-chat browser panel state (open + URL). Switching sessions restores
 * that chat's panel without sharing a global webview.
 */
export function useSessionBrowserState(activeSessionId: string | null) {
  const [bySession, setBySession] = useState<SessionBrowserMap>({});
  /** Session the agent last asked to open (panel must mount even before focus). */
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null);

  const panelSessionId = resolveBrowserPanelSession(
    bySession,
    activeSessionId,
    agentSessionId,
  );
  const state = getSessionBrowserState(bySession, panelSessionId);

  const setOpen = useCallback(
    (open: boolean) => {
      const target = panelSessionId ?? activeSessionId;
      setBySession((prev) => patchSessionBrowser(prev, target, { open }));
      if (!open) setAgentSessionId(null);
    },
    [activeSessionId, panelSessionId],
  );

  const toggle = useCallback(() => {
    const target = panelSessionId ?? activeSessionId;
    if (!target) return;
    setBySession((prev) => {
      const next = toggleSessionBrowser(prev, target);
      const opened = next[target]?.open ?? false;
      if (!opened) setAgentSessionId(null);
      return next;
    });
  }, [activeSessionId, panelSessionId]);

  const setUrl = useCallback(
    (url: string) => {
      const target = panelSessionId ?? activeSessionId;
      setBySession((prev) => patchSessionBrowser(prev, target, { url }));
    },
    [activeSessionId, panelSessionId],
  );

  const pruneSessions = useCallback((keepIds: Set<string>) => {
    setBySession((prev) => pruneSessionBrowserMap(prev, keepIds));
    setAgentSessionId((cur) => (cur && !keepIds.has(cur) ? null : cur));
  }, []);

  /**
   * Open the panel for any session (agent MCP). Mounts immediately even if
   * the user is still on another chat; caller may also switch focus.
   */
  const openForSession = useCallback((sessionId: string, url?: string) => {
    setAgentSessionId(sessionId);
    setBySession((prev) =>
      patchSessionBrowser(prev, sessionId, {
        open: true,
        ...(url ? { url } : {}),
      }),
    );
  }, []);

  return {
    sessionId: panelSessionId,
    open: Boolean(panelSessionId),
    url: state.url,
    setOpen,
    toggle,
    setUrl,
    pruneSessions,
    openForSession,
  };
}
