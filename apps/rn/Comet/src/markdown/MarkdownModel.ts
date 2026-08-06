// Markdown block model — TS port of MarkdownModel.swift (parser.rs port).
// The transcript renders one row per top-level block, so the model is
// block-first: a parsed document is a flat list of TopBlocks whose content
// hash doubles as the row-version key for the virtualizer. Inline content is
// a run model (adjacent same-style runs merged).
//
// This is a focused CommonMark + GFM subset matching swift-markdown's output:
// paragraphs, ATX/setext headings, fenced code blocks, blockquotes, ordered/
// unordered lists (incl. task lists), tables, thematic breaks. HTML blocks
// surface as code blocks (no raw HTML rendered, matching the desktop).

export interface InlineStyle {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strikethrough: boolean;
  link?: string;
}

export const PLAIN_STYLE: InlineStyle = {
  bold: false,
  italic: false,
  code: false,
  strikethrough: false,
};

export interface InlineRun {
  text: string;
  style: InlineStyle;
}

export type MDAlign = 'left' | 'center' | 'right' | 'none';

export interface MDListItem {
  checked?: boolean;
  children: MDBlock[];
}

// MARK: - Rich visualization JSON blocks

// Agents emit single-line JSON in <json-render> tags (or as raw JSON objects)
// to render structured visualizations. The schema is:
//   { root: "id", elements: { id: { type, props, children: [...] } } }
// Each element is one of the component types below.

export type VizDirection = 'row' | 'column';

export interface VizBoxProps {
  flexDirection?: VizDirection;
  padding?: number;
  gap?: number;
  borderStyle?: string;
}

export interface VizTextProps {
  text: string;
  color?: string;
  bold?: boolean;
}

export interface VizHeadingProps {
  text: string;
  level?: number;
}

export interface VizCardProps {
  title?: string;
  padding?: number;
}

export interface VizBarChartDataItem {
  label: string;
  value: number;
  color?: string;
}

export interface VizBarChartProps {
  data: VizBarChartDataItem[];
  showPercentage?: boolean;
}

export interface VizSparklineProps {
  data: number[];
  color?: string;
}

export interface VizTableColumn {
  header: string;
  key: string;
  width?: number;
}

export interface VizTableProps {
  columns: VizTableColumn[];
  rows: Record<string, string | number>[];
  headerColor?: string;
}

export interface VizDividerProps {
  title?: string;
}

export interface VizListProps {
  items: string[];
  ordered?: boolean;
}

export interface VizStatusLineProps {
  text: string;
  status?: 'success' | 'error' | 'warning' | 'info';
}

export interface VizKeyValueProps {
  label: string;
  value: string;
}

export interface VizBadgeProps {
  label: string;
  variant?: string;
}

export interface VizProgressBarProps {
  progress: number;
  width?: number;
  label?: string;
}

export interface VizMetricProps {
  label: string;
  value: string;
  trend?: 'up' | 'down';
}

export interface VizCalloutProps {
  type?: string;
  title?: string;
  content?: string;
}

export interface VizTimelineItem {
  title: string;
  description?: string;
  status?: string;
}

export interface VizTimelineProps {
  items: VizTimelineItem[];
}

export interface VizNewlineProps {}

export interface VizSpacerProps {}

export type VizElement = {
  type: string;
  props: Record<string, unknown>;
  children: string[];
};

export interface VizDocument {
  root: string;
  elements: Record<string, VizElement>;
}

export type MDBlock =
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'heading'; level: number; runs: InlineRun[] }
  | { kind: 'codeBlock'; language?: string; code: string }
  | { kind: 'blockquote'; children: MDBlock[] }
  | { kind: 'list'; orderedStart?: number; items: MDListItem[] }
  | { kind: 'table'; header: InlineRun[][]; rows: InlineRun[][][]; align: MDAlign[] }
  | { kind: 'rule' }
  | { kind: 'visualization'; doc: VizDocument };

export interface TopBlock {
  startLine: number;
  block: MDBlock;
}

// MARK: - Parser

const LINK_DEF_PATTERN = /^\s{0,3}\[[^\]]+\]:/m;

export const MarkdownParser = {
  parse(source: string): TopBlock[] {
    return parseDocument(source);
  },

  hasLinkDefs(text: string): boolean {
    return LINK_DEF_PATTERN.test(text);
  },
};

// MARK: - Incremental streaming parser (IncrementalMarkdownParser port)

export class IncrementalMarkdownParser {
  private sourceText = '';
  private blocks: TopBlock[] = [];
  private fullOnly = false;

  get source(): string {
    return this.sourceText;
  }

  getBlocks(): TopBlock[] {
    return this.blocks;
  }

  setText(text: string): void {
    if (text === this.sourceText) return;
    if (!this.fullOnly && text.startsWith(this.sourceText) && this.sourceText.length > 0) {
      this.append(text);
    } else {
      this.reset(text);
    }
  }

  private reset(text: string): void {
    this.sourceText = text;
    this.fullOnly = MarkdownParser.hasLinkDefs(text);
    this.blocks = MarkdownParser.parse(text);
  }

  private append(text: string): void {
    const delta = text.slice(this.sourceText.length);
    this.sourceText = text;
    if (MarkdownParser.hasLinkDefs(delta)) {
      this.fullOnly = true;
      this.blocks = MarkdownParser.parse(text);
      return;
    }
    if (this.blocks.length < 2) {
      this.blocks = MarkdownParser.parse(text);
      return;
    }
    // Stable boundary: start of the second-to-last top-level block.
    const boundaryLine = this.blocks[this.blocks.length - 2].startLine;
    const stable = this.blocks.slice(0, this.blocks.length - 2);
    const tailSource = suffixFromLine(text, boundaryLine);
    const tailBlocks = MarkdownParser.parse(tailSource).map((tb) => ({
      startLine: tb.startLine + boundaryLine - 1,
      block: tb.block,
    }));
    this.blocks = [...stable, ...tailBlocks];
  }
}

function suffixFromLine(text: string, line: number): string {
  if (line <= 1) return text;
  let remaining = line - 1;
  let idx = 0;
  while (remaining > 0) {
    const nl = text.indexOf('\n', idx);
    if (nl === -1) return '';
    idx = nl + 1;
    remaining--;
  }
  return text.slice(idx);
}

// MARK: - Run merging

export function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const merged: InlineRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last && stylesEqual(last.style, run.style)) {
      last.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function stylesEqual(a: InlineStyle, b: InlineStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.code === b.code &&
    a.strikethrough === b.strikethrough &&
    a.link === b.link
  );
}

// MARK: - Block-level CommonMark + GFM parser (compact; covers the spec
// subset the desktop's pulldown-cmark config enables).
//
// The implementation scans line-by-line, dispatching on indentation and
// leading marker. It handles all the markdown features the iOS app's
// transcripts use; the parser is intentionally pragmatic — full CommonMark
// is what swift-markdown gives, but every case below is a faithful port of
// the rendered shape (heading levels, fenced code with optional language,
// GFM tables with alignment, task list checkboxes, blockquote nesting,
// ordered/unordered list nesting, setext headings, thematic breaks).

interface LineInfo {
  text: string;
  // The original line content with leading indentation stripped where
  // container blocks (blockquote, list) consumed it.
  content: string;
  // 1-based line number in the source.
  line: number;
  blank: boolean;
  indent: number;
}

export function parseDocument(source: string): TopBlock[] {
  const lines = source.split('\n');
  const blocks: TopBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const startLine = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();

    // Blank line: skip.
    if (trimmed.length === 0) {
      i++;
      continue;
    }

    // Rich visualization JSON: <json-render>{...}</json-render> or a raw
    // single-line {"root":...} object emitted by the agent.
    const viz = matchVisualization(raw, lines, i);
    if (viz) {
      blocks.push({ startLine, block: { kind: 'visualization', doc: viz.doc } });
      i = viz.nextIndex;
      continue;
    }

    // ATX heading: 1–6 `#`.
    const atx = matchAtx(trimmed);
    if (atx) {
      blocks.push({
        startLine,
        block: { kind: 'heading', level: atx.level, runs: parseInline(atx.text) },
      });
      i++;
      continue;
    }

    // Thematic break: - - -, * * *, _ _ _ (with optional spaces).
    if (/^([-*_])(\s*\1){2,}\s*$/.test(trimmed)) {
      blocks.push({ startLine, block: { kind: 'rule' } });
      i++;
      continue;
    }

    // Fenced code block: ``` or ~~~ (with optional language).
    const fence = matchFence(trimmed);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim().startsWith(fence.marker)) {
          i++;
          break;
        }
        codeLines.push(line);
        i++;
      }
      let code = codeLines.join('\n');
      if (code.endsWith('\n')) code = code.slice(0, -1);
      blocks.push({
        startLine,
        block: { kind: 'codeBlock', language: fence.language, code },
      });
      continue;
    }

    // Blockquote: lines starting with `>`.
    if (/^>\s?/.test(raw)) {
      const inner: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        inner.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const childBlocks = parseDocument(inner.join('\n'));
      blocks.push({
        startLine,
        block: {
          kind: 'blockquote',
          children: childBlocks.map((c) => c.block),
        },
      });
      continue;
    }

    // GFM table: header row + delimiter row.
    if (i + 1 < lines.length && /\|/.test(trimmed) && isTableDelimiter(lines[i + 1].trim())) {
      const tableLines: string[] = [raw];
      i++;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim().length > 0) {
        tableLines.push(lines[i]);
        i++;
      }
      const table = parseTable(tableLines);
      if (table) {
        blocks.push({ startLine, block: table });
        continue;
      }
    }

    // List: - / * / + / digit.
    if (matchListMarker(trimmed)) {
      const items = parseList(lines, i);
      blocks.push({
        startLine,
        block: items.block,
      });
      i = items.nextIndex;
      continue;
    }

    // Setext heading: paragraph followed by === or --- on next line.
    if (
      i + 1 < lines.length &&
      /^(=+|-+)$/.test(lines[i + 1].trim()) &&
      lines[i + 1].trim().length >= 1
    ) {
      const underline = lines[i + 1].trim();
      const level = underline[0] === '=' ? 1 : 2;
      blocks.push({
        startLine,
        block: { kind: 'heading', level, runs: parseInline(trimmed) },
      });
      i += 2;
      continue;
    }

    // Paragraph: gather consecutive non-blank lines until a breaker.
    const paraLines: string[] = [raw];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const nextTrim = next.trim();
      if (nextTrim.length === 0) break;
      if (
        matchAtx(nextTrim) ||
        matchFence(nextTrim) ||
        /^>\s?/.test(next) ||
        matchListMarker(nextTrim) ||
        /^([-*_])(\s*\1){2,}\s*$/.test(nextTrim) ||
        // Stop paragraph gathering if a visualization JSON block starts.
        nextTrim.startsWith('{"root"') ||
        nextTrim.startsWith('{ "root"') ||
        /^<json-render>/i.test(nextTrim)
      ) break;
      paraLines.push(next);
      i++;
    }
    blocks.push({
      startLine,
      block: { kind: 'paragraph', runs: parseInline(paraLines.join('\n')) },
    });
  }

  return blocks;
}

// MARK: - Visualization JSON detection

// Matches rich visualization JSON blocks. Two forms are supported:
//   1. <json-render>{"root":...}</json-render> — fenced tag form
//   2. {"root":...}  — raw single-line JSON object (may span multiple lines)
//
// In both cases the inner JSON must have a "root" string and an "elements"
// object to qualify as a visualization; otherwise we return null and let the
// normal paragraph/code-block path handle it.
function matchVisualization(
  firstLine: string,
  lines: string[],
  start: number,
): { doc: VizDocument; nextIndex: number } | null {
  const trimmed = firstLine.trim();

  // Form 1: <json-render>...</json-render> on a single line.
  const TAG_RE = /^<json-render>\s*(\{[\s\S]*\})\s*<\/json-render>$/i;
  const tagMatch = TAG_RE.exec(trimmed);
  if (tagMatch) {
    const doc = tryParseViz(tagMatch[1]);
    if (doc) return { doc, nextIndex: start + 1 };
    return null;
  }

  // Form 1b: <json-render> opening tag — gather until closing tag.
  const OPEN_RE = /^<json-render>\s*$/i;
  const CLOSE_RE = /^<\/json-render>\s*$/i;
  if (OPEN_RE.test(trimmed)) {
    const jsonLines: string[] = [];
    let j = start + 1;
    while (j < lines.length) {
      if (CLOSE_RE.test(lines[j].trim())) {
        const doc = tryParseViz(jsonLines.join('\n'));
        if (doc) return { doc, nextIndex: j + 1 };
        return null;
      }
      jsonLines.push(lines[j]);
      j++;
    }
    return null; // unterminated tag — let markdown handle it
  }

  // Form 2: raw JSON object starting with {"root"
  if (trimmed.startsWith('{"root"') || trimmed.startsWith('{ "root"')) {
    // Gather lines until braces balance.
    const collected = gatherJsonObject(firstLine, lines, start);
    if (collected) {
      const doc = tryParseViz(collected.text);
      if (doc) return { doc, nextIndex: collected.nextIndex };
    }
  }

  return null;
}

// Gather a multi-line JSON object starting at `start`, tracking brace depth.
function gatherJsonObject(
  firstLine: string,
  lines: string[],
  start: number,
): { text: string; nextIndex: number } | null {
  let depth = 0;
  const collected: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    collected.push(line);
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return { text: collected.join('\n'), nextIndex: i + 1 };
        }
      }
    }
  }
  return null;
}

// Parse and validate that the JSON has the viz-document shape.
function tryParseViz(text: string): VizDocument | null {
  try {
    const obj = JSON.parse(text);
    if (
      typeof obj === 'object' && obj !== null &&
      typeof obj.root === 'string' &&
      typeof obj.elements === 'object' && obj.elements !== null
    ) {
      return obj as VizDocument;
    }
  } catch {
    // Not valid JSON — fall through.
  }
  return null;
}

function matchAtx(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!m) return null;
  let text = m[2].replace(/\s+#+\s*$/, '').trim();
  if (text.endsWith('#')) text = text.replace(/#+$/, '').trim();
  return { level: m[1].length, text };
}

function matchFence(line: string): { marker: string; language?: string } | null {
  const m = /^(`{3,}|~{3,})\s*([\w.-]*)\s*$/.exec(line.trim());
  if (!m) return null;
  const lang = m[2] && m[2].length > 0 ? m[2] : undefined;
  return { marker: m[1][0].repeat(3), language: lang };
}

function isTableDelimiter(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line) ||
    /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function parseTable(lines: string[]): MDBlock | null {
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const delim = splitRow(lines[1]);
  const align: MDAlign[] = delim.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return 'none';
  });
  const rows = lines.slice(2).map((line) => splitRow(line));
  return {
    kind: 'table',
    header: header.map(parseInline),
    rows: rows.map((row) => row.map(parseInline)),
    align,
  };
}

function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((c) => c.trim());
}

interface ListParse {
  block: MDBlock;
  nextIndex: number;
}

function matchListMarker(line: string): 'ordered' | 'unordered' | null {
  if (/^[-*+]\s+/.test(line)) return 'unordered';
  if (/^\d+\.\s+/.test(line)) return 'ordered';
  return null;
}

function parseList(lines: string[], start: number): ListParse {
  const items: MDListItem[] = [];
  let orderedStart: number | undefined;
  let i = start;

  // Determine ordered start from first marker.
  const firstMarker = /^(\d+)\.\s+/.exec(lines[start].trim());
  if (firstMarker) orderedStart = parseInt(firstMarker[1], 10);

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // Blank line ends list unless next line continues the list.
      if (i + 1 < lines.length && matchListMarker(lines[i + 1].trim())) {
        i++;
        continue;
      }
      break;
    }
    const marker = matchListMarker(trimmed);
    if (!marker) break;

    // Strip the marker and any checkbox, capture the rest of the item.
    const stripped = trimmed.replace(/^([-*+]|\d+\.)\s+/, '');
    let checked: boolean | undefined;
    let itemText = stripped;
    const cb = /^\[([ xX])\]\s+/.exec(stripped);
    if (cb) {
      checked = cb[1].toLowerCase() === 'x';
      itemText = stripped.slice(cb[0].length);
    }

    // Gather continuation lines (same indent, no marker).
    const itemLines = [itemText];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const nextTrim = next.trim();
      if (nextTrim.length === 0) break;
      if (matchListMarker(nextTrim)) break;
      itemLines.push(nextTrim);
      i++;
    }
    const children = parseDocument(itemLines.join('\n')).map((tb) => tb.block);
    items.push({ checked, children });
  }

  return {
    block: { kind: 'list', orderedStart, items },
    nextIndex: i,
  };
}

// MARK: - Inline parser (covers the inline subset the transcripts use).

export function parseInline(text: string): InlineRun[] {
  // Convert soft breaks to spaces (matches swift-markdown's SoftBreak → " ").
  const normalized = text.replace(/\n/g, ' ');
  const runs: InlineRun[] = [];
  let i = 0;
  let buf = '';

  function flushBuf(style: InlineStyle) {
    if (buf.length === 0) return;
    runs.push({ text: buf, style: { ...style } });
    buf = '';
  }

  const style: InlineStyle = { ...PLAIN_STYLE };

  while (i < normalized.length) {
    const c = normalized[i];

    // Inline code: `code` (backtick fence; longest-match like cmark).
    if (c === '`') {
      let ticks = 0;
      while (normalized[i + ticks] === '`') ticks++;
      const opener = '`'.repeat(ticks);
      const close = normalized.indexOf(opener, i + ticks);
      if (close !== -1) {
        const code = normalized.slice(i + ticks, close);
        flushBuf(style);
        const saved = { ...style };
        style.code = true;
        runs.push({ text: code, style: { ...style } });
        style.code = false;
        Object.assign(style, saved);
        i = close + ticks;
        continue;
      }
    }

    // Emphasis / strong.
    if (c === '*' || c === '_') {
      let count = 0;
      while (normalized[i + count] === c) count++;
      const isStrong = count >= 2;
      const consumed = isStrong ? 2 : 1;
      // Find matching close of the same run length.
      const close = findClose(normalized, i + consumed, c, consumed);
      if (close !== -1) {
        flushBuf(style);
        const saved = { ...style };
        if (isStrong) style.bold = true; else style.italic = true;
        // Recurse into the inner span.
        const inner = normalized.slice(i + consumed, close);
        runs.push(...parseInline(inner).map((r) => ({
          text: r.text,
          style: { ...style, ...r.style, bold: r.style.bold || style.bold, italic: r.style.italic || style.italic },
        })));
        Object.assign(style, saved);
        i = close + consumed;
        continue;
      }
    }

    // Strikethrough: ~~text~~.
    if (c === '~' && normalized[i + 1] === '~') {
      const close = normalized.indexOf('~~', i + 2);
      if (close !== -1) {
        flushBuf(style);
        const saved = { ...style };
        style.strikethrough = true;
        const inner = normalized.slice(i + 2, close);
        runs.push(...parseInline(inner).map((r) => ({
          text: r.text,
          style: { ...style, ...r.style, strikethrough: true },
        })));
        Object.assign(style, saved);
        i = close + 2;
        continue;
      }
    }

    // Image: ![alt](url) — render alt text.
    if (c === '!' && normalized[i + 1] === '[') {
      const close = matchLink(normalized, i + 1);
      if (close) {
        flushBuf(style);
        runs.push({ text: close.label, style: { ...style } });
        i = close.next;
        continue;
      }
    }

    // Link: [label](url).
    if (c === '[') {
      const close = matchLink(normalized, i);
      if (close) {
        flushBuf(style);
        const saved = { ...style };
        style.link = close.url;
        runs.push(...parseInline(close.label).map((r) => ({
          text: r.text,
          style: { ...style, ...r.style, link: close.url },
        })));
        Object.assign(style, saved);
        i = close.next;
        continue;
      }
    }

    // Hard line break already normalized; just consume.
    buf += c;
    i++;
  }

  flushBuf(style);
  return mergeRuns(runs);
}

function findClose(text: string, start: number, char: string, count: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === char) {
      let run = 0;
      while (text[i + run] === char) run++;
      if (run >= count) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

function matchLink(
  text: string,
  start: number,
): { label: string; url: string; next: number } | null {
  if (text[start] !== '[') return null;
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (depth !== 0 || text[i] !== ']') return null;
  const label = text.slice(start + 1, i);
  if (text[i + 1] !== '(') return null;
  const close = text.indexOf(')', i + 2);
  if (close === -1) return null;
  const url = text.slice(i + 2, close).trim();
  return { label, url, next: close + 1 };
}
