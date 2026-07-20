import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Timeline } from "./components/Timeline";
import { PromptInput } from "./components/PromptInput";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { UserQuestionPrompt } from "./components/UserQuestionPrompt";
import { SettingsPanel } from "./components/SettingsPanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { CommandPanel } from "./components/CommandPanel";
import { ProjectHarnessModal } from "./components/ProjectHarnessModal";
import { RemoteAccessPanel } from "./components/RemoteAccessPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { ChatEmptyState } from "./components/ChatEmptyState";
import { BrowserPanel } from "./components/BrowserPanel";
import { SidebarResizeHandle } from "./components/SidebarResizeHandle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { setBrowserOpenHandler } from "./browser/open-bridge";
import { useAppController } from "./hooks/useAppController";
import { useBrowserPanelResize } from "./hooks/useBrowserPanelResize";
import { useSessionBrowserState } from "./hooks/useSessionBrowserState";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { applyDocumentTheme, resolveThemeMode } from "./lib/theme";
import { isRemoteAccessClient } from "./rpc";

export default function App() {
  const app = useAppController();
  const remoteClient = isRemoteAccessClient();
  const {
    sidebarWidth,
    isResizingSidebar,
    handleSidebarResizeStart,
    nudgeSidebarWidth,
  } = useSidebarResize();
  const {
    browserWidth,
    isResizingBrowser,
    handleBrowserResizeStart,
    nudgeBrowserWidth,
  } = useBrowserPanelResize();
  const browser = useSessionBrowserState(app.activeSessionId);

  // DocumentElement owns theme (shadcn `.dark` + data-theme). Keep in sync when settings load.
  useEffect(() => {
    applyDocumentTheme(app.settings?.theme ?? "system");
  }, [app.settings?.theme]);

  // Drop browser state for deleted chats.
  useEffect(() => {
    browser.pruneSessions(new Set(app.sessions.map((s) => s.id)));
  }, [app.sessions, browser.pruneSessions]);

  // Agent MCP → open the built-in panel for that chat (and optional URL).
  // If the agent targets a non-focused chat, switch to it so the user sees
  // the panel and handlers register under the correct session id.
  useEffect(() => {
    setBrowserOpenHandler((sessionId, url) => {
      browser.openForSession(sessionId, url);
      if (sessionId !== app.activeSessionId) {
        void app.handleSwitchSession(sessionId);
      }
    });
    return () => setBrowserOpenHandler(null);
  }, [browser.openForSession, app.activeSessionId, app.handleSwitchSession]);

  const showBrowser = Boolean(browser.sessionId && browser.open);

  const browserSuppressed =
    app.showSettings ||
    app.showSkills ||
    app.showCommands ||
    app.showHarness ||
    app.showRemoteAccess ||
    app.showNewSession ||
    Boolean(app.pendingDelete);

  const toastTheme = resolveThemeMode(app.settings?.theme ?? "system");

  return (
    <TooltipProvider>
    <div
      className="app-shell flex h-full min-h-0 w-full overflow-hidden"
      data-remote={remoteClient ? "true" : undefined}
    >
      {app.showSidebar && (
        <>
          {/* On remote/phone: drawer overlay so chat keeps full width */}
          {remoteClient && (
            <button
              type="button"
              aria-label="Close sidebar"
              className="fixed inset-0 z-30 bg-black/50"
              onClick={() => app.setShowSidebar(false)}
            />
          )}
          <div
            className={
              remoteClient
                ? "sidebar-bg fixed inset-y-0 left-0 z-40 flex max-w-[85vw] shadow-2xl"
                : "contents"
            }
          >
            <Sidebar
              sessions={app.sessions}
              activeSessionId={app.activeSessionId}
              sessionActivity={app.sessionActivity}
              width={remoteClient ? Math.min(sidebarWidth, 300) : sidebarWidth}
              onSelect={(id) => {
                app.handleSwitchSession(id);
                if (remoteClient) app.setShowSidebar(false);
              }}
              onNew={() => {
                void app.handleNewSession();
              }}
              onNewInProject={(project) => void app.handleNewInProject(project)}
              onOpenHarness={(project) => void app.openHarness(project)}
              onDeleteSession={app.handleDeleteSession}
              onOffloadSession={(id) => void app.handleOffloadSession(id)}
              onOpenSettings={() => app.setShowSettings(true)}
              onOpenSkills={() => void app.openSkills()}
              onOpenCommands={() => void app.openUserCommands()}
              onOpenRemoteAccess={
                remoteClient ? undefined : () => void app.openRemoteAccess()
              }
              onWindowControl={
                remoteClient ? undefined : app.handleWindowControl
              }
            />
          </div>
          {!remoteClient && (
            <SidebarResizeHandle
              width={sidebarWidth}
              isResizing={isResizingSidebar}
              onResizeStart={handleSidebarResizeStart}
              onNudge={nudgeSidebarWidth}
            />
          )}
        </>
      )}
      <main
        className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${
          remoteClient ? "py-0" : "py-[8px]"
        }`}
      >
        <div
          className={`relative flex h-full min-w-0 flex-1 flex-col main-bg border-t border-l border-gray-300 ${
            remoteClient ? "rounded-none" : "rounded-tl-[8px]"
          } ${showBrowser && !remoteClient ? "rounded-r-none" : ""}`}
        >
          <div className="shrink-0">
            <Header
              title={app.activeSession?.title ?? "New session"}
              project={app.activeSession?.project ?? "—"}
              cwd={app.activeSession?.cwd}
              branch={app.gitBranch}
              connection={app.connection}
              onToggleSidebar={() => app.setShowSidebar((s) => !s)}
              onOpenSettings={() => app.setShowSettings(true)}
              onToggleBrowser={() => {
                // Always show the control; without an active chat, open New task.
                if (!app.activeSessionId) {
                  void app.handleNewSession();
                  return;
                }
                browser.toggle();
              }}
              browserOpen={showBrowser}
              browserEnabled={Boolean(app.activeSessionId)}
              canReview={app.canReviewSession}
              reviewBusy={app.reviewBusy}
              onReviewInNewSession={() => void app.handleReviewInNewSession()}
              showWindowControls={!remoteClient && !app.showSidebar}
              onWindowControl={
                remoteClient ? undefined : app.handleWindowControl
              }
              compact={remoteClient}
            />
            <ConnectionBanner connection={app.connection} />
          </div>
          {/*
            Legend List rows are absolutely positioned, so this region must have a
            real height (flex-1 + relative). Timeline fills via absolute inset-0.
          */}
          <div className="relative min-h-0 min-w-0 flex-1">
            <Timeline
              sessionKey={app.activeSessionId}
              entries={app.session.timeline}
              onOpenFile={app.handleOpenFile}
              messageActions={app.messageActions}
              header={
                app.elapsed || app.session.timeline.length > 0 ? (
                  <span>
                    {app.isPrompting
                      ? `Working${app.elapsed ? ` · ${app.elapsed}` : "…"}`
                      : app.session.timeline.length > 0
                        ? "Ready"
                        : "Start a conversation"}
                  </span>
                ) : null
              }
              empty={
                <ChatEmptyState
                  sessionLoading={app.sessionLoading}
                  hasActiveSession={Boolean(app.activeSessionId)}
                  recentProjects={app.recentProjects}
                  onNewSession={app.handleNewSession}
                  onOpenProject={(cwd) => void app.handleOpenProjectCwd(cwd)}
                />
              }
            />
          </div>
          {app.permission && (
            <PermissionPrompt
              request={app.permission}
              onRespond={app.handlePermission}
            />
          )}
          {app.userQuestion && (
            <UserQuestionPrompt
              request={app.userQuestion}
              onRespond={app.handleUserQuestion}
            />
          )}
          <PromptInput
            disabled={
              // Allow typing on the default empty screen; send opens New task
              // when there is no session. Block only while an agent connects.
              app.connection.status === "connecting"
            }
            prompting={app.isPrompting}
            commands={app.commands}
            mode={app.session.mode}
            configOptions={app.configOptions}
            usage={app.usage}
            queue={app.activePromptQueue}
            providers={app.settings?.providers ?? []}
            activeProviderId={app.settings?.activeProviderId ?? null}
            activeModelAlias={app.settings?.activeModelAlias ?? "sonnet"}
            onSubmit={app.handlePrompt}
            onCancel={app.handleCancel}
            onRemoveQueued={app.handleRemoveQueued}
            onClearQueue={app.handleClearQueue}
            onSetConfigOption={app.handleSetConfigOption}
            onProviderModelChange={app.handleProviderModelChange}
          />
          {app.showSettings && app.settings && (
            <SettingsPanel
              settings={app.settings}
              agents={app.agents}
              onClose={() => app.setShowSettings(false)}
              onSave={app.handleSaveSettings}
              showRemoteControl={!remoteClient}
              remoteAccess={app.remoteAccess}
              remoteAccessLoading={app.remoteAccessLoading}
              remoteAccessError={app.remoteAccessError}
              onRemoteStart={() => void app.startRemoteAccess()}
              onRemoteStop={() => void app.stopRemoteAccess()}
              onRemoteRegenerate={() => void app.regenerateRemoteAccess()}
              onRemoteRefresh={() => void app.refreshRemoteAccess()}
              projectCwd={
                app.activeSession?.cwd ||
                app.settings?.lastProjectCwd ||
                null
              }
              projectName={app.activeSession?.project ?? null}
            />
          )}
          {app.showSkills && (
            <SkillsPanel
              skills={app.skills}
              loading={app.skillsLoading}
              error={app.skillsError}
              busyId={app.skillsBusyId}
              onClose={() => app.setShowSkills(false)}
              onRefresh={app.refreshSkills}
              onInstall={app.handleInstallSkill}
              onToggle={app.handleToggleSkill}
              onUninstall={app.handleUninstallSkill}
            />
          )}
          {app.showCommands && (
            <CommandPanel
              commands={app.userCommands}
              runs={app.commandRuns}
              loading={app.commandsLoading}
              error={app.commandsError}
              busyId={app.commandsBusyId}
              projectCwd={app.commandsProjectCwd}
              projectName={app.activeSession?.project}
              onClose={() => app.setShowCommands(false)}
              onRefresh={app.refreshUserCommands}
              onAdd={app.handleAddUserCommand}
              onRemove={app.handleRemoveUserCommand}
              onRun={app.handleRunUserCommand}
              onStop={app.handleStopUserCommandRun}
              onLoadLog={app.handleLoadUserCommandLog}
            />
          )}
          {app.showHarness && (
            <ProjectHarnessModal
              harness={app.harness}
              loading={app.harnessLoading}
              error={app.harnessError}
              busyId={app.harnessBusyId}
              onClose={() => app.setShowHarness(false)}
              onRefresh={() => void app.refreshHarness()}
              onApply={app.handleApplyHarness}
            />
          )}
          {app.showRemoteAccess && (
            <RemoteAccessPanel
              status={app.remoteAccess}
              loading={app.remoteAccessLoading}
              error={app.remoteAccessError}
              onClose={() => app.setShowRemoteAccess(false)}
              onStart={() => void app.startRemoteAccess()}
              onStop={() => void app.stopRemoteAccess()}
              onRegenerate={() => void app.regenerateRemoteAccess()}
            />
          )}
          {app.showNewSession && (
            <NewSessionDialog
              agents={app.agents}
              defaultAgentId={
                app.settings?.defaultAgentId ?? app.agents[0]?.id ?? null
              }
              defaultCwd={
                app.newSessionDefaultCwd ||
                app.settings?.lastProjectCwd ||
                app.activeSession?.cwd ||
                app.recentProjects[0]?.cwd ||
                ""
              }
              lockProject={Boolean(app.newSessionDefaultCwd)}
              recentProjects={app.recentProjects}
              workflows={app.resolvedWorkflows}
              onProjectCwdChange={(cwd) => {
                void app.loadResolvedWorkflows(cwd);
              }}
              onPickFolder={app.handlePickFolder}
              onRemoveRecent={app.handleRemoveRecentProject}
              onCancel={app.handleCancelNewSession}
              onCreate={app.handleCreateSession}
            />
          )}
          {app.pendingDelete && (
            <ConfirmDialog
              title="Delete session?"
              message={`"${app.pendingDelete.title || "Untitled session"}" will be permanently deleted. This cannot be undone.`}
              confirmLabel="Delete"
              cancelLabel="Cancel"
              destructive
              onConfirm={() => void app.confirmDeleteSession()}
              onCancel={() => app.setPendingDelete(null)}
            />
          )}
        </div>
        {showBrowser && browser.sessionId && (
          <div
            className={`flex h-full min-h-0 shrink-0 ${
              remoteClient ? "" : "pr-[8px]"
            }`}
          >
            <div
              className={`flex h-full min-h-0 overflow-hidden main-bg ${
                remoteClient ? "rounded-none" : "rounded-r-[8px]"
              }`}
            >
              <BrowserPanel
                key={browser.sessionId}
                sessionId={browser.sessionId}
                url={browser.url}
                onUrlChange={browser.setUrl}
                width={
                  remoteClient
                    ? Math.min(browserWidth, 360)
                    : browserWidth
                }
                isResizing={isResizingBrowser}
                onResizeStart={handleBrowserResizeStart}
                onNudge={nudgeBrowserWidth}
                onClose={() => browser.setOpen(false)}
                suppressNative={browserSuppressed}
              />
            </div>
          </div>
        )}
      </main>
    </div>
    <Toaster theme={toastTheme} />
    </TooltipProvider>
  );
}
