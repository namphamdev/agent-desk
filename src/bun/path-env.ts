/**
 * GUI-launched desktop apps (Finder, Dock, DMG, Explorer) inherit a stripped PATH
 * and miss Homebrew / npm / bun / Node install dirs.
 * Agent commands like `claude-agent-acp` live there — and npm `.cmd` shims need
 * `node` on PATH — so we augment PATH before spawn.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, isAbsolute } from "node:path";

/** User / package-manager bin dirs commonly missing from GUI app PATH. */
export function commonUserBinDirs(home = homedir()): string[] {
  const dirs = [
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".npm", "bin"),
    join(home, "Library", "pnpm"),
    // Grok Build (xAI) installs here: `irm https://x.ai/cli/install.ps1 | iex`
    join(home, ".grok", "bin"),
    // Homebrew
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles =
      process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

    dirs.push(
      // npm global bins (claude-agent-acp.cmd etc.)
      join(appData, "npm"),
      join(localAppData, "pnpm"),
      join(home, ".bun", "bin"),
      join(home, ".grok", "bin"),
      join(home, ".npm", "bin"),
      // Official Node.js installer — required by npm .cmd shims (`"%_prog%" node …`)
      join(programFiles, "nodejs"),
      join(programFilesX86, "nodejs"),
      // Volta / fnm / nvm-windows style user installs
      join(home, ".volta", "bin"),
      join(localAppData, "fnm_multishells"),
      join(appData, "nvm"),
      join(localAppData, "Programs", "node"),
    );
  }

  return dirs;
}

/**
 * Merge common bin dirs into PATH (existing entries first, then missing dirs
 * that actually exist on disk).
 */
export function buildAugmentedPath(
  existing = process.env.PATH ?? "",
  home = homedir(),
): string {
  const parts = existing.split(delimiter).filter(Boolean);
  const seen = new Set(
    process.platform === "win32"
      ? parts.map((p) => p.toLowerCase())
      : parts,
  );
  for (const dir of commonUserBinDirs(home)) {
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    if (!existsSync(dir)) continue;
    parts.push(dir);
    seen.add(key);
  }
  return parts.join(delimiter);
}

/** Mutate `process.env.PATH` once so all Bun.spawn / child processes inherit it. */
export function ensureAugmentedPath(): void {
  process.env.PATH = buildAugmentedPath(process.env.PATH);
}

const WIN_EXTS = [".cmd", ".exe", ".bat", ".ps1", ""];

/**
 * Resolve a bare command name against an augmented PATH.
 * Returns the absolute path, or null if not found.
 */
export function resolveExecutable(
  command: string,
  pathEnv = buildAugmentedPath(),
): string | null {
  if (!command) return null;

  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    if (existsSync(command)) return command;
    if (process.platform === "win32") {
      for (const ext of WIN_EXTS) {
        const withExt = command + ext;
        if (ext && existsSync(withExt)) return withExt;
      }
    }
    return null;
  }

  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const base = join(dir, command);
    if (process.platform === "win32") {
      for (const ext of WIN_EXTS) {
        const candidate = ext ? base + ext : base;
        if (existsSync(candidate)) return candidate;
      }
    } else if (existsSync(base)) {
      return base;
    }
  }
  return null;
}
