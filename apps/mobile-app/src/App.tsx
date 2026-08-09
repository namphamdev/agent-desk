// App root — wires the AppModel state machine to the navigation graph, runs
// restore on mount, and selects between SignInView, OrgPickerView, and the
// main Home stack. Deep-link handler routes agentdeski://callback back to signIn.

import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StatusBar, Text, useColorScheme, View } from 'react-native';
import {
  NavigationContainer,
  DarkTheme,
  createNavigationContainerRef,
  type LinkingOptions,
} from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppModel } from './app/AppModel';
import { useAppModel } from './lib/hooks';
import { getActiveScheme, setActiveScheme, Theme } from './theme/Theme';
import { Appearance, fs, useAppearance } from './theme/Appearance';
import { SignInView, OrgPickerView } from './views/SignInView';
import { HomeView } from './views/HomeView';
import { SpaceView } from './views/SpaceView';
import { SessionView } from './views/SessionView';
import { NewSessionView } from './views/NewSessionView';
import { ChangesView } from './views/ChangesView';
import { SpaceGitView } from './views/SpaceGitView';
import { DeviceSettingsView } from './views/DeviceSettingsView';
import { NotificationSettingsView } from './views/NotificationSettingsView';
import { ActivityView } from './views/ActivityView';
import { MenuView } from './views/MenuView';
import { useEasUpdate } from './lib/useEasUpdate';
import { UpdateModal } from './components/UpdateModal';
// Keep the splash screen visible while we restore session.
void SplashScreen.preventAutoHideAsync();

// Navigation ref so the notification tap handler can navigate from outside
// the component tree.
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

export type RootStackParamList = {
  Home: undefined;
  Space: { spaceId: string };
  Chat: { chatId: string };
  NewSession: { spaceId: string };
  NewSpace: undefined;
  Changes: { chatId: string };
  SpaceGit: { spaceId: string };
  DeviceSettings: { deviceId: string };
  NotificationSettings: undefined;
  Activity: undefined;
  Menu: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Build a react-navigation theme that mirrors the active palette. The
 * getter-based Theme resolves colors at call time, so this object always
 * reads the current scheme when consumed by the navigator. */
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    get background() { return Theme.bg; },
    get card() { return Theme.surface; },
    get text() { return Theme.text; },
    get border() { return Theme.border; },
    get primary() { return Theme.text; },
  },
};

const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['agentdeski://'],
  config: {
    screens: {
      Home: '',
    },
  },
};

export default function App() {
  const model = useMemo(() => new AppModel(), []);
  const [restored, setRestored] = useState(false);
  const systemColorScheme = useColorScheme();
  // Subscribe to appearance changes so the tree re-renders when the user
  // switches theme mode or adjusts the minimum font size.
  useAppearance();

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([Appearance.hydrate(), model.restore()]);
      } finally {
        setRestored(true);
        void SplashScreen.hideAsync();
      }
    })();
  }, [model]);

  // Sync the active palette whenever the user's mode preference or the
  // system color scheme changes. setActiveScheme mutates the module-level
  // variable that Theme getters read, so the next render picks it up.
  useEffect(() => {
    const scheme = Appearance.effectiveScheme(systemColorScheme === 'light' ? 'light' : 'dark');
    setActiveScheme(scheme);
  }, [systemColorScheme, Appearance.themeMode]);

  // Periodically scan session statuses for notification transitions.
  useEffect(() => {
    if (model.phase.kind !== 'ready') return;
    const id = setInterval(() => model.scanSessionStatuses(), 15_000);
    return () => clearInterval(id);
  }, [model, model.phase.kind]);

  // Wire notification tap → navigate to the chat.
  useEffect(() => {
    model.notifications.onNotificationTap = (chatId: string) => {
      navigationRef.navigate('Chat', { chatId });
    };
    return () => {
      model.notifications.onNotificationTap = undefined;
    };
  }, [model]);

  useAppModel(model);

  // EAS OTA update check — looks for a newer bundle on launch, prompts via modal.
  const eas = useEasUpdate();
  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => { void eas.checkForUpdate(); }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored]);

  // Demo mode shortcut for development.
  useEffect(() => {
    const handler = (url: string) => {
      if (url.includes('demo')) {
        model.enterDemoMode();
      }
    };
    Linking.getInitialURL().then((url) => { if (url) handler(url); });
    const sub = Linking.addEventListener('url', ({ url }) => handler(url));
    return () => sub.remove();
  }, [model]);

  if (!restored) {
    return <View style={{ flex: 1, backgroundColor: Theme.bg }} />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={getActiveScheme() === 'light' ? 'dark-content' : 'light-content'}
        backgroundColor={Theme.bg}
      />
      <GestureHandlerRootView style={{ flex: 1 }}>
        <NavigationContainer ref={navigationRef} theme={navTheme} linking={linking}>
          {model.phase.kind === 'signedOut' ? (
            <SignInView model={model} />
          ) : model.phase.kind === 'pickingOrg' ? (
            <OrgPickerView
              model={model}
              tokens={model.phase.tokens}
              orgs={model.phase.orgs}
            />
          ) : (
            <MainStack model={model} />
          )}
        </NavigationContainer>
      </GestureHandlerRootView>
      <UpdateModal
        info={eas.available}
        downloading={eas.downloading}
        error={eas.error}
        onInstall={() => { void eas.downloadAndReload(); }}
        onDismiss={eas.dismiss}
      />
    </SafeAreaProvider>
  );
}

function MainStack({ model }: { model: AppModel }) {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Theme.bg },
      }}
    >
      <Stack.Screen name="Home">
        {(props) => <HomeView model={model} navigation={props.navigation} />}
      </Stack.Screen>
      <Stack.Screen name="Space" options={{ title: 'Space' }}>
        {(props) => (
          <SpaceView
            model={model}
            spaceId={props.route.params.spaceId}
            onOpenChat={(chatId) => props.navigation.navigate('Chat', { chatId })}
            onNewSession={() =>
              props.navigation.navigate('NewSession', { spaceId: props.route.params.spaceId })
            }
            onOpenGit={() =>
              props.navigation.navigate('SpaceGit', { spaceId: props.route.params.spaceId })
            }
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Chat" options={{ title: 'Chat' }}>
        {(props) => {
          const chat = model.chat(props.route.params.chatId);
          return (
            <SessionView
              model={model}
              chatId={props.route.params.chatId}
              onBack={() => props.navigation.goBack()}
              onOpenChanges={() => props.navigation.navigate('Changes', { chatId: props.route.params.chatId })}
              onOpenConfig={() => props.navigation.navigate('Menu')}
            />
          );
        }}
      </Stack.Screen>
      <Stack.Screen name="NewSession" options={{ title: 'New Session' }}>
        {(props) => (
          <NewSessionView
            model={model}
            spaceId={props.route.params.spaceId}
            onOpenChat={(chatId) =>
              props.navigation.reset({ index: 0, routes: [{ name: 'Home' }, { name: 'Chat', params: { chatId } }] })
            }
            onBack={() => props.navigation.goBack()}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="NewSpace" options={{ title: 'New Space' }}>
        {/* Placeholder — folder browser for creating a new space */}
        {(props) => (
          <NewSpaceView model={model} onDone={() => props.navigation.goBack()} />
        )}
      </Stack.Screen>
      <Stack.Screen name="Changes" options={{ title: 'Changes' }}>
        {(props) => {
          const chat = model.chat(props.route.params.chatId);
          if (!chat) return <View style={{ flex: 1, backgroundColor: Theme.bg }} />;
          return <ChangesView model={model} chat={chat} />;
        }}
      </Stack.Screen>
      <Stack.Screen name="SpaceGit" options={{ title: 'Git' }}>
        {(props) => (
          <SpaceGitView
            model={model}
            spaceId={props.route.params.spaceId}
            onBack={() => props.navigation.goBack()}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="DeviceSettings" options={{ title: 'Device' }}>
        {(props) => (
          <DeviceSettingsView
            model={model}
            deviceId={props.route.params.deviceId}
            onBack={() => props.navigation.goBack()}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="NotificationSettings" options={{ title: 'Notifications' }}>
        {(props) => (
          <NotificationSettingsView
            model={model}
            onBack={() => props.navigation.goBack()}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Activity" options={{ title: 'Activity' }}>
        {(props) => (
          <ActivityView
            model={model}
            onOpenChat={(chatId) => props.navigation.navigate('Chat', { chatId })}
            onBack={() => props.navigation.goBack()}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Menu" options={{ title: 'Settings' }}>
        {(props) => (
          <MenuView
            model={model}
            onBack={() => props.navigation.goBack()}
            onNotifications={() => props.navigation.navigate('NotificationSettings')}
            onDevice={(deviceId) => props.navigation.navigate('DeviceSettings', { deviceId })}
          />
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

// Minimal NewSpace placeholder — full folder-browser is a future enhancement.
function NewSpaceView({ model, onDone }: { model: AppModel; onDone: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: Theme.bg, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ flex: 1 }} />
      <View style={{ alignItems: 'center', gap: 12 }}>
        <Text style={{ fontFamily: 'Geist', fontSize: fs(15), color: Theme.textFaint }}>
          To add a space, pair a desktop device running AgentDeski.
        </Text>
      </View>
      <View style={{ flex: 1 }} />
      <PressableText onPress={onDone} label="Done" />
    </View>
  );
}

function PressableText({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <View style={{ paddingBottom: 32 }}>
      <Text
        onPress={onPress}
        style={{ fontFamily: 'Geist', fontSize: fs(14), color: Theme.text, padding: 12 }}
      >
        {label}
      </Text>
    </View>
  );
}
