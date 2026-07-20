/**
 * Cross-platform helpers for stopping spawned shells and freeing TCP ports.
 *
 * On Windows, `proc.kill()` only ends the direct child (often `cmd.exe`),
 * leaving grandchildren such as `vite` bound to the port. Use taskkill /T.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Default Vite HMR / `dev:web` port (must match package.json + vite.config). */
export const DEV_WEB_PORT = 5173;

function winSystem32(binary: string): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return join(root, "System32", binary);
}

/** Kill `pid` and its entire process tree. No-op for invalid/self pids. */
export function killProcessTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;

  try {
    if (process.platform === "win32") {
      execFileSync(winSystem32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    try {
      // Prefer process-group kill when the child was started in its own group.
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* already dead or no permission */
  }
}

/** Parse OwningProcess / lsof pid lines into unique positive ints. */
export function parseListeningPids(raw: string): number[] {
  const seen = new Set<number>();
  for (const token of raw.split(/[\s,;]+/)) {
    const n = Number.parseInt(token.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n === process.pid) continue;
    seen.add(n);
  }
  return [...seen];
}

/** PIDs currently listening on `port` (TCP LISTEN). */
export function listPidsListeningOnPort(port: number): number[] {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return [];

  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        winSystem32("WindowsPowerShell\\v1.0\\powershell.exe"),
        [
          "-NoProfile",
          "-Command",
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
        },
      );
      return parseListeningPids(out);
    }

    // lsof is the usual macOS/Linux path; fall back to fuser.
    try {
      const out = execFileSync("lsof", ["-ti", `TCP:${port}`, `-sTCP:LISTEN`], {
        encoding: "utf8",
        timeout: 10_000,
      });
      return parseListeningPids(out);
    } catch {
      const out = execFileSync("fuser", [`${port}/tcp`], {
        encoding: "utf8",
        timeout: 10_000,
      });
      return parseListeningPids(out);
    }
  } catch {
    return [];
  }
}

/**
 * Kill every process tree listening on `port`.
 * Used by `dev:web` / `dev:hmr` so a leftover Vite does not fail `strictPort`.
 */
export function freePort(port: number): { killed: number[] } {
  const pids = listPidsListeningOnPort(port);
  for (const pid of pids) {
    killProcessTree(pid);
  }
  return { killed: pids };
}
