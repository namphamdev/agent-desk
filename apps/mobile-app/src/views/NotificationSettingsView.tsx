// NotificationSettingsView — RN port of NotificationSettingsView.swift.
// Toggles for the three notification categories (task-done, input-needed,
// task-failed) backed by AsyncStorage.

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { NotificationManager } from '../notifications/NotificationManager';
import { Fonts, overlay, Theme } from '../theme/Theme';
import { fs, useThemedStyles } from '../theme/Appearance';

interface Props {
  model: AppModel;
  onBack: () => void;
}

export function NotificationSettingsView({ model, onBack }: Props) {
  const styles = useThemedStyles(() => makeStyles(), []);
  const [done, setDone] = useState(true);
  const [input, setInput] = useState(true);
  const [perm, setPerm] = useState<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      setDone(NotificationManager.shared.taskDoneEnabled);
      setInput(NotificationManager.shared.inputNeededEnabled);
      await NotificationManager.shared.refreshAuthStatus();
      setPerm(NotificationManager.shared.canSendNotifications);
    })();
  }, []);

  const toggleDone = (value: boolean) => {
    NotificationManager.shared.setTaskDone(value);
    setDone(value);
  };

  const toggleInput = (value: boolean) => {
    NotificationManager.shared.setInputNeeded(value);
    setInput(value);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ color: Theme.text, fontSize: fs(22) }}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Notifications</Text>
        <View style={{ width: 28 }} />
      </View>
      {perm === false ? (
        <View style={styles.banner}>
          <Text style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: Theme.warning }}>
            Notifications are disabled in system settings.
          </Text>
        </View>
      ) : null}
      <View style={{ padding: 16, gap: 8 }}>
        <ToggleRow
          icon="✓"
          label="Task completed"
          description="When a session goes idle after working."
          value={done}
          onValueChange={toggleDone}
        />
        <ToggleRow
          icon="?"
          label="Input needed"
          description="When a session is waiting for your response."
          value={input}
          onValueChange={toggleInput}
        />
      </View>
    </SafeAreaView>
  );
}

function ToggleRow({ icon, label, description, value, onValueChange }: {
  icon: string;
  label: string;
  description: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const styles = useThemedStyles(() => makeStyles(), []);
  return (
    <View style={styles.row}>
      <Text style={styles.icon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: overlay(0.1), true: overlay(0.25) }}
        thumbColor={value ? Theme.text : Theme.textFaint}
      />
    </View>
  );
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
    banner: {
      margin: 12,
      padding: 12,
      backgroundColor: 'rgba(255,180,0,0.08)',
      borderRadius: 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: overlay(0.04),
      borderRadius: 16,
    },
    icon: {
      fontSize: fs(14),
      color: Theme.textMuted,
    },
    label: {
      fontFamily: Fonts.sans,
      fontSize: fs(14),
      color: Theme.text,
    },
    description: {
      fontFamily: Fonts.sans,
      fontSize: fs(12),
      color: Theme.textMuted,
      marginTop: 2,
    },
  });
}
