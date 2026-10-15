/**
 * The kiosk's screens inside the Android app — one renderer, three hosts: Electron (the preload's
 * `window.kiosk`), the browser (the dashboard's kiosk route) and the Android WebView (pos-android
 * ui/kiosk/web), where THIS bridge speaks to the APK's JavaScript interface `window.R2MAndroid`
 * (KioskWebBridge.kt) instead of Electron's IPC. It implements the very KioskBridge and ShellBridge
 * the screens already use (shared/bridge.ts, shared/roles.ts), so no screen knows which host it is in.
 *
 * The wire (bridgeApi 1, and 2 where the APK speaks it — `R2MAndroid.bridgeApi()`) is JSON text both ways:
 *
 *   JS → APK   R2MAndroid.call(id, method, argsJson)   an answer is due:
 *   APK → JS   window.__r2mAndroid.reply(id, ok, json) (evaluateJavascript), JSON of the result
 *              (ok) or of a message (not ok)
 *   JS → APK   R2MAndroid.send(method, argsJson)       one way, nothing comes back
 *   APK → JS   window.__r2mAndroid.event(name, json)   the APK's news (a new view, the payment…)
 *
 * bridgeApi 2 adds the call `placeOpenOrder` — "תשלום בקופה", the Windows kiosk's call of that name: the
 * screens offer it only where the APK says it speaks 2 ([apkPlacesOpenOrders]); on an APK of API 1 the
 * bundle runs as before (no till; a "ללא אשראי" kiosk rests on "no payment").
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

import { kioskOfflineBlocks, resolveKioskConfig, tsKioskPayMethods, type KioskLayer } from '@dash-lib/kioskConfig';
import type { PaymentMethod } from '@dash-lib/kioskConfig';
import type { VoucherLeg } from '@dash-lib/kioskWebOrders';
import type {
  AppliedVoucher,
  BasketChange,
  CashOwedChoice,
  CashPayView,
  KioskBridge,
  KioskEvents,
  KioskView,
  PayProgress,
  PlaceOrderIn,
  PlaceOrderOut,
  StartPaymentIn,
  StartPaymentOut,
  VoucherAnswer,
  VoucherApplyIn,
} from '../../shared/bridge';
import type { ShellBridge, ShellEvents, ShellView } from '../../shared/roles';
import { SIDE_DP as ADMIN_CORNER_SIDE } from '../../core/adminCorner';
import { configOfflineBlockScope, offlineBlockCashOf, offlineBlockScopeOf, offlineRests, offlineUsable } from '../../core/offlineBlock';
import { ANDROID_BRIDGE_API, ANDROID_ORIGIN, ANDROID_PLACE_OPEN_ORDER_API, type ANDROID_CALLS, type ANDROID_EVENTS, type ANDROID_SENDS } from './androidWire';

export { ANDROID_BRIDGE_API, ANDROID_CALLS, ANDROID_EVENTS, ANDROID_ORIGIN, ANDROID_PLACE_OPEN_ORDER_API, ANDROID_SENDS, ANDROID_WIRE_API } from './androidWire';

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
  // The APK waits up to 20 s for the cloud's word on a voucher (KioskWebSession START_WAIT_MS).
  voucherApply: 30_000,
  voucherRemove: 15_000,
  // The APK checks the basket, then waits up to 20 s on its pay-at-till path (KioskWebSession START_WAIT_MS).
  placeOpenOrder: 30_000,
  // §11.15: a choice / a split the APK answers at once.
  cashOwedChoice: 15_000,
  cashSplit: 15_000,
};

/** The staff's screens are the APK's on Android (its corners, its PIN, its admin). */
export const NATIVE_STAFF = 'ניהול הקיוסק נפתח מהמסך המובנה';
/** startPayment had no answer: the customer reads it, nothing was charged by this screen. */
export const PAY_NO_ANSWER = 'התשלום לא התחיל. אנא נסו שוב או פנו לצוות.';
/** placeOpenOrder had no answer (or none of its shape): the Windows kiosk's words when the order did not go (i18n placeFailed). */
export const PLACE_NO_ANSWER = 'ההזמנה לא נשלחה. נסו שוב או פנו לצוות.';

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

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The APK's answer to voucherApply / voucherRemove, checked: anything that is not the answer's
 * shape is no answer (null) — the screens keep the order's vouchers as they were.
 */
export function voucherAnswerOf(v: unknown): VoucherAnswer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const due = num(o.dueAgorot);
  if (due === null || !Array.isArray(o.vouchers)) return null;
  const vouchers: AppliedVoucher[] = [];
  for (const x of o.vouchers as unknown[]) {
    const u = (x ?? {}) as Record<string, unknown>;
    const serial = num(u.serial);
    const amount = num(u.amountAgorot);
    if (serial === null || amount === null) return null;
    vouchers.push({
      serial,
      title: text(u.title) ?? `שובר מס׳ ${String(serial).padStart(4, '0')}`,
      mode: text(u.mode) ?? 'payment',
      amountAgorot: Math.max(0, Math.trunc(amount)),
      lines: Array.isArray(u.lines) ? (u.lines as unknown[]).filter((l): l is string => typeof l === 'string' && l.trim() !== '') : [],
    });
  }
  const error = text(o.error);
  return {
    ok: o.ok === true && error === null,
    error,
    note: text(o.note),
    totalAgorot: num(o.totalAgorot),
    deductionAgorot: Math.max(0, Math.trunc(num(o.deductionAgorot) ?? 0)),
    dueAgorot: Math.max(0, Math.trunc(due)),
    vouchers,
  };
}

/**
 * The APK sends the cloud's kiosk config as it came (its media already on the local copy): resolved
 * here against the screens' own defaults, as the Windows kiosk's main process resolves it
 * (resolveKioskConfig), with anything still remote dropped.
 */
export function normalizeView(view: KioskView, opts: { payAtTill?: boolean } = {}): KioskView {
  if (!view || !view.config) return view;
  const resolved = resolveKioskConfig(view.config as KioskLayer);
  // The APK's web engine takes the card, and a voucher where the kiosk is set to take one — the APK
  // holds it (voucherApply) and the payment books it. With the card alone: no "איך תרצו לשלם?".
  // Cash at the till: where the APK places orders for the till ([payAtTill], bridgeApi 2) — else its own screens'.
  const configured: readonly unknown[] = Array.isArray(resolved.payment?.methods) ? resolved.payment.methods : [];
  const config = localMediaOnly(JSON.parse(JSON.stringify(resolved))) as Record<string, unknown>;
  if (view.pay) return { ...view, config };
  // "חסימת הזמנות כשאין אינטרנט", offline: what it blocks is "קיוסק — מה נחסם כשאין אינטרנט" (core/offlineBlock.ts) —
  // the cloud puts a scope other than the default in the config as it sends it (`general.offlineBlockScope`).
  const blocked = kioskOfflineBlocks(resolved.general, view.state?.offline === true);
  const scope = offlineBlockScopeOf(configOfflineBlockScope(view.config));
  const base = opts.payAtTill ? tillPay(configured, androidNoCard(view), blocked) : androidNoCard(view) ? noCardPay(configured) : cardPay(configured);
  // "מזומן עובד בלי אינטרנט" (§13): the cash station stays unless the config says `general.offlineBlockCash`.
  const pay = { ...base, usable: offlineUsable(base.usable, blocked, scope, offlineBlockCashOf(undefined, view.config)) };
  // Resting for it: the "offline" screen's words (the Windows kiosk's noPaymentReason), not the terminal's.
  const state = view.state && offlineRests(blocked, scope, pay.usable) ? { ...view.state, noPayment: true, noPaymentReason: 'offline' as const } : view.state;
  return { ...view, state, pay, config };
}

/** "ללא אשראי" as the card's tile says it (the Windows kiosk's and the browser kiosk's words). */
export const ANDROID_NO_CARD_TEXT = 'הקיוסק מוגדר ללא אשראי';

/**
 * "ללא אשראי" (`paymentIntegration` = `none`, pos-server P:/specs/payment-integration-none.md): the APK's
 * snapshot (pos-android KioskWebSnapshot) says `state.terminal` = `no_card` — no terminal by design, not a
 * fault. Its `state.noPayment` is set then too (KioskPayBlock.TERMINAL); the screens go by `pay` instead.
 */
export function androidNoCard(view: Pick<KioskView, 'state'> | null | undefined): boolean {
  return view?.state?.terminal === 'no_card';
}

function cardPay(configured: readonly unknown[]): KioskView['pay'] {
  const methods: PaymentMethod[] = configured.includes('voucher') ? ['card', 'voucher'] : ['card'];
  return { methods, usable: methods, cardOff: null };
}

/**
 * No card tile at all (not one shown off), and never the terminal's "not available" on a press: what is
 * left of what the web engine takes here is the voucher, where the kiosk takes one. A voucher is usable
 * only where its order can be finished — by the card or at the till (client lib/kioskConfig.ts
 * voucherCanFinish) — and on an APK of bridge API 1 cash at the till is the APK's own screens' (no call
 * places an order for the till): so nothing is usable, and the kiosk rests on its "no payment" screen, as
 * the native kiosk does with nothing to sell by. An APK of API 2: [tillPay].
 */
function noCardPay(configured: readonly unknown[]): KioskView['pay'] {
  const methods: PaymentMethod[] = configured.includes('voucher') ? ['voucher'] : [];
  return { methods, usable: [], cardOff: ANDROID_NO_CARD_TEXT };
}

/**
 * An APK that places orders for the till (bridgeApi 2, "placeOpenOrder"): the Windows kiosk's "איך תרצו לשלם?"
 * (main/service.ts payView) — the methods configured as a one-card kiosk takes them (tsKioskPayMethods, in their
 * order); "ללא אשראי" ([noCard]) without the card (no tile; its line says why); cash at the till usable unless
 * "חסימת הזמנות כשאין אינטרנט" holds the kiosk ([offlineBlocked], whatever it blocks — with `all` [normalizeView]
 * then takes the rest too); a voucher where its order can be finished — by the card or at the till. The card is as
 * on API 1: the APK checks its terminal on the press.
 */
function tillPay(configured: readonly unknown[], noCard: boolean, offlineBlocked: boolean): KioskView['pay'] {
  const set = tsKioskPayMethods(configured).filter((m) => m === 'card' || m === 'voucher' || m === 'cash_at_till');
  const methods = noCard ? set.filter((m) => m !== 'card') : set;
  const cardUsable = methods.includes('card');
  const tillUsable = methods.includes('cash_at_till') && !offlineBlocked;
  const usable = methods.filter((m) => (m === 'card' ? cardUsable : m === 'cash_at_till' ? tillUsable : cardUsable || tillUsable));
  return { methods, usable, cardOff: noCard ? ANDROID_NO_CARD_TEXT : null };
}

/**
 * The APK places orders for the till ("placeOpenOrder", bridgeApi ≥ 2): `R2MAndroid.bridgeApi()` says so. An APK of
 * API 1, one with no `bridgeApi`, or one that throws: no — the screens stay as they were.
 */
export function apkPlacesOpenOrders(native: { bridgeApi?: unknown } | null | undefined): boolean {
  try {
    if (!native || typeof native.bridgeApi !== 'function') return false;
    const api: unknown = (native as { bridgeApi(): unknown }).bridgeApi();
    return typeof api === 'number' && Number.isFinite(api) && api >= ANDROID_PLACE_OPEN_ORDER_API;
  } catch {
    return false;
  }
}

const PLACE_REFUSALS = ['empty', 'rejected', 'error'] as const;

function basketChangeOf(v: unknown): BasketChange | null {
  const c = (v ?? {}) as Record<string, unknown>;
  const productId = text(c.productId);
  if (productId === null) return null;
  const name = typeof c.name === 'string' ? c.name : '';
  const key = text(c.key);
  if (c.kind === 'removed') return { kind: 'removed', productId, name, ...(key !== null ? { key } : {}) };
  const from = num(c.from);
  const to = num(c.to);
  if (c.kind === 'repriced' && from !== null && to !== null) return { kind: 'repriced', productId, name, ...(key !== null ? { key } : {}), from, to };
  return null;
}

/**
 * The APK's `pay` event as the screens read the Windows kiosk's (shared/bridge.ts PayProgress). Its `cash` (P:/specs/
 * cash-paylink.md §11.13, §11.15) names the card's part of a split `cardAgorot` (the screens' `cardRestAgorot`); the rest
 * passes as is. Anything that is not an object stays as it came.
 */
export function payOf(v: unknown): PayProgress {
  if (!v || typeof v !== 'object') return v as PayProgress;
  const p = v as PayProgress & { cash?: (CashPayView & { cardAgorot?: unknown }) | null };
  const cash = p.cash;
  if (!cash || typeof cash !== 'object') return p;
  const card = typeof cash.cardRestAgorot === 'number' ? cash.cardRestAgorot : typeof cash.cardAgorot === 'number' ? cash.cardAgorot : undefined;
  return card === undefined ? p : { ...p, cash: { ...cash, cardRestAgorot: card } };
}

/**
 * The APK's answer to placeOpenOrder as the screens read the Windows kiosk's (shared/bridge.ts PlaceOrderOut): placed —
 * the number (`pickupLabel`, else `orderNumber`), what the till collects, the order's code, the vouchers taken with it;
 * "changed" — what changed in the basket and the total now; else not placed, in the APK's words. Anything not of the
 * answer's shape is not placed ([PLACE_NO_ANSWER]).
 */
export function placeAnswerOf(v: unknown): PlaceOrderOut {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (o.ok === true) {
    const localId = text(o.localId);
    const due = num(o.dueAgorot);
    if (localId === null || due === null) return { ok: false, reason: 'error', message: PLACE_NO_ANSWER };
    const vouchers: VoucherLeg[] = [];
    for (const x of Array.isArray(o.vouchers) ? (o.vouchers as unknown[]) : []) {
      const u = (x ?? {}) as Record<string, unknown>;
      const redemptionId = text(u.redemptionId);
      const serial = num(u.serial);
      const amount = num(u.amountAgorot);
      if (redemptionId !== null && serial !== null && amount !== null) {
        vouchers.push({ redemptionId, serial, amountAgorot: Math.max(0, Math.trunc(amount)), eventName: text(u.eventName), redeemed: [] });
      }
    }
    return {
      ok: true,
      localId,
      pickupLabel: text(o.pickupLabel) ?? text(o.orderNumber) ?? '',
      vouchers,
      dueAgorot: Math.max(0, Math.trunc(due)),
      pending: o.pending === true,
      code: text(o.code) ?? `KO:${localId}`,
    };
  }
  if (o.reason === 'changed' && Array.isArray(o.changes)) {
    const total = num(o.totalAgorot);
    const changes = (o.changes as unknown[]).map(basketChangeOf).filter((c): c is BasketChange => c !== null);
    return { ok: false, reason: 'changed', changes, ...(total !== null ? { totalAgorot: total } : {}) };
  }
  const reason = (PLACE_REFUSALS as readonly unknown[]).includes(o.reason) ? (o.reason as (typeof PLACE_REFUSALS)[number]) : 'error';
  return { ok: false, reason, message: text(o.message) ?? PLACE_NO_ANSWER };
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
  // bridgeApi 2: "תשלום בקופה" offered and placed through the APK (read once — an APK does not change under its page).
  const payAtTill = apkPlacesOpenOrders(native);
  const viewOf = (v: KioskView) => normalizeView(v, { payAtTill });
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
          fire(kioskOn, name, viewOf(payload as KioskView));
          return;
        case 'pay':
          fire(kioskOn, name, payOf(payload));
          return;
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
    bootstrap: () => call<KioskView>('bootstrap', {}).then(viewOf),
    // Android pairs natively (its own pairing screen); the web screens never show pairing.
    pair: async () => ({ ok: false, error: NATIVE_STAFF }),
    reportFlow: (input) => send('reportFlow', input),
    funnel: (events) => send('funnel', events),
    // No `battery`: the APK shows the low battery itself (LowBatteryBanner), on every screen.
    startPayment: (input: StartPaymentIn) =>
      // Never a rejection: the screen awaits it with no catch, and a stuck "starting" is worse than a message.
      call<StartPaymentOut>('startPayment', input).catch((): StartPaymentOut => ({ ok: false, reason: 'error', message: PAY_NO_ANSWER })),
    cancelPayment: () => call<unknown>('cancelPayment', {}).then(noop, noop),
    // "מזומן" at the cash station, stage 2 (§11.15): only on what the APK's `pay.cash` offers — never a rejection.
    cashOwedChoice: (choice: CashOwedChoice) => call<unknown>('cashOwedChoice', { choice }).then(noop, noop),
    cashSplit: () =>
      call<unknown>('cashSplit', {}).then(
        (r) => ({ ok: !!r && typeof r === 'object' && (r as { ok?: unknown }).ok === true }),
        () => ({ ok: false }),
      ),
    receiptChoice: (orderId, print) => call<unknown>('receiptChoice', { orderId, print }).then(noop, noop),
    helpRequest: () => call<unknown>('helpRequest', {}).then(noop, noop),
    // Production vouchers: the APK redeems and holds them; its answer is the order's vouchers now.
    voucherApply: (input: VoucherApplyIn) => call<unknown>('voucherApply', input).then(voucherAnswerOf, () => null),
    voucherRemove: (serial: number) => call<unknown>('voucherRemove', { serial }).then(voucherAnswerOf, () => null),
    // "תשלום בקופה" (bridgeApi 2): the order to the shop's tills through the APK's own pay-at-till path (its number, bon,
    // slip and success). Absent on an APK of API 1 — the screens then never offer it. Never a rejection: no answer is
    // "not placed", in the customer's words. The APK takes the vouchers it holds (voucherApply), not `vouchers`.
    ...(payAtTill
      ? {
          placeOpenOrder: (input: PlaceOrderIn): Promise<PlaceOrderOut> =>
            call<unknown>('placeOpenOrder', { ...input, vouchers: input.vouchers ?? [], discounts: input.discounts ?? [] }).then(
              placeAnswerOf,
              (): PlaceOrderOut => ({ ok: false, reason: 'error', message: PLACE_NO_ANSWER }),
            ),
        }
      : {}),
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

/** The admin's corner of the screens (core/adminCorner.ts — the Android KioskAdminCorner's square, CSS px from the top right). */
export const WEB_ADMIN_ZONE = ADMIN_CORNER_SIDE;

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
  return (width - x >= 0 && width - x <= WEB_ADMIN_ZONE && y <= WEB_ADMIN_ZONE && y >= 0) || inTechZone(x, y);
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

