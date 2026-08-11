// SpaceGitView — git changes panel for a space's working directory. Mirrors
// the desktop Changes panel: file list with per-file stage/unstage/discard/
// ignore, stage all, commit form (subject + body), push/fetch, and AI commit
// message generation.

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import { GitFileChange, GitStatus, InstalledAcpAgent } from '../models/Entities';
import { HarnessCatalog, ModelInfo } from '../models/HarnessCatalog';
import type { HarnessInfo } from '../models/HarnessCatalog';
import { LineIcon } from '../theme/LineIcon';
import { Fonts, overlay, Theme } from '../theme/Theme';
import { fs, useThemedStyles } from '../theme/Appearance';
import { withAlpha } from '../theme/color';

interface Props {
  model: AppModel;
  spaceId: string;
  onBack: () => void;
}

type BusyAction = 'stage' | 'unstage' | 'discard' | 'ignore' | 'commit' | 'push' | 'fetch' | null;

export function SpaceGitView({ model, spaceId, onBack }: Props) {
  useForceUpdateOnNotify(model);
  const styles = useThemedStyles(() => makeStyles(), []);

  const space = model.spaces.find((s) => s.id === spaceId);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // AI generation runs in its own flag so it doesn't lock the rest of the
  // panel: staging, discarding, fetch/push, etc. stay usable while the
  // message is being generated.
  const [generating, setGenerating] = useState(false);

  // Commit form
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  // AI generation
  const [acpAgents, setAcpAgents] = useState<InstalledAcpAgent[]>([]);
  const [selectedHarness, setSelectedHarness] = useState<string>('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [modelSearch, setModelSearch] = useState('');
  const [showHarnessPicker, setShowHarnessPicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);

  const cwd = space?.path;
  const deviceId = space?.deviceId;

  const refresh = useCallback(async () => {
    if (!deviceId || !cwd) return;
    const s = await model.gitStatusFor(deviceId, cwd);
    setStatus(s);
  }, [model, deviceId, cwd]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  // Load ACP agents from the device.
  useEffect(() => {
    if (!space) return;
    void (async () => {
      const snap = await model.acpAgents(space.deviceId);
      if (snap) setAcpAgents(snap.installed);
    })();
  }, [space, model]);

  // Restore last-used harness/model for AI generation.
  useEffect(() => {
    void (async () => {
      const h = (await AsyncStorage.getItem('spaceGitHarness')) ?? HarnessCatalog.harnesses[0]?.id ?? '';
      setSelectedHarness(h);
      const m = (await AsyncStorage.getItem('spaceGitModel')) ?? '';
      setSelectedModel(m);
    })();
  }, []);

  // Build the dynamic harness list: built-in harnesses + one entry per
  // installed ACP agent.
  const allHarnesses: HarnessInfo[] = [
    ...HarnessCatalog.harnesses,
    ...acpAgents.map((agent) => ({
      id: HarnessCatalog.acpAgentHarnessId(agent.id),
      label: agent.name,
    })),
  ];

  // Load models when harness changes.
  useEffect(() => {
    if (!selectedHarness || !space) return;
    void (async () => {
      const live = await model.listModels(space, selectedHarness);
      if (live && live.length > 0) {
        setModels(live);
        if (selectedModel && !live.some((m) => m.id === selectedModel)) {
          setSelectedModel(live[0].id);
        } else if (!selectedModel) {
          setSelectedModel(live[0].id);
        }
      } else {
        setModels(HarnessCatalog.modelsFor(selectedHarness));
        if (!selectedModel) {
          setSelectedModel(HarnessCatalog.defaultModelFor(selectedHarness).id);
        }
      }
    })();
  }, [selectedHarness, space, model, selectedModel]);

  // Reset model search when opening the picker.
  useEffect(() => {
    if (showModelPicker) setModelSearch('');
  }, [showModelPicker]);

  // Clear transient messages after a timeout.
  useEffect(() => {
    if (!info && !error) return;
    const t = setTimeout(() => { setInfo(null); setError(null); }, 4_000);
    return () => clearTimeout(t);
  }, [info, error]);

  const showErr = (msg: string) => { setError(msg); setInfo(null); };
  const showInfo = (msg: string) => { setInfo(msg); setError(null); };

  // -- File actions --

  const doStage = async (paths: string[]) => {
    if (!deviceId || !cwd) return;
    setBusy('stage');
    const err = await model.gitStage(deviceId, cwd, paths);
    setBusy(null);
    if (err) showErr(err); else { await refresh(); showInfo(paths.length === 1 ? 'Staged' : `${paths.length} files staged`); }
  };

  const doUnstage = async (paths: string[]) => {
    if (!deviceId || !cwd) return;
    setBusy('unstage');
    const err = await model.gitUnstage(deviceId, cwd, paths);
    setBusy(null);
    if (err) showErr(err); else { await refresh(); showInfo(paths.length === 1 ? 'Unstaged' : `${paths.length} files unstaged`); }
  };

  const doDiscard = async (file: GitFileChange) => {
    if (!deviceId || !cwd) return;
    setBusy('discard');
    const untracked = file.kind === 'untracked';
    const err = await model.gitDiscard(deviceId, cwd, file.path, untracked);
    setBusy(null);
    if (err) showErr(err); else { await refresh(); showInfo('Discarded'); }
  };

  const doIgnore = async (file: GitFileChange) => {
    if (!deviceId || !cwd) return;
    setBusy('ignore');
    const err = await model.gitIgnore(deviceId, cwd, file.path);
    setBusy(null);
    if (err) showErr(err); else { await refresh(); showInfo('Added to .gitignore'); }
  };

  // -- Bulk actions --

  const stageAll = async () => {
    if (!status) return;
    const unstagedPaths = status.files.filter((f) => f.unstaged || f.kind === 'untracked').map((f) => f.path);
    if (unstagedPaths.length === 0) return;
    await doStage(unstagedPaths);
  };

  const unstageAll = async () => {
    if (!status) return;
    const stagedPaths = status.files.filter((f) => f.staged).map((f) => f.path);
    if (stagedPaths.length === 0) return;
    await doUnstage(stagedPaths);
  };

  // -- Remote --

  const doFetch = async () => {
    if (!deviceId || !cwd) return;
    setBusy('fetch');
    const result = await model.gitFetch(deviceId, cwd);
    setBusy(null);
    await refresh();
    showInfo(result ?? 'Fetch complete');
  };

  const doPush = async () => {
    if (!deviceId || !cwd) return;
    setBusy('push');
    const result = await model.gitPush(deviceId, cwd);
    setBusy(null);
    await refresh();
    showInfo(result ?? 'Push complete');
  };

  // -- Commit --

  const doCommit = async () => {
    if (!deviceId || !cwd) return;
    const subj = subject.trim();
    if (subj.length === 0) return;
    setBusy('commit');
    const result = await model.gitCommit(deviceId, cwd, subj, body.trim().length > 0 ? body : undefined);
    setBusy(null);
    if (result === null) {
      showInfo('Committed');
      setSubject('');
      setBody('');
    } else if (/^[0-9a-f]{4,}$/i.test(result)) {
      // Short commit hash from the engine on success.
      showInfo(`Committed ${result}`);
      setSubject('');
      setBody('');
    } else {
      showErr(result);
    }
    await refresh();
  };

  // -- AI message --

  const doGenerate = async () => {
    if (!deviceId || !cwd || !selectedHarness || !selectedModel) return;
    setGenerating(true);
    try {
      void AsyncStorage.setItem('spaceGitHarness', selectedHarness);
      void AsyncStorage.setItem('spaceGitModel', selectedModel);
      const result: unknown = await model.gitGenerateCommitMessage(deviceId, cwd, selectedHarness, selectedModel);
      if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).subject === 'string') {
        const msg = result as { subject: string; body?: string };
        setSubject(msg.subject);
        setBody(typeof msg.body === 'string' ? msg.body : '');
        showInfo('AI message generated');
      } else if (typeof result === 'string' && result.length > 0) {
        setSubject(result);
        showInfo('AI message generated');
      } else {
        showErr('Failed to generate commit message');
      }
    } catch (err) {
      showErr(err instanceof Error ? err.message : 'Failed to generate commit message');
    } finally {
      // Always release the generating flag so the button never stays stuck,
      // even if the underlying RPC throws or hangs without settling.
      setGenerating(false);
    }
  };

  const canCommit = !busy && !generating && subject.trim().length > 0 && !!status && status.files.some((f) => f.staged);
  const canGenerate = !busy && !generating && !!status && status.files.length > 0 && !!selectedHarness && !!selectedModel;
  const filteredModels = models.filter((m) => {
    const q = modelSearch.trim().toLowerCase();
    return q.length === 0 || `${m.label} ${m.id} ${m.description ?? ''}`.toLowerCase().includes(q);
  });

  if (!space) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: Theme.bg }} edges={['top']}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: Theme.textFaint, fontFamily: Fonts.sans, fontSize: fs(13) }}>Space not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            Git · {space.name ?? spacePathBase(space.path)}
          </Text>
          {status?.branch ? (
            <View style={styles.branchRow}>
              <LineIcon icon="gitBranch" size={11} color={withAlpha(Theme.textMuted, 0.6)} />
              <Text style={styles.branchText} numberOfLines={1}>{status.branch}</Text>
              {status.ahead > 0 ? <Text style={styles.aheadBehindText}>↑ {status.ahead}</Text> : null}
              {status.behind > 0 ? <Text style={styles.aheadBehindText}>↓ {status.behind}</Text> : null}
            </View>
          ) : null}
        </View>
        {/* Remote buttons */}
        <View style={styles.remoteButtons}>
          <Pressable
            onPress={doFetch}
            disabled={!!busy}
            hitSlop={8}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed, busy && styles.iconButtonDisabled]}
          >
            {busy === 'fetch' ? (
              <ActivityIndicator size="small" color={Theme.textMuted} />
            ) : (
              <LineIcon icon="download" size={16} color={Theme.textMuted} />
            )}
          </Pressable>
          <Pressable
            onPress={doPush}
            disabled={!!busy}
            hitSlop={8}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed, busy && styles.iconButtonDisabled]}
          >
            {busy === 'push' ? (
              <ActivityIndicator size="small" color={Theme.textMuted} />
            ) : (
              <LineIcon icon="upload" size={16} color={Theme.textMuted} />
            )}
          </Pressable>
        </View>
      </View>

      {/* Info / error banner */}
      {info ? (
        <View style={styles.infoBanner}>
          <LineIcon icon="check" size={13} color={Theme.statusCompleted} />
          <Text style={styles.infoText}>{info}</Text>
        </View>
      ) : null}
      {error ? (
        <View style={styles.errorBanner}>
          <LineIcon icon="ban" size={13} color={Theme.danger} />
          <Text style={styles.errorText} numberOfLines={3}>{error}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={Theme.textMuted} />
        </View>
      ) : !status || !status.isRepo ? (
        <View style={styles.empty}>
          <LineIcon icon="gitBranch" size={32} color={Theme.textFaint} />
          <Text style={styles.emptyText}>Not a git repository.</Text>
        </View>
      ) : status.files.length === 0 ? (
        <View style={styles.empty}>
          <LineIcon icon="check" size={32} color={Theme.statusCompleted} />
          <Text style={styles.emptyText}>Working tree is clean.</Text>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 16 }}
            keyboardShouldPersistTaps="handled"
          >
            {/* Bulk action bar */}
            <View style={styles.bulkBar}>
              <Text style={styles.bulkLabel}>{status.files.length} changed</Text>
              <View style={styles.bulkButtons}>
                <Pressable
                  onPress={unstageAll}
                  disabled={!!busy || !status.files.some((f) => f.staged)}
                  style={({ pressed }) => [
                    styles.bulkButton,
                    pressed && styles.bulkButtonPressed,
                    (!status.files.some((f) => f.staged) || !!busy) && styles.bulkButtonDisabled,
                  ]}
                >
                  <Text style={styles.bulkButtonText}>Unstage all</Text>
                </Pressable>
                <Pressable
                  onPress={stageAll}
                  disabled={!!busy || !status.files.some((f) => f.unstaged || f.kind === 'untracked')}
                  style={({ pressed }) => [
                    styles.bulkButton,
                    pressed && styles.bulkButtonPressed,
                    (!status.files.some((f) => f.unstaged || f.kind === 'untracked') || !!busy) && styles.bulkButtonDisabled,
                  ]}
                >
                  <Text style={styles.bulkButtonText}>Stage all</Text>
                </Pressable>
              </View>
            </View>

            {/* File list */}
            {status.files.map((file, ix) => (
              <FileRow
                key={`${file.path}-${ix}`}
                file={file}
                busy={!!busy}
                onStage={() => doStage([file.path])}
                onUnstage={() => doUnstage([file.path])}
                onDiscard={() => doDiscard(file)}
                onIgnore={() => doIgnore(file)}
              />
            ))}

            {/* AI generation row */}
            <View style={styles.aiSection}>
              <Text style={styles.sectionLabel}>AI COMMIT MESSAGE</Text>
              <View style={styles.aiRow}>
                <Pressable
                  onPress={() => setShowHarnessPicker(true)}
                  disabled={!!busy || generating}
                  style={({ pressed }) => [
                    styles.aiSelector,
                    pressed && styles.aiSelectorPressed,
                    (!!busy || generating) && styles.aiSelectorDisabled,
                  ]}
                >
                  <Text style={styles.aiSelectorText} numberOfLines={1}>
                    {allHarnesses.find((h) => h.id === selectedHarness)?.label ?? 'Select harness'}
                  </Text>
                  <Text style={styles.chevron}>⌄</Text>
                </Pressable>
                <Pressable
                  onPress={() => setShowModelPicker(true)}
                  disabled={!!busy || generating || models.length === 0}
                  style={({ pressed }) => [
                    styles.aiSelector,
                    pressed && styles.aiSelectorPressed,
                    (!!busy || generating || models.length === 0) && styles.aiSelectorDisabled,
                  ]}
                >
                  <Text style={styles.aiSelectorText} numberOfLines={1}>
                    {models.find((m) => m.id === selectedModel)?.label ?? 'Select model'}
                  </Text>
                  <Text style={styles.chevron}>⌄</Text>
                </Pressable>
                <Pressable
                  onPress={doGenerate}
                  disabled={!canGenerate}
                  style={({ pressed }) => [
                    styles.aiButton,
                    pressed && styles.aiButtonPressed,
                    !canGenerate && styles.aiButtonDisabled,
                  ]}
                >
                  {generating ? (
                    <ActivityIndicator size="small" color={Theme.text} />
                  ) : (
                    <LineIcon icon="sparkles" size={14} color={canGenerate ? Theme.text : Theme.textFaint} />
                  )}
                  <Text style={[styles.aiButtonText, !canGenerate && styles.aiButtonTextDisabled]}>
                    {generating ? '' : 'AI'}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Commit form */}
            <View style={styles.commitSection}>
              <TextInput
                style={styles.subjectInput}
                value={subject}
                onChangeText={setSubject}
                placeholder="Commit subject"
                placeholderTextColor={Theme.textFaint}
              />
              <TextInput
                style={styles.bodyInput}
                value={body}
                onChangeText={setBody}
                placeholder="Description (optional)"
                placeholderTextColor={Theme.textFaint}
                multiline
                textAlignVertical="top"
              />
              <Pressable
                onPress={doCommit}
                disabled={!canCommit}
                style={({ pressed }) => [
                  styles.commitButton,
                  pressed && styles.commitButtonPressed,
                  !canCommit && styles.commitButtonDisabled,
                ]}
              >
                {busy === 'commit' ? (
                  <ActivityIndicator size="small" color={Theme.bg} />
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <LineIcon icon="gitCommit" size={14} color={canCommit ? Theme.bg : Theme.textFaint} />
                    <Text style={[styles.commitButtonText, !canCommit && styles.commitButtonTextDisabled]}>
                      Commit
                    </Text>
                  </View>
                )}
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* Harness picker modal */}
      <Modal visible={showHarnessPicker} transparent animationType="fade" onRequestClose={() => setShowHarnessPicker(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowHarnessPicker(false)} />
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>Select harness</Text>
            {allHarnesses.map((h) => (
              <Pressable
                key={h.id}
                onPress={() => {
                  setSelectedHarness(h.id);
                  void AsyncStorage.setItem('spaceGitHarness', h.id);
                  // Reset model selection so the next list loads fresh.
                  setSelectedModel('');
                  setShowHarnessPicker(false);
                }}
                style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
              >
                <Text style={[styles.pickerRowText, selectedHarness === h.id && styles.pickerRowTextSelected]}>
                  {h.label}
                </Text>
                {selectedHarness === h.id ? <LineIcon icon="check" size={14} color={Theme.text} /> : null}
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>

      {/* Model picker modal */}
      <Modal visible={showModelPicker} transparent animationType="fade" onRequestClose={() => setShowModelPicker(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowModelPicker(false)} />
          <View style={styles.pickerCard}>
            <View style={styles.pickerHeaderRow}>
              <Text style={styles.pickerTitle}>Select model</Text>
              <Pressable onPress={() => setShowModelPicker(false)} hitSlop={12}>
                <Text style={styles.pickerCloseText}>✕</Text>
              </Pressable>
            </View>
            <View style={styles.searchBox}>
              <Text style={styles.searchIcon}>⌕</Text>
              <TextInput
                value={modelSearch}
                onChangeText={setModelSearch}
                placeholder="Search models"
                placeholderTextColor={Theme.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.searchInput}
              />
            </View>
            <ScrollView style={{ maxHeight: 340 }} keyboardShouldPersistTaps="handled">
              {filteredModels.length === 0 ? (
                <Text style={styles.pickerEmptyText}>No models found.</Text>
              ) : filteredModels.map((m) => (
                <Pressable
                  key={m.id}
                  onPress={() => { setSelectedModel(m.id); void AsyncStorage.setItem('spaceGitModel', m.id); setShowModelPicker(false); }}
                  style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.pickerRowText, selectedModel === m.id && styles.pickerRowTextSelected]}>
                      {m.label}
                    </Text>
                    {m.description ? (
                      <Text style={styles.pickerRowDesc} numberOfLines={1}>{m.description}</Text>
                    ) : null}
                  </View>
                  {selectedModel === m.id ? <LineIcon icon="check" size={14} color={Theme.text} /> : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// MARK: - File row

function FileRow({
  file,
  busy,
  onStage,
  onUnstage,
  onDiscard,
  onIgnore,
}: {
  file: GitFileChange;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onIgnore: () => void;
}) {
  const styles = useThemedStyles(() => makeStyles(), []);
  const isFullyStaged = file.staged && !file.unstaged;
  const showStageButton = file.unstaged || file.kind === 'untracked';
  const showUnstageButton = file.staged;

  return (
    <View style={styles.fileRow}>
      <Text style={[styles.fileStatus, { color: deltaColor(file.kind) }]}>
        {deltaSymbol(file.kind)}
      </Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.filePath} numberOfLines={1}>{file.path}</Text>
        {file.oldPath ? (
          <Text style={styles.fileOldPath} numberOfLines={1}>from {file.oldPath}</Text>
        ) : null}
        <View style={styles.fileBadgeRow}>
          {isFullyStaged ? (
            <View style={[styles.fileBadge, { backgroundColor: withAlpha(Theme.statusCompleted, 0.12) }]}>
              <Text style={[styles.fileBadgeText, { color: Theme.statusCompleted }]}>Staged</Text>
            </View>
          ) : null}
          {file.unstaged || file.kind === 'untracked' ? (
            <View style={[styles.fileBadge, { backgroundColor: withAlpha(Theme.warning, 0.12) }]}>
              <Text style={[styles.fileBadgeText, { color: Theme.warning }]}>
                {file.kind === 'untracked' ? 'Untracked' : 'Modified'}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.fileActions}>
        {showStageButton ? (
          <Pressable
            onPress={onStage}
            disabled={busy}
            hitSlop={6}
            style={({ pressed }) => [styles.fileActionButton, pressed && styles.fileActionButtonPressed]}
          >
            <LineIcon icon="plus" size={13} color={Theme.statusCompleted} />
          </Pressable>
        ) : null}
        {showUnstageButton ? (
          <Pressable
            onPress={onUnstage}
            disabled={busy}
            hitSlop={6}
            style={({ pressed }) => [styles.fileActionButton, pressed && styles.fileActionButtonPressed]}
          >
            <LineIcon icon="minus" size={13} color={Theme.textMuted} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={onDiscard}
          disabled={busy}
          hitSlop={6}
          style={({ pressed }) => [styles.fileActionButton, pressed && styles.fileActionButtonPressed]}
        >
          <LineIcon icon="undo" size={13} color={Theme.danger} />
        </Pressable>
        <Pressable
          onPress={onIgnore}
          disabled={busy}
          hitSlop={6}
          style={({ pressed }) => [styles.fileActionButton, pressed && styles.fileActionButtonPressed]}
        >
          <LineIcon icon="ban" size={13} color={Theme.textFaint} />
        </Pressable>
      </View>
    </View>
  );
}

// MARK: - Helpers

function spacePathBase(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function deltaColor(kind: string): string {
  switch (kind) {
    case 'added': return Theme.statusCompleted;
    case 'deleted': return Theme.danger;
    case 'modified':
    case 'renamed':
    default: return Theme.warning;
  }
}

function deltaSymbol(kind: string): string {
  switch (kind) {
    case 'added': return '+';
    case 'deleted': return '−';
    case 'renamed': return '→';
    case 'untracked': return '?';
    default: return 'M';
  }
}

// MARK: - Styles

function makeStyles() {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: Theme.border,
      gap: 4,
    },
    backButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backText: {
      color: Theme.text,
      fontSize: fs(22),
      fontFamily: Fonts.sans,
    },
    title: {
      fontFamily: Fonts.sansSemiBold,
      fontSize: fs(15),
      color: Theme.text,
    },
    branchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginTop: 2,
    },
    branchText: {
      fontFamily: Fonts.sans,
      fontSize: fs(11),
      color: withAlpha(Theme.textMuted, 0.6),
      maxWidth: 160,
    },
    aheadBehindText: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(10),
      color: Theme.textMuted,
    },
    remoteButtons: {
      flexDirection: 'row',
      gap: 4,
    },
    iconButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: overlay(0.08),
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconButtonPressed: {
      backgroundColor: overlay(0.14),
    },
    iconButtonDisabled: {
      opacity: 0.4,
    },

    // Banners
    infoBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: withAlpha(Theme.statusCompleted, 0.08),
    },
    infoText: {
      fontFamily: Fonts.sans,
      fontSize: fs(12),
      color: Theme.statusCompleted,
      flex: 1,
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: withAlpha(Theme.danger, 0.08),
    },
    errorText: {
      fontFamily: Fonts.sans,
      fontSize: fs(12),
      color: Theme.danger,
      flex: 1,
    },

    // Empty
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    emptyText: {
      fontFamily: Fonts.sans,
      fontSize: fs(13),
      color: Theme.textFaint,
    },

    // Bulk bar
    bulkBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: Theme.border,
    },
    bulkLabel: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(11),
      color: Theme.textMuted,
    },
    bulkButtons: {
      flexDirection: 'row',
      gap: 6,
    },
    bulkButton: {
      paddingHorizontal: 10,
      height: 28,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: Theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bulkButtonPressed: {
      backgroundColor: overlay(0.08),
    },
    bulkButtonDisabled: {
      opacity: 0.35,
    },
    bulkButtonText: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(11),
      color: Theme.textMuted,
    },

    // File row
    fileRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: withAlpha(Theme.border, 0.5),
    },
    fileStatus: {
      fontFamily: Fonts.sansSemiBold,
      fontSize: fs(14),
      width: 16,
      textAlign: 'center',
    },
    filePath: {
      fontFamily: Fonts.sans,
      fontSize: fs(12.5),
      color: Theme.text,
    },
    fileOldPath: {
      fontFamily: Fonts.sans,
      fontSize: fs(10),
      color: Theme.textFaint,
      marginTop: 1,
    },
    fileBadgeRow: {
      flexDirection: 'row',
      gap: 4,
      marginTop: 4,
    },
    fileBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1.5,
      borderRadius: 4,
    },
    fileBadgeText: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(9),
      letterSpacing: 0.3,
    },
    fileActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    fileActionButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fileActionButtonPressed: {
      backgroundColor: overlay(0.08),
    },

    // AI section
    aiSection: {
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 10,
      marginTop: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: Theme.border,
    },
    sectionLabel: {
      fontFamily: Fonts.sansSemiBold,
      fontSize: fs(9.5),
      letterSpacing: 0.5,
      color: Theme.textFaint,
      marginBottom: 8,
    },
    aiRow: {
      flexDirection: 'row',
      gap: 6,
    },
    aiSelector: {
      flex: 1,
      height: 32,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: Theme.border,
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    aiSelectorPressed: {
      backgroundColor: overlay(0.05),
    },
    aiSelectorDisabled: {
      opacity: 0.4,
    },
    aiSelectorText: {
      fontFamily: Fonts.sans,
      fontSize: fs(11),
      color: Theme.textMuted,
      flex: 1,
    },
    chevron: {
      fontFamily: Fonts.sans,
      fontSize: fs(14),
      color: Theme.textFaint,
    },
    aiButton: {
      height: 32,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: Theme.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    aiButtonPressed: {
      backgroundColor: overlay(0.08),
    },
    aiButtonDisabled: {
      opacity: 0.35,
    },
    aiButtonText: {
      fontFamily: Fonts.sansMedium,
      fontSize: fs(11),
      color: Theme.text,
    },
    aiButtonTextDisabled: {
      color: Theme.textFaint,
    },

    // Commit section
    commitSection: {
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 24,
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: Theme.border,
    },
    subjectInput: {
      height: 38,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: Theme.border,
      backgroundColor: overlay(0.025),
      paddingHorizontal: 10,
      color: Theme.text,
      fontFamily: Fonts.sans,
      fontSize: fs(13),
    },
    bodyInput: {
      minHeight: 48,
      maxHeight: 80,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: Theme.border,
      backgroundColor: overlay(0.025),
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: Theme.text,
      fontFamily: Fonts.sans,
      fontSize: fs(12),
    },
    commitButton: {
      height: 38,
      borderRadius: 10,
      backgroundColor: Theme.text,
      alignItems: 'center',
      justifyContent: 'center',
    },
    commitButtonPressed: {
      backgroundColor: withAlpha(Theme.text, 0.85),
    },
    commitButtonDisabled: {
      backgroundColor: Theme.surfaceRaised,
    },
    commitButtonText: {
      fontFamily: Fonts.sansSemiBold,
      fontSize: fs(13),
      color: Theme.bg,
    },
    commitButtonTextDisabled: {
      color: Theme.textFaint,
    },

    // Modals
    modalOverlay: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.5)',
      padding: 32,
    },
    pickerCard: {
      backgroundColor: Theme.surface,
      borderRadius: 12,
      padding: 16,
      width: '100%',
      maxWidth: 340,
      borderWidth: 1,
      borderColor: Theme.border,
    },
    pickerTitle: {
      fontFamily: Fonts.sansSemiBold,
      fontSize: fs(13),
      color: Theme.text,
      marginBottom: 10,
    },
    pickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: 40,
      paddingHorizontal: 10,
      borderRadius: 8,
      gap: 8,
    },
    pickerRowPressed: {
      backgroundColor: overlay(0.05),
    },
    pickerRowText: {
      fontFamily: Fonts.sans,
      fontSize: fs(12.5),
      color: Theme.textMuted,
    },
    pickerRowTextSelected: {
      fontFamily: Fonts.sansMedium,
      color: Theme.text,
    },
    pickerRowDesc: {
      fontFamily: Fonts.sans,
      fontSize: fs(10),
      color: Theme.textFaint,
      marginTop: 1,
    },
    pickerHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    pickerCloseText: {
      color: Theme.textMuted,
      fontSize: fs(13),
      paddingHorizontal: 4,
    },
    pickerEmptyText: {
      fontFamily: Fonts.sans,
      fontSize: fs(12),
      color: Theme.textFaint,
      textAlign: 'center',
      paddingVertical: 20,
    },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      height: 34,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: Theme.border,
      backgroundColor: overlay(0.025),
      paddingHorizontal: 8,
      marginBottom: 10,
    },
    searchIcon: {
      fontFamily: Fonts.sans,
      fontSize: fs(15),
      color: Theme.textFaint,
    },
    searchInput: {
      flex: 1,
      fontFamily: Fonts.sans,
      fontSize: fs(12),
      color: Theme.text,
      padding: 0,
    },
  });
}
