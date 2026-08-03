// SpaceView — RN port of SpaceView.swift. The phone's answer to the desktop's
// horizontal session tabs: the space's sessions as a vertical list,
// swipe-to-archive (= tab close), "+" to start a session in this space.

import React, { useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import { Fonts, Theme } from '../theme/Theme';
import { withAlpha } from '../theme/color';

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
        <Pressable onPress={onNewSession} hitSlop={12}>
          <Text style={{ color: Theme.text, fontSize: 18 }}>＋</Text>
        </Pressable>
      </View>
      {chats.length === 0 ? (
        <View style={styles.empty}>
          <Text style={{ fontSize: 28, color: Theme.textFaint }}>💬</Text>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: Theme.textFaint }}>
            No sessions in this space
          </Text>
          <Pressable
            onPress={onNewSession}
            style={({ pressed }) => ({
              marginTop: 14,
              paddingHorizontal: 16,
              height: 36,
              borderRadius: 18,
              backgroundColor: pressed ? withAlpha(Theme.text, 0.85) : Theme.text,
              alignItems: 'center',
              justifyContent: 'center',
            })}
          >
            <Text style={{ fontFamily: Fonts.sansMedium, fontSize: 13, color: Theme.bg }}>
              Start a session
            </Text>
          </Pressable>
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
                paddingVertical: 6,
                marginHorizontal: 12,
                marginVertical: 1,
                borderRadius: 8,
                backgroundColor: pressed ? Theme.elementHover : 'transparent',
              })}
            >
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: Theme.text }} numberOfLines={1}>
                {item.title ?? 'New session'}
              </Text>
            </Pressable>
          )}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}
    </SafeAreaView>
  );
}

function displayName(path: string, name?: string): string {
  if (name && name.length > 0) return name;
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Theme.border,
  },
  title: {
    fontFamily: Fonts.sansMedium,
    fontSize: 13,
    color: Theme.text,
  },
  subtitle: {
    fontFamily: Fonts.sans,
    fontSize: 10.5,
    color: withAlpha(Theme.textMuted, 0.6),
    marginTop: 2,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingVertical: 48,
  },
});
