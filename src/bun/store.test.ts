import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store";
import type { SessionUpdate } from "../session/types";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "terminal-react-store-"));
}

describe("SessionStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function openStore() {
    const dir = tempDir();
    dirs.push(dir);
    return { store: new SessionStore(dir), dir };
  }

  it("creates, lists, gets, and deletes sessions", () => {
    const { store } = openStore();
    const s = store.createSession({
      id: "sess-1",
      title: "First",
      project: "demo",
      cwd: "/tmp/demo",
      agentId: "demo",
    });

    expect(s).toMatchObject({
      id: "sess-1",
      title: "First",
      project: "demo",
      cwd: "/tmp/demo",
      agentId: "demo",
      mode: "default",
    });
    expect(s.createdAt).toBeTypeOf("number");
    expect(s.updatedAt).toBe(s.createdAt);

    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession("sess-1")?.title).toBe("First");

    store.deleteSession("sess-1");
    expect(store.listSessions()).toHaveLength(0);
    expect(store.getSession("sess-1")).toBeNull();
    store.close();
  });

  it("updates session fields and touches updatedAt", async () => {
    const { store } = openStore();
    const s = store.createSession({
      id: "sess-2",
      title: "Old",
      project: "p",
      cwd: "/tmp",
      agentId: "demo",
    });

    await Bun.sleep(5);
    store.updateSession("sess-2", {
      title: "New title",
      project: "proj",
      mode: "plan",
      agentId: "claude-code",
    });

    const got = store.getSession("sess-2");
    expect(got).toMatchObject({
      title: "New title",
      project: "proj",
      mode: "plan",
      agentId: "claude-code",
    });
    expect(got!.updatedAt).toBeGreaterThanOrEqual(s.updatedAt);
    store.close();
  });

  it("no-ops updateSession for missing ids", () => {
    const { store } = openStore();
    expect(() =>
      store.updateSession("missing", { title: "x" }),
    ).not.toThrow();
    store.close();
  });

  it("appends events in order and reloads them", () => {
    const { store } = openStore();
    store.createSession({
      id: "sess-3",
      title: "Events",
      project: "p",
      cwd: "/tmp",
      agentId: "demo",
    });

    const updates: SessionUpdate[] = [
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read",
        kind: "read",
        status: "completed",
      },
    ];

    for (const u of updates) store.appendEvent("sess-3", u);

    const loaded = store.loadEvents("sess-3");
    expect(loaded).toEqual(updates);

    // touch via appendEvent should bump updatedAt
    const before = store.getSession("sess-3")!.updatedAt;
    store.appendEvent("sess-3", {
      sessionUpdate: "current_mode",
      mode: "default",
    });
    expect(store.getSession("sess-3")!.updatedAt).toBeGreaterThanOrEqual(before);
    store.close();
  });

  it("deletes events when session is deleted", () => {
    const { store } = openStore();
    store.createSession({
      id: "sess-4",
      title: "Gone",
      project: "p",
      cwd: "/tmp",
      agentId: "demo",
    });
    store.appendEvent("sess-4", {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "bye" },
    });
    store.deleteSession("sess-4");
    expect(store.loadEvents("sess-4")).toEqual([]);
    store.close();
  });

  it("lists sessions newest-first by updated_at", async () => {
    const { store } = openStore();
    store.createSession({
      id: "old",
      title: "Old",
      project: "p",
      cwd: "/tmp",
      agentId: "demo",
    });
    await Bun.sleep(5);
    store.createSession({
      id: "new",
      title: "New",
      project: "p",
      cwd: "/tmp",
      agentId: "demo",
    });
    const list = store.listSessions();
    expect(list.map((s) => s.id)).toEqual(["new", "old"]);

    // Touching the old one should promote it.
    await Bun.sleep(5);
    store.touchSession("old");
    expect(store.listSessions().map((s) => s.id)).toEqual(["old", "new"]);
    store.close();
  });

  it("persists settings key/value pairs", () => {
    const { store, dir } = openStore();
    expect(store.getSetting("theme")).toBeNull();
    store.setSetting("theme", "light");
    expect(store.getSetting("theme")).toBe("light");
    store.setSetting("theme", "dark");
    expect(store.getSetting("theme")).toBe("dark");
    store.close();

    // Re-open same db file — settings survive.
    const store2 = new SessionStore(dir);
    expect(store2.getSetting("theme")).toBe("dark");
    store2.close();
  });
});
