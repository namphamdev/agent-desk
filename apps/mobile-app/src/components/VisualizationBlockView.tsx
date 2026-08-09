// Rich visualization renderer — renders JSON visualization documents emitted
// by agents ({"root":"r","elements":{...}}) as native RN components.
//
// The element graph is resolved recursively from the root element; each type
// maps to a styled RN component. Unknown types render a muted fallback.

import React, { memo } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { VizDocument, VizElement } from '../markdown/MarkdownModel';
import { Fonts, sansFont, Theme } from '../theme/Theme';
import { fs } from '../theme/Appearance';
import { withAlpha } from '../theme/color';

interface Props {
  doc: VizDocument;
}

export const VisualizationBlockView = memo(function VisualizationBlockView({ doc }: Props) {
  const root = doc.elements[doc.root];
  if (!root) return null;
  return (
    <View style={{ borderRadius: Theme.panelRadius, overflow: 'hidden' }}>
      {renderElement(root, doc, 'root')}
    </View>
  );
});

function renderElement(el: VizElement, doc: VizDocument, id: string): React.ReactNode {
  const children = (el.children ?? []).map((cid) => {
    const child = doc.elements[cid];
    if (!child) return null;
    return <React.Fragment key={cid}>{renderElement(child, doc, cid)}</React.Fragment>;
  });

  switch (el.type) {
    case 'Box':
      return <VizBox key={id} props={el.props} children={children} />;
    case 'Text':
      return <VizText key={id} props={el.props} />;
    case 'Heading':
      return <VizHeading key={id} props={el.props} />;
    case 'Card':
      return <VizCard key={id} props={el.props} children={children} />;
    case 'BarChart':
      return <VizBarChart key={id} props={el.props} />;
    case 'Sparkline':
      return <VizSparkline key={id} props={el.props} />;
    case 'Table':
      return <VizTable key={id} props={el.props} />;
    case 'Divider':
      return <VizDivider key={id} props={el.props} />;
    case 'List':
      return <VizList key={id} props={el.props} />;
    case 'Newline':
      return <View key={id} style={{ height: 8 }} />;
    case 'Spacer':
      return <View key={id} style={{ flex: 1 }} />;
    case 'StatusLine':
      return <VizStatusLine key={id} props={el.props} />;
    case 'KeyValue':
      return <VizKeyValue key={id} props={el.props} />;
    case 'Badge':
      return <VizBadge key={id} props={el.props} />;
    case 'ProgressBar':
      return <VizProgressBar key={id} props={el.props} />;
    case 'Metric':
      return <VizMetric key={id} props={el.props} />;
    case 'Callout':
      return <VizCallout key={id} props={el.props} />;
    case 'Timeline':
      return <VizTimeline key={id} props={el.props} />;
    default:
      return (
        <Text key={id} style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: Theme.textMuted }}>
          [unknown: {el.type}]
        </Text>
      );
  }
}

// MARK: - Helpers

function str(val: unknown, fallback = ''): string {
  return typeof val === 'string' ? val : fallback;
}

function num(val: unknown, fallback = 0): number {
  return typeof val === 'number' ? val : fallback;
}

function bool(val: unknown, fallback = false): boolean {
  return typeof val === 'boolean' ? val : fallback;
}

function direction(val: unknown): 'row' | 'column' {
  return val === 'row' ? 'row' : 'column';
}

// MARK: - Box

function VizBox({ props, children }: { props: Record<string, unknown>; children: React.ReactNode[] }) {
  return (
    <View
      style={{
        flexDirection: direction(props.flexDirection),
        padding: num(props.padding),
        gap: num(props.gap),
      }}
    >
      {children}
    </View>
  );
}

// MARK: - Text

function VizText({ props }: { props: Record<string, unknown> }) {
  return (
    <Text
      style={{
        fontFamily: sansFont(bool(props.bold) ? 'semibold' : 'regular'),
        fontSize: fs(14),
        color: str(props.color, Theme.text),
      }}
    >
      {str(props.text)}
    </Text>
  );
}

// MARK: - Heading

function VizHeading({ props }: { props: Record<string, unknown> }) {
  const level = num(props.level, 2);
  const size = level <= 1 ? 19 : level === 2 ? 16 : level === 3 ? 15 : 14;
  return (
    <Text
      style={{
        fontFamily: Fonts.sansSemiBold,
        fontSize: size,
        color: Theme.text,
      }}
    >
      {str(props.text)}
    </Text>
  );
}

// MARK: - Card

function VizCard({ props, children }: { props: Record<string, unknown>; children: React.ReactNode[] }) {
  const title = str(props.title);
  return (
    <View
      style={{
        backgroundColor: withAlpha(Theme.surfaceRaised, 0.5),
        borderRadius: 10,
        borderWidth: 1,
        borderColor: Theme.border,
        padding: num(props.padding, 12),
        gap: 8,
      }}
    >
      {title.length > 0 ? (
        <Text style={{ fontFamily: Fonts.sansSemiBold, fontSize: fs(14), color: Theme.text }}>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

// MARK: - BarChart

interface BarItem {
  label: string;
  value: number;
  color?: string;
}

function VizBarChart({ props }: { props: Record<string, unknown> }) {
  const rawData = props.data;
  const items: BarItem[] = Array.isArray(rawData)
    ? rawData.map((d) => ({
        label: str((d as Record<string, unknown>).label),
        value: num((d as Record<string, unknown>).value),
        color:
          typeof (d as Record<string, unknown>).color === 'string'
            ? ((d as Record<string, unknown>).color as string)
            : undefined,
      }))
    : [];
  if (items.length === 0) return null;

  const maxVal = Math.max(...items.map((i) => i.value), 0.001);
  const showPct = bool(props.showPercentage);

  return (
    <View style={{ gap: 8 }}>
      {items.map((item, ix) => {
        const frac = item.value / maxVal;
        const pct = Math.round(frac * 100);
        const color = item.color ?? Theme.accent;
        return (
          <View key={`bar-${ix}`} style={{ gap: 3 }}>
            <Text
              style={{ fontFamily: Fonts.sans, fontSize: fs(11), color: Theme.textMuted }}
              numberOfLines={1}
            >
              {item.label}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View
                style={{
                  height: 18,
                  width: `${Math.max(frac * 100, 2)}%`,
                  backgroundColor: color,
                  borderRadius: 4,
                }}
              />
              <Text
                style={{
                  fontFamily: Fonts.sansMedium,
                  fontSize: fs(12),
                  color: Theme.text,
                }}
              >
                {showPct ? `${pct}%` : formatNum(item.value)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function formatNum(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// MARK: - Sparkline

function VizSparkline({ props }: { props: Record<string, unknown> }) {
  const rawData = props.data;
  const data: number[] = Array.isArray(rawData)
    ? rawData.map((d) => num(d))
    : [];
  if (data.length < 2) return null;
  const color = str(props.color, Theme.accent);
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const barW = 3;
  const gap = 2;
  const h = 28;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: h, gap }}>
      {data.map((v, ix) => {
        const frac = (v - min) / range;
        return (
          <View
            key={`sl-${ix}`}
            style={{
              width: barW,
              height: Math.max(frac * h, 1),
              backgroundColor: color,
              borderRadius: 1,
            }}
          />
        );
      })}
    </View>
  );
}

// MARK: - Table

interface Col {
  header: string;
  key: string;
  width?: number;
}

function VizTable({ props }: { props: Record<string, unknown> }) {
  const rawCols = props.columns;
  const columns: Col[] = Array.isArray(rawCols)
    ? rawCols.map((c) => ({
        header: str((c as Record<string, unknown>).header),
        key: str((c as Record<string, unknown>).key),
        width:
          typeof (c as Record<string, unknown>).width === 'number'
            ? ((c as Record<string, unknown>).width as number)
            : undefined,
      }))
    : [];
  const rawRows = props.rows;
  const rows: Record<string, string | number>[] = Array.isArray(rawRows)
    ? (rawRows as Record<string, string | number>[])
    : [];
  if (columns.length === 0) return null;

  const headerColor = str(props.headerColor, Theme.accent);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        {/* Header */}
        <View style={{ flexDirection: 'row' }}>
          {columns.map((col, ix) => (
            <View
              key={`th-${ix}`}
              style={{
                minWidth: col.width ?? 60,
                paddingVertical: 8,
                paddingHorizontal: 10,
                borderBottomWidth: 2,
                borderBottomColor: withAlpha(headerColor, 0.5),
              }}
            >
              <Text
                style={{
                  fontFamily: Fonts.sansSemiBold,
                  fontSize: fs(12),
                  color: Theme.text,
                }}
                numberOfLines={1}
              >
                {col.header}
              </Text>
            </View>
          ))}
        </View>
        {/* Rows */}
        {rows.map((row, rix) => (
          <View
            key={`tr-${rix}`}
            style={{
              flexDirection: 'row',
              borderTopWidth: 1,
              borderTopColor: Theme.border,
            }}
          >
            {columns.map((col, cix) => (
              <View
                key={`td-${rix}-${cix}`}
                style={{
                  minWidth: col.width ?? 60,
                  paddingVertical: 7,
                  paddingHorizontal: 10,
                }}
              >
                <Text
                  style={{
                    fontFamily: Fonts.sans,
                    fontSize: fs(12),
                    color: Theme.text,
                  }}
                  numberOfLines={1}
                >
                  {String(row[col.key] ?? '')}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// MARK: - Divider

function VizDivider({ props }: { props: Record<string, unknown> }) {
  const title = str(props.title);
  if (title.length === 0) {
    return <View style={{ height: 1, backgroundColor: Theme.border, marginVertical: 4 }} />;
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 4 }}>
      <Text style={{ fontFamily: Fonts.sansMedium, fontSize: fs(11), color: Theme.textMuted }}>
        {title}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: Theme.border }} />
    </View>
  );
}

// MARK: - List

function VizList({ props }: { props: Record<string, unknown> }) {
  const rawItems = props.items;
  const items: string[] = Array.isArray(rawItems)
    ? rawItems.map((i) => str(i))
    : [];
  const ordered = bool(props.ordered);
  if (items.length === 0) return null;

  return (
    <View style={{ gap: 4 }}>
      {items.map((item, ix) => (
        <View key={`li-${ix}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <Text style={{ color: Theme.textMuted, fontSize: fs(13) }}>
            {ordered ? `${ix + 1}.` : '•'}
          </Text>
          <Text style={{ fontFamily: Fonts.sans, fontSize: fs(13), color: Theme.text, flex: 1 }}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

// MARK: - StatusLine

function VizStatusLine({ props }: { props: Record<string, unknown> }) {
  const status = str(props.status, 'info');
  const color =
    status === 'success'
      ? Theme.statusCompleted
      : status === 'error'
      ? Theme.danger
      : status === 'warning'
      ? Theme.warning
      : Theme.accent;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color }} />
      <Text style={{ fontFamily: Fonts.sans, fontSize: fs(13), color: Theme.text }}>
        {str(props.text)}
      </Text>
    </View>
  );
}

// MARK: - KeyValue

function VizKeyValue({ props }: { props: Record<string, unknown> }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ fontFamily: Fonts.sans, fontSize: fs(13), color: Theme.textMuted }}>
        {str(props.label)}
      </Text>
      <Text style={{ fontFamily: Fonts.sansMedium, fontSize: fs(13), color: Theme.text }}>
        {str(props.value)}
      </Text>
    </View>
  );
}

// MARK: - Badge

function VizBadge({ props }: { props: Record<string, unknown> }) {
  const variant = str(props.variant, 'default');
  const bg =
    variant === 'success'
      ? withAlpha(Theme.statusCompleted, 0.15)
      : variant === 'error'
      ? withAlpha(Theme.danger, 0.15)
      : variant === 'warning'
      ? withAlpha(Theme.warning, 0.15)
      : withAlpha(Theme.accent, 0.15);
  const fg =
    variant === 'success'
      ? Theme.statusCompleted
      : variant === 'error'
      ? Theme.danger
      : variant === 'warning'
      ? Theme.warning
      : Theme.accent;
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ fontFamily: Fonts.sansSemiBold, fontSize: fs(11), color: fg }}>
        {str(props.label)}
      </Text>
    </View>
  );
}

// MARK: - ProgressBar

function VizProgressBar({ props }: { props: Record<string, unknown> }) {
  const progress = Math.min(Math.max(num(props.progress, 0), 0), 1);
  const label = str(props.label);
  return (
    <View style={{ gap: 4 }}>
      {label.length > 0 ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: fs(11), color: Theme.textMuted }}>
          {label}
        </Text>
      ) : null}
      <View
        style={{
          height: 6,
          backgroundColor: Theme.border,
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <View style={{ height: '100%', width: `${progress * 100}%`, backgroundColor: Theme.accent, borderRadius: 3 }} />
      </View>
    </View>
  );
}

// MARK: - Metric

function VizMetric({ props }: { props: Record<string, unknown> }) {
  const trend = str(props.trend);
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ fontFamily: Fonts.sans, fontSize: fs(11), color: Theme.textMuted }}>
        {str(props.label)}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
        <Text style={{ fontFamily: Fonts.sansSemiBold, fontSize: fs(18), color: Theme.text }}>
          {str(props.value)}
        </Text>
        {trend === 'up' || trend === 'down' ? (
          <Text style={{ fontSize: fs(12), color: trend === 'up' ? Theme.statusCompleted : Theme.danger }}>
            {trend === 'up' ? '↑' : '↓'}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// MARK: - Callout

function VizCallout({ props }: { props: Record<string, unknown> }) {
  const type = str(props.type, 'info');
  const color =
    type === 'success'
      ? Theme.statusCompleted
      : type === 'error'
      ? Theme.danger
      : type === 'warning'
      ? Theme.warning
      : Theme.accent;
  const title = str(props.title);
  const content = str(props.content);
  return (
    <View
      style={{
        backgroundColor: withAlpha(color, 0.08),
        borderLeftWidth: 2,
        borderLeftColor: color,
        borderRadius: 6,
        padding: 10,
        gap: 4,
      }}
    >
      {title.length > 0 ? (
        <Text style={{ fontFamily: Fonts.sansSemiBold, fontSize: fs(13), color: Theme.text }}>
          {title}
        </Text>
      ) : null}
      {content.length > 0 ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: fs(13), color: Theme.textMuted }}>
          {content}
        </Text>
      ) : null}
    </View>
  );
}

// MARK: - Timeline

interface TLItem {
  title: string;
  description?: string;
  status?: string;
}

function VizTimeline({ props }: { props: Record<string, unknown> }) {
  const rawItems = props.items;
  const items: TLItem[] = Array.isArray(rawItems)
    ? rawItems.map((i) => {
        const obj = i as Record<string, unknown>;
        return {
          title: str(obj.title),
          description: typeof obj.description === 'string' ? obj.description : undefined,
          status: typeof obj.status === 'string' ? obj.status : undefined,
        };
      })
    : [];
  if (items.length === 0) return null;

  return (
    <View style={{ gap: 10 }}>
      {items.map((item, ix) => {
        const dotColor =
          item.status === 'success'
            ? Theme.statusCompleted
            : item.status === 'error'
            ? Theme.danger
            : item.status === 'warning'
            ? Theme.warning
            : Theme.accent;
        const isLast = ix === items.length - 1;
        return (
          <View key={`tl-${ix}`} style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ alignItems: 'center', width: 12 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor, marginTop: 4 }} />
              {!isLast ? (
                <View style={{ flex: 1, width: 1.5, backgroundColor: Theme.border, marginTop: 2 }} />
              ) : null}
            </View>
            <View style={{ flex: 1, paddingBottom: isLast ? 0 : 0 }}>
              <Text style={{ fontFamily: Fonts.sansMedium, fontSize: fs(13), color: Theme.text }}>
                {item.title}
              </Text>
              {item.description ? (
                <Text style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: Theme.textMuted, marginTop: 1 }}>
                  {item.description}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
