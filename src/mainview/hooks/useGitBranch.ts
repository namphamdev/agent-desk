import { useEffect, useState } from "react";
import { getRpc } from "../rpc";

/** Resolve the real git branch for a project folder via RPC. */
export function useGitBranch(cwd: string | undefined): string | null {
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) {
      setGitBranch(null);
      return;
    }
    let cancelled = false;
    void getRpc()
      .request.getGitBranch({ cwd })
      .then((r) => {
        if (!cancelled) setGitBranch(r.branch);
      })
      .catch(() => {
        if (!cancelled) setGitBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return gitBranch;
}
