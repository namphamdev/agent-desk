// SessionView — RN port of SessionView.swift. Transcript + status strip +
// composer (or question panel while input is requested).

import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify, useSessionStore } from '../lib/hooks';
import { ComposerView } from '../components/ComposerView';
import { ModelConfigSheet, ConfigChipButton } from '../components/ModelConfigSheet';
import { QuestionPanel } from '../components/QuestionPanel';
import { TranscriptView } from '../components/TranscriptView';
import { WorkingSpinner } from '../components/Loaders';
import {
  baseName,
  Chat,
  chatDisplayTitle,
  ChatConfig,
  effectiveStatus,
  nowMs,
  PermissionModeValue,
  permissionModeMeta,
} from '../models/Entities';
import { HarnessCatalog } from '../models/HarnessCatalog';
import { BrandMark } from '../theme/BrandMark';
import { flavourSeed, flavourWord, formatElapsed } from '../theme/Motion';
import { Fonts, Theme } from '../theme/Theme';
import { fs, useThemedStyles } from '../theme/Appearance';
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
  const styles = useThemedStyles(() => makeStyles(), []);
  const chat = model.chat(chatId);
  const store = chat ? model.sessionStoreFor(chat) : undefined;
  useSessionStore(store!);

  const [, setTick] = useState(0);
  const [showConfigSheet, setShowConfigSheet] = useState(false);

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
        <Text style={{ color: Theme.textFaint, fontFamily: Fonts.sans, fontSize: fs(12) }}>
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

  // Resolve the chat's saved harness/model into display state. The harness
  // stored on the wire is one of: "claude-code", "codex", "acp" (with
  // acpAgentId). For ACP, synthesize the picker harness id so the chip
  // shows the agent name.
  const cfg = chat.config;
  const wireHarness = cfg?.harness ?? 'claude-code';
  const pickerHarness = wireHarness === 'acp' && cfg?.acpAgentId
    ? HarnessCatalog.acpAgentHarnessId(cfg.acpAgentId)
    : wireHarness;
  const modelLabel = HarnessCatalog.modelLabel(wireHarness, cfg?.model);
  const reasoningLabel = cfg?.reasoning
    ? HarnessCatalog.reasoningLabel(cfg.reasoning)
    : undefined;
  const permMode = cfg?.permissionMode
    ? permissionModeMeta(cfg.permissionMode)
    : permissionModeMeta('default');

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
                <Text style={{ fontFamily: Fonts.sans, fontSize: fs(12), color: Theme.textMuted, marginLeft: 6 }}>
                  {flavourWord(flavourSeed(chat.id), (nowMs() - sessionStartedAt(model, chat.id)) / 1000)}…
                </Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: fs(11), color: Theme.textFaint, marginLeft: 4 }}>
                  {formatElapsed((nowMs() - sessionStartedAt(model, chat.id)) / 1000)}
                </Text>
              </>
            ) : status === 'errored' ? (
              <Text style={{ fontFamily: Fonts.sans, fontSize: fs(11), color: Theme.danger }}>Run failed</Text>
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
          <ComposerView
            store={store}
            chat={chat}
            runLive={status === 'working'}
            chips={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <ConfigChipButton
                  onPress={() => setShowConfigSheet(true)}
                  leading={
                    <BrandMark
                      harness={HarnessCatalog.isAcpAgentHarness(pickerHarness) ? HarnessCatalog.ACP_WIRE : wireHarness}
                      size={13}
                      color={Theme.text}
                    />
                  }
                  label={modelLabel}
                  trailing={reasoningLabel}
                />
                <ConfigChipButton
                  onPress={() => setShowConfigSheet(true)}
                  label={permMode.label}
                />
              </View>
            }
          />
        )}
      </KeyboardAvoidingView>

      {showConfigSheet ? (
        <SessionConfigSheet
          model={model}
          chat={chat}
          onClose={() => setShowConfigSheet(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

// Thin wrapper around the shared ModelConfigSheet that loads the chat's
// saved config and persists changes via model.setChatConfig.
function SessionConfigSheet({
  model,
  chat,
  onClose,
}: {
  model: AppModel;
  chat: Chat;
  onClose: () => void;
}) {
  const space = model.spaceFor(chat);
  const cfg = chat.config;
  const [harness, setHarness] = useState(
    cfg?.harness === 'acp' && cfg.acpAgentId
      ? HarnessCatalog.acpAgentHarnessId(cfg.acpAgentId)
      : cfg?.harness ?? 'claude-code',
  );
  const [modelId, setModelId] = useState(cfg?.model ?? HarnessCatalog.defaultModelFor(harness).id);
  const [reasoning, setReasoning] = useState(cfg?.reasoning);
  const [permissionMode, setPermissionMode] = useState<PermissionModeValue>(
    cfg?.permissionMode ?? 'default',
  );

  const persist = (next: Partial<{
    harness: string;
    modelId: string;
    reasoning: string | undefined;
    permissionMode: PermissionModeValue;
  }>) => {
    const nextHarness = next.harness ?? harness;
    const nextModelId = next.modelId ?? modelId;
    const nextReasoning = next.reasoning !== undefined ? next.reasoning : reasoning;
    const nextPermissionMode = next.permissionMode ?? permissionMode;
    const wireHarness = HarnessCatalog.isAcpAgentHarness(nextHarness)
      ? HarnessCatalog.ACP_WIRE
      : nextHarness;
    const wireAcpAgentId = HarnessCatalog.acpAgentIdFromHarness(nextHarness);
    const mode = permissionModeMeta(nextPermissionMode);
    const nextCfg: ChatConfig = {
      harness: wireHarness,
      model: nextModelId,
      reasoning: nextReasoning,
      sandbox: mode.sandbox,
      permissionMode: mode.value,
      ...(wireHarness === HarnessCatalog.ACP_WIRE && wireAcpAgentId
        ? { acpAgentId: wireAcpAgentId }
        : {}),
    };
    model.setChatConfig(chat.id, nextCfg);
  };

  return (
    <ModelConfigSheet
      model={model}
      space={space}
      title="Session settings"
      harness={harness}
      modelId={modelId}
      reasoning={reasoning}
      permissionMode={permissionMode}
      showSummary
      onHarnessChange={(h) => { setHarness(h); persist({ harness: h }); }}
      onModelChange={(m) => { setModelId(m); persist({ modelId: m }); }}
      onReasoningChange={(r) => { setReasoning(r); persist({ reasoning: r }); }}
      onPermissionModeChange={(m) => { setPermissionMode(m); persist({ permissionMode: m }); }}
      onClose={onClose}
    />
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
  const headerStyles = useThemedStyles(() => makeHeaderStyles(), []);
  const harness = chat.config?.harness ?? 'claude-code';
  const modelLabel = chat.config?.model
    ? HarnessCatalog.modelLabel(harness, chat.config.model)
    : undefined;
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
        <Text style={{ color: Theme.text, fontSize: fs(22) }}>‹</Text>
      </Pressable>
      <Pressable
        onPress={onOpenConfig}
        style={headerStyles.configButton}
      >
        <Text style={{ fontFamily: Fonts.sansMedium, fontSize: fs(13), color: Theme.text }} numberOfLines={1}>
          {modelLabel ? `${modelLabel} · ` : ''}{chatDisplayTitle(chat)} ▾
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: fs(10.5), color: withAlpha(Theme.textMuted, 0.6) }} numberOfLines={1}>
          {subtitle}
        </Text>
      </Pressable>
      {onOpenChanges ? (
        <Pressable onPress={onOpenChanges} hitSlop={12}>
          <Text style={{ color: Theme.text, fontSize: fs(14) }}>⋯</Text>
        </Pressable>
      ) : (
        <View style={{ width: 28 }} />
      )}
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
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
}

function makeHeaderStyles() {
  return StyleSheet.create({
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
}



