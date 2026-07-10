import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { initialSession, reduce } from "../../session/reducer";
import type { SessionState } from "../../session/reducer";
import type { SessionUpdate } from "../../session/types";
import {
  DEFAULT_REVIEW_PROMPT,
  reviewSessionTitle,
  summarizeSessionChanges,
} from "../../session/session-summary";
import type {
  AgentInfo,
  AppSettings,
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  RecentProject,
  RemoteAccessStatus,
  SessionConfigOption,
  SessionSummary,
  SessionUsage,
  SkillInfo,
} from "../../shared/rpc";
import type { NewSessionOptions } from "../components/NewSessionDialog";
import {
  clearSessionQueue,
  dequeuePrompt,
  enqueuePrompt,
  getQueue,
  removeQueuedPrompt,
  type PromptQueues,
} from "../promptQueue";
import { getRpc, initRpc, isRemoteAccessClient, setRpcListeners } from "../rpc";
import { formatElapsed } from "../utils/formatElapsed";
import {
  createAppRpcListeners,
  type SessionActivity,
} from "./createAppRpcListeners";
import { useGitBranch } from "./useGitBranch";

function clearSessionUi(
  setSession: (s: SessionState) => void,
  setCommands: (c: AvailableCommand[]) => void,
  setConfigOptions: (o: SessionConfigOption[]) => void,
  setPermission: (p: PermissionRequest | null) => void,
) {
  setSession(initialSession);
  setCommands([]);
  setConfigOptions([]);
  setPermission(null);
}

/**
 * Owns all main-app state, RPC bootstrap, and action handlers so App.tsx
 * stays a thin composition shell.
 */
export function useAppController() {
  const [session, setSession] = useState<SessionState>(initialSession);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatePayload>({
    status: "idle",
  });
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [configOptions, setConfigOptions] = useState<SessionConfigOption[]>([]);
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsBusyId, setSkillsBusyId] = useState<string | null>(null);
  const [showRemoteAccess, setShowRemoteAccess] = useState(false);
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessStatus | null>(
    null,
  );
  const [remoteAccessLoading, setRemoteAccessLoading] = useState(false);
  const [remoteAccessError, setRemoteAccessError] = useState<string | null>(
    null,
  );
  const [showNewSession, setShowNewSession] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(
    null,
  );
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  // Remote/phone: start with chat full-width; open sessions via header menu.
  const [showSidebar, setShowSidebar] = useState(() => !isRemoteAccessClient());
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  /** True while waiting for history after clicking a session in the sidebar. */
  const [sessionLoading, setSessionLoading] = useState(false);
  /**
   * Per-session sidebar activity:
   * - processing: agent is running a turn (loading spinner)
   * - done: turn finished; blue indicator until the session is opened again
   */
  const [sessionActivity, setSessionActivity] = useState<SessionActivity>({});
  /**
   * Per-session follow-up queue. ACP allows one prompt at a time; while a
   * turn is in flight, further submits land here and flush on turn end.
   */
  const [promptQueues, setPromptQueues] = useState<PromptQueues>({});

  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const promptQueuesRef = useRef(promptQueues);
  promptQueuesRef.current = promptQueues;
  /** Sessions with an in-flight agent turn (local, independent of connection banner). */
  const busySessionsRef = useRef(new Set<string>());

  const refreshRecentProjects = useCallback(async () => {
    try {
      const r = await getRpc().request.listRecentProjects();
      setRecentProjects(r.projects);
    } catch {
      /* ignore — older bridges */
    }
  }, []);

  const handleRemoveRecentProject = useCallback(
    async (cwd: string) => {
      try {
        const r = await getRpc().request.removeRecentProject({ cwd });
        if (r.ok) setRecentProjects(r.projects);
        else await refreshRecentProjects();
      } catch {
        /* ignore — older bridges */
      }
    },
    [refreshRecentProjects],
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const gitBranch = useGitBranch(activeSession?.cwd);

  const applyUpdate = useCallback((update: SessionUpdate) => {
    setSession((prev) => reduce(prev, update));
  }, []);

  const dispatchPrompt = useCallback(
    async (text: string, sessionId: string) => {
      busySessionsRef.current.add(sessionId);
      setSessionActivity((prev) => ({ ...prev, [sessionId]: "processing" }));

      // Only mutate the visible timeline when this session is active.
      if (sessionId === activeSessionIdRef.current) {
        setTurnStartedAt(Date.now());
        applyUpdate({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text },
        });
      }

      const res = await getRpc().request.sendPrompt({
        text,
        sessionId,
      });
      if (!res.ok) {
        busySessionsRef.current.delete(sessionId);
        setSessionActivity((prev) => {
          if (prev[sessionId] !== "processing") return prev;
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        setConnection({ status: "error", error: res.error });
      }
    },
    [applyUpdate],
  );

  const flushPromptQueue = useCallback(
    (sessionId: string): boolean => {
      const { next, queues } = dequeuePrompt(
        promptQueuesRef.current,
        sessionId,
      );
      if (!next) return false;
      promptQueuesRef.current = queues;
      setPromptQueues(queues);
      void dispatchPrompt(next.text, sessionId);
      return true;
    },
    [dispatchPrompt],
  );

  // Keep latest flush for the one-shot RPC listener registration.
  const flushPromptQueueRef = useRef(flushPromptQueue);
  flushPromptQueueRef.current = flushPromptQueue;

  useEffect(() => {
    initRpc();
    setRpcListeners(
      createAppRpcListeners({
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
      }),
    );

    const rpc = getRpc();
    void rpc.request.listSessions().then((r) => {
      setSessions(r.sessions);
      setActiveSessionId(r.activeSessionId);
    });
    void rpc.request.getConnectionState().then(setConnection);
    void rpc.request.getSettings().then(setSettings);
    void rpc.request.listAgents().then((r) => setAgents(r.agents));
    void rpc.request
      .listRecentProjects()
      .then((r) => setRecentProjects(r.projects));
    void rpc.request.connectAgent().then(() => {});
  }, [applyUpdate]);

  // Elapsed timer while prompting.
  useEffect(() => {
    if (connection.status !== "prompting") return;
    if (!turnStartedAt) setTurnStartedAt(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [connection.status, turnStartedAt]);

  const handleNewSession = useCallback(async () => {
    await refreshRecentProjects();
    setShowNewSession(true);
  }, [refreshRecentProjects]);

  const handleCreateSession = useCallback(
    async (opts: NewSessionOptions) => {
      // Clear prior session UI before create. Do not clear again after the RPC
      // returns — createSession already pushes onSessionLoaded / onConfigOptions
      // with model/effort selectors; a post-success wipe hid the Selector.
      clearSessionUi(setSession, setCommands, setConfigOptions, setPermission);

      const res = await getRpc().request.createSession({
        cwd: opts.cwd,
        project: opts.project,
        title: opts.title,
        agentId: opts.agentId,
      });
      if (res.ok) {
        setActiveSessionId(res.session.id);
        setShowNewSession(false);
        setSettings((prev) =>
          prev ? { ...prev, lastProjectCwd: res.session.cwd } : prev,
        );
        await refreshRecentProjects();
      } else {
        setConnection({ status: "error", error: res.error });
        throw new Error(res.error);
      }
    },
    [refreshRecentProjects],
  );

  const handlePrompt = useCallback(
    async (text: string) => {
      // Require an explicit project folder before the first prompt.
      if (!activeSessionId) {
        await handleNewSession();
        return;
      }

      const sessionId = activeSessionId;
      // ACP only allows one prompt at a time — queue follow-ups while busy.
      const sessionBusy =
        busySessionsRef.current.has(sessionId) ||
        (connection.status === "prompting" &&
          (connection.sessionId === sessionId || !connection.sessionId));
      if (sessionBusy) {
        setPromptQueues((prev) => {
          const next = enqueuePrompt(prev, sessionId, text);
          promptQueuesRef.current = next;
          return next;
        });
        return;
      }

      // Idle but leftover queue (e.g. after a failed send): keep FIFO order.
      if (getQueue(promptQueuesRef.current, sessionId).length > 0) {
        setPromptQueues((prev) => {
          const next = enqueuePrompt(prev, sessionId, text);
          promptQueuesRef.current = next;
          return next;
        });
        flushPromptQueue(sessionId);
        return;
      }

      await dispatchPrompt(text, sessionId);
    },
    [
      activeSessionId,
      connection.sessionId,
      connection.status,
      dispatchPrompt,
      flushPromptQueue,
      handleNewSession,
    ],
  );

  const handleRemoveQueued = useCallback(
    (id: string) => {
      if (!activeSessionId) return;
      setPromptQueues((prev) => {
        const next = removeQueuedPrompt(prev, activeSessionId, id);
        promptQueuesRef.current = next;
        return next;
      });
    },
    [activeSessionId],
  );

  const handleClearQueue = useCallback(() => {
    if (!activeSessionId) return;
    setPromptQueues((prev) => {
      const next = clearSessionQueue(prev, activeSessionId);
      promptQueuesRef.current = next;
      return next;
    });
  }, [activeSessionId]);

  const handleCancel = useCallback(async () => {
    const sessionId = activeSessionId;
    await getRpc().request.cancel({
      sessionId: sessionId ?? undefined,
    });
    // Keep the follow-up queue: when the cancelled turn fully stops
    // (onTurnEnd), the next item is sent automatically.
    if (sessionId) {
      setSessionActivity((prev) => {
        if (prev[sessionId] !== "processing") return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    }
  }, [activeSessionId]);

  /** Create a new chat in an existing project (sidebar + button), no folder picker. */
  const handleNewInProject = useCallback(
    async (project: string) => {
      const fromSession = sessions.find(
        (s) => (s.project || "other") === project,
      );
      const fromRecent = recentProjects.find((p) => p.project === project);
      const cwd = fromSession?.cwd || fromRecent?.cwd;
      if (!cwd) {
        // Unknown path — fall back to the full new-session dialog.
        await handleNewSession();
        return;
      }
      try {
        await handleCreateSession({
          cwd,
          project: project === "other" ? undefined : project,
          agentId:
            fromSession?.agentId || settings?.defaultAgentId || undefined,
        });
      } catch {
        // handleCreateSession already sets connection error state.
      }
    },
    [
      handleCreateSession,
      handleNewSession,
      recentProjects,
      sessions,
      settings?.defaultAgentId,
    ],
  );

  const handlePickFolder = useCallback(
    async (startingFolder?: string): Promise<string | null> => {
      const res = await getRpc().request.pickFolder(
        startingFolder ? { startingFolder } : undefined,
      );
      if (res.ok) return res.path;
      if (res.cancelled) return null;
      throw new Error(res.error || "Could not open folder picker");
    },
    [],
  );

  const handleSwitchSession = useCallback(
    async (id: string) => {
      if (id === activeSessionId) return;
      // Instant sidebar highlight + clear stale timeline so the main panel
      // doesn't keep showing the previous session while history loads.
      setActiveSessionId(id);
      // Opening a session acknowledges the completed-turn indicator.
      setSessionActivity((prev) => {
        if (prev[id] !== "done") return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      clearSessionUi(setSession, setCommands, setConfigOptions, setPermission);
      setSessionLoading(true);
      setTurnStartedAt(null);
      try {
        const res = await getRpc().request.switchSession({ sessionId: id });
        if (!res.ok) {
          setSessionLoading(false);
          setConnection({ status: "error", error: res.error });
        }
      } catch (err) {
        setSessionLoading(false);
        setConnection({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeSessionId],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      const target = sessions.find((s) => s.id === id);
      if (!target) return;
      setPendingDelete(target);
    },
    [sessions],
  );

  const handleOffloadSession = useCallback(async (id: string) => {
    try {
      const res = await getRpc().request.offloadSession({ sessionId: id });
      if (!res.ok) {
        setConnection({
          status: "error",
          error: res.error,
        });
        return;
      }
      // Clear activity indicator for the offloaded session.
      setSessionActivity((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      setConnection({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const confirmDeleteSession = useCallback(async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    const id = target.id;
    // Optimistically remove from sidebar; backend re-emits the authoritative list.
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setSessionActivity((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    busySessionsRef.current.delete(id);
    setPromptQueues((prev) => {
      const next = clearSessionQueue(prev, id);
      promptQueuesRef.current = next;
      return next;
    });
    // If we're deleting the active session, clear the main panel.
    if (id === activeSessionId) {
      setActiveSessionId(null);
      setSession(initialSession);
      setSessionLoading(false);
    }
    try {
      await getRpc().request.deleteSession({ sessionId: id });
    } catch (err) {
      setConnection({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [activeSessionId, pendingDelete]);

  const handlePermission = useCallback(
    async (optionId: string) => {
      if (!permission) return;
      await getRpc().request.respondPermission({
        requestId: permission.requestId,
        optionId,
      });
      setPermission(null);
    },
    [permission],
  );

  const handleOpenFile = useCallback(async (path: string, line?: number) => {
    await getRpc().request.openFile({ path, line });
  }, []);

  const handleCopyMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;
    try {
      await getRpc().request.writeClipboard({ text });
    } catch {
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const handleNewThreadFromMessage = useCallback(
    async (text: string, role: "user" | "agent" | "thought") => {
      if (!text.trim()) return;
      const cwd =
        activeSession?.cwd ||
        settings?.lastProjectCwd ||
        recentProjects[0]?.cwd;
      if (!cwd) {
        setConnection({
          status: "error",
          error: "Open a project before starting a new thread from a message.",
        });
        return;
      }
      // Clear prior UI first; onSessionLoaded will apply seed + configOptions.
      clearSessionUi(setSession, setCommands, setConfigOptions, setPermission);

      const res = await getRpc().request.createSession({
        cwd,
        project: activeSession?.project,
        agentId:
          activeSession?.agentId || settings?.defaultAgentId || undefined,
        seedContext: { text, role, purpose: "continue" },
      });
      if (res.ok) {
        setActiveSessionId(res.session.id);
        setSettings((prev) =>
          prev ? { ...prev, lastProjectCwd: res.session.cwd } : prev,
        );
        await refreshRecentProjects();
      } else {
        setConnection({ status: "error", error: res.error });
      }
    },
    [
      activeSession?.agentId,
      activeSession?.cwd,
      activeSession?.project,
      recentProjects,
      refreshRecentProjects,
      settings?.defaultAgentId,
      settings?.lastProjectCwd,
    ],
  );

  const [reviewBusy, setReviewBusy] = useState(false);

  /**
   * Summarize file changes from the current chat, open a new session with that
   * summary as seed context, and auto-send the default review requirement as
   * the first prompt.
   */
  const handleReviewInNewSession = useCallback(async () => {
    if (reviewBusy) return;
    const cwd =
      activeSession?.cwd ||
      settings?.lastProjectCwd ||
      recentProjects[0]?.cwd;
    if (!cwd) {
      setConnection({
        status: "error",
        error: "Open a project before starting a review session.",
      });
      return;
    }

    const summary = summarizeSessionChanges(session.timeline, {
      sessionTitle: activeSession?.title,
      project: activeSession?.project,
    });
    // Historical chats often lack ACP edit/diff kinds (shell writes, Q&A).
    // Allow review whenever there is goals / tools / agent output.
    if (!summary.hasReviewableContent) {
      setConnection({
        status: "error",
        error:
          "This session has nothing to review yet (no messages or tool activity).",
      });
      return;
    }

    setReviewBusy(true);
    try {
      clearSessionUi(setSession, setCommands, setConfigOptions, setPermission);

      const res = await getRpc().request.createSession({
        cwd,
        project: activeSession?.project,
        title: reviewSessionTitle(activeSession?.title),
        agentId:
          activeSession?.agentId || settings?.defaultAgentId || undefined,
        seedContext: {
          text: summary.text,
          role: "agent",
          purpose: "review",
        },
      });

      if (!res.ok) {
        setConnection({ status: "error", error: res.error });
        return;
      }

      setActiveSessionId(res.session.id);
      setSettings((prev) =>
        prev ? { ...prev, lastProjectCwd: res.session.cwd } : prev,
      );
      await refreshRecentProjects();

      // First requirement: structured review of the seeded change summary.
      await dispatchPrompt(DEFAULT_REVIEW_PROMPT, res.session.id);
    } finally {
      setReviewBusy(false);
    }
  }, [
    activeSession?.agentId,
    activeSession?.cwd,
    activeSession?.project,
    activeSession?.title,
    dispatchPrompt,
    recentProjects,
    refreshRecentProjects,
    reviewBusy,
    session.timeline,
    settings?.defaultAgentId,
    settings?.lastProjectCwd,
  ]);

  const canReviewSession = useMemo(() => {
    if (
      !activeSession?.cwd &&
      !settings?.lastProjectCwd &&
      !recentProjects[0]?.cwd
    ) {
      return false;
    }
    // Show for any loaded session with work — not only structured file edits.
    // (Claude ACP history often records mutations as execute/other without diffs.)
    return summarizeSessionChanges(session.timeline).hasReviewableContent;
  }, [
    activeSession?.cwd,
    recentProjects,
    session.timeline,
    settings?.lastProjectCwd,
  ]);

  const handleSetConfigOption = useCallback(
    async (configId: string, value: string | boolean) => {
      const res = await getRpc().request.setConfigOption({
        sessionId: activeSessionIdRef.current ?? undefined,
        configId,
        value,
      });
      if (res.ok) {
        setConfigOptions(res.configOptions);
      } else {
        setConnection({
          status: "error",
          error: res.error,
          agentName: connection.agentName,
          sessionId: activeSessionIdRef.current,
        });
      }
    },
    [connection.agentName],
  );

  const messageActions = useMemo(
    () => ({
      onCopyMessage: handleCopyMessage,
      onNewThreadFromMessage: handleNewThreadFromMessage,
      canNewThread: Boolean(
        activeSession?.cwd ||
          settings?.lastProjectCwd ||
          recentProjects[0]?.cwd,
      ),
    }),
    [
      handleCopyMessage,
      handleNewThreadFromMessage,
      activeSession?.cwd,
      settings?.lastProjectCwd,
      recentProjects,
    ],
  );

  const handleSaveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await getRpc().request.saveSettings(patch);
      setSettings(next);
      // Apply theme immediately.
      document.documentElement.dataset.theme =
        next.theme === "system"
          ? window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark"
          : next.theme;
      // Native sample banner on first enable is handled in Bun saveSettings.
    },
    [],
  );

  /**
   * Switch provider and/or Claude model alias in one settings write + reconnect
   * so ANTHROPIC_* env matches the selection without a double respawn.
   */
  const handleProviderModelChange = useCallback(
    async (
      providerId: string,
      alias: import("../../shared/rpc").ClaudeModelAlias,
    ) => {
      const prev = settings;
      if (
        prev?.activeProviderId === providerId &&
        prev?.activeModelAlias === alias
      ) {
        return;
      }
      const next = await getRpc().request.saveSettings({
        activeProviderId: providerId,
        activeModelAlias: alias,
      });
      setSettings(next);

      try {
        await getRpc().request.connectAgent({
          agentId:
            activeSession?.agentId || next.defaultAgentId || undefined,
          cwd: activeSession?.cwd,
        });
      } catch {
        /* connection error surface via onConnectionState */
      }
    },
    [activeSession?.agentId, activeSession?.cwd, settings],
  );

  const handleWindowControl = useCallback(
    (action: "close" | "minimize" | "maximize") => {
      void getRpc().request.windowControl({ action });
    },
    [],
  );

  const openRemoteAccess = useCallback(async () => {
    if (isRemoteAccessClient()) return;
    setShowRemoteAccess(true);
    setRemoteAccessError(null);
    setRemoteAccessLoading(true);
    try {
      const status = await getRpc().request.startRemoteAccess();
      setRemoteAccess(status);
      if (!status.running || !status.url) {
        setRemoteAccessError(
          "Could not start remote access. Ensure the desktop app is running and dist/ was built.",
        );
      }
    } catch (err) {
      setRemoteAccessError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setRemoteAccessLoading(false);
    }
  }, []);

  const startRemoteAccess = useCallback(async () => {
    setRemoteAccessError(null);
    setRemoteAccessLoading(true);
    try {
      const status = await getRpc().request.startRemoteAccess();
      setRemoteAccess(status);
    } catch (err) {
      setRemoteAccessError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setRemoteAccessLoading(false);
    }
  }, []);

  const stopRemoteAccess = useCallback(async () => {
    setRemoteAccessError(null);
    try {
      const status = await getRpc().request.stopRemoteAccess();
      setRemoteAccess(status);
    } catch (err) {
      setRemoteAccessError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }, []);

  const regenerateRemoteAccess = useCallback(async () => {
    setRemoteAccessError(null);
    setRemoteAccessLoading(true);
    try {
      const status = await getRpc().request.regenerateRemoteAccess();
      setRemoteAccess(status);
    } catch (err) {
      setRemoteAccessError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setRemoteAccessLoading(false);
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const cwd =
        sessionsRef.current.find((s) => s.id === activeSessionIdRef.current)
          ?.cwd ?? null;
      const r = await getRpc().request.listSkills({ projectCwd: cwd });
      setSkills(r.skills);
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  const openSkills = useCallback(async () => {
    setShowSkills(true);
    await refreshSkills();
  }, [refreshSkills]);

  const handleInstallSkill = useCallback(async (packageSpec: string) => {
    setSkillsError(null);
    const res = await getRpc().request.installSkill({ package: packageSpec });
    if (!res.ok) {
      setSkillsError(res.error);
      throw new Error(res.error);
    }
    setSkills(res.skills);
  }, []);

  const handleToggleSkill = useCallback(
    async (skillId: string, enabled: boolean) => {
      setSkillsBusyId(skillId);
      setSkillsError(null);
      try {
        const res = await getRpc().request.setSkillEnabled({
          skillId,
          enabled,
        });
        if (!res.ok) {
          setSkillsError(res.error);
          return;
        }
        setSkills(res.skills);
      } catch (err) {
        setSkillsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSkillsBusyId(null);
      }
    },
    [],
  );

  const handleUninstallSkill = useCallback(async (skillId: string) => {
    setSkillsBusyId(skillId);
    setSkillsError(null);
    try {
      const res = await getRpc().request.uninstallSkill({ skillId });
      if (!res.ok) {
        setSkillsError(res.error);
        return;
      }
      setSkills(res.skills);
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkillsBusyId(null);
    }
  }, []);

  const elapsed =
    turnStartedAt && connection.status === "prompting"
      ? formatElapsed(now - turnStartedAt)
      : null;

  const isPrompting = connection.status === "prompting";
  const activePromptQueue = activeSessionId
    ? getQueue(promptQueues, activeSessionId)
    : [];

  return {
    // state
    session,
    sessions,
    activeSessionId,
    activeSession,
    connection,
    permission,
    commands,
    configOptions,
    usage,
    settings,
    agents,
    showSettings,
    showSkills,
    skills,
    skillsLoading,
    skillsError,
    skillsBusyId,
    showRemoteAccess,
    remoteAccess,
    remoteAccessLoading,
    remoteAccessError,
    showNewSession,
    pendingDelete,
    recentProjects,
    showSidebar,
    sessionLoading,
    sessionActivity,
    gitBranch,
    elapsed,
    isPrompting,
    activePromptQueue,
    messageActions,
    canReviewSession,
    reviewBusy,
    // setters for simple UI toggles
    setShowSettings,
    setShowSkills,
    setShowRemoteAccess,
    setShowNewSession,
    setShowSidebar,
    setPendingDelete,
    // handlers
    handlePrompt,
    handleRemoveQueued,
    handleClearQueue,
    handleCancel,
    handleNewSession,
    handleNewInProject,
    handlePickFolder,
    handleCreateSession,
    handleSwitchSession,
    handleDeleteSession,
    handleOffloadSession,
    confirmDeleteSession,
    handlePermission,
    handleOpenFile,
    handleSetConfigOption,
    handleSaveSettings,
    handleProviderModelChange,
    handleRemoveRecentProject,
    handleWindowControl,
    handleReviewInNewSession,
    openRemoteAccess,
    startRemoteAccess,
    stopRemoteAccess,
    regenerateRemoteAccess,
    openSkills,
    refreshSkills,
    handleInstallSkill,
    handleToggleSkill,
    handleUninstallSkill,
  };
}
