/**
 * The kiosk's screens inside the Android app — one renderer, three hosts: Electron (the preload's
 * `window.kiosk`), the browser (the dashboard's kiosk route) and the Android WebView (pos-android
 * ui/kiosk/web), where THIS bridge speaks to the APK's JavaScript interface `window.R2MAndroid`
 * (KioskWebBridge.kt) instead of Electron's IPC. It implements the very KioskBridge and ShellBridge
 * the screens already use (shared/bridge.ts, shared/roles.ts), so no screen knows which host it is in.
 *
 * The wire (bridgeApi 1) is JSON text both ways:
 *
 *   JS → APK   R2MAndroid.call(id, method, argsJson)   an answer is due:
 *   APK → JS   window.__r2mAndroid.reply(id, ok, json) (evaluateJavascript), JSON of the result
 *              (ok) or of a message (not ok)
 *   JS → APK   R2MAndroid.send(method, argsJson)       one way, nothing comes back
 *   APK → JS   window.__r2mAndroid.event(name, json)   the APK's news (a new view, the payment…)
 *
 * What stays native on Android: the payment (Nayax LAN / Agamento), the documents and their
 * numbers, the Z, printing (the bon, the receipt, the pickup slip), the scanner hardware, the
 * device's health, and the staff — the admin's corner and the technician's taps are watched by
 * the APK over the WebView, so here the screens' own staff corners are kept quiet
 * ([guardStaffCorners]) and the staff calls answer "native".
 *
 * Every name on the wire is in test/fixtures/android_bridge_api.json — the same bytes as
 * pos-android app/src/test/resources/kiosk_web_bridge_api.json; both sides' tests pin them.
 */

import { resolveKioskConfig, type KioskLayer } from '@dash-lib/kioskConfig';
import type { KioskBridge, KioskEvents, KioskView, StartPaymentIn, StartPaymentOut } from '../../shared/bridge';
import type { ShellBridge, ShellEvents, ShellView } from '../../shared/roles';
import { ANDROID_BRIDGE_API, ANDROID_ORIGIN, type ANDROID_CALLS, type ANDROID_EVENTS, type ANDROID_SENDS } from './androidWire';

export { ANDROID_BRIDGE_API, ANDROID_CALLS, ANDROID_EVENTS, ANDROID_ORIGIN, ANDROID_SENDS } from './androidWire';

export type AndroidCall = (typeof ANDROID_CALLS)[number];
export type AndroidSend = (typeof ANDROID_SENDS)[number];
export type AndroidEvent = (typeof ANDROID_EVENTS)[number];

/** `window.R2MAndroid` — the APK's @JavascriptInterface (strings only cross it). */
export interface AndroidNative {
  /** The bridge API the APK speaks. */
  bridgeApi(): number;
  call(id: string, method: string, argsJson: string): void;
  send(method: string, argsJson: string): void;
}

/** `window.__r2mAndroid` — where the APK's answers and news land. */
export interface AndroidInbox {
  reply(id: string, ok: boolean, json: string | null): void;
  event(name: string, json: string | null): void;
}

/** How long an answer may take before the screen is told there is none (ms). */
export const CALL_TIMEOUT_MS: Record<AndroidCall, number> = {
  bootstrap: 20_000,
  shellView: 10_000,
  // The native payment checks the basket with the cloud (≤ 3 s) and the pinpad first.
  startPayment: 90_000,
  cancelPayment: 15_000,
  receiptChoice: 15_000,
  helpRequest: 15_000,
};

/** The staff's screens are the APK's on Android (its corners, its PIN, its admin). */
export const NATIVE_STAFF = 'ניהול הקיוסק נפתח מהמסך המובנה';
/** startPayment had no answer: the customer reads it, nothing was charged by this screen. */
export const PAY_NO_ANSWER = 'התשלום לא התחיל. אנא נסו שוב או פנו לצוות.';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Listeners = Map<string, Set<(p: unknown) => void>>;

function listen(map: Listeners, event: string, fn: (p: unknown) => void): () => void {
  const set = map.get(event) ?? new Set();
  map.set(event, set);
  set.add(fn);
  return () => void set.delete(fn);
}

function fire(map: Listeners, event: string, payload: unknown) {
  for (const fn of Array.from(map.get(event) ?? [])) {
    try {
      fn(payload);
    } catch (e) {
      // One screen's listener failing never stops the others hearing it.
      console.error(`kiosk bridge: ${event} listener failed`, e);
    }
  }
}

function parse(json: string | null): unknown {
  return json === null || json === '' ? null : JSON.parse(json);
}

/** A media reference on the device itself (the APK's origin, or inline). */
const isLocal = (url: string) => url.startsWith(`${ANDROID_ORIGIN}/`) || url.startsWith('data:');

/**
 * Every media reference left in the config on the device's own copy; one that is not becomes null
 * (and drops out of a list as `{media: null}`, and out of `categoryImages`) — the Windows kiosk's
 * localizeConfig (main/service.ts), so the screens never ask the network for a picture.
 */
export function localMediaOnly(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(localMediaOnly).filter((x) => !(x && typeof x === 'object' && 'media' in (x as object) && (x as { media: unknown }).media === null));
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.url === 'string' && (o.kind === 'image' || o.kind === 'video' || o.kind === 'font')) return isLocal(o.url) ? o : null;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = localMediaOnly(x);
    if (out.categoryImages && typeof out.categoryImages === 'object' && !Array.isArray(out.categoryImages)) {
      out.categoryImages = Object.fromEntries(Object.entries(out.categoryImages as Record<string, unknown>).filter(([, x]) => x));
    }
    return out;
  }
  return v;
}

/**
 * The APK sends the cloud's kiosk config as it came (its media already on the local copy): resolved
 * here against the screens' own defaults, as the Windows kiosk's main process resolves it
 * (resolveKioskConfig), with anything still remote dropped.
 */
export function normalizeView(view: KioskView): KioskView {
  if (!view || !view.config) return view;
  const resolved = resolveKioskConfig(view.config as KioskLayer);
  // The APK's web engine takes the card only (its own screens take the other methods): no "איך תרצו לשלם?".
  const pay = view.pay ?? { methods: ['card'], usable: ['card'], cardOff: null };
  return { ...view, pay, config: localMediaOnly(JSON.parse(JSON.stringify(resolved))) as Record<string, unknown> };
}

export interface AndroidBridges {
  kiosk: KioskBridge;
  shell: ShellBridge;
  inbox: AndroidInbox;
  /** Calls still waiting for the APK (for the tests). */
  pending(): number;
}

/**
 * The two bridges over [native]. [onScan]: a code the APK's scanner read (its keyboard wedge or its
 * scan head) — handed to the screens' own scanner ([injectScan]).
 */
export function createAndroidBridges(native: AndroidNative, opts: { onScan?: (code: string) => void; timeouts?: Partial<Record<AndroidCall, number>> } = {}): AndroidBridges {
  let seq = 0;
  const waiting = new Map<string, Pending>();
  const kioskOn: Listeners = new Map();
  const shellOn: Listeners = new Map();

  const call = <T>(method: AndroidCall, args: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = `c${++seq}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method}: no answer from the app`));
      }, opts.timeouts?.[method] ?? CALL_TIMEOUT_MS[method]);
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        native.call(id, method, JSON.stringify(args ?? {}));
      } catch (e) {
        clearTimeout(timer);
        waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  const send = (method: AndroidSend, payload: unknown) => {
    try {
      native.send(method, JSON.stringify(payload ?? null));
    } catch {
      /* the APK is going away: nothing to tell */
    }
  };

  const inbox: AndroidInbox = {
    reply(id, ok, json) {
      const p = waiting.get(id);
      if (!p) return;
      waiting.delete(id);
      clearTimeout(p.timer);
      let value: unknown;
      try {
        value = parse(json);
      } catch (e) {
        p.reject(new Error(`bad answer: ${String(e)}`));
        return;
      }
      if (ok) p.resolve(value);
      else p.reject(new Error(typeof value === 'string' ? value : ((value as { message?: string } | null)?.message ?? 'refused')));
    },
    event(name, json) {
      let payload: unknown;
      try {
        payload = parse(json);
      } catch {
        return;
      }
      switch (name as AndroidEvent) {
        case 'view':
          fire(kioskOn, name, normalizeView(payload as KioskView));
          return;
        case 'pay':
        case 'toast':
          fire(kioskOn, name, payload);
          return;
        case 'shell':
          fire(shellOn, 'view', payload);
          return;
        case 'scan': {
          const code = (payload as { code?: unknown } | null)?.code;
          if (typeof code === 'string' && code) opts.onScan?.(code);
          return;
        }
        default:
          // A newer APK's news this bundle does not know: ignored.
          return;
      }
    },
  };

  const noop = () => undefined;
  const kiosk: KioskBridge = {
    bootstrap: () => call<KioskView>('bootstrap', {}).then(normalizeView),
    // Android pairs natively (its own pairing screen); the web screens never show pairing.
    pair: async () => ({ ok: false, error: NATIVE_STAFF }),
    reportFlow: (input) => send('reportFlow', input),
    funnel: (events) => send('funnel', events),
    // No `battery`: the APK shows the low battery itself (LowBatteryBanner), on every screen.
    startPayment: (input: StartPaymentIn) =>
      // Never a rejection: the screen awaits it with no catch, and a stuck "starting" is worse than a message.
      call<StartPaymentOut>('startPayment', input).catch((): StartPaymentOut => ({ ok: false, reason: 'error', message: PAY_NO_ANSWER })),
    cancelPayment: () => call<unknown>('cancelPayment', {}).then(noop, noop),
    receiptChoice: (orderId, print) => call<unknown>('receiptChoice', { orderId, print }).then(noop, noop),
    helpRequest: () => call<unknown>('helpRequest', {}).then(noop, noop),
    adminUnlock: async () => ({ ok: false, error: NATIVE_STAFF }),
    adminInfo: () => Promise.reject(new Error(NATIVE_STAFF)),
    adminAction: async () => ({ ok: false, message: NATIVE_STAFF }),
    technicianUnlock: async () => ({ outcome: 'locked', triesLeft: 0, lockedForMs: 0 }),
    technicianInfo: () => Promise.reject(new Error(NATIVE_STAFF)),
    technicianAction: async () => ({ ok: false, message: NATIVE_STAFF }),
    on: <K extends keyof KioskEvents>(event: K, fn: (payload: KioskEvents[K]) => void) => listen(kioskOn, event, fn as (p: unknown) => void),
  };

  const shell: ShellBridge = {
    view: () => call<ShellView>('shellView', {}),
    board: () => Promise.reject(new Error('not on the Android kiosk')),
    kds: () => Promise.reject(new Error('not on the Android kiosk')),
    kdsAction: async () => ({ ok: false, message: 'not on the Android kiosk' }),
    activity: () => send('activity', null),
    on: <K extends keyof ShellEvents>(event: K, fn: (payload: ShellEvents[K]) => void) => listen(shellOn, event, fn as (p: unknown) => void),
  };

  return { kiosk, shell, inbox, pending: () => waiting.size };
}

/* ------------------------------------------------------------- the screens' own pieces */

/** The admin's corner of the screens (KioskApp.tsx ADMIN_ZONE, CSS px from the physical top-right). */
export const WEB_ADMIN_ZONE = 48;

/** The technician's zone of the screens (core/technician.ts ZONE), the physical top-left. */
function inTechZone(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && ((x < 20 && y < 72) || (y < 12 && x < 72));
}

/**
 * Whether a press at (x, y) is one of the screens' own staff corners — on Android the APK watches
 * those (its admin's two-second hold, its technician's six taps), so the screens must not open their
 * own PIN pad as well.
 */
export function inWebStaffCorner(x: number, y: number, width: number): boolean {
  return (x > width - WEB_ADMIN_ZONE && y < WEB_ADMIN_ZONE && y >= 0) || inTechZone(x, y);
}

interface PointerLike {
  clientX: number;
  clientY: number;
  stopPropagation(): void;
}

/**
 * The screens' staff corners kept quiet: a press there is stopped at the window, before the
 * screens' root sees it (its long-press timer, its tap counter). Only the press — the tap itself
 * still reaches whatever is drawn in the corner (the header's back arrow in Hebrew).
 */
export function guardStaffCorners(win: { addEventListener(type: 'pointerdown', fn: (e: PointerLike) => void, capture: boolean): void; innerWidth: number }) {
  win.addEventListener(
    'pointerdown',
    (e) => {
      if (inWebStaffCorner(e.clientX, e.clientY, win.innerWidth)) e.stopPropagation();
    },
    true,
  );
}

/** One key as the screens' scanner reads it (kioskScanner.tsx: `code`, `key`, ctrl for GS). */
export interface ScanKey {
  key: string;
  code: string;
  ctrlKey: boolean;
}

/**
 * The keys of [code] as a scanner types them, then Enter: what the screens' scanner reads at the
 * window. GS1's separator (GS, 0x1D) is Ctrl+] as on a real scanner.
 */
export function scanKeys(code: string): ScanKey[] {
  const keys: ScanKey[] = [];
  for (const ch of code) {
    if (ch === '\u001d') keys.push({ key: ']', code: 'BracketRight', ctrlKey: true });
    else if (ch === '\r' || ch === '\n') continue;
    else keys.push({ key: ch, code: '', ctrlKey: false });
  }
  keys.push({ key: 'Enter', code: 'Enter', ctrlKey: false });
  return keys;
}

/**
 * A code the APK's scanner read, into the screens: a burst of keydowns at the window, as a USB
 * scanner's keys arrive on Windows — the screens' own scan rules decide (core/kioskScan.ts).
 */
export function injectScan(code: string, target: { dispatchEvent(e: Event): boolean }, makeKey: (k: ScanKey) => Event) {
  for (const k of scanKeys(code)) target.dispatchEvent(makeKey(k));
}

/** What the screens tell the APK about a failure (the watchdog's errors; `fatal`: nothing on screen). */
export interface ScreenError {
  message: string;
  source: string | null;
  line: number | null;
  fatal: boolean;
}

/** The message of whatever was thrown, short. */
export function errorText(reason: unknown): string {
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : typeof reason === 'string' ? reason : JSON.stringify(reason ?? null);
  return (text ?? 'error').slice(0, 500);
}

/** A bundle needs [needed]; the APK speaks [apk]. */
export function apkSupports(apk: unknown, needed = ANDROID_BRIDGE_API): boolean {
  return typeof apk === 'number' && Number.isInteger(apk) && apk >= needed;
}

