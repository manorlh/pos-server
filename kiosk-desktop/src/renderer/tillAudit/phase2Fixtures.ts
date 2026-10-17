/**
 * The layout audit's phase-2 slices (P:/specs/windows-till-menu-parity.md §7): each module's state with stress data — long
 * Hebrew and English names, many rows — so the audit lays out every new screen and sheet of the Windows till. Fixtures
 * only: nothing here is sent anywhere.
 */

import type { Catalog, TillState } from '../../shared/till/protocol';
import { emptyShopZState, statusOf } from '../../core/till/shopZRun';
import { rowOf, orderOf } from '../../core/till/kioskOrders';

const NOW = Date.parse('2026-10-16T12:30:00.000Z');
const money = (a: number) => `₪${(a / 100).toFixed(2)}`;
const gate = (o: Record<string, unknown> = {}) => ({ offered: true, usable: true, approval: false, reason: null, ...o });

/** "ניהול קטלוג" open on its products. */
export const catalogAdmin: NonNullable<TillState['catalogAdmin']> = {
  entryShown: true,
  open: true,
  panel: 'products',
  title: 'ניהול קטלוג',
  scopeLine: 'קטלוג נקודת המכירה «בר הטרסה — Terrace Bar & Lounge» · 1,234 מוצרים',
  busy: false,
  note: { text: 'עודכן — הקופות יסתנכרנו', tone: 'ok' },
  approvedBy: 'Jonathan Livingston-Smith',
  gates: { availability: gate(), price: gate({ approval: true }), edit: gate(), create: gate() },
  canSelect: true,
  filter: { query: '', categoryId: null, channel: null, state: 'any', showOutOfScope: false },
  offerOutOfScope: true,
  stateChips: [
    { key: 'any', label: 'מצב: הכל', on: true },
    { key: 'active', label: 'פעילים', on: false },
    { key: 'inactive', label: 'לא פעילים', on: false },
    { key: 'sold_out', label: 'אזל / חסום', on: false },
  ],
  channelChips: [
    { key: '', label: 'כל הערוצים', on: true },
    { key: 'all', label: 'קופות וקיוסק', on: false },
    { key: 'kiosk_only', label: 'קיוסק בלבד', on: false },
    { key: 'pos_only', label: 'קופות בלבד', on: false },
  ],
  categoryChips: [
    { key: '', label: 'הכל (1,234)', on: true },
    { key: 'c-main', label: 'מנות עיקריות מיוחדות של השף (418)', on: false },
    { key: 'c-drink', label: 'Chef’s Specials & Signature Dishes (816)', on: false },
  ],
  rows: Array.from({ length: 24 }, (_, i) => ({
    id: `p${i}`,
    name: i % 3 === 0 ? 'המבורגר אנטריקוט 300 גרם עם צ׳יפס בטטה, בצל מקורמל ורוטב הבית החריף' : i % 3 === 1 ? 'Double Smash Burger with Caramelized Onions, Aged Cheddar & Truffle Mayo' : 'קולה זירו',
    price: i === 2 ? '₪99,999.90' : `₪${(12 + i * 3.5).toFixed(2)}`,
    imageUrl: null,
    inScope: i % 7 !== 3,
    tags: i % 4 === 1 ? [{ tag: 'inactive', label: 'לא פעיל' }] : i % 4 === 2 ? [{ tag: 'sold_out', label: 'אזל' }, { tag: 'shared', label: 'משותף' }] : [],
    channel: i % 5 === 0 ? 'קופות בלבד' : null,
  })),
  total: 1234,
  hasArea: true,
  availabilityScope: 'area',
  scopeOptions: [
    { key: 'machine', label: 'בקופה זו', affects: 'ישפיע על הקופה הזו בלבד', enabled: true },
    { key: 'area', label: 'בנקודת המכירה', affects: 'ישפיע על כל נקודת המכירה', enabled: true },
    { key: 'shop', label: 'בכל הסניף', affects: 'ישפיע על כל הסניף', enabled: true },
  ],
  categories: [
    { id: 'c-main', name: 'מנות עיקריות מיוחדות של השף', inactive: false },
    { id: 'c-drink', name: 'Chef’s Specials & Signature Dishes', inactive: true },
  ],
  page: null,
  priceAsk: null,
  machine: null,
} as unknown as NonNullable<TillState['catalogAdmin']>;

/** "סגירת Z סניפי": the tills and their shifts, before the start. */
export const shopZ: NonNullable<TillState['shopZ']> = {
  ...emptyShopZState(),
  loading: false,
  status: statusOf({
    shopName: 'רויאל בר — סניף הרצליה פיתוח (מתחם הקניון, קומה 2)',
    tills: [
      { id: 'm-1', posNumber: '12', name: 'קופה 12 — דלפק ראשי (Main Counter)', self: true, online: true, openShift: { id: 's-1', openedByName: 'אלכסנדרה בן־דוד' }, closedWaiting: 0 },
      { id: 'm-2', posNumber: '3', name: 'Terrace till 3 — בר הטרסה', self: false, online: true, openShift: { id: 's-2', openedByName: 'Jonathan Livingston-Smith' }, closedWaiting: 0 },
      { id: 'm-3', posNumber: '4', name: 'קופת אירועים', self: false, online: false, openShift: null, closedWaiting: 2 },
    ],
    activity: { hasActivity: true, documents: 1234 },
  }),
};

/** "נוכחות": the panel of the employee signed in. */
export const attendance: NonNullable<TillState['attendance']> = {
  clockShown: false,
  clockOpen: false,
  menuLine: 'במשמרת מ־17:02',
  gate: null,
  card: {
    userId: 'u1',
    title: 'נוכחות · אלכסנדרה בן־דוד (מנהלת משמרת)',
    status: 'במשמרת מ־17:02',
    lines: ['מנהלת משמרת — Senior Shift Manager', 'שעות במשמרת: 3:12', 'הפסקות: 1 · 0:20', 'בקשות תיקון ממתינות לאישור: 1'],
    offline: false,
    buttons: [
      { action: 'break_start', label: 'יציאה להפסקה', tone: 'tonal' },
      { action: 'clock_out', label: 'סיום משמרת', tone: 'danger' },
    ],
    loading: false,
  },
  cardKind: 'panel',
  sheet: null,
  message: null,
  busy: false,
  unsent: 0,
} as unknown as NonNullable<TillState['attendance']>;

/** The menu's line only (no card): what every screen carries. */
export const attendanceQuiet = { ...attendance, card: null, cardKind: null } as unknown as NonNullable<TillState['attendance']>;

/** "הזמנות להכנה". */
export const readyOrders = {
  loaded: true,
  offline: false,
  blocked: null,
  hasKds: false,
  notice: null,
  empty: false,
  sections: [
    {
      key: 'waiting',
      title: 'בהכנה',
      count: 6,
      rows: Array.from({ length: 6 }, (_, i) => ({
        orderId: `o${i}`,
        headline: i % 2 ? `A-${17 + i}` : `שולחן ${12 + i} — משפחת כהן־אברהמי`,
        headlineLtr: i % 2 === 1,
        minutes: `${12 + i} דק׳`,
        meta: 'קיוסק · לקחת · Jonathan Livingston-Smith · 20000057',
        items: [
          { text: '2 × Double Smash Burger with Caramelized Onions, Aged Cheddar & Truffle Mayo', ready: true },
          { text: "1.50 × צ'יפס בטטה", ready: false },
        ],
        handed: false,
        mode: 'actions',
        actions: [{ action: 'ready', label: 'מוכן', primary: true }],
      })),
    },
    {
      key: 'ready',
      title: 'מוכן לאיסוף',
      count: 1,
      rows: [{ orderId: 'o9', headline: 'שולחן 12', headlineLtr: false, minutes: 'עכשיו', meta: 'שולחן · לשבת', items: [], handed: false, mode: 'failed', actions: [{ action: 'handover', label: 'נמסר', primary: true }, { action: 'undo', label: 'החזר', primary: false }] }],
    },
  ],
} as unknown as NonNullable<TillState['readyOrders']>;

/** "התראות". */
export const alerts = {
  count: 3,
  unseen: 2,
  subtitle: '3 פתוחות',
  line: { text: 'התראות (3) · קיוסק כניסה ראשית — Main Entrance Kiosk A מבקש עזרה · תשלום · ₪42', strong: true, help: true },
  beep: null,
  groups: [
    {
      device: 'k1',
      name: 'קיוסק כניסה ראשית — Main Entrance Kiosk A',
      kioskControl: true,
      items: [
        { key: 'k1|help|h1', source: 'kiosk', title: 'בקשת עזרה מקיוסק', text: 'קיוסק כניסה ראשית מבקש עזרה · תשלום · ₪42', time: '14:05', unseen: true, urgent: true, help: true, pinged: 'קריאה מספר 2', ackedBy: null, onMyWay: true, seen: 'text', pay: false, queue: false, printers: false },
        { key: 'k1|printer:receipt|no_paper', source: 'kiosk', title: 'תקלה במדפסת של קיוסק', text: 'קיוסק כניסה ראשית — מדפסת קבלות: אין נייר', time: '13:40', unseen: false, urgent: false, help: false, pinged: null, ackedBy: 'ראו: Jonathan Livingston-Smith', onMyWay: false, seen: null, pay: false, queue: false, printers: false },
      ],
    },
    {
      device: 'cash:s1',
      name: 'עמדת מזומן 2',
      kioskControl: false,
      items: [{ key: 'cash:s1|cash:change_owed:o1|change_owed', source: 'cash', title: 'עודף חייב ללקוח', text: 'עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57: 13 ₪', time: '13:58', unseen: true, urgent: true, help: false, pinged: null, ackedBy: null, onMyWay: false, seen: 'button', pay: true, queue: false, printers: false }],
    },
  ],
} as unknown as NonNullable<TillState['alerts']>;

/** "בירור יתרת שובר": a voucher found. */
export const voucherBalance = {
  enabled: true,
  open: true,
  busy: false,
  error: null,
  answer: {
    kind: 'found',
    code: 'ABCDEFGH23456789',
    card: {
      serial: 'שובר מס׳ 8',
      typeName: 'שובר ארוחה — Annual Company Conference 2026',
      event: 'פסטיבל חורף',
      production: 'הפקה: קייטרינג אלון',
      validFrom: null,
      validUntil: 'בתוקף עד 2026-12-31 23:59',
      note: null,
      testBar: null,
      status: { text: 'מומש חלקית', tone: 'orange', dead: false, detail: null },
      left: ['מכסה 3 | מומשו 1 | נותרו 2', 'Double Smash Burger with Caramelized Onions — נותרו 2'],
      lastRedeemed: 'מומש לאחרונה: 2026-10-11 22:14 · קופה 3 · סניף מרכז',
      first: null,
      historyTitle: 'היסטוריית מימושים (6)',
      history: Array.from({ length: 6 }, (_, i) => ({ text: `2026-10-1${i} 22:14 · קופה 3 · סניף מרכז · דנה — 1× המבורגר · ₪42 · מסמך ${1234 + i}`, reversed: i === 2 })),
      redeemable: true,
    },
  },
} as unknown as NonNullable<TillState['voucherBalance']>;

/** "עמדת שובר": the home with a sale under way. */
export const voucherStation = {
  active: true,
  menu: { label: 'יציאה למסך רגיל' },
  phase: 'home',
  header: 'עמדת מימוש שוברים — Voucher Redemption Station',
  home: { scan: true, manual: true, nothing: null, scanText: 'סרקו שובר נוסף', hint: 'הסורק פעיל תמיד', strip: 'בעסקה: שובר מס׳ 0008 · 2 פריטים', vouchers: [{ voucherId: 'v-g', title: 'שובר מס׳ 0008', covers: 'המבורגר ×1 · קולה ×1' }], finish: true, openOrder: null, basket: true },
  notice: null,
  picker: null,
  basket: null,
  testBar: null,
  busy: false,
} as unknown as NonNullable<TillState['voucherStation']>;

/** "דוחות Z" from the cloud, with the what-to-print choice. */
export const cloudZ = {
  title: 'דוחות Z',
  loading: false,
  loadingText: null,
  message: 'דו״ח Z \u200F#57 נשלח למדפסת.',
  empty: null,
  unsupported: false,
  rows: Array.from({ length: 30 }, (_, i) => ({ id: `z-${58 - i}`, title: `דו״ח Z \u200F#${58 - i}`, line: `\u20662026-10-${String(16 - (i % 15)).padStart(2, '0')}\u2069 · \u2066₪${(12480 - i * 97.5).toFixed(2)}\u2069`, checked: i === 0, printing: false })),
  busy: false,
  selectAllLabel: 'בחר הכל',
  sequenceLabel: 'הדפס רצף (1)',
  canSequence: true,
  printLabel: 'הדפס',
  printingLabel: 'מדפיס…',
  choice: null,
  progress: null,
  cancelLabel: 'ביטול',
} as unknown as NonNullable<TillState['cloudZ']>;

/** "מדפסות". */
export const printers = {
  title: 'מדפסות',
  queue: { title: 'בונים שממתינים לטיפול', rows: [{ id: 'j1', title: 'שולחן 12 · בר — Double Smash Burger with Caramelized Onions', state: 'לא הודפס — no_paper: אין נייר', canMove: true, canTill: true }] },
  server: { light: 'ok', title: 'שרת הדפסות', text: 'שרת ההדפסות: קופה 1 · 192.168.1.20:8399', sub: 'זמין ברשת — הבונים נשלחים אליו' },
  receipt: {
    title: 'מדפסת לקבלות ולמסמכים',
    hint: 'קבלות, העתקים, שוברים וחשבונות שולחן — בקופה הזו. לדוחות יש מדפסת משלהם.',
    now: 'הקבלות מודפסות כעת: מדפסת הקופה',
    override: null,
    followsCloud: 'לפי הגדרת הענן',
    backLabel: 'חזור להגדרת הענן',
    gone: null,
    options: [
      { id: 'local', label: 'מדפסת הקופה', on: false },
      { id: 'r-3', label: 'המדפסת של קופה 3 — Terrace till 3', on: false },
      { id: 'ask', label: 'לשאול בכל פעם', on: false },
    ],
  },
  listTitle: 'המדפסות של הקופה',
  rows: [
    { id: 'till', name: 'קופה', light: 'ok', where: 'מדפסת הקופה · Windows: EPSON TM-T20III Receipt (USB · אוטומטי)', usb: 'מדפסת USB: מחוברת', design: null, status: 'תקין', checking: false, widthTest: false, designTest: false },
    { id: 'p-bar', name: 'בר הטרסה — Terrace Bar Printer', light: 'error', where: 'רשת · 192.168.1.41:9100 · 576 נקודות', usb: null, design: 'עיצוב בון: גדול וברור', status: 'לא מגיב', checking: false, widthTest: true, designTest: true },
    { id: 'p-k', name: 'מטבח', light: 'ok', where: 'דרך הענן', usb: null, design: 'עיצוב בון: לפי ההגדרה הכללית', status: 'תקין · דרך הענן', checking: true, widthTest: false, designTest: true },
  ],
  none: null,
  message: 'בון בדיקה נשלח ל־בר',
  history: { title: 'הודפסו לאחרונה (24 שעות)', rows: Array.from({ length: 8 }, (_, i) => ({ id: `j${9 + i}`, text: `מכירה #${57 + i} · מטבח · 21:1${i}` })) },
  discovery: {
    title: 'חיפוש מדפסות ברשת',
    hint: 'הקופה סורקת את הרשת המקומית (Wi‑Fi / Ethernet) ומוצאת מדפסות קבלה ומטבח שאפשר להוסיף לסניף.',
    scanning: false,
    startLabel: 'חיפוש מחדש',
    stopLabel: 'הפסק',
    text: 'נמצאו 1 ב-192.168.1.0/24 (6 שנ׳)',
    found: [{ key: '192.168.1.40:9100', host: '192.168.1.40', port: 9100, title: 'מדפסת · 192.168.1.40:9100', kind: 'מדפסת ESC/POS', paper: 'נייר תקין', known: null, canAdd: true, addTitle: 'הוספת מדפסת 192.168.1.40' }],
    add: { label: 'הוספה', name: 'שם המדפסת', purpose: 'סוג המדפסת', kitchen: 'מדפסת מטבח / בר (בונים)', receipt: 'מדפסת חשבוניות (קבלות)', hint: 'המדפסת תתווסף לכל הקופות בסניף, עם הגדרות ההדפסה של הסניף. מה מודפס בה (ניתוב הבונים) — בדשבורד, בדף "מדפסות".', cancel: 'ביטול' },
  },
  labels: { check: 'בדיקת תקשורת', testTicket: 'בון בדיקה', testDesign: 'הדפסת ניסיון בעיצוב הזה', widthTest: 'בדיקת רוחב', reprint: 'הדפס שוב', retry: 'נסה שוב', other: 'מדפסת אחרת', till: 'הדפס בקופה', dismiss: 'בטל בון' },
} as unknown as NonNullable<TillState['printers']>;

/** "עריכת מסך" on. */
export const screenEditOn = { available: true, on: true, saving: false, dirty: true, lockBusy: null } as unknown as NonNullable<TillState['screenEdit']>;
export const screenEditOff = { available: true, on: false, saving: false, dirty: false, lockBusy: null } as unknown as NonNullable<TillState['screenEdit']>;

/** "הזמנות קיוסק לתשלום": three waiting, one held by another till. */
export function kioskOrders(): NonNullable<TillState['kioskOrders']> {
  const orders = Array.from({ length: 3 }, (_, i) =>
    orderOf({
      id: `ko-${i}`,
      localId: `L${17 + i}`,
      kioskName: 'קיוסק כניסה ראשית — Main Entrance Kiosk A',
      state: 'open',
      pickupLabel: `A-${17 + i}`,
      customerName: i === 0 ? 'Jonathan Livingston-Smith' : 'משפחת כהן־אברהמי',
      serviceType: i % 2 ? 'eat_in' : 'take_away',
      itemCount: 12 + i,
      totalAgorot: 9_999_990,
      tipAgorot: 0,
      voucherAgorot: i === 1 ? 2_500 : 0,
      dueAgorot: 9_999_990 - (i === 1 ? 2_500 : 0),
      lines: Array.from({ length: 8 }, (_, j) => ({ name: j % 2 ? 'Double Smash Burger with Caramelized Onions' : 'קפה הפוך גדול על חלב שיבולת שועל', quantity: 1 + (j % 3), totalAgorot: 4_200 })),
      createdAt: new Date(NOW - (5 + i * 7) * 60_000).toISOString(),
      lockedBy: i === 2 ? 'Terrace till 3 · Jonathan' : null,
    })!,
  );
  return { waiting: 3, rows: orders.map((o) => rowOf(o, NOW, money)), busyId: null, notice: null, active: null };
}

/** The sell screen's catalog with a dish of required choices and a meal (the choices sheet's scenarios). */
export function withChoices(catalog: Catalog): Catalog {
  return {
    ...catalog,
    choiceGroups: {
      'g-size': {
        id: 'g-size',
        name: 'גודל המנה — Portion size',
        kind: 'choice',
        min: 1,
        max: 1,
        freeCount: 0,
        allowQuantity: false,
        allowPre: false,
        options: [
          { id: 'o-s', name: 'רגילה', priceAgorot: 0, isDefault: false, maxQty: null },
          { id: 'o-l', name: 'גדולה (Family size — מומלץ לשניים)', priceAgorot: 1_500, isDefault: false, maxQty: null },
        ],
      },
      'g-extra': {
        id: 'g-extra',
        name: 'תוספות',
        kind: 'addon',
        min: 0,
        max: 5,
        freeCount: 1,
        allowQuantity: true,
        allowPre: true,
        options: Array.from({ length: 9 }, (_, i) => ({ id: `o-x${i}`, name: i % 2 ? 'Aged Cheddar Cheese' : 'פטריות פורטובלו מוקפצות', priceAgorot: 300 + i * 100, isDefault: i === 0, maxQty: 3 })),
      },
      'g-rm': { id: 'g-rm', name: 'הסרות', kind: 'removal', min: 0, max: null, freeCount: 0, allowQuantity: false, allowPre: false, options: [{ id: 'o-on', name: 'בצל', priceAgorot: 0, isDefault: false, maxQty: null }, { id: 'o-to', name: 'עגבנייה', priceAgorot: 0, isDefault: false, maxQty: null }] },
    },
    products: [
      {
        id: 'p-dish',
        departmentId: catalog.departments[0].id,
        name: 'פיצה מרגריטה של השף',
        priceAgorot: 5_800,
        allergens: ['גלוטן', 'חלב'],
        choices: { groupIds: ['g-size', 'g-extra', 'g-rm'], notes: ['בלי מלח', 'לילד', 'חתוך ל-8', 'Well done, please'], ownNotes: true, needsSheet: true },
      },
      {
        id: 'p-meal',
        departmentId: catalog.departments[0].id,
        name: 'ארוחת המבורגר עסקית',
        priceAgorot: 6_900,
        choices: {
          groupIds: [],
          notes: ['בלי מלח'],
          ownNotes: true,
          needsSheet: true,
          meal: [
            { id: 's-main', name: 'מנה עיקרית', minSelect: 1, maxSelect: 1, quantity: 1, allowRepeat: false, choices: [{ productId: 'p-dish', name: 'פיצה מרגריטה של השף', upchargeAgorot: 0, isDefault: false, groupIds: ['g-size'] }, { productId: 'p2', name: 'Double Smash Burger with Caramelized Onions', upchargeAgorot: 900, isDefault: false, groupIds: [] }] },
            { id: 's-drink', name: 'שתייה', minSelect: 1, maxSelect: 2, quantity: 2, allowRepeat: true, choices: [{ productId: 'p9', name: 'אספרסו', upchargeAgorot: 0, isDefault: true, groupIds: [] }, { productId: 'p10', name: 'מיץ תפוזים סחוט טבעי 100% — גדול', upchargeAgorot: 500, isDefault: false, groupIds: [] }] },
          ],
        },
      },
      ...catalog.products,
    ],
  };
}
