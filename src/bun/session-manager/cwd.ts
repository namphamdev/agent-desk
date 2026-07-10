import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve and validate a working directory path for a new session.
 */
export function resolveWorkingDirectory(
  rawCwd: string,
): { ok: true; cwd: string } | { ok: false; error: string } {
  let cwd: string;
  try {
    cwd = resolve(rawCwd);
  } catch {
    return { ok: false, error: `Invalid folder path: ${rawCwd}` };
  }
  if (!existsSync(cwd)) {
    return { ok: false, error: `Folder does not exist: ${cwd}` };
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      return { ok: false, error: `Not a folder: ${cwd}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
  return { ok: true, cwd };
}
