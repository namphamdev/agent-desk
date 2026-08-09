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

  const listRef = useRef<FlatList<TranscriptRow>>(null);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const lastSignatureRef = useRef('');

  const rows = useMemo(() => {
    return buildRows(store.entries, store.pendingSends, builderRef.current);
  }, [store.entries, store.pendingSends, store.revision]);

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
    </View>
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
