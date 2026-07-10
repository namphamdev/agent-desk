import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAugmentedPath,
  commonUserBinDirs,
  resolveExecutable,
} from "./path-env";

describe("path-env", () => {
  it("lists expected user bin dirs for the platform", () => {
    const dirs = commonUserBinDirs("/Users/test");
    expect(dirs).toContain("/Users/test/.bun/bin");
    expect(dirs).toContain("/Users/test/.local/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
  });

  it("buildAugmentedPath appends existing dirs not already on PATH", () => {
    const scratch = join(tmpdir(), `tr-path-${Date.now()}`);
    const bin = join(scratch, ".bun", "bin");
    mkdirSync(bin, { recursive: true });
    try {
      const result = buildAugmentedPath("/usr/bin:/bin", scratch);
      const parts = result.split(":");
      expect(parts).toContain("/usr/bin");
      expect(parts).toContain("/bin");
      expect(parts).toContain(bin);
      // Non-existent homebrew path under this home should still include system
      // homebrew if present on the machine, or omit if not — only assert our bin.
      expect(parts.indexOf(bin)).toBeGreaterThan(-1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not duplicate PATH entries", () => {
    const withBrew = buildAugmentedPath("/opt/homebrew/bin:/usr/bin");
    const matches = withBrew
      .split(":")
      .filter((p) => p === "/opt/homebrew/bin");
    expect(matches.length).toBe(1);
  });

  it("resolveExecutable finds a file on PATH", () => {
    const scratch = join(tmpdir(), `tr-resolve-${Date.now()}`);
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "fake-agent");
    writeFileSync(exe, "#!/bin/sh\necho ok\n");
    chmodSync(exe, 0o755);
    try {
      const found = resolveExecutable("fake-agent", `${bin}:/usr/bin`);
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
