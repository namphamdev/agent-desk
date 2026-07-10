/**
 * Native desktop notifications via Electrobun (not the Web Notification API).
 * WKWebView does not reliably support window.Notification / permission prompts.
 */
import { Utils } from "electrobun/bun";

export type DesktopNotificationOpts = {
  title: string;
  body?: string;
  subtitle?: string;
  /** When true, OS plays no notification sound. */
  silent?: boolean;
};

export function showDesktopNotification(opts: DesktopNotificationOpts): boolean {
  try {
    Utils.showNotification({
      title: opts.title,
      body: opts.body,
      subtitle: opts.subtitle,
      silent: opts.silent ?? false,
    });
    return true;
  } catch (err) {
    console.warn("[notify] showNotification failed:", err);
    return false;
  }
}

/** Shown when the user turns notifications on (also triggers OS permission UI). */
export function showNotificationsEnabledToast(): void {
  showDesktopNotification({
    title: "Notifications enabled",
    body: "You'll get a banner when an agent task finishes.",
    silent: true,
  });
}

export function notifyTurnComplete(opts: {
  title: string;
  body?: string;
  /** Play the OS notification sound. */
  withSound: boolean;
}): void {
  showDesktopNotification({
    title: opts.title,
    body: opts.body,
    silent: !opts.withSound,
  });
}
