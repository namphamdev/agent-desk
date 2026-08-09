// SpaceView — RN port of SpaceView.swift. The phone's answer to the desktop's
// horizontal session tabs: the space's sessions as a vertical list,
// swipe-to-archive (= tab close), "+" to start a session in this space.

import React, { useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import {
  Chat,
  chatDisplayTitle,
  chatUnseen,
  ChatIndicatorValue,
  nowMs,
} from '../models/Entities';
import { Fonts, Theme } from '../theme/Theme';
import { withAlpha, whiteAlpha } from '../theme/color';
import { SessionSwipeable } from '../components/SessionSwipeable';
import { StatusRail, indicatorDotColor } from '../components/Loaders';
import { BrandMark } from '../theme/BrandMark';
import { LineIcon } from '../theme/LineIcon';

interface Props {
  model: AppModel;
  spaceId: string;
  onOpenChat: (chatId: string) => void;
  onNewSession: () => void;
}

export function SpaceView({ model, spaceId, onOpenChat, onNewSession }: Props) {
  useForceUpdateOnNotify(model);
  const space = model.spaces.find((s) => s.id === spaceId);
  const chats = model.chatsIn(spaceId);

  useEffect(() => {
    if (model.launchSheet === 'newsession') {
      model.launchSheet = undefined;
      onNewSession();
    }
  }, [model, onNewSession]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {space ? displayName(space.path, space.name) : 'Space'}
          </Text>
          {space ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {space.path} · {model.deviceNameFor(space.deviceId)}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={onNewSession}
          hitSlop={12}
          style={({ pressed }) => [
            styles.newButton,
            pressed && styles.newButtonPressed,
          ]}
        >
          <Text style={styles.newButtonText}>＋</Text>
        </Pressable>
      </View>
      {chats.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.emptyIconWrap}>
            <Text style={{ fontSize: 32 }}>💬</Text>
          </View>
          <Text style={styles.emptyTitle}>No sessions yet</Text>
          <Text style={styles.emptySub}>
            Start a new session in this space to get going.
          </Text>
          <Pressable
            onPress={onNewSession}
            style={({ pressed }) => [
              styles.emptyCta,
              pressed && styles.emptyCtaPressed,
            ]}
          >
            <Text style={styles.emptyCtaText}>Start a session</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={chats}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <SessionCard
              chat={item}
              indicator={model.indicatorFor(item)}
              onPress={() => onOpenChat(item.id)}
              onArchive={() => model.archive(item.id)}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 32 }}
        />
      )}
    </SafeAreaView>
  );
}

// MARK: - Session card

function SessionCard({
  chat,
  indicator,
  onPress,
  onArchive,
}: {
  chat: Chat;
  indicator: ChatIndicatorValue;
  onPress: () => void;
  onArchive: () => void;
}) {
  const unseen = chatUnseen(chat);
  const time = relativeTime(chat.lastMessageAt ?? chat.createdAt);
  const hasPreview = chat.lastMessagePreview && chat.lastMessagePreview.trim().length > 0;
  const dotColor = indicatorDotColor(indicator);

  return (
    <SessionSwipeable onDelete={onArchive}>
      <Pressable
        onPress={onPress}
        onLongPress={onArchive}
        style={({ pressed }) => [
          styles.card,
          pressed && styles.cardPressed,
        ]}
      >
        {/* Status row */}
        <View style={styles.cardTop}>
          <View style={styles.statusWrap}>
            <StatusRail indicator={indicator} />
            {indicator !== 'idle' && indicator !== 'completed' ? (
              <Text style={[styles.statusLabel, { color: dotColor }]}>
                {indicatorLabel(indicator)}
              </Text>
            ) : null}
          </View>
          <Text style={styles.timeText}>{time}</Text>
        </View>

        {/* Title */}
        <Text
          style={[styles.cardTitle, unseen && styles.cardTitleUnseen]}
          numberOfLines={1}
        >
          {chatDisplayTitle(chat)}
        </Text>

        {/* Preview (if available) */}
        {hasPreview ? (
          <Text style={styles.previewText} numberOfLines={1}>
            {chat.lastMessagePreview}
          </Text>
        ) : null}

        {/* Meta row: harness + branch */}
        <View style={styles.metaRow}>
          {chat.config?.harness ? (
            <View style={styles.harnessBadge}>
              {chat.config.harness === 'acp' ? (
                <Text style={styles.harnessAcpIcon}>▦</Text>
              ) : (
                <BrandMark harness={chat.config.harness} size={11} color={Theme.textMuted} />
              )}
              <Text style={styles.metaText}>
                {harnessLabel(chat.config.harness)}
              </Text>
            </View>
          ) : null}
          {chat.branch && chat.branch.trim().length > 0 ? (
            <View style={styles.branchBadge}>
              <LineIcon icon="gitBranch" size={11} color={withAlpha(Theme.textMuted, 0.6)} />
              <Text style={styles.metaText} numberOfLines={1}>
                {chat.branch}
              </Text>
            </View>
          ) : null}
          {unseen ? <View style={styles.unseenDot} /> : null}
        </View>
      </Pressable>
    </SessionSwipeable>
  );
}

// MARK: - Helpers

function displayName(path: string, name?: string): string {
  if (name && name.length > 0) return name;
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function harnessLabel(harness: string): string {
  switch (harness) {
    case 'claude-code': return 'Claude';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'acp': return 'ACP';
    default: return harness;
  }
}

function indicatorLabel(indicator: ChatIndicatorValue): string {
  switch (indicator) {
    case 'awaitingInput': return 'Needs input';
    case 'errored': return 'Error';
    case 'working': return 'Running';
    case 'completed': return 'Done';
    case 'idle': return '';
  }
}

function relativeTime(ms: number): string {
  const delta = Math.max(0, Math.floor((nowMs() - ms) / 1000));
  if (delta < 60) return 'now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86_400)}d`;
}

// MARK: - Styles

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border,
  },
  title: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 15,
    color: Theme.text,
  },
  subtitle: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: withAlpha(Theme.textMuted, 0.6),
    marginTop: 3,
  },
  newButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: whiteAlpha(0.08),
    alignItems: 'center',
    justifyContent: 'center',
  },
  newButtonPressed: {
    backgroundColor: whiteAlpha(0.14),
  },
  newButtonText: {
    color: Theme.text,
    fontSize: 16,
    fontFamily: Fonts.sansMedium,
  },

  // Empty state
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  emptyIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: whiteAlpha(0.05),
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 15,
    color: Theme.text,
  },
  emptySub: {
    fontFamily: Fonts.sans,
    fontSize: 12.5,
    color: Theme.textFaint,
    textAlign: 'center',
    lineHeight: 18,
  },
  emptyCta: {
    marginTop: 12,
    paddingHorizontal: 20,
    height: 38,
    borderRadius: 19,
    backgroundColor: Theme.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCtaPressed: {
    backgroundColor: withAlpha(Theme.text, 0.85),
  },
  emptyCtaText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Theme.bg,
  },

  // Session cards
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.border,
    marginHorizontal: 14,
  },
  card: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginVertical: 2,
    borderRadius: Theme.panelRadius,
  },
  cardPressed: {
    backgroundColor: Theme.elementHover,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 5,
  },
  statusWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusLabel: {
    fontFamily: Fonts.sansMedium,
    fontSize: 10.5,
    letterSpacing: 0.2,
  },
  timeText: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Theme.textFaint,
  },
  cardTitle: {
    fontFamily: Fonts.sans,
    fontSize: 13.5,
    color: Theme.textMuted,
  },
  cardTitleUnseen: {
    fontFamily: Fonts.sansMedium,
    color: Theme.text,
  },
  previewText: {
    fontFamily: Fonts.sans,
    fontSize: 12,
    color: Theme.textFaint,
    marginTop: 3,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 7,
  },
  harnessBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  harnessAcpIcon: {
    fontSize: 11,
    color: Theme.textMuted,
  },
  branchBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 1,
  },
  metaText: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: withAlpha(Theme.textMuted, 0.6),
  },
  unseenDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.accent,
    marginLeft: 'auto',
  },
});
