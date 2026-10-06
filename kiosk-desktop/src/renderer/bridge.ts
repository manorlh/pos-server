/**
 * The screens' only way to the local service: `window.kiosk` (preload). In `npm run dev:web` (a
 * browser, no Electron) a fake bridge with demo data stands in, to look at the screens quickly —
 * it never charges anything and never reaches the network.
 */

import { KIOSK_DEFAULTS, UI_STYLES, resolveKioskConfig, type UiStyle } from '@dash-lib/kioskConfig';
import type { KioskBridge, KioskEvents, KioskView, PayProgress } from '../shared/bridge';

/** `?style=ios|wolt|classic|minimal_dark` picks the demo's look, as a kiosk's `theme.uiStyle` would. */
function demoStyle(): UiStyle {
  const s = new URLSearchParams(window.location.search).get('style') ?? '';
  return (UI_STYLES as string[]).includes(s) ? (s as UiStyle) : KIOSK_DEFAULTS.theme.uiStyle;
}

function demoView(): KioskView {
  const cats = [
    { id: 'c1', name: 'המבורגרים', imageUrl: null },
    { id: 'c2', name: 'שתייה', imageUrl: null },
    { id: 'c3', name: 'קינוחים', imageUrl: null },
  ];
  const p = (id: string, categoryId: string, name: string, price: number, soldOut = false, description: string | null = null) => ({
    id,
    name,
    price,
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
    config: JSON.parse(JSON.stringify(resolveKioskConfig({ theme: { uiStyle: demoStyle() } }))) as Record<string, unknown>,
    configVersion: 'demo',
    fontFace: null,
    fontFamily: null,
    brandName: 'R2M',
    catalog: {
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
          { id: 'g1', name: 'גודל', kind: 'choice', min: 1, max: 1, options: [{ id: 'o1', name: 'רגיל', price: 0, isDefault: true }, { id: 'o2', name: 'גדול', price: 8, isDefault: false }] },
        ],
      },
      quickNotes: { p1: ['בלי בצל', 'רוטב בצד'] },
      upsells: [],
      categoryImages: {},
    },
    state: { paused: false, pausedMessage: null, pausedUntil: null, noPayment: false, terminal: 'ready', offline: false, offlineSince: null, cardBlocked: false },
    staff: { unprintedBons: 0, printer: 'ok', pendingUploads: 0, mediaMissing: 0 },
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
      const amount = Math.round(
        input.lines.reduce((sum, l) => {
          const unit = (products.find((x) => x.id === l.productId)?.price ?? 0) + l.options.reduce((s, o) => s + optionPrice(l.productId, o.groupId, o.optionId), 0);
          return sum + unit * l.qty;
        }, 0) * 100,
      );
      const base: PayProgress = { orderId, phase: 'starting', message: null, amountAgorot: amount, canCancel: true, cancelling: false };
      setTimeout(() => fire('pay', { ...base, phase: 'charging' }), 400);
      setTimeout(() => fire('pay', { ...base, phase: 'approved', canCancel: false, pickupLabel: String(order), documentNumber: `9000000${order}`, receipt: 'ask' }), 2500);
      return { ok: true, orderId, amountAgorot: amount };
    },
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
