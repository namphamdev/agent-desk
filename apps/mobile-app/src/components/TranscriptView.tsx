// Transcript — RN port of TranscriptView.swift. Virtualized block-granularity
// rows with stick-to-bottom.
//
// Desktop parity: GAP_TURN 14 / GAP_BLOCK 8 / MD_BLOCK_GAP 12, content column
// max 736, re-engage band 70, jump-button threshold 320, bottom pad 24.
// RN's FlatList handles virtualization; stick-to-bottom uses onScroll +
// onContentSizeChange to track distanceFromBottom and scroll to end on
// streamed growth when pinned.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { MarkdownBlockView } from '../components/MarkdownBlockView';
import {
  CometPulse,
} from '../components/Loaders';
import { Fonts, overlay, Theme } from '../theme/Theme';
import { Appearance, fs, useAppearance } from '../theme/Appearance';
import { MD } from '../markdown/Metrics';
import { withAlpha } from '../theme/color';
import { RowVeil } from '../transcript/Veil';
import {
  buildRows,
  chipDetail,
  chipLabel,
  GAP_BLOCK,
  GAP_TURN,
  makeRowBuilderState,
  MAX_CONTENT_WIDTH,
  RowBuilderState,
  toolGroupSummary,
  TranscriptRow,
  ToolItem,
} from '../transcript/TranscriptRows';
import type { SessionStore } from '../sync/SessionStore';

const STICK_THRESHOLD = 70;
const JUMP_THRESHOLD = 320;
const STICKY_USER_HEIGHT = 40;

// Type guard for user rows that can be pinned at the top of the transcript.
function isPinnableUserRow(row: TranscriptRow): row is TranscriptRow & { kind: { kind: 'user'; text: string } } {
  return row.kind.kind === 'user';
}

interface TranscriptProps {
  store: SessionStore;
  chatId: string;
}

interface VeilCache {
  current: Map<string, RowVeil>;
}

export function TranscriptView({ store, chatId }: TranscriptProps) {
  // Subscribe to appearance changes so font-size adjustments re-render.
  useAppearance();
  // Subscribe to store mutations.
  const [, setBump] = useState(0);
  useEffect(() => store.subscribe(() => setBump((n) => n + 1)), [store]);

  const builderRef = useRef<RowBuilderState>(makeRowBuilderState());
  const veilsRef = useRef<VeilCache>({ current: new Map() });
  const foldsRef = useRef<Map<string, boolean>>(new Map());
  const [foldsBump, setFoldsBump] = useState(0);
  const [, forceRerender] = useState(0);
  const [pinned, setPinned] = useState(true);
  const [distanceFromBottom, setDistanceFromBottom] = useState(0);
  const [hydrated, setHydrated] = useState(store.hasRevealed);
  const [settled, setSettled] = useState(store.hasRevealed);
  // The latest user message that has been scrolled past (sits above the
  // viewport). Undefined while the topmost visible row is itself a user
  // message or there is no earlier user turn.
  const [stickyUserId, setStickyUserId] = useState<string | null>(null);

  // Latest rows snapshot, kept in a ref so the stable viewability callback
  // can read current data without re-subscribing the FlatList.
  const rowsRef = useRef<TranscriptRow[]>([]);

  const listRef = useRef<FlatList<TranscriptRow>>(null);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const lastSignatureRef = useRef('');

  const rows = useMemo(() => {
    return buildRows(store.entries, store.pendingSends, builderRef.current);
  }, [store.entries, store.pendingSends, store.revision]);

  rowsRef.current = rows;

  // Stable viewability tracking so the FlatList doesn't re-subscribe on
  // every render. The callback reads the latest rows from rowsRef.
  const viewabilityConfigRef = useRef<{ viewAreaCoveragePercentThreshold: number }>({
    viewAreaCoveragePercentThreshold: 0,
  });
  const onViewableItemsChangedRef = useRef(
    (info: { viewableItems: Array<{ index: number | null }>; changed: unknown[] }) => {
      const indices = info.viewableItems
        .map((v) => v.index)
        .filter((i): i is number => typeof i === 'number');
      if (indices.length === 0) return;
      const first = Math.min(...indices);
      setStickyUserId((prev) => {
        const next = computeStickyUserId(rowsRef.current, first);
        return next === prev ? prev : next;
      });
    },
  );

  // Streamed growth signature — drives the auto-scroll.
  const signature = useMemo(() => {
    const last = rows[rows.length - 1];
    if (!last) return '';
    return `${rows.length}|${last.id}|${last.version}`;
  }, [rows]);

  // Tick the veil paint at ~30Hz while any span is fading.
  useEffect(() => {
    const id = setInterval(() => {
      let anyFading = false;
      for (const v of veilsRef.current.current.values()) {
        if (v.isFading) {
          anyFading = true;
          break;
        }
      }
      if (anyFading) forceRerender((n) => n + 1);
    }, 1000 / 30);
    return () => clearInterval(id);
  }, []);

  // Settle on first non-empty rows.
  useEffect(() => {
    if (rows.length > 0 && !hydrated) {
      setHydrated(true);
      setSettled(false);
    }
  }, [rows.length, hydrated]);

  // Hold the bottom until layout stops moving, then reveal.
  useEffect(() => {
    if (!hydrated || settled) return;
    let lastHeight = -1;
    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      if (pinned) {
        listRef.current?.scrollToEnd({ animated: false });
      }
      if (contentHeightRef.current === lastHeight || attempts >= 16) {
        setSettled(true);
        store.hasRevealed = true;
        clearInterval(id);
      }
      lastHeight = contentHeightRef.current;
    }, 30);
    return () => clearInterval(id);
  }, [hydrated, settled, pinned, store]);

  // Streamed growth → follow if pinned.
  useEffect(() => {
    if (!pinned) return;
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    if (rows.length === 0) return;
    // Allow layout to flush, then snap.
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false });
    });
  }, [signature, pinned, rows.length]);

  const screenWidth = Dimensions.get('window').width;
  const contentWidth = Math.min(screenWidth, MAX_CONTENT_WIDTH);

  const renderItem = ({ item, index }: { item: TranscriptRow; index: number }) => {
    return (
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: item.topGap,
          width: contentWidth,
          alignSelf: 'center',
        }}
      >
        <RowRenderer
          row={item}
          prevRow={index > 0 ? rows[index - 1] : null}
          veils={veilsRef.current}
          folds={foldsRef.current}
          onToggleFold={(id) => {
            const cur = foldsRef.current.get(id);
            const defaultFolded = item.kind.kind === 'toolGroup' && item.kind.autoOpen === true;
            foldsRef.current.set(id, !(cur ?? defaultFolded));
            setFoldsBump((n) => n + 1);
          }}
        />
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: Theme.bg, opacity: settled ? 1 : 0 }}>
      <FlatList
        key={`transcript-${Appearance.minFontSize}`}
        ref={listRef}
        data={rows}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 44, paddingTop: 4 }}
        onViewableItemsChanged={onViewableItemsChangedRef.current}
        viewabilityConfig={viewabilityConfigRef.current}
        onScroll={(e) => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
          const distance = Math.max(
            0,
            contentSize.height - layoutMeasurement.height - contentOffset.y,
          );
          viewportHeightRef.current = layoutMeasurement.height;
          contentHeightRef.current = contentSize.height;
          setDistanceFromBottom(distance);
          // Pin breaks on user scroll-up; re-engages within the band.
          if (distance > STICK_THRESHOLD && distance > distanceFromBottom + 1) {
            if (pinned) setPinned(false);
          } else if (!pinned && distance <= STICK_THRESHOLD && distance < distanceFromBottom) {
            setPinned(true);
          }
        }}
        onContentSizeChange={(w, h) => {
          contentHeightRef.current = h;
        }}
        scrollEventThrottle={32}
        onEndReachedThreshold={0.1}
        initialNumToRender={20}
        maxToRenderPerBatch={10}
        windowSize={11}
        removeClippedSubviews={Platform.OS === 'android'}
        onScrollToIndexFailed={(info) => {
          // The target row is outside the rendered window. Wait a beat for
          // more rows to render, then retry the scroll.
          setTimeout(() => {
            listRef.current?.scrollToIndex({
              index: Math.min(info.index, rowsRef.current.length - 1),
              animated: true,
              viewOffset: STICKY_USER_HEIGHT,
              viewPosition: 0,
            });
          }, 80);
        }}
      />
      {distanceFromBottom > JUMP_THRESHOLD ? (
        <Pressable
          onPress={() => {
            setPinned(true);
            listRef.current?.scrollToEnd({ animated: true });
          }}
          style={{
            position: 'absolute',
            bottom: 12,
            right: 16,
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: withAlpha(Theme.surfaceRaised, 0.9),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: Theme.text, fontSize: fs(14) }}>↓</Text>
        </Pressable>
      ) : null}
      <StickyUserBanner
        rows={rows}
        stickyUserId={stickyUserId}
        onScrollTo={(index) => {
          listRef.current?.scrollToIndex({
            index,
            animated: true,
            // viewOffset nudges the target just below the banner so it
            // isn't hidden underneath it after the scroll settles.
            viewOffset: STICKY_USER_HEIGHT,
            viewPosition: 0,
          });
        }}
      />
    </View>
  );
}

// Returns the id of the latest user row strictly before `firstVisibleIndex`,
// or null if there isn't one. This is the "previous user message" that stays
// pinned at the top while the conversation scrolls beneath it.
function computeStickyUserId(rows: TranscriptRow[], firstVisibleIndex: number): string | null {
  if (firstVisibleIndex <= 0) return null;
  for (let i = firstVisibleIndex - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && isPinnableUserRow(row)) return row.id;
  }
  return null;
}

function StickyUserBanner({
  rows,
  stickyUserId,
  onScrollTo,
}: {
  rows: TranscriptRow[];
  stickyUserId: string | null;
  onScrollTo: (index: number) => void;
}) {
  const index = stickyUserId ? rows.findIndex((r) => r.id === stickyUserId) : -1;
  const row = index >= 0 ? rows[index] : null;
  if (!row || !isPinnableUserRow(row)) return null;
  return (
    <Pressable
      onPress={() => onScrollTo(index)}
      style={({ pressed }) => [
        {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: STICKY_USER_HEIGHT,
          paddingHorizontal: 16,
          paddingVertical: 6,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: pressed ? Theme.elementHover : Theme.surface,
          borderBottomWidth: 1,
          borderBottomColor: Theme.border,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          fontFamily: Fonts.sans,
          fontSize: MD.textSize,
          color: Theme.textMuted,
        }}
      >
        {row.kind.text}
      </Text>
      <Text style={{ color: Theme.textFaint, fontSize: fs(11), marginLeft: 8 }}>↑</Text>
    </Pressable>
  );
}

interface RowRendererProps {
  row: TranscriptRow;
  prevRow: TranscriptRow | null;
  veils: { current: Map<string, RowVeil> };
  folds: Map<string, boolean>;
  onToggleFold: (id: string) => void;
}

const RowRenderer = React.memo(function RowRenderer({
  row,
  veils,
  folds,
  onToggleFold,
}: RowRendererProps) {
  switch (row.kind.kind) {
    case 'user':
      return <UserBubble text={row.kind.text} pending={row.timestamp === undefined} />;
    case 'markdown':
      return (
        <MarkdownRow
          row={row}
          block={row.kind.block}
          streaming={row.kind.streaming}
          veils={veils}
        />
      );
    case 'toolGroup': {
      const foldState = folds.get(row.id);
      const open = foldState ?? row.kind.autoOpen;
      return (
        <ToolGroupView
          tools={row.kind.tools}
          open={open}
          onToggle={() => onToggleFold(row.id)}
        />
      );
    }
    case 'inputChip':
      return <InputChipView header={row.kind.header} resolved={row.kind.resolved} />;
    case 'errorChip':
      return <ErrorChipView message={row.kind.message} />;
  }
});

function UserBubble({ text, pending }: { text: string; pending: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
      <View
        style={{
          backgroundColor: Theme.surfaceRaised,
          borderRadius: Theme.bubbleRadius,
          paddingHorizontal: 16,
          paddingVertical: 10,
          maxWidth: MAX_CONTENT_WIDTH * 0.8,
          opacity: pending ? 0.65 : 1,
        }}
      >
        <Text style={{ fontFamily: Fonts.sans, fontSize: MD.textSize, color: Theme.text }}>
          {text}
        </Text>
      </View>
    </View>
  );
}

const MarkdownRow = React.memo(function MarkdownRow({
  row,
  block,
  streaming,
  veils,
}: {
  row: TranscriptRow;
  block: import('../markdown/MarkdownModel').MDBlock;
  streaming: boolean;
  veils: { current: Map<string, RowVeil> };
}) {
  // Veil is only applied to paragraph/heading streaming rows.
  if (streaming && (block.kind === 'paragraph' || block.kind === 'heading')) {
    let veil = veils.current.get(row.id);
    if (!veil) {
      veil = new RowVeil();
      veils.current.set(row.id, veil);
    }
    const total = block.kind === 'paragraph'
      ? block.runs.reduce((acc, r) => acc + r.text.length, 0)
      : block.runs.reduce((acc, r) => acc + r.text.length, 0);
    veil.noteLength(total);
    return (
      <View style={{ opacity: veil.isFading ? 0.999 : 1 }}>
        <MarkdownBlockView block={block} cacheKey={row.id} />
      </View>
    );
  }
  // Drop the veil once settled.
  if (!streaming) veils.current.delete(row.id);
  return <MarkdownBlockView block={block} cacheKey={row.id} />;
});

function ToolGroupView({ tools, open, onToggle }: {
  tools: ToolItem[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <View>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => ({
          height: 26,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: pressed ? Theme.elementHover : 'transparent',
          borderRadius: 6,
          paddingHorizontal: 4,
        })}
      >
        <Text style={{ color: Theme.textMuted, fontSize: fs(9), fontWeight: '600' }}>
          {open ? '▸' : '▷'}
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: Theme.textMuted }} numberOfLines={1}>
          {toolGroupSummary(tools)}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ marginTop: 2 }}>
          {tools.map((tool, ix) => (
            <ToolChipRow key={ix} tool={tool} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ToolChipRow({ tool }: { tool: ToolItem }) {
  return (
    <View style={{ height: 38, paddingLeft: 12 }}>
      <View
        style={{
          height: 30,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 8,
          backgroundColor: overlay(0.03),
          borderRadius: 9,
          borderWidth: 1,
          borderColor: overlay(0.05),
        }}
      >
        <Text style={{ color: Theme.textMuted, fontSize: fs(10) }}>▪</Text>
        <Text
          style={{
            fontFamily: Fonts.sansMedium,
            fontSize: fs(12),
            color: tool.isError ? Theme.danger : Theme.textMuted,
          }}
        >
          {chipLabel(tool.call)}
        </Text>
        <Text
          style={{
            fontFamily: Fonts.sans,
            fontSize: fs(12),
            color: tool.isError ? Theme.danger : withAlpha(Theme.text, 0.85),
            flex: 1,
          }}
          numberOfLines={1}
        >
          {chipDetail(tool.call)}
        </Text>
      </View>
    </View>
  );
}

function InputChipView({ header, resolved }: { header: string; resolved: boolean }) {
  return (
    <View
      style={{
        height: 34,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        backgroundColor: overlay(0.045),
        borderRadius: 10,
        borderWidth: 1,
        borderColor: overlay(0.08),
      }}
    >
      <Text style={{ color: Theme.textMuted, fontSize: fs(10) }}>💬</Text>
      <Text style={{ fontFamily: Fonts.sansMedium, fontSize: fs(12), color: Theme.text }}>Question</Text>
      <Text style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: Theme.textMuted, flex: 1 }} numberOfLines={1}>
        {resolved ? header : 'Awaiting your answer…'}
      </Text>
    </View>
  );
}

function ErrorChipView({ message }: { message: string }) {
  return (
    <View
      style={{
        height: 34,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        backgroundColor: withAlpha(Theme.danger, 0.05),
        borderRadius: 10,
        borderWidth: 1,
        borderColor: withAlpha(Theme.danger, 0.16),
      }}
    >
      <Text style={{ color: withAlpha(Theme.dangerSoft, 0.8), fontSize: fs(10) }}>⚠</Text>
      <Text style={{ fontFamily: Fonts.sansMedium, fontSize: fs(12), color: Theme.text }}>Error</Text>
      <Text style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: withAlpha(Theme.text, 0.8), flex: 1 }} numberOfLines={1}>
        {message}
      </Text>
    </View>
  );
}

// Use Keyboard import to satisfy lints on platforms where it is needed.
void Keyboard;
