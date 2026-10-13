/**
 * "התראות בנייד שחובה להפעיל" (P:/specs/pwa-push-required.md §2–3) — the dashboard's `PushGate`
 * (components/dashboard/push-gate): on a phone or a tablet only, never on a computer.
 *
 * * **Install** — opened in the phone's browser and not installed: "התקן את R2M כאפליקציה"
 *   (Android: the system's install prompt; iPhone: Share → "הוסף למסך הבית", iOS ≥ 16.4).
 * * **Enable** — the "הפעל התראות" screen: one tap asks the system's permission and registers the
 *   device, a test notification follows, "קיבלתי" confirms. First open from the icon; with
 *   `required`, on every open until on.
 * * **Every open** — permission, this device on the server, not failing: re-subscribed silently
 *   when the permission is there and the registration is not.
 * * **Bars** — `reminder`: orange, closable for 24 h; `required`: red, never closable; blocked
 *   in the system: how to unblock it, per platform.
 *
 * Pure (no React, no network, no browser globals) so `npm test` runs it with node:test; the
 * component gathers the facts and keeps the flags in localStorage through `safeGet` / `safeSet`.
 */

import type { PushMode } from './pushPolicy';

export type GatePlatform = 'android' | 'ios' | 'other_mobile' | 'desktop';

export interface DeviceFacts {
  userAgent: string;
  /** `navigator.maxTouchPoints` — an iPad on iPadOS 13+ says it is a Mac; only this tells. */
  maxTouchPoints?: number;
  /** The screen's short side in CSS px (`Math.min(screen.width, screen.height)`). */
  screenShortSide?: number | null;
}

export function detectPlatform(f: DeviceFacts): GatePlatform {
  const ua = f.userAgent || '';
  if (/iPhone|iPod|iPad/.test(ua)) return 'ios';
  if (/Macintosh/.test(ua) && (f.maxTouchPoints ?? 0) > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Mobi|Mobile|IEMobile|Opera Mini|BlackBerry|webOS|KaiOS/i.test(ua)) return 'other_mobile';
  return 'desktop';
}

/** A screen this wide on its short side is a computer's, whatever the browser says. */
export const DESKTOP_SHORT_SIDE = 1100;

/** The gate is for phones and tablets: never a computer (its user agent or its width). */
export function gateApplies(f: DeviceFacts): boolean {
  if (detectPlatform(f) === 'desktop') return false;
  return !(typeof f.screenShortSide === 'number' && f.screenShortSide >= DESKTOP_SHORT_SIDE);
}

/** iOS / iPadOS version from the user agent, or null when it does not say. */
export function iosVersion(userAgent: string): { major: number; minor: number } | null {
  const m = /OS (\d+)[_.](\d+)(?:[_.]\d+)? like Mac OS X/.exec(userAgent) ?? /Version\/(\d+)\.(\d+)/.exec(userAgent);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Web Push on iOS: an installed app on 16.4 or later (unknown version: assume it can). */
export function iosPushCapable(userAgent: string): boolean {
  const v = iosVersion(userAgent);
  if (!v) return true;
  return v.major > 16 || (v.major === 16 && v.minor >= 4);
}

// ── The facts and what the gate shows ────────────────────────────────────────

export type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export interface GateFacts {
  /** A phone or a tablet (`gateApplies`). */
  applies: boolean;
  /** The server can push (VAPID configured). */
  configured: boolean;
  mode: PushMode;
  platform: GatePlatform;
  /** Opened from the home-screen icon (display-mode standalone). */
  standalone: boolean;
  /** Service worker, PushManager and Notification are all here. */
  supported: boolean;
  /** iOS ≥ 16.4 (true on every other platform). */
  iosCapable: boolean;
  permission: PermissionState;
  /** This browser's subscription is one of my active devices and not failing. */
  registered: boolean;
  /** Notifications were turned off on this device on purpose ("הפסק כאן"). */
  stoppedHere: boolean;
  /** A silent re-subscribe was already tried on this open (it did not help: show the bar). */
  resubscribeTried: boolean;
  /** Chrome's install offer (`beforeinstallprompt`) is in hand. */
  installPrompt: boolean;
  reminderSnoozed: boolean;
  installSnoozed: boolean;
  /** The first-open screen was already shown on this device. */
  onboarded: boolean;
  /** The screen was closed in this session ("לא עכשיו"). */
  screenClosed: boolean;
}

/** install → enable → (test, inside the screen) → ok. */
export type GateStage = 'install' | 'enable' | 'ok';

export function gateStage(f: Pick<GateFacts, 'permission' | 'registered' | 'platform' | 'standalone'>): GateStage {
  if (f.permission === 'granted' && f.registered) return 'ok';
  if (f.platform === 'ios' && !f.standalone) return 'install';
  return 'enable';
}

export type BannerKind =
  | 'none'
  | 'install' // a suggestion: nothing requires it
  | 'install_required' // iPhone: notifications need the installed app
  | 'ios_update' // iPhone below 16.4
  | 'unsupported' // this browser cannot receive notifications
  | 'denied' // blocked in the system: how to unblock
  | 'reminder'
  | 'required';

export type BannerTone = 'neutral' | 'warning' | 'danger';

export interface GateView {
  stage: GateStage;
  banner: BannerKind;
  tone: BannerTone;
  /** Reminder (24 h) and install (7 days) only; a required bar never closes. */
  dismissible: boolean;
  /** Open the "הפעל התראות" screen by itself now. */
  autoScreen: boolean;
  /** Permission granted, registration missing: register again without asking anything. */
  resubscribe: boolean;
}

const NOTHING: Omit<GateView, 'stage'> = { banner: 'none', tone: 'neutral', dismissible: false, autoScreen: false, resubscribe: false };

/** Whether installing is worth offering here (in the browser, on a phone). */
export function offersInstall(f: Pick<GateFacts, 'standalone' | 'platform' | 'installPrompt'>): boolean {
  if (f.standalone) return false;
  return f.platform === 'ios' || f.platform === 'android' || f.installPrompt;
}

export function gateView(f: GateFacts): GateView {
  const stage = gateStage(f);
  if (!f.applies) return { ...NOTHING, stage };
  const install: Omit<GateView, 'stage'> =
    offersInstall(f) && !f.installSnoozed ? { ...NOTHING, banner: 'install', dismissible: true } : NOTHING;
  const resubscribe =
    f.configured &&
    f.mode !== 'off' &&
    f.supported &&
    f.permission === 'granted' &&
    !f.registered &&
    !f.stoppedHere &&
    !f.resubscribeTried &&
    !(f.platform === 'ios' && !f.standalone);
  // Nothing asked of this user, or nothing missing here (or only a silent re-subscribe).
  if (!f.configured || f.mode === 'off' || stage === 'ok' || resubscribe) return { ...install, stage, resubscribe };

  const dismissible = f.mode === 'reminder';
  if (dismissible && f.reminderSnoozed) return { ...install, stage };
  let banner: BannerKind;
  if (f.platform === 'ios' && !f.iosCapable) banner = 'ios_update';
  else if (stage === 'install') banner = 'install_required';
  else if (!f.supported) banner = 'unsupported';
  else if (f.permission === 'denied') banner = 'denied';
  else banner = f.mode;
  // Required: on every open. Reminder: once, the first time the app opens from its icon.
  const autoScreen = !f.screenClosed && (f.mode === 'required' || (f.standalone && !f.onboarded));
  return {
    stage,
    banner,
    tone: f.mode === 'required' ? 'danger' : 'warning',
    dismissible,
    autoScreen,
    resubscribe: false,
  };
}

// ── The "הפעל התראות" screen ─────────────────────────────────────────────────

export type FlowStep =
  | 'install' // iPhone in Safari: install first
  | 'update_ios'
  | 'unsupported'
  | 'enable' // "אפשר התראות"
  | 'working'
  | 'test' // "שלחנו התראת בדיקה — הגיעה?"
  | 'not_received'
  | 'denied'
  | 'error'
  | 'done';

export type FlowEvent =
  | 'tap_enable' // the button: ask the system, register
  | 'subscribed' // registered, the test sent
  | 'denied' // the system said no (or it was blocked already)
  | 'failed'
  | 'received' // "קיבלתי"
  | 'not_received' // "לא הגיעה"
  | 'resent'; // the test sent again

export function initialStep(
  f: Pick<GateFacts, 'platform' | 'standalone' | 'iosCapable' | 'supported' | 'permission' | 'registered'>,
): FlowStep {
  if (f.platform === 'ios' && !f.iosCapable) return 'update_ios';
  if (f.platform === 'ios' && !f.standalone) return 'install';
  if (!f.supported) return 'unsupported';
  if (f.permission === 'denied') return 'denied';
  if (f.permission === 'granted' && f.registered) return 'done';
  return 'enable';
}

export function nextStep(step: FlowStep, event: FlowEvent): FlowStep {
  switch (event) {
    case 'tap_enable':
      return step === 'enable' || step === 'error' || step === 'denied' ? 'working' : step;
    case 'subscribed':
      return step === 'working' ? 'test' : step;
    case 'denied':
      return step === 'working' || step === 'enable' ? 'denied' : step;
    case 'failed':
      return step === 'working' ? 'error' : step;
    case 'received':
      return step === 'test' || step === 'not_received' ? 'done' : step;
    case 'not_received':
      return step === 'test' ? 'not_received' : step;
    case 'resent':
      return step === 'not_received' ? 'test' : step;
    default:
      return step;
  }
}

// ── Help texts per platform (message keys under `pushGate.help`) ─────────────

export type DeniedHelp = 'android_app' | 'android_browser' | 'ios_app' | 'other';

/** How to unblock notifications the system blocked: the browser cannot ask again. */
export function deniedHelp(platform: GatePlatform, standalone: boolean): DeniedHelp {
  if (platform === 'android') return standalone ? 'android_app' : 'android_browser';
  if (platform === 'ios') return 'ios_app';
  return 'other';
}

export type InstallHelp = 'android_prompt' | 'android_menu' | 'ios_steps' | 'ios_update' | 'none';

export function installHelp(
  f: Pick<GateFacts, 'platform' | 'standalone' | 'installPrompt' | 'iosCapable'>,
): InstallHelp {
  if (f.standalone) return 'none';
  if (f.platform === 'ios') return f.iosCapable ? 'ios_steps' : 'ios_update';
  if (f.installPrompt) return 'android_prompt';
  if (f.platform === 'android' || f.platform === 'other_mobile') return 'android_menu';
  return 'none';
}

// ── Flags on this device ─────────────────────────────────────────────────────

export const REMINDER_SNOOZE_MS = 24 * 60 * 60 * 1000;
export const INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage / sessionStorage, or a stand-in. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A read that never throws (private mode, blocked storage): null instead. */
export function safeGet(store: KeyValueStore | null | undefined, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

/** A write that never throws; null removes. */
export function safeSet(store: KeyValueStore | null | undefined, key: string, value: string | null): void {
  try {
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Storage blocked: the bar simply shows again next time.
  }
}

export function snoozedUntil(raw: string | null, now: number): boolean {
  const until = raw ? Number(raw) : NaN;
  return Number.isFinite(until) && until > now;
}

/** The keys, per user (a shared phone: each person's own reminder). */
export function gateKeys(userId: string) {
  const base = `r2m.pushGate.${userId}`;
  return {
    reminderUntil: `${base}.reminderUntil`,
    installUntil: `${base}.installUntil`,
    onboarded: `${base}.onboarded`,
    /** sessionStorage: the screen was closed in this session. */
    screenClosed: `${base}.screenClosed`,
  };
}

/** Per device, not per user: "הפסק כאן" turned this browser off (lib/pushAlertsApi.ts writes it). */
export const STOPPED_HERE_KEY = 'r2m.push.stoppedHere';
