/**
 * Electrobun's packaged CLI resolves rcedit via a baked CI path
 * (D:\a\electrobun\...), so build.win.icon never embeds on consumer machines.
 * This post-step re-embeds assets/icon.ico into launcher.exe, bun.exe, and
 * any Windows installer EXEs under build/artifacts.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.exit(0);
}

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconPath = join(projectRoot, "assets", "icon.ico");

if (!existsSync(iconPath)) {
  console.warn(`[embed-win-icon] icon not found: ${iconPath}`);
  process.exit(0);
}

function resolveRcedit() {
  const rceditPkgPath = require.resolve("rcedit/package.json");
  const rceditDir = dirname(rceditPkgPath);
  const rceditX64 = join(rceditDir, "bin", "rcedit-x64.exe");
  return existsSync(rceditX64)
    ? rceditX64
    : join(rceditDir, "bin", "rcedit.exe");
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip huge / irrelevant trees.
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
      out.push(full);
    }
  }
  return out;
}

const rceditExe = resolveRcedit();
if (!existsSync(rceditExe)) {
  console.warn(`[embed-win-icon] rcedit not found at ${rceditExe}`);
  process.exit(0);
}

const candidates = [
  ...walk(join(projectRoot, "build")),
  ...walk(join(projectRoot, "artifacts")),
].filter((p) => {
  const base = p.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  // Runtime process (taskbar/window), launcher shortcut entry, installer wrapper.
  // Match basename only — path segments like agent-desk must not match.
  return (
    base === "bun.exe" ||
    base === "launcher.exe" ||
    base.endsWith("-setup.exe") ||
    base.endsWith("setup.exe") ||
    /^agentdesk.*\.exe$/.test(base)
  );
});

// De-dupe and prefer unique paths
const unique = [...new Set(candidates)];
if (unique.length === 0) {
  console.warn("[embed-win-icon] no Windows EXEs found under build/ or artifacts/");
  process.exit(0);
}

let ok = 0;
for (const exe of unique) {
  try {
    const before = statSync(exe).size;
    execFileSync(rceditExe, [exe, "--set-icon", iconPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const after = statSync(exe).size;
    console.log(
      `[embed-win-icon] set icon: ${exe} (${before} → ${after} bytes)`,
    );
    ok++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[embed-win-icon] failed for ${exe}: ${message}`);
  }
}

if (ok === 0) {
  console.warn("[embed-win-icon] no icons were embedded");
  process.exit(1);
}
