// Composer — RN port of ComposerView.swift. The glass shell, the
// compact↔expanded flip (deterministic by newline / >26 chars), the
// Send→Steer→Stop morph on the action button.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Fonts, Theme } from '../theme/Theme';
import { whiteAlpha } from '../theme/color';
import type { Chat } from '../models/Entities';
import type { SessionStore } from '../sync/SessionStore';

interface ShellProps {
  draft: string;
  setDraft: (s: string) => void;
  placeholder?: string;
  sendEnabled: boolean;
  showStop: boolean;
  busy?: boolean;
  onSend: () => void;
  onStop?: () => void;
  chips?: React.ReactNode;
}

export function ComposerShell({
  draft,
  setDraft,
  placeholder = 'Message',
  sendEnabled,
  showStop,
  busy = false,
  onSend,
  onStop,
  chips,
}: ShellProps) {
  const [focused, setFocused] = useState(false);
  const expanded = chips !== undefined || draft.includes('\n') || draft.length > 26;

  // Compact↔expanded flip uses a layout animation so the row transition is
  // smooth (matches SwiftUI's `Motion.collapse`).
  useEffect(() => {
    if (Platform.OS === 'android') return;
    LayoutAnimation.configureNext({
      duration: 180,
      update: { type: LayoutAnimation.Types.easeOut },
    });
  }, [expanded]);

  const buttonActive = (() => {
    if (showStop && draft.trim().length === 0) return true;
    return sendEnabled && draft.trim().length > 0 && !busy;
  })();

  const onPress = () => {
    if (showStop && draft.trim().length === 0) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onStop?.();
    } else {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onSend();
    }
  };

  const input = (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      placeholder={placeholder}
      placeholderTextColor={Theme.textFaint}
      multiline
      style={{
        fontFamily: Fonts.sans,
        fontSize: 16,
        color: Theme.text,
        paddingHorizontal: 0,
        paddingVertical: 0,
        margin: 0,
        minHeight: 24,
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    />
  );

  const actionButton = (
    <Pressable
      onPress={onPress}
      disabled={!buttonActive}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: buttonActive
          ? (showStop && draft.trim().length === 0 ? Theme.text : Theme.text)
          : whiteAlpha(0.1),
        opacity: buttonActive ? (pressed ? 0.85 : 1) : 1,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={Theme.bg} />
      ) : showStop && draft.trim().length === 0 ? (
        <View
          style={{
            width: 12,
            height: 12,
            borderRadius: 3.5,
            backgroundColor: Theme.bg,
          }}
        />
      ) : (
        <Text style={{ color: buttonActive ? Theme.bg : Theme.textFaint, fontSize: 16, fontWeight: '700' }}>
          ↑
        </Text>
      )}
    </Pressable>
  );

  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        marginHorizontal: focused ? 10 : 16,
        paddingBottom: insets.bottom,
      }}
    >
      <View
        style={[
          styles.shell,
          {
            flexDirection: expanded ? 'column' : 'row',
            paddingHorizontal: expanded ? 0 : 20,
            paddingTop: expanded ? 15 : 8,
            paddingBottom: expanded ? 0 : 8,
            alignItems: expanded ? 'stretch' : 'center',
          },
        ]}
      >
        <View style={{ flex: expanded ? 0 : 1, paddingHorizontal: expanded ? 20 : 0 }}>
          {input}
        </View>
        {expanded ? (
          <View
            style={styles.expandedActionRow}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
              {chips}
            </ScrollView>
            {actionButton}
          </View>
        ) : (
          <View style={styles.compactActionSlot}>{actionButton}</View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    gap: 12,
    backgroundColor: whiteAlpha(0.04),
    borderColor: whiteAlpha(0.05),
    borderWidth: 1,
    borderRadius: 28,
    overflow: 'hidden',
  },
  compactActionSlot: {
    paddingLeft: 4,
  },
  expandedActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
});

interface ComposerViewProps {
  store: SessionStore;
  chat: Chat;
  runLive: boolean;
}

export function ComposerView({ store, chat, runLive }: ComposerViewProps) {
  const [text, setText] = useState('');

  const send = () => {
    const prompt = text.trim();
    if (prompt.length === 0) return;
    if (runLive) {
      store.sendSteer(prompt);
    } else {
      store.sendRun(prompt, chat);
    }
    setText('');
    // The clear above is unconditional; some keyboards re-commit pending
    // autocorrect AFTER the change, restoring the prompt. Re-clear on the
    // next tick so a prompt never lingers after a send.
    setTimeout(() => setText(''), 0);
  };

  return (
    <ComposerShell
      draft={text}
      setDraft={setText}
      sendEnabled={true}
      showStop={runLive}
      onSend={send}
      onStop={() => store.sendInterrupt()}
    />
  );
}
