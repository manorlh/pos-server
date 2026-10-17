/**
 * The screens of the layout audit and how to reach them in the demo (`npm run dev:web`: the kiosk's demo bridge at
 * /, the till's demo engine at /app.html, the till's screen gallery at /tillGallery.html, the customer display at
 * /display.html). `&stress=1` is the demo's stress menu (demoLayouts.ts: long Hebrew + English names, 30+
 * modifiers, ₪99,999.90), `&admin=full` every panel of "ניהול הקיוסק", `&cash=<stage>` the cash device's screens.
 */

const KIOSK = ['win-kiosk', 'android-kiosk'];
const Q = 'layout=restaurant_rail&stress=1';
const PAY = `${Q}&pay=card,cash_at_till,voucher,cash_device&tip=1`;
const start = [{ tap: 'הזמינו כאן', after: 1000 }];
const service = [{ tap: 'טייק אווי', after: 300 }, { tap: 'להמשך', after: 1000, optional: true }];
const toMenu = [...start, ...service];
/** 22 dishes that need no choice, each its own line (the "+" of each card). */
const fillCart = [{ sel: '[data-add=direct]', after: 300 }, ...Array.from({ length: 21 }, (_, i) => ({ sel: '[data-add=direct]', index: i + 1, after: 260, optional: true }))];
/** The big one in the basket too: ₪99,999.90. */
const addBig = [{ sel: '[data-dish=x4] [data-add]', after: 400, optional: true }];
/** The page says it (a screen reached). */
const says = (...t) => t.map((x) => `document.body.innerText.includes(${JSON.stringify(x)})`).join(' || ');
const cartScreen = says('בדקו את ההזמנה');
const upsellShown = says('Something on the side');
/** From the menu to the basket's own screen (the bar's "לסל" upright; the side cart's "לתשלום" sideways). */
const toCart = [
  { tap: 'לסל', optional: true },
  { wait: 900 },
  { tap: 'לתשלום', optional: true, if: `!(${cartScreen})` },
  { waitFor: cartScreen },
];
/** The basket's "לתשלום", then "לא תודה" to the upsell window that comes up on every order. */
const toCheckout = [
  ...toCart,
  { tap: 'לתשלום' },
  { waitFor: says('Something on the side', 'המשך ללא טיפ', 'המשך ללא שם', 'הצמידו') },
  { tap: 'לא תודה', if: upsellShown },
  { waitFor: says('המשך ללא טיפ', 'המשך ללא שם', 'הצמידו') },
];
const basket = [...toMenu, { sel: '[data-add=direct]', after: 300 }, ...addBig];
const toTip = [...basket, ...toCheckout];
const toDetails = [...toTip, { tap: 'המשך ללא טיפ' }, { waitFor: says('המשך ללא שם') }];
const toPayMethod = [...toDetails, { tap: 'המשך ללא שם' }, { waitFor: says('מזומן בקופה') }];
const admin = [{ hold: 'admin' }, { tap: '1', after: 120 }, { tap: '2', after: 120 }, { tap: '3', after: 120 }, { tap: '4', after: 120 }, { tap: 'אישור', after: 1200 }];
const has = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const insideJs = `const inside = (r) => r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;`;
/**
 * The basket's review fits: "לתשלום" wholly in the window; in a landscape content column (two columns: under the
 * summary, centred on it, the column centred in the window).
 */
const cartFits = `(() => {
  ${insideJs}
  const pay = document.querySelector('[data-cart-pay] button') || document.querySelector('[data-cart-pay]');
  if (!pay || !inside(pay.getBoundingClientRect())) return false;
  const r = pay.getBoundingClientRect();
  const c = document.querySelector('[data-cart-content]');
  if (!c) return true;
  const cr = c.getBoundingClientRect();
  if (r.left < cr.left - 1 || r.right > cr.right + 1) return false;
  if (Math.abs(cr.left - (innerWidth - cr.right)) > 2) return false;
  const sm = document.querySelector('[data-cart-summary]');
  if (!sm) return true;
  const sr = sm.getBoundingClientRect();
  return r.top >= sr.bottom - 1 && r.top - sr.bottom <= 40 && Math.abs((r.left + r.right) / 2 - (sr.left + sr.right) / 2) <= 4;
})()`;
/** The tip step: its main button and "המשך ללא טיפ" in the window without scrolling. */
const tipFits = `(() => {
  ${insideJs}
  const act = document.querySelector('[data-tip-actions]');
  return !!act && [...act.querySelectorAll('button')].every((b) => inside(b.getBoundingClientRect()));
})()`;
/** "איך תרצו לשלם?": every tile in the window; the sheet's content centred, no wider than the window less 2×12 px. */
const payMethodFits = `(() => {
  ${insideJs}
  const tiles = [...document.querySelectorAll('[data-pay-tiles] > *')];
  if (!tiles.length || !tiles.every((t) => inside(t.getBoundingClientRect()))) return false;
  const c = document.querySelector('[data-pay-content]');
  if (!c || innerWidth <= innerHeight) return true;
  const cr = c.getBoundingClientRect();
  return Math.abs(cr.left - (innerWidth - cr.right)) <= 2;
})()`;
/**
 * The service screen fits (P:/specs/kiosk-service-size.md): both cards and "להמשך" wholly inside the window, and in
 * landscape a card no taller than 45% of it.
 */
const serviceFits = `(() => {
  const cards = [...document.querySelectorAll('[data-service-card]')].map((e) => e.getBoundingClientRect());
  const next = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('להמשך'));
  if (cards.length < 2 || !next) return false;
  const inside = (r) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
  if (!cards.every(inside) || !inside(next.getBoundingClientRect())) return false;
  return innerWidth <= innerHeight || cards.every((r) => r.height <= innerHeight * 0.45 + 1);
})()`;

const menu = (row) => [{ tap: 'תפריט', after: 700 }, { tap: row, after: 1000 }];
/** A report in the menu's "דוחות" folder (folded: its row opens it first). */
const report = (row) => [{ tap: 'תפריט', after: 700 }, { sel: '[data-menu=reports]', after: 500 }, { tap: row, after: 1000 }];
const TILL = [
  { id: 't-lock', query: 'state=lock' },
  { id: 't-sell', query: 'state=sell' },
  { id: 't-sell-empty', query: 'state=sell-empty' },
  { id: 't-item-info', query: 'state=sell-empty', steps: [{ sel: '.t-tile-info', after: 800 }] },
  { id: 't-order-ask', query: 'state=order-ask' },
  { id: 't-notice', query: 'state=notice' },
  { id: 't-dialog', query: 'state=dialog' },
  // The order panel's "⋮" (Android QuickOrderMenu) holds the parked sales and the discount.
  { id: 't-held', query: 'state=sell', steps: [{ sel: '.t-cart-bar', optional: true }, { sel: '.t-more', after: 500 }, { tap: 'הזמנות בהמתנה', after: 900 }], expect: has('שולחן 12') },
  { id: 't-discount', query: 'state=sell', steps: [{ sel: '.t-cart-bar', optional: true }, { sel: '.t-more', after: 500 }, { tap: 'הנחה', after: 900 }] },
  { id: 't-refund-chooser', query: 'state=refund-mode' },
  { id: 't-receipt-picker', query: 'state=refund-mode', steps: [{ tap: 'זיכוי מקבלה', after: 1200 }] },
  { id: 't-pay', query: 'state=pay' },
  { id: 't-pay-split', query: 'state=pay-split' },
  { id: 't-pay-card', query: 'state=pay-card' },
  { id: 't-pay-card-unknown', query: 'state=pay-card-unknown' },
  { id: 't-pay-vouchers', query: 'state=pay-vouchers' },
  { id: 't-pay-return', query: 'state=pay-return' },
  { id: 't-pay-payout', query: 'state=pay-payout' },
  { id: 't-pay-done', query: 'state=pay-done' },
  { id: 't-shift', query: 'state=sell', steps: menu('משמרת (דו״ח X)') },
  { id: 't-menu', query: 'state=sell', steps: [{ tap: 'תפריט', after: 900 }], expect: has('חסומים כעת') },
  { id: 't-menu-reports', query: 'state=sell', steps: [{ tap: 'תפריט', after: 700 }, { sel: '[data-menu=reports]', after: 600 }], expect: has('מכירות לפי מוצר') },
  { id: 't-cash-sheet', query: 'state=sell', steps: menu('מזומן במגירה'), expect: has('הכנסת מזומן') },
  { id: 't-drawer', query: 'state=sell', steps: [...menu('מזומן במגירה'), { tap: 'הכנסת מזומן', after: 1000 }] },
  { id: 't-recent', query: 'state=sell', steps: report('24 השעות האחרונות'), expect: has('40000123') },
  { id: 't-report-products', query: 'state=sell', steps: report('מכירות לפי מוצר'), expect: has('משמרת בוקר') },
  { id: 't-report-workers', query: 'state=sell', steps: report('דוח לפי עובד') },
  { id: 't-report-shifts', query: 'state=sell', steps: report('היסטוריית משמרות'), expect: has('משמרת #1287') },
  { id: 't-kiosks', query: 'state=sell', steps: menu('קיוסקים'), expect: has('קיוסק טרסה') },
  { id: 't-report-zs', query: 'state=sell', steps: report('דוחות Z'), expect: has('Z 412') },
  { id: 't-drawer-open', query: 'state=sell', steps: menu('פתיחת מגירה') },
  { id: 't-history', query: 'state=sell', steps: menu('היסטוריה'), expect: has('40000123') },
  { id: 't-history-detail', query: 'state=sell', steps: [...menu('היסטוריה'), { tap: '40000123', after: 1200 }] },
  { id: 't-blocks', query: 'state=sell', steps: menu('חסומים כעת') },
  { id: 't-block-sheet', query: 'state=sell', steps: [...menu('חסומים כעת'), { tap: 'חסום פריט', after: 1200, optional: true }] },
  { id: 't-print-queue', query: 'state=sell', steps: menu('תור הדפסה') },
  { id: 't-users', query: 'state=sell', steps: menu('עובדים מחוברים') },
  { id: 't-owed', query: 'state=sell', steps: menu('עודף חייב ללקוח') },
  { id: 't-transmission', query: 'state=sell', steps: menu('פעולות אשראי') },
  { id: 't-shop-x', query: 'state=sell', steps: [...report('דוח X סניפי'), { wait: 600 }] },
];

export const SCENARIOS = [
  // ── The kiosk (kiosk-desktop KioskApp over the shared screens) ──
  { id: 'k-attract', hosts: KIOSK, query: Q },
  { id: 'k-pairing', hosts: KIOSK, query: `${Q}&unpaired=1`, expect: `!!document.querySelector('input')` },
  { id: 'k-service', hosts: KIOSK, query: Q, steps: start, expect: has('טייק אווי') },
  // "גודל כרטיסי לקחת / לשבת" (P:/specs/kiosk-service-size.md): the two cards and "להמשך" all in the window, never huge.
  { id: 'k-service-fit', hosts: KIOSK, query: Q, steps: start, expect: serviceFits },
  { id: 'k-service-small', hosts: KIOSK, query: `${Q}&svcsize=small`, steps: start, expect: serviceFits },
  { id: 'k-service-large', hosts: KIOSK, query: `${Q}&svcsize=large`, steps: start, expect: serviceFits },
  { id: 'k-service-attract', hosts: KIOSK, query: `${Q}&placement=attract`, expect: `!!document.querySelector('[data-service-buttons]')` },
  { id: 'k-menu-rail', hosts: KIOSK, query: Q, steps: toMenu, expect: `!!document.querySelector('[data-dish]')` },
  { id: 'k-menu-tabs', hosts: KIOSK, query: 'layout=tabs&stress=1', steps: toMenu, expect: `!!document.querySelector('[data-dish]')` },
  { id: 'k-menu-classic', hosts: KIOSK, query: 'layout=standard&stress=1&style=classic', steps: toMenu, expect: has('שניצל עוף') },
  { id: 'k-sheet', hosts: KIOSK, query: Q, steps: [...toMenu, { tap: 'שניצל עוף בציפוי פנקו', after: 1200 }], expect: has('Sauces') },
  { id: 'k-upsell', hosts: KIOSK, query: Q, steps: [...basket, ...toCart, { tap: 'לתשלום' }, { waitFor: upsellShown }], expect: upsellShown },
  { id: 'k-cart', hosts: KIOSK, query: Q, steps: [...toMenu, ...fillCart, ...addBig, ...toCart], expect: has('בדקו את ההזמנה') },
  { id: 'k-side-cart', hosts: KIOSK, query: Q, steps: [...toMenu, ...fillCart, ...addBig] },
  // The basket's review in landscape (owner, 0.5.9 17.10): "לתשלום" inside the window, in the content column under the
  // summary, the composition centred — never a lone button at the window's edge. The rail and the standard template.
  { id: 'k-cart-fit', hosts: KIOSK, query: Q, steps: [...toMenu, ...fillCart, ...addBig, ...toCart], expect: cartFits },
  { id: 'k-cart-fit-standard', hosts: KIOSK, query: 'stress=1', steps: [...toMenu, { sel: '[data-add=direct]', after: 300 }, { sel: '[data-add=direct]', index: 1, after: 300, optional: true }, ...toCart], expect: cartFits },
  { id: 'k-tip', hosts: KIOSK, query: PAY, steps: toTip, expect: has('המשך ללא טיפ') },
  { id: 'k-details', hosts: KIOSK, query: PAY, steps: toDetails, expect: has('המשך ללא שם') },
  { id: 'k-pay-method', hosts: KIOSK, query: PAY, steps: toPayMethod, expect: has('מזומן בקופה') },
  { id: 'k-tip-fit', hosts: KIOSK, query: PAY, steps: toTip, expect: tipFits },
  { id: 'k-pay-method-fit', hosts: KIOSK, query: PAY, steps: toPayMethod, expect: payMethodFits },
  { id: 'k-card-wait', hosts: KIOSK, query: `${Q}&pay=card`, steps: [...basket, ...toCheckout, { tap: 'המשך ללא שם', after: 300 }], after: 200, expect: has('הצמידו') },
  { id: 'k-cash-at-till', hosts: KIOSK, query: PAY, steps: [...toPayMethod, { tap: 'מזומן בקופה', after: 2200 }] },
  { id: 'k-cash-insert', hosts: KIOSK, query: `${PAY}&cash=insert`, steps: [...toPayMethod, { sel: '[data-method=cash_device]', after: 1600, optional: true }, { tap: 'מזומן', index: 0, after: 1600, if: `!document.body.innerText.includes('הכניסו')` }] },
  { id: 'k-cash-busy', hosts: KIOSK, query: `${PAY}&cash=busy&cashdev=cashmag`, steps: [...toPayMethod, { tap: 'מזומן', index: 0, after: 1600 }] },
  { id: 'k-cash-queued', hosts: KIOSK, query: `${PAY}&cash=queued`, steps: [...toPayMethod, { tap: 'מזומן', index: 0, after: 1600 }] },
  { id: 'k-cash-owed', hosts: KIOSK, query: `${PAY}&cash=owed_choice`, steps: [...toPayMethod, { tap: 'מזומן', index: 0, after: 1600 }] },
  { id: 'k-cashmag-question', hosts: KIOSK, query: `${PAY}&cash=question&cashdev=cashmag`, steps: [...toPayMethod, { tap: 'מזומן', index: 0, after: 1600 }] },
  { id: 'k-cashmag-insert', hosts: KIOSK, query: `${PAY}&cash=insert&cashdev=cashmag`, steps: [...toPayMethod, { tap: 'מזומן', index: 0, after: 1600 }] },
  { id: 'k-done', hosts: KIOSK, query: `${Q}&pay=card`, steps: [...basket, ...toCheckout, { tap: 'המשך ללא שם', after: 300 }, { wait: 3600 }], expect: has('ההזמנה התקבלה') },
  { id: 'k-no-payment', hosts: KIOSK, query: `${Q}&nopay=1` },
  { id: 'k-offline', hosts: KIOSK, query: `${Q}&offline=1`, steps: toMenu },
  { id: 'k-paused', hosts: KIOSK, query: `${Q}&paused=1&until=18:30&msg=${encodeURIComponent('הקיוסק מושהה לניקיון — אפשר להזמין בקופה הראשית, תודה על הסבלנות')}` },
  { id: 'k-closed', hosts: KIOSK, query: `${Q}&closed=1` },
  { id: 'k-admin', hosts: KIOSK, query: `${Q}&admin=full`, steps: admin, expect: has('ניהול הקיוסק') },
  { id: 'k-admin-z', hosts: KIOSK, query: `${Q}&admin=full`, steps: [...admin, { eval: `Array.from(document.querySelectorAll('h2,h3,div')).find(e => e.innerText && e.innerText.trim().startsWith('משמרת ו-Z'))?.scrollIntoView({ block: 'start' })` }], expect: has('משמרת ו-Z') },
  { id: 'k-admin-history', hosts: KIOSK, query: `${Q}&admin=full`, steps: [...admin, { eval: `Array.from(document.querySelectorAll('h2,h3,div')).find(e => e.innerText && e.innerText.trim().startsWith('היסטוריית עסקאות'))?.scrollIntoView({ block: 'start' })` }], expect: has('היסטוריית עסקאות') },
  { id: 'k-admin-cash', hosts: KIOSK, query: `${Q}&admin=full`, steps: [...admin, { eval: `Array.from(document.querySelectorAll('h2,h3,div')).find(e => e.innerText && e.innerText.trim().startsWith('מכשיר מזומן'))?.scrollIntoView({ block: 'start' })` }], expect: has('CashMag') },
  { id: 'k-technician', hosts: KIOSK, query: Q, steps: [{ taps: 'technician' }, { tap: '1', after: 120 }, { tap: '9', after: 120 }, { tap: '9', after: 120 }, { tap: '5', after: 120 }, { tap: 'אישור', after: 1500 }], expect: has('192.168.1.57') },

  // ── The Windows till (roles/till TillApp on the fixture engine: /tillAudit.html, src/renderer/tillAudit) ──
  ...TILL.map((t) => ({ hosts: ['win-till'], page: 'tillAudit.html', ...t })),
  // ── The till's customer display (second screen: display.html's audit frame) ──
  ...['idle', 'basket', 'tip', 'paying', 'change', 'thanks'].map((phase) => ({ id: `d-${phase}`, hosts: ['display'], page: 'display.html', query: `phase=${phase}` })),
  { id: 'd-basket-split-light', hosts: ['display'], page: 'display.html', query: 'phase=basket&layout=split&theme=light' },
];

/**
 * Intended exceptions, each with its reason (the checker skips these rules on these elements).
 */
export const ALLOW = [
  // The Windows till in the Android till's colours (P:/specs/till-visual-parity): the owner's iOS system blue (#007AFF, the
  // brand when the cloud sets none) as a fill under white (4.0:1) and as text on the grouped grey (3.6:1) — exactly what the
  // Android till draws; a brand colour from the cloud repaints both alike.
  {
    selector: '.t-root .t-btn-primary, .t-root .t-btn-ghost, .t-root .t-chip-on, .t-root .t-nav-on, .t-root .t-payall-prominent, .t-root .t-pay-head, .t-root .t-link, .t-root .t-tender-main, .t-root .t-more-count, .t-root .t-mbadge, .t-root .t-key-bare, .t-root .t-lock-hello, .t-root .t-pay-details-toggle, .t-root .t-tile-info-dot, .t-root .t-tile-count',
    rules: ['contrast'],
    reason: "the Android till's brand colour (iOS blue) as Android draws it",
  },
  // An unavailable product at half strength, as Android's ProductTile (alpha 0.5): shown as off, not meant to be read as on.
  { selector: '.t-root .t-tile-off', rules: ['contrast'], reason: 'an unavailable tile at half strength, as Android ProductTile' },
  // The tenders' own colours under white (card #2563EB, cash #16A34A / #15803D), as Android's PayNowButtons / quick-pay.
  { selector: '.t-root .t-paynow-btn, .t-root .t-quickpay-btn', rules: ['contrast'], reason: "the Android till's tender colours" },
  // The customer display's basket is bottom-anchored on purpose: older lines go out at the top so the newest always shows.
  { selector: '[data-cd-lines] > *', rules: ['clipped', 'outside'], screens: ['d-basket', 'd-basket-split-light', 'd-tip', 'd-paying', 'd-change'], reason: 'the oldest lines leave at the top by design' },
];
