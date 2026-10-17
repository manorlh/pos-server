/**
 * "הזמנות קיוסק לתשלום" — a kiosk order the customer pays at the till (pos-server docs/SPEC_KIOSK.md §23,
 * services/kiosk_open_orders.py; pos-android data/repo/KioskPayAtTill.kt `KioskPayAtTillTill`, domain/KioskPayAtTill.kt
 * `KioskOpenOrderView` / `KioskOpenOrders` / `KioskOpenOrderCode`, ui/sell/KioskOpenOrdersUi.kt), the pure part:
 *
 *  - the cloud's list (`GET /sync/{m}/kiosk/open-orders`, already narrowed to this till's point of sale by the area lock),
 *    each order as the till lists it: number, name · kiosk, service · items · how long ago, what is left to pay ("שובר: …"),
 *    the lines, "בטיפול ב…" when another till holds it;
 *  - the kiosk's basket (`cart.codec`, the Android held-sale codec both kiosks write — client lib/kioskWebOrders.ts
 *    heldSaleCodec) decoded line for line: the product, the quantity, the dish's own price as the kiosk took it, its choices,
 *    a meal's components, the notes, "חשוב", the allergies — the till prices it as it prices any line;
 *  - the vouchers the kiosk redeemed towards it (pending on the order): legs of the till's document, taken first;
 *  - what the cashier reads when an order cannot be opened, cancelled, or is already gone;
 *  - the slip's code ("KO:" and the kiosk's order id) scanned on the sell screen.
 *
 * Pure (test/tillKioskOrders.test.ts).
 */

import { cleanAllergies, cleanNotes, type LineChoices, type LineComponent, type LineOption } from './choices';

/** The Android strings (strings.xml `kpay_till_*`), word for word. */
export const KPAY_TEXT = {
  badge: (n: number) => `הזמנות קיוסק ממתינות לתשלום (${n})`,
  openList: 'פתיחה',
  menu: 'הזמנות קיוסק לתשלום',
  menuSub: (n: number) => `${n} ממתינות`,
  listTitle: 'הזמנות קיוסק ממתינות לתשלום',
  empty: 'אין הזמנות ממתינות',
  kiosk: 'קיוסק',
  items: (n: number) => `${n} פריטים`,
  age: (m: number) => `לפני ${m} דק׳`,
  ageNow: 'עכשיו',
  voucherNote: (s: string) => `שובר: ${s}`,
  lockedBy: (by: string) => `בטיפול ב${by}`,
  viaLan: 'התקבלה ברשת המקומית',
  pay: 'לתשלום',
  cancel: 'ביטול הזמנה',
  close: 'סגירה',
  ok: 'הבנתי',
  cancelTitle: (label: string) => `ביטול הזמנה ${label}`,
  cancelBody: 'ההזמנה תוסר מהרשימה, ושוברים שמומשו בה יחזרו ללקוח. נדרשת סיבה.',
  cancelReason: 'סיבת הביטול',
  cancelConfirm: 'ביטול ההזמנה',
  cancelDone: (label: string) => `הזמנה ${label} בוטלה`,
  reasonLeft: 'הלקוח ויתר',
  reasonDouble: 'הזמנה כפולה',
  reasonChanged: 'הלקוח הזמין מחדש בקופה',
  basketBusy: 'יש לסיים או להשהות את הסל הנוכחי לפני תשלום הזמנת קיוסק',
  notFound: 'ההזמנה לא נמצאה',
  closed: 'ההזמנה כבר נסגרה',
  paidBy: (by: string) => `ההזמנה כבר שולמה (${by})`,
  cancelled: 'ההזמנה בוטלה',
  expired: 'פג תוקף ההזמנה — לא שולמה בזמן',
  offline: 'אין חיבור לענן — נסו שוב',
  failed: (status: number) => `הפעולה נכשלה (${status})`,
  areaLocked: 'ההזמנה שייכת לנקודת מכירה אחרת. הקופה נעולה לנקודת המכירה שלה.',
  eatIn: 'לשבת',
  takeAway: 'לקחת',
  /** The Windows till's own: a line of the order this till does not sell (the catalog or its menu dropped it). */
  notSoldHere: (names: string) => `אי אפשר לשלם את ההזמנה בקופה הזו: ${names} אינו נמכר כאן`,
} as const;

/** The slip's barcode prefix (KioskOpenOrderCode.PREFIX). */
export const SLIP_PREFIX = 'KO:';

export type OpenState = 'open' | 'paid' | 'cancelled' | 'expired';

/** A voucher the kiosk redeemed towards the order (KioskVoucherLeg): a leg of the till's document. */
export interface KioskVoucherLeg {
  redemptionId: string;
  serial: number;
  amountAgorot: number;
  eventName: string | null;
  includeExtras: boolean;
}

/** One order as the till keeps it from the cloud's list (KioskOpenOrderView.fromCloud). */
export interface KioskOpenOrder {
  id: string;
  localId: string;
  kioskName: string | null;
  state: OpenState;
  pickupLabel: string;
  customerName: string | null;
  service: 'take_away' | 'eat_in' | null;
  tableRef: string | null;
  itemCount: number;
  totalAgorot: number;
  tipAgorot: number;
  voucherAgorot: number;
  dueAgorot: number;
  lines: Array<{ name: string; quantity: number; totalAgorot: number; notes: string | null }>;
  cartCodec: string | null;
  fulfillment: 'BON' | 'KDS';
  vouchers: KioskVoucherLeg[];
  kitchenSent: boolean;
  createdAtMs: number | null;
  lockedBy: string | null;
  lockedByMe: boolean;
  paidBy: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v !== 'null' ? v : null);
const int = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);

export function stateOf(v: unknown): OpenState {
  return v === 'paid' || v === 'cancelled' || v === 'expired' ? v : 'open';
}

/** One order of the cloud's answer; null when it names no order. */
export function orderOf(raw: unknown): KioskOpenOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  const cart = o.cart && typeof o.cart === 'object' ? (o.cart as Record<string, unknown>) : null;
  const total = int(o.totalAgorot);
  const tip = int(o.tipAgorot);
  const created = str(o.createdAt);
  const createdMs = created ? Date.parse(created) : NaN;
  const fulfillment = (str(o.fulfillmentMode) ?? str(cart?.fulfillment)) === 'KDS' ? 'KDS' : 'BON';
  return {
    id,
    localId: str(o.localId) ?? id,
    kioskName: str(o.kioskName),
    state: stateOf(o.state),
    pickupLabel: str(o.pickupLabel) ?? String(int(o.pickupNumber)),
    customerName: str(o.customerName),
    service: o.serviceType === 'eat_in' || o.serviceType === 'take_away' ? o.serviceType : null,
    tableRef: str(o.tableRef),
    itemCount: int(o.itemCount),
    totalAgorot: total,
    tipAgorot: tip,
    voucherAgorot: int(o.voucherAgorot),
    dueAgorot: typeof o.dueAgorot === 'number' ? int(o.dueAgorot) : total + tip,
    lines: (Array.isArray(o.lines) ? o.lines : []).flatMap((l) => {
      if (!l || typeof l !== 'object') return [];
      const r = l as Record<string, unknown>;
      const name = str(r.name);
      return name ? [{ name, quantity: typeof r.quantity === 'number' ? r.quantity : 1, totalAgorot: int(r.totalAgorot), notes: str(r.notes) }] : [];
    }),
    cartCodec: str(cart?.codec),
    fulfillment,
    vouchers: (Array.isArray(o.vouchers) ? o.vouchers : []).flatMap((v) => {
      if (!v || typeof v !== 'object') return [];
      const r = v as Record<string, unknown>;
      const redemptionId = str(r.redemptionId);
      if (!redemptionId) return [];
      return [{ redemptionId, serial: int(r.serial), amountAgorot: Math.max(0, int(r.amountAgorot)), eventName: str(r.eventName), includeExtras: r.includeExtras === true }];
    }),
    kitchenSent: o.kitchenSent === true,
    createdAtMs: Number.isFinite(createdMs) ? createdMs : null,
    lockedBy: str(o.lockedBy),
    lockedByMe: o.lockedByMe === true,
    paidBy: str(o.paidBy),
  };
}

/** The cloud's `{orders: [...]}` (KioskOpenOrders.parse), oldest first. */
export function ordersOf(body: unknown): KioskOpenOrder[] {
  const list = body && typeof body === 'object' ? (body as { orders?: unknown }).orders : null;
  return (Array.isArray(list) ? list : [])
    .map(orderOf)
    .filter((o): o is KioskOpenOrder => !!o)
    .sort((a, b) => (a.createdAtMs ?? Number.MAX_SAFE_INTEGER) - (b.createdAtMs ?? Number.MAX_SAFE_INTEGER));
}

export const waiting = (o: Pick<KioskOpenOrder, 'state'>) => o.state === 'open';
/** Another till holds it ("בטיפול ב…"): not this till's to pay or cancel. */
export const heldElsewhere = (o: Pick<KioskOpenOrder, 'state' | 'lockedBy' | 'lockedByMe'>) => waiting(o) && !!o.lockedBy && !o.lockedByMe;
export const waitingCount = (list: readonly KioskOpenOrder[]) => list.filter(waiting).length;

/** The order a scan of the slip names (KioskOpenOrders.byCode): by the kiosk's id, or the cloud's. */
export function byCode(list: readonly KioskOpenOrder[], code: string): KioskOpenOrder | null {
  const c = code.trim().toLowerCase();
  return list.find((o) => o.localId.toLowerCase() === c || o.id.toLowerCase() === c) ?? null;
}

/** The order id in a scan of the slip ("KO:…"), or null (KioskOpenOrderCode.parse: CR and an AIM id cleaned first). */
export function slipCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\r\n\t]/g, '').replace(/^\][A-Za-z][0-9]/, '').trim();
  if (text.length <= SLIP_PREFIX.length || text.slice(0, SLIP_PREFIX.length).toUpperCase() !== SLIP_PREFIX) return null;
  const id = text.slice(SLIP_PREFIX.length).trim();
  return id && id.length <= 64 ? id : null;
}

/* ---------------------------------------------------------------- the list */

/** One order as the list draws it (OrderCard). */
export interface KioskOrderRow {
  id: string;
  label: string;
  title: string;
  sub: string;
  dueAgorot: number;
  voucherNote: string | null;
  linesText: string | null;
  lockedBy: string | null;
  /** "לתשלום" / "ביטול הזמנה" offered (not held by another till). */
  actionable: boolean;
}

export function rowOf(o: KioskOpenOrder, nowMs: number, money: (agorot: number) => string): KioskOrderRow {
  const age = o.createdAtMs === null ? 0 : Math.max(0, Math.floor((nowMs - o.createdAtMs) / 60_000));
  const service = o.service === 'eat_in' ? KPAY_TEXT.eatIn : o.service === 'take_away' ? KPAY_TEXT.takeAway : null;
  const qty = (q: number) => (Number.isInteger(q) ? String(q) : String(q));
  const lines = o.lines.slice(0, 6).map((l) => `${qty(l.quantity)}× ${l.name}`).join(' · ') + (o.lines.length > 6 ? ' …' : '');
  const held = heldElsewhere(o);
  return {
    id: o.id,
    label: o.pickupLabel,
    title: [o.customerName, o.kioskName].filter((x): x is string => !!x).join(' · ') || KPAY_TEXT.kiosk,
    sub: [service, KPAY_TEXT.items(o.itemCount), age < 1 ? KPAY_TEXT.ageNow : KPAY_TEXT.age(age)].filter((x): x is string => !!x).join(' · '),
    dueAgorot: o.dueAgorot,
    voucherNote: o.voucherAgorot > 0 ? KPAY_TEXT.voucherNote(money(o.voucherAgorot)) : null,
    linesText: o.lines.length > 0 ? lines : null,
    lockedBy: held ? KPAY_TEXT.lockedBy(o.lockedBy ?? '') : null,
    actionable: !held,
  };
}

/** What the screens draw (TillState.kioskOrders). */
export interface KioskOrdersState {
  /** Orders waiting to be paid: the strip on the sell screen and the menu row (none — neither). */
  waiting: number;
  rows: KioskOrderRow[];
  /** The order being opened now ("לתשלום" spinning). */
  busyId: string | null;
  /** The last answer the cashier must read ("הבנתי"). */
  notice: string | null;
  /** The order on the payment now. */
  active: { id: string; label: string } | null;
}

/** The ready reasons of "ביטול הזמנה" (CancelSheet), in Android's order. */
export const CANCEL_REASONS = [KPAY_TEXT.reasonLeft, KPAY_TEXT.reasonDouble, KPAY_TEXT.reasonChanged] as const;

/* --------------------------------------------------------------- refusals */

/** What the cashier reads when the cloud refused to lock an order (KioskPayAtTillTill.describe). */
export function lockRefusal(status: number, body: unknown): string {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (status === 404) return KPAY_TEXT.notFound;
  const detail = str(b.detail);
  if (detail === 'area_locked') return str(b.message) ?? KPAY_TEXT.areaLocked;
  if (detail === 'kiosk_order_locked') return KPAY_TEXT.lockedBy(str(b.lockedBy) ?? '');
  if (detail === 'kiosk_order_closed') {
    const st = stateOf(b.state);
    if (st === 'paid') return KPAY_TEXT.paidBy(str(b.paidBy) ?? '');
    if (st === 'cancelled') return KPAY_TEXT.cancelled;
    if (st === 'expired') return KPAY_TEXT.expired;
    return KPAY_TEXT.closed;
  }
  return KPAY_TEXT.notFound;
}

/** "ביטול הזמנה" refused (KioskPayAtTillTill.cancel). */
export function cancelRefusal(status: number, body: unknown): string {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const detail = str(b.detail);
  if (detail === 'kiosk_order_locked') return KPAY_TEXT.lockedBy(str(b.lockedBy) ?? '');
  if (detail === 'kiosk_order_closed') return KPAY_TEXT.closed;
  if (detail === 'area_locked') return str(b.message) ?? KPAY_TEXT.areaLocked;
  return KPAY_TEXT.failed(status);
}

/* ------------------------------------------------------------ the basket */

/** One line of the kiosk's basket as the till takes it in. */
export interface KioskBasketLine {
  productId: string;
  name: string;
  qty: number;
  /** The dish's own price as the kiosk took it (agorot): kept as the line's price, the choices priced on top by the till. */
  baseAgorot: number | null;
  choices: LineChoices | null;
}

const PRES = new Set(['lite', 'extra', 'side']);

function optionsOf(raw: unknown): LineOption[] {
  return (Array.isArray(raw) ? raw : []).flatMap((m) => {
    if (!m || typeof m !== 'object') return [];
    const r = m as Record<string, unknown>;
    const groupId = str(r.groupId);
    const optionId = str(r.optionId);
    if (!groupId || !optionId) return [];
    const qty = typeof r.qty === 'number' && r.qty >= 1 ? Math.round(r.qty) : 1;
    const pre = typeof r.pre === 'string' && PRES.has(r.pre) ? (r.pre as LineOption['pre']) : null;
    return [{ groupId, optionId, qty, pre }];
  });
}

/**
 * The kiosk's basket (HeldSaleCodec.decode + LineDetailsCodec.fromJson): each line's product, quantity, own price and
 * choices; null when there is none to rebuild (an order without its basket cannot be paid here: "ההזמנה לא נמצאה").
 */
export function decodeBasket(codec: string | null): KioskBasketLine[] | null {
  if (!codec) return null;
  let root: unknown;
  try {
    root = JSON.parse(codec);
  } catch {
    return null;
  }
  const lines = root && typeof root === 'object' ? (root as { lines?: unknown }).lines : null;
  if (!Array.isArray(lines)) return null;
  const out: KioskBasketLine[] = [];
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') return null;
    const l = raw as Record<string, unknown>;
    let product: Record<string, unknown> | null = null;
    try {
      product = typeof l.product === 'string' ? (JSON.parse(l.product) as Record<string, unknown>) : l.product && typeof l.product === 'object' ? (l.product as Record<string, unknown>) : null;
    } catch {
      product = null;
    }
    const productId = str(product?.cloudId) ?? str(product?.id);
    const qty = typeof l.quantity === 'number' ? Math.round(l.quantity) : NaN;
    if (!product || !productId || !(qty >= 1)) return null;
    const d = l.details && typeof l.details === 'object' ? (l.details as Record<string, unknown>) : null;
    const mealRaw = d?.meal && typeof d.meal === 'object' ? (d.meal as Record<string, unknown>) : null;
    const components: LineComponent[] = (Array.isArray(mealRaw?.components) ? (mealRaw!.components as unknown[]) : []).flatMap((c) => {
      if (!c || typeof c !== 'object') return [];
      const r = c as Record<string, unknown>;
      const slotId = str(r.slotId);
      const pid = str(r.productId);
      if (!slotId || !pid) return [];
      const options = optionsOf(r.modifiers);
      const times = typeof r.qty === 'number' && r.qty > 1 ? Math.round(r.qty) : 1;
      return Array.from({ length: times }, () => ({ slotId, productId: pid, ...(options.length > 0 ? { options } : {}) }));
    });
    const notes = cleanNotes([...(Array.isArray(d?.notes) ? (d!.notes as unknown[]) : []), d?.noteText, l.notes]);
    const choices: LineChoices | null = d
      ? {
          options: components.length > 0 ? [] : optionsOf(d.modifiers),
          notes,
          meal: components.length > 0 ? { components } : null,
          important: d.important === true,
          allergies: cleanAllergies(d.allergies),
        }
      : notes.length > 0
        ? { options: [], notes, meal: null, important: false, allergies: [] }
        : null;
    const base = typeof product.price === 'number' && Number.isFinite(product.price) ? Math.round(product.price) : null;
    out.push({ productId, name: str(product.name) ?? productId, qty, baseAgorot: base, choices });
  }
  return out.length > 0 ? out : null;
}

/** The kitchen ticket's headline and the order's name on the till: "A-17 · דנה" (KioskPayAtTillBon.headline's parts). */
export function orderNameOf(o: Pick<KioskOpenOrder, 'pickupLabel' | 'customerName'>): string | null {
  return [o.pickupLabel, o.customerName].filter((x): x is string => !!x && x.trim().length > 0).join(' · ') || null;
}

/* ------------------------------------------------------------ the reports */

/** A "paid" report kept until the cloud has it (KioskPayAtTillTill.queuePaidReport). */
export interface PaidReport {
  ref: string;
  transactionId: string;
  transactionNumber: string | null;
  by: string | null;
  paidAt: string;
  firstAt: number;
}

/** A report is done: the cloud took it, another document paid it first (409), or a 404 older than a day. */
export function reportDone(reply: { kind: 'ok' } | { kind: 'offline' } | { kind: 'refused'; status: number }, firstAt: number, nowMs: number): boolean {
  if (reply.kind === 'ok') return true;
  if (reply.kind === 'offline') return false;
  if (reply.status === 409) return true;
  return nowMs - firstAt > 24 * 60 * 60_000;
}
