import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  resolveSelectOptionValue,
  type SessionManagerEvents,
} from "./session-manager";
import type { SessionUpdate } from "../session/types";
import type {
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  SessionConfigOption,
  SessionSummary,
  SessionUsage,
  UserQuestionRequest,
} from "../shared/rpc";
import { demoUpdates } from "../fixtures/demo";

describe("resolveSelectOptionValue", () => {
  const options: SessionConfigOption[] = [
    {
      id: "thought_level",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
        { value: "low", name: "Low" },
      ],
    },
  ];

  it("resolves by value and by display name (case-insensitive)", () => {
    expect(
      resolveSelectOptionValue(options, "thought_level", "thought_level", "low"),
    ).toEqual({ configId: "thought_level", value: "low" });
    expect(
      resolveSelectOptionValue(
        options,
        "thought_level",
        "thought_level",
        "Medium",
      ),
    ).toEqual({ configId: "thought_level", value: "medium" });
  });

  it("returns null when already current or unknown", () => {
    expect(
      resolveSelectOptionValue(
        options,
        "thought_level",
        "thought_level",
        "high",
      ),
    ).toBeNull();
    expect(
      resolveSelectOptionValue(
        options,
        "thought_level",
        "thought_level",
        "High",
      ),
    ).toBeNull();
    expect(
      resolveSelectOptionValue(
        options,
        "thought_level",
        "thought_level",
        "max",
      ),
    ).toBeNull();
  });
});

const mockConfigOptions: SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "model-a",
    options: [
      { value: "model-a", name: "Model A" },
      { value: "model-b", name: "Model B" },
    ],
  },
  {
    id: "thought_level",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "high", name: "High" },
      { value: "medium", name: "Medium" },
      { value: "low", name: "Low" },
    ],
  },
  {
    id: "mode",
    name: "Permission",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "acceptEdits", name: "Accept Edits" },
      { value: "plan", name: "Plan" },
      { value: "bypassPermissions", name: "Bypass Permissions" },
    ],
  },
];

/** Tracks mock AcpClient instances for offload / dispose assertions. */
const mockAcpClients: Array<{ disposed: boolean }> = (
  (globalThis as { __mockAcpClients?: Array<{ disposed: boolean }> })
    .__mockAcpClients ??= []
);

vi.mock("./acp-client", () => {
  let mockSessionSeq = 0;
  const clients = (
    (globalThis as { __mockAcpClients?: Array<{ disposed: boolean }> })
      .__mockAcpClients ??= []
  );
  class AcpClient {
    agent: { id: string; name: string };
    disposed = false;
    handlers: {
      onUpdate: (sessionId: string, update: SessionUpdate) => void;
      onTurnEnd?: (sessionId: string, stopReason: string) => void;
      onConfigOptions?: (
        sessionId: string,
        configOptions: SessionConfigOption[],
      ) => void;
    };
    constructor(
      agent: { id: string; name: string },
      handlers: {
        onUpdate: (sessionId: string, update: SessionUpdate) => void;
        onTurnEnd?: (sessionId: string, stopReason: string) => void;
        onConfigOptions?: (
          sessionId: string,
          configOptions: SessionConfigOption[],
        ) => void;
      },
    ) {
      this.agent = agent;
      this.handlers = handlers;
      clients.push(this);
    }
    async connect() {}
    async dispose() {
      this.disposed = true;
    }
    getPid() {
      return null;
    }
    async sampleMemoryRssBytes() {
      return null;
    }
    async openSession(_cwd: string) {
      // Unique per open — Date.now() collides when sessions open in the same ms.
      const sessionId = `mock-${++mockSessionSeq}-${Date.now()}`;
      const h = this.handlers;
      let cancelled = false;
      /** Mirrors AcpClient: dispose while prompting ends the turn as cancelled. */
      let pendingReject: ((err: unknown) => void) | null = null;
      const configOptions = mockConfigOptions.map((o) =>
        o.type === "select"
          ? { ...o, options: o.options.map((opt) => ({ ...opt })) }
          : { ...o },
      );
      return {
        sessionId,
        configOptions,
        beginUpdates() {
          // No-op in mock — updates are emitted from prompt().
        },
        async prompt(text: string) {
          cancelled = false;
          h.onUpdate(sessionId, {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
          });
          try {
            for (const update of demoUpdates) {
              if (cancelled) {
                h.onTurnEnd?.(sessionId, "cancelled");
                return { stopReason: "cancelled" };
              }
              if (update.sessionUpdate === "user_message_chunk") continue;
              h.onUpdate(sessionId, update);
              await new Promise<void>((resolve, reject) => {
                pendingReject = reject;
                setTimeout(() => {
                  pendingReject = null;
                  resolve();
                }, 5);
              });
            }
            h.onTurnEnd?.(sessionId, "end_turn");
            return { stopReason: "end_turn" };
          } catch (err) {
            // dispose() may reject with "session disposed" (legacy) or resolve
            // via cancelled flag — both must not become connection errors.
            if (err instanceof Error && /session disposed/i.test(err.message)) {
              return { stopReason: "cancelled" };
            }
            throw err;
          } finally {
            pendingReject = null;
          }
        },
        async cancel() {
          cancelled = true;
        },
        async setConfigOption(configId: string, value: string | boolean) {
          for (const opt of configOptions) {
            if (opt.id !== configId) continue;
            if (opt.type === "select" && typeof value === "string") {
              opt.currentValue = value;
            } else if (opt.type === "boolean" && typeof value === "boolean") {
              opt.currentValue = value;
            }
          }
          h.onConfigOptions?.(sessionId, configOptions);
          return configOptions;
        },
        dispose() {
          cancelled = true;
          // Match prior AcpClient stopUpdatePump rejection so the catch path
          // for lifecycle races is exercised by offload/switch tests.
          const reject = pendingReject;
          pendingReject = null;
          reject?.(new Error("session disposed"));
        },
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
  userQuestions: UserQuestionRequest[];
  lists: Array<{ sessions: SessionSummary[]; active: string | null }>;
  loaded: Array<{
    session: SessionSummary;
    updates: SessionUpdate[];
    mode: string;
    commands: AvailableCommand[];
    configOptions?: SessionConfigOption[];
    usage?: SessionUsage | null;
  }>;
  commands: Array<{ sessionId: string; commands: AvailableCommand[] }>;
  modes: Array<{ sessionId: string; mode: string }>;
  configOptions: Array<{
    sessionId: string;
    configOptions: SessionConfigOption[];
  }>;
  events: SessionManagerEvents;
};

function capture(): Captured {
  const c: Captured = {
    updates: [],
    turnEnds: [],
    connections: [],
    permissions: [],
    userQuestions: [],
    lists: [],
    loaded: [],
    commands: [],
    modes: [],
    configOptions: [],
    events: {
      onUpdate: (sessionId, update) => c.updates.push({ sessionId, update }),
      onTurnEnd: (sessionId, stopReason) =>
        c.turnEnds.push({ sessionId, stopReason }),
      onConnectionState: (state) => c.connections.push(state),
      onPermissionRequest: (req) => c.permissions.push(req),
      onUserQuestionRequest: (req) => c.userQuestions.push(req),
      onSessionList: (sessions, activeSessionId) =>
        c.lists.push({ sessions, active: activeSessionId }),
      onCommands: (sessionId, commands) =>
        c.commands.push({ sessionId, commands }),
      onMode: (sessionId, mode) => c.modes.push({ sessionId, mode }),
      onConfigOptions: (sessionId, configOptions) =>
        c.configOptions.push({ sessionId, configOptions }),
      onUsage: () => {},
      onSessionLoaded: (session, updates, mode, commands, configOptions, usage) =>
        c.loaded.push({ session, updates, mode, commands, configOptions, usage }),
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

    // ACP config options (model list) should surface from session/new.
    const loaded = c.loaded.find((l) => l.session.id === res.session.id);
    expect(loaded?.configOptions?.some((o) => o.category === "model")).toBe(
      true,
    );
    expect(c.configOptions.some((e) => e.sessionId === res.session.id)).toBe(
      true,
    );
  });

  it("setConfigOption updates model selection from ACP", async () => {
    const { mgr, c, agentId } = await boot();
    const created = await mgr.createSession({ agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const res = await mgr.setConfigOption(
      "model",
      "model-b",
      created.session.id,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const model = res.configOptions.find((o) => o.id === "model");
    expect(model?.type).toBe("select");
    if (model?.type === "select") {
      expect(model.currentValue).toBe("model-b");
    }
    expect(
      c.configOptions.some(
        (e) =>
          e.sessionId === created.session.id &&
          e.configOptions.some(
            (o) =>
              o.id === "model" &&
              o.type === "select" &&
              o.currentValue === "model-b",
          ),
      ),
    ).toBe(true);
  });

  it("applies defaultEffort when a session opens", async () => {
    const { mgr, c, agentId } = await boot();
    // Mock agent starts at "high"; set settings default to "low".
    mgr.saveSettings({ defaultEffort: "low" });

    const created = await mgr.createSession({ agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const latest = [...c.configOptions]
      .reverse()
      .find((e) => e.sessionId === created.session.id);
    const thought = latest?.configOptions.find((o) => o.id === "thought_level");
    expect(thought?.type).toBe("select");
    if (thought?.type === "select") {
      expect(thought.currentValue).toBe("low");
    }
  });

  it("matches defaultEffort case-insensitively by name", async () => {
    const { mgr, c, agentId } = await boot();
    mgr.saveSettings({ defaultEffort: "Medium" });

    const created = await mgr.createSession({ agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const latest = [...c.configOptions]
      .reverse()
      .find((e) => e.sessionId === created.session.id);
    const thought = latest?.configOptions.find((o) => o.id === "thought_level");
    expect(thought?.type).toBe("select");
    if (thought?.type === "select") {
      expect(thought.currentValue).toBe("medium");
    }
  });

  it("applies defaultPermissionMode when a session opens", async () => {
    const { mgr, c, agentId } = await boot();
    mgr.saveSettings({ defaultPermissionMode: "acceptEdits" });

    const created = await mgr.createSession({ agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const latest = [...c.configOptions]
      .reverse()
      .find((e) => e.sessionId === created.session.id);
    const mode = latest?.configOptions.find((o) => o.id === "mode");
    expect(mode?.type).toBe("select");
    if (mode?.type === "select") {
      expect(mode.currentValue).toBe("acceptEdits");
    }
  });

  it("matches defaultPermissionMode case-insensitively by name", async () => {
    const { mgr, c, agentId } = await boot();
    mgr.saveSettings({ defaultPermissionMode: "Plan" });

    const created = await mgr.createSession({ agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const latest = [...c.configOptions]
      .reverse()
      .find((e) => e.sessionId === created.session.id);
    const mode = latest?.configOptions.find((o) => o.id === "mode");
    expect(mode?.type).toBe("select");
    if (mode?.type === "select") {
      expect(mode.currentValue).toBe("plan");
    }
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

  it("removeRecentProject hides a cwd until it is used again", async () => {
    const { mgr, agentId } = await boot();
    const cwd = process.cwd();
    const other = tempDir();
    dirs.push(other);
    await mgr.createSession({ title: "A", cwd, agentId });
    await mgr.createSession({ title: "B", cwd: other, agentId });

    const afterRemove = mgr.removeRecentProject(cwd);
    expect(afterRemove.map((p) => p.cwd)).not.toContain(cwd);
    expect(afterRemove.map((p) => p.cwd)).toContain(other);

    // Creating another session in that folder restores it to recents.
    await mgr.createSession({ title: "C", cwd, agentId });
    expect(mgr.listRecentProjects().map((p) => p.cwd)).toContain(cwd);
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
    // The user message is persisted by sendPrompt, NOT emitted on the stream
    // (the UI shows it optimistically; emitting would duplicate it). The mock
    // agent also echoes a user_message_chunk, which onUpdate must skip.
    const types = c.updates.map((u) => u.update.sessionUpdate);
    expect(types).not.toContain("user_message_chunk");
    expect(types).toContain("plan");
    expect(types).toContain("tool_call");
    expect(types).toContain("agent_message_chunk");
    expect(types).toContain("tool_call_update");
    // ...but it must survive a reload from the store.
    const reloaded = mgr["store"].loadEvents(created.session.id);
    expect(
      reloaded.some(
        (u) =>
          u.sessionUpdate === "user_message_chunk" &&
          u.content.type === "text" &&
          u.content.text === "How does progress work?",
      ),
    ).toBe(true);

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

  it("switchSession emits history before agent prepare finishes", async () => {
    const { mgr, c, agentId } = await boot();
    const a = await mgr.createSession({ title: "A", agentId });
    const b = await mgr.createSession({ title: "B", agentId });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await mgr.sendPrompt("history for A", a.session.id);
    await waitFor(() =>
      c.turnEnds.some((t) => t.sessionId === a.session.id),
    );

    c.loaded.length = 0;
    const switched = await mgr.switchSession(a.session.id);
    expect(switched.ok).toBe(true);

    // History must already be delivered when switchSession resolves (not after
    // a multi-second agent reconnect/openSession).
    expect(c.loaded.some((l) => l.session.id === a.session.id)).toBe(true);
    expect(mgr.listSessions().activeSessionId).toBe(a.session.id);
  });

  it("switchSession mid-prompt keeps the background turn running", async () => {
    const { mgr, c, agentId } = await boot();
    const a = await mgr.createSession({ title: "Busy", agentId });
    const b = await mgr.createSession({ title: "Other", agentId });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // A owns the live handle after create; switch back and start a long turn.
    await mgr.switchSession(a.session.id);
    // Wait for prepare to open A's handle (background chain).
    await waitFor(() => {
      const list = mgr.listSessions().sessions.find((s) => s.id === a.session.id);
      return list?.agentRunning === true;
    });

    await mgr.sendPrompt("keep going", a.session.id);
    expect(mgr.getConnectionState().status).toBe("prompting");

    // Switch away while A is still streaming.
    c.loaded.length = 0;
    const switched = await mgr.switchSession(b.session.id);
    expect(switched.ok).toBe(true);
    expect(mgr.listSessions().activeSessionId).toBe(b.session.id);
    expect(c.loaded.some((l) => l.session.id === b.session.id)).toBe(true);

    // Background prompt must not be cancelled by the switch.
    await Bun.sleep(30);
    const endsForA = c.turnEnds.filter((t) => t.sessionId === a.session.id);
    expect(endsForA.every((t) => t.stopReason !== "cancelled")).toBe(true);
    expect(
      endsForA.some((t) => t.stopReason === "cancelled"),
    ).toBe(false);

    // A still finishes the turn successfully.
    await waitFor(() =>
      c.turnEnds.some(
        (t) => t.sessionId === a.session.id && t.stopReason === "end_turn",
      ),
    );
  });

  it("createSession mid-prompt does not cancel the background turn", async () => {
    const { mgr, c, agentId } = await boot();
    const a = await mgr.createSession({ title: "Busy", agentId });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    await mgr.sendPrompt("keep going", a.session.id);
    expect(mgr.getConnectionState().status).toBe("prompting");

    const created = await mgr.createSession({ title: "New while busy", agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(mgr.listSessions().activeSessionId).toBe(created.session.id);

    // New chat has its own agent process; both can be running.
    const list = mgr.listSessions().sessions;
    expect(list.find((s) => s.id === a.session.id)?.agentRunning).toBe(true);
    expect(list.find((s) => s.id === created.session.id)?.agentRunning).toBe(
      true,
    );

    // Background turn on A must keep running.
    await Bun.sleep(30);
    expect(
      c.turnEnds.some(
        (t) => t.sessionId === a.session.id && t.stopReason === "cancelled",
      ),
    ).toBe(false);

    await waitFor(() =>
      c.turnEnds.some(
        (t) => t.sessionId === a.session.id && t.stopReason === "end_turn",
      ),
    );
  });

  it("createSession spawns a separate agent process per chat", async () => {
    mockAcpClients.length = 0;
    const { mgr, agentId } = await boot();
    const a = await mgr.createSession({ title: "A", agentId });
    const b = await mgr.createSession({ title: "B", agentId });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(mockAcpClients.length).toBeGreaterThanOrEqual(2);
    const clients = mockAcpClients.slice(-2);
    expect(clients.every((c) => !c.disposed)).toBe(true);

    // Both chats report an independent running agent.
    const list = mgr.listSessions().sessions;
    expect(list.find((s) => s.id === a.session.id)?.agentRunning).toBe(true);
    expect(list.find((s) => s.id === b.session.id)?.agentRunning).toBe(true);

    // Offloading B only kills B's process.
    const before = mockAcpClients.length;
    const off = await mgr.offloadSession(b.session.id);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.killed).toBe(true);
    const bClient = mockAcpClients[before - 1]!;
    expect(bClient.disposed).toBe(true);
    // A's client still alive
    const aStill = mockAcpClients.find((c) => !c.disposed);
    expect(aStill).toBeTruthy();
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

  it("offloadSession kills the ACP client but keeps chat history", async () => {
    mockAcpClients.length = 0;
    const { mgr, agentId } = await boot();
    const created = await mgr.createSession({ title: "Keep me", agentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(mockAcpClients.length).toBeGreaterThan(0);
    const client = mockAcpClients[mockAcpClients.length - 1]!;
    expect(client.disposed).toBe(false);
    expect(mgr.getConnectionState().status).toBe("ready");

    const before = mgr.listSessions().sessions.find((s) => s.id === created.session.id);
    expect(before?.agentRunning).toBe(true);

    const res = await mgr.offloadSession(created.session.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.killed).toBe(true);
    expect(client.disposed).toBe(true);
    expect(mgr.getConnectionState().status).toBe("idle");

    // Session list / history still present; agent no longer running.
    const list = mgr.listSessions();
    expect(list.sessions.map((s) => s.id)).toContain(created.session.id);
    const after = list.sessions.find((s) => s.id === created.session.id);
    expect(after?.agentRunning).toBe(false);
    const switched = await mgr.switchSession(created.session.id);
    expect(switched.ok).toBe(true);
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
