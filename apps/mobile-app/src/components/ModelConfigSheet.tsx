// Shared model/agent config bottom sheet — used by both NewSessionView
// (create new chat) and SessionView (existing chat). The SessionView layout
// is the canonical source of truth: vertical scroll with Agent harness row,
// Model list with search, Reasoning ladder, and Permission mode. Callers
// persist state via the onChange* callbacks; this component is presentational
// only (it fetches catalogs/acpAgents internally but does not touch AppModel
// persistence).
//
// Derived from the original SessionConfigSheet in SessionView.tsx.

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import type { AppModel } from '../app/AppModel';
import type { Space, InstalledAcpAgent, PermissionModeValue } from '../models/Entities';
import { PERMISSION_MODES, permissionModeMeta } from '../models/Entities';
import { HarnessCatalog } from '../models/HarnessCatalog';
import type { HarnessInfo, ModelInfo } from '../models/HarnessCatalog';
import { BrandMark } from '../theme/BrandMark';
import { Fonts, overlay, Theme } from '../theme/Theme';
import { fs, useThemedStyles } from '../theme/Appearance';
import { withAlpha } from '../theme/color';

export interface ModelConfigSheetProps {
  model: AppModel;
  space: Space | undefined;
  title: string;
  // Current selection state.
  harness: string;
  modelId: string;
  reasoning?: string;
  permissionMode: PermissionModeValue;
  // Lock harness switching (e.g. when not applicable).
  lockedHarness?: boolean;
  // Show the "Saved for this session" summary block at the bottom.
  showSummary?: boolean;
  // Callbacks — callers persist (AsyncStorage for new session, setChatConfig
  // for existing). All callbacks are optional so callers can opt out of
  // sections they don't need, but harness/model/permission are expected.
  onHarnessChange: (h: string) => void;
  onModelChange: (m: string) => void;
  onReasoningChange: (r: string | undefined) => void;
  onPermissionModeChange: (m: PermissionModeValue) => void;
  onClose: () => void;
}

export function ModelConfigSheet({
  model,
  space,
  title,
  harness,
  modelId,
  reasoning,
  permissionMode,
  lockedHarness,
  showSummary,
  onHarnessChange,
  onModelChange,
  onReasoningChange,
  onPermissionModeChange,
  onClose,
}: ModelConfigSheetProps) {
  const sheetStyles = useThemedStyles(() => makeSheetStyles(), []);
  const [acpAgents, setAcpAgents] = useState<InstalledAcpAgent[]>([]);
  const [catalogs, setCatalogs] = useState<Record<string, ModelInfo[]>>({});
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

  // Build the dynamic harness list: built-in harnesses + one entry per
  // installed ACP agent.
  const allHarnesses: HarnessInfo[] = [
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
          <Text style={sheetStyles.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={{ color: Theme.text, fontSize: fs(13) }}>✕</Text>
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
          {!lockedHarness ? (
            <>
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
                        void Haptics.selectionAsync();
                        const fallback = HarnessCatalog.defaultModelFor(h.id);
                        const nextReasoning = HarnessCatalog.defaultReasoningFor(fallback) ?? undefined;
                        onHarnessChange(h.id);
                        onModelChange(fallback.id);
                        onReasoningChange(nextReasoning);
                      }}
                      style={[sheetStyles.harness, { backgroundColor: sel ? overlay(0.15) : overlay(0.05) }]}
                    >
                      <BrandMark harness={wireHarness} size={15} color={Theme.text} dimmed={!sel} />
                      <Text style={[sheetStyles.harnessText, { color: sel ? Theme.text : Theme.textMuted }]}>{h.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

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
                        void Haptics.selectionAsync();
                        const nextReasoning = (!m.reasoningLevels.includes(effectiveReasoning ?? '')
                          ? HarnessCatalog.defaultReasoningFor(m) ?? undefined
                          : effectiveReasoning);
                        onModelChange(m.id);
                        onReasoningChange(nextReasoning);
                      }}
                      style={({ pressed }) => [sheetStyles.option, { backgroundColor: pressed ? overlay(0.06) : 'transparent' }]}
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
                        void Haptics.selectionAsync();
                        onReasoningChange(level);
                      }}
                      style={({ pressed }) => [sheetStyles.option, { backgroundColor: pressed ? overlay(0.06) : 'transparent' }]}
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
            {PERMISSION_MODES.map((mode, ix, arr) => {
              const sel = mode.value === permissionMode;
              return (
                <React.Fragment key={mode.value}>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      onPermissionModeChange(mode.value);
                    }}
                    style={({ pressed }) => [sheetStyles.option, { backgroundColor: pressed ? overlay(0.06) : 'transparent' }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={sheetStyles.optionTitle}>{mode.label}</Text>
                      <Text style={sheetStyles.optionDescription}>{mode.description}</Text>
                    </View>
                    <Text style={[sheetStyles.checkmark, { opacity: sel ? 1 : 0 }]}>✓</Text>
                  </Pressable>
                  {ix < arr.length - 1 ? <View style={sheetStyles.separator} /> : null}
                </React.Fragment>
              );
            })}
          </View>

          {showSummary ? (
            <View style={sheetStyles.summary}>
              <Text style={sheetStyles.summaryLabel}>Saved for this session</Text>
              <Text style={sheetStyles.summaryValue}>
                {selectedAcpAgent ? selectedAcpAgent.name : harnessLabel(HarnessCatalog.isAcpAgentHarness(harness) ? HarnessCatalog.ACP_WIRE : harness)}
                {' · '}
                {selectedModel.label}
                {effectiveReasoning ? ` · ${HarnessCatalog.reasoningLabel(effectiveReasoning)}` : ''}
              </Text>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

function harnessLabel(harness: string): string {
  switch (harness) {
    case 'claude-code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'acp': return 'ACP';
    default: return harness;
  }
}

// Small shared chip button used by both views under the composer. Matches
// the SessionView ConfigChipButton dimensions (height 34, radius 17,
// fontSize 12.5) so the chips look identical across screens.
export function ConfigChipButton({
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
        backgroundColor: pressed ? overlay(0.16) : overlay(0.1),
      })}
    >
      {leading}
      <Text
        style={{ fontFamily: Fonts.sansMedium, fontSize: fs(12.5), color: withAlpha(Theme.text, 0.9) }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {trailing ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: fs(11), color: Theme.textMuted }}>
          {trailing}
        </Text>
      ) : null}
    </Pressable>
  );
}

function makeSheetStyles() {
  return StyleSheet.create({
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
      backgroundColor: Theme.surface,
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
      fontSize: fs(14),
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
      fontSize: fs(13),
    },
    label: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(11),
      color: withAlpha(Theme.textMuted, 0.6),
      textTransform: 'uppercase',
      letterSpacing: 1,
      marginBottom: 8,
      marginTop: 4,
    },
    card: {
      backgroundColor: overlay(0.045),
      borderColor: overlay(0.06),
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
      backgroundColor: overlay(0.06),
      borderWidth: 1,
      borderColor: Theme.border,
    },
    searchIcon: {
      color: Theme.textMuted,
      fontSize: fs(22),
      marginRight: 8,
    },
    searchInput: {
      flex: 1,
      padding: 0,
      fontFamily: Fonts.sans,
      fontSize: fs(14),
      color: Theme.text,
    },
    modelList: {
      height: 280,
      borderRadius: 20,
      backgroundColor: overlay(0.045),
      borderColor: overlay(0.06),
      borderWidth: 1,
      marginBottom: 8,
      overflow: 'hidden',
    },
    emptyText: {
      fontFamily: Fonts.sans,
      fontSize: fs(13),
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
      fontSize: fs(15),
      color: Theme.text,
    },
    optionDescription: {
      fontFamily: Fonts.sans,
      fontSize: fs(12.5),
      color: Theme.textMuted,
      marginTop: 2,
    },
    checkmark: {
      fontFamily: Fonts.sansSemiBold,
      fontSize: fs(14),
      color: Theme.text,
    },
    separator: {
      height: 1,
      backgroundColor: overlay(0.06),
      marginLeft: 16,
    },
    summary: {
      marginTop: 16,
      padding: 14,
      borderRadius: 14,
      backgroundColor: overlay(0.04),
    },
    summaryLabel: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(10.5),
      color: withAlpha(Theme.textMuted, 0.6),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 4,
    },
    summaryValue: {
      fontFamily: Fonts.sans,
      fontSize: fs(13),
      color: Theme.text,
    },
  });
}

// Silence unused import warnings for type-only re-exports kept for clarity.
void permissionModeMeta;
