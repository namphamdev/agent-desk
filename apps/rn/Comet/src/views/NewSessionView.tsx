// New session — RN port of NewSessionView.swift. A composer page with picker
// chips for harness/model, permission mode, workflow, checkout, and ref.

import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
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
import * as Haptics from 'expo-haptics';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import { ComposerShell } from '../components/ComposerView';
import { BrandMark } from '../theme/BrandMark';
import { CometMark } from '../theme/CometMark';
import { LineIcon } from '../theme/LineIcon';
import { Fonts, Theme } from '../theme/Theme';
import { withAlpha, whiteAlpha } from '../theme/color';
import {
  baseName,
  ChatConfig,
  CheckoutKind,
  effectivePermissionMode,
  PermissionModeValue,
  permissionModeMeta,
  PERMISSION_MODES,
  RepoRef,
  Space,
} from '../models/Entities';
import { HarnessCatalog, ModelInfo } from '../models/HarnessCatalog';
import { WorkflowCatalog, WorkflowDefinition } from '../models/WorkflowCatalog';

interface Props {
  model: AppModel;
  spaceId: string;
  onOpenChat: (chatId: string) => void;
  onBack: () => void;
}

export function NewSessionView({ model, spaceId, onOpenChat, onBack }: Props) {
  useForceUpdateOnNotify(model);
  const space = model.spaces.find((s) => s.id === spaceId);

  const [draft, setDraft] = useState('');
  const [harness, setHarness] = useState('claude-code');
  const [storedModel, setStoredModel] = useState('');
  const [storedReasoning, setStoredReasoning] = useState('');
  const [storedPermissionMode, setStoredPermissionMode] = useState<PermissionModeValue>('default');
  const [workflowId, setWorkflowId] = useState('');
  const [prRef, setPrRef] = useState('');
  const [catalogs, setCatalogs] = useState<Record<string, ModelInfo[]>>({});
  const [refs, setRefs] = useState<RepoRef[]>([]);
  const [selectedRef, setSelectedRef] = useState<string | undefined>();
  const [checkoutKind, setCheckoutKind] = useState<CheckoutKind>('local');
  const [busy, setBusy] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showRefPicker, setShowRefPicker] = useState(false);
  const [showCheckoutPicker, setShowCheckoutPicker] = useState(false);
  const [showWorkflowPicker, setShowWorkflowPicker] = useState(false);

  useEffect(() => {
    (async () => {
      const h = (await AsyncStorage.getItem('newSessionHarness')) ?? 'claude-code';
      setHarness(h);
      const m = (await AsyncStorage.getItem('newSessionModel')) ?? '';
      setStoredModel(m);
      const r = (await AsyncStorage.getItem('newSessionReasoning')) ?? '';
      setStoredReasoning(r);
      const pm = (await AsyncStorage.getItem('newSessionPermissionMode')) as PermissionModeValue | null;
      setStoredPermissionMode(pm ?? 'default');
      const wf = (await AsyncStorage.getItem('newSessionWorkflow')) ?? '';
      setWorkflowId(wf);
      const pr = (await AsyncStorage.getItem('newSessionPrRef')) ?? '';
      setPrRef(pr);
    })();
  }, []);

  useEffect(() => {
    if (!space) return;
    void (async () => {
      const cat = await model.listModels(space, harness);
      setCatalogs((prev) => ({ ...prev, [harness]: cat }));
      if (storedModel.length === 0 && cat.length > 0) {
        setStoredModel(cat[0].id);
        await AsyncStorage.setItem('newSessionModel', cat[0].id);
      }
    })();
  }, [space, harness, storedModel, model]);

  useEffect(() => {
    if (!space?.gitDetected) return;
    void (async () => {
      const loaded = await model.listRefs(space);
      if (loaded) {
        setRefs(loaded);
        if (selectedRef === undefined) {
          setSelectedRef(loaded.find((r) => r.current)?.name ?? loaded[0]?.name);
        }
      }
    })();
  }, [space, model, selectedRef]);

  const models = catalogs[harness] ?? HarnessCatalog.modelsFor(harness);
  const selectedModel = models.find((m) => m.id === storedModel) ?? models[0];
  const reasoning = (() => {
    if (selectedModel.reasoningLevels.length === 0) return undefined;
    if (selectedModel.reasoningLevels.includes(storedReasoning)) return storedReasoning;
    return HarnessCatalog.defaultReasoningFor(selectedModel) ?? undefined;
  })();
  const workflow = WorkflowCatalog.all.find((w) => w.id === workflowId);

  const selectedRefRow = refs.find((r) => r.name === selectedRef);

  const persistHarness = async (h: string) => {
    setHarness(h);
    await AsyncStorage.setItem('newSessionHarness', h);
  };
  const persistModel = async (m: string) => {
    setStoredModel(m);
    await AsyncStorage.setItem('newSessionModel', m);
  };
  const persistReasoning = async (r: string | undefined) => {
    setStoredReasoning(r ?? '');
    await AsyncStorage.setItem('newSessionReasoning', r ?? '');
  };
  const persistPermissionMode = async (m: PermissionModeValue) => {
    setStoredPermissionMode(m);
    await AsyncStorage.setItem('newSessionPermissionMode', m);
  };

  const send = async () => {
    if (!space || busy) return;
    const promptText = draft.trim();
    if (promptText.length === 0) return;
    const prompt = workflow
      ? WorkflowCatalog.promptFor(workflow, promptText, prRef)
      : promptText;
    setBusy(true);
    const mode = permissionModeMeta(storedPermissionMode);
    const cfg: ChatConfig = {
      harness, model: selectedModel.id, reasoning,
      sandbox: mode.sandbox, permissionMode: mode.value,
    };
    let cwd: string | undefined;
    let branch = selectedRef;
    if (checkoutKind === 'newWorktree' && selectedRef) {
      const worktreePath = await model.createWorktree(space, selectedRef);
      if (!worktreePath) {
        setBusy(false);
        return;
      }
      cwd = worktreePath;
      branch = selectedRef;
    } else if (selectedRefRow?.worktreePath) {
      cwd = selectedRefRow.worktreePath;
    }
    const chatId = model.createChat(space, cfg, branch, cwd);
    if (!chatId) {
      setBusy(false);
      return;
    }
    const chat = model.chat(chatId);
    const store = chat ? model.sessionStoreFor(chat) : undefined;
    if (chat && store) store.sendRun(prompt, chat);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDraft('');
    setBusy(false);
    onOpenChat(chatId);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.bg }} edges={['top']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={headerStyles.bar}>
          <Pressable onPress={onBack} hitSlop={12}>
            <Text style={{ color: Theme.text, fontSize: 22 }}>‹</Text>
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontFamily: Fonts.sansMedium, fontSize: 13, color: Theme.text }}>New session</Text>
            {space ? (
              <Text style={{ fontFamily: Fonts.sans, fontSize: 10.5, color: withAlpha(Theme.textMuted, 0.6) }} numberOfLines={1}>
                {spaceDisplayName(space)} · {model.deviceNameFor(space.deviceId)}
              </Text>
            ) : null}
          </View>
          <View style={{ width: 28 }} />
        </View>

        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <CometMark size={84} color={withAlpha(Theme.text, 0.22)} />
          <Text style={{ marginTop: 24, fontFamily: Fonts.sans, fontSize: 15, color: Theme.textFaint }}>
            What are we building?
          </Text>
        </View>

        {space && !model.deviceOnline(space.deviceId) && model.demo === undefined ? (
          <View style={styles.offlineNotice}>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: withAlpha(Theme.warning, 0.9) }}>
              {model.deviceNameFor(space.deviceId)} is offline — the run will start when it reconnects.
            </Text>
          </View>
        ) : null}

        <View style={{ paddingBottom: 8 }}>
          <ComposerShell
            draft={draft}
            setDraft={setDraft}
            placeholder="Do anything…"
            sendEnabled={!!space}
            showStop={false}
            busy={busy}
            onSend={() => void send()}
            chips={
              <>
                <ChipButton
                  onPress={() => setShowPicker(true)}
                  leading={<BrandMark harness={harness} size={15} color={Theme.text} />}
                  label={selectedModel.label}
                  trailing={reasoning ? HarnessCatalog.reasoningLabel(reasoning) : undefined}
                />
                <ChipButton
                  onPress={() => setShowPicker(true)}
                  systemIcon="🛡"
                  label={permissionModeMeta(storedPermissionMode).label}
                />
                <ChipButton
                  onPress={() => setShowWorkflowPicker(true)}
                  systemIcon="⛓"
                  label={workflow?.label ?? 'Workflow'}
                />
                {space?.gitDetected === true ? (
                  <>
                    <ChipButton
                      onPress={() => setShowCheckoutPicker(true)}
                      systemIcon={checkoutKind === 'local' && !selectedRefRow?.worktreePath ? '📁' : '📂'}
                      label={checkoutLabel(checkoutKind, selectedRefRow)}
                    />
                    <ChipButton
                      onPress={() => setShowRefPicker(true)}
                      systemIcon="⎇"
                      label={refLabel(checkoutKind, selectedRef)}
                    />
                  </>
                ) : null}
              </>
            }
          />
        </View>
      </KeyboardAvoidingView>

      {showPicker ? (
        <ModelPickerSheet
          harness={harness}
          modelId={storedModel}
          reasoning={reasoning}
          permissionMode={storedPermissionMode}
          lockedHarness={false}
          catalogs={catalogs}
          onClose={() => setShowPicker(false)}
          onHarnessChange={(h) => void persistHarness(h)}
          onModelChange={(m) => void persistModel(m)}
          onReasoningChange={(r) => void persistReasoning(r)}
          onPermissionModeChange={(m) => void persistPermissionMode(m)}
        />
      ) : null}
      {showRefPicker ? (
        <RefPickerSheet
          refs={refs}
          selected={selectedRef}
          onPick={async (ref) => {
            const error = await pickRef(model, space, refs, selectedRef, checkoutKind, ref, setSelectedRef, setCheckoutKind, setRefs);
            return error;
          }}
          onClose={() => setShowRefPicker(false)}
        />
      ) : null}
      {showCheckoutPicker ? (
        <CheckoutPickerSheet
          kind={checkoutKind}
          selectedRefHasWorktree={!!selectedRefRow?.worktreePath}
          onPick={(k) => setCheckoutKind(k)}
          onClose={() => setShowCheckoutPicker(false)}
        />
      ) : null}
      {showWorkflowPicker ? (
        <WorkflowPickerSheet
          selectedId={workflowId}
          prRef={prRef}
          onSelect={async (id) => {
            setWorkflowId(id);
            await AsyncStorage.setItem('newSessionWorkflow', id);
          }}
          onPrRefChange={async (v) => {
            setPrRef(v);
            await AsyncStorage.setItem('newSessionPrRef', v);
          }}
          onClose={() => setShowWorkflowPicker(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

function spaceDisplayName(space: Space): string {
  if (space.name && space.name.length > 0) return space.name;
  return baseName(space.path);
}

function checkoutLabel(kind: CheckoutKind, ref?: RepoRef): string {
  if (kind === 'newWorktree') return 'New worktree';
  return ref?.worktreePath ? 'Current worktree' : 'Current checkout';
}

function refLabel(kind: CheckoutKind, ref?: string): string {
  if (!ref) return 'Select ref';
  return kind === 'newWorktree' ? `From ${ref}` : ref;
}

async function pickRef(
  model: AppModel,
  space: Space | undefined,
  _refs: RepoRef[],
  _selectedRef: string | undefined,
  checkoutKind: CheckoutKind,
  ref: RepoRef,
  setSelectedRef: (s: string) => void,
  setCheckoutKind: (k: CheckoutKind) => void,
  setRefs: (r: RepoRef[]) => void,
): Promise<string | null> {
  if (ref.worktreePath) {
    setSelectedRef(ref.name);
    setCheckoutKind('local');
    return null;
  }
  if (checkoutKind === 'newWorktree' || ref.current) {
    setSelectedRef(ref.name);
    return null;
  }
  if (!space) return null;
  const error = await model.switchSpaceRef(space, ref.name);
  if (error === null) {
    setSelectedRef(ref.name);
    const reloaded = await model.listRefs(space);
    if (reloaded) setRefs(reloaded);
  }
  return error;
}

function ChipButton({
  onPress,
  label,
  leading,
  trailing,
  systemIcon,
}: {
  onPress: () => void;
  label: string;
  leading?: React.ReactNode;
  trailing?: string;
  systemIcon?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 13,
        height: 36,
        borderRadius: 18,
        backgroundColor: pressed ? whiteAlpha(0.16) : whiteAlpha(0.1),
      })}
    >
      {leading}
      {systemIcon ? <Text style={{ fontSize: 12 }}>{systemIcon}</Text> : null}
      <Text
        style={{ fontFamily: Fonts.sansMedium, fontSize: 13, color: withAlpha(Theme.text, 0.9) }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {trailing ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: Theme.textMuted }}>
          {trailing}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ---- Sheets ----

interface SheetShellProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function SheetShell({ title, onClose, children }: SheetShellProps) {
  return (
    <View style={sheetStyles.backdrop}>
      <Pressable style={sheetStyles.scrim} onPress={onClose} />
      <View style={sheetStyles.panel}>
        <View style={sheetStyles.header}>
          <Text style={sheetStyles.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={{ color: Theme.text, fontSize: 13 }}>✕</Text>
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
          {children}
        </ScrollView>
      </View>
    </View>
  );
}

interface ModelPickerProps {
  harness: string;
  modelId: string;
  reasoning?: string;
  permissionMode: PermissionModeValue;
  lockedHarness: boolean;
  catalogs: Record<string, ModelInfo[]>;
  onClose: () => void;
  onHarnessChange: (h: string) => void;
  onModelChange: (m: string) => void;
  onReasoningChange: (r: string | undefined) => void;
  onPermissionModeChange: (m: PermissionModeValue) => void;
}

function ModelPickerSheet(props: ModelPickerProps) {
  const models = props.catalogs[props.harness] ?? HarnessCatalog.modelsFor(props.harness);
  const selected = models.find((m) => m.id === props.modelId) ?? models[0];

  return (
    <SheetShell title="Select model" onClose={props.onClose}>
      {!props.lockedHarness ? (
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {HarnessCatalog.harnesses.map((h) => {
            const sel = h.id === props.harness;
            return (
              <Pressable
                key={h.id}
                onPress={() => {
                  if (h.id === props.harness) return;
                  void Haptics.selectionAsync();
                  props.onHarnessChange(h.id);
                  const fallback = HarnessCatalog.defaultModelFor(h.id);
                  props.onModelChange(fallback.id);
                  props.onReasoningChange(HarnessCatalog.defaultReasoningFor(fallback) ?? undefined);
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  paddingHorizontal: 14,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: sel ? whiteAlpha(0.15) : whiteAlpha(0.05),
                }}
              >
                <BrandMark harness={h.id} size={15} color={Theme.text} dimmed={!sel} />
                <Text style={{
                  fontFamily: Fonts.sansMedium,
                  fontSize: 13,
                  color: sel ? Theme.text : Theme.textMuted,
                }}>
                  {h.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Text style={sheetStyles.label}>Model</Text>
      <View style={sheetStyles.card}>
        {models.map((m, ix) => {
          const sel = m.id === props.modelId;
          return (
            <React.Fragment key={m.id}>
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  props.onModelChange(m.id);
                  if (m.reasoningLevels.includes(props.reasoning ?? '')) return;
                  props.onReasoningChange(HarnessCatalog.defaultReasoningFor(m) ?? undefined);
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 11,
                  backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent',
                })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: Fonts.sans, fontSize: 15, color: Theme.text }}>{m.label}</Text>
                  {m.description ? (
                    <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.textMuted, marginTop: 2 }}>
                      {m.description}
                    </Text>
                  ) : null}
                </View>
                <Text style={{
                  fontFamily: Fonts.sansSemiBold,
                  fontSize: 14,
                  color: Theme.text,
                  opacity: sel ? 1 : 0,
                }}>✓</Text>
              </Pressable>
              {ix < models.length - 1 ? <View style={sheetStyles.separator} /> : null}
            </React.Fragment>
          );
        })}
      </View>

      {selected && selected.reasoningLevels.length > 0 ? (
        <>
          <Text style={[sheetStyles.label, { marginTop: 16 }]}>Reasoning</Text>
          <View style={sheetStyles.card}>
            {selected.reasoningLevels.map((level: string, ix: number) => {
              const sel = props.reasoning === level;
              return (
                <React.Fragment key={level}>
                  <Pressable
                    onPress={() => props.onReasoningChange(level)}
                    style={({ pressed }) => ({
                      paddingHorizontal: 16,
                      paddingVertical: 11,
                      backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent',
                    })}
                  >
                    <Text style={{ fontFamily: Fonts.sans, fontSize: 15, color: Theme.text }}>
                      {HarnessCatalog.reasoningLabel(level)}
                    </Text>
                    {HarnessCatalog.effortHint(level) ? (
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.textMuted }}>
                        {HarnessCatalog.effortHint(level)}
                      </Text>
                    ) : null}
                  </Pressable>
                  {ix < selected.reasoningLevels.length - 1 ? <View style={sheetStyles.separator} /> : null}
                </React.Fragment>
              );
            })}
          </View>
        </>
      ) : null}

      <Text style={[sheetStyles.label, { marginTop: 16 }]}>Permission mode</Text>
      <View style={sheetStyles.card}>
        {PERMISSION_MODES.map((mode, ix) => {
          const sel = mode.value === props.permissionMode;
          return (
            <React.Fragment key={mode.value}>
              <Pressable
                onPress={() => props.onPermissionModeChange(mode.value)}
                style={({ pressed }) => ({
                  paddingHorizontal: 16,
                  paddingVertical: 11,
                  backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent',
                })}
              >
                <Text style={{ fontFamily: Fonts.sans, fontSize: 15, color: Theme.text }}>{mode.label}</Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.textMuted }}>
                  {mode.description}
                </Text>
              </Pressable>
              {ix < PERMISSION_MODES.length - 1 ? <View style={sheetStyles.separator} /> : null}
            </React.Fragment>
          );
        })}
      </View>
    </SheetShell>
  );
}

function RefPickerSheet({ refs, selected, onPick, onClose }: {
  refs: RepoRef[];
  selected?: string;
  onPick: (ref: RepoRef) => Promise<string | null>;
  onClose: () => void;
}) {
  const [switching, setSwitching] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  return (
    <SheetShell title="Select ref" onClose={onClose}>
      <Text style={sheetStyles.label}>Ref</Text>
      {refs.length === 0 ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: Theme.textFaint, paddingVertical: 20 }}>
          Loading refs from the device…
        </Text>
      ) : (
        <View style={sheetStyles.card}>
          {refs.map((ref, ix) => {
            const sel = ref.name === selected;
            return (
              <React.Fragment key={ref.name}>
                <Pressable
                  onPress={async () => {
                    if (switching || sel) return;
                    void Haptics.selectionAsync();
                    setError(null);
                    setSwitching(ref.name);
                    const result = await onPick(ref);
                    setSwitching(undefined);
                    if (result) setError(result); else onClose();
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingHorizontal: 16,
                    paddingVertical: 11,
                    backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent',
                  })}
                >
                  <LineIcon icon="gitBranch" size={15} color={Theme.textMuted} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: Fonts.sans, fontSize: 15, color: Theme.text }}>{ref.name}</Text>
                    {ref.current ? (
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.textMuted }}>
                        Current checkout
                      </Text>
                    ) : ref.worktreePath ? (
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.textMuted }}>
                        Checked out in a worktree
                      </Text>
                    ) : null}
                  </View>
                  <Text style={{
                    fontFamily: Fonts.sansSemiBold,
                    fontSize: 14,
                    color: Theme.text,
                    opacity: sel ? 1 : 0,
                  }}>✓</Text>
                </Pressable>
                {ix < refs.length - 1 ? <View style={sheetStyles.separator} /> : null}
              </React.Fragment>
            );
          })}
        </View>
      )}
      {error ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.danger, marginTop: 8 }}>
          {error}
        </Text>
      ) : null}
    </SheetShell>
  );
}

function CheckoutPickerSheet({ kind, selectedRefHasWorktree, onPick, onClose }: {
  kind: CheckoutKind;
  selectedRefHasWorktree: boolean;
  onPick: (k: CheckoutKind) => void;
  onClose: () => void;
}) {
  return (
    <SheetShell title="Checkout" onClose={onClose}>
      <Text style={sheetStyles.label}>Checkout</Text>
      <View style={sheetStyles.card}>
        <Pressable
          onPress={() => { void Haptics.selectionAsync(); onPick('local'); onClose(); }}
          style={({ pressed }) => ({
            paddingHorizontal: 16,
            paddingVertical: 11,
            backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent',
          })}
        >
          <Text style={{ fontFamily: Fonts.sans, fontSize: 15, color: Theme.text }}>
            {selectedRefHasWorktree ? 'Current worktree' : 'Current checkout'}
          </Text>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.textMuted }}>
            {selectedRefHasWorktree ? "Reuse the picked ref's existing worktree" : "Run in the space's folder as-is"}
          </Text>
        </Pressable>
        <View style={sheetStyles.separator} />
        <Pressable
          onPress={() => { void Haptics.selectionAsync(); onPick('newWorktree'); onClose(); }}
          style={({ pressed }) => ({
            paddingHorizontal: 16,
            paddingVertical: 11,
            backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent',
          })}
        >
          <Text style={{ fontFamily: Fonts.sans, fontSize: 15, color: Theme.text }}>New worktree</Text>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.textMuted }}>
            A fresh isolated worktree created off the picked base ref
          </Text>
        </Pressable>
      </View>
    </SheetShell>
  );
}

function WorkflowPickerSheet({ selectedId, prRef, onSelect, onPrRefChange, onClose }: {
  selectedId: string;
  prRef: string;
  onSelect: (id: string) => void;
  onPrRefChange: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <SheetShell title="Workflow" onClose={onClose}>
      <Text style={sheetStyles.label}>Workflow</Text>
      <View style={sheetStyles.card}>
        {WorkflowCatalog.all.map((wf: WorkflowDefinition, ix) => (
          <React.Fragment key={wf.id}>
            <Pressable
              onPress={() => { onSelect(wf.id); onClose(); }}
              style={({ pressed }) => ({
                paddingHorizontal: 16,
                paddingVertical: 11,
                backgroundColor: pressed ? whiteAlpha(0.06) : 'transparent',
              })}
            >
              <Text style={{ fontFamily: Fonts.sans, fontSize: 15, color: Theme.text }}>{wf.label}</Text>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: Theme.textMuted }}>{wf.description}</Text>
            </Pressable>
            {ix < WorkflowCatalog.all.length - 1 ? <View style={sheetStyles.separator} /> : null}
          </React.Fragment>
        ))}
        {WorkflowCatalog.all.find((w) => w.id === selectedId)?.needsPrRef ? (
          <>
            <View style={sheetStyles.separator} />
            <TextInput
              placeholder="PR or branch reference"
              value={prRef}
              onChangeText={onPrRefChange}
            />
          </>
        ) : null}
      </View>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  offlineNotice: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: withAlpha(Theme.warning, 0.1),
    borderRadius: 12,
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
});

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
  label: {
    fontFamily: Fonts.sansMedium,
    fontSize: 11,
    color: withAlpha(Theme.textMuted, 0.6),
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  card: {
    backgroundColor: whiteAlpha(0.045),
    borderColor: whiteAlpha(0.06),
    borderWidth: 1,
    borderRadius: 20,
    overflow: 'hidden',
  },
  separator: {
    height: 1,
    backgroundColor: whiteAlpha(0.06),
    marginLeft: 16,
  },
});

// Silence unused imports
void effectivePermissionMode;
