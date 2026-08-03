// Local push notifications — RN port of NotificationManager.swift.
// Fires a notification when the agent finishes a task (Working → Idle) or
// asks for input (→ AwaitingInput). Foreground notifications are suppressed
// when the active session IS the source.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  nowMs,
  SessionStatusValue,
  SESSION_STALE_MS,
} from '../models/Entities';

const KEY_TASK_DONE = 'notifyTaskDone';
const KEY_INPUT_NEEDED = 'notifyInputNeeded';

export class NotificationManager {
  static shared = new NotificationManager();

  taskDoneEnabled = true;
  inputNeededEnabled = true;
  authorizationStatus: 'granted' | 'denied' | 'undetermined' = 'undetermined';
  activeChatId?: string;

  private lastStatus = new Map<string, SessionStatusValue>();

  private constructor() {
    void this.hydrate();
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        priority: Notifications.AndroidNotificationPriority.DEFAULT,
      }),
    });
  }

  private async hydrate(): Promise<void> {
    const taskDone = await AsyncStorage.getItem(KEY_TASK_DONE);
    const inputNeeded = await AsyncStorage.getItem(KEY_INPUT_NEEDED);
    this.taskDoneEnabled = taskDone === null ? true : taskDone === '1';
    this.inputNeededEnabled = inputNeeded === null ? true : inputNeeded === '1';
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

  get canSendNotifications(): boolean {
    return this.authorizationStatus === 'granted';
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
    if (!rawStatus) return;
    if (!previous) return;
    if (previous === rawStatus) return;

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
        this.fire(
          `done-${chatId}-${nowMs()}`,
          'Task complete',
          chatTitle ? `${chatTitle} finished its work.` : 'The agent finished its work.',
          chatId,
        );
        break;
      case 'awaitingInput':
        if (!this.inputNeededEnabled) return;
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
  }

  private async fire(identifier: string, title: string, body: string, chatId: string): Promise<void> {
    if (!this.canSendNotifications) return;
    if (this.activeChatId === chatId) return; // suppressed in foreground
    try {
      await Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title,
          body,
          sound: true,
          data: { chatId },
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
