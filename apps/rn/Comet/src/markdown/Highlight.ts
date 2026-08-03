// Line-by-line syntax tokenizer — TS port of Highlight.swift.
// Paint-only: tokens recolor text runs on the same mono font, so highlighting
// can never change layout.

export type TokenClass = 'keyword' | 'stringLit' | 'comment' | 'number';

export interface TokenSpan {
  start: number;
  end: number;
  cls: TokenClass;
}

export type HighlightLanguage =
  | 'rust'
  | 'javascript'
  | 'python'
  | 'go'
  | 'json'
  | 'bash'
  | 'toml'
  | 'markdown'
  | 'swift';

export function highlightLanguageForTag(tag?: string): HighlightLanguage | null {
  if (!tag) return null;
  const t = tag.toLowerCase();
  switch (t) {
    case 'rust':
    case 'rs': return 'rust';
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'javascript':
    case 'typescript': return 'javascript';
    case 'py':
    case 'python': return 'python';
    case 'go':
    case 'golang': return 'go';
    case 'json':
    case 'jsonc': return 'json';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'shell':
    case 'console': return 'bash';
    case 'toml': return 'toml';
    case 'md':
    case 'markdown': return 'markdown';
    case 'swift': return 'swift';
    default: return null;
  }
}

interface LangDef {
  keywords: Set<string>;
  lineComment?: string;
  blockComment?: [string, string];
  multilineString?: string;
}

function langDef(lang: HighlightLanguage): LangDef {
  switch (lang) {
    case 'rust':
      return {
        keywords: new Set([
          'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn',
          'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in',
          'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
          'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type',
          'unsafe', 'use', 'where', 'while',
        ]),
        lineComment: '//',
        blockComment: ['/*', '*/'],
      };
    case 'javascript':
      return {
        keywords: new Set([
          'async', 'await', 'break', 'case', 'catch', 'class', 'const',
          'continue', 'default', 'delete', 'do', 'else', 'export', 'extends',
          'false', 'finally', 'for', 'function', 'if', 'import', 'in',
          'instanceof', 'interface', 'let', 'new', 'null', 'of', 'return',
          'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type',
          'typeof', 'undefined', 'var', 'void', 'while', 'yield',
        ]),
        lineComment: '//',
        blockComment: ['/*', '*/'],
      };
    case 'python':
      return {
        keywords: new Set([
          'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
          'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for',
          'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None',
          'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try',
          'while', 'with', 'yield',
        ]),
        lineComment: '#',
        multilineString: '"""',
      };
    case 'go':
      return {
        keywords: new Set([
          'break', 'case', 'chan', 'const', 'continue', 'default', 'defer',
          'else', 'fallthrough', 'false', 'for', 'func', 'go', 'goto', 'if',
          'import', 'interface', 'map', 'nil', 'package', 'range', 'return',
          'select', 'struct', 'switch', 'true', 'type', 'var',
        ]),
        lineComment: '//',
        blockComment: ['/*', '*/'],
      };
    case 'json':
      return { keywords: new Set(['true', 'false', 'null']) };
    case 'bash':
      return {
        keywords: new Set([
          'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for',
          'function', 'if', 'in', 'local', 'return', 'then', 'until', 'while',
        ]),
        lineComment: '#',
      };
    case 'toml':
      return { keywords: new Set(['true', 'false']), lineComment: '#' };
    case 'swift':
      return {
        keywords: new Set([
          'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'continue',
          'default', 'defer', 'do', 'else', 'enum', 'extension', 'false',
          'final', 'for', 'func', 'guard', 'if', 'import', 'in', 'init',
          'internal', 'is', 'let', 'nil', 'private', 'protocol', 'public',
          'return', 'self', 'Self', 'static', 'struct', 'switch', 'throw',
          'throws', 'true', 'try', 'var', 'where', 'while',
        ]),
        lineComment: '//',
        blockComment: ['/*', '*/'],
      };
    case 'markdown':
      return { keywords: new Set() };
  }
}

interface CarryState {
  inBlockComment: boolean;
  inMultilineString: boolean;
}

export function highlight(code: string, language: HighlightLanguage): TokenSpan[][] {
  const def = langDef(language);
  const lines = code.split('\n');
  const carry: CarryState = { inBlockComment: false, inMultilineString: false };
  return lines.map((line) => tokenizeLine(line, def, carry));
}

function tokenizeLine(
  line: string,
  def: LangDef,
  carry: CarryState,
): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const chars = Array.from(line);
  const n = chars.length;
  let i = 0;

  const matches = (pattern: string, at: number): boolean => {
    if (at + pattern.length > n) return false;
    for (let k = 0; k < pattern.length; k++) {
      if (chars[at + k] !== pattern[k]) return false;
    }
    return true;
  };

  // Resume carry.
  if (carry.inBlockComment && def.blockComment) {
    const close = def.blockComment[1];
    const start = i;
    while (i < n && !matches(close, i)) i++;
    if (i < n) {
      i += close.length;
      carry.inBlockComment = false;
    } else {
      i = n;
    }
    spans.push({ start, end: i, cls: 'comment' });
  } else if (carry.inMultilineString && def.multilineString) {
    const start = i;
    while (i < n && !matches(def.multilineString, i)) i++;
    if (i < n) {
      i += def.multilineString.length;
      carry.inMultilineString = false;
    } else {
      i = n;
    }
    spans.push({ start, end: i, cls: 'stringLit' });
  }

  while (i < n) {
    const c = chars[i];

    if (def.blockComment && matches(def.blockComment[0], i)) {
      const start = i;
      i += def.blockComment[0].length;
      while (i < n && !matches(def.blockComment[1], i)) i++;
      if (i < n) i += def.blockComment[1].length;
      else carry.inBlockComment = true;
      spans.push({ start, end: i, cls: 'comment' });
      continue;
    }
    if (def.lineComment && matches(def.lineComment, i)) {
      spans.push({ start: i, end: n, cls: 'comment' });
      i = n;
      continue;
    }
    if (def.multilineString && matches(def.multilineString, i)) {
      const start = i;
      i += def.multilineString.length;
      while (i < n && !matches(def.multilineString, i)) i++;
      if (i < n) i += def.multilineString.length;
      else carry.inMultilineString = true;
      spans.push({ start, end: i, cls: 'stringLit' });
      continue;
    }
    if (c === '"' || c === "'" || (c === '`' && def === langDef('javascript'))) {
      const start = i;
      i++;
      while (i < n) {
        if (chars[i] === '\\') {
          i += Math.min(2, n - i);
          continue;
        }
        if (chars[i] === c) {
          i++;
          break;
        }
        i++;
      }
      spans.push({ start, end: i, cls: 'stringLit' });
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      while (
        i < n &&
        (isHexDigit(chars[i]) ||
          chars[i] === '.' ||
          chars[i] === '_' ||
          chars[i] === 'x' ||
          chars[i] === 'o' ||
          chars[i] === 'b' ||
          chars[i] === 'e')
      ) {
        i++;
      }
      if (start === 0 || !(isLetter(chars[start - 1]) || chars[start - 1] === '_')) {
        spans.push({ start, end: i, cls: 'number' });
      }
      continue;
    }
    if (isLetter(c) || c === '_') {
      const start = i;
      while (i < n && (isLetter(chars[i]) || isDigit(chars[i]) || chars[i] === '_')) i++;
      const word = chars.slice(start, i).join('');
      if (def.keywords.has(word)) {
        spans.push({ start, end: i, cls: 'keyword' });
      }
      continue;
    }

    i++;
  }
  return spans;
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isHexDigit(c: string): boolean {
  return (
    (c >= '0' && c <= '9') ||
    (c >= 'a' && c <= 'f') ||
    (c >= 'A' && c <= 'F')
  );
}

function isLetter(c: string): boolean {
  return /[A-Za-z]/.test(c);
}
