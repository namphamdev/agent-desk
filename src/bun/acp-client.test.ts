import { describe, expect, it } from "vitest";
import { spawn } from "bun";
import { collectDescendantPids, sampleProcessTreeRssBytes } from "./acp-client";

describe("process-tree memory sampling", () => {
  // Spawn a long-lived child so the sampler has a live tree to walk.
  // `bun -e` keeps a process alive on both POSIX and Windows.
  it("walks a live process tree and sums RSS without throwing", async () => {
    const child = spawn({
      // Sleep 20s — long enough to sample, short enough to clean up.
      cmd: ["bun", "-e", "setTimeout(()=>{},20000)"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const pid = child.pid;
      if (pid == null) return; // spawn failed; skip rather than fail spuriously

      const pids = await collectDescendantPids(pid, 64);
      expect(pids.length).toBeGreaterThan(0);
      expect(pids).toContain(pid);

      const bytes = await sampleProcessTreeRssBytes(pid);
      // A live Bun process should report some resident memory.
      expect(bytes).toBeGreaterThan(0);
    } finally {
      try {
        child.kill();
        await child.exited;
      } catch {
        /* already exited */
      }
    }
  }, 15_000);
});
