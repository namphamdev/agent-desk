// Sign-in — the OAuth authorization-code flow against WorkOS AuthKit, with
// the secret-bearing exchange delegated to the edge. The comet mark on black,
// one white button.

import { makeRedirectUri } from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { AppModel } from "../app/AppModel";
import { AuthOrg, AuthTokens } from "../auth/AuthClient";
import { Fonts, overlay, Theme } from "../theme/Theme";
import { fs, useThemedStyles } from "../theme/Appearance";

const EDGE_URL = process.env.EXPO_PUBLIC_EDGE_URL ?? "";
const WORKOS_CLIENT_ID = process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID ?? "";
const WORKOS_API_BASE = "https://api.workos.com";
const CALLBACK_SCHEME = "agentdeski";

function authorizeURL(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: WORKOS_CLIENT_ID,
    redirect_uri: `${CALLBACK_SCHEME}://callback`,
    provider: "authkit",
    state,
  });
  return `${WORKOS_API_BASE}/user_management/authorize?${params.toString()}`;
}

interface SignInProps {
  model: AppModel;
}

export function SignInView({ model }: SignInProps) {
  const styles = useThemedStyles(() => makeStyles(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const state = Math.random().toString(36).slice(2);
    const redirect = makeRedirectUri({
      scheme: CALLBACK_SCHEME,
      path: "callback",
    });
    const result = await WebBrowser.openAuthSessionAsync(
      authorizeURL(state),
      redirect,
    );
    if (result.type !== "success") {
      setBusy(false);
      return;
    }
    const params = new URLSearchParams(result.url.split("?")[1] ?? "");
    console.log('params', JSON.stringify(params))
    const code = params.get("code");
    const cbState = params.get("state");
    if (!code || cbState !== state) {
      setBusy(false);
      setError("Callback missing code or state mismatch");
      return;
    }
    try {
      await model.signIn(EDGE_URL, code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  return (
    <View style={styles.container}>
      <View style={{ flex: 1 }} />
      <View style={{ alignItems: "center", gap: 24 }}>
        <Image
          source={require("../../assets/agent-deski-logo.png")}
          style={{ width: 84, height: 84, resizeMode: "contain" }}
        />
        <View style={{ alignItems: "center", gap: 6 }}>
          <Text style={styles.title}>AgentDeski</Text>
          <Text style={styles.subtitle}>Your coding agents, from anywhere</Text>
        </View>
      </View>

      <View style={{ gap: 12, marginTop: 32 }}>
        <Pressable
          onPress={signIn}
          disabled={busy}
          style={({ pressed }) => ({
            opacity: busy ? 0.6 : pressed ? 0.85 : 1,
            backgroundColor: Theme.text,
            height: 50,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <Text style={styles.buttonText}>
            {busy ? "Signing in…" : "Log in to AgentDeski"}
          </Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
      <View style={{ flex: 1 }} />
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: Theme.bg,
      paddingHorizontal: 32,
      maxWidth: 480,
      width: "100%",
      alignSelf: "center",
    },
  title: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: fs(28),
    color: Theme.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: Fonts.sans,
    fontSize: fs(15),
    color: Theme.textMuted,
  },
  buttonText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: fs(15),
    color: Theme.bg,
  },
  error: {
    fontFamily: Fonts.sans,
    fontSize: fs(13),
    color: Theme.danger,
    textAlign: "center",
  },
  });
}

interface OrgPickerProps {
  model: AppModel;
  tokens: AuthTokens;
  orgs: AuthOrg[];
}

export function OrgPickerView({ model, tokens, orgs }: OrgPickerProps) {
  const styles = useThemedStyles(() => makeStyles(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const select = async (org: AuthOrg) => {
    setBusy(true);
    setError(null);
    try {
      await model.selectOrg(org, tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  return (
    <View style={[styles.container, { gap: 20 }]}>
      <View style={{ flex: 1 }} />
      <Text
        style={{
          fontFamily: Fonts.sansSemiBold,
          fontSize: fs(16),
          color: Theme.text,
        }}
      >
        Choose an organization
      </Text>
      <View style={{ gap: 8 }}>
        {orgs.map((org) => (
          <Pressable
            key={org.id}
            onPress={() => select(org)}
            disabled={busy}
            style={({ pressed }) => ({
              opacity: pressed ? 0.85 : 1,
              backgroundColor: overlay(0.04),
              height: 48,
              borderRadius: 14,
              paddingHorizontal: 16,
              flexDirection: "row",
              alignItems: "center",
            })}
          >
            <Text
              style={{
                flex: 1,
                fontFamily: Fonts.sansMedium,
                fontSize: fs(14),
                color: Theme.text,
              }}
            >
              {org.name}
            </Text>
            <Text style={{ color: Theme.textFaint, fontSize: fs(12) }}>›</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable onPress={() => model.signOut()}>
        <Text
          style={{
            fontFamily: Fonts.sans,
            fontSize: fs(13),
            color: Theme.textMuted,
          }}
        >
          Back
        </Text>
      </Pressable>
      <View style={{ flex: 1 }} />
    </View>
  );
}
