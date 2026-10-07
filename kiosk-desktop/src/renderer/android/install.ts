/**
 * The Android entry's first module (android/main.tsx imports it BEFORE the screens): puts the
 * Android bridges on `window.kiosk` / `window.r2m`, where renderer/bridge.ts and
 * roles/shellBridge.ts look first — so the screens run unchanged on the APK's native services.
 *
 * It also tells the APK's watchdog (pos-android ui/kiosk/web/KioskWebWatchdog.kt) what it needs:
 * `ready` once the first screen is drawn, `error` for what is thrown (fatal when nothing is left
 * on screen) — the APK goes back to its built-in screens on no ready, a renderer crash or
 * repeated errors.
 */

import { apkSupports, createAndroidBridges, errorText, guardStaffCorners, injectScan, type AndroidInbox, type AndroidNative, type ScreenError } from '../bridges/android';
import type { KioskBridge } from '../../shared/bridge';
import type { ShellBridge } from '../../shared/roles';

declare const __KIOSK_BUNDLE__: { version: string; versionCode: number; bridgeApi: number } | undefined;

type AndroidWindow = Window & { R2MAndroid?: AndroidNative; __r2mAndroid?: AndroidInbox; kiosk?: KioskBridge; r2m?: ShellBridge };

const win = window as AndroidWindow;
const native = win.R2MAndroid;
const bundle = typeof __KIOSK_BUNDLE__ !== 'undefined' ? __KIOSK_BUNDLE__ : null;

function tell(method: 'ready' | 'error', payload: unknown) {
  try {
    native?.send(method, JSON.stringify(payload));
  } catch {
    /* nothing to tell it with */
  }
}

if (!native) {
  // Opened outside the APK (a desktop browser on the bundle's files): the demo bridge of
  // renderer/bridge.ts stands in, as in `npm run dev:web`.
  console.warn('kiosk bundle: no R2MAndroid — running on the demo bridge');
} else if (!apkSupports(native.bridgeApi?.())) {
  // The APK checks this before it loads a bundle; a second look costs nothing.
  tell('error', { message: `bridgeApi ${String(native.bridgeApi?.())} < ${bundle?.bridgeApi ?? '?'}`, source: 'bridge_api', line: null, fatal: true } satisfies ScreenError);
} else {
  const bridges = createAndroidBridges(native, {
    onScan: (code) => injectScan(code, win, (k) => new KeyboardEvent('keydown', { key: k.key, code: k.code, ctrlKey: k.ctrlKey, bubbles: true, cancelable: true })),
  });
  win.__r2mAndroid = bridges.inbox;
  win.kiosk = bridges.kiosk;
  win.r2m = bridges.shell;
  guardStaffCorners(win);

  let readySent = false;
  const root = () => document.getElementById('root');
  const drawn = () => (root()?.childElementCount ?? 0) > 0;

  // A render error unmounts React's tree a moment after it is thrown: "fatal" is read a little later.
  const report = (reason: unknown, source: string | null, line: number | null) => {
    const message = errorText(reason);
    window.setTimeout(() => tell('error', { message, source, line, fatal: readySent && !drawn() } satisfies ScreenError), 50);
  };
  window.addEventListener('error', (e) => report(e.error ?? e.message, e.filename || null, e.lineno || null));
  window.addEventListener('unhandledrejection', (e) => report(e.reason, 'promise', null));

  // Ready = the first screen is in the page (not merely the script loaded).
  const markReady = () => {
    if (readySent || !drawn()) return false;
    readySent = true;
    tell('ready', { bundle, at: Date.now() });
    return true;
  };
  const watch = () => {
    const el = root();
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (markReady()) observer.disconnect();
    });
    observer.observe(el, { childList: true });
    markReady();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
  else watch();
}
