// ChangesView — RN port of ChangesView.swift. Git diff overview for a chat's
// working directory, showing added/modified/deleted files with a tap to drill
// into the full diff. In demo mode it shows the fake tree.

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import { Chat, GitStatus } from '../models/Entities';
import { Fonts, Theme } from '../theme/Theme';
import { LineIcon } from '../theme/LineIcon';
import { withAlpha } from '../theme/color';

interface Props {
  model: AppModel;
  chat: Chat;
}

export function ChangesView({ model, chat }: Props) {
  useForceUpdateOnNotify(model);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const s = await model.gitStatus(chat);
      setStatus(s);
      setLoading(false);
    })();
  }, [model, chat.id]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          Changes · {chat.branch ?? 'branch'}
        </Text>
      </View>
      {loading ? (
        <View style={{ alignItems: 'center', paddingTop: 40 }}>
          <ActivityIndicator color={Theme.textMuted} />
        </View>
      ) : !status || !status.isRepo ? (
        <View style={{ alignItems: 'center', paddingTop: 40, paddingHorizontal: 24 }}>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: Theme.textFaint }}>
            This session's folder is not a git repository.
          </Text>
        </View>
      ) : status.files.length === 0 ? (
        <View style={{ alignItems: 'center', paddingTop: 40 }}>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: Theme.textFaint }}>
            No changes — working tree is clean.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {status.ahead > 0 || status.behind > 0 ? (
            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: Theme.textMuted }}>
                ↑ {status.ahead} ahead
              </Text>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: Theme.textMuted }}>
                ↓ {status.behind} behind
              </Text>
            </View>
          ) : null}
          {status.files.map((f, ix) => (
            <View
              key={`${f.path}-${ix}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderBottomColor: withAlpha(Theme.border, 0.5),
              }}
            >
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: deltaColor(f.kind) }}>
                {deltaSymbol(f.kind)}
              </Text>
              <Text
                style={{ flex: 1, fontFamily: Fonts.sans, fontSize: 13, color: Theme.text }}
                numberOfLines={1}
              >
                {f.path}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function deltaColor(kind: string): string {
  switch (kind) {
    case 'added': return Theme.statusCompleted;
    case 'deleted': return Theme.danger;
    case 'modified':
    case 'renamed':
    default:
      return Theme.warning;
  }
}

function deltaSymbol(kind: string): string {
  switch (kind) {
    case 'added': return '+';
    case 'deleted': return '−';
    case 'renamed': return '→';
    case 'modified':
    default:
      return 'M';
  }
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Theme.border,
  },
  title: {
    fontFamily: Fonts.sansMedium,
    fontSize: 14,
    color: Theme.text,
  },
});

void LineIcon;
