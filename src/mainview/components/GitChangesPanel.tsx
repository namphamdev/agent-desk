import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FileDiff,
  GitBranch,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { GitFileChange } from "../../shared/rpc";
import { getRpc } from "../rpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  cwd: string | null;
  agentId?: string | null;
  onClose: () => void;
};

type StatusState = {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  isRepo: boolean;
};

function kindLabel(kind: GitFileChange["kind"]): string {
  switch (kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "conflict":
      return "!";
    case "typechange":
      return "T";
    default:
      return "?";
  }
}

function kindClass(kind: GitFileChange["kind"]): string {
  switch (kind) {
    case "added":
    case "untracked":
      return "text-emerald-400";
    case "deleted":
      return "text-red-400";
    case "conflict":
      return "text-amber-400";
    case "renamed":
    case "copied":
      return "text-sky-400";
    default:
      return "text-muted-foreground";
  }
}

function fileKey(f: GitFileChange): string {
  return f.path;
}

export function GitChangesPanel({ open, cwd, agentId, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewStaged, setPreviewStaged] = useState(false);
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      setError("Open a project to review git changes.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getRpc().request.getGitStatus({ cwd });
      if (!res.ok) {
        setError(res.error);
        setStatus(null);
        return;
      }
      setStatus({
        branch: res.branch,
        ahead: res.ahead,
        behind: res.behind,
        files: res.files,
        isRepo: res.isRepo,
      });
      // Drop selections that no longer exist.
      setSelected((prev) => {
        const paths = new Set(res.files.map(fileKey));
        const next = new Set<string>();
        for (const p of prev) if (paths.has(p)) next.add(p);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    setInfo(null);
    void refresh();
  }, [open, refresh]);

  const loadDiff = useCallback(
    async (path: string, staged: boolean) => {
      if (!cwd) return;
      setPreviewPath(path);
      setPreviewStaged(staged);
      setDiffLoading(true);
      setDiff("");
      try {
        const res = await getRpc().request.getGitDiff({ cwd, path, staged });
        if (res.ok) setDiff(res.diff);
        else setDiff(`Error: ${res.error}`);
      } catch (err) {
        setDiff(err instanceof Error ? err.message : String(err));
      } finally {
        setDiffLoading(false);
      }
    },
    [cwd],
  );

  const stagedFiles = useMemo(
    () => status?.files.filter((f) => f.staged) ?? [],
    [status],
  );
  const unstagedFiles = useMemo(
    () => status?.files.filter((f) => f.unstaged) ?? [],
    [status],
  );

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectAll = (files: GitFileChange[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of files) next.add(fileKey(f));
      return next;
    });
  };

  const clearSelection = (files: GitFileChange[]) => {
    const drop = new Set(files.map(fileKey));
    setSelected((prev) => {
      const next = new Set<string>();
      for (const p of prev) if (!drop.has(p)) next.add(p);
      return next;
    });
  };

  const sectionAllSelected = (files: GitFileChange[]) =>
    files.length > 0 && files.every((f) => selected.has(fileKey(f)));

  const runStage = async (paths: string[], stage: boolean) => {
    if (!cwd || paths.length === 0) return;
    setBusy(stage ? "stage" : "unstage");
    setError(null);
    setInfo(null);
    try {
      const res = stage
        ? await getRpc().request.stageGitFiles({ cwd, paths })
        : await getRpc().request.unstageGitFiles({ cwd, paths });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSelected((prev) => {
        const drop = new Set(paths);
        const next = new Set<string>();
        for (const p of prev) if (!drop.has(p)) next.add(p);
        return next;
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const selectedList = useMemo(() => [...selected], [selected]);
  const unstagedPaths = useMemo(
    () => unstagedFiles.map(fileKey),
    [unstagedFiles],
  );
  const stagedPaths = useMemo(() => stagedFiles.map(fileKey), [stagedFiles]);

  const handleFetch = async () => {
    if (!cwd) return;
    setBusy("fetch");
    setError(null);
    setInfo(null);
    try {
      const res = await getRpc().request.fetchGit({ cwd });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setInfo(res.summary);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handlePush = async () => {
    if (!cwd) return;
    setBusy("push");
    setError(null);
    setInfo(null);
    try {
      const res = await getRpc().request.pushGit({ cwd });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setInfo(res.summary);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleGenerate = async () => {
    if (!cwd) return;
    setBusy("generate");
    setError(null);
    setInfo(null);
    try {
      const res = await getRpc().request.generateGitCommitMessage({
        cwd,
        agentId: agentId ?? undefined,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSubject(res.subject);
      setBody(res.body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleCommit = async () => {
    if (!cwd) return;
    const subj = subject.trim();
    if (!subj) {
      setError("Enter a commit subject.");
      return;
    }
    setBusy("commit");
    setError(null);
    setInfo(null);
    try {
      // If nothing staged but selection exists, stage selection first.
      if (stagedFiles.length === 0 && selectedList.length > 0) {
        const st = await getRpc().request.stageGitFiles({
          cwd,
          paths: selectedList,
        });
        if (!st.ok) {
          setError(st.error);
          return;
        }
      } else if (stagedFiles.length === 0 && unstagedFiles.length > 0) {
        // Stage everything when user commits with no staged files.
        const paths = unstagedFiles.map(fileKey);
        const st = await getRpc().request.stageGitFiles({ cwd, paths });
        if (!st.ok) {
          setError(st.error);
          return;
        }
      }

      const res = await getRpc().request.commitGit({
        cwd,
        subject: subj,
        body: body.trim() || undefined,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSubject("");
      setBody("");
      setSelected(new Set());
      setPreviewPath(null);
      setDiff("");
      setInfo(res.hash ? `Committed ${res.hash}` : "Committed.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const renderFileRow = (f: GitFileChange, section: "staged" | "unstaged") => {
    const key = fileKey(f);
    const isPreview = previewPath === key && previewStaged === (section === "staged");
    return (
      <div
        key={`${section}-${key}`}
        className={cn(
          "group flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/60",
          isPreview && "bg-muted",
        )}
      >
        <Checkbox
          checked={selected.has(key)}
          onCheckedChange={() => toggleSelect(key)}
          aria-label={`Select ${key}`}
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => void loadDiff(key, section === "staged")}
        >
          <span
            className={cn(
              "w-3 shrink-0 font-mono text-[10px] font-semibold",
              kindClass(f.kind),
            )}
            title={f.kind}
          >
            {kindLabel(f.kind)}
          </span>
          <span className="min-w-0 truncate font-mono text-foreground/90" title={key}>
            {key}
          </span>
        </button>
      </div>
    );
  };

  const remoteBusy = busy === "fetch" || busy === "push";
  const canRemote = Boolean(cwd && status?.isRepo && busy == null);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
        showCloseButton
      >
        <SheetHeader className="border-b border-border px-4 py-3 pr-12 text-left">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <FileDiff className="size-4 shrink-0" aria-hidden />
            Git changes
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            {status?.branch ? (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3" aria-hidden />
                {status.branch}
              </span>
            ) : (
              <span>{cwd ? "…" : "No project"}</span>
            )}
            {status && status.ahead > 0 && (
              <span className="text-muted-foreground">↑{status.ahead}</span>
            )}
            {status && status.behind > 0 && (
              <span className="text-muted-foreground">↓{status.behind}</span>
            )}
            {cwd && (
              <span className="truncate text-muted-foreground" title={cwd}>
                {cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop()}
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void refresh()}
            disabled={loading || !cwd}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!canRemote}
            onClick={() => void handleFetch()}
            title="git fetch --prune"
          >
            {busy === "fetch" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <ArrowDownToLine className="size-3.5" aria-hidden />
            )}
            Fetch
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!canRemote}
            onClick={() => void handlePush()}
            title={
              status && status.ahead > 0
                ? `git push (${status.ahead} ahead)`
                : "git push (sets upstream on first push)"
            }
          >
            {busy === "push" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <ArrowUpFromLine className="size-3.5" aria-hidden />
            )}
            Push
            {status && status.ahead > 0 ? (
              <span className="tabular-nums text-muted-foreground">
                {status.ahead}
              </span>
            ) : null}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!cwd || unstagedFiles.length === 0 || busy != null}
            onClick={() => {
              selectAll(unstagedFiles);
              void runStage(unstagedPaths, true);
            }}
            title="Select and stage every unstaged change"
          >
            Stage all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!cwd || selectedList.length === 0 || busy != null}
            onClick={() => void runStage(selectedList, true)}
          >
            Stage
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!cwd || selectedList.length === 0 || busy != null}
            onClick={() => void runStage(selectedList, false)}
          >
            Unstage
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!cwd || stagedFiles.length === 0 || busy != null}
            onClick={() => void runStage(stagedPaths, false)}
            title="Unstage every staged change"
          >
            Unstage all
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={
              !cwd ||
              busy != null ||
              !status?.isRepo ||
              (status?.files.length ?? 0) === 0
            }
            onClick={() => void handleGenerate()}
            title="Generate commit message with ACP agent"
          >
            {busy === "generate" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-3.5" aria-hidden />
            )}
            AI message
          </Button>
        </div>

        {error && (
          <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            {error}
          </div>
        )}
        {info && !error && (
          <div className="mx-3 mt-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {info}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {!status?.isRepo && !loading && cwd && (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Not a git repository.
              </p>
            )}
            {status?.isRepo && status.files.length === 0 && !loading && (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Working tree clean.
              </p>
            )}

            {stagedFiles.length > 0 && (
              <section className="mb-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Staged ({stagedFiles.length})
                  </h3>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        sectionAllSelected(stagedFiles)
                          ? clearSelection(stagedFiles)
                          : selectAll(stagedFiles)
                      }
                    >
                      {sectionAllSelected(stagedFiles)
                        ? "Deselect all"
                        : "Select all"}
                    </button>
                    <button
                      type="button"
                      className="text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                      disabled={busy != null}
                      onClick={() => void runStage(stagedPaths, false)}
                    >
                      Unstage all
                    </button>
                  </div>
                </div>
                <div className="space-y-0.5">
                  {stagedFiles.map((f) => renderFileRow(f, "staged"))}
                </div>
              </section>
            )}

            {unstagedFiles.length > 0 && (
              <section className="mb-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Changes ({unstagedFiles.length})
                  </h3>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        sectionAllSelected(unstagedFiles)
                          ? clearSelection(unstagedFiles)
                          : selectAll(unstagedFiles)
                      }
                    >
                      {sectionAllSelected(unstagedFiles)
                        ? "Deselect all"
                        : "Select all"}
                    </button>
                    <button
                      type="button"
                      className="text-[10px] font-medium text-emerald-500/90 hover:text-emerald-400 disabled:opacity-50"
                      disabled={busy != null}
                      onClick={() => void runStage(unstagedPaths, true)}
                    >
                      Stage all
                    </button>
                  </div>
                </div>
                <div className="space-y-0.5">
                  {unstagedFiles.map((f) => renderFileRow(f, "unstaged"))}
                </div>
              </section>
            )}

            {(previewPath || diffLoading) && (
              <section className="mt-2 rounded-md border border-border bg-muted/30">
                <div className="border-b border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  {previewStaged ? "staged · " : ""}
                  {previewPath}
                  {diffLoading ? " …" : ""}
                </div>
                <pre className="max-h-48 overflow-auto p-2 text-[10px] leading-relaxed">
                  <code className="font-mono whitespace-pre">
                    {diff.split("\n").map((line, i) => {
                      let cls = "text-muted-foreground";
                      if (line.startsWith("+") && !line.startsWith("+++"))
                        cls = "text-emerald-400";
                      else if (line.startsWith("-") && !line.startsWith("---"))
                        cls = "text-red-400";
                      else if (line.startsWith("@@")) cls = "text-sky-400";
                      return (
                        <div key={i} className={cls}>
                          {line || " "}
                        </div>
                      );
                    })}
                  </code>
                </pre>
              </section>
            )}
          </div>

          <div className="shrink-0 space-y-2 border-t border-border p-3">
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Commit subject"
              className="h-8 text-xs"
              disabled={!cwd || busy === "commit"}
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Description (optional)"
              className="min-h-[72px] resize-y text-xs"
              disabled={!cwd || busy === "commit"}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="min-w-0 flex-1"
                disabled={!cwd || !subject.trim() || busy != null}
                onClick={() => void handleCommit()}
              >
                {busy === "commit" ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    Committing…
                  </>
                ) : (
                  "Commit"
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={!canRemote || remoteBusy}
                onClick={() => void handlePush()}
                title="Push current branch"
              >
                {busy === "push" ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <ArrowUpFromLine className="size-3.5" aria-hidden />
                )}
                Push
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
