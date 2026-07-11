import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetCommandRunnerForTests,
  addCommand,
  CommandRunner,
  loadCommands,
  normalizeProjectCwd,
  removeCommand,
  saveCommands,
} from "./user-commands";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "tr-cmds-"));
}

describe("user-commands project scope", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    _resetCommandRunnerForTests();
  });

  it("scopes commands to a project folder", () => {
    const data = tempDir();
    const projA = join(data, "proj-a");
    const projB = join(data, "proj-b");
    dirs.push(data);

    const a = addCommand(data, {
      projectCwd: projA,
      name: "A tests",
      command: "bun test",
    });
    const b = addCommand(data, {
      projectCwd: projB,
      name: "B build",
      command: "bun run build",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(loadCommands(data, projA)).toHaveLength(1);
    expect(loadCommands(data, projA)[0]?.name).toBe("A tests");
    expect(loadCommands(data, projB)).toHaveLength(1);
    expect(loadCommands(data, projB)[0]?.name).toBe("B build");
    expect(loadCommands(data, projA)[0]?.projectCwd).toBe(
      normalizeProjectCwd(projA),
    );
  });

  it("rejects empty name, command, or project", () => {
    const data = tempDir();
    dirs.push(data);
    expect(
      addCommand(data, { projectCwd: "", name: "x", command: "ls" }).ok,
    ).toBe(false);
    expect(
      addCommand(data, { projectCwd: "/tmp/p", name: "", command: "ls" }).ok,
    ).toBe(false);
    expect(
      addCommand(data, { projectCwd: "/tmp/p", name: "x", command: "  " }).ok,
    ).toBe(false);
  });

  it("removes only within the project", () => {
    const data = tempDir();
    const projA = join(data, "a");
    const projB = join(data, "b");
    dirs.push(data);

    const a = addCommand(data, {
      projectCwd: projA,
      name: "A",
      command: "echo a",
    });
    const b = addCommand(data, {
      projectCwd: projB,
      name: "B",
      command: "echo b",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const removed = removeCommand(data, projA, a.command.id);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.commands).toHaveLength(0);
    expect(loadCommands(data, projB)).toHaveLength(1);
    expect(removeCommand(data, projA, "missing").ok).toBe(false);
  });

  it("round-trips through project-commands.json", () => {
    const data = tempDir();
    const proj = join(data, "my-app");
    dirs.push(data);
    saveCommands(data, proj, [
      {
        id: "cmd_1",
        name: "Hello",
        command: "echo hi",
        projectCwd: normalizeProjectCwd(proj),
        createdAt: 1,
      },
    ]);
    expect(existsSync(join(data, "project-commands.json"))).toBe(true);
    const loaded = loadCommands(data, proj);
    expect(loaded[0]?.name).toBe("Hello");
    const raw = readFileSync(join(data, "project-commands.json"), "utf8");
    expect(raw).toContain("echo hi");
    expect(raw).toContain("byProject");
  });
});

describe("CommandRunner project runs", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    _resetCommandRunnerForTests();
  });

  it("spawns in project cwd and filters runs by project", async () => {
    const data = tempDir();
    const proj = tempDir();
    dirs.push(data, proj);
    const runner = new CommandRunner(data);
    const start = await runner.start({
      id: "cmd_echo",
      name: "Echo",
      command: "echo hello-cmd-panel",
      projectCwd: proj,
      createdAt: Date.now(),
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.run.projectCwd).toBe(normalizeProjectCwd(proj));
    expect(start.run.cwd).toBe(normalizeProjectCwd(proj));

    for (let i = 0; i < 50; i++) {
      const run = runner.getRun(start.run.id);
      if (run && run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const log = runner.getLog(start.run.id);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.run.status).toBe("exited");
    expect(log.run.exitCode).toBe(0);
    expect(log.log).toContain("hello-cmd-panel");

    expect(runner.listRuns(proj)).toHaveLength(1);
    expect(runner.listRuns(join(data, "other-project"))).toHaveLength(0);
  }, 10_000);

  it("can kill a long-running process", async () => {
    const data = tempDir();
    const proj = tempDir();
    dirs.push(data, proj);
    const runner = new CommandRunner(data);
    const start = await runner.start({
      id: "cmd_sleep",
      name: "Sleep",
      command: "sleep 30",
      projectCwd: proj,
      createdAt: Date.now(),
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.run.status).toBe("running");

    const stopped = runner.stop(start.run.id);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.run.status).toBe("killed");
  }, 10_000);
});
