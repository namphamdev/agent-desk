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
                <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
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
                <ChatRow
                  model={model}
                  chat={item.chat}
                  showLocation
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
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginHorizontal: 12,
        marginVertical: 2,
        borderRadius: 8,
        backgroundColor: pressed ? Theme.elementHover : 'transparent',
      })}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: aggColor }} />
      <Text style={{ fontSize: 13, color: Theme.textMuted }}>📁</Text>
      <Text
        style={{ flex: 1, fontFamily: Fonts.sansMedium, fontSize: 13, color: Theme.text }}
        numberOfLines={1}
      >
        {spaceDisplayName(space)}
      </Text>
      <Text
        style={{
          fontFamily: Fonts.sans,
          fontSize: 12,
          color: online ? withAlpha(Theme.textMuted, 0.6) : withAlpha(Theme.warning, 0.8),
        }}
        numberOfLines={1}
      >
        {online ? `@ ${deviceName}` : `@ ${deviceName} · offline`}
      </Text>
      <Text style={{ color: withAlpha(Theme.textFaint, 0.6), fontSize: 10 }}>›</Text>
    </Pressable>
  );
}

function ChatRow({ model, chat, showLocation, onPress, onArchive }: {
  model: AppModel;
  chat: Chat;
  showLocation: boolean;
  onPress: () => void;
  onArchive: () => void;
}) {
  const indicator = model.indicatorFor(chat);
  const indent = 6 + 8;
  const subline = withAlpha(Theme.textMuted, 0.5);
  const location = (() => {
    const space = model.spaceFor(chat)?.path ?? chat.cwd ?? '?';
    const name = model.deviceNameFor(chat.deviceId);
    const folder = baseName(space);
    const online = model.deviceOnline(chat.deviceId);
    return online ? `${folder} · ${name}` : `${folder} · ${name} (offline)`;
  })();

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onArchive}
      style={({ pressed }) => ({
        paddingHorizontal: 12,
        paddingVertical: 6,
        marginHorizontal: 12,
        marginVertical: 1,
        borderRadius: 8,
        backgroundColor: pressed ? Theme.elementHover : 'transparent',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusRail indicator={indicator} />
        {showLocation ? (
          <Text
            style={{
              flex: 1,
              fontFamily: Fonts.sans,
              fontSize: 11,
              color: subline,
            }}
            numberOfLines={1}
          >
            {location}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Text style={{ fontFamily: Fonts.sans, fontSize: 11, color: subline }}>
          {relativeTime(chat.lastMessageAt ?? chat.createdAt)}
        </Text>
      </View>
      <Text
        style={{
          paddingLeft: indent,
          fontFamily: Fonts.sans,
          fontSize: 13,
          color: Theme.text,
          marginTop: 2,
        }}
        numberOfLines={1}
      >
        {chatDisplayTitle(chat)}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: indent, marginTop: 2 }}>
        {chat.config?.harness ? <HarnessBadgeSmall harness={chat.config.harness} /> : null}
        {chat.branch && chat.branch.trim().length > 0 ? (
          <>
            <LineIcon icon="gitBranch" size={11} color={subline} />
            <Text style={{ fontFamily: Fonts.sans, fontSize: 11, color: subline }} numberOfLines={1}>
              {chat.branch}
            </Text>
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

function HarnessBadgeSmall({ harness }: { harness: string }) {
  if (harness === 'acp') {
    return <Text style={{ fontSize: 11, color: Theme.textMuted }}>▦</Text>;
  }
  return <BrandMark harness={harness} size={11} color={Theme.text} />;
}

function relativeTime(ms: number): string {
  const delta = Math.max(0, Math.floor((nowMs() - ms) / 1000));
  if (delta < 60) return 'now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86_400)}d`;
}

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
});
