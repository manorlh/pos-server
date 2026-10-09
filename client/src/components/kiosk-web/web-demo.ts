/**
 * `/k?demo=1` — the browser kiosk against a pretend cloud, to look at it (and take screenshots)
 * without a paired device: the real service (lib/kioskWebService.ts) and the real screens, with
 * a fetch that answers here, in memory. Nothing reaches the network, nothing is charged, nothing
 * is kept (a memory store). Never used by a paired kiosk.
 *
 *   ?demo=1&style=ios|wolt|classic|minimal_dark|tech   the kiosk's `theme.uiStyle`
 *   &tip=1                                         "טיפ לצוות" before the payment
 *   &methods=cash_at_till,voucher,card             `payment.methods` (default: card, voucher, cash at the till)
 *   &paused=1                                      the pause screen
 *   &ticker=top|bottom                             "כיתוב רץ"
 *   &layout=standard|guided|tabs|landing|fastfood  `layout.template`
 *   voucher code DEMO-VOUC-HERR-2345 (or "PV:" + it scanned) takes one burger.
 */

import type { FetchFn } from '@/lib/kioskWebApi';
import { MemoryStore, KV } from '@/lib/kioskWebStore';

export const DEMO_MACHINE = 'demo';
const DEMO_VOUCHER = 'DEMOVOUCHERR2345';

function art(emoji: string, hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">` +
    `<defs><radialGradient id="g" cx="50%" cy="30%" r="80%"><stop offset="0" stop-color="hsl(${hue} 95% 95%)"/>` +
    `<stop offset="0.55" stop-color="hsl(${hue} 75% 82%)"/><stop offset="1" stop-color="hsl(${hue} 55% 66%)"/></radialGradient></defs>` +
    `<rect width="400" height="400" fill="url(#g)"/>` +
    `<text x="200" y="250" font-size="190" text-anchor="middle" font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji">${emoji}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function demoCatalog() {
  const categories = [
    { id: 'c-burgers', name: 'המבורגרים', isActive: true, sortOrder: 1 },
    { id: 'c-pita', name: 'פיתות', isActive: true, sortOrder: 2 },
    { id: 'c-salads', name: 'סלטים', isActive: true, sortOrder: 3 },
    { id: 'c-sides', name: 'תוספות', isActive: true, sortOrder: 4 },
    { id: 'c-drinks', name: 'שתייה', isActive: true, sortOrder: 5 },
    { id: 'c-desserts', name: 'קינוחים', isActive: true, sortOrder: 6 },
  ];
  const p = (id: string, categoryId: string, name: string, price: number, emoji: string, hue: number, extra: Record<string, unknown> = {}) => ({
    id,
    categoryId,
    name,
    price,
    imageUrl: art(emoji, hue),
    isAvailable: true,
    inStock: true,
    sku: id.toUpperCase(),
    barcode: null,
    dietaryTags: [] as string[],
    allergens: [] as string[],
    ...extra,
  });
  const products = [
    p('p-classic', 'c-burgers', 'המבורגר קלאסי', 54, '🍔', 30, { description: '200 גרם בקר, חסה, עגבנייה ורוטב הבית', allergens: ['gluten', 'sesame'], barcode: '7290000000017' }),
    p('p-cheese', 'c-burgers', 'צ׳יזבורגר', 59, '🍔', 40, { allergens: ['gluten', 'milk'] }),
    p('p-vegan', 'c-burgers', 'המבורגר טבעוני', 52, '🥬', 110, { dietaryTags: ['vegan'] }),
    p('p-chicken', 'c-burgers', 'בורגר עוף', 49, '🍗', 25),
    p('p-shawarma', 'c-pita', 'פיתה שווארמה', 46, '🥙', 35),
    p('p-falafel', 'c-pita', 'פיתה פלאפל', 28, '🧆', 80, { dietaryTags: ['vegan'] }),
    p('p-sabich', 'c-pita', 'סביח', 32, '🍆', 280, { dietaryTags: ['vegetarian'], isAvailable: false }),
    p('p-greek', 'c-salads', 'סלט יווני', 44, '🥗', 120, { dietaryTags: ['vegetarian'] }),
    p('p-caesar', 'c-salads', 'סלט קיסר', 46, '🥗', 95),
    p('p-fries', 'c-sides', 'צ׳יפס', 18, '🍟', 45, { dietaryTags: ['vegan'] }),
    p('p-rings', 'c-sides', 'טבעות בצל', 22, '🧅', 50),
    p('p-cola', 'c-drinks', 'קולה', 12, '🥤', 0, { barcode: '7290000000024' }),
    p('p-lemonade', 'c-drinks', 'לימונדה', 16, '🍋', 55),
    p('p-water', 'c-drinks', 'מים מינרליים', 9, '💧', 200),
    p('p-cake', 'c-desserts', 'עוגת שוקולד', 28, '🍰', 15),
    p('p-icecream', 'c-desserts', 'גלידה', 22, '🍨', 320),
  ];
  const menu = {
    groups: [
      { id: 'g-size', name: 'גודל', kind: 'choice', minSelect: 1, maxSelect: 1, options: [{ id: 'o-regular', name: 'רגיל', price: 0, isDefault: true }, { id: 'o-large', name: 'גדול', price: 8 }] },
      { id: 'g-extras', name: 'תוספות', kind: 'addon', minSelect: 0, maxSelect: 3, options: [{ id: 'o-cheese', name: 'גבינה', price: 5 }, { id: 'o-egg', name: 'ביצת עין', price: 6 }, { id: 'o-bacon', name: 'בייקון', price: 9 }] },
      { id: 'g-without', name: 'בלי', kind: 'removal', minSelect: 0, maxSelect: 4, options: [{ id: 'o-onion', name: 'בצל', price: 0 }, { id: 'o-tomato', name: 'עגבנייה', price: 0 }] },
    ],
    links: { categories: { 'c-burgers': ['g-size', 'g-extras', 'g-without'] }, products: {} },
    notes: { all: [], categories: { 'c-burgers': [{ text: 'רוטב בצד' }, { text: 'עשוי היטב' }] } },
    upsells: [{ triggerType: 'category', triggerIds: ['c-burgers'], options: [{ type: 'product', id: 'p-fries' }, { type: 'product', id: 'p-cola' }], prompt: 'משהו לצד?' }],
  };
  return { syncType: 'full', serverTime: '2026-10-07T00:00:00Z', products, categories, menu, machineCatalog: { mode: 'all' } };
}

function demoConfig(q: URLSearchParams): Record<string, unknown> {
  const style = q.get('style');
  const out: Record<string, unknown> = {
    theme: style ? { uiStyle: style } : {},
    payment: {
      methods: (q.get('methods') ?? 'card,voucher,cash_at_till').split(',').map((s) => s.trim()).filter(Boolean),
      tipEnabled: q.get('tip') === '1',
      customerName: q.get('name') === '1' ? 'optional' : 'off',
    },
    pickup: { scope: 'kiosk', prefix: 'W', start: 1, max: 999 },
  };
  const t = q.get('layout');
  if (t) out.layout = { template: t };
  const ticker = q.get('ticker');
  if (ticker === 'top' || ticker === 'bottom') {
    const text = (id: string, s: string) => ({ id, text: s, enabled: true, from: null, to: null, days: [0, 1, 2, 3, 4, 5, 6], startsAt: null, endsAt: null });
    out.ticker = { enabled: true, position: ticker, screens: ['attract', 'service', 'catalog', 'cart', 'details', 'pay', 'success'], items: [text('t1', 'מבצע צהריים: המבורגר + שתייה ב-59 ₪'), text('t2', 'פתוחים היום עד חצות')] };
  }
  return out;
}

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  headers: { get: (name: string) => (name.toLowerCase() === 'date' ? new Date().toUTCString() : null) },
});

/** The pretend cloud. */
export function demoFetch(q: URLSearchParams): FetchFn {
  let pickup = 0;
  const redeemed = new Set<string>();
  return async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^.*\/api\/v1\//, '');
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    await new Promise((r) => setTimeout(r, 120));
    if (path === 'machines/me') return json(200, { machineId: DEMO_MACHINE, machineName: 'קיוסק הדגמה', shopName: 'סניף הדגמה', companyName: 'עסק הדגמה', posNumber: '9', deviceRole: 'kiosk', platform: 'web' });
    if (path === 'machines/me/heartbeat') return json(200, { ok: true });
    const m = new RegExp(`^sync/${DEMO_MACHINE}/(.+)$`).exec(path);
    const rest = m?.[1] ?? '';
    if (rest === 'kiosk/sync') {
      return json(200, {
        kiosk: true,
        name: 'קיוסק הדגמה',
        configVersion: 'demo',
        config: demoConfig(q),
        state: { paused: q.get('paused') === '1', message: q.get('paused') === '1' ? 'תכף חוזרים' : null, until: null },
        operator: { id: `kiosk:${DEMO_MACHINE}`, name: 'קיוסק הדגמה' },
        alerts: { open: [], help: null },
        closeRequest: null,
        bonCommands: [],
      });
    }
    if (rest.startsWith('settings')) return json(200, { syncType: 'full', settings: {}, businessInfo: { companyName: 'R2M דמו' }, settingsUpdatedAt: null });
    if (rest === 'parameters') return json(200, { parameters: {} });
    if (rest.startsWith('catalog')) return json(200, rest.includes('since=') ? { syncType: 'delta', products: [], categories: [] } : demoCatalog());
    if (rest === 'kiosk/pickup-number') return json(200, { number: ++pickup, label: `W-${pickup}` });
    if (rest === 'kiosk/open-orders') {
      const orders = (body.orders as Array<{ localId: string }>) ?? [];
      return json(200, { accepted: orders.map((o) => o.localId), rejected: [], states: Object.fromEntries(orders.map((o) => [o.localId, { state: 'open' }])) });
    }
    if (rest === 'prepaid-vouchers/lookup') {
      const code = String(body.code ?? '').replace(/^PV:/i, '').replace(/[\s-]/g, '').toUpperCase();
      if (code !== DEMO_VOUCHER) return json(404, { detail: 'prepaid_voucher_not_found' });
      if (redeemed.has(code)) return json(200, { redeemable: false, status: 'used', reason: 'prepaid_voucher_used', items: [] });
      return json(200, { serial: 17, eventName: 'שובר הדגמה', redeemable: true, splitAllowed: true, items: [{ productId: 'p-classic', tillProductId: 'p-classic', name: 'המבורגר קלאסי', quantity: 1, remaining: 1 }] });
    }
    if (rest === 'prepaid-vouchers/redeem') {
      redeemed.add(DEMO_VOUCHER);
      const items = (body.items as Array<{ productId: string; quantity: number }>) ?? [];
      return json(200, { ok: true, redemptionId: `demo-${Date.now()}`, redeemed: items.map((i) => ({ productId: i.productId, tillProductId: i.productId, name: 'המבורגר קלאסי', quantity: i.quantity })), voucher: { serial: 17, eventName: 'שובר הדגמה' } });
    }
    if (/^prepaid-vouchers\/redemptions\/.+\/reverse$/.test(rest)) {
      redeemed.delete(DEMO_VOUCHER);
      return json(200, { ok: true });
    }
    return json(404, { detail: 'not in the demo' });
  };
}

/** A memory store that starts paired to the pretend cloud. */
export async function demoStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.set(KV.credentials, { serverUrl: 'https://demo.invalid/api/v1/', accessToken: 'demo', machineId: DEMO_MACHINE, machineCode: null, tenantId: null, shopId: null, pairedAt: new Date().toISOString() });
  return store;
}
