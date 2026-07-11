/**
 * Git worktree helpers for isolated session folders.
 *
 * After `git worktree add`, optionally symlink heavy shared paths
 * (e.g. node_modules) from the main working tree so installs are not duplicated.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  DEFAULT_WORKTREE_SYMLINK_PATHS,
  normalizeSharedPath,
} from "../shared/worktree-paths";

export {
  DEFAULT_WORKTREE_SYMLINK_PATHS,
  formatSymlinkPathsText,
  normalizeSharedPath,
  normalizeSymlinkPaths,
  parseSymlinkPathsText,
} from "../shared/worktree-paths";

export type WorktreeInfo = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
};

export type CreateWorktreeOpts = {
  /** Main project working tree (must be a git checkout). */
  mainCwd: string;
  /** Branch to check out in the worktree. */
  branch: string;
  /**
   * When true (default), create `branch` if it does not exist yet
   * (`git worktree add -b …`). When false, the branch must already exist.
   */
  createBranch?: boolean;
  /** Explicit worktree path. Default: `<parent>/<repo>.worktrees/<branch>`. */
  path?: string;
  /**
   * Relative paths to symlink from `mainCwd` into the new worktree
   * when present on main and missing in the worktree.
   */
  symlinkPaths?: string[];
};

export type CreateWorktreeResult =
  | {
      ok: true;
      path: string;
      branch: string;
      created: boolean;
      linked: string[];
      mainCwd: string;
    }
  | { ok: false; error: string };

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
}

/** Resolve the top-level working tree for a path, or null if not a git checkout. */
export async function getGitTopLevel(cwd: string): Promise<string | null> {
  const dir = cwd?.trim();
  if (!dir) return null;
  try {
    const { exitCode, stdout } = await runGit(dir, ["rev-parse", "--show-toplevel"]);
    if (exitCode !== 0) return null;
    const top = stdout.trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/** True when `branch` exists as a local ref. */
export async function localBranchExists(
  cwd: string,
  branch: string,
): Promise<boolean> {
  const name = branch.trim();
  if (!name) return false;
  const { exitCode } = await runGit(cwd, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${name}`,
  ]);
  return exitCode === 0;
}

/**
 * Sanitize a branch name for use as a single path segment under the worktrees root.
 * Keeps hierarchy readable (`feature/foo` → `feature-foo`).
 */
export function sanitizeWorktreeDirName(branch: string): string {
  const cleaned = branch
    .trim()
    .replace(/^[./]+/, "")
    .replace(/[\\/:\0<>"|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  return cleaned || "worktree";
}

/** Default directory for a worktree of `mainCwd` checking out `branch`. */
export function defaultWorktreePath(mainCwd: string, branch: string): string {
  const top = resolve(mainCwd);
  const parent = dirname(top);
  const repo = basename(top);
  return join(parent, `${repo}.worktrees`, sanitizeWorktreeDirName(branch));
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktreeListPorcelain(stdout: string): WorktreeInfo[] {
  const items: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;

  const flush = () => {
    if (current?.path) {
      items.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
      });
    }
    current = null;
  };

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length).trim(),
        bare: false,
        detached: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim() || null;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.replace(/^refs\/heads\//, "") || null;
      current.detached = false;
    } else if (line === "detached") {
      current.detached = true;
      current.branch = null;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return items;
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const top = await getGitTopLevel(cwd);
  if (!top) return [];
  const { exitCode, stdout } = await runGit(top, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (exitCode !== 0) return [];
  return parseWorktreeListPorcelain(stdout);
}

/**
 * Symlink shared paths from `mainCwd` into `worktreeCwd`.
 * Skips missing sources and existing real destinations; repairs broken links.
 * Returns the relative paths that were linked (or already correctly linked).
 */
export function linkSharedPaths(
  mainCwd: string,
  worktreeCwd: string,
  symlinkPaths: string[],
): string[] {
  const main = resolve(mainCwd);
  const wt = resolve(worktreeCwd);
  const linked: string[] = [];

  for (const raw of symlinkPaths) {
    const rel = normalizeSharedPath(raw);
    if (!rel) continue;

    const src = join(main, rel);
    const dest = join(wt, rel);

    if (!existsSync(src)) continue;

    let destExists = false;
    let isLink = false;
    try {
      const st = lstatSync(dest);
      destExists = true;
      isLink = st.isSymbolicLink();
    } catch {
      destExists = false;
    }

    if (destExists && !isLink) {
      // Real file/dir already present — do not clobber.
      continue;
    }

    if (isLink) {
      try {
        const current = readlinkSync(dest);
        const resolvedCurrent = resolve(dirname(dest), current);
        if (resolve(resolvedCurrent) === resolve(src)) {
          linked.push(rel);
          continue;
        }
      } catch {
        /* replace below */
      }
      try {
        rmSync(dest, { force: true });
      } catch {
        continue;
      }
    }

    try {
      mkdirSync(dirname(dest), { recursive: true });
      const target = relative(dirname(dest), src);
      symlinkSync(target, dest);
      linked.push(rel);
    } catch {
      // Best-effort: continue other paths.
    }
  }

  return linked;
}

/**
 * Create (or reuse) a git worktree for `branch` and symlink configured shared paths.
 */
export async function createWorktree(
  opts: CreateWorktreeOpts,
): Promise<CreateWorktreeResult> {
  const branch = opts.branch?.trim() ?? "";
  if (!branch) {
    return { ok: false, error: "Branch name is required for a worktree." };
  }
  if (branch.includes("..") || /[\0\n\r]/.test(branch)) {
    return { ok: false, error: "Invalid branch name." };
  }

  const mainCwd = resolve(opts.mainCwd);
  const top = await getGitTopLevel(mainCwd);
  if (!top) {
    return {
      ok: false,
      error: `Not a git repository: ${mainCwd}`,
    };
  }

  const worktreePath = resolve(
    opts.path?.trim() || defaultWorktreePath(top, branch),
  );

  // Reuse an existing worktree for this branch or path.
  const existing = await listWorktrees(top);
  const byPath = existing.find(
    (w) => resolve(w.path) === worktreePath,
  );
  if (byPath) {
    if (byPath.branch && byPath.branch !== branch) {
      return {
        ok: false,
        error: `Path already used by worktree on branch "${byPath.branch}": ${worktreePath}`,
      };
    }
    const linked = linkSharedPaths(
      top,
      worktreePath,
      opts.symlinkPaths ?? [...DEFAULT_WORKTREE_SYMLINK_PATHS],
    );
    return {
      ok: true,
      path: worktreePath,
      branch: byPath.branch ?? branch,
      created: false,
      linked,
      mainCwd: top,
    };
  }

  const byBranch = existing.find((w) => w.branch === branch);
  if (byBranch) {
    const linked = linkSharedPaths(
      top,
      byBranch.path,
      opts.symlinkPaths ?? [...DEFAULT_WORKTREE_SYMLINK_PATHS],
    );
    return {
      ok: true,
      path: byBranch.path,
      branch,
      created: false,
      linked,
      mainCwd: top,
    };
  }

  if (existsSync(worktreePath)) {
    return {
      ok: false,
      error: `Worktree path already exists (not a registered worktree): ${worktreePath}`,
    };
  }

  mkdirSync(dirname(worktreePath), { recursive: true });

  const branchExists = await localBranchExists(top, branch);
  const createBranch = opts.createBranch !== false;

  let args: string[];
  if (branchExists) {
    args = ["worktree", "add", worktreePath, branch];
  } else if (createBranch) {
    args = ["worktree", "add", "-b", branch, worktreePath];
  } else {
    return {
      ok: false,
      error: `Branch "${branch}" does not exist. Enable create-branch or pick an existing branch.`,
    };
  }

  const { exitCode, stderr } = await runGit(top, args);
  if (exitCode !== 0) {
    const detail = stderr.trim() || `git worktree add failed (${exitCode})`;
    return { ok: false, error: detail };
  }

  const linked = linkSharedPaths(
    top,
    worktreePath,
    opts.symlinkPaths ?? [...DEFAULT_WORKTREE_SYMLINK_PATHS],
  );

  return {
    ok: true,
    path: worktreePath,
    branch,
    created: true,
    linked,
    mainCwd: top,
  };
}
