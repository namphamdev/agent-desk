// SessionView — RN port of SessionView.swift. Transcript + status strip +
// composer (or question panel while input is requested).

import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify, useSessionStore } from '../lib/hooks';
import { ComposerView } from '../components/ComposerView';
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
import { withAlpha, whiteAlpha } from '../theme/color';

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
        <Text style={{ color: Theme.text, fontSize: 22 }}>‹</Text>
      </Pressable>
      <Pressable
        onPress={onOpenConfig}
        style={headerStyles.configButton}
      >
        <Text style={{ fontFamily: Fonts.sansMedium, fontSize: 13, color: Theme.text }} numberOfLines={1}>
          {modelLabel ? `${modelLabel} · ` : ''}{chatDisplayTitle(chat)} ▾
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

// MARK: - Composer config chip

function ConfigChipButton({
  onPress,
  label,
  leading,
  trailing,
}: {
  onPress: () => void;
  label: string;
  leading?: React.ReactNode;
  trailing?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 12,
        height: 34,
        borderRadius: 17,
        backgroundColor: pressed ? whiteAlpha(0.16) : whiteAlpha(0.1),
      })}
    >
      {leading}
      <Text
        style={{ fontFamily: Fonts.sansMedium, fontSize: 12.5, color: withAlpha(Theme.text, 0.9) }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {trailing ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 11, color: Theme.textMuted }}>
          {trailing}
        </Text>
      ) : null}
    </Pressable>
  );
}

// MARK: - Session config sheet (view/change agent + model)

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
  const [acpAgents, setAcpAgents] = useState<import('../models/Entities').InstalledAcpAgent[]>([]);
  const [catalogs, setCatalogs] = useState<Record<string, import('../models/HarnessCatalog').ModelInfo[]>>({});
  const [modelSearch, setModelSearch] = useState('');

  useEffect(() => {
    if (!space) return;
    void (async () => {
      const snap = await model.acpAgents(space.deviceId);
      if (snap) setAcpAgents(snap.installed);
    })();
  }, [space, model]);

  // Fetch the model catalog from the device whenever the harness changes.
  // ACP agents expose their own model lists via ListModels with acpAgentId.
  useEffect(() => {
    if (!space) return;
    void (async () => {
      const cat = await model.listModels(space, harness);
      setCatalogs((prev) => ({ ...prev, [harness]: cat }));
      // If the current model id isn't in the fetched catalog, snap to the
      // first entry so the picker never shows a stale selection.
      if (cat.length > 0 && !cat.some((m) => m.id === modelId)) {
        setModelId(cat[0].id);
      }
    })();
  }, [space, harness, model]);

  const models = catalogs[harness] ?? HarnessCatalog.modelsFor(harness);
  const filteredModels = models.filter((m) => {
    const query = modelSearch.trim().toLowerCase();
    return query.length === 0 || `${m.label} ${m.id} ${m.description ?? ''}`.toLowerCase().includes(query);
  });
  const selectedModel = models.find((m) => m.id === modelId) ?? models[0];
  const effectiveReasoning = (() => {
    if (selectedModel.reasoningLevels.length === 0) return undefined;
    if (reasoning && selectedModel.reasoningLevels.includes(reasoning)) return reasoning;
    return HarnessCatalog.defaultReasoningFor(selectedModel) ?? undefined;
  })();

  const selectedAcpAgent = (() => {
    const agentId = HarnessCatalog.acpAgentIdFromHarness(harness);
    if (!agentId) return null;
    return acpAgents.find((a) => a.id === agentId) ?? null;
  })();

  const persist = (next: Partial<{
    harness: string;
    modelId: string;
    reasoning: string | undefined;
    permissionMode: PermissionModeValue;
  }>) => {
    const nextHarness = next.harness ?? harness;
    const nextModelId = next.modelId ?? modelId;
    const nextReasoning = next.reasoning !== undefined ? next.reasoning : effectiveReasoning;
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

  // Build the dynamic harness list: built-in harnesses + one entry per
  // installed ACP agent.
  const allHarnesses: import('../models/HarnessCatalog').HarnessInfo[] = [
    ...HarnessCatalog.harnesses,
    ...acpAgents.map((agent) => ({
      id: HarnessCatalog.acpAgentHarnessId(agent.id),
      label: agent.name,
    })),
  ];

  return (
    <View style={sheetStyles.backdrop}>
      <Pressable style={sheetStyles.scrim} onPress={onClose} />
      <View style={sheetStyles.panel}>
        <View style={sheetStyles.header}>
          <Text style={sheetStyles.title}>Session settings</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={{ color: Theme.text, fontSize: 13 }}>✕</Text>
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
          <Text style={sheetStyles.label}>Agent</Text>
          <View style={sheetStyles.harnessRow}>
            {allHarnesses.map((h) => {
              const sel = h.id === harness;
              const wireHarness = HarnessCatalog.isAcpAgentHarness(h.id)
                ? HarnessCatalog.ACP_WIRE
                : h.id;
              return (
                <Pressable
                  key={h.id}
                  onPress={() => {
                    if (h.id === harness) return;
                    setHarness(h.id);
                    const fallback = HarnessCatalog.defaultModelFor(h.id);
                    setModelId(fallback.id);
                    setReasoning(HarnessCatalog.defaultReasoningFor(fallback) ?? undefined);
                    persist({
                      harness: h.id,
                      modelId: fallback.id,
                      reasoning: HarnessCatalog.defaultReasoningFor(fallback) ?? undefined,
                    });
                  }}
                  style={[sheetStyles.harness, { backgroundColor: sel ? whiteAlpha(0.15) : whiteAlpha(0.05) }]}
                >
                  <BrandMark harness={wireHarness} size={15} color={Theme.text} dimmed={!sel} />
                  <Text style={[sheetStyles.harnessText, { color: sel ? Theme.text : Theme.textMuted }]}>{h.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={sheetStyles.label}>Model</Text>
          <View style={sheetStyles.searchBox}>
            <Text style={sheetStyles.searchIcon}>⌕</Text>
            <TextInput
              value={modelSearch}
              onChangeText={setModelSearch}
              placeholder="Search models"
              placeholderTextColor={Theme.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              style={sheetStyles.searchInput}
            />
          </View>
          <View style={sheetStyles.modelList}>
            <ScrollView nestedScrollEnabled style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 4 }}>
              {filteredModels.length === 0 ? (
                <Text style={sheetStyles.emptyText}>No models found.</Text>
              ) : filteredModels.map((m, ix) => {
                const sel = m.id === (models.find((x) => x.id === modelId) ?? models[0]).id;
                return (
                  <React.Fragment key={m.id}>
                    <Pressable
                      onPress={() => {
                        setModelId(m.id);
                        const nextReasoning = (!m.reasoningLevels.includes(effectiveReasoning ?? '')
                          ? HarnessCatalog.defaultReasoningFor(m) ?? undefined
                          : effectiveReasoning);
                        setReasoning(nextReasoning);
                        persist({ modelId: m.id, reasoning: nextReasoning });
                      }}
                      style={({ pressed }) => [sheetStyles.option, { backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent' }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={sheetStyles.optionTitle}>{m.label}</Text>
                        {m.description ? <Text style={sheetStyles.optionDescription}>{m.description}</Text> : null}
                      </View>
                      <Text style={[sheetStyles.checkmark, { opacity: sel ? 1 : 0 }]}>✓</Text>
                    </Pressable>
                    {ix < filteredModels.length - 1 ? <View style={sheetStyles.separator} /> : null}
                  </React.Fragment>
                );
              })}
            </ScrollView>
          </View>

          {selectedModel.reasoningLevels.length > 0 ? (
            <>
              <Text style={sheetStyles.label}>Reasoning</Text>
              <View style={sheetStyles.card}>
                {selectedModel.reasoningLevels.map((level, ix) => (
                  <React.Fragment key={level}>
                    <Pressable
                      onPress={() => {
                        setReasoning(level);
                        persist({ reasoning: level });
                      }}
                      style={({ pressed }) => [sheetStyles.option, { backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent' }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={sheetStyles.optionTitle}>{HarnessCatalog.reasoningLabel(level)}</Text>
                        {HarnessCatalog.effortHint(level) ? <Text style={sheetStyles.optionDescription}>{HarnessCatalog.effortHint(level)}</Text> : null}
                      </View>
                      <Text style={[sheetStyles.checkmark, { opacity: effectiveReasoning === level ? 1 : 0 }]}>✓</Text>
                    </Pressable>
                    {ix < selectedModel.reasoningLevels.length - 1 ? <View style={sheetStyles.separator} /> : null}
                  </React.Fragment>
                ))}
              </View>
            </>
          ) : null}

          <Text style={sheetStyles.label}>Permission mode</Text>
          <View style={sheetStyles.card}>
            {(
              [
                { value: 'default', label: 'Default', description: 'Prompts before writing files' },
                { value: 'plan', label: 'Plan', description: 'Read-only mode, no file edits' },
                { value: 'accept-edits', label: 'Accept edits', description: 'Auto-approves workspace file edits' },
                { value: 'full-access', label: 'Full access', description: 'Bypasses all sandbox and approval prompts' },
              ] as { value: PermissionModeValue; label: string; description: string }[]
            ).map((mode, ix, arr) => (
              <React.Fragment key={mode.value}>
                <Pressable
                  onPress={() => {
                    setPermissionMode(mode.value);
                    persist({ permissionMode: mode.value });
                  }}
                  style={({ pressed }) => [sheetStyles.option, { backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent' }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={sheetStyles.optionTitle}>{mode.label}</Text>
                    <Text style={sheetStyles.optionDescription}>{mode.description}</Text>
                  </View>
                  <Text style={[sheetStyles.checkmark, { opacity: permissionMode === mode.value ? 1 : 0 }]}>✓</Text>
                </Pressable>
                {ix < arr.length - 1 ? <View style={sheetStyles.separator} /> : null}
              </React.Fragment>
            ))}
          </View>

          {/* Summary of the active saved config so the user can verify the
              persisted state at a glance. */}
          <View style={sheetStyles.summary}>
            <Text style={sheetStyles.summaryLabel}>Saved for this session</Text>
            <Text style={sheetStyles.summaryValue}>
              {selectedAcpAgent ? selectedAcpAgent.name : harnessLabel(HarnessCatalog.isAcpAgentHarness(harness) ? HarnessCatalog.ACP_WIRE : harness)}
              {' · '}
              {selectedModel.label}
              {effectiveReasoning ? ` · ${HarnessCatalog.reasoningLabel(effectiveReasoning)}` : ''}
            </Text>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const sheetStyles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'flex-end',
  },
  scrim: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  panel: {
    height: '80%',
    backgroundColor: '#141414',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  harnessRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 16,
  },
  harness: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    height: 36,
    borderRadius: 18,
  },
  harnessText: {
    fontFamily: Fonts.sansMedium,
    fontSize: 13,
  },
  label: {
    fontFamily: Fonts.sansMedium,
    fontSize: 11,
    color: withAlpha(Theme.textMuted, 0.6),
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 4,
  },
  card: {
    backgroundColor: whiteAlpha(0.045),
    borderColor: whiteAlpha(0.06),
    borderWidth: 1,
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 8,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 42,
    paddingHorizontal: 12,
    marginBottom: 10,
    borderRadius: 12,
    backgroundColor: whiteAlpha(0.06),
    borderWidth: 1,
    borderColor: Theme.border,
  },
  searchIcon: {
    color: Theme.textMuted,
    fontSize: 22,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    padding: 0,
    fontFamily: Fonts.sans,
    fontSize: 14,
    color: Theme.text,
  },
  modelList: {
    height: 280,
    borderRadius: 20,
    backgroundColor: whiteAlpha(0.045),
    borderColor: whiteAlpha(0.06),
    borderWidth: 1,
    marginBottom: 8,
    overflow: 'hidden',
  },
  emptyText: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Theme.textFaint,
    padding: 20,
    textAlign: 'center',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  optionTitle: {
    fontFamily: Fonts.sans,
    fontSize: 15,
    color: Theme.text,
  },
  optionDescription: {
    fontFamily: Fonts.sans,
    fontSize: 12.5,
    color: Theme.textMuted,
    marginTop: 2,
  },
  checkmark: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Theme.text,
  },
  separator: {
    height: 1,
    backgroundColor: whiteAlpha(0.06),
    marginLeft: 16,
  },
  summary: {
    marginTop: 16,
    padding: 14,
    borderRadius: 14,
    backgroundColor: whiteAlpha(0.04),
  },
  summaryLabel: {
    fontFamily: Fonts.sansMedium,
    fontSize: 10.5,
    color: withAlpha(Theme.textMuted, 0.6),
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  summaryValue: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Theme.text,
  },
});



