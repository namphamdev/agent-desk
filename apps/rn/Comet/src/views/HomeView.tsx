// HomeView — RN port of HomeView.swift. The mobile shell. Spaces section +
// Sessions section in a FlatList. Tab bar provides Activity / New space / menu.

import React, { useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlatList } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import {
  baseName,
  Chat,
  chatDisplayTitle,
  chatUnseen,
  ChatIndicatorValue,
  nowMs,
  Space,
  spaceDisplayName,
} from '../models/Entities';
import { Fonts, Theme } from '../theme/Theme';
import { withAlpha, whiteAlpha } from '../theme/color';
import { BrandMark } from '../theme/BrandMark';
import {
  indicatorDotColor,
  StatusRail,
} from '../components/Loaders';
import { LineIcon } from '../theme/LineIcon';
import { SessionSwipeable } from '../components/SessionSwipeable';

type RouteStack = NativeStackNavigationProp<any>;

interface Props {
  model: AppModel;
  navigation: RouteStack;
}

export function HomeView({ model, navigation }: Props) {
  useForceUpdateOnNotify(model);

  useEffect(() => {
    model.preloadSessions();
    model.scanSessionStatuses();
  }, [model, model.overviewChats.map((c) => c.id).join('|')]);

  useEffect(() => {
    model.scanSessionStatuses();
  }, [model, model.sessionStatusFingerprint]);

  const items = useMemo(() => {
    const typeA: Array<{ type: 'space'; space: Space }> = model.spaces.map((space) => ({
      type: 'space' as const,
      space,
    }));
    const typeB: Array<{ type: 'chat'; chat: Chat }> = model.overviewChats.map((chat) => ({
      type: 'chat' as const,
      chat,
    }));
    return [
      { type: 'header' as const, title: 'Spaces' },
      ...(typeA.length === 0
        ? [{ type: 'placeholder' as const, text: 'No spaces yet — add one from a desktop device' }]
        : typeA),
      { type: 'header' as const, title: 'Sessions' },
      ...(typeB.length === 0
        ? [{ type: 'placeholder' as const, text: 'No sessions yet' }]
        : typeB),
    ];
  }, [model.spaces, model.overviewChats]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      <View style={styles.headerBar}>
        <View style={{ width: 40 }}>
          {!model.connected ? (
            <ActivityIndicator size="small" color={Theme.textMuted} />
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Pressable
            onPress={() => navigation.navigate('Activity')}
            hitSlop={8}
          >
            <Text style={{ color: Theme.text, fontSize: 14 }}>🔔</Text>
          </Pressable>
          <Pressable onPress={() => navigation.navigate('NewSpace')} hitSlop={8}>
            <Text style={{ color: Theme.text, fontSize: 18 }}>＋</Text>
          </Pressable>
          <Pressable onPress={() => navigation.navigate('Menu')} hitSlop={8}>
            <Text style={{ color: Theme.text, fontSize: 14 }}>⋯</Text>
          </Pressable>
        </View>
      </View>
      <FlatList
        data={items}
        keyExtractor={(item, ix) =>
          item.type === 'space' ? `s-${item.space.id}`
          : item.type === 'chat' ? `c-${item.chat.id}`
          : `h-${ix}`
        }
        renderItem={({ item }) => {
          switch (item.type) {
            case 'header':
              return <SectionHeader title={item.title} />;
            case 'placeholder':
              return (
                <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                  <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: Theme.textFaint }}>
                    {item.text}
                  </Text>
                </View>
              );
            case 'space':
              return (
                <SpaceRow
                  model={model}
                  space={item.space}
                  onPress={() => navigation.navigate('Space', { spaceId: item.space.id })}
                />
              );
            case 'chat':
              return (
                <ChatCard
                  model={model}
                  chat={item.chat}
                  onPress={() => navigation.navigate('Chat', { chatId: item.chat.id })}
                  onArchive={() => model.archive(item.chat.id)}
                />
              );
          }
        }}
        contentContainerStyle={{ paddingBottom: 32 }}
      />
    </SafeAreaView>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 }}>
      <Text style={styles.sectionHeaderText}>{title}</Text>
    </View>
  );
}

// MARK: - Space row

function SpaceRow({ model, space, onPress }: {
  model: AppModel;
  space: Space;
  onPress: () => void;
}) {
  const agg = model.spaceIndicator(space.id);
  const aggColor = agg ? indicatorDotColor(agg) : whiteAlpha(0.14);
  const online = model.deviceOnline(space.deviceId);
  const deviceName = model.deviceNameFor(space.deviceId);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.spaceRow,
        pressed && styles.spaceRowPressed,
      ]}
    >
      <View style={[styles.spaceDot, { backgroundColor: aggColor }]} />
      <Text style={styles.spaceIcon}>📁</Text>
      <Text style={styles.spaceName} numberOfLines={1}>
        {spaceDisplayName(space)}
      </Text>
      <Text
        style={[
          styles.spaceDevice,
          { color: online ? withAlpha(Theme.textMuted, 0.6) : withAlpha(Theme.warning, 0.8) },
        ]}
        numberOfLines={1}
      >
        {online ? `@ ${deviceName}` : `@ ${deviceName} · offline`}
      </Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

// MARK: - Session card

function ChatCard({ model, chat, onPress, onArchive }: {
  model: AppModel;
  chat: Chat;
  onPress: () => void;
  onArchive: () => void;
}) {
  const indicator = model.indicatorFor(chat);
  const unseen = chatUnseen(chat);
  const time = relativeTime(chat.lastMessageAt ?? chat.createdAt);
  const hasPreview = chat.lastMessagePreview && chat.lastMessagePreview.trim().length > 0;
  const dotColor = indicatorDotColor(indicator);

  const location = (() => {
    const spacePath = model.spaceFor(chat)?.path ?? chat.cwd ?? '?';
    const name = model.deviceNameFor(chat.deviceId);
    const folder = baseName(spacePath);
    const online = model.deviceOnline(chat.deviceId);
    return online ? `${folder} · ${name}` : `${folder} · ${name} (offline)`;
  })();

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
        {/* Status + time row */}
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

        {/* Meta row: location · harness · branch · unseen dot */}
        <View style={styles.metaRow}>
          <Text style={styles.locationText} numberOfLines={1}>
            {location}
          </Text>
          {chat.config?.harness ? (
            <View style={styles.harnessBadge}>
              {chat.config.harness === 'acp' ? (
                <Text style={styles.harnessAcpIcon}>▦</Text>
              ) : (
                <BrandMark harness={chat.config.harness} size={11} color={Theme.textMuted} />
              )}
            </View>
          ) : null}
          {chat.branch && chat.branch.trim().length > 0 ? (
            <View style={styles.branchBadge}>
              <LineIcon icon="gitBranch" size={11} color={withAlpha(Theme.textMuted, 0.6)} />
              <Text style={styles.branchText} numberOfLines={1}>
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
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sectionHeaderText: {
    fontFamily: Fonts.sansMedium,
    fontSize: 11,
    color: withAlpha(Theme.textMuted, 0.6),
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Space row
  spaceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 14,
    marginVertical: 2,
    borderRadius: Theme.panelRadius,
  },
  spaceRowPressed: {
    backgroundColor: Theme.elementHover,
  },
  spaceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  spaceIcon: {
    fontSize: 13,
    color: Theme.textMuted,
  },
  spaceName: {
    flex: 1,
    fontFamily: Fonts.sansMedium,
    fontSize: 13,
    color: Theme.text,
  },
  spaceDevice: {
    fontFamily: Fonts.sans,
    fontSize: 12,
  },
  chevron: {
    color: withAlpha(Theme.textFaint, 0.6),
    fontSize: 10,
  },

  // Session card
  card: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 14,
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
    gap: 8,
    marginTop: 7,
  },
  locationText: {
    flexShrink: 1,
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: withAlpha(Theme.textMuted, 0.5),
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
  branchText: {
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
