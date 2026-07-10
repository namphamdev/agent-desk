import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { initialSession, reduce } from "../../session/reducer";
import type { SessionState } from "../../session/reducer";
import type { SessionUpdate } from "../../session/types";
import type {
  AppSettings,
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  SessionConfigOption,
  SessionSummary,
  SessionUsage,
} from "../../shared/rpc";
import { alertTurnComplete } from "../completionAlert";
import type { RpcListeners } from "../rpc";

export type SessionActivity = Record<string, "processing" | "done">;

type Deps = {
  activeSessionIdRef: MutableRefObject<string | null>;
  settingsRef: MutableRefObject<AppSettings | null>;
  sessionsRef: MutableRefObject<SessionSummary[]>;
  busySessionsRef: MutableRefObject<Set<string>>;
  flushPromptQueueRef: MutableRefObject<(sessionId: string) => boolean>;
  applyUpdate: (update: SessionUpdate) => void;
  setSession: Dispatch<SetStateAction<SessionState>>;
  setSessions: Dispatch<SetStateAction<SessionSummary[]>>;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  setConnection: Dispatch<SetStateAction<ConnectionStatePayload>>;
  setPermission: Dispatch<SetStateAction<PermissionRequest | null>>;
  setCommands: Dispatch<SetStateAction<AvailableCommand[]>>;
  setConfigOptions: Dispatch<SetStateAction<SessionConfigOption[]>>;
  setUsage: Dispatch<SetStateAction<SessionUsage | null>>;
  setSessionLoading: Dispatch<SetStateAction<boolean>>;
  setSessionActivity: Dispatch<SetStateAction<SessionActivity>>;
  setTurnStartedAt: Dispatch<SetStateAction<number | null>>;
};

/** Build the one-shot RPC listener map for the main app shell. */
export function createAppRpcListeners(deps: Deps): RpcListeners {
  const {
    activeSessionIdRef,
    settingsRef,
    sessionsRef,
    busySessionsRef,
    flushPromptQueueRef,
    applyUpdate,
    setSession,
    setSessions,
    setActiveSessionId,
    setConnection,
    setPermission,
    setCommands,
    setConfigOptions,
    setUsage,
    setSessionLoading,
    setSessionActivity,
    setTurnStartedAt,
  } = deps;

  return {
    onUpdate: (sessionId, update) => {
      const active = activeSessionIdRef.current;
      if (active && sessionId !== active) return;
      applyUpdate(update);
    },
    onTurnEnd: ({ sessionId }) => {
      if (sessionId) busySessionsRef.current.delete(sessionId);
      setTurnStartedAt(null);
      setConnection((c) =>
        c.status === "prompting" ? { ...c, status: "ready" } : c,
      );

      // Auto-send the next queued follow-up for this session (if any).
      // Skip the "done" chime/indicator so chained prompts feel continuous.
      if (sessionId && flushPromptQueueRef.current(sessionId)) {
        return;
      }

      if (sessionId) {
        setSessionActivity((prev) => ({ ...prev, [sessionId]: "done" }));
      }
      const s = settingsRef.current;
      const session = sessionsRef.current.find((x) => x.id === sessionId);
      // Desktop: Bun already posts Utils.showNotification on turn end.
      // Here we only play the in-app chime (and cover browser mock).
      void alertTurnComplete({
        enableNotifications: s?.enableNotifications ?? true,
        enableSound: s?.enableSound ?? true,
        nativeNotificationHandled: true,
        title: session?.title ? `Done: ${session.title}` : "Task complete",
        body: session?.project
          ? `${session.project} · agent finished responding`
          : "The agent finished responding.",
      });
    },
    onConnectionState: (state) => {
      setConnection(state);
      if (state.status === "prompting" && state.sessionId) {
        setSessionActivity((prev) => ({
          ...prev,
          [state.sessionId!]: "processing",
        }));
      }
      if (
        (state.status === "error" || state.status === "disconnected") &&
        state.sessionId
      ) {
        setSessionActivity((prev) => {
          if (prev[state.sessionId!] !== "processing") return prev;
          const next = { ...prev };
          delete next[state.sessionId!];
          return next;
        });
      }
    },
    onPermissionRequest: (req) => setPermission(req),
    onSessionList: ({ sessions: list, activeSessionId: active }) => {
      setSessions(list);
      setActiveSessionId(active);
    },
    onSessionLoaded: ({
      session: s,
      updates,
      mode,
      commands: cmds,
      configOptions: opts,
      usage: sessionUsage,
    }) => {
      setActiveSessionId(s.id);
      setCommands(cmds);
      setConfigOptions(opts ?? []);
      setUsage(sessionUsage ?? null);
      setSessionLoading(false);
      let next = initialSession;
      for (const u of updates) next = reduce(next, u);
      next = { ...next, mode };
      setSession(next);
    },
    onCommands: (sessionId, cmds) => {
      const active = activeSessionIdRef.current;
      if (!active || sessionId === active) setCommands(cmds);
    },
    onMode: (sessionId, mode) => {
      const active = activeSessionIdRef.current;
      if (!active || sessionId === active) {
        setSession((prev) => ({ ...prev, mode }));
        // Keep Permission / mode selector currentValue in sync.
        setConfigOptions((prev) =>
          prev.map((o) =>
            o.type === "select" &&
            (o.category === "mode" || o.id === "mode") &&
            o.currentValue !== mode
              ? { ...o, currentValue: mode }
              : o,
          ),
        );
      }
    },
    onConfigOptions: (sessionId, opts) => {
      const active = activeSessionIdRef.current;
      if (!active || sessionId === active) setConfigOptions(opts);
    },
    onUsage: (sessionId, nextUsage) => {
      const active = activeSessionIdRef.current;
      if (!active || sessionId === active) setUsage(nextUsage);
    },
  };
}
