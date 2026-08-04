// Local push notifications — RN port of NotificationManager.swift.
// Fires a notification when the agent finishes a task (Working → Idle) or
// asks for input (→ AwaitingInput). Foreground notifications are suppressed
// when the active session IS the source.
//
// Background strategy: iOS suspends the WebSocket and JS runtime when the
// app is backgrounded, so we can't observe the working → idle transition
// in real time. To handle this, when the app goes to background with
// sessions in `working` state, we schedule a delayed "fallback" notification
// per session. These fire even while the app is suspended. When the app
// returns to foreground and we observe the real transition, we cancel the
// fallback for that session.

import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { AppState, AppStateStatus, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  nowMs,
  SessionStatusValue,
  SESSION_STALE_MS,
} from '../models/Entities';

const KEY_TASK_DONE = 'notifyTaskDone';
const KEY_INPUT_NEEDED = 'notifyInputNeeded';
const KEY_LAST_STATUS = 'notifyLastStatus';

// Delay before the fallback notification fires after backgrounding with
// sessions in `working` state. The idea: most tasks complete within a few
// minutes. When the fallback fires, it re-scans current session statuses.
// If the session is already idle/errored/awaitingInput, we show the
// notification. If still working, we reschedule another fallback.
const FALLBACK_DELAY_SECONDS = 120;
const FALLBACK_PREFIX = 'fallback-';

// On foreground, cancel all pending fallbacks and rescan immediately.
const FALLBACK_MAX_RESCHEDULES = 30; // safety cap: ~2 hours at 120s each

export class NotificationManager {
  static shared = new NotificationManager();

  taskDoneEnabled = true;
  inputNeededEnabled = true;
  authorizationStatus: 'granted' | 'denied' | 'undetermined' = 'undetermined';
  activeChatId?: string;

  private lastStatus = new Map<string, SessionStatusValue>();
  private lastStatusDirty = false;
  private appState: AppStateStatus = 'active';
  private fallbackRescheduleCount = new Map<string, number>();

  // Callback the AppModel sets so we can trigger a rescan when the app
  // returns to foreground or a fallback fires.
  onRescan?: () => void;

  // Callback fired when the user taps a notification (push or local) —
  // the App wires this to navigate to the relevant chat.
  onNotificationTap?: (chatId: string) => void;

  private constructor() {
    void this.hydrate();
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        priority: Notifications.AndroidNotificationPriority.DEFAULT,
      }),
    });
    // Android requires an explicit notification channel for scheduled
    // notifications to display (including in background).
    if (Platform.OS === 'android') {
      void Notifications.setNotificationChannelAsync('default', {
        name: 'AgentDeski',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
      });
    }
    // Persist lastStatus periodically (debounced) so transitions survive
    // app suspension/restart.
    setInterval(() => {
      if (this.lastStatusDirty) {
        this.lastStatusDirty = false;
        void this.saveLastStatus();
      }
    }, 5_000);

    // Listen for app state changes to manage fallback notifications.
    this.appState = AppState.currentState;
    AppState.addEventListener('change', (nextState) => this.handleAppStateChange(nextState));

    // Listen for fallback notification triggers — when a scheduled fallback
    // fires while the app is in background, we need to evaluate current
    // session states and potentially reschedule.
    Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as { chatId?: string; fallback?: boolean };
      if (data?.fallback) {
        console.info('[notify] fallback notification received for', data.chatId?.slice(0, 8));
        // The notification is already displayed by the OS. Nothing more to do.
      }
    });

    // When the user taps a notification (push or local), navigate to the chat.
    Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { chatId?: string };
      if (data?.chatId && this.onNotificationTap) {
        console.info('[notify] notification tapped, opening chat', data.chatId.slice(0, 8));
        this.onNotificationTap(data.chatId);
      }
    });
  }

  private async saveLastStatus(): Promise<void> {
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.lastStatus) {
        if (v) obj[k] = v;
      }
      await AsyncStorage.setItem(KEY_LAST_STATUS, JSON.stringify(obj));
    } catch {
      // best-effort
    }
  }

  private async hydrate(): Promise<void> {
    const taskDone = await AsyncStorage.getItem(KEY_TASK_DONE);
    const inputNeeded = await AsyncStorage.getItem(KEY_INPUT_NEEDED);
    this.taskDoneEnabled = taskDone === null ? true : taskDone === '1';
    this.inputNeededEnabled = inputNeeded === null ? true : inputNeeded === '1';
    // Restore lastStatus so transitions survive app restart/background.
    try {
      const raw = await AsyncStorage.getItem(KEY_LAST_STATUS);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(obj)) {
          this.lastStatus.set(k, v as SessionStatusValue);
        }
      }
    } catch {
      // best-effort
    }
    await this.refreshAuthStatus();
  }

  async refreshAuthStatus(): Promise<void> {
    const settings = await Notifications.getPermissionsAsync();
    this.authorizationStatus = settings.granted
      ? 'granted'
      : settings.canAskAgain
      ? 'undetermined'
      : 'denied';
  }

  async requestPermissionIfNeeded(): Promise<void> {
    if (this.authorizationStatus !== 'undetermined') return;
    const result = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    this.authorizationStatus = result.granted ? 'granted' : 'denied';
  }

  /**
   * Obtain (or retrieve cached) Expo push token and register it with the
   * edge via the provided callback. Returns the token or null.
   */
  expoPushToken: string | null = null;

  async registerForPushNotifications(
    registerFn: (token: string) => Promise<boolean>,
  ): Promise<string | null> {
    // Ensure auth status is fresh (hydrate may not have completed yet).
    await this.refreshAuthStatus();
    if (!this.canSendNotifications) {
      console.info('[notify] skip push token — no permission. authStatus=', this.authorizationStatus);
      return null;
    }
    if (this.expoPushToken) return this.expoPushToken;
    try {
      // In prebuild/bare apps, Constants.expoConfig may be stale or missing
      // the EAS projectId. Fall back to the hardcoded project ID from app.config.ts.
      const projectId =
        (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) ??
        '83b80ffb-ca4f-4bac-b5f5-a6ad54a4d634';
      const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
      this.expoPushToken = data;
      console.info('[notify] got Expo push token:', data.slice(0, 30) + '...');
      const ok = await registerFn(data);
      if (!ok) {
        console.warn('[notify] edge push register failed; will retry on next connect');
      } else {
        console.info('[notify] push token registered with edge');
      }
      return data;
    } catch (err) {
      console.warn('[notify] getExpoPushToken failed', err);
      return null;
    }
  }

  get canSendNotifications(): boolean {
    return this.authorizationStatus === 'granted';
  }

  // MARK: App state management

  private handleAppStateChange(nextState: AppStateStatus): void {
    this.appState = nextState;

    if (nextState === 'active') {
      // App returned to foreground: cancel all pending fallbacks and
      // trigger an immediate rescan to catch any missed transitions.
      void this.cancelAllFallbacks();
      if (this.onRescan) {
        this.onRescan();
      }
    } else if (nextState === 'background' || nextState === 'inactive') {
      // App going to background: schedule fallbacks for any sessions
      // currently in `working` state.
      this.scheduleFallbacksForWorkingSessions();
      // Drop lastStatus so the foreground rescan doesn't fire a duplicate
      // local notification for transitions the server-side push pipeline
      // already delivered while we were suspended. After clearing, the
      // post-sync statuses will be recorded as first observations (which
      // observeStatus already skips). The server push (edge /push/send
      // driven by the engine) is authoritative during background gaps.
      this.lastStatus.clear();
      // Persist the clear so a cold relaunch also starts fresh.
      this.lastStatusDirty = false;
      void AsyncStorage.removeItem(KEY_LAST_STATUS);
    }
  }

  // MARK: Background fallback notifications

  /**
   * For each session currently known to be in `working` state, schedule a
   * delayed notification that will fire even if the app is suspended. The
   * notification content is generic ("task may have completed") since we
   * can't know the final state at schedule time.
   *
   * The AppModel calls this when transitioning to background.
   */
  scheduleFallbacksForWorkingSessions(): void {
    if (!this.canSendNotifications) return;

    for (const [chatId, status] of this.lastStatus) {
      if (status !== 'working') continue;

      const count = this.fallbackRescheduleCount.get(chatId) ?? 0;
      if (count >= FALLBACK_MAX_RESCHEDULES) continue;

      const identifier = `${FALLBACK_PREFIX}${chatId}`;
      const title = 'Task may have completed';
      const body = 'Tap to check the status of your session.';
      console.info('[notify] scheduling fallback for', chatId.slice(0, 8), `in ${FALLBACK_DELAY_SECONDS}s`);

      void Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title,
          body,
          sound: true,
          data: { chatId, fallback: true },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: FALLBACK_DELAY_SECONDS,
        } as Notifications.NotificationTriggerInput,
      }).catch((err) => console.warn('[notify] schedule fallback failed', err));
    }
  }

  /**
   * Cancel all pending fallback notifications (called on foreground).
   */
  async cancelAllFallbacks(): Promise<void> {
    try {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      for (const notif of scheduled) {
        if (notif.identifier.startsWith(FALLBACK_PREFIX)) {
          await Notifications.cancelScheduledNotificationAsync(notif.identifier);
          console.info('[notify] cancelled fallback', notif.identifier.slice(FALLBACK_PREFIX.length, FALLBACK_PREFIX.length + 8));
        }
      }
    } catch (err) {
      console.warn('[notify] cancelAllFallbacks failed', err);
    }
  }

  /**
   * Cancel the fallback for a specific chat (called when the real transition
   * is observed).
   */
  async cancelFallback(chatId: string): Promise<void> {
    try {
      await Notifications.cancelScheduledNotificationAsync(`${FALLBACK_PREFIX}${chatId}`);
    } catch {
      // best-effort
    }
  }

  setTaskDone(enabled: boolean): void {
    this.taskDoneEnabled = enabled;
    void AsyncStorage.setItem(KEY_TASK_DONE, enabled ? '1' : '0');
  }

  setInputNeeded(enabled: boolean): void {
    this.inputNeededEnabled = enabled;
    void AsyncStorage.setItem(KEY_INPUT_NEEDED, enabled ? '1' : '0');
  }

  observeStatus(
    chatId: string,
    rawStatus: SessionStatusValue | undefined,
    updatedAt: number | undefined,
    now: number,
    chatTitle?: string,
  ): void {
    const previous = this.lastStatus.get(chatId);
    this.lastStatus.set(chatId, rawStatus as SessionStatusValue);
    this.lastStatusDirty = true;
    if (!rawStatus) {
      console.info('[notify] observe', chatId.slice(0, 8), 'status=undefined, skipping');
      return;
    }
    if (!previous) {
      console.info('[notify] observe', chatId.slice(0, 8), `first-seen=${rawStatus} (no previous, no notification)`);
      return;
    }
    if (previous === rawStatus) return;

    console.info('[notify] transition', chatId.slice(0, 8), `${previous} → ${rawStatus}, updatedAt=${updatedAt}, age=${updatedAt !== undefined ? now - updatedAt : '?'}ms`);

    if (updatedAt !== undefined) {
      switch (rawStatus) {
        case 'working':
        case 'awaitingInput': {
          const age = now - updatedAt;
          if (age > SESSION_STALE_MS) return;
          break;
        }
        case 'idle':
        case 'errored':
          break;
      }
    }

    switch (rawStatus) {
      case 'idle':
        if (previous !== 'working') return;
        if (!this.taskDoneEnabled) return;
        void this.cancelFallback(chatId);
        this.fire(
          `done-${chatId}-${nowMs()}`,
          'Task complete',
          chatTitle ? `${chatTitle} finished its work.` : 'The agent finished its work.',
          chatId,
        );
        break;
      case 'awaitingInput':
        if (!this.inputNeededEnabled) return;
        void this.cancelFallback(chatId);
        this.fire(
          `input-${chatId}-${nowMs()}`,
          'Input needed',
          chatTitle ? `${chatTitle} is waiting for your response.` : 'The agent is waiting for your response.',
          chatId,
        );
        break;
      case 'errored':
        if (previous !== 'working') return;
        if (!this.taskDoneEnabled) return;
        void this.cancelFallback(chatId);
        this.fire(
          `error-${chatId}-${nowMs()}`,
          'Task failed',
          chatTitle ? `${chatTitle} ran into an error.` : 'The agent encountered an error.',
          chatId,
        );
        break;
      case 'working':
        break;
    }
  }

  clearAll(): void {
    void Notifications.dismissAllNotificationsAsync();
    void Notifications.cancelAllScheduledNotificationsAsync();
    this.lastStatus.clear();
    this.fallbackRescheduleCount.clear();
    void AsyncStorage.removeItem(KEY_LAST_STATUS);
  }

  private async fire(identifier: string, title: string, body: string, chatId: string): Promise<void> {
    if (!this.canSendNotifications) {
      console.info('[notify] fire suppressed — no permission. authStatus=', this.authorizationStatus);
      return;
    }
    if (this.activeChatId === chatId) {
      console.info('[notify] fire suppressed — chat is active (foreground)');
      return;
    }
    console.info('[notify] firing notification:', title, 'for chat', chatId.slice(0, 8));
    try {
      await Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title,
          body,
          sound: true,
          data: { chatId },
          ...(Platform.OS === 'android' ? { channelId: 'default' } : {}),
        },
        trigger: null, // immediate
      });
    } catch (err) {
      console.warn('[notify] fire failed', err);
    }
  }
}

export type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined';

// Silence unused-import lints on Android (where Linking is unused).
void Platform;
