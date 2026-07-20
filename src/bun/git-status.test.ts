/**
 * Tests for git status porcelain parsing and commit-message helpers.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCommitMessagePrompt,
  commitGit,
  fetchGit,
  getGitStatus,
  parseBranchHeader,
  parseCommitMessageResponse,
  parsePorcelainLine,
  pushGit,
  stageGitFiles,
} from "./git-status";

const dirs: string[] = [];

function tempDir(prefix = "tr-git-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function run(
  cwd: string,
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, stdout: "", stderr: message };
  }
}

async function gitAvailable(): Promise<boolean> {
  const r = await run(process.cwd(), ["git", "--version"]);
  return r.exitCode === 0;
}

async function initRepo(): Promise<string> {
  const dir = tempDir();
  const r1 = await run(dir, ["git", "init", "-b", "main"]);
  expect(r1.exitCode).toBe(0);
  await run(dir, ["git", "config", "user.email", "test@example.com"]);
  await run(dir, ["git", "config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
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

describe("parsePorcelainLine", () => {
  it("parses modified staged+unstaged", () => {
    const f = parsePorcelainLine("MM src/app.ts");
    expect(f).toEqual({
      path: "src/app.ts",
      oldPath: undefined,
      kind: "modified",
      staged: true,
      unstaged: true,
      xy: "MM",
    });
  });

  it("parses untracked", () => {
    const f = parsePorcelainLine("?? new-file.ts");
    expect(f?.kind).toBe("untracked");
    expect(f?.staged).toBe(false);
    expect(f?.unstaged).toBe(true);
    expect(f?.path).toBe("new-file.ts");
  });

  it("parses rename", () => {
    const f = parsePorcelainLine("R  old.ts -> new.ts");
    expect(f?.kind).toBe("renamed");
    expect(f?.oldPath).toBe("old.ts");
    expect(f?.path).toBe("new.ts");
    expect(f?.staged).toBe(true);
  });

  it("skips branch header", () => {
    expect(parsePorcelainLine("## main")).toBeNull();
  });
});

describe("parseBranchHeader", () => {
  it("parses simple branch", () => {
    expect(parseBranchHeader("## main")).toEqual({
      branch: "main",
      ahead: 0,
      behind: 0,
    });
  });

  it("parses ahead/behind", () => {
    expect(
      parseBranchHeader("## main...origin/main [ahead 2, behind 1]"),
    ).toEqual({ branch: "main", ahead: 2, behind: 1 });
  });

  it("parses detached HEAD", () => {
    expect(parseBranchHeader("## HEAD (no branch)")).toEqual({
      branch: "HEAD",
      ahead: 0,
      behind: 0,
    });
  });
});

describe("parseCommitMessageResponse", () => {
  it("splits subject and body", () => {
    const m = parseCommitMessageResponse(
      "feat: add panel\n\nExplain why it exists.\nMore detail.",
    );
    expect(m.subject).toBe("feat: add panel");
    expect(m.body).toBe("Explain why it exists.\nMore detail.");
  });

  it("strips fenced blocks", () => {
    const m = parseCommitMessageResponse("```\nfix: thing\n\nBody\n```");
    expect(m.subject).toBe("fix: thing");
    expect(m.body).toBe("Body");
  });
});

describe("buildCommitMessagePrompt", () => {
  it("includes rules and context", () => {
    const p = buildCommitMessagePrompt("Branch: main\n- file.ts");
    expect(p).toContain("Conventional Commits");
    expect(p).toContain("Branch: main");
    expect(p).toContain("Output ONLY the commit message");
  });
});

describe("getGitStatus / stage / commit", () => {
  it("reports clean repo", async () => {
    if (!(await gitAvailable())) return;
    const dir = await initRepo();
    const s = await getGitStatus(dir);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe("main");
    expect(s.files).toEqual([]);
  });

  it("detects untracked and stages + commits", async () => {
    if (!(await gitAvailable())) return;
    const dir = await initRepo();
    writeFileSync(join(dir, "extra.txt"), "hello\n");
    const s1 = await getGitStatus(dir);
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    expect(
      s1.files.some((f) => f.path === "extra.txt" && f.kind === "untracked"),
    ).toBe(true);

    const st = await stageGitFiles(dir, ["extra.txt"]);
    expect(st).toEqual({ ok: true });

    const s2 = await getGitStatus(dir);
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    const f = s2.files.find((x) => x.path === "extra.txt");
    expect(f?.staged).toBe(true);

    const c = await commitGit(dir, "feat: add extra", "Why: test");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.hash.length).toBeGreaterThan(0);

    const s3 = await getGitStatus(dir);
    expect(s3.ok).toBe(true);
    if (!s3.ok) return;
    expect(s3.files).toEqual([]);
  });

  it("returns isRepo false for non-git dir", async () => {
    if (!(await gitAvailable())) return;
    const dir = tempDir();
    const s = await getGitStatus(dir);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.isRepo).toBe(false);
  });

  it("fetch returns ok without throwing", async () => {
    if (!(await gitAvailable())) return;
    const dir = await initRepo();
    const res = await fetchGit(dir);
    // No remote is fine for fetch (no-op success on some git versions).
    if (res.ok) {
      expect(typeof res.summary).toBe("string");
    } else {
      expect(res.error.length).toBeGreaterThan(0);
    }
  });

  it("push fails cleanly without a remote", async () => {
    if (!(await gitAvailable())) return;
    const dir = await initRepo();
    const res = await pushGit(dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.length).toBeGreaterThan(0);
  });
});
