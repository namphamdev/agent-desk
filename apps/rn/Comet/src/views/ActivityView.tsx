// ActivityView — RN port of ActivityView.swift. The phone's answer to the
// desktop's sidebar activity feed: all active chats across spaces, sorted by
// last message time, with unread indicators and long-press to archive.

import React, { useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import {
  baseName,
  chatDisplayTitle,
  chatUnseen,
  nowMs,
} from '../models/Entities';
import { Fonts, Theme } from '../theme/Theme';
import { withAlpha } from '../theme/color';
import { StatusRail, indicatorDotColor } from '../components/Loaders';

interface Props {
  model: AppModel;
  onOpenChat: (chatId: string) => void;
  onBack: () => void;
}

export function ActivityView({ model, onOpenChat, onBack }: Props) {
  useForceUpdateOnNotify(model);
  const chats = model.activityChats;
  const unseenCount = chats.filter((c) => chatUnseen(c)).length;

  useEffect(() => {
    model.markAllActivityRead();
  }, [model, unseenCount]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ color: Theme.text, fontSize: 22 }}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Activity</Text>
        <View style={{ width: 28 }} />
      </View>
      {chats.length === 0 ? (
        <View style={styles.empty}>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: Theme.textFaint }}>
            No active sessions
          </Text>
        </View>
      ) : (
        <FlatList
          data={chats}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onOpenChat(item.id)}
              onLongPress={() => model.archive(item.id)}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 8,
                marginHorizontal: 12,
                marginVertical: 2,
                borderRadius: 10,
                backgroundColor: pressed ? Theme.elementHover : 'transparent',
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StatusRail indicator={model.indicatorFor(item)} />
                <Text
                  style={{ flex: 1, fontFamily: Fonts.sans, fontSize: 13, color: Theme.text }}
                  numberOfLines={1}
                >
                  {chatDisplayTitle(item)}
                </Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 11, color: withAlpha(Theme.textMuted, 0.5) }}>
                  {relativeTime(item.lastMessageAt ?? item.createdAt)}
                </Text>
              </View>
              <Text
                style={{
                  paddingLeft: 14,
                  fontFamily: Fonts.sans,
                  fontSize: 11,
                  color: withAlpha(Theme.textMuted, 0.5),
                  marginTop: 2,
                }}
                numberOfLines={1}
              >
                {item.cwd ? baseName(item.cwd) : ''} · {model.deviceNameFor(item.deviceId)}
              </Text>
            </Pressable>
          )}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}
    </SafeAreaView>
  );
}

function relativeTime(ms: number): string {
  const delta = Math.max(0, Math.floor((nowMs() - ms) / 1000));
  if (delta < 60) return 'now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86_400)}d`;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Theme.border,
  },
  title: {
    fontFamily: Fonts.sansMedium,
    fontSize: 14,
    color: Theme.text,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

void indicatorDotColor;
