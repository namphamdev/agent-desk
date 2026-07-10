import { rawTextFromContent } from "./content-text";
import type {
  TimelineEntry,
  ToolCall,
  ToolCallContentItem,
  ToolKind,
} from "./types";

/** ACP kinds that typically mutate the workspace. */
const MUTATING_KINDS = new Set<ToolKind>(["edit", "delete", "move"]);

/**
 * Titles used by Claude Code / common agents when kind is missing or "other".
 * ACP often labels Write/Edit as kind "other" without a structured diff.
 */
const WRITE_TITLE_RE =
  /^(Write|Edit|Create|Update|Delete|Remove|Move|Rename|Apply[_\s-]?Patch|StrReplace|MultiEdit|NotebookEdit)\b/i;

/** Shell commands that usually mutate files (when kind is execute). */
const EXEC_MUTATE_RE =
  /\b(rm|rmdir|mv|cp|install|tee|truncate|chmod|chown|touch|mkdir|ln|sed\s+-i|perl\s+-i|git\s+(apply|checkout|restore|rm|mv|add|commit|reset|rebase|merge|cherry-pick|stash)|npm\s+i(?:nstall)?|pnpm\s+i(?:nstall)?|yarn\s+add|bun\s+add|pip\s+install|cargo\s+add)\b/i;

export type FileChangeKind = "edit" | "delete" | "move" | "other";

export type FileChange = {
  path: string;
  kind: FileChangeKind;
  /** Truncated unified-ish diff text when available. */
  diff?: string;
  /** Extra notes (e.g. shell command that mutated the path). */
  note?: string;
  toolTitle?: string;
  status?: string;
};

export type SessionChangeSummary = {
  /** Full markdown summary for seeding a review session. */
  text: string;
  /**
   * True when the session has file mutations (edit/delete/move, diffs,
   * write-like tools, or mutating shell commands).
   */
  hasChanges: boolean;
  /**
   * True when there is anything useful to review in a new session
   * (user goals, tools, or agent replies) — not only structured file edits.
   */
  hasReviewableContent: boolean;
  fileCount: number;
  files: FileChange[];
  userGoals: string[];
};

export type SummarizeSessionOptions = {
  sessionTitle?: string;
  project?: string;
  /** Max lines included per file diff (default 80). */
  maxDiffLines?: number;
  /** Max total characters for the markdown body (default 14000). */
  maxChars?: number;
  /** Max user goals to include (default 8). */
  maxGoals?: number;
  /** Max agent note snippets (default 3). */
  maxAgentNotes?: number;
};

const DEFAULT_MAX_DIFF_LINES = 80;
const DEFAULT_MAX_CHARS = 14_000;
const DEFAULT_MAX_GOALS = 8;
const DEFAULT_MAX_AGENT_NOTES = 3;

/**
 * Default first user prompt for a review session. This is the primary
 * requirement the new-session agent should satisfy.
 */
export const DEFAULT_REVIEW_PROMPT = [
  "Review the work from the previous session (summarized in the starting context).",
  "",
  "Focus on:",
  "1. Correctness — logic bugs, edge cases, broken contracts",
  "2. Security — injection, secrets, unsafe paths or permissions",
  "3. Regressions — unintended side effects on existing behavior",
  "4. Tests — missing or weak coverage for the changes",
  "5. Code quality — clarity, maintainability, unnecessary complexity",
  "",
  "For each finding report: severity (blocker / major / minor / nit), file location, what's wrong, and a concrete fix suggestion. End with an overall assessment.",
  "If the summary has no structured file diffs, inspect the project (and git status/diff if available) against the user goals and tool activity listed above.",
].join("\n");

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines);
  const omitted = lines.length - maxLines;
  return `${kept.join("\n")}\n… (${omitted} more lines truncated)`;
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n\n… (summary truncated)`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringField(
  obj: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function pathFromRawInput(tc: ToolCall): string | null {
  const input = asRecord(tc.rawInput);
  return stringField(
    input,
    "path",
    "file_path",
    "filePath",
    "target",
    "dest",
    "to",
  );
}

function pathFromToolCall(tc: ToolCall): string | null {
  for (const item of tc.content) {
    if (item.type === "diff" && item.path) return item.path;
  }
  const loc = tc.locations?.[0]?.path;
  if (loc) return loc;
  const fromInput = pathFromRawInput(tc);
  if (fromInput) return fromInput;

  // Heuristic: titles like "Edit foo.ts", "Write src/a.ts", "rm ./ui.html"
  const m = tc.title.match(
    /(?:^|\s)((?:\/|\.\/)?[\w.@+-]+(?:\/[\w.@+-]+)*(?:\.\w+)?)\s*$/,
  );
  return m?.[1] ?? null;
}

function contentSnippetFromRawInput(
  tc: ToolCall,
  maxDiffLines: number,
): string | undefined {
  const input = asRecord(tc.rawInput);
  if (!input) return undefined;
  const content = stringField(
    input,
    "content",
    "contents",
    "new_string",
    "newString",
    "new_text",
    "newText",
  );
  const old = stringField(input, "old_string", "oldString", "old_text", "oldText");
  if (old && content) {
    return [
      "--- before",
      truncateLines(old, Math.floor(maxDiffLines / 2)),
      "+++ after",
      truncateLines(content, Math.floor(maxDiffLines / 2)),
    ].join("\n");
  }
  if (content) return truncateLines(content, maxDiffLines);
  return undefined;
}

function kindFromToolCall(tc: ToolCall): FileChangeKind {
  if (tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move") {
    return tc.kind;
  }
  if (tc.content.some((c) => c.type === "diff")) return "edit";
  const title = tc.title;
  if (/^(Delete|Remove|rm\b)/i.test(title)) return "delete";
  if (/^(Move|Rename|mv\b)/i.test(title)) return "move";
  if (WRITE_TITLE_RE.test(title)) return "edit";
  if (tc.kind === "execute" && EXEC_MUTATE_RE.test(title)) {
    if (/\brm\b|\brmdir\b|git\s+rm\b/i.test(title)) return "delete";
    if (/\bmv\b|git\s+mv\b/i.test(title)) return "move";
    return "edit";
  }
  const input = asRecord(tc.rawInput);
  if (input && stringField(input, "content", "contents", "new_string", "newString")) {
    return "edit";
  }
  return "other";
}

function formatDiffItem(
  item: Extract<ToolCallContentItem, { type: "diff" }>,
  maxDiffLines: number,
): string {
  const oldText = item.oldText ?? "";
  const newText = item.newText ?? "";
  let body: string;
  if (oldText && newText) {
    body = [
      "--- before",
      truncateLines(oldText, Math.floor(maxDiffLines / 2)),
      "+++ after",
      truncateLines(newText, Math.floor(maxDiffLines / 2)),
    ].join("\n");
  } else if (newText) {
    body = truncateLines(newText, maxDiffLines);
  } else if (oldText) {
    body = truncateLines(oldText, maxDiffLines);
  } else {
    body = "(empty diff)";
  }
  return body;
}

/** True when this tool call likely mutated files (including Claude ACP quirks). */
export function isMutatingToolCall(tc: ToolCall): boolean {
  if (tc.kind && MUTATING_KINDS.has(tc.kind)) return true;
  if (tc.content.some((c) => c.type === "diff")) return true;
  if (WRITE_TITLE_RE.test(tc.title)) return true;

  const input = asRecord(tc.rawInput);
  if (input) {
    const hasPath = Boolean(
      stringField(input, "path", "file_path", "filePath", "target"),
    );
    const hasWriteBody = Boolean(
      stringField(
        input,
        "content",
        "contents",
        "new_string",
        "newString",
        "old_string",
        "oldString",
      ),
    );
    // Write/Edit-style tools often send file_path + content without kind=edit.
    if (hasPath && hasWriteBody) return true;
  }

  if (tc.kind === "execute" && EXEC_MUTATE_RE.test(tc.title)) return true;
  // Some adapters leave execute commands as kind "other".
  if ((!tc.kind || tc.kind === "other") && EXEC_MUTATE_RE.test(tc.title)) {
    return true;
  }
  return false;
}

function upsertFileChange(
  fileMap: Map<string, FileChange>,
  next: FileChange,
): void {
  const existing = fileMap.get(next.path);
  if (!existing) {
    fileMap.set(next.path, next);
    return;
  }
  fileMap.set(next.path, {
    path: next.path,
    kind: existing.kind === "delete" || next.kind === "delete" ? "delete" : next.kind,
    toolTitle: next.toolTitle ?? existing.toolTitle,
    status: next.status ?? existing.status,
    note: [existing.note, next.note].filter(Boolean).join("\n") || undefined,
    diff: next.diff
      ? existing.diff
        ? `${existing.diff}\n\n${next.diff}`
        : next.diff
      : existing.diff,
  });
}

/**
 * Build a structured, markdown change summary from a session timeline.
 * Pure — safe to call from the webview without Bun.
 */
export function summarizeSessionChanges(
  timeline: TimelineEntry[],
  opts: SummarizeSessionOptions = {},
): SessionChangeSummary {
  const maxDiffLines = opts.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxGoals = opts.maxGoals ?? DEFAULT_MAX_GOALS;
  const maxAgentNotes = opts.maxAgentNotes ?? DEFAULT_MAX_AGENT_NOTES;

  const userGoals: string[] = [];
  const agentNotes: string[] = [];
  const fileMap = new Map<string, FileChange>();
  const otherTools: string[] = [];
  let toolCount = 0;

  for (const entry of timeline) {
    if (entry.type === "message" && entry.role === "user") {
      const text = rawTextFromContent(entry.content).trim();
      if (text && userGoals.length < maxGoals) {
        const oneLine = text.replace(/\s+/g, " ");
        userGoals.push(
          oneLine.length > 240 ? `${oneLine.slice(0, 239)}…` : oneLine,
        );
      }
      continue;
    }

    if (entry.type === "message" && entry.role === "agent") {
      const text = rawTextFromContent(entry.content).trim();
      if (text && agentNotes.length < maxAgentNotes) {
        const oneLine = text.replace(/\s+/g, " ");
        agentNotes.push(
          oneLine.length > 320 ? `${oneLine.slice(0, 319)}…` : oneLine,
        );
      }
      continue;
    }

    if (entry.type !== "tool_call") continue;
    toolCount += 1;
    const tc = entry.toolCall;

    if (isMutatingToolCall(tc)) {
      const path = pathFromToolCall(tc) ?? `(tool) ${tc.title.slice(0, 80)}`;
      const kind = kindFromToolCall(tc);
      const diffs = tc.content.filter(
        (c): c is Extract<ToolCallContentItem, { type: "diff" }> =>
          c.type === "diff",
      );
      let diff: string | undefined;
      if (diffs.length > 0) {
        diff = truncateLines(
          diffs.map((d) => formatDiffItem(d, maxDiffLines)).join("\n\n"),
          maxDiffLines * 2,
        );
      } else {
        diff = contentSnippetFromRawInput(tc, maxDiffLines);
      }
      const note =
        tc.kind === "execute" || EXEC_MUTATE_RE.test(tc.title)
          ? `Shell: ${tc.title}`
          : undefined;
      upsertFileChange(fileMap, {
        path,
        kind,
        toolTitle: tc.title,
        status: tc.status,
        diff,
        note,
      });
    } else {
      // Reads, searches, MCP tools, non-mutating executes — keep a short log.
      if (
        tc.kind === "execute" ||
        tc.kind === "other" ||
        tc.kind === "search" ||
        tc.kind === "fetch" ||
        !tc.kind
      ) {
        const status = tc.status === "failed" ? " (failed)" : "";
        otherTools.push(`- ${tc.title}${status}`);
      }
    }
  }

  const files = [...fileMap.values()];
  const hasChanges = files.length > 0;
  const hasReviewableContent =
    hasChanges ||
    userGoals.length > 0 ||
    toolCount > 0 ||
    agentNotes.length > 0;

  const sections: string[] = [];
  sections.push("# Session work summary");
  if (opts.sessionTitle) {
    sections.push(`**Session:** ${opts.sessionTitle}`);
  }
  if (opts.project) {
    sections.push(`**Project:** ${opts.project}`);
  }
  sections.push("");

  if (userGoals.length > 0) {
    sections.push("## User goals");
    for (const g of userGoals) sections.push(`- ${g}`);
    sections.push("");
  }

  if (files.length > 0) {
    sections.push(`## Files changed (${files.length})`);
    for (const f of files) {
      sections.push(`### \`${f.path}\` (${f.kind})`);
      if (f.toolTitle) sections.push(`_Tool:_ ${f.toolTitle}`);
      if (f.note) sections.push(`_${f.note}_`);
      if (f.diff) {
        sections.push("```");
        sections.push(truncateLines(f.diff, maxDiffLines * 2));
        sections.push("```");
      } else {
        sections.push(
          "_No diff content captured in the session (inspect the file / git diff)._",
        );
      }
      sections.push("");
    }
  } else {
    sections.push("## Files changed");
    sections.push(
      "_No structured file edits were recorded. If the agent used shell commands or tools without diffs, use git status/diff and the activity below._",
    );
    sections.push("");
  }

  if (otherTools.length > 0) {
    sections.push("## Other tool activity");
    const shown = otherTools.slice(0, 30);
    sections.push(...shown);
    if (otherTools.length > 30) {
      sections.push(`- … and ${otherTools.length - 30} more`);
    }
    sections.push("");
  }

  if (agentNotes.length > 0) {
    sections.push("## Agent notes (excerpts)");
    for (const n of agentNotes) sections.push(`- ${n}`);
    sections.push("");
  }

  const text = truncateChars(sections.join("\n").trim(), maxChars);

  return {
    text,
    hasChanges,
    hasReviewableContent,
    fileCount: files.length,
    files,
    userGoals,
  };
}

/** Short title for a review session forked from a source chat. */
export function reviewSessionTitle(sourceTitle?: string, max = 56): string {
  const base = (sourceTitle || "session").replace(/\s+/g, " ").trim();
  const prefix = "Review: ";
  const budget = max - prefix.length;
  if (base.length <= budget) return `${prefix}${base}`;
  return `${prefix}${base.slice(0, Math.max(1, budget - 1))}…`;
}
