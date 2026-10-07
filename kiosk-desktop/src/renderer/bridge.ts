/**
 * The screens' only way to the local service: `window.kiosk` (preload). In `npm run dev:web` (a
 * browser, no Electron) a fake bridge with demo data stands in, to look at the screens quickly —
 * it never charges anything and never reaches the network.
 */

import { KIOSK_DEFAULTS, UI_STYLES, kioskPayMethods, resolveKioskConfig, type PaymentMethod, type UiStyle } from '@dash-lib/kioskConfig';
import type { KioskBridge, KioskEvents, KioskView, PayProgress } from '../shared/bridge';
import { tipToCharge } from '../core/sale';
import { demoLayoutLayer, demoRich, richCatalog } from './demoLayouts';

/** `?style=ios|wolt|classic|minimal_dark|tech` picks the demo's look, as a kiosk's `theme.uiStyle` would. */
function demoStyle(): UiStyle {
  const s = new URLSearchParams(window.location.search).get('style') ?? '';
  return (UI_STYLES as string[]).includes(s) ? (s as UiStyle) : KIOSK_DEFAULTS.theme.uiStyle;
}

/** "HH:MM" today, local time, as ISO; null when it is not one. */
function todayAt(hhmm: string | null): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.toISOString();
}

/**
 * The closed screen in the demo: `?paused=1` (with `&until=HH:MM` and `&msg=…` for the pause's
 * end and message), or `?closed=1` — outside the hours, opening at `&opens=HH:MM` (else in two
 * hours) for an hour.
 */
function demoRest(): { state: Pick<KioskView['state'], 'paused' | 'pausedMessage' | 'pausedUntil'>; hours: Record<string, unknown> | null } {
  const q = new URLSearchParams(window.location.search);
  const paused = q.get('paused') === '1';
  const state = { paused, pausedMessage: paused ? q.get('msg') : null, pausedUntil: paused ? todayAt(q.get('until')) : null };
  if (q.get('closed') !== '1') return { state, hours: null };
  const opens = /^(\d{1,2}):(\d{2})$/.exec(q.get('opens') ?? '');
  const openMin = opens ? Number(opens[1]) * 60 + Number(opens[2]) : ((new Date().getHours() + 2) % 24) * 60;
  const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  return { state, hours: { enabled: true, ranges: [{ days: [0, 1, 2, 3, 4, 5, 6], open: hhmm(openMin), close: hhmm(openMin + 60) }] } };
}

/**
 * The checkout in the demo: `?tip=1` asks "טיפ לצוות" before the payment (`&first=details`: the
 * details before it), `&select=instant`: a tap on לקחת / לשבת goes on at once, `&notes=1`: the
 * dish's free note (its window).
 */
function demoCheckout(): Record<string, unknown> {
  const q = new URLSearchParams(window.location.search);
  const out: Record<string, unknown> = {};
  if (q.get('tip') === '1') out.payment = { tipEnabled: true, ...(q.get('first') === 'details' ? { checkoutSteps: ['details', 'tip'] } : {}) };
  // `&pay=card,cash_at_till,voucher`: the methods offered ("איך תרצו לשלם?"); `&paymode=off|optional|required`.
  const pay = q.get('pay');
  if (pay) {
    const methods = pay.split(',').filter((m): m is PaymentMethod => m === 'card' || m === 'cash_at_till' || m === 'voucher');
    const mode = q.get('paymode');
    out.payment = { ...((out.payment as Record<string, unknown>) ?? {}), methods, ...(mode === 'off' || mode === 'optional' || mode === 'required' ? { stepModes: { payMethod: mode } } : {}) };
  }
  const general: Record<string, unknown> = {};
  if (q.get('select') === 'instant') general.serviceSelect = 'instant';
  if (q.get('notes') === '1') general.notesEnabled = true;
  // "כיתוב רץ": `&ticker=top|bottom` runs it on every screen it may (`&reduce=1`: reduce motion, it stands still).
  if (q.get('reduce') === '1') general.reduceMotion = true;
  // `&service=take_away|eat_in`: one service type — never asked, never shown.
  const one = q.get('service');
  if (one === 'take_away' || one === 'eat_in') general.serviceTypes = [one];
  if (Object.keys(general).length > 0) out.general = general;
  // `&cta=hidden`: no start button, the whole screen starts (`&hint=0`: not even the line in its place).
  if (q.get('cta') === 'hidden') out.attract = { cta: { visible: false, tapAnywhere: true, touchHint: q.get('hint') !== '0' } };
  const ticker = q.get('ticker');
  if (ticker === 'top' || ticker === 'bottom') {
    const text = (id: string, t: string) => ({ id, text: t, enabled: true, from: null, to: null, days: [0, 1, 2, 3, 4, 5, 6], startsAt: null, endsAt: null });
    out.ticker = {
      enabled: true,
      position: ticker,
      screens: ['attract', 'service', 'catalog', 'cart', 'details', 'pay', 'success'],
      items: [text('t1', 'מבצע צהריים: המבורגר + שתייה ב-59 ₪'), text('t2', 'פתוחים היום עד חצות'), text('t3', 'Free refills all day')],
    };
  }
  return out;
}

function demoView(): KioskView {
  const rest = demoRest();
  const methods = kioskPayMethods(((demoCheckout().payment ?? {}) as { methods?: unknown[] }).methods);
  const nopay = new URLSearchParams(window.location.search).get('nopay') === '1';
  const cats = [
    { id: 'c1', name: 'המבורגרים', imageUrl: null },
    { id: 'c2', name: 'שתייה', imageUrl: null },
    { id: 'c3', name: 'קינוחים', imageUrl: null },
  ];
  const p = (id: string, categoryId: string, name: string, price: number, soldOut = false, description: string | null = null) => ({
    id,
    name,
    price,
    priceAgorot: Math.round(price * 100),
    noDiscount: false,
    imageUrl: null,
    imageLarge: null,
    soldOut,
    available: !soldOut,
    description,
    categoryId,
    dietaryTags: [] as never[],
    allergens: [],
    sku: null,
    trackStock: false,
    meal: false,
  });
  return {
    phase: 'kiosk',
    appVersion: 'dev',
    machine: { machineId: 'demo', name: 'קיוסק הדגמה', shopName: 'סניף הדגמה', companyName: 'עסק הדגמה', posNumber: '9', serverUrl: null },
    // `?layout=` (demoLayouts.ts): the layout's template, the accessible mode, "ברוכים הבאים".
    config: JSON.parse(JSON.stringify(resolveKioskConfig({ theme: { uiStyle: demoStyle() }, ...(rest.hours ? { hours: rest.hours } : {}), ...demoCheckout(), ...demoLayoutLayer(new URLSearchParams(window.location.search)) }))) as Record<string, unknown>,
    configVersion: 'demo',
    fontFace: null,
    fontFamily: null,
    brandName: 'R2M',
    catalog: demoRich(new URLSearchParams(window.location.search)) ? richCatalog() : {
      categories: cats,
      products: [
        p('p1', 'c1', 'המבורגר קלאסי', 54, false, '200 גרם בקר, חסה, עגבנייה ורוטב הבית'),
        p('p2', 'c1', 'צ׳יזבורגר', 59),
        p('p3', 'c1', 'המבורגר טבעוני', 49, true),
        p('p4', 'c2', 'קולה', 12),
        p('p5', 'c2', 'לימונדה', 16),
        p('p6', 'c3', 'עוגת שוקולד', 28),
      ],
      groups: {
        p1: [
          {
            id: 'g1',
            name: 'גודל',
            kind: 'choice',
            min: 1,
            max: 1,
            freeCount: 0,
            allowQuantity: false,
            allowPre: false,
            options: [
              { id: 'o1', name: 'רגיל', price: 0, priceAgorot: 0, isDefault: true, maxQty: null },
              { id: 'o2', name: 'גדול', price: 8, priceAgorot: 800, isDefault: false, maxQty: null },
            ],
          },
        ],
      },
      meals: {},
      quickNotes: { p1: ['בלי בצל', 'רוטב בצד'] },
      upsells: [],
      categoryImages: {},
      promotions: [],
    },
    // `?nopay=1`: "התשלום אינו זמין" — nothing to charge on.
    state: { ...rest.state, noPayment: nopay, terminal: 'ready', offline: false, offlineSince: null, cardBlocked: false },
    staff: { unprintedBons: 0, printer: 'ok', pendingUploads: 0, mediaMissing: 0 },
    pay: { methods, usable: nopay ? [] : methods, cardOff: null },
  };
}

function webBridge(): KioskBridge {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const fire = <K extends keyof KioskEvents>(k: K, p: KioskEvents[K]) => listeners.get(k)?.forEach((fn) => fn(p));
  let order = 0;
  return {
    bootstrap: async () => demoView(),
    pair: async () => ({ ok: false, error: 'web demo' }),
    reportFlow: () => undefined,
    startPayment: async (input) => {
      const orderId = `demo-${++order}`;
      // The demo catalog's own prices, as the real service would charge them.
      const { products, groups } = demoView().catalog;
      const optionPrice = (productId: string, groupId: string, optionId: string) =>
        groups[productId]?.find((g) => g.id === groupId)?.options.find((o) => o.id === optionId)?.price ?? 0;
      const goods = Math.round(
        input.lines.reduce((sum, l) => {
          const unit = (products.find((x) => x.id === l.productId)?.price ?? 0) + l.options.reduce((s, o) => s + optionPrice(l.productId, o.groupId, o.optionId), 0);
          return sum + unit * l.qty;
        }, 0) * 100,
      );
      // The total the screen priced (choices, meals, promotions) is the demo's: it has no money of its own.
      const shown = typeof input.expectedTotalAgorot === 'number' ? input.expectedTotalAgorot : goods;
      // The tip on top, as the real service charges it.
      const amount = shown + tipToCharge(shown, input.tipPct, input.tipAgorot);
      const base: PayProgress = { orderId, phase: 'starting', message: null, amountAgorot: amount, canCancel: true, cancelling: false };
      setTimeout(() => fire('pay', { ...base, phase: 'charging' }), 400);
      setTimeout(() => fire('pay', { ...base, phase: 'approved', canCancel: false, pickupLabel: String(order), documentNumber: `9000000${order}`, receipt: 'ask' }), 2500);
      return { ok: true, orderId, amountAgorot: amount };
    },
    // "מזומן בקופה" in the demo: a number and the code, nothing sent anywhere.
    placeOpenOrder: async (input) => {
      const n = ++order;
      const goods = typeof input.expectedTotalAgorot === 'number' ? input.expectedTotalAgorot : 0;
      const tip = tipToCharge(goods, input.tipPct, input.tipAgorot);
      const paid = input.vouchers.reduce((s, v) => s + v.amountAgorot, 0);
      return { ok: true, localId: `demo-open-${n}`, pickupLabel: String(n), vouchers: input.vouchers, dueAgorot: Math.max(0, goods + tip - paid), pending: false, code: `KO:demo-open-${n}` };
    },
    // The demo's one voucher: "DEMO2026" pays ₪10.
    redeemVoucher: async (input) =>
      input.code === 'DEMO2026'
        ? { kind: 'ok', leg: { redemptionId: `demo-${input.clientRequestId}`, serial: 2026, amountAgorot: 1000, eventName: 'שובר הדגמה', redeemed: [] } }
        : { kind: 'refused', reason: 'prepaid_voucher_not_found' },
    reverseVoucher: async () => undefined,
    cancelPayment: async () => undefined,
    receiptChoice: async () => undefined,
    helpRequest: async () => undefined,
    adminUnlock: async (pin) => (pin === '1234' ? { ok: true, name: 'מנהל הדגמה' } : { ok: false, error: 'קוד שגוי' }),
    adminInfo: async () => {
      throw new Error('web demo');
    },
    adminAction: async () => ({ ok: false, message: 'web demo' }),
    technicianUnlock: async (code) => (code === '1995' ? { outcome: 'granted', triesLeft: 0, lockedForMs: 0 } : { outcome: 'wrong', triesLeft: 4, lockedForMs: 0 }),
    technicianInfo: async () => {
      throw new Error('web demo');
    },
    technicianAction: async () => ({ ok: false, message: 'web demo' }),
    on: (event, fn) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      const f = fn as (p: unknown) => void;
      set.add(f);
      return () => void set.delete(f);
    },
  };
}

export const kiosk: KioskBridge = window.kiosk ?? webBridge();
