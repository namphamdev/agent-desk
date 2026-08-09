// SessionView — RN port of SessionView.swift. Transcript + status strip +
// composer (or question panel while input is requested).

import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify, useSessionStore } from '../lib/hooks';
import { ComposerView } from '../components/ComposerView';
import { QuestionPanel } from '../components/QuestionPanel';
import { TranscriptView } from '../components/TranscriptView';
import { WorkingSpinner } from '../components/Loaders';
import {
  baseName,
  chatDisplayTitle,
  effectiveStatus,
  nowMs,
} from '../models/Entities';
import { flavourSeed, flavourWord, formatElapsed } from '../theme/Motion';
import { Fonts, Theme } from '../theme/Theme';
import { withAlpha } from '../theme/color';

interface Props {
  model: AppModel;
  chatId: string;
  onBack: () => void;
  onOpenChanges: () => void;
  onOpenConfig: () => void;
}

export function SessionView({ model, chatId, onBack, onOpenChanges, onOpenConfig }: Props) {
  useForceUpdateOnNotify(model);
  const chat = model.chat(chatId);
  const store = chat ? model.sessionStoreFor(chat) : undefined;
  useSessionStore(store!);

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (chat) model.markSeen(chatId);
    model.notifications.activeChatId = chatId;
    return () => {
      if (chat) model.markSeen(chatId);
      if (model.notifications.activeChatId === chatId) {
        model.notifications.activeChatId = undefined;
      }
    };
  }, [chat?.id, chatId, model]);

  if (!chat || !store) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: Theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: Theme.textFaint, fontFamily: Fonts.sans, fontSize: 12 }}>
          Opening session…
        </Text>
      </SafeAreaView>
    );
  }

  const status = effectiveStatus(
    model.demo?.sessions[chat.id] ?? model.workspace?.sessions[chat.id],
    nowMs(),
  );
  const openInput = store.openInputRequest;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.bg }} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardAvoidingView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <SessionHeader
          chat={chat}
          model={model}
          onBack={onBack}
          onOpenConfig={onOpenConfig}
          onOpenChanges={chat.cwd ? onOpenChanges : undefined}
        />
        <View style={{ flex: 1 }}>
          <TranscriptView store={store} chatId={chat.id} />
          <View pointerEvents="none" style={styles.statusStrip}>
            {status === 'working' ? (
              <>
                <WorkingSpinner />
                <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: Theme.textMuted, marginLeft: 6 }}>
                  {flavourWord(flavourSeed(chat.id), (nowMs() - sessionStartedAt(model, chat.id)) / 1000)}…
                </Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 11, color: Theme.textFaint, marginLeft: 4 }}>
                  {formatElapsed((nowMs() - sessionStartedAt(model, chat.id)) / 1000)}
                </Text>
              </>
            ) : status === 'errored' ? (
              <Text style={{ fontFamily: Fonts.sans, fontSize: 11, color: Theme.danger }}>Run failed</Text>
            ) : null}
          </View>
        </View>
        {openInput ? (
          <QuestionPanel
            requestId={openInput.requestId}
            questions={openInput.questions}
            onRespond={(rid, answers) => store.respondInput(rid, answers)}
          />
        ) : (
          <ComposerView store={store} chat={chat} runLive={status === 'working'} />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function sessionStartedAt(model: AppModel, chatId: string): number {
  const row = model.demo?.sessions[chatId] ?? model.workspace?.sessions[chatId];
  return (row as { startedAt?: number; updatedAt?: number })?.startedAt
    ?? (row as { updatedAt?: number })?.updatedAt
    ?? nowMs();
}

function SessionHeader({
  chat,
  model,
  onBack,
  onOpenConfig,
  onOpenChanges,
}: {
  chat: import('../models/Entities').Chat;
  model: AppModel;
  onBack: () => void;
  onOpenConfig: () => void;
  onOpenChanges?: () => void;
}) {
  const harness = chat.config?.harness ?? 'claude-code';
  const subtitle = (() => {
    const parts: string[] = [];
    if (chat.cwd) parts.push(baseName(chat.cwd));
    if (chat.branch && chat.branch.length > 0) parts.push(chat.branch);
    parts.push(model.deviceNameFor(chat.deviceId));
    return parts.join(' · ');
  })();
  return (
    <View style={headerStyles.bar}>
      <Pressable
        onPress={onBack}
        hitSlop={{ top: 16, bottom: 16, left: 16, right: 8 }}
        style={headerStyles.backButton}
      >
        <Text style={{ color: Theme.text, fontSize: 22 }}>‹</Text>
      </Pressable>
      <Pressable
        onPress={onOpenConfig}
        style={headerStyles.configButton}
      >
        <Text style={{ fontFamily: Fonts.sansMedium, fontSize: 13, color: Theme.text }} numberOfLines={1}>
          {harnessLabel(harness)} · {chatDisplayTitle(chat)} ▾
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 10.5, color: withAlpha(Theme.textMuted, 0.6) }} numberOfLines={1}>
          {subtitle}
        </Text>
      </Pressable>
      {onOpenChanges ? (
        <Pressable onPress={onOpenChanges} hitSlop={12}>
          <Text style={{ color: Theme.text, fontSize: 14 }}>⋯</Text>
        </Pressable>
      ) : (
        <View style={{ width: 28 }} />
      )}
    </View>
  );
}

function harnessLabel(harness: string): string {
  switch (harness) {
    case 'claude-code': return 'Claude';
    case 'codex': return 'Codex';
    case 'acp': return 'ACP';
    default: return harness;
  }
}

const styles = StyleSheet.create({
  keyboardAvoidingView: {
    flex: 1,
  },
  statusStrip: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 24,
    paddingHorizontal: 26,
    flexDirection: 'row',
    alignItems: 'center',
  },
});

const headerStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Theme.border,
  },
  // Fixed-width back affordance with its own padding so the config button
  // (flex:1) can't steal edge taps meant for back. The 44pt width matches
  // Apple's minimum hit target; hitSlop adds a guard band beyond that.
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  configButton: {
    flex: 1,
    alignItems: 'center',
    marginLeft: 4,
  },
});


