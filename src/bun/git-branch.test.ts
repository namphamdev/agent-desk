import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitBranch } from "./git-branch";

describe("getGitBranch", () => {
  it("returns null for empty cwd", async () => {
    expect(await getGitBranch("")).toBeNull();
    expect(await getGitBranch("   ")).toBeNull();
  });

  it("returns null for a non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tr-nogit-"));
    try {
      expect(await getGitBranch(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the current branch inside this repo", async () => {
    const branch = await getGitBranch(process.cwd());
    // This project is a git repo; branch should be a non-empty string.
    expect(branch).toBeTruthy();
    expect(typeof branch).toBe("string");
  });
});
