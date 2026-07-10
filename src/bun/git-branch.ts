/**
 * Resolve the current git branch for a working directory.
 * Walks up from `cwd` via `git rev-parse` so nested folders work.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  const dir = cwd?.trim();
  if (!dir) return null;

  try {
    const proc = Bun.spawn(
      ["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const branch = stdout.trim();
    // Detached HEAD reports "HEAD" — still useful as a signal.
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}
