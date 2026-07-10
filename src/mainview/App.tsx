import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Timeline } from "./components/Timeline";
import { PromptInput } from "./components/PromptInput";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { SettingsPanel } from "./components/SettingsPanel";
import { RemoteAccessPanel } from "./components/RemoteAccessPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { ChatEmptyState } from "./components/ChatEmptyState";
import { SidebarResizeHandle } from "./components/SidebarResizeHandle";
import { useAppController } from "./hooks/useAppController";
import { useSidebarResize } from "./hooks/useSidebarResize";
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

  return (
    <div
      className="app-shell flex h-full min-h-0 w-full overflow-hidden"
      data-theme={app.settings?.theme ?? "dark"}
      data-remote={remoteClient ? "true" : undefined}
    >
      {app.showSidebar && (
        <>
          <Sidebar
            sessions={app.sessions}
            activeSessionId={app.activeSessionId}
            sessionActivity={app.sessionActivity}
            width={sidebarWidth}
            onSelect={app.handleSwitchSession}
            onNew={app.handleNewSession}
            onNewInProject={(project) => void app.handleNewInProject(project)}
            onDeleteSession={app.handleDeleteSession}
            onOffloadSession={(id) => void app.handleOffloadSession(id)}
            onOpenSettings={() => app.setShowSettings(true)}
            onOpenRemoteAccess={
              remoteClient ? undefined : () => void app.openRemoteAccess()
            }
            onWindowControl={
              remoteClient ? undefined : app.handleWindowControl
            }
          />
          <SidebarResizeHandle
            width={sidebarWidth}
            isResizing={isResizingSidebar}
            onResizeStart={handleSidebarResizeStart}
            onNudge={nudgeSidebarWidth}
          />
        </>
      )}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden py-[8px]">
        <div className="h-full w-full relative flex flex-col main-bg rounded-[8px]">
          <div className="shrink-0">
            <Header
              title={app.activeSession?.title ?? "New session"}
              project={app.activeSession?.project ?? "—"}
              cwd={app.activeSession?.cwd}
              branch={app.gitBranch}
              connection={app.connection}
              onToggleSidebar={() => app.setShowSidebar((s) => !s)}
              onOpenSettings={() => app.setShowSettings(true)}
              showWindowControls={!app.showSidebar}
              onWindowControl={app.handleWindowControl}
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
                  connection={app.connection}
                  activeSession={app.activeSession}
                  onNewSession={app.handleNewSession}
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
          <PromptInput
            disabled={
              app.connection.status === "connecting" ||
              app.connection.status === "idle"
            }
            prompting={app.isPrompting}
            commands={app.commands}
            mode={app.session.mode}
            configOptions={app.configOptions}
            usage={app.usage}
            queue={app.activePromptQueue}
            onSubmit={app.handlePrompt}
            onCancel={app.handleCancel}
            onRemoveQueued={app.handleRemoveQueued}
            onClearQueue={app.handleClearQueue}
            onSetConfigOption={app.handleSetConfigOption}
          />
          {app.showSettings && app.settings && (
            <SettingsPanel
              settings={app.settings}
              agents={app.agents}
              onClose={() => app.setShowSettings(false)}
              onSave={app.handleSaveSettings}
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
                app.settings?.lastProjectCwd ||
                app.activeSession?.cwd ||
                app.recentProjects[0]?.cwd ||
                ""
              }
              recentProjects={app.recentProjects}
              onPickFolder={app.handlePickFolder}
              onRemoveRecent={app.handleRemoveRecentProject}
              onCancel={() => app.setShowNewSession(false)}
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
      </main>
    </div>
  );
}
