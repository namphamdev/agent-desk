// Transcript row model — TS port of TranscriptRows.swift (rows_for_entry).
// One row = one markdown top-level block / tool group / chip, never one
// message: streamed tokens re-render one row, and the lazy list only
// re-measures what changed.

import {
  IncrementalMarkdownParser,
  MDBlock,
  MarkdownParser,
  TopBlock,
} from '../markdown/MarkdownModel';
import { MD } from '../markdown/Metrics';
import { MessageEntry, RenderToolCall, toolStringField } from '../models/Entities';
import type { PendingSend } from '../sync/SessionStore';

export interface CompletedParse {
  source: string;
  blocks: TopBlock[];
}

export type RowKind =
  | { kind: 'user'; text: string }
  | { kind: 'markdown'; block: MDBlock; streaming: boolean }
  | { kind: 'toolGroup'; tools: ToolItem[]; autoOpen: boolean }
  | { kind: 'inputChip'; header: string; resolved: boolean }
  | { kind: 'errorChip'; message: string };

export interface ToolItem {
  call: RenderToolCall;
  isError: boolean;
  resolved: boolean;
}

export interface TranscriptRow {
  id: string;
  version: number;
  turnStart: boolean;
  kind: RowKind;
  entryId: string;
  timestamp?: number;
  partKey?: string;
  topGap: number;
}

// TranscriptView constants (parity with iOS).
export const GAP_TURN = 14;
export const GAP_BLOCK = 8;
export const MAX_CONTENT_WIDTH = 736;

export interface RowBuilderState {
  parsers: Map<string, IncrementalMarkdownParser>;
  completed: Map<string, CompletedParse>;
  cachedRevision?: number;
  cachedRows: TranscriptRow[];
}

export function makeRowBuilderState(): RowBuilderState {
  return {
    parsers: new Map(),
    completed: new Map(),
    cachedRows: [],
  };
}

export function buildRows(
  entries: MessageEntry[],
  pendingSends: PendingSend[],
  state: RowBuilderState,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const live = new Set<string>();

  for (const entry of entries) {
    rowsForEntry(entry, rows, state, live);
  }

  // Optimistic echo: pending sends share their client-minted id, so the
  // host's real entry replaces them without a flicker.
  const ids = new Set(entries.map((e) => e.id));
  for (const pending of pendingSends) {
    if (!ids.has(pending.messageId)) {
      rows.push({
        id: pending.messageId,
        version: fnv1a(pending.text) | 1,
        turnStart: true,
        kind: { kind: 'user', text: pending.text },
        entryId: pending.messageId,
        timestamp: undefined,
        partKey: undefined,
        topGap: 0,
      });
    }
  }

  // Drop memos for parts that no longer exist.
  if (state.completed.size > live.size) {
    for (const key of state.completed.keys()) {
      if (!live.has(key)) state.completed.delete(key);
    }
  }

  // Resolve top gaps in a second pass (depends on the previous row).
  for (let i = 0; i < rows.length; i++) {
    rows[i].topGap = gapFor(rows[i], i > 0 ? rows[i - 1] : null, i === 0);
  }

  return rows;
}

function gapFor(row: TranscriptRow, previous: TranscriptRow | null, isFirst: boolean): number {
  if (isFirst) return GAP_TURN + 10;
  if (row.turnStart) return GAP_TURN;
  if (row.partKey && previous?.partKey === row.partKey) return MD.blockGap;
  return GAP_BLOCK;
}

function rowsForEntry(
  entry: MessageEntry,
  rows: TranscriptRow[],
  state: RowBuilderState,
  live: Set<string>,
): void {
  const streaming = entry.status === 'streaming';
  const settled = entry.status !== undefined && !streaming;

  if (entry.role === 'user') {
    const text = entry.parts
      .filter((p): p is { kind: 'text'; id: string; text: string } => p.kind === 'text')
      .map((p) => p.text)
      .join('\n');
    if (text.length === 0) return;
    rows.push({
      id: entry.id,
      version: fnv1a(text),
      turnStart: true,
      kind: { kind: 'user', text },
      entryId: entry.id,
      timestamp: entry.createdAt,
      partKey: undefined,
      topGap: 0,
    });
    return;
  }

  let first = true;
  let pendingTools: ToolItem[] = [];
  let groupIx = 0;
  const lastPartIx = entry.parts.length - 1;

  const flushTools = (lastIx: number | null) => {
    if (pendingTools.length === 0) return;
    const autoOpen = streaming && lastIx === lastPartIx;
    const id = `${entry.id}#g${groupIx}`;
    let version = toolFingerprint(pendingTools);
    if (autoOpen) version ^= 1;
    rows.push({
      id,
      version,
      turnStart: first,
      kind: { kind: 'toolGroup', tools: pendingTools, autoOpen },
      entryId: entry.id,
      timestamp: undefined,
      partKey: undefined,
      topGap: 0,
    });
    first = false;
    pendingTools = [];
    groupIx += 1;
  };

  entry.parts.forEach((part, ix) => {
    switch (part.kind) {
      case 'tool':
        pendingTools.push({
          call: part.call,
          isError: part.isError,
          resolved: part.resolved,
        });
        if (ix === lastPartIx) flushTools(ix);
        break;
      case 'text': {
        flushTools(ix - 1);
        if (part.text.length === 0) return;
        const key = `${entry.id}#${part.id}`;
        live.add(key);
        const isLiveTail = streaming && ix === lastPartIx;
        const blocks = parseText(part.text, key, isLiveTail, state);
        blocks.forEach((top, blockIx) => {
          let version = (blockFingerprint(top) << 1) |
            (isLiveTail && blockIx === blocks.length - 1 ? 1 : 0);
          if (settled && ix === lastPartIx && blockIx === blocks.length - 1) {
            version ^= 1 << 62;
          }
          rows.push({
            id: `${key}.${blockIx}`,
            version,
            turnStart: first,
            kind: {
              kind: 'markdown',
              block: top.block,
              streaming: isLiveTail && blockIx === blocks.length - 1,
            },
            entryId: entry.id,
            timestamp: settled && ix === lastPartIx && blockIx === blocks.length - 1
              ? entry.createdAt
              : undefined,
            partKey: key,
            topGap: 0,
          });
          first = false;
        });
        break;
      }
      case 'input': {
        flushTools(ix - 1);
        const header = part.questions[0]?.header ?? 'Question';
        rows.push({
          id: `${entry.id}#${part.id}`,
          version: fnv1a(header) | (part.resolved ? 1 : 0),
          turnStart: first,
          kind: { kind: 'inputChip', header, resolved: part.resolved },
          entryId: entry.id,
          timestamp: undefined,
          partKey: undefined,
          topGap: 0,
        });
        first = false;
        break;
      }
      case 'error': {
        flushTools(ix - 1);
        rows.push({
          id: `${entry.id}#${part.id}`,
          version: fnv1a(part.message),
          turnStart: first,
          kind: { kind: 'errorChip', message: part.message },
          entryId: entry.id,
          timestamp: undefined,
          partKey: undefined,
          topGap: 0,
        });
        first = false;
        break;
      }
    }
  });
  flushTools(lastPartIx);
}

function parseText(
  text: string,
  key: string,
  streaming: boolean,
  state: RowBuilderState,
): TopBlock[] {
  if (streaming) {
    let parser = state.parsers.get(key);
    if (!parser) {
      parser = new IncrementalMarkdownParser();
      state.parsers.set(key, parser);
    }
    parser.setText(text);
    return parser.getBlocks();
  }
  // Settled — drop the live parser and serve from the memo.
  state.parsers.delete(key);
  const hit = state.completed.get(key);
  if (hit && hit.source === text) return hit.blocks;
  const blocks = MarkdownParser.parse(text);
  state.completed.set(key, { source: text, blocks });
  return blocks;
}

function blockFingerprint(top: TopBlock): number {
  // FNV-1a hash of the block's start line and a content snapshot.
  let hash = 0xcbf29ce484222325n;
  const str = `${top.startLine}:${JSON.stringify(top.block)}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return Number(hash & 0x7fffffffn);
}

function toolFingerprint(tools: ToolItem[]): number {
  let hash = 0xcbf29ce484222325n;
  for (const tool of tools) {
    for (let i = 0; i < tool.call.tag.length; i++) {
      hash ^= BigInt(tool.call.tag.charCodeAt(i));
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    const fieldCount = BigInt(Object.keys(tool.call.fields).length);
    const errBit = tool.isError ? 2n : 0n;
    const resBit = tool.resolved ? 4n : 0n;
    hash ^= fieldCount + errBit + resBit;
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    const sorted = Object.entries(tool.call.fields).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [k, v] of sorted) {
      const repr = `${k}=${String(v)}`;
      for (let i = 0; i < repr.length; i++) {
        hash ^= BigInt(repr.charCodeAt(i));
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
      }
    }
  }
  // Fit into safe-int (RN lacks BigInt>>>3 for shift) by XOR-fold.
  const low = Number(hash & 0xffffffffn);
  const high = Number((hash >> 32n) & 0xffffffffn);
  return ((low ^ high) << 3) | 0;
}

export function fnv1a(text: string): number {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const low = Number(hash & 0xffffffffn);
  const high = Number((hash >> 32n) & 0xffffffffn);
  return ((low ^ high) << 1) | 0;
}

// MARK: - Tool chip content (transcript.rs tool_chip_content_raw)

export function chipLabel(call: RenderToolCall): string {
  switch (call.tag) {
    case 'exec': return 'Run';
    case 'readFile': return 'Read';
    case 'writeFile': return 'Write';
    case 'editFile': return 'Edit';
    case 'applyPatch': return 'Patch';
    case 'search': return 'Search';
    case 'glob': return 'Glob';
    case 'webFetch': return 'Fetch';
    case 'webSearch': return 'Web';
    case 'todo': return 'Todo';
    case 'mcp': return 'MCP';
    default: return 'Tool';
  }
}

export function chipDetail(call: RenderToolCall): string {
  switch (call.tag) {
    case 'exec': return toolStringField(call, 'command') ?? '';
    case 'readFile':
    case 'writeFile':
    case 'editFile':
      return shortPath(toolStringField(call, 'path') ?? '');
    case 'applyPatch': {
      const changes = call.fields.changes;
      const count = Array.isArray(changes) ? changes.length : 0;
      return count === 1 ? '1 file' : `${count} files`;
    }
    case 'search': return toolStringField(call, 'pattern') ?? '';
    case 'glob': return toolStringField(call, 'pattern') ?? '';
    case 'webFetch': return toolStringField(call, 'url') ?? '';
    case 'webSearch': return toolStringField(call, 'query') ?? '';
    case 'todo': return toolStringField(call, 'summary') ?? 'task list';
    case 'mcp': {
      const server = toolStringField(call, 'server');
      const tool = toolStringField(call, 'tool');
      return [server ? `${server} · ` : null, tool].filter(Boolean).join('') || '';
    }
    default: return toolStringField(call, 'name') ?? '';
  }
}

function shortPath(path: string): string {
  const comps = path.split('/');
  if (comps.length <= 2) return path;
  return comps.slice(-2).join('/');
}

export function toolGroupSummary(tools: ToolItem[]): string {
  const segments: string[] = [];
  const runs = tools.filter((t) => t.call.tag === 'exec').length;
  if (runs > 0) segments.push(runs === 1 ? 'ran 1 command' : `ran ${runs} commands`);
  const edits = tools.filter((t) =>
    ['editFile', 'writeFile', 'applyPatch'].includes(t.call.tag),
  ).length;
  if (edits > 0) segments.push(edits === 1 ? 'edited 1 file' : `edited ${edits} files`);
  const reads = tools.filter((t) => t.call.tag === 'readFile').length;
  if (reads > 0) segments.push(reads === 1 ? 'read 1 file' : `read ${reads} files`);
  const searches = tools.filter((t) =>
    ['search', 'glob', 'webSearch', 'webFetch'].includes(t.call.tag),
  ).length;
  if (searches > 0) segments.push(searches === 1 ? '1 search' : `${searches} searches`);
  const other = tools.length - runs - edits - reads - searches;
  if (other > 0) segments.push(other === 1 ? '1 tool' : `${other} tools`);
  const failed = tools.filter((t) => t.isError).length;
  if (failed > 0) segments.push(`${failed} failed`);
  if (segments.length === 0) return `${tools.length} tools`;
  const first = segments[0];
  const cap = first.charAt(0).toUpperCase() + first.slice(1);
  return [cap, ...segments.slice(1)].join(' · ');
}
