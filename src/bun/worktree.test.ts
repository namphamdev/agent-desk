import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  formatSymlinkPathsText,
  normalizeSharedPath,
  normalizeSymlinkPaths,
  parseSymlinkPathsText,
} from "../shared/worktree-paths";
import {
  createWorktree,
  defaultWorktreePath,
  getGitTopLevel,
  linkSharedPaths,
  parseWorktreeListPorcelain,
  sanitizeWorktreeDirName,
} from "./worktree";

const dirs: string[] = [];

function tempDir(prefix = "tr-wt-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function run(
  cwd: string,
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function initRepo(): Promise<string> {
  const dir = tempDir();
  const r1 = await run(dir, ["git", "init", "-b", "main"]);
  expect(r1.exitCode).toBe(0);
  await run(dir, ["git", "config", "user.email", "test@example.com"]);
  await run(dir, ["git", "config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports=1\n");
  // node_modules may be ignored by default templates — force-add if needed for existence only
  // (we only need the folder on disk for symlink source, not in git).
  const add = await run(dir, ["git", "add", "README.md"]);
  expect(add.exitCode).toBe(0);
  const commit = await run(dir, ["git", "commit", "-m", "init"]);
  expect(commit.exitCode).toBe(0);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("path helpers", () => {
  it("sanitizes branch names for directories", () => {
    expect(sanitizeWorktreeDirName("feature/foo")).toBe("feature-foo");
    expect(sanitizeWorktreeDirName("  a b  ")).toBe("a-b");
    expect(sanitizeWorktreeDirName("../evil")).toBe("evil");
  });

  it("rejects unsafe shared paths", () => {
    expect(normalizeSharedPath("node_modules")).toBe("node_modules");
    expect(normalizeSharedPath("vendor/bundle")).toBe("vendor/bundle");
    expect(normalizeSharedPath("../etc")).toBeNull();
    expect(normalizeSharedPath("/abs")).toBeNull();
    expect(normalizeSharedPath("")).toBeNull();
  });

  it("normalizes and formats symlink path lists", () => {
    expect(normalizeSymlinkPaths(undefined)).toEqual(["node_modules"]);
    expect(normalizeSymlinkPaths(["node_modules", "node_modules", "../x"])).toEqual([
      "node_modules",
    ]);
    expect(parseSymlinkPathsText("node_modules\n.venv, vendor")).toEqual([
      "node_modules",
      ".venv",
      "vendor",
    ]);
    expect(formatSymlinkPathsText(["node_modules", ".venv"])).toBe(
      "node_modules\n.venv",
    );
  });

  it("parses porcelain worktree list", () => {
    const text = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo-wt",
      "HEAD def",
      "branch refs/heads/feature/x",
      "",
      "worktree /detached",
      "HEAD ghi",
      "detached",
      "",
    ].join("\n");
    const list = parseWorktreeListPorcelain(text);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ path: "/repo", branch: "main" });
    expect(list[1]).toMatchObject({
      path: "/repo-wt",
      branch: "feature/x",
    });
    expect(list[2]).toMatchObject({ path: "/detached", detached: true, branch: null });
  });
});

describe("linkSharedPaths", () => {
  it("symlinks configured paths from main into worktree", () => {
    const main = tempDir("tr-main-");
    const wt = tempDir("tr-wtpath-");
    mkdirSync(join(main, "node_modules", "x"), { recursive: true });
    writeFileSync(join(main, "node_modules", "x", "a.js"), "1");
    mkdirSync(join(main, ".venv"), { recursive: true });

    const linked = linkSharedPaths(main, wt, ["node_modules", ".venv", "missing"]);
    expect(linked.sort()).toEqual([".venv", "node_modules"]);

    const dest = join(wt, "node_modules");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(resolve(join(wt, readlinkSync(dest)))).toBe(resolve(join(main, "node_modules")));
    expect(existsSync(join(wt, "node_modules", "x", "a.js"))).toBe(true);
  });

  it("does not clobber a real directory in the worktree", () => {
    const main = tempDir("tr-main2-");
    const wt = tempDir("tr-wt2-");
    mkdirSync(join(main, "node_modules"), { recursive: true });
    mkdirSync(join(wt, "node_modules"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "keep.txt"), "keep");

    const linked = linkSharedPaths(main, wt, ["node_modules"]);
    expect(linked).toEqual([]);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(wt, "node_modules", "keep.txt"))).toBe(true);
  });

  it("repairs a broken symlink", () => {
    const main = tempDir("tr-main3-");
    const wt = tempDir("tr-wt3-");
    mkdirSync(join(main, "node_modules"), { recursive: true });
    symlinkSync("./nope", join(wt, "node_modules"));

    const linked = linkSharedPaths(main, wt, ["node_modules"]);
    expect(linked).toEqual(["node_modules"]);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    const target = resolve(join(wt, readlinkSync(join(wt, "node_modules"))));
    expect(target).toBe(resolve(join(main, "node_modules")));
  });
});

describe("createWorktree", () => {
  it("creates a worktree on a new branch and links node_modules", async () => {
    const main = await initRepo();
    const top = await getGitTopLevel(main);
    expect(top).toBeTruthy();

    const res = await createWorktree({
      mainCwd: main,
      branch: "feature/shared-deps",
      symlinkPaths: ["node_modules"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.created).toBe(true);
    expect(res.branch).toBe("feature/shared-deps");
    expect(res.linked).toContain("node_modules");
    expect(existsSync(join(res.path, "README.md"))).toBe(true);
    expect(lstatSync(join(res.path, "node_modules")).isSymbolicLink()).toBe(true);

    const expected = defaultWorktreePath(top!, "feature/shared-deps");
    expect(resolve(res.path)).toBe(resolve(expected));

    // Reuse returns same path without error.
    const again = await createWorktree({
      mainCwd: main,
      branch: "feature/shared-deps",
      symlinkPaths: ["node_modules"],
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.created).toBe(false);
    expect(resolve(again.path)).toBe(resolve(res.path));
  });

  it("fails when not a git repo", async () => {
    const dir = tempDir();
    const res = await createWorktree({ mainCwd: dir, branch: "x" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a git repository/i);
  });

  it("requires a branch name", async () => {
    const main = await initRepo();
    const res = await createWorktree({ mainCwd: main, branch: "  " });
    expect(res.ok).toBe(false);
  });
});
