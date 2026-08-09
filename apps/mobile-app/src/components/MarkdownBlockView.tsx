// Markdown block rendering — RN component port of MarkdownBlockView.swift.
// Inline runs render as <Text> with per-run style (bold/italic/code/links);
// code runs paint a violet rounded wash via nested <Text> backgrounds.

import React, { memo, useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { highlight, HighlightLanguage, highlightLanguageForTag, TokenClass, TokenSpan } from '../markdown/Highlight';
import {
  InlineRun,
  MDBlock,
  MDListItem,
} from '../markdown/MarkdownModel';
import { MarkdownParser } from '../markdown/MarkdownModel';
import { MD } from '../markdown/Metrics';
import { Fonts, FontWeight, sansFont, Theme } from '../theme/Theme';
import { VisualizationBlockView } from './VisualizationBlockView';

interface InlineProps {
  runs: InlineRun[];
  size?: number;
  weight?: FontWeight;
  baseColor?: string;
}

/**
 * Inline runs → styled <Text>. Inline code uses a nested <Text> with the
 * violet wash + token color; everything else concatenates plain runs.
 */
export function InlineRuns({ runs, size = MD.textSize, weight = 'regular', baseColor = Theme.text }: InlineProps) {
  const elements = runs.map((run, i) => {
    if (run.style.code) {
      return (
        <Text
          key={`c-${i}`}
          style={{
            fontFamily: Fonts.mono,
            fontSize: size - 1.5,
            color: Theme.inlineCodeText,
            backgroundColor: Theme.inlineCodeWash,
            paddingHorizontal: 4,
            borderRadius: MD.inlineCodeRadius,
            overflow: 'hidden',
          }}
        >
          {run.text}
        </Text>
      );
    }
    const family = sansFont(run.style.bold ? 'semibold' : weight);
    return (
      <Text
        key={`t-${i}`}
        style={{
          fontFamily: family,
          fontSize: size,
          color: run.style.link ? Theme.text : baseColor,
          fontStyle: run.style.italic ? 'italic' : 'normal',
          textDecorationLine: run.style.strikethrough
            ? 'line-through'
            : run.style.link
            ? 'underline'
            : 'none',
        }}
      >
        {run.text}
      </Text>
    );
  });
  return <>{elements}</>;
}

interface BlockProps {
  block: MDBlock;
  cacheKey?: string;
}

export const MarkdownBlockView = memo(function MarkdownBlockView({ block, cacheKey = '' }: BlockProps) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <Text style={{ lineHeight: MD.lineHeight }}>
          <InlineRuns runs={block.runs} />
        </Text>
      );
    case 'heading': {
      const m = MD.headingMetrics(block.level);
      return (
        <Text style={{ lineHeight: m.line }}>
          <InlineRuns runs={block.runs} size={m.size} weight="semibold" />
        </Text>
      );
    }
    case 'codeBlock':
      return <CodeBlock language={block.language} code={block.code} cacheKey={cacheKey} />;
    case 'blockquote':
      return <Blockquote children={block.children} cacheKey={cacheKey} />;
    case 'list':
      return <ListBlock orderedStart={block.orderedStart} items={block.items} cacheKey={cacheKey} />;
    case 'table':
      return <TableBlock header={block.header} rows={block.rows} align={block.align} />;
    case 'rule':
      return <View style={{ height: 1, backgroundColor: Theme.border }} />;
    case 'visualization':
      return <VisualizationBlockView doc={block.doc} />;
  }
});

// MARK: - Code block

const CodeBlock = memo(function CodeBlock({
  language,
  code,
  cacheKey,
}: {
  language?: string;
  code: string;
  cacheKey: string;
}) {
  const lines = useMemo(() => code.split('\n'), [code]);
  const spans = useMemo<TokenSpan[][]>(() => {
    const lang = highlightLanguageForTag(language);
    if (!lang) return [];
    return highlight(code, lang as HighlightLanguage);
  }, [language, code]);

  return (
    <View
      style={{
        backgroundColor: 'rgba(255,255,255,0.035)',
        borderRadius: Theme.panelRadius,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}
    >
      {language && language.length > 0 ? (
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 5,
            backgroundColor: 'rgba(255,255,255,0.02)',
            borderBottomWidth: 1,
            borderBottomColor: Theme.border,
          }}
        >
          <Text style={{ fontFamily: Fonts.sans, fontSize: 11, color: Theme.textMuted }}>
            {language}
          </Text>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ paddingHorizontal: MD.codePaddingX, paddingVertical: MD.codePaddingY }}>
          {lines.map((line, ix) => {
            const lineSpans = ix < spans.length ? spans[ix] : [];
            return (
              <CodeLine key={`${cacheKey}-${ix}`} line={line} spans={lineSpans} />
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
});

const CodeLine = memo(function CodeLine({ line, spans }: { line: string; spans: TokenSpan[] }) {
  if (spans.length === 0) {
    return (
      <Text style={{ fontFamily: Fonts.mono, fontSize: MD.codeTextSize, lineHeight: MD.codeLineHeight, color: withOpacity(Theme.text, 0.9) }}>
        {line.length === 0 ? ' ' : line}
      </Text>
    );
  }
  return (
    <Text style={{ fontFamily: Fonts.mono, fontSize: MD.codeTextSize, lineHeight: MD.codeLineHeight }}>
      {renderSpans(line, spans)}
    </Text>
  );
});

function renderSpans(line: string, spans: TokenSpan[]) {
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span.start > cursor) {
      out.push(
        <Text key={`p-${i}`} style={{ color: withOpacity(Theme.text, 0.9) }}>
          {line.slice(cursor, span.start)}
        </Text>,
      );
    }
    out.push(
      <Text key={`s-${i}`} style={{ color: colorForToken(span.cls) }}>
        {line.slice(span.start, span.end)}
      </Text>,
    );
    cursor = span.end;
  }
  if (cursor < line.length) {
    out.push(
      <Text key="tail" style={{ color: withOpacity(Theme.text, 0.9) }}>
        {line.slice(cursor)}
      </Text>,
    );
  }
  return out;
}

function colorForToken(cls: TokenClass): string {
  switch (cls) {
    case 'keyword': return Theme.tokenKeyword;
    case 'stringLit': return Theme.tokenString;
    case 'number': return Theme.tokenNumber;
    case 'comment': return Theme.textFaint;
  }
}

function withOpacity(hex: string, alpha: number): string {
  // rgba() over a hex is the simplest RN path.
  const { r, g, b } = parseHexLocal(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseHexLocal(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// MARK: - Blockquote

const Blockquote = memo(function Blockquote({
  children,
  cacheKey,
}: {
  children: MDBlock[];
  cacheKey: string;
}) {
  return (
    <View
      style={{
        paddingLeft: 12,
        paddingRight: 10,
        paddingVertical: 6,
        backgroundColor: withOpacity(Theme.accent, 0.05),
        borderTopRightRadius: 6,
        borderBottomRightRadius: 6,
        borderLeftWidth: 2,
        borderLeftColor: withOpacity(Theme.accent, 0.6),
      }}
    >
      {children.map((child, i) => (
        <MarkdownBlockView key={`${cacheKey}-q${i}`} block={child} cacheKey={`${cacheKey}/q${i}`} />
      ))}
    </View>
  );
});

// MARK: - List

const ListBlock = memo(function ListBlock({
  orderedStart,
  items,
  cacheKey,
}: {
  orderedStart?: number;
  items: MDListItem[];
  cacheKey: string;
}) {
  return (
    <View>
      {items.map((item, ix) => {
        let marker: React.ReactNode;
        if (item.checked !== undefined) {
          marker = (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, lineHeight: MD.lineHeight, color: item.checked ? withOpacity(Theme.accent, 0.85) : Theme.textMuted }}>
              {item.checked ? '☑' : '☐'}
            </Text>
          );
        } else if (orderedStart !== undefined) {
          marker = (
            <Text style={{ fontFamily: Fonts.sans, fontSize: MD.textSize, lineHeight: MD.lineHeight, color: withOpacity(Theme.accent, 0.85) }}>
              {orderedStart + ix}.
            </Text>
          );
        } else {
          marker = (
            <View
              style={{
                width: 5,
                height: 5,
                marginTop: 8,
                borderRadius: 2.5,
                backgroundColor: withOpacity(Theme.accent, 0.85),
              }}
            />
          );
        }
        return (
          <View key={`${cacheKey}-l${ix}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <View style={{ minWidth: 18, alignItems: 'flex-end' }}>{marker}</View>
            <View style={{ flex: 1 }}>
              {item.children.map((child, cix) => (
                <MarkdownBlockView key={`${cacheKey}-l${ix}.${cix}`} block={child} cacheKey={`${cacheKey}/l${ix}.${cix}`} />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
});

// MARK: - Table

function TableBlock({ header, rows, align }: {
  header: InlineRun[][];
  rows: InlineRun[][][];
  align: ('left' | 'center' | 'right' | 'none')[];
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        <View style={{ flexDirection: 'row' }}>
          {header.map((cell, ix) => (
            <View
              key={`h-${ix}`}
              style={{
                minWidth: 48,
                padding: 12,
                alignItems: align[ix] === 'center' ? 'center' : align[ix] === 'right' ? 'flex-end' : 'flex-start',
              }}
            >
              <Text style={{ lineHeight: MD.lineHeight }}>
                <InlineRuns runs={cell} weight="bold" />
              </Text>
            </View>
          ))}
        </View>
        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.10)' }} />
        {rows.map((row, ix) => (
          <View key={`r-${ix}`}>
            <View style={{ flexDirection: 'row' }}>
              {row.map((cell, cix) => (
                <View
                  key={`r-${ix}-c-${cix}`}
                  style={{
                    minWidth: 48,
                    padding: 12,
                    alignItems: align[cix] === 'center' ? 'center' : align[cix] === 'right' ? 'flex-end' : 'flex-start',
                  }}
                >
                  <Text style={{ lineHeight: MD.lineHeight }}>
                    <InlineRuns runs={cell} />
                  </Text>
                </View>
              ))}
            </View>
            <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.10)' }} />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// Re-export parser convenience for callers.
export const parseMarkdown = MarkdownParser.parse;
