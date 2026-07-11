import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAugmentedPath,
  commonUserBinDirs,
  resolveExecutable,
} from "./path-env";

describe("path-env", () => {
  it("lists expected user bin dirs for the platform", () => {
    const home = process.platform === "win32" ? "C:\\Users\\test" : "/Users/test";
    const dirs = commonUserBinDirs(home);
    expect(dirs).toContain(join(home, ".bun", "bin"));
    expect(dirs).toContain(join(home, ".local", "bin"));
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
    if (process.platform === "win32") {
      // Windows extras use APPDATA/LOCALAPPDATA when set (CI runners do)
      const appData =
        process.env.APPDATA ?? join(home, "AppData", "Roaming");
      const localAppData =
        process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      expect(dirs).toContain(join(appData, "npm"));
      expect(dirs).toContain(join(localAppData, "pnpm"));
    }
  });

  it("buildAugmentedPath appends existing dirs not already on PATH", () => {
    const scratch = join(tmpdir(), `tr-path-${Date.now()}`);
    const bin = join(scratch, ".bun", "bin");
    mkdirSync(bin, { recursive: true });
    try {
      const basePath =
        process.platform === "win32"
          ? ["C:\\Windows\\System32", "C:\\Windows"].join(delimiter)
          : "/usr/bin:/bin";
      const result = buildAugmentedPath(basePath, scratch);
      const parts = result.split(delimiter);
      for (const part of basePath.split(delimiter)) {
        expect(parts).toContain(part);
      }
      expect(parts).toContain(bin);
      expect(parts.indexOf(bin)).toBeGreaterThan(-1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not duplicate PATH entries", () => {
    const brew = "/opt/homebrew/bin";
    const withBrew = buildAugmentedPath([brew, "/usr/bin"].join(delimiter));
    const matches = withBrew.split(delimiter).filter((p) => p === brew);
    expect(matches.length).toBe(1);
  });

  it("resolveExecutable finds a file on PATH", () => {
    const scratch = join(tmpdir(), `tr-resolve-${Date.now()}`);
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    const name =
      process.platform === "win32" ? "fake-agent.cmd" : "fake-agent";
    const exe = join(bin, name);
    writeFileSync(
      exe,
      process.platform === "win32" ? "@echo off\necho ok\n" : "#!/bin/sh\necho ok\n",
    );
    if (process.platform !== "win32") {
      chmodSync(exe, 0o755);
    }
    try {
      // Resolve by bare command name (Windows still finds .cmd via WIN_EXTS)
      const command = "fake-agent";
      const pathEnv = [bin, process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin"].join(
        delimiter,
      );
      const found = resolveExecutable(command, pathEnv);
      expect(found).toBe(exe);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("resolveExecutable returns absolute paths when they exist", () => {
    // /bin/sh exists on macOS/Linux test hosts
    if (process.platform === "win32") return;
    expect(resolveExecutable("/bin/sh")).toBe("/bin/sh");
  });

  it("resolveExecutable returns null for missing bare commands", () => {
    expect(
      resolveExecutable("definitely-not-a-real-binary-xyz", "/usr/bin"),
    ).toBeNull();
  });
});
