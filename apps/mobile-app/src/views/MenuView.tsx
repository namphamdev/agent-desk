// MenuView — RN port of MenuView.swift. The app's settings / about / sign-out
// drawer. Simple list of rows.

import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { version } from '../../package.json';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import { Fonts, Theme } from '../theme/Theme';
import { withAlpha, whiteAlpha } from '../theme/color';
import { AgentDeskiMark } from '../theme/AgentDeskiMark';

interface Props {
  model: AppModel;
  onBack: () => void;
  onNotifications: () => void;
  onDevice: (deviceId: string) => void;
}

export function MenuView({ model, onBack, onNotifications }: Props) {
  useForceUpdateOnNotify(model);
  const devices = model.demo?.devices ?? model.workspace?.devices ?? [];
  const connected = model.connected;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ color: Theme.text, fontSize: 22 }}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 28 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <View style={styles.aboutRow}>
          <AgentDeskiMark size={36} color={Theme.text} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: Fonts.sansSemiBold, fontSize: 16, color: Theme.text }}>AgentDeski</Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: Theme.textMuted }}>
              v{version} {connected ? '· Connected' : '· Connecting…'}
            </Text>
          </View>
        </View>

        <Section title="Notifications">
          <Row label="Notification settings" onPress={onNotifications} />
        </Section>

        <Section title="Devices">
          {devices.length === 0 ? (
            <Text style={styles.emptyText}>No paired devices.</Text>
          ) : (
            devices.map((d) => (
              <Row
                key={d.id}
                label={d.name}
                subText={model.deviceOnline(d.id) ? 'Online' : 'Offline'}
                onPress={() => {}}
              />
            ))
          )}
        </Section>

        <Section title="Account">
          <Row
            label="Sign out"
            destructive
            onPress={() => {
              Alert.alert(
                'Sign out',
                'This will clear all local data including cached sessions.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Sign out', style: 'destructive', onPress: () => void model.signOut() },
                ],
              );
            }}
          />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View>
      <Text style={styles.sectionHeader}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({ label, subText, onPress, destructive }: {
  label: string;
  subText?: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: pressed ? whiteAlpha(0.04) : 'transparent',
        borderBottomWidth: 1,
        borderBottomColor: whiteAlpha(0.04),
      })}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: Fonts.sans,
          fontSize: 14,
          color: destructive ? Theme.danger : Theme.text,
        }}
      >
        {label}
      </Text>
      {subText ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: Theme.textMuted }}>{subText}</Text>
      ) : (
        <Text style={{ color: Theme.textFaint, fontSize: 12 }}>›</Text>
      )}
    </Pressable>
  );
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
  sectionHeader: {
    fontFamily: Fonts.sansMedium,
    fontSize: 11,
    color: withAlpha(Theme.textMuted, 0.6),
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: whiteAlpha(0.04),
    borderRadius: 16,
    overflow: 'hidden',
  },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  emptyText: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Theme.textFaint,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});
