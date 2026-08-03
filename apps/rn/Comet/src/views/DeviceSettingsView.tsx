// DeviceSettingsView — RN port of DeviceSettingsView.swift. Configure ACP
// agents and custom providers for a device.

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppModel } from '../app/AppModel';
import { useForceUpdateOnNotify } from '../lib/hooks';
import {
  AcpAgentsSnapshot,
  CustomProviderSnapshot,
} from '../models/Entities';
import { Fonts, Theme } from '../theme/Theme';
import { withAlpha, whiteAlpha } from '../theme/color';

interface Props {
  model: AppModel;
  deviceId: string;
  onBack: () => void;
}

export function DeviceSettingsView({ model, deviceId, onBack }: Props) {
  useForceUpdateOnNotify(model);
  const [acp, setAcp] = useState<AcpAgentsSnapshot | null>(null);
  const [providers, setProviders] = useState<CustomProviderSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const [a, p] = await Promise.all([
        model.acpAgents(deviceId),
        model.customProviders(deviceId),
      ]);
      setAcp(a);
      setProviders(p);
      setLoading(false);
    })();
  }, [model, deviceId]);

  const device = (model.demo?.devices ?? model.workspace?.devices)?.find((d) => d.id === deviceId);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Theme.surface }} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ color: Theme.text, fontSize: 22 }}>‹</Text>
        </Pressable>
        <Text style={styles.title}>{device?.name ?? deviceId}</Text>
        <View style={{ width: 28 }} />
      </View>
      {loading ? (
        <View style={{ alignItems: 'center', paddingTop: 40 }}>
          <ActivityIndicator color={Theme.textMuted} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {acp ? (
            <Section title="ACP Agents">
              {acp.installed.length === 0 && acp.registry.length === 0 ? (
                <Text style={styles.empty}>No ACP agents discovered.</Text>
              ) : (
                <>
                  {acp.installed.map((agent) => (
                    <View key={agent.id} style={styles.row}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{agent.name}</Text>
                        <Text style={styles.rowSub}>
                          {agent.id} · {acp.activeAgentId === agent.id ? 'Active' : 'Installed'}
                        </Text>
                      </View>
                    </View>
                  ))}
                  {acp.registry.length > 0 ? (
                    <View style={[styles.row, { borderTopWidth: acp.installed.length > 0 ? 1 : 0, borderTopColor: 'rgba(255,255,255,0.05)' }]}>
                      <Text style={[styles.rowSub, { flex: 1 }]}>
                        {acp.registry.length} agents available in registry
                      </Text>
                    </View>
                  ) : null}
                </>
              )}
            </Section>
          ) : null}
          {providers ? (
            <Section title="Custom Providers">
              {providers.providers.length === 0 ? (
                <Text style={styles.empty}>No custom providers configured.</Text>
              ) : (
                providers.providers.map((p) => (
                  <View key={p.id} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{p.name}</Text>
                      <Text style={styles.rowSub}>{p.baseUrl}</Text>
                    </View>
                  </View>
                ))
              )}
            </Section>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 24 }}>
      <Text style={styles.sectionHeader}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    fontSize: 14,
    color: Theme.text,
  },
  sectionHeader: {
    fontFamily: Fonts.sansMedium,
    fontSize: 11,
    color: withAlpha(Theme.textMuted, 0.6),
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: whiteAlpha(0.04),
    borderRadius: 16,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: whiteAlpha(0.05),
  },
  rowTitle: {
    fontFamily: Fonts.sans,
    fontSize: 14,
    color: Theme.text,
  },
  rowSub: {
    fontFamily: Fonts.sans,
    fontSize: 12,
    color: Theme.textMuted,
    marginTop: 2,
  },
  empty: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Theme.textFaint,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
});


