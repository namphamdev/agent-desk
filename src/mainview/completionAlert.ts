/**
 * Completion chime + desktop notification helpers (webview side).
 *
 * Native banners are delivered from the Bun process via Electrobun
 * Utils.showNotification (WKWebView does not support Web Notification
 * permission prompts). The webview still plays the in-app chime and can
 * request a native banner over RPC (e.g. Settings test).
 */

import { getRpc } from "./rpc";

export type CompletionAlertOptions = {
  enableNotifications: boolean;
  enableSound: boolean;
  /** When true, OS/native notification already handled on Bun side. */
  nativeNotificationHandled?: boolean;
  title?: string;
  body?: string;
};

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

/** Short two-tone chime (no external sound file). */
export function playCompletionSound(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    void ctx.resume();

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.12, now);
    master.connect(ctx.destination);

    const tones: Array<{ freq: number; start: number; dur: number }> = [
      { freq: 880, start: 0, dur: 0.1 },
      { freq: 1174.66, start: 0.1, dur: 0.16 },
    ];

    for (const t of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(t.freq, now + t.start);
      gain.gain.setValueAtTime(0.0001, now + t.start);
      gain.gain.exponentialRampToValueAtTime(1, now + t.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + t.start + t.dur,
      );
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + t.start);
      osc.stop(now + t.start + t.dur + 0.02);
    }
  } catch {
    /* autoplay blocked or AudioContext unavailable */
  }
}

/**
 * Request a native OS notification through the Bun host.
 * Falls back to the Web Notification API only in browser/dev without Electrobun.
 */
export async function showNativeNotification(opts: {
  title: string;
  body: string;
  silent?: boolean;
}): Promise<boolean> {
  try {
    const res = await getRpc().request.showDesktopNotification({
      title: opts.title,
      body: opts.body,
      silent: opts.silent ?? true,
    });
    if (res.ok) return true;
  } catch {
    /* browser mock / older bridge */
  }

  // Browser fallback only.
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }
  try {
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return false;
    const n = new Notification(opts.title, {
      body: opts.body,
      silent: opts.silent ?? true,
      tag: "terminal-react-turn-complete",
    });
    window.setTimeout(() => n.close(), 6000);
    return true;
  } catch {
    return false;
  }
}

/** Ask OS permission by showing a sample native notification. */
export async function ensureNotificationPermission(): Promise<boolean> {
  return showNativeNotification({
    title: "Notifications enabled",
    body: "You'll get a banner when an agent task finishes.",
    silent: true,
  });
}

/**
 * Fire completion sound and/or notification based on user settings.
 * In the desktop app, Bun already posts the native banner on turn end;
 * this mainly plays the chime and covers browser/dev fallbacks.
 */
export async function alertTurnComplete(
  opts: CompletionAlertOptions,
): Promise<void> {
  const title = opts.title?.trim() || "Task complete";
  const body = opts.body?.trim() || "The agent finished responding.";

  if (opts.enableNotifications && !opts.nativeNotificationHandled) {
    await showNativeNotification({
      title,
      body,
      silent: !opts.enableSound,
    });
  }

  // In-app chime only when sound is on and the OS banner is not providing sound.
  const osProvidesSound = opts.enableNotifications && opts.enableSound;
  if (opts.enableSound && !osProvidesSound) {
    playCompletionSound();
  }
}
