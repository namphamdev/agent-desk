import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TerminalRPC } from "../shared/rpc";
import { SessionManager } from "./session-manager";

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
        return manager.saveSettings(patch);
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
  },
  onTurnEnd: (sessionId, stopReason) => {
    try {
      rpc()?.send.onTurnEnd({ sessionId, stopReason });
    } catch (err) {
      console.warn("[rpc] onTurnEnd failed:", err);
    }
  },
  onConnectionState: (state) => {
    try {
      rpc()?.send.onConnectionState(state);
    } catch (err) {
      console.warn("[rpc] onConnectionState failed:", err);
    }
  },
  onPermissionRequest: (req) => {
    try {
      rpc()?.send.onPermissionRequest(req);
    } catch (err) {
      console.warn("[rpc] onPermissionRequest failed:", err);
    }
  },
  onSessionList: (sessions, activeSessionId) => {
    try {
      rpc()?.send.onSessionList({ sessions, activeSessionId });
    } catch (err) {
      console.warn("[rpc] onSessionList failed:", err);
    }
  },
  onCommands: (sessionId, commands) => {
    try {
      rpc()?.send.onCommands({ sessionId, commands });
    } catch (err) {
      console.warn("[rpc] onCommands failed:", err);
    }
  },
  onMode: (sessionId, mode) => {
    try {
      rpc()?.send.onMode({ sessionId, mode });
    } catch (err) {
      console.warn("[rpc] onMode failed:", err);
    }
  },
  onSessionLoaded: (session, updates, mode, commands) => {
    try {
      rpc()?.send.onSessionLoaded({ session, updates, mode, commands });
    } catch (err) {
      console.warn("[rpc] onSessionLoaded failed:", err);
    }
  },
});

await manager.init();

const url = await resolveMainViewUrl();

mainWindow = new BrowserWindow({
  title: "Terminal React",
  url,
  rpc: terminalRPC,
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
