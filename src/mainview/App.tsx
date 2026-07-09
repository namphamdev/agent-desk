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
  SessionSummary,
} from "../shared/rpc";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Timeline } from "./components/Timeline";
import { PromptInput } from "./components/PromptInput";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { SettingsPanel } from "./components/SettingsPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import {
  NewSessionDialog,
  type NewSessionOptions,
} from "./components/NewSessionDialog";
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
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [agents, setAgents] = useState<import("../shared/rpc").AgentInfo[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const refreshRecentProjects = useCallback(async () => {
    try {
      const r = await getRpc().request.listRecentProjects();
      setRecentProjects(r.projects);
    } catch {
      /* ignore — older bridges */
    }
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  // Apply a single update to local reducer state.
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
      onTurnEnd: () => {
        setTurnStartedAt(null);
        setConnection((c) =>
          c.status === "prompting" ? { ...c, status: "ready" } : c,
        );
      },
      onConnectionState: (state) => setConnection(state),
      onPermissionRequest: (req) => setPermission(req),
      onSessionList: ({ sessions: list, activeSessionId: active }) => {
        setSessions(list);
        setActiveSessionId(active);
      },
      onSessionLoaded: ({ session: s, updates, mode, commands: cmds }) => {
        setActiveSessionId(s.id);
        setCommands(cmds);
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

  // Auto-scroll to bottom when timeline grows, unless user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [session.timeline]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = dist < 80;
  };

  const handlePrompt = async (text: string) => {
    // Require an explicit project folder before the first prompt.
    if (!activeSessionId) {
      await handleNewSession();
      return;
    }

    stickToBottom.current = true;
    setTurnStartedAt(Date.now());

    applyUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });
    const res = await getRpc().request.sendPrompt({
      text,
      sessionId: activeSessionId,
    });
    if (!res.ok) {
      setConnection({ status: "error", error: res.error });
    }
  };

  const handleCancel = async () => {
    await getRpc().request.cancel({
      sessionId: activeSessionId ?? undefined,
    });
  };

  const handleNewSession = async () => {
    await refreshRecentProjects();
    setShowNewSession(true);
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
    const res = await getRpc().request.createSession({
      cwd: opts.cwd,
      project: opts.project,
      title: opts.title,
      agentId: opts.agentId,
    });
    if (res.ok) {
      setSession(initialSession);
      setActiveSessionId(res.session.id);
      setCommands([]);
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
    const res = await getRpc().request.switchSession({ sessionId: id });
    if (!res.ok) setConnection({ status: "error", error: res.error });
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
  };

  const elapsed =
    turnStartedAt && connection.status === "prompting"
      ? formatElapsed(now - turnStartedAt)
      : null;

  const isPrompting = connection.status === "prompting";

  return (
    <div className="flex h-screen overflow-hidden w-full" data-theme={settings?.theme ?? "dark"}>
      {showSidebar && (
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={handleSwitchSession}
          onNew={handleNewSession}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}
      <main className="main-bg relative grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <div>
          <Header
            title={activeSession?.title ?? "New session"}
            project={activeSession?.project ?? "—"}
            cwd={activeSession?.cwd}
            branch={session.mode}
            connection={connection}
            onToggleSidebar={() => setShowSidebar((s) => !s)}
            onOpenSettings={() => setShowSettings(true)}
          />
          <ConnectionBanner connection={connection} />
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 overflow-y-auto p-6 md:p-8"
        >
          <div className="w-full space-y-8 pb-40">
            {(elapsed || session.timeline.length > 0) && (
              <div className="flex items-center space-x-1 text-xs text-gray-500">
                <span>
                  {isPrompting
                    ? `Working${elapsed ? ` · ${elapsed}` : "…"}`
                    : session.timeline.length > 0
                      ? "Ready"
                      : "Start a conversation"}
                </span>
              </div>
            )}
            <Timeline
              entries={session.timeline}
              onOpenFile={handleOpenFile}
            />
            {session.timeline.length === 0 && connection.status === "ready" && (
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
            )}
          </div>
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
          onSubmit={handlePrompt}
          onCancel={handleCancel}
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
            onCancel={() => setShowNewSession(false)}
            onCreate={handleCreateSession}
          />
        )}
      </main>
    </div>
  );
}
