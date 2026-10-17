/**
 * The layout audit's till (P:/specs/layout-audit-1610/README.md): the real TillApp on an engine that answers from
 * fixtures — every screen and sheet of the Windows till with stress data (long Hebrew and English names, 24 lines,
 * discounts, OTH, returns, vouchers, ₪99,999.90) — so `scripts/layout-audit` can lay each one out on every screen size.
 * `npm run dev:web` serves it at /tillAudit.html?state=<name>; never in a build (not a vite input), never the network.
 */

import {
  TILL_PROTOCOL,
  type Catalog,
  type CartLine,
  type DocumentDetail,
  type EngineCall,
  type EngineEndpoint,
  type EngineEvent,
  type EngineReply,
  type HelloReply,
  type LocalReportView,
  type TillState,
  type XReport,
} from '../../shared/till/protocol';
import { demoDesignState, initialState } from '../../shared/till/mockEngine';
import { demoDesignConfig, themeOf, withTotal } from '../../core/till/tillDesign';
import { kioskControlRows } from '../../core/till/kioskControl';
import { drawerOf } from '../../core/till/cashWithTips';
import * as P2 from './phase2Fixtures';

const LONG = [
  'שניצל עוף בציפוי פנקו עם פירה תפוחי אדמה ורוטב פטריות שמנת',
  'Double Smash Burger with Caramelized Onions, Aged Cheddar & Truffle Mayo',
  'Ultimate בורגר XXL Special Edition',
  'מגש אירוח ענק לאירועים — Party Platter Deluxe',
  'קפה הפוך גדול על חלב שיבולת שועל עם שוט נוסף',
  'סלט קינואה, בטטה צלויה, רימונים ואגוזי מלך',
  'Iced Caramel Macchiato Venti Extra Shot',
  'כריך טונה',
  'אספרסו',
  'מיץ תפוזים סחוט טבעי 100% — גדול',
  'בירה מהחבית 0.5 ליטר',
  'עוגת גבינה פירורים',
];

export function stressCatalog(): Catalog {
  const departments = [
    { id: 'd1', name: 'מנות עיקריות מיוחדות של השף', color: '#8a5a2b' },
    { id: 'd2', name: 'Chef’s Specials & Signature Dishes', color: '#1f6feb' },
    { id: 'd3', name: 'שתייה חמה', color: '#b26b00' },
    { id: 'd4', name: 'שתייה קרה', color: '#1a7f37' },
    { id: 'd5', name: 'מאפים', color: '#2e7d6b' },
    { id: 'd6', name: 'קינוחים', color: '#a3346a' },
    { id: 'd7', name: 'מגשי אירוח לאירועים', color: '#5b3cc4' },
    { id: 'd8', name: 'בר', color: '#b42318' },
    { id: 'd9', name: 'ילדים', color: '#0e7490' },
    { id: 'd10', name: 'תוספות', color: '#4d7c0f' },
  ];
  const products = Array.from({ length: 60 }, (_, i) => ({
    id: `p${i + 1}`,
    departmentId: departments[i % departments.length].id,
    name: i < LONG.length ? LONG[i] : `${LONG[i % LONG.length]} ${Math.floor(i / LONG.length) + 1}`,
    priceAgorot: i === 3 ? 9_999_990 : 900 + ((i * 731) % 18_000),
    ...(i % 9 === 4 || i === 3 ? { sale: 'sold_out' as const, saleReason: 'אזל במלאי' } : {}),
    ...(i % 7 === 2 ? { description: 'תיאור ארוך של המנה עם רכיבים, אלרגנים ושאר פרטים שהלקוח שואל עליהם', allergens: ['גלוטן', 'חלב', 'אגוזים'] } : {}),
  }));
  return { version: 7, departments, products };
}

function lines(n: number): CartLine[] {
  const out: CartLine[] = [];
  for (let i = 0; i < n; i++) {
    const unit = i === 3 ? 9_999_990 : 900 + ((i * 731) % 18_000);
    const qty = i % 5 === 0 ? 12 : 1 + (i % 3);
    const pct = i % 4 === 1 ? 20 : 0;
    const total = Math.round((qty * unit * (100 - pct)) / 100);
    out.push({
      lineId: `l${i + 1}`,
      productId: `p${i + 1}`,
      name: i < LONG.length ? LONG[i] : `${LONG[i % LONG.length]} ${i}`,
      qty,
      unitAgorot: unit,
      discountPct: pct,
      totalAgorot: i === 6 ? -total : total,
      ...(i === 6 ? { refund: true, fromReceipt: '40000123' } : {}),
      ...(pct ? { discountAgorot: qty * unit - total } : {}),
      ...(i === 8 ? { oth: 'אורח VIP של המנהל', discountAgorot: total, totalAgorot: 0 } : {}),
      ...(i === 10 ? { noDiscount: true } : {}),
      ...(i === 11 ? { voucher: 'כלול בשובר #12 · שובר ארוחת צהריים לעובדים', voucherValueAgorot: unit, totalAgorot: 0 } : {}),
    });
  }
  return out;
}

const NOW = Date.parse('2026-10-16T12:30:00.000Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

/** The rich till state every screen starts from (a real engine's, not the demo's). */
function richState(): TillState {
  const base = initialState({ role: 'till', rolesAllowed: ['kiosk'], terminal: true, printer: true, catalogVersion: 7, nowIso: iso(300) });
  const l = lines(24);
  const total = l.reduce((s, x) => s + x.totalAgorot, 0);
  return {
    ...base,
    session: {
      cashier: { id: 'u1', name: 'אלכסנדרה בן־דוד (מנהלת משמרת)' },
      locked: false,
      demo: false,
      permissions: ['SELL', 'SHIFT_OPEN', 'SHIFT_CLOSE', 'REPORT_X', 'Z', 'REFUND', 'SHOP_X_REPORT', 'DISCOUNT', 'TRANSMIT', 'DRAWER_OPEN'],
    },
    sell: {
      catalogVersion: 7,
      departmentId: null,
      search: '',
      lines: l,
      itemCount: l.reduce((s, x) => s + x.qty, 0),
      totalAgorot: total,
      vatAgorot: Math.round((total * 18) / 118),
      promotionsAgorot: 4_590,
      saleTotalAgorot: total + 30_000,
      refundTotalAgorot: 30_000,
      basketDiscount: { amountAgorot: 12_345, type: 'percentage', value: 5 },
      lineDiscountsAgorot: 9_870,
      othAgorot: 4_200,
      nonDiscountableAgorot: 1_800,
    },
    shift: { open: true, number: 1287, openedAt: iso(300), openingCashAgorot: 50_000, salesCount: 214, salesAgorot: 9_999_990, cashAgorot: 4_567_890, cardAgorot: 5_432_100 },
    z: { lastNumber: 1186, canProduce: true, reason: null, zMode: 'till' },
    health: { cloud: 'online', printer: 'ok', terminal: 'ok', outbox: 3 },
    mode: { role: 'till', current: 'till', rolesAllowed: ['kiosk'], switchLabel: 'מעבר לקיוסק' },
    tileText: { fit: 'wrap', maxLines: 3, minSize: 's', infoBadge: 'auto' },
    held: {
      count: 4,
      keepAllowed: true,
      sales: Array.from({ length: 4 }, (_, i) => ({
        id: `h${i + 1}`,
        label: i === 0 ? 'שולחן 12 — משפחת כהן־אברהמי, חוגגים יום הולדת' : i === 1 ? 'Mr. Johnson — takeaway' : null,
        at: iso(20 + i * 7),
        cashier: 'אלכסנדרה בן־דוד',
        itemCount: 3 + i * 4,
        totalAgorot: i === 0 ? 9_999_990 : 4_590 * (i + 1),
        items: lines(4 + i).map((x) => ({ name: x.name, quantity: x.qty })),
      })),
    },
    oth: { enabled: true, requiresManager: true, reasons: ['אורח VIP', 'פיצוי על עיכוב בהגשה', 'טעות במטבח — מנה הוחלפה', 'ארוחת צוות'] },
    drawer: {
      offered: { open: true, cashIn: true, cashOut: true, deposit: true, count: true, walletDeposit: true, log: true, remote: true },
      hosts: [{ id: 'm-2', label: 'בר — קופה 2 (ליד הכניסה)' }, { id: 'm-3', label: 'Terrace till 3' }],
      requireReason: true,
      requireNoteForOther: true,
      movementsEnabled: true,
      blindCount: false,
      reasons: [
        { code: 'change', label: 'פריטת כסף ללקוח' },
        { code: 'tip', label: 'משיכת טיפים לצוות' },
        { code: 'supplier', label: 'תשלום לספק במזומן' },
        { code: 'other', label: 'אחר' },
      ],
      count: { blind: false, expectedAgorot: 9_999_990, result: { countedAgorot: 9_998_890, expectedAgorot: 9_999_990, varianceAgorot: -1_100 } },
    },
    users: {
      notice: 'אלכסנדרה בן־דוד מחוברת גם בקופה 3 (טרסה) — תנותק שם בסוף הפעולה',
      offered: true,
      busy: false,
      error: null,
      list: {
        at: NOW,
        sessions: [
          { id: 's1', posUserId: 'u1', posUserName: 'אלכסנדרה בן־דוד', machineName: 'קופה 1 — דלפק ראשי', posNumber: '1', startedAt: iso(300), lastSeenAt: iso(1), silentSince: null, openTables: 0, here: true },
          { id: 's2', posUserId: 'u2', posUserName: 'Jonathan Livingston-Smith', machineName: 'Terrace till 3', posNumber: '3', startedAt: iso(200), lastSeenAt: iso(40), silentSince: iso(35), openTables: 4, here: false },
        ],
      },
    },
    owed: { items: [{ id: 'o-1', line: 'עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57 (משפחת כהן־אברהמי): 139.90 ₪', amountAgorot: 13_990 }] },
    printQueue: { banner: '3 בונים לא הודפסו במדפסת המטבח — יש לטפל', count: 3, redirects: [{ fromId: 'pr-bar', text: '«בר» נשלחת ל«מטבח ראשי» עד 14:20' }] },
    terminalOffline: { text: 'המסוף עובד במצב לא מקוון (עסקאות נשמרות לשידור)\nלא ניתן לשלם בכרטיס דביט / דיירקט / כרטיס זר כרגע', tone: 'amber' },
    order: { dining: 'take_away', name: 'Jonathan', strip: 'לקחת  ·  Jonathan', configured: true, ask: null },
    shopX: { offered: true, report: null, at: null, busy: false, error: null },
    // "קיוסקים": two kiosks this till controls, one locked, one with an unprinted bon and an alert.
    kiosks: {
      busy: false,
      note: { text: 'נשלח לקיוסק — יבוצע כשאין תשלום פתוח', ok: true },
      rows: kioskControlRows([
        { machineId: 'k1', name: 'קיוסק כניסה ראשית — Main Entrance Kiosk A', online: true, flowState: 'ordering', ordersToday: 1234, salesTodayAgorot: 9_999_990, printerStatus: 'ok', bonPrinter: 'error', unprintedBons: 2, unprintedOrders: [{ localId: 'l1', label: '57' }], alerts: [{ kind: 'terminal', text: 'המסופון לא מגיב מזה 5 דקות' }], shiftOpen: true, zMode: 'cloud', areaName: 'נקודת מכירה מרכזית — Main Food Court', tillMode: { mode: 'kiosk', tillSwitch: true, blockedText: 'יש הזמנה בתשלום בקיוסק' } },
        { machineId: 'k2', name: 'קיוסק טרסה', online: false, lastSeenAt: iso(40), paused: true, pausedBy: 'Jonathan Livingston-Smith', pausedAt: iso(30), pausedUntil: null, ordersToday: 0, salesTodayAgorot: 0, shiftOpen: false, zMode: 'till' },
      ]),
    },
    // "תפריט" (core/till/tillMenu.ts): the profile card, the sync, a release ready, the reports folder.
    menu: {
      roleName: 'מנהלת משמרת — Senior Shift Manager',
      shopName: 'רויאל בר — סניף הרצליה פיתוח (מתחם הקניון)',
      posNumber: '12',
      identity: [
        { label: 'חברה', value: 'רויאל בר בע״מ — Royal Bar Holdings Ltd.' },
        { label: 'סניף', value: 'רויאל בר — סניף הרצליה פיתוח (מתחם הקניון)' },
        { label: 'מספר קופה', value: '12' },
        { label: 'שם קופה', value: 'קופה 12 — דלפק ראשי (Main Counter)' },
        { label: 'גרסה', value: '0.5.11' },
      ],
      sync: { running: false, lastAt: '2026-10-16 12:28', error: null, waiting: 3 },
      update: { version: '0.5.12', phase: 'ready', message: null },
      showTillZHistory: true,
      support: true,
      report: null,
    },
    // Phase 2 (P:/specs/windows-till-menu-parity.md §7): every module's slice, so its row and its screen show.
    menuOffers: { shopZ: true, cloudZ: true },
    catalogAdmin: P2.catalogAdmin,
    shopZ: P2.shopZ,
    attendance: P2.attendanceQuiet,
    readyOrders: P2.readyOrders,
    alerts: P2.alerts,
    voucherBalance: P2.voucherBalance,
    voucherStation: { ...P2.voucherStation, active: false, menu: { label: 'חזרה לעמדת שובר' } },
    cloudZ: P2.cloudZ,
    printers: P2.printers,
    screenEdit: P2.screenEditOff,
    kioskOrders: P2.kioskOrders(),
    transmission: {
      supported: true,
      deferredSupported: true,
      offline: { reading: false, failed: false, status: { allowed: true, working: true, readAt: NOW - 60_000 }, stateLine: 'המסוף במצב לא מקוון מאז 11:42', limitsLine: 'תקרה לעסקה: 1,000 ₪ · נותרו 37 עסקאות', switching: false },
      pendingLine: '12 עסקאות ממתינות לשידור (4,321.50 ₪)',
      neverTransmitted: false,
      lastFailed: 'שידור אחרון נכשל ב-09:12: אין תקשורת לחברת האשראי',
      running: false,
      message: null,
      history: {
        rows: Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, at: iso(60 * (i + 1)), status: i === 1 ? 'נכשל' : 'הצליח', tone: i === 1 ? ('error' as const) : ('ok' as const), trigger: i % 2 ? 'אוטומטי (סוף יום)' : 'ידני', facts: ['42 עסקאות', '9,999.90 ₪', 'מסוף 0881234'], detail: i === 1 ? 'Timeout waiting for the card company host (code 51)' : null, unsynced: i === 0 })),
        total: 8,
        error: null,
        loading: false,
        more: true,
      },
    },
  };
}

function checkout(s: TillState, over: Partial<TillState['checkout']>): TillState {
  const total = s.sell.totalAgorot;
  return { ...s, checkout: { phase: 'tender', totalAgorot: total, paidAgorot: 0, dueAgorot: total, changeAgorot: 0, legs: [], documentRef: null, ...over } };
}

/** `?state=`: the screen the till opens on (the menu's screens are reached from `sell` by the audit's taps). */
export function stateFor(name: string): TillState {
  const s = richState();
  switch (name) {
    case 'lock':
      return { ...s, session: { ...s.session, cashier: null, locked: true } };
    case 'sell-empty':
      return { ...s, sell: { ...s.sell, lines: [], itemCount: 0, totalAgorot: 0, vatAgorot: 0, basketDiscount: null }, users: { ...s.users!, notice: null }, terminalOffline: undefined, printQueue: undefined, owed: undefined };
    case 'refund-mode':
      return { ...s, sell: { ...s.sell, refundMode: true, refundChooser: true } };
    case 'pay':
      return checkout(s, {});
    case 'pay-split':
      return checkout(s, { paidAgorot: 5_000_000, dueAgorot: s.sell.totalAgorot - 5_000_000, tenderedAgorot: 5_000_000, legs: [{ method: 'cash', amountAgorot: 5_000_000, status: 'approved' }, { method: 'card', amountAgorot: 2_500_000, status: 'approved' }, { method: 'cash_credit', amountAgorot: 13_990, status: 'approved', credit: { code: 'CC:7F3A-91B2', redemptionId: 'r1' } }], deferredNotice: 'המסוף עובד במצב לא מקוון — בתשלום באשראי: לא ניתן לשלם בכרטיס דביט / דיירקט / כרטיס זר כרגע' });
    case 'pay-card':
      return checkout(s, { phase: 'card_waiting', cardStatus: 'הצמד, הכנס או העבר את הכרטיס במסוף (99,999.90 ₪)', legs: [{ method: 'card', amountAgorot: s.sell.totalAgorot, status: 'pending' }] });
    case 'pay-card-unknown':
      return checkout(s, { cardError: 'המסוף לא ענה — לא ידוע אם העסקה עברה. אל תחייבו שוב לפני בדיקה.', cardUnknown: true });
    case 'pay-vouchers':
      return checkout(s, {
        vouchers: {
          items: [
            { id: 'v1', kind: 'production', label: 'שובר #12 · ארוחת צהריים לעובדים — Annual Company Conference 2026', what: '2 פריטים: המבורגר, שתייה', amountAgorot: 12_990, test: false },
            { id: 'v2', kind: 'discount', label: 'שובר הנחה 15% — לקוחות מועדון', what: 'על כל ההזמנה', amountAgorot: 1_499_998, test: true },
          ],
          testBar: 'מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם',
          testDue: 'יתרה לתשלום אחרי השוברים: 98,487.02 ₪',
          entitlement: 'הלקוח זכאי לעוד פריט מהשובר: קינוח לבחירה או שתייה חמה',
          busy: false,
          applied: 'השובר הוחל: שובר #12 · ארוחת צהריים לעובדים',
          error: null,
          autoApply: true,
          deductionAgorot: 12_990,
          goodsValueAgorot: 3_400,
        },
        legs: [{ method: 'production_voucher', amountAgorot: 12_990, status: 'approved', voucher: { serial: 12 } }],
      });
    case 'pay-return':
      return checkout(s, { basket: { saleAgorot: 9_999_990, refundAgorot: 30_000, netAgorot: 9_969_990, payoutAgorot: 0, hasUnlinked: true, step: 'return_customer', customer: { name: '', phone: '', address: '', required: true }, payoutRoute: 'unlinked' } });
    case 'pay-payout':
      return checkout(s, { totalAgorot: -30_000, dueAgorot: -30_000, basket: { saleAgorot: 0, refundAgorot: 30_000, netAgorot: -30_000, payoutAgorot: 30_000, hasUnlinked: false, step: 'payout', customer: { name: 'ישראל ישראלי', phone: '050-1234567', address: 'רחוב הרצל 123, דירה 45, תל אביב-יפו', required: true }, payoutRoute: 'linked' } });
    case 'pay-done':
      return checkout(s, {
        phase: 'done',
        paidAgorot: s.sell.totalAgorot + 7_100,
        dueAgorot: 0,
        changeAgorot: 7_100,
        tenderedAgorot: s.sell.totalAgorot + 7_100,
        legs: [{ method: 'cash', amountAgorot: s.sell.totalAgorot + 7_100, status: 'approved' }],
        documentRef: 'חשבונית מס קבלה 40000123',
        documentRefs: ['חשבונית מס קבלה 40000123', 'תעודת זיכוי 50000017'],
        askPrint: true,
        printWarning: 'קבלה: המדפסת POS-80 לא מחוברת (USB) — הקבלה נשמרה ותודפס כשתחזור',
        kitchenWarning: 'פריטים שלא נותבו למדפסת: Double Smash Burger with Caramelized Onions, קפה הפוך גדול',
        voucherSuccess: { title: 'השובר מומש בהצלחה', detail: 'שובר #12 · 2 פריטים: המבורגר, שתייה', notTaken: 'הלקוח לא לקח: קינוח לבחירה (נשאר בשובר)', note: null },
      });
    case 'dialog':
      return {
        ...s,
        dialog: {
          id: 'dlg1',
          kind: 'manager_approval',
          title: 'נדרש אישור מנהל — הנחה מעל 20% על שורה',
          body: 'הנחה של 35% על "Double Smash Burger with Caramelized Onions, Aged Cheddar & Truffle Mayo" חורגת מההרשאה של הקופאי. הקלידו קוד מנהל כדי לאשר.',
          fields: [{ name: 'pin', label: 'קוד מנהל', kind: 'pin' }, { name: 'note', label: 'סיבה (תופיע בדוח)', kind: 'text' }, { name: 'all', label: 'להחיל על כל השורות בסל', kind: 'check' }],
          actions: [{ id: 'cancel', label: 'ביטול' }, { id: 'ok', label: 'אישור ההנחה', primary: true }],
          expiresAt: NOW + 60_000,
        },
      };
    case 'notice':
      return { ...s, notice: { title: 'סגירה אוטומטית במשמרת הקודמת', text: 'הסל שנשאר פתוח במשמרת 1286 (12 פריטים, 9,999.90 ₪) הועבר למכירות בהמתנה בשם "סל פתוח מ-03:12". 2 מכירות בהמתנה בוטלו אחרי 24 שעות.' } };
    case 'attendance':
      return { ...s, attendance: P2.attendance };
    case 'station':
      return { ...s, voucherStation: P2.voucherStation };
    case 'screen-edit':
      return { ...s, screenEdit: P2.screenEditOn };
    case 'order-ask':
      return { ...s, order: { ...s.order!, ask: { purpose: 'start', dining: true, name: true, confirmLabel: 'התחלת הזמנה' } } };
    case 'sell':
    default:
      return s;
  }
}

function historyRows() {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `doc${i + 1}`,
    ref: i % 6 === 1 ? `תעודת זיכוי ${50000017 + i}` : `חשבונית מס קבלה ${40000123 + i}`,
    totalAgorot: i === 0 ? 9_999_990 : i % 6 === 1 ? -(1_200 + i * 37) : 1_200 + i * 731,
    at: iso(i * 11),
    cashier: i % 3 ? 'אלכסנדרה בן־דוד' : 'Jonathan Livingston-Smith',
    methods: (i % 2 ? ['cash'] : ['card', 'cash']) as Array<'cash' | 'card'>,
    documentType: i % 6 === 1 ? 330 : 320,
    status: i % 9 === 3 ? 'cancelled' : 'final',
  }));
}

function detail(id: string): DocumentDetail {
  const l = lines(14);
  return {
    id,
    ref: 'חשבונית מס קבלה 40000123',
    documentType: 320,
    status: 'final',
    totalAgorot: 9_999_990,
    cashier: 'אלכסנדרה בן־דוד',
    at: iso(30),
    methods: ['card', 'cash'],
    lines: l.map((x, i) => ({ itemId: `it${i}`, productId: x.productId, name: x.name, originalQty: x.qty, remainingQty: Math.max(0, x.qty - (i % 2)), unitNetAgorot: x.unitAgorot })),
    isRefundDocument: false,
    anythingRefundable: true,
    refundMethod: 'card',
    refundAllAgorot: 9_999_990,
  };
}

function xReport(): XReport {
  return {
    shiftNumber: 1287,
    salesCount: 214,
    salesAgorot: 9_999_990,
    cashAgorot: 4_567_890,
    cardAgorot: 5_432_100,
    expectedCashAgorot: 4_617_890,
    demo: false,
    openingCashAgorot: 50_000,
    discountsAgorot: 123_450,
    refundsAgorot: 30_000,
    vatAgorot: 1_525_422,
    tipsAgorot: 99_990,
    itemsCount: 1_234,
    cashInAgorot: 10_000,
    cashOutAgorot: 5_000,
    depositsAgorot: 4_000_000,
    walletInAgorot: 12_000,
    walletDepositsAgorot: 9_000,
    vouchersAgorot: 12_990,
    voucherInfo: [{ label: 'שוברי הפקה', value: '', title: true }, { label: 'שובר #12 · ארוחת צהריים לעובדים — Annual Company Conference 2026', value: '37 פריטים · 2,345.00 ₪' }],
    // "מזומן במגירה" (x-z-cash-with-tips): every line of the block, the drawer short (red) after paying all the card tips.
    cardTipsFromDrawerAgorot: 9_999_990,
    cardTipsUnpaidAgorot: 0,
    drawerCashAgorot: -5_432_100,
    cashBlock: drawerOf({
      opening: 50_000,
      cashSales: 4_567_890,
      cashTips: 99_990,
      cardTips: 9_999_990,
      movements: { cashIn: 10_000, cashOut: 5_000, deposits: 4_000_000 },
      wallet: { walletIn: 12_000, walletDeposits: 9_000 },
      between: 0,
      param: true,
      shortfall: 'negative',
    }).lines.map((l) => ({ key: l.key, label: l.label, amountAgorot: l.agorot, bold: l.bold, warn: l.warn })),
  };
}

const blockRow = (i: number) => ({
  id: `b${i}`,
  kind: i % 2 ? ('blocked' as const) : ('sold_out' as const),
  words: {
    pill: i % 2 ? 'חסום' : 'אזל',
    name: i === 0 ? 'מחלקה · מנות עיקריות מיוחדות של השף' : LONG[i % LONG.length],
    level: i % 3 ? 'סניף · סניף הרצליה פיתוח — מתחם הקניון' : 'קופה · קופה 1',
    channels: 'קופה · קיוסק · אונליין · תפריט דיגיטלי',
    kiosk: i % 2 ? 'מוסתר בקיוסק' : 'באפור בקיוסק',
    auto: i === 2 ? 'אוטומטי — מלאי 0' : null,
    meta: 'עד 23:59 · ע״י אלכסנדרה בן־דוד · מהדשבורד',
    note: i === 1 ? '“הספק לא הגיע — לבדוק שוב מחר בבוקר”' : null,
  },
  releasable: i !== 3,
  wide: i === 4,
  why: i === 3 ? 'רק מנהל נקודת מכירה יכול לשחרר חסימה ברמת נקודת מכירה' : null,
});

/** The menu's local reports, long names and big sums (core/till/localReports.ts). */
function localReport(kind: string, preset: string): LocalReportView {
  const ranged = kind === 'products' || kind === 'workers' || kind === 'tips';
  const p = (ranged ? preset : null) as LocalReportView['preset'];
  if (kind === 'tillZs') {
    return {
      kind: 'tillZs',
      title: 'דוחות Z',
      subtitle: null,
      preset: null,
      empty: null,
      sections: [{ title: null, rows: Array.from({ length: 8 }, (_, i) => ({ label: `Z ${412 - i}`, value: `${16 - i}/10/2026 23:5${i}`, sub: 'הודפס', reprintZ: `z${i}` })) }],
    };
  }
  if (kind === 'shifts') {
    return {
      kind: 'shifts',
      title: 'היסטוריית משמרות',
      subtitle: null,
      preset: null,
      empty: null,
      sections: [
        {
          title: null,
          rows: Array.from({ length: 8 }, (_, i) => ({
            label: `משמרת #${1287 - i} · ${i === 0 ? 'פתוחה' : `בדוח Z ${412 - i}`}`,
            value: '99,999.90 ₪',
            sub: `16/10/2026 08:0${i}–16:1${i} · נפתחה ע״י ${LONG[i % LONG.length]} · 214 מסמכים`,
            tone: i === 0 ? ('ok' as const) : null,
          })),
        },
      ],
    };
  }
  return {
    kind: kind as LocalReportView['kind'],
    title: kind === 'workers' ? 'דוח לפי עובד' : kind === 'tips' ? 'דוח תשר' : 'מכירות לפי מוצר',
    subtitle: 'היום · 16/10/2026',
    preset: p,
    empty: null,
    sections: [
      { title: null, rows: [{ label: 'מכירות', value: '99,999.90 ₪' }, { label: 'זיכויים', value: '−1,234.50 ₪' }, { label: 'נטו', value: '98,765.40 ₪', emphasis: true }] },
      { title: kind === 'workers' ? 'אלכסנדרה בן־דוד' : 'מכירות לפי מוצר', rows: Array.from({ length: 10 }, (_, i) => ({ label: LONG[i % LONG.length], value: `${9_999 - i * 37}.90 ₪`, sub: `${120 - i} יחידות` })) },
    ],
  };
}

/** The engine: the state of `?state=`, and every list a screen asks for. Nothing changes, nothing is sent. */
export class AuditEngine implements EngineEndpoint {
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private st: TillState;
  private seq = 1;
  readonly catalog = P2.withChoices(stressCatalog());

  constructor(state: string) {
    const s = stateFor(state);
    // "עיצוב קופה" as the demo takes it: /tillAudit.html?state=sell&design=night&accent=%23E11D48&mode=dark.
    const cfg = typeof location !== 'undefined' ? demoDesignConfig(location.search) : null;
    this.st = cfg ? { ...s, design: withTotal(demoDesignState(cfg, true), s.sell.totalAgorot), theme: themeOf(cfg, {}, {}) } : s;
  }

  hello(): HelloReply {
    return { protocol: TILL_PROTOCOL, seq: 1, state: JSON.parse(JSON.stringify(this.st)) as TillState };
  }

  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  async call(c: EngineCall): Promise<EngineReply> {
    return { id: c.id, ok: true, value: this.answer(c.op, (c.args ?? {}) as Record<string, unknown>) };
  }

  private answer(op: string, a: Record<string, unknown>): unknown {
    switch (op) {
      case 'report.local': {
        // The menu's local reports: put in the state, as the engine does (the screen draws `menu.report`).
        const report = localReport(String(a.kind ?? 'products'), typeof a.preset === 'string' ? a.preset : 'today');
        if (this.st.menu) this.st = { ...this.st, menu: { ...this.st.menu, report } };
        const state = JSON.parse(JSON.stringify(this.st)) as TillState;
        queueMicrotask(() => this.listeners.forEach((fn) => fn({ ev: 'state', seq: ++this.seq, data: state })));
        return undefined;
      }
      case 'catalog.snapshot':
        return JSON.parse(JSON.stringify(this.catalog)) as Catalog;
      case 'doc.history':
        return historyRows();
      case 'doc.detail':
        return detail(String(a.documentId ?? 'doc1'));
      case 'report.x':
        return xReport();
      case 'report.shopX':
        return {
          title: 'דוח X סניפי',
          businessName: 'רויאל בר — סניף הרצליה פיתוח (מתחם הקניון, קומה 2)',
          subtitle: 'נכון ל-16.10.2026 12:30 · 4 קופות',
          sections: [
            { title: 'מכירות', rows: [{ label: 'סה״כ מכירות כולל מע״מ', value: '9,999,999.90 ₪', emphasis: true }, { label: 'מספר עסקאות', value: '12,345', emphasis: false }, { label: 'Average basket (incl. VAT)', value: '810.04 ₪', emphasis: false }] },
            { title: 'אמצעי תשלום', rows: [{ label: 'אשראי', value: '5,432,100.00 ₪', emphasis: false }, { label: 'מזומן', value: '4,567,899.90 ₪', emphasis: false }] },
          ],
          footer: 'דוח זה אינו מסמך חשבונאי',
        };
      case 'refund.recent':
        return historyRows().slice(0, 12).map((r) => ({ transactionId: r.id, number: r.ref.replace(/\D+/g, ''), at: r.at, documentType: r.documentType ?? 320, totalAgorot: r.totalAgorot }));
      case 'refund.find':
      case 'refund.pick': {
        const d = detail('doc1');
        return { document: { transactionId: 'doc1', number: '40000123', at: d.at, documentType: 320, totalAgorot: d.totalAgorot }, lines: d.lines };
      }
      case 'blocks.list':
        return { live: true, banner: 'אין חיבור יציב — חלק מהחסימות מוצגות מהקטלוג השמור', rows: Array.from({ length: 6 }, (_, i) => blockRow(i)), mayBlock: true };
      case 'blocks.sheet':
        return {
          title: 'חסימת פריט: Double Smash Burger with Caramelized Onions, Aged Cheddar & Truffle Mayo',
          productId: 'p2',
          categoryId: 'd2',
          live: true,
          banner: null,
          rows: [blockRow(1)],
          releaseAll: 1,
          mayBlock: true,
          what: [{ v: 'product', label: 'Double Smash Burger with Caramelized Onions', id: 'p2' }, { v: 'category', label: 'מחלקה · Chef’s Specials & Signature Dishes', id: 'd2' }],
          channels: [{ v: 'pos', label: 'קופה', access: 'open' }, { v: 'kiosk', label: 'קיוסק', access: 'open' }, { v: 'online', label: 'הזמנות אונליין', access: 'approval' }, { v: 'menu', label: 'תפריט דיגיטלי', access: 'locked_permission' }],
          levels: [{ v: 'machine', label: 'הקופה הזו', access: 'open' }, { v: 'area', label: 'נקודת מכירה — טרסה ובר', access: 'approval' }, { v: 'shop', label: 'כל הסניף', access: 'approval' }, { v: 'event', label: 'אירוע', access: 'locked_till' }],
          devices: [{ id: 'm1', label: 'קופה 1 — דלפק ראשי', access: 'open' }, { id: 'm2', label: 'קיוסק כניסה (Kiosk A)', access: 'approval' }],
          events: [{ id: 'e1', name: 'אירוע חברה — Annual Conference 2026' }],
          defaults: { channels: ['pos', 'kiosk'], level: 'machine', kind: 'sold_out' },
          notes: ['חסימה ברמת סניף מחייבת אישור מנהל', 'Blocked items stay hidden in the kiosk until released'],
          machineId: 'm1',
        };
      case 'printQueue.list':
        return {
          rows: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, title: `בון ${700 + i} · שולחן 12 · ${LONG[i]}`, printer: i % 2 ? 'מטבח ראשי (Epson TM-T88VI, 192.168.1.80)' : 'בר', state: i === 0 ? 'נכשל' : 'ממתין', error: i === 0 ? 'המדפסת לא עונה (timeout 10s) — נייר / חיבור' : null, at: NOW - i * 60_000, canMove: i !== 4 })),
          view: { redirects: [{ fromId: 'pr-bar', text: '«בר» נשלחת ל«מטבח ראשי» עד 14:20' }] },
        };
      case 'printQueue.choices':
        return [{ id: 'pr-k', label: 'מטבח ראשי' }, { id: 'pr-b', label: 'בר' }];
      case 'drawer.log':
        return {
          events: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, at: iso(i * 13), eventType: i % 3 ? 'OPEN_MANUAL' : 'OPEN_SALE', result: i === 2 ? 'denied' : 'ok', employeeName: 'אלכסנדרה בן־דוד', approverName: i % 4 ? null : 'Jonathan Livingston-Smith', reason: i % 3 ? 'פריטת כסף ללקוח — שטר של 200' : null, amountAgorot: i % 2 ? 9_999_990 : null })),
          movements: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, at: iso(i * 29), type: ['CASH_IN', 'CASH_OUT', 'DEPOSIT'][i % 3], amountAgorot: 9_999_990 - i * 1000, varianceAgorot: i === 2 ? -1_100 : null, employeeName: 'אלכסנדרה בן־דוד', reason: 'תשלום לספק במזומן — ירקות טריים' })),
        };
      case 'drawer.wallets':
        return { offline: false, wallets: [{ employeeId: 'u2', employeeName: 'Jonathan Livingston-Smith', balanceAgorot: 9_999_990, accruals: 14 }, { employeeId: 'u3', employeeName: 'מרים אבוטבול־שטרנברג', balanceAgorot: 45_000, accruals: 3 }] };
      case 'discount.preview':
        return { amountAgorot: 1_499_998, newTotalAgorot: 8_499_992, text: 'הנחה של 15% · חוסך 14,999.98 ₪' };
      default:
        return undefined;
    }
  }
}
