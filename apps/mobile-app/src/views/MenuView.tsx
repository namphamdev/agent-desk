// MenuView — RN port of MenuView.swift. The app's settings / about / sign-out
// drawer. Simple list of rows.
import React, { useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { version } from '../../package.json';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import { Fonts, overlay, Theme } from '../theme/Theme';
import {
  Appearance,
  FONT_SIZE_OPTIONS,
  fs,
  ThemeMode,
  useAppearance,
  useThemedStyles,
} from '../theme/Appearance';
import { withAlpha } from '../theme/color';
import { useEasUpdate } from '../lib/useEasUpdate';
import { UpdateModal } from '../components/UpdateModal';

interface Props {
  model: AppModel;
  onBack: () => void;
  onNotifications: () => void;
  onDevice: (deviceId: string) => void;
}

export function MenuView({ model, onBack, onNotifications }: Props) {
  const eas = useEasUpdate();
  const [checkedRecently, setCheckedRecently] = useState(false);
  const styles = useThemedStyles(() => makeStyles(), []);
  const appearance = useAppearance();
  const devices = model.demo?.devices ?? model.workspace?.devices ?? [];
  const connected = model.connected;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ color: Theme.text, fontSize: fs(22) }}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 28 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <View style={styles.aboutRow}>
          <Image source={require('../../assets/agent-deski.png')} style={{ width: 36, height: 36, borderRadius: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: Fonts.sansSemiBold, fontSize: fs(16), color: Theme.text }}>AgentDeski</Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: Theme.textMuted }}>
              v{version} {connected ? '· Connected' : '· Connecting…'}
            </Text>
          </View>
        </View>
        <Section title="Update">
          <Row
            label={eas.checking ? 'Checking for updates…' : 'Check for updates'}
            subText={
              eas.error
                ? eas.error
                : checkedRecently && !eas.available && !eas.checking
                  ? 'Up to date'
                  : undefined
            }
            onPress={async () => {
              try {
                const found = await eas.checkForUpdate();
                setCheckedRecently(true);
                if (!found) {
                  Alert.alert('Up to date', 'You are running the latest version of AgentDeski.');
                }
              } catch {
                // error surfaced in the row subText via eas.error
              }
            }}
          />
        </Section>

        <Section title="Appearance">
          <View style={styles.appearanceGroup}>
            <Text style={styles.appearanceLabel}>Theme</Text>
            <View style={styles.segmentedRow}>
              {(['system', 'dark', 'light'] as ThemeMode[]).map((mode) => {
                const sel = appearance.themeMode === mode;
                return (
                  <Pressable
                    key={mode}
                    onPress={() => appearance.setThemeMode(mode)}
                    style={[
                      styles.segment,
                      sel ? styles.segmentActive : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        sel ? styles.segmentTextActive : null,
                      ]}
                    >
                      {themeModeLabel(mode)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <View style={[styles.appearanceGroup, { borderTopWidth: 1, borderTopColor: overlay(0.05) }]}>
            <Text style={styles.appearanceLabel}>Minimum font size</Text>
            <Text style={styles.appearanceValue}>{appearance.minFontSize} pt</Text>
            <View style={styles.stepperRow}>
              <Pressable
                onPress={() => appearance.setMinFontSize(appearance.minFontSize - 1)}
                style={styles.stepperButton}
                hitSlop={8}
              >
                <Text style={styles.stepperText}>−</Text>
              </Pressable>
              <Text style={styles.stepperValue}>{appearance.minFontSize}</Text>
              <Pressable
                onPress={() => appearance.setMinFontSize(appearance.minFontSize + 1)}
                style={styles.stepperButton}
                hitSlop={8}
              >
                <Text style={styles.stepperText}>+</Text>
              </Pressable>
            </View>
            <View style={styles.sizeChips}>
              {FONT_SIZE_OPTIONS.map((size) => {
                const sel = size === appearance.minFontSize;
                return (
                  <Pressable
                    key={size}
                    onPress={() => appearance.setMinFontSize(size)}
                    style={[
                      styles.sizeChip,
                      sel ? styles.sizeChipActive : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.sizeChipText,
                        sel ? styles.sizeChipTextActive : null,
                      ]}
                    >
                      {size}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Section>

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
      <UpdateModal
        info={eas.available}
        downloading={eas.downloading}
        error={eas.error}
        onInstall={() => { void eas.downloadAndReload(); }}
        onDismiss={eas.dismiss}
      />
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useThemedStyles(() => makeStyles(), []);
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
        backgroundColor: pressed ? overlay(0.04) : 'transparent',
        borderBottomWidth: 1,
        borderBottomColor: overlay(0.04),
      })}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: Fonts.sans,
          fontSize: fs(14),
          color: destructive ? Theme.danger : Theme.text,
        }}
      >
        {label}
      </Text>
      {subText ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: Theme.textMuted }}>{subText}</Text>
      ) : (
        <Text style={{ color: Theme.textFaint, fontSize: fs(12) }}>›</Text>
      )}
    </Pressable>
  );
}

function themeModeLabel(mode: ThemeMode): string {
  switch (mode) {
    case 'dark': return 'Dark';
    case 'light': return 'Light';
    case 'system': return 'System';
  }
}

function makeStyles() {
  return StyleSheet.create({
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
      fontSize: fs(14),
      color: Theme.text,
    },
    sectionHeader: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(11),
      color: withAlpha(Theme.textMuted, 0.6),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    card: {
      backgroundColor: overlay(0.04),
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
      fontSize: fs(13),
      color: Theme.textFaint,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    appearanceGroup: {
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    appearanceLabel: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(13),
      color: Theme.text,
      marginBottom: 8,
    },
    appearanceValue: {
      fontFamily: Fonts.sans,
      fontSize: fs(12),
      color: Theme.textMuted,
      marginBottom: 8,
    },
    segmentedRow: {
      flexDirection: 'row',
      backgroundColor: overlay(0.06),
      borderRadius: 10,
      padding: 2,
    },
    segment: {
      flex: 1,
      paddingVertical: 8,
      alignItems: 'center',
      borderRadius: 8,
    },
    segmentActive: {
      backgroundColor: overlay(0.12),
    },
    segmentText: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(13),
      color: Theme.textMuted,
    },
    segmentTextActive: {
      color: Theme.text,
    },
    stepperRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 24,
      marginBottom: 12,
    },
    stepperButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: overlay(0.08),
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperText: {
      fontSize: fs(18),
      color: Theme.text,
      fontFamily: Fonts.sansMedium,
    },
    stepperValue: {
      fontFamily: Fonts.sansSemiBold,
      fontSize: fs(18),
      color: Theme.text,
      minWidth: 32,
      textAlign: 'center',
    },
    sizeChips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    sizeChip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: overlay(0.05),
    },
    sizeChipActive: {
      backgroundColor: Theme.accent,
    },
    sizeChipText: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(12),
      color: Theme.textMuted,
    },
    sizeChipTextActive: {
      color: '#fff',
    },
  });
}
