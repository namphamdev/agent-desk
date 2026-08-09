// UpdateModal — presents an available EAS update with its changelog message
// and installs it (fetch + reload). Shown when `info` is non-null.
//
// The modal is transparent-overlay, card-styled to match the rest of the app
// (mono dark surface). When the changelog message is empty we fall back to a
// neutral line so the card never reads as broken.

import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { EasUpdateInfo } from '../lib/useEasUpdate';
import { Fonts, overlay, Theme } from '../theme/Theme';
import { fs, useThemedStyles } from '../theme/Appearance';

interface Props {
  info: EasUpdateInfo | null;
  /** True while the update bundle downloads (after the user taps Install). */
  downloading: boolean;
  /** Error message from the last fetch attempt, if any. */
  error: string | null;
  onInstall: () => void;
  onDismiss: () => void;
}

export function UpdateModal({ info, downloading, error, onInstall, onDismiss }: Props) {
  const visible = info !== null;
  const styles = useThemedStyles(() => makeStyles(), []);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>Update available</Text>

          {info && (
            <Text style={styles.meta}>
              {info.createdAt ? new Date(info.createdAt).toLocaleDateString() : ''}
            </Text>
          )}

          <ScrollView style={styles.changelogScroll}>
            <Text style={styles.changelog}>
              {info?.message?.trim() || 'A new version of AgentDeski is available.'}
            </Text>
          </ScrollView>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.actions}>
            <Pressable
              onPress={onDismiss}
              disabled={downloading}
              style={({ pressed }) => [
                styles.secondaryBtn,
                pressed && { backgroundColor: overlay(0.06) },
                downloading && styles.disabled,
              ]}
            >
              <Text style={styles.secondaryText}>Later</Text>
            </Pressable>

            <Pressable
              onPress={onInstall}
              disabled={downloading}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && { opacity: 0.85 },
                downloading && styles.disabled,
              ]}
            >
              {downloading ? (
                <ActivityIndicator color={Theme.bg} size="small" />
              ) : (
                <Text style={styles.primaryText}>Install &amp; restart</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles() {
  return StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: Theme.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 20,
  },
  title: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: fs(17),
    color: Theme.text,
  },
  meta: {
    fontFamily: Fonts.sans,
    fontSize: fs(12),
    color: Theme.textFaint,
    marginTop: 4,
  },
  changelogScroll: {
    maxHeight: 220,
    marginTop: 16,
  },
  changelog: {
    fontFamily: Fonts.sans,
    fontSize: fs(14),
    lineHeight: 20,
    color: Theme.textMuted,
  },
  error: {
    fontFamily: Fonts.sans,
    fontSize: fs(12),
    color: Theme.danger,
    marginTop: 12,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 20,
  },
  secondaryBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  secondaryText: {
    fontFamily: Fonts.sansMedium,
    fontSize: fs(14),
    color: Theme.textMuted,
  },
  primaryBtn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: Theme.text,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: fs(14),
    color: Theme.bg,
  },
  disabled: {
    opacity: 0.5,
  },
  });
}
