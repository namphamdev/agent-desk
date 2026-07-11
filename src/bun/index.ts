import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun/bun";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TerminalRPC } from "../shared/rpc";
import {
  notifyTurnComplete,
  showDesktopNotification,
  showNotificationsEnabledToast,
} from "./notify";
import { ensureAugmentedPath } from "./path-env";
import { RemoteAccessServer } from "./remote-access";
import { SessionManager } from "./session-manager";
import {
  applyProjectHarness,
  getProjectHarness,
} from "./project-harness";
import {
  appSkillsPaths,
  installSkill,
  listSkills,
  setSkillEnabled,
  uninstallSkill,
} from "./skills";
import {
  addCommand,
  getCommandRunner,
  loadCommands,
  removeCommand,
} from "./user-commands";
import { ensureAgentSetup, getAgentSetupStatus } from "./agents";

// GUI launches (canary/stable .app) get a minimal PATH without Homebrew/npm.
// Fix before any agent/editor/git spawn.
ensureAugmentedPath();

/**
 * Install a standard macOS application menu with Edit roles.
 *
 * WKWebView does not handle ⌘C / ⌘V / ⌘X / ⌘A on its own when the host app
 * has no Edit menu. Native NSMenu items with roles (paste, copy, …) wire those
 * shortcuts into the first-responder chain so text fields work.
 */
function installApplicationMenu() {
  ApplicationMenu.setApplicationMenu([
    {
      label: "Terminal React",
      submenu: [
        { role: "about", label: "About Terminal React" },
        { type: "separator" },
        { role: "hide", label: "Hide Terminal React", accelerator: "CmdOrCtrl+H" },
        { role: "hideOthers", label: "Hide Others" },
        { role: "showAll", label: "Show All" },
        { type: "separator" },
        { role: "quit", label: "Quit Terminal React", accelerator: "CmdOrCtrl+Q" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo", accelerator: "CmdOrCtrl+Z" },
        { role: "redo", accelerator: "Shift+CmdOrCtrl+Z" },
        { type: "separator" },
        { role: "cut", accelerator: "CmdOrCtrl+X" },
        { role: "copy", accelerator: "CmdOrCtrl+C" },
        { role: "paste", accelerator: "CmdOrCtrl+V" },
        { role: "pasteAndMatchStyle", accelerator: "Shift+CmdOrCtrl+V" },
        { role: "delete" },
        { role: "selectAll", accelerator: "CmdOrCtrl+A" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "toggleFullScreen", accelerator: "Ctrl+CmdOrCtrl+F" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize", accelerator: "CmdOrCtrl+M" },
        { role: "zoom" },
        { type: "separator" },
        { role: "bringAllToFront" },
      ],
    },
  ]);
}

async function pickFolderDialog(startingFolder?: string): Promise<
  | { ok: true; path: string }
  | { ok: false; cancelled?: boolean; error?: string }
> {
  try {
    const start =
      startingFolder?.trim() ||
      manager?.getSettings()?.lastProjectCwd ||
      process.cwd() ||
      homedir();
    const paths = await Utils.openFileDialog({
      startingFolder: start,
      canChooseFiles: false,
      canChooseDirectory: true,
      allowsMultipleSelection: false,
      allowedFileTypes: "*",
    });
    // Electrobun joins selections with "," and may yield [""] on cancel/null.
    const list = Array.isArray(paths) ? paths : paths != null ? [String(paths)] : [];
    const path = list
      .map((p) => String(p ?? "").trim())
      .find((p) => p.length > 0);
    if (!path) return { ok: false, cancelled: true };
    return { ok: true, path };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Native cancel can surface as a null cstring .toString() throw.
    if (/null|cancelled|canceled/i.test(message)) {
      return { ok: false, cancelled: true };
    }
    return { ok: false, error: message };
  }
}

const DEV_SERVER_URL = "http://localhost:5173";

async function resolveMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`[terminal-react] HMR: ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log("[terminal-react] using bundled webview (no Vite dev server)");
    }
  }
  return "views://mainview/index.html";
}

const dataDir =
  process.env.TERMINAL_REACT_DATA ?? join(homedir(), ".terminal-react");

// Forward-declared so RPC handlers can call into it after construction.
let manager: SessionManager;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mainWindow: BrowserWindow<any>;
let remoteAccess: RemoteAccessServer;

function rpc() {
  return mainWindow?.webview?.rpc as
    | ReturnType<typeof BrowserView.defineRPC<TerminalRPC>>
    | undefined;
}

const terminalRPC = BrowserView.defineRPC<TerminalRPC>({
  // Folder picker and agent connect can take longer than the default 1s.
  maxRequestTime: 600_000,
  handlers: {
    requests: {
      sendPrompt: async ({ text, sessionId }) => {
        return manager.sendPrompt(text, sessionId);
      },
      cancel: async (params) => {
        return manager.cancel(params?.sessionId);
      },
      listAgents: async () => {
        return { agents: manager.getAgents() };
      },
      listSessions: async () => {
        return manager.listSessions();
      },
      createSession: async (params) => {
        return manager.createSession(params ?? {});
      },
      switchSession: async ({ sessionId }) => {
        return manager.switchSession(sessionId);
      },
      deleteSession: async ({ sessionId }) => {
        return manager.deleteSession(sessionId);
      },
      offloadSession: async ({ sessionId }) => {
        return manager.offloadSession(sessionId);
      },
      respondPermission: async ({ requestId, optionId }) => {
        return manager.respondPermission(requestId, optionId);
      },
      openFile: async ({ path, line }) => {
        return manager.openFile(path, line);
      },
      getSettings: async () => {
        return manager.getSettings();
      },
      saveSettings: async (patch) => {
        const before = manager.getSettings();
        const next = manager.saveSettings(patch);
        // First enable → sample banner (macOS prompts for notification permission here).
        if (next.enableNotifications && !before.enableNotifications) {
          showNotificationsEnabledToast();
        }
        return next;
      },
      showDesktopNotification: async (params) => {
        const ok = showDesktopNotification({
          title: params.title,
          body: params.body,
          subtitle: params.subtitle,
          silent: params.silent,
        });
        return ok
          ? { ok: true as const }
          : { ok: false as const, error: "Failed to show notification" };
      },
      getConnectionState: async () => {
        return manager.getConnectionState();
      },
      connectAgent: async (params) => {
        return manager.connectAgent(params?.agentId, params?.cwd);
      },
      pickFolder: async (params) => {
        return pickFolderDialog(params?.startingFolder);
      },
      listRecentProjects: async () => {
        return { projects: manager.listRecentProjects() };
      },
      removeRecentProject: async ({ cwd }) => {
        const projects = manager.removeRecentProject(cwd);
        return { ok: true as const, projects };
      },
      writeClipboard: async ({ text }) => {
        try {
          const value = text ?? "";
          Utils.clipboardWriteText(value);
          // Verify the write landed (some sandboxed builds no-op).
          const readBack = Utils.clipboardReadText();
          if (readBack !== value) {
            console.warn(
              "[clipboard] write/read mismatch",
              { wrote: value.length, read: readBack?.length ?? null },
            );
          } else {
            console.info("[clipboard] bun wrote", value.length, "chars");
          }
          return { ok: true as const };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[clipboard] bun write error:", message);
          return { ok: false as const, error: message };
        }
      },
      readClipboard: async () => {
        try {
          const text = Utils.clipboardReadText() ?? "";
          return { ok: true as const, text };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[clipboard] bun read error:", message);
          return { ok: false as const, error: message };
        }
      },
      getGitBranch: async ({ cwd }) => {
        return manager.getGitBranch(cwd);
      },
      setConfigOption: async ({ sessionId, configId, value }) => {
        return manager.setConfigOption(configId, value, sessionId);
      },
      windowControl: async ({ action }) => {
        if (!mainWindow) return { ok: false as const, error: "no window" };
        try {
          switch (action) {
            case "close":
              mainWindow.close();
              break;
            case "minimize":
              mainWindow.minimize();
              break;
            case "maximize":
              if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
              } else {
                mainWindow.maximize();
              }
              break;
            default:
              return { ok: false as const, error: `unknown action: ${action}` };
          }
          return { ok: true as const };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false as const, error: message };
        }
      },
      getRemoteAccess: async () => {
        return remoteAccess.getStatus();
      },
      startRemoteAccess: async () => {
        return remoteAccess.start();
      },
      stopRemoteAccess: async () => {
        return remoteAccess.stop();
      },
      regenerateRemoteAccess: async () => {
        return remoteAccess.regenerate();
      },
      getAgentSetup: async () => {
        return getAgentSetupStatus();
      },
      ensureAgentSetup: async () => {
        return ensureAgentSetup();
      },
      listSkills: async (params) => {
        const listed = manager.listSessions();
        const projectCwd =
          params?.projectCwd ??
          listed.sessions.find((s) => s.id === listed.activeSessionId)?.cwd ??
          null;
        return {
          skills: listSkills(appSkillsPaths(dataDir, projectCwd)),
        };
      },
      installSkill: async ({ package: pkg }) => {
        return installSkill(appSkillsPaths(dataDir), pkg);
      },
      setSkillEnabled: async ({ skillId, enabled }) => {
        const paths = appSkillsPaths(dataDir);
        const res = setSkillEnabled(paths, skillId, enabled);
        if (!res.ok) return res;
        return {
          ok: true as const,
          skill: res.skill,
          skills: listSkills(paths),
        };
      },
      uninstallSkill: async ({ skillId }) => {
        return uninstallSkill(appSkillsPaths(dataDir), skillId);
      },
      getProjectHarness: async ({ cwd, project }) => {
        return getProjectHarness(cwd, project);
      },
      applyProjectHarness: async ({ cwd, optimizationId, project }) => {
        return applyProjectHarness(cwd, optimizationId, project);
      },
      listUserCommands: async ({ projectCwd }) => {
        if (!projectCwd?.trim()) {
          return { commands: [] };
        }
        return { commands: loadCommands(dataDir, projectCwd) };
      },
      addUserCommand: async ({ projectCwd, name, command }) => {
        return addCommand(dataDir, { projectCwd, name, command });
      },
      removeUserCommand: async ({ projectCwd, commandId }) => {
        return removeCommand(dataDir, projectCwd, commandId);
      },
      runUserCommand: async ({ projectCwd, commandId }) => {
        if (!projectCwd?.trim()) {
          return { ok: false as const, error: "Project folder is required" };
        }
        const commands = loadCommands(dataDir, projectCwd);
        const saved = commands.find((c) => c.id === commandId);
        if (!saved) return { ok: false as const, error: "Command not found" };
        return getCommandRunner(dataDir).start(saved);
      },
      stopUserCommandRun: async ({ runId }) => {
        return getCommandRunner(dataDir).stop(runId);
      },
      listUserCommandRuns: async ({ projectCwd }) => {
        return {
          runs: getCommandRunner(dataDir).listRuns(projectCwd),
        };
      },
      getUserCommandRunLog: async ({ runId }) => {
        return getCommandRunner(dataDir).getLog(runId);
      },
    },
    messages: {},
  },
});

manager = new SessionManager(dataDir, {
  onUpdate: (sessionId, update) => {
    try {
      rpc()?.send.onUpdate({ sessionId, update });
    } catch (err) {
      console.warn("[rpc] onUpdate failed:", err);
    }
    remoteAccess?.onUpdate(sessionId, update);
  },
  onTurnEnd: (sessionId, stopReason) => {
    try {
      rpc()?.send.onTurnEnd({ sessionId, stopReason });
    } catch (err) {
      console.warn("[rpc] onTurnEnd failed:", err);
    }
    remoteAccess?.onTurnEnd({ sessionId, stopReason });
    // Native notification from Bun — Web Notification API is unreliable in WKWebView.
    try {
      const settings = manager.getSettings();
      if (!settings.enableNotifications) return;
      const sessions = manager.listSessions().sessions;
      const session = sessions.find((s) => s.id === sessionId);
      notifyTurnComplete({
        title: session?.title ? `Done: ${session.title}` : "Task complete",
        body: session?.project
          ? `${session.project} · agent finished responding`
          : "The agent finished responding.",
        // OS sound when the user wants sound; webview also plays a chime when
        // notifications are off (see mainview completionAlert).
        withSound: settings.enableSound,
      });
    } catch (err) {
      console.warn("[notify] turn-end notification failed:", err);
    }
  },
  onConnectionState: (state) => {
    try {
      rpc()?.send.onConnectionState(state);
    } catch (err) {
      console.warn("[rpc] onConnectionState failed:", err);
    }
    remoteAccess?.onConnectionState(state);
  },
  onPermissionRequest: (req) => {
    try {
      rpc()?.send.onPermissionRequest(req);
    } catch (err) {
      console.warn("[rpc] onPermissionRequest failed:", err);
    }
    remoteAccess?.onPermissionRequest(req);
  },
  onSessionList: (sessions, activeSessionId) => {
    try {
      rpc()?.send.onSessionList({ sessions, activeSessionId });
    } catch (err) {
      console.warn("[rpc] onSessionList failed:", err);
    }
    remoteAccess?.onSessionList({ sessions, activeSessionId });
  },
  onCommands: (sessionId, commands) => {
    try {
      rpc()?.send.onCommands({ sessionId, commands });
    } catch (err) {
      console.warn("[rpc] onCommands failed:", err);
    }
    remoteAccess?.onCommands(sessionId, commands);
  },
  onMode: (sessionId, mode) => {
    try {
      rpc()?.send.onMode({ sessionId, mode });
    } catch (err) {
      console.warn("[rpc] onMode failed:", err);
    }
    remoteAccess?.onMode(sessionId, mode);
  },
  onConfigOptions: (sessionId, configOptions) => {
    try {
      rpc()?.send.onConfigOptions({ sessionId, configOptions });
    } catch (err) {
      console.warn("[rpc] onConfigOptions failed:", err);
    }
    remoteAccess?.onConfigOptions(sessionId, configOptions);
  },
  onUsage: (sessionId, usage) => {
    try {
      rpc()?.send.onUsage({ sessionId, usage });
    } catch (err) {
      console.warn("[rpc] onUsage failed:", err);
    }
    remoteAccess?.onUsage(sessionId, usage);
  },
  onSessionLoaded: (session, updates, mode, commands, configOptions, usage) => {
    const payload = {
      session,
      updates,
      mode,
      commands,
      configOptions,
      usage: usage ?? null,
    };
    try {
      rpc()?.send.onSessionLoaded(payload);
    } catch (err) {
      console.warn("[rpc] onSessionLoaded failed:", err);
    }
    remoteAccess?.onSessionLoaded(payload);
  },
});

remoteAccess = new RemoteAccessServer({
  sendPrompt: (text, sessionId) => manager.sendPrompt(text, sessionId),
  cancel: (sessionId) => manager.cancel(sessionId),
  listAgents: () => ({ agents: manager.getAgents() }),
  listSessions: () => manager.listSessions(),
  createSession: (params) => manager.createSession(params),
  switchSession: (sessionId) => manager.switchSession(sessionId),
  deleteSession: (sessionId) => manager.deleteSession(sessionId),
  offloadSession: (sessionId) => manager.offloadSession(sessionId),
  respondPermission: async (requestId, optionId) =>
    manager.respondPermission(requestId, optionId),
  openFile: (path, line) => manager.openFile(path, line),
  getSettings: () => manager.getSettings(),
  saveSettings: (patch) => manager.saveSettings(patch),
  getConnectionState: () => manager.getConnectionState(),
  connectAgent: (agentId, cwd) => manager.connectAgent(agentId, cwd),
  listRecentProjects: () => ({ projects: manager.listRecentProjects() }),
  removeRecentProject: (cwd) => {
    const projects = manager.removeRecentProject(cwd);
    return { ok: true as const, projects };
  },
  getGitBranch: (cwd) => manager.getGitBranch(cwd),
  setConfigOption: (configId, value, sessionId) =>
    manager.setConfigOption(configId, value, sessionId),
  writeClipboard: async (text) => {
    try {
      Utils.clipboardWriteText(text ?? "");
      return { ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
  readClipboard: async () => {
    try {
      const text = Utils.clipboardReadText() ?? "";
      return { ok: true as const, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
  listSkills: (projectCwd) => ({
    skills: listSkills(appSkillsPaths(dataDir, projectCwd)),
  }),
  installSkill: (packageSpec) => installSkill(appSkillsPaths(dataDir), packageSpec),
  setSkillEnabled: (skillId, enabled) => {
    const paths = appSkillsPaths(dataDir);
    const res = setSkillEnabled(paths, skillId, enabled);
    if (!res.ok) return res;
    return {
      ok: true as const,
      skill: res.skill,
      skills: listSkills(paths),
    };
  },
  uninstallSkill: (skillId) => uninstallSkill(appSkillsPaths(dataDir), skillId),
  getProjectHarness: (cwd, project) => getProjectHarness(cwd, project),
  applyProjectHarness: (cwd, optimizationId, project) =>
    applyProjectHarness(cwd, optimizationId, project),
  getAgentSetup: () => getAgentSetupStatus(),
  ensureAgentSetup: () => ensureAgentSetup(),
});

await manager.init();

// Must run before (or as soon as) the window opens so ⌘V / ⌘C hit Edit roles.
installApplicationMenu();

const url = await resolveMainViewUrl();

mainWindow = new BrowserWindow({
  title: "Terminal React",
  url,
  rpc: terminalRPC,
  // Custom chrome: hide system titlebar; Sidebar traffic lights control the window.
  // Transparent so CSS can round the window corners (16px shell).
  titleBarStyle: "hidden",
  transparent: true,
  frame: {
    width: 1280,
    height: 840,
    x: 160,
    y: 120,
  },
});

console.log("[terminal-react] started");
console.log(`[terminal-react] data dir: ${dataDir}`);
console.log(`[terminal-react] userData: ${Utils.paths.userData}`);

// Auto-connect the default (demo) agent so the UI is ready immediately.
void manager.connectAgent().then((r) => {
  if (!r.ok) console.warn("[terminal-react] initial connect:", r.error);
});
