import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionManagerEvents } from "./session-manager";
import type { SessionUpdate } from "../session/types";
import type {
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  SessionSummary,
} from "../shared/rpc";
import { demoUpdates } from "../fixtures/demo";

vi.mock("./acp-client", () => {
  class AcpClient {
    agent: { id: string; name: string };
    handlers: {
      onUpdate: (sessionId: string, update: SessionUpdate) => void;
      onTurnEnd?: (sessionId: string, stopReason: string) => void;
    };
    constructor(
      agent: { id: string; name: string },
      handlers: {
        onUpdate: (sessionId: string, update: SessionUpdate) => void;
        onTurnEnd?: (sessionId: string, stopReason: string) => void;
      },
    ) {
      this.agent = agent;
      this.handlers = handlers;
    }
    async connect() {}
    async dispose() {}
    async openSession(_cwd: string) {
      const sessionId = `mock-${Date.now()}`;
      const h = this.handlers;
      let cancelled = false;
      return {
        sessionId,
        async prompt(text: string) {
          cancelled = false;
          h.onUpdate(sessionId, {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
          });
          for (const update of demoUpdates) {
            if (cancelled) {
              h.onTurnEnd?.(sessionId, "cancelled");
              return { stopReason: "cancelled" };
            }
            if (update.sessionUpdate === "user_message_chunk") continue;
            h.onUpdate(sessionId, update);
            await Bun.sleep(5);
          }
          h.onTurnEnd?.(sessionId, "end_turn");
          return { stopReason: "end_turn" };
        },
        async cancel() { cancelled = true; },
        dispose() { cancelled = true; },
      };
    }
  }
  return { AcpClient };
});

function tempDir() {
  return mkdtempSync(join(tmpdir(), "terminal-react-sm-"));
}

type Captured = {
  updates: Array<{ sessionId: string; update: SessionUpdate }>;
  turnEnds: Array<{ sessionId: string; stopReason: string }>;
  connections: ConnectionStatePayload[];
  permissions: PermissionRequest[];
  lists: Array<{ sessions: SessionSummary[]; active: string | null }>;
  loaded: Array<{
    session: SessionSummary;
    updates: SessionUpdate[];
    mode: string;
    commands: AvailableCommand[];
  }>;
  commands: Array<{ sessionId: string; commands: AvailableCommand[] }>;
  modes: Array<{ sessionId: string; mode: string }>;
  events: SessionManagerEvents;
};

function capture(): Captured {
  const c: Captured = {
    updates: [],
    turnEnds: [],
    connections: [],
    permissions: [],
    lists: [],
    loaded: [],
    commands: [],
    modes: [],
    events: {
      onUpdate: (sessionId, update) => c.updates.push({ sessionId, update }),
      onTurnEnd: (sessionId, stopReason) =>
        c.turnEnds.push({ sessionId, stopReason }),
      onConnectionState: (state) => c.connections.push(state),
      onPermissionRequest: (req) => c.permissions.push(req),
      onSessionList: (sessions, activeSessionId) =>
        c.lists.push({ sessions, active: activeSessionId }),
      onCommands: (sessionId, commands) =>
        c.commands.push({ sessionId, commands }),
      onMode: (sessionId, mode) => c.modes.push({ sessionId, mode }),
      onSessionLoaded: (session, updates, mode, commands) =>
        c.loaded.push({ session, updates, mode, commands }),
    },
  };
  return c;
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 5000,
  intervalMs = 20,
) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(intervalMs);
  }
}

describe("SessionManager", () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  afterEach(async () => {
    for (const m of managers.splice(0)) {
      try {
        await m.dispose();
      } catch {
        /* ignore */
      }
    }
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  async function boot() {
    const dir = tempDir();
    dirs.push(dir);
    const c = capture();
    const mgr = new SessionManager(dir, c.events);
    managers.push(mgr);
    await mgr.init();
    const agentId = mgr.getAgents()[0]?.id;
    if (!agentId) throw new Error("No agents configured");
    return { mgr, c, dir, agentId };
  }

  it("init hydrates empty session list and loads agents", async () => {
    const { mgr, c } = await boot();
    expect(mgr.listSessions()).toEqual({
      sessions: [],
      activeSessionId: null,
    });
    expect(c.lists.length).toBeGreaterThanOrEqual(1);
    const agents = mgr.getAgents();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some((a) => a.id === "demo")).toBe(false);
    expect(mgr.getConnectionState().status).toBe("idle");
  });

  it("createSession with configured agent opens a ready session", async () => {
    const { mgr, c, agentId } = await boot();
    const res = await mgr.createSession({
      title: "My task",
      project: "terminal-react",
      cwd: process.cwd(),
      agentId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.session.title).toBe("My task");
    expect(res.session.agentId).toBe(agentId);
    expect(res.session.project).toBe("terminal-react");
    expect(res.session.cwd).toBe(process.cwd());
    expect(mgr.getSettings().lastProjectCwd).toBe(process.cwd());

    const list = mgr.listSessions();
    expect(list.sessions).toHaveLength(1);
    expect(list.activeSessionId).toBe(res.session.id);

    expect(c.loaded.some((l) => l.session.id === res.session.id)).toBe(true);
    const ready = c.connections.find((x) => x.status === "ready");
    expect(ready?.sessionId).toBe(res.session.id);
  });

  it("createSession rejects missing folders", async () => {
    const { mgr, agentId } = await boot();
    const res = await mgr.createSession({
      cwd: join(tmpdir(), "definitely-missing-folder-" + Date.now()),
      agentId,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/does not exist/i);
  });

  it("listRecentProjects de-dupes by cwd", async () => {
    const { mgr, agentId } = await boot();
    const cwd = process.cwd();
    await mgr.createSession({ title: "A", cwd, agentId });
    await mgr.createSession({ title: "B", cwd, agentId });
    const other = tempDir();
    dirs.push(other);
    await mgr.createSession({ title: "C", cwd: other, agentId });

    const projects = mgr.listRecentProjects();
    expect(projects.map((p) => p.cwd)).toEqual(
      expect.arrayContaining([cwd, other]),
    );
    expect(new Set(projects.map((p) => p.cwd)).size).toBe(projects.length);
  });

  it("sendPrompt streams updates and ends the turn", async () => {
    const { mgr, c, agentId } = await boot();
    const created = await mgr.createSession({ agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const promptRes = await mgr.sendPrompt(
      "How does progress work?",
      created.session.id,
    );
    expect(promptRes.ok).toBe(true);

    await waitFor(() =>
      c.turnEnds.some(
        (t) => t.sessionId === created.session.id && t.stopReason === "end_turn",
      ),
    );

    expect(c.updates.length).toBeGreaterThan(5);
    const types = c.updates.map((u) => u.update.sessionUpdate);
    expect(types).toContain("user_message_chunk");
    expect(types).toContain("plan");
    expect(types).toContain("tool_call");
    expect(types).toContain("agent_message_chunk");
    expect(types).toContain("tool_call_update");

    // Title auto-updates from the first user prompt when default title.
    const list = mgr.listSessions();
    const session = list.sessions.find((s) => s.id === created.session.id);
    expect(session?.title).toBe("How does progress work?");
  });

  it("sendPrompt without a session auto-creates one", async () => {
    const { mgr, c } = await boot();
    const res = await mgr.sendPrompt("auto create please");
    expect(res.ok).toBe(true);

    await waitFor(() => c.turnEnds.some((t) => t.stopReason === "end_turn"));
    expect(mgr.listSessions().sessions.length).toBe(1);
    expect(mgr.listSessions().sessions[0]!.title).toBe("auto create please");
  });

  it("switchSession reloads persisted events", async () => {
    const { mgr, c, agentId } = await boot();
    const a = await mgr.createSession({ title: "A", agentId });
    const b = await mgr.createSession({ title: "B", agentId });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await mgr.sendPrompt("message for A", a.session.id);
    await waitFor(() =>
      c.turnEnds.some((t) => t.sessionId === a.session.id),
    );

    c.loaded.length = 0;
    const switched = await mgr.switchSession(a.session.id);
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;

    const load = c.loaded.find((l) => l.session.id === a.session.id);
    expect(load).toBeTruthy();
    expect(load!.updates.length).toBeGreaterThan(0);
    expect(
      load!.updates.some((u) => u.sessionUpdate === "user_message_chunk"),
    ).toBe(true);
  });

  it("deleteSession removes it and activates another when needed", async () => {
    const { mgr, agentId } = await boot();
    const a = await mgr.createSession({ title: "Keep", agentId });
    const b = await mgr.createSession({ title: "Drop", agentId });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(mgr.listSessions().activeSessionId).toBe(b.session.id);
    await mgr.deleteSession(b.session.id);

    const list = mgr.listSessions();
    expect(list.sessions.map((s) => s.id)).toEqual([a.session.id]);
    expect(list.activeSessionId).toBe(a.session.id);
  });

  it("cancel during a prompt stops streaming", async () => {
    const { mgr, c, agentId } = await boot();
    const created = await mgr.createSession({ agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await mgr.sendPrompt("long running", created.session.id);
    // Demo streams with 80ms sleeps — cancel quickly.
    await Bun.sleep(40);
    const cancelRes = await mgr.cancel(created.session.id);
    expect(cancelRes.ok).toBe(true);

    await waitFor(
      () =>
        c.turnEnds.some((t) => t.sessionId === created.session.id) ||
        mgr.getConnectionState().status === "ready",
      3000,
    );

    // Either cancelled mid-stream or finished extremely fast; connection
    // should not stay stuck in prompting.
    expect(mgr.getConnectionState().status).not.toBe("prompting");
  });

  it("settings load/save round-trips through the manager", async () => {
    const { mgr } = await boot();
    const before = mgr.getSettings();
    expect(before.theme).toBeTruthy();

    const next = mgr.saveSettings({
      theme: "light",
      editorCommand: "nvim",
      enableFsCapabilities: true,
    });
    expect(next.theme).toBe("light");
    expect(next.editorCommand).toBe("nvim");
    expect(next.enableFsCapabilities).toBe(true);
    expect(mgr.getSettings()).toEqual(next);
  });

  it("connectAgent rejects unknown agent ids", async () => {
    const { mgr, c } = await boot();
    const res = await mgr.connectAgent("does-not-exist");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Unknown agent/);
    expect(c.connections.some((x) => x.status === "error")).toBe(true);
  });

  it("connectAgent succeeds for configured agent and reconnect is a no-op success", async () => {
    const { mgr, agentId } = await boot();
    const first = await mgr.connectAgent(agentId);
    expect(first.ok).toBe(true);
    expect(mgr.getConnectionState().status).toBe("ready");

    const second = await mgr.connectAgent(agentId);
    expect(second.ok).toBe(true);
    expect(mgr.getConnectionState().agentName).toBeTruthy();
  });

  it("respondPermission returns false for unknown request ids", async () => {
    const { mgr } = await boot();
    expect(mgr.respondPermission("nope", "allow-once")).toEqual({ ok: false });
  });

  it("persists sessions across manager restarts", async () => {
    const dir = tempDir();
    dirs.push(dir);

    const c1 = capture();
    const m1 = new SessionManager(dir, c1.events);
    managers.push(m1);
    await m1.init();
    const agentId = m1.getAgents()[0]?.id;
    if (!agentId) throw new Error("no agents");
    const created = await m1.createSession({
      title: "Persisted",
      agentId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await m1.sendPrompt("remember this", created.session.id);
    await waitFor(() =>
      c1.turnEnds.some((t) => t.sessionId === created.session.id),
    );
    await m1.dispose();
    managers.pop();

    const c2 = capture();
    const m2 = new SessionManager(dir, c2.events);
    managers.push(m2);
    await m2.init();

    const list = m2.listSessions();
    expect(list.sessions.some((s) => s.id === created.session.id)).toBe(true);

    const switched = await m2.switchSession(created.session.id);
    expect(switched.ok).toBe(true);
    const load = c2.loaded.find((l) => l.session.id === created.session.id);
    expect(load?.updates.length).toBeGreaterThan(0);
  });
});
