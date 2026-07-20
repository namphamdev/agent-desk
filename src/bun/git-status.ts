/**
 * Git working-tree status, staging, commit, and diff helpers for the
 * in-app Git Changes panel.
 */
import { basename, join } from "node:path";

export type GitFileKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflict"
  | "typechange"
  | "unknown";

export type GitFileChange = {
  path: string;
  /** Original path when renamed/copied. */
  oldPath?: string;
  kind: GitFileKind;
  /** True when index (staged) side has a change. */
  staged: boolean;
  /** True when worktree side has a change (or untracked). */
  unstaged: boolean;
  /** Raw XY status chars from `git status --porcelain`. */
  xy: string;
};

export type GitStatusPayload = {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  isRepo: boolean;
};

export type GitCommitMessage = {
  subject: string;
  body: string;
};

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
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

function kindFromXy(x: string, y: string): GitFileKind {
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return "conflict";
  }
  if (x === "?" || y === "?") return "untracked";
  if (x === "R" || y === "R") return "renamed";
  if (x === "C" || y === "C") return "copied";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "T" || y === "T") return "typechange";
  if (x === "M" || y === "M") return "modified";
  return "unknown";
}

/**
 * Parse one `git status --porcelain=v1 -b` line into a file change.
 * Handles rename (`R  old -> new`) and untracked paths.
 */
export function parsePorcelainLine(line: string): GitFileChange | null {
  if (!line || line.startsWith("##")) return null;
  if (line.length < 3) return null;

  const x = line[0] ?? " ";
  const y = line[1] ?? " ";
  const rest = line.slice(3);

  let path = rest;
  let oldPath: string | undefined;

  // Rename/copy: "old -> new" (paths may be quoted).
  const arrow = rest.indexOf(" -> ");
  if (arrow >= 0 && (x === "R" || x === "C" || y === "R" || y === "C")) {
    oldPath = unquotePath(rest.slice(0, arrow));
    path = unquotePath(rest.slice(arrow + 4));
  } else {
    path = unquotePath(rest);
  }

  if (!path) return null;

  const staged = x !== " " && x !== "?";
  const unstaged = y !== " " || x === "?";
  return {
    path,
    oldPath,
    kind: kindFromXy(x, y),
    staged,
    unstaged,
    xy: `${x}${y}`,
  };
}

function unquotePath(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // git C-style quotes: \" \\ \t \n \r
    return s
      .slice(1, -1)
      .replace(/\\([\\"nt])/g, (_, c: string) => {
        if (c === "n") return "\n";
        if (c === "t") return "\t";
        return c;
      });
  }
  return s;
}

/** Parse branch header: `## main...origin/main [ahead 1, behind 2]`. */
export function parseBranchHeader(line: string): {
  branch: string | null;
  ahead: number;
  behind: number;
} {
  if (!line.startsWith("## ")) {
    return { branch: null, ahead: 0, behind: 0 };
  }
  const body = line.slice(3).trim();
  // Detached: `## HEAD (no branch)`
  if (body.startsWith("HEAD ") || body === "HEAD (no branch)") {
    return { branch: "HEAD", ahead: 0, behind: 0 };
  }
  const noTrack = body.split("...")[0]?.trim() ?? body;
  const branch = noTrack.split(/\s+/)[0] || null;
  let ahead = 0;
  let behind = 0;
  const m = body.match(/\[([^\]]+)\]/);
  if (m?.[1]) {
    const a = m[1].match(/ahead\s+(\d+)/);
    const b = m[1].match(/behind\s+(\d+)/);
    if (a) ahead = Number(a[1]) || 0;
    if (b) behind = Number(b[1]) || 0;
  }
  return { branch, ahead, behind };
}

export async function getGitStatus(cwd: string): Promise<
  | ({ ok: true } & GitStatusPayload)
  | { ok: false; error: string }
> {
  const dir = cwd?.trim();
  if (!dir) return { ok: false, error: "No project folder." };

  try {
    const { exitCode, stdout, stderr } = await runGit(dir, [
      "status",
      "--porcelain=v1",
      "-b",
    ]);
    if (exitCode !== 0) {
      const msg = stderr.trim() || stdout.trim() || "git status failed";
      if (/not a git repository/i.test(msg)) {
        return {
          ok: true,
          branch: null,
          ahead: 0,
          behind: 0,
          files: [],
          isRepo: false,
        };
      }
      if (/ENOENT|not found|Executable not found/i.test(msg)) {
        return { ok: false, error: "git is not available on PATH." };
      }
      return { ok: false, error: msg };
    }

    const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    const files: GitFileChange[] = [];

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const h = parseBranchHeader(line);
        branch = h.branch;
        ahead = h.ahead;
        behind = h.behind;
        continue;
      }
      const f = parsePorcelainLine(line);
      if (f) files.push(f);
    }

    return {
      ok: true,
      branch,
      ahead,
      behind,
      files,
      isRepo: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function getGitDiff(
  cwd: string,
  path: string,
  staged: boolean,
): Promise<{ ok: true; diff: string } | { ok: false; error: string }> {
  const dir = cwd?.trim();
  const file = path?.trim();
  if (!dir || !file) return { ok: false, error: "Missing cwd or path." };

  try {
    // Untracked files: show full content as a synthetic diff.
    if (!staged) {
      const check = await runGit(dir, ["ls-files", "--error-unmatch", "--", file]);
      if (check.exitCode !== 0) {
        const content = await Bun.file(join(dir, file)).text().catch(() => null);
        if (content == null) {
          return { ok: true, diff: `(untracked) ${file}\n` };
        }
        const lines = content.split(/\r?\n/);
        const body = lines.map((l) => `+${l}`).join("\n");
        return {
          ok: true,
          diff: `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n${body}\n`,
        };
      }
    }

    const args = staged
      ? ["diff", "--cached", "--", file]
      : ["diff", "--", file];
    const { exitCode, stdout, stderr } = await runGit(dir, args);
    if (exitCode !== 0) {
      return { ok: false, error: stderr.trim() || "git diff failed" };
    }
    return { ok: true, diff: stdout || "(no textual diff)\n" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function stageGitFiles(
  cwd: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = cwd?.trim();
  const list = paths.map((p) => p.trim()).filter(Boolean);
  if (!dir) return { ok: false, error: "No project folder." };
  if (list.length === 0) return { ok: false, error: "No paths to stage." };

  try {
    const { exitCode, stderr } = await runGit(dir, ["add", "--", ...list]);
    if (exitCode !== 0) {
      return { ok: false, error: stderr.trim() || "git add failed" };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function unstageGitFiles(
  cwd: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = cwd?.trim();
  const list = paths.map((p) => p.trim()).filter(Boolean);
  if (!dir) return { ok: false, error: "No project folder." };
  if (list.length === 0) return { ok: false, error: "No paths to unstage." };

  try {
    // `restore --staged` works on modern git; fall back to reset HEAD.
    let result = await runGit(dir, ["restore", "--staged", "--", ...list]);
    if (result.exitCode !== 0) {
      result = await runGit(dir, ["reset", "HEAD", "--", ...list]);
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: result.stderr.trim() || "git unstage failed",
      };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function commitGit(
  cwd: string,
  subject: string,
  body?: string,
): Promise<{ ok: true; hash: string } | { ok: false; error: string }> {
  const dir = cwd?.trim();
  const subj = subject?.trim();
  if (!dir) return { ok: false, error: "No project folder." };
  if (!subj) return { ok: false, error: "Commit subject is required." };

  const message = body?.trim() ? `${subj}\n\n${body.trim()}` : subj;

  try {
    // Ensure something is staged.
    const staged = await runGit(dir, ["diff", "--cached", "--name-only"]);
    if (staged.exitCode !== 0) {
      return { ok: false, error: staged.stderr.trim() || "git diff failed" };
    }
    if (!staged.stdout.trim()) {
      return { ok: false, error: "Nothing staged to commit." };
    }

    const { exitCode, stderr } = await runGit(dir, [
      "commit",
      "-m",
      message,
    ]);
    if (exitCode !== 0) {
      return { ok: false, error: stderr.trim() || "git commit failed" };
    }

    const rev = await runGit(dir, ["rev-parse", "--short", "HEAD"]);
    const hash = rev.exitCode === 0 ? rev.stdout.trim() : "";
    return { ok: true, hash };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg };
  }
}

function summarizeGitRemoteOutput(stdout: string, stderr: string): string {
  const text = [stdout, stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) return "";
  // Prefer the last non-empty line — git often prints progress on stderr.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? text;
}

/** Fetch from the configured remote (default: all remotes / origin). */
export async function fetchGit(
  cwd: string,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const dir = cwd?.trim();
  if (!dir) return { ok: false, error: "No project folder." };

  try {
    const { exitCode, stdout, stderr } = await runGit(dir, [
      "fetch",
      "--prune",
      "--progress",
    ]);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: stderr.trim() || stdout.trim() || "git fetch failed",
      };
    }
    const summary =
      summarizeGitRemoteOutput(stdout, stderr) || "Fetch complete.";
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Push the current branch to its upstream (sets upstream on first push).
 * Uses `git push -u` when no upstream is configured.
 */
export async function pushGit(
  cwd: string,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const dir = cwd?.trim();
  if (!dir) return { ok: false, error: "No project folder." };

  try {
    // Detect whether HEAD has an upstream.
    const up = await runGit(dir, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    const hasUpstream = up.exitCode === 0 && up.stdout.trim().length > 0;

    const args = hasUpstream
      ? ["push", "--progress"]
      : ["push", "-u", "origin", "HEAD", "--progress"];

    const { exitCode, stdout, stderr } = await runGit(dir, args);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: stderr.trim() || stdout.trim() || "git push failed",
      };
    }
    const summary =
      summarizeGitRemoteOutput(stdout, stderr) || "Push complete.";
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Build a compact status + diff summary for the commit-message agent prompt.
 * Caps total size so the agent context stays reasonable.
 */
export async function buildCommitContext(
  cwd: string,
  maxDiffChars = 24_000,
): Promise<
  | { ok: true; summary: string; hasStaged: boolean; hasChanges: boolean }
  | { ok: false; error: string }
> {
  const status = await getGitStatus(cwd);
  if (!status.ok) return status;
  if (!status.isRepo) return { ok: false, error: "Not a git repository." };
  if (status.files.length === 0) {
    return { ok: false, error: "No changes to commit." };
  }

  const stagedFiles = status.files.filter((f) => f.staged);
  const unstagedOnly = status.files.filter((f) => f.unstaged && !f.staged);
  const hasStaged = stagedFiles.length > 0;

  const lines: string[] = [];
  lines.push(`Branch: ${status.branch ?? "(unknown)"}`);
  lines.push(`Project: ${basename(cwd)}`);
  lines.push("");
  lines.push("Files:");
  for (const f of status.files) {
    const flags = [
      f.staged ? "staged" : null,
      f.unstaged ? "unstaged" : null,
    ]
      .filter(Boolean)
      .join("+");
    lines.push(
      `- [${f.kind}/${flags}] ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ""}`,
    );
  }

  // Prefer staged diff for the message; include unstaged summary if nothing staged.
  const diffArgs = hasStaged
    ? ["diff", "--cached", "--stat", "-p", "--"]
    : ["diff", "HEAD", "--stat", "-p", "--"];
  const { stdout: diffOut } = await runGit(cwd, [
    ...diffArgs,
    ...(hasStaged
      ? stagedFiles.map((f) => f.path)
      : status.files.map((f) => f.path)),
  ]);

  let diff = diffOut.trim();
  if (!diff && !hasStaged) {
    // Untracked files only — show short headers.
    const bits: string[] = [];
    for (const f of unstagedOnly
      .filter((x) => x.kind === "untracked")
      .slice(0, 20)) {
      const d = await getGitDiff(cwd, f.path, false);
      if (d.ok) bits.push(d.diff.slice(0, 2000));
    }
    diff = bits.join("\n");
  }

  if (diff.length > maxDiffChars) {
    diff = `${diff.slice(0, maxDiffChars)}\n\n…(diff truncated)`;
  }

  lines.push("");
  lines.push(hasStaged ? "Staged diff:" : "Working tree diff:");
  lines.push(diff || "(no textual diff)");

  return {
    ok: true,
    summary: lines.join("\n"),
    hasStaged,
    hasChanges: true,
  };
}

/** Prompt text for ACP commit-message generation. */
export function buildCommitMessagePrompt(contextSummary: string): string {
  return [
    "You are writing a git commit message for the changes below.",
    "Rules:",
    "- Output ONLY the commit message — no preamble, no markdown fences, no tool calls.",
    "- First line: imperative subject ≤72 characters (Conventional Commits style when it fits, e.g. feat:, fix:, docs:).",
    "- Optional body after a blank line: wrap ~72 chars, explain why not how.",
    "- Do not run shell commands or tools. Do not stage or commit.",
    "",
    "Changes:",
    contextSummary,
  ].join("\n");
}

/**
 * Parse agent free-text into subject + body.
 * Accepts plain text or fenced blocks.
 */
export function parseCommitMessageResponse(raw: string): GitCommitMessage {
  let text = raw.trim();
  // Strip a single surrounding fence.
  const fence = text.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence?.[1]) text = fence[1].trim();

  // Drop common labels the model might add.
  text = text.replace(/^(?:commit message|subject|title)\s*:\s*/i, "");

  const parts = text.split(/\r?\n/);
  const subject = (parts[0] ?? "").trim().replace(/^["']|["']$/g, "");
  let bodyStart = 1;
  while (bodyStart < parts.length && parts[bodyStart]?.trim() === "") {
    bodyStart++;
  }
  const body = parts.slice(bodyStart).join("\n").trim();
  return { subject, body };
}
