import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { initialSession, reduce } from "../session/reducer";
import type { SessionState } from "../session/reducer";
import type { SessionUpdate } from "../session/types";
import type {
  AppSettings,
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  RecentProject,
  SessionConfigOption,
  SessionSummary,
} from "../shared/rpc";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Timeline } from "./components/Timeline";
import { PromptInput } from "./components/PromptInput";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { SettingsPanel } from "./components/SettingsPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ConfirmDialog } from "./components/ConfirmDialog";
import {
  NewSessionDialog,
  type NewSessionOptions,
} from "./components/NewSessionDialog";
import { alertTurnComplete } from "./completionAlert";
import { getRpc, initRpc, setRpcListeners } from "./rpc";

function formatElapsed(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export default function App() {
  const [session, setSession] = useState<SessionState>(initialSession);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatePayload>({
    status: "idle",
  });
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [configOptions, setConfigOptions] = useState<SessionConfigOption[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [agents, setAgents] = useState<import("../shared/rpc").AgentInfo[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  /** True while waiting for history after clicking a session in the sidebar. */
  const [sessionLoading, setSessionLoading] = useState(false);
  /**
   * Per-session sidebar activity:
   * - processing: agent is running a turn (loading spinner)
   * - done: turn finished; blue indicator until the session is opened again
   */
  const [sessionActivity, setSessionActivity] = useState<
    Record<string, "processing" | "done">
  >({});
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const refreshRecentProjects = useCallback(async () => {
    try {
      const r = await getRpc().request.listRecentProjects();
      setRecentProjects(r.projects);
    } catch {
      /* ignore — older bridges */
    }
  }, []);

  const handleRemoveRecentProject = useCallback(async (cwd: string) => {
    try {
      const r = await getRpc().request.removeRecentProject({ cwd });
      if (r.ok) setRecentProjects(r.projects);
      else await refreshRecentProjects();
    } catch {
      /* ignore — older bridges */
    }
  }, [refreshRecentProjects]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  // Resolve real git branch for the active session's project folder.
  useEffect(() => {
    const cwd = activeSession?.cwd;
    if (!cwd) {
      setGitBranch(null);
      return;
    }
    let cancelled = false;
    void getRpc()
      .request.getGitBranch({ cwd })
      .then((r) => {
        if (!cancelled) setGitBranch(r.branch);
      })
      .catch(() => {
        if (!cancelled) setGitBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession?.cwd]);

  const applyUpdate = useCallback((update: SessionUpdate) => {
    setSession((prev) => reduce(prev, update));
  }, []);

  useEffect(() => {
    initRpc();
    setRpcListeners({
      onUpdate: (sessionId, update) => {
        const active = activeSessionIdRef.current;
        if (active && sessionId !== active) return;
        applyUpdate(update);
      },
      onTurnEnd: ({ sessionId }) => {
        setTurnStartedAt(null);
        setConnection((c) =>
          c.status === "prompting" ? { ...c, status: "ready" } : c,
        );
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
          title: session?.title
            ? `Done: ${session.title}`
            : "Task complete",
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
      }) => {
        setActiveSessionId(s.id);
        setCommands(cmds);
        setConfigOptions(opts ?? []);
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
        }
      },
      onConfigOptions: (sessionId, opts) => {
        const active = activeSessionIdRef.current;
        if (!active || sessionId === active) setConfigOptions(opts);
      },
    });

    const rpc = getRpc();
    void rpc.request.listSessions().then((r) => {
      setSessions(r.sessions);
      setActiveSessionId(r.activeSessionId);
    });
    void rpc.request.getConnectionState().then(setConnection);
    void rpc.request.getSettings().then(setSettings);
    void rpc.request.listAgents().then((r) => setAgents(r.agents));
    void rpc.request.listRecentProjects().then((r) => setRecentProjects(r.projects));
    void rpc.request.connectAgent().then(() => {

    });
  }, [applyUpdate]);

  // Elapsed timer while prompting.
  useEffect(() => {
    if (connection.status !== "prompting") return;
    if (!turnStartedAt) setTurnStartedAt(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [connection.status, turnStartedAt]);

  const handlePrompt = async (text: string) => {
    // Require an explicit project folder before the first prompt.
    if (!activeSessionId) {
      await handleNewSession();
      return;
    }

    const sessionId = activeSessionId;
    setTurnStartedAt(Date.now());
    setSessionActivity((prev) => ({ ...prev, [sessionId]: "processing" }));

    applyUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });
    const res = await getRpc().request.sendPrompt({
      text,
      sessionId,
    });
    if (!res.ok) {
      setSessionActivity((prev) => {
        if (prev[sessionId] !== "processing") return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setConnection({ status: "error", error: res.error });
    }
  };

  const handleCancel = async () => {
    const sessionId = activeSessionId;
    await getRpc().request.cancel({
      sessionId: sessionId ?? undefined,
    });
    if (sessionId) {
      setSessionActivity((prev) => {
        if (prev[sessionId] !== "processing") return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    }
  };

  const handleNewSession = async () => {
    await refreshRecentProjects();
    setShowNewSession(true);
  };

  /** Create a new chat in an existing project (sidebar + button), no folder picker. */
  const handleNewInProject = async (project: string) => {
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
  };

  const handlePickFolder = async (
    startingFolder?: string,
  ): Promise<string | null> => {
    const res = await getRpc().request.pickFolder(
      startingFolder ? { startingFolder } : undefined,
    );
    if (res.ok) return res.path;
    if (res.cancelled) return null;
    throw new Error(res.error || "Could not open folder picker");
  };

  const handleCreateSession = async (opts: NewSessionOptions) => {
    // Clear prior session UI before create. Do not clear again after the RPC
    // returns — createSession already pushes onSessionLoaded / onConfigOptions
    // with model/effort selectors; a post-success wipe hid the Selector.
    setSession(initialSession);
    setCommands([]);
    setConfigOptions([]);
    setPermission(null);

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
  };

  const handleSwitchSession = async (id: string) => {
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
    setSession(initialSession);
    setCommands([]);
    setConfigOptions([]);
    setPermission(null);
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
  };

  const handleDeleteSession = async (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    setPendingDelete(target);
  };

  const confirmDeleteSession = async () => {
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
  };

  const handlePermission = async (optionId: string) => {
    if (!permission) return;
    await getRpc().request.respondPermission({
      requestId: permission.requestId,
      optionId,
    });
    setPermission(null);
  };

  const handleOpenFile = async (path: string, line?: number) => {
    await getRpc().request.openFile({ path, line });
  };

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
      setSession(initialSession);
      setCommands([]);
      setConfigOptions([]);
      setPermission(null);

      const res = await getRpc().request.createSession({
        cwd,
        project: activeSession?.project,
        agentId: activeSession?.agentId || settings?.defaultAgentId || undefined,
        seedContext: { text, role },
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

  const handleSaveSettings = async (patch: Partial<AppSettings>) => {
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
  };

  const elapsed =
    turnStartedAt && connection.status === "prompting"
      ? formatElapsed(now - turnStartedAt)
      : null;

  const isPrompting = connection.status === "prompting";

  return (
    <div
      className="app-shell flex h-full min-h-0 w-full overflow-hidden"
      data-theme={settings?.theme ?? "dark"}
    >
      {showSidebar && (
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          sessionActivity={sessionActivity}
          onSelect={handleSwitchSession}
          onNew={handleNewSession}
          onNewInProject={(project) => void handleNewInProject(project)}
          onDeleteSession={handleDeleteSession}
          onOpenSettings={() => setShowSettings(true)}
          onWindowControl={(action) => {
            void getRpc().request.windowControl({ action });
          }}
        />
      )}
      <main className="main-bg relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0">
          <Header
            title={activeSession?.title ?? "New session"}
            project={activeSession?.project ?? "—"}
            cwd={activeSession?.cwd}
            branch={gitBranch}
            connection={connection}
            onToggleSidebar={() => setShowSidebar((s) => !s)}
            onOpenSettings={() => setShowSettings(true)}
            showWindowControls={!showSidebar}
            onWindowControl={(action) => {
              void getRpc().request.windowControl({ action });
            }}
          />
          <ConnectionBanner connection={connection} />
        </div>
        {/*
          Legend List rows are absolutely positioned, so this region must have a
          real height (flex-1 + relative). Timeline fills via absolute inset-0.
        */}
        <div className="relative min-h-0 min-w-0 flex-1">
          <Timeline
            sessionKey={activeSessionId}
            entries={session.timeline}
            onOpenFile={handleOpenFile}
            messageActions={messageActions}
            header={
              elapsed || session.timeline.length > 0 ? (
                <span>
                  {isPrompting
                    ? `Working${elapsed ? ` · ${elapsed}` : "…"}`
                    : session.timeline.length > 0
                      ? "Ready"
                      : "Start a conversation"}
                </span>
              ) : null
            }
            empty={
              sessionLoading ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-gray-500">
                  <div
                    className="h-5 w-5 animate-spin rounded-full border-2 border-[#444] border-t-gray-300"
                    aria-hidden
                  />
                  <p className="text-gray-400">Loading chat…</p>
                </div>
              ) : connection.status === "ready" ? (
                <div className="rounded-2xl border border-dashed border-[#333] px-6 py-12 text-center text-sm text-gray-500">
                  <p className="mb-2 text-base text-gray-400">
                    {activeSession
                      ? `Connected to ${connection.agentName ?? "agent"}`
                      : "No project open"}
                  </p>
                  {activeSession ? (
                    <>
                      <p className="mb-1">
                        Working in{" "}
                        <span className="font-mono text-gray-400">
                          {activeSession.cwd}
                        </span>
                      </p>
                      <p>Type a prompt below to start.</p>
                    </>
                  ) : (
                    <>
                      <p className="mb-4">
                        Choose a project folder to start a coding-agent session.
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleNewSession()}
                        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
                      >
                        Open project…
                      </button>
                    </>
                  )}
                </div>
              ) : connection.status === "connecting" ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-gray-500">
                  <div
                    className="h-5 w-5 animate-spin rounded-full border-2 border-[#444] border-t-gray-300"
                    aria-hidden
                  />
                  <p className="text-gray-400">
                    Connecting to {connection.agentName ?? "agent"}…
                  </p>
                </div>
              ) : null
            }
          />
        </div>
        {permission && (
          <PermissionPrompt
            request={permission}
            onRespond={handlePermission}
          />
        )}
        <PromptInput
          disabled={connection.status === "connecting" || connection.status === "idle"}
          prompting={isPrompting}
          commands={commands}
          mode={session.mode}
          configOptions={configOptions}
          onSubmit={handlePrompt}
          onCancel={handleCancel}
          onSetConfigOption={handleSetConfigOption}
        />
        {showSettings && settings && (
          <SettingsPanel
            settings={settings}
            agents={agents}
            onClose={() => setShowSettings(false)}
            onSave={handleSaveSettings}
          />
        )}
        {showNewSession && (
          <NewSessionDialog
            agents={agents}
            defaultAgentId={settings?.defaultAgentId ?? agents[0]?.id ?? null}
            defaultCwd={
              settings?.lastProjectCwd ||
              activeSession?.cwd ||
              recentProjects[0]?.cwd ||
              ""
            }
            recentProjects={recentProjects}
            onPickFolder={handlePickFolder}
            onRemoveRecent={handleRemoveRecentProject}
            onCancel={() => setShowNewSession(false)}
            onCreate={handleCreateSession}
          />
        )}
        {pendingDelete && (
          <ConfirmDialog
            title="Delete session?"
            message={`"${pendingDelete.title || "Untitled session"}" will be permanently deleted. This cannot be undone.`}
            confirmLabel="Delete"
            cancelLabel="Cancel"
            destructive
            onConfirm={() => void confirmDeleteSession()}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </main>
    </div>
  );
}
