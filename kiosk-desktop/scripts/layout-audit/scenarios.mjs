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

const menu = (row) => [{ tap: 'תפריט', after: 700 }, { tap: row, after: 1000 }];
const TILL = [
  { id: 't-lock', query: 'state=lock' },
  { id: 't-sell', query: 'state=sell' },
  { id: 't-sell-empty', query: 'state=sell-empty' },
  { id: 't-item-info', query: 'state=sell-empty', steps: [{ sel: '.t-tile-info', after: 800 }] },
  { id: 't-order-ask', query: 'state=order-ask' },
  { id: 't-notice', query: 'state=notice' },
  { id: 't-dialog', query: 'state=dialog' },
  { id: 't-held', query: 'state=sell', steps: [{ sel: '.t-cart-bar', optional: true }, { tap: 'מכירות בהמתנה', after: 900 }], expect: has('שולחן 12') },
  { id: 't-discount', query: 'state=sell', steps: [{ sel: '.t-cart-bar', optional: true }, { tap: 'הנחה לחשבון', after: 900 }] },
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
  { id: 't-shift', query: 'state=sell', steps: [{ tap: 'משמרת', index: 0, after: 1200 }] },
  { id: 't-menu', query: 'state=sell', steps: [{ tap: 'תפריט', after: 900 }], expect: has('חסומים כעת') },
  { id: 't-drawer', query: 'state=sell', steps: menu('מזומן במגירה') },
  { id: 't-drawer-open', query: 'state=sell', steps: menu('פתיחת מגירה') },
  { id: 't-history', query: 'state=sell', steps: menu('היסטוריה'), expect: has('40000123') },
  { id: 't-history-detail', query: 'state=sell', steps: [...menu('היסטוריה'), { tap: '40000123', after: 1200 }] },
  { id: 't-blocks', query: 'state=sell', steps: menu('חסומים כעת') },
  { id: 't-block-sheet', query: 'state=sell', steps: [...menu('חסומים כעת'), { tap: 'חסום פריט', after: 1200, optional: true }] },
  { id: 't-print-queue', query: 'state=sell', steps: menu('תור הדפסה') },
  { id: 't-users', query: 'state=sell', steps: menu('עובדים מחוברים') },
  { id: 't-owed', query: 'state=sell', steps: menu('עודף חייב ללקוח') },
  { id: 't-transmission', query: 'state=sell', steps: menu('פעולות אשראי') },
  { id: 't-shop-x', query: 'state=sell', steps: [...menu('דוח X סניפי'), { wait: 600 }] },
];

export const SCENARIOS = [
  // ── The kiosk (kiosk-desktop KioskApp over the shared screens) ──
  { id: 'k-attract', hosts: KIOSK, query: Q },
  { id: 'k-pairing', hosts: KIOSK, query: `${Q}&unpaired=1`, expect: `!!document.querySelector('input')` },
  { id: 'k-service', hosts: KIOSK, query: Q, steps: start, expect: has('טייק אווי') },
  { id: 'k-menu-rail', hosts: KIOSK, query: Q, steps: toMenu, expect: `!!document.querySelector('[data-dish]')` },
  { id: 'k-menu-tabs', hosts: KIOSK, query: 'layout=tabs&stress=1', steps: toMenu, expect: `!!document.querySelector('[data-dish]')` },
  { id: 'k-menu-classic', hosts: KIOSK, query: 'layout=standard&stress=1&style=classic', steps: toMenu, expect: has('שניצל עוף') },
  { id: 'k-sheet', hosts: KIOSK, query: Q, steps: [...toMenu, { tap: 'שניצל עוף בציפוי פנקו', after: 1200 }], expect: has('Sauces') },
  { id: 'k-upsell', hosts: KIOSK, query: Q, steps: [...basket, ...toCart, { tap: 'לתשלום' }, { waitFor: upsellShown }], expect: upsellShown },
  { id: 'k-cart', hosts: KIOSK, query: Q, steps: [...toMenu, ...fillCart, ...addBig, ...toCart], expect: has('בדקו את ההזמנה') },
  { id: 'k-side-cart', hosts: KIOSK, query: Q, steps: [...toMenu, ...fillCart, ...addBig] },
  { id: 'k-tip', hosts: KIOSK, query: PAY, steps: toTip, expect: has('המשך ללא טיפ') },
  { id: 'k-details', hosts: KIOSK, query: PAY, steps: toDetails, expect: has('המשך ללא שם') },
  { id: 'k-pay-method', hosts: KIOSK, query: PAY, steps: toPayMethod, expect: has('מזומן בקופה') },
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
  // The customer display's basket is bottom-anchored on purpose: older lines go out at the top so the newest always shows.
  { selector: '[data-cd-lines] > *', rules: ['clipped', 'outside'], screens: ['d-basket', 'd-basket-split-light', 'd-tip', 'd-paying', 'd-change'], reason: 'the oldest lines leave at the top by design' },
];
