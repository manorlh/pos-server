/**
 * The browser kiosk's orders (`/k`, docs/SPEC_KIOSK.md §23, §27): a browser cannot charge a card
 * (no pinpad on the LAN from a web page) and never writes a tax document, so every order it takes
 * is an OPEN order the shop's tills collect — "מזומן בקופה" — with the prepaid vouchers it redeemed
 * on the way (pending until the till is paid):
 *
 *  - the pickup number: the kiosk's own daily sequence (saved before it is shown), or the shop's
 *    from the cloud (3 s, else a local one tagged L), as the Windows kiosk (kiosk-desktop
 *    src/core/kioskOrders.ts);
 *  - the order as `POST /sync/{m}/kiosk/open-orders` takes it (server app/schemas/kiosk_open_orders.py),
 *    with the basket for the till to rebuild exactly: the till's held-sale form
 *    (pos-android domain/HeldSaleCodec.kt, LineDetailsCodec v1) in `cart.codec`;
 *  - the basket priced as the till will charge it (lib/kioskMoney.ts — the till's rules, ported once):
 *    each line's unit with its charged choices (or a meal's components), its share of the
 *    promotions; the till that collects prices it again with the same rules and the same promotions;
 *  - a voucher pays the goods it covers at the dish's own price (paid add-ons stay to be paid), net
 *    of the line's promotions, never the tip, never more than what is left (pos-android
 *    KioskPayRemainder, coverByVoucher / voucherCoverable);
 *  - the slip's code "KO:" + the order id — on the screen as a QR (a browser cannot print).
 *
 * Money is agorot (integers) throughout. Pure; no `@/` imports (the node tests compile it alone).
 */

/* ---------------------------------------------------------------- pickup */

export interface PickupRules {
  scope: 'kiosk' | 'shop';
  prefix: string;
  start: number;
  max: number;
  /**
   * "מספר הזמנה": with the letter ("A-17", the default) or the number alone ("17"). The number
   * alone comes with `scope: 'shop'` (the config's repair); a number drawn without the cloud keeps
   * its letter and the L tag ("AL-17") in either format, so it is never one of the shop's.
   */
  labelFormat?: 'prefixed' | 'number';
}

/** The next daily number: `start` on a new day, then +1, back to `start` after `max`. */
export function nextPickup(lastDate: string | null, last: number | null, today: string, rules: Pick<PickupRules, 'start' | 'max'>): number {
  const start = Number.isInteger(rules.start) && rules.start >= 1 ? rules.start : 1;
  const max = Number.isInteger(rules.max) && rules.max > start ? rules.max : 999;
  if (lastDate !== today || !last) return start;
  const n = last + 1;
  return n > max || n < start ? start : n;
}

/**
 * "A-17" with a prefix, "17" without — and "17" whatever the prefix with `format: 'number'`
 * ("מספר בלבד", `pickup.labelFormat`; the server's kiosk_pickup.pickup_label, one rule).
 */
export function pickupLabelOf(prefix: string | null | undefined, n: number, format?: 'prefixed' | 'number' | null): string {
  if (format === 'number') return String(n);
  const p = (prefix ?? '').trim();
  return p ? `${p}-${n}` : String(n);
}

/** A shop-scope kiosk's own number while the cloud did not answer: tagged L ("AL-4"). */
export function offlinePickupLabel(prefix: string | null | undefined, n: number): string {
  return pickupLabelOf(`${(prefix ?? '').trim()}L`, n);
}

/** A local business date, yyyy-MM-dd (the device's own day). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- basket */

export type GroupKind = 'choice' | 'addon' | 'removal';

/** One option chosen on a dish, with what the catalog says of its group. */
export interface WebLineOption {
  groupId: string;
  groupName: string | null;
  kind: GroupKind;
  optionId: string;
  name: string;
  /** The option's own price, per unit. */
  priceAgorot: number;
  qty?: number;
  /** "מעט / הרבה / בצד". */
  pre?: 'lite' | 'extra' | 'side' | null;
  /** What it was charged per unit of the dish, after free choices and "הרבה" (kioskMoney.ts); absent: price × qty. */
  chargedAgorot?: number;
}

/** One component of a meal line (the till's MealComponent). */
export interface WebMealComponent {
  slotId: string;
  slotName: string;
  productId: string;
  name: string;
  categoryId: string | null;
  /** The component's own catalog price: what the meal's base is allocated by. */
  listPriceAgorot: number;
  upchargeAgorot: number;
  options: WebLineOption[];
}

/** What one choice adds to one unit of the dish. */
export function optionChargedAgorot(o: Pick<WebLineOption, 'priceAgorot' | 'qty' | 'chargedAgorot'>): number {
  return o.chargedAgorot ?? o.priceAgorot * Math.max(1, o.qty ?? 1);
}

/** One basket line, as the kiosk took it (prices as the customer saw them). */
export interface WebOrderLine {
  key: string;
  productId: string;
  name: string;
  qty: number;
  /** The dish's own price per unit, as the line was added at — the active menu's while a menu priced it ("תפריטים"). */
  baseAgorot: number;
  /**
   * "תפריטים": the catalog's own price when the line was added under a menu, and the menu — an open basket keeps its
   * price when the menu changes under it, and the sale records where it came from (lib/kioskMenus.ts).
   */
  catalogAgorot?: number;
  menuId?: string | null;
  menuName?: string | null;
  priceSource?: 'menu' | 'catalog' | null;
  /** What one unit costs with its options. */
  unitAgorot: number;
  options: WebLineOption[];
  note: string | null;
  categoryId: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  allergens: string[];
  /** A meal: its components (the line's product is the meal). */
  meal?: { components: WebMealComponent[] } | null;
  /** "לא מקבל הנחות" (the till's promotions never touch it). */
  noDiscount?: boolean;
  /** The line's share of the promotions (kioskMoney.ts), agorot, and the promotion that took most of it. */
  promotionAgorot?: number;
  promotionId?: string | null;
  promotionName?: string | null;
}

/** What the line costs: unit × qty, less its share of the promotions. */
export function lineTotalAgorot(l: Pick<WebOrderLine, 'qty' | 'unitAgorot'> & { promotionAgorot?: number }): number {
  return Math.round(l.qty * l.unitAgorot) - Math.max(0, l.promotionAgorot ?? 0);
}

/** What the goods cost, after the promotions. */
export function goodsAgorot(lines: ReadonlyArray<Pick<WebOrderLine, 'qty' | 'unitAgorot'> & { promotionAgorot?: number }>): number {
  return lines.reduce((s, l) => s + lineTotalAgorot(l), 0);
}

/** A choice on the till's held sale (LineDetailsCodec modifier). */
function modifierCodec(o: WebLineOption) {
  return {
    groupId: o.groupId,
    groupName: o.groupName,
    kind: o.kind,
    optionId: o.optionId,
    name: o.name,
    price: shekels(o.priceAgorot),
    qty: o.qty ?? 1,
    pre: o.pre ?? null,
    charged: shekels(optionChargedAgorot(o)),
  };
}

/** "הרבה טחינה ×2", "בלי בצל" — the kitchen's and the tills' wording (LineModifier.displayText). */
function optionWords(o: WebLineOption): string {
  const pre = o.pre === 'lite' ? 'מעט' : o.pre === 'extra' ? 'הרבה' : o.pre === 'side' ? 'בצד' : null;
  const withPre = pre === null ? o.name : o.pre === 'side' ? `${o.name} ${pre}` : `${pre} ${o.name}`;
  const text = o.kind === 'removal' ? `בלי ${withPre}` : withPre;
  return (o.qty ?? 1) > 1 ? `${text} ×${o.qty}` : text;
}

function shekels(agorot: number): number {
  return Math.round(agorot) / 100;
}

/**
 * The basket as the till's held sale (pos-android HeldSaleCodec.encode): the product travels with
 * the line (a JSON string, as the till writes it) and the options as the line's details
 * (LineDetailsCodec v1: basePrice and the modifiers in shekels). The cloud id is the till's id.
 */
export function heldSaleCodec(cartId: string, lines: readonly WebOrderLine[]): string {
  return JSON.stringify({
    cartId,
    lines: lines.map((l) => ({
      id: l.key,
      quantity: l.qty,
      unitPrice: Math.round(l.unitAgorot),
      discount: 0,
      discountType: null,
      // The dish's note travels in its details (noteText), as the Android kiosk's dish: never twice on the bon.
      notes: null,
      product: JSON.stringify({
        id: l.productId,
        cloudId: l.productId,
        name: l.name,
        sku: l.sku ?? l.productId.slice(0, 8),
        categoryId: l.categoryId ?? '',
        price: Math.round(l.baseAgorot),
        // The menu the line was added under travels with the line, as the Android till's held sale (HeldSaleCodec).
        ...(l.menuId ? { menuId: l.menuId, menuName: l.menuName ?? null, priceSource: l.priceSource === 'menu' ? 'menu' : 'catalog', ...(typeof l.catalogAgorot === 'number' ? { catalogPrice: Math.round(l.catalogAgorot) } : {}) } : {}),
        barcode: l.barcode,
        imageUrl: l.imageUrl,
        localImagePath: null,
        isAvailable: true,
        inStock: true,
        trackStock: false,
        isOpenPrice: false,
        isWeighed: false,
        isGeneral: false,
        unitLabel: null,
        voucherId: null,
        noDiscount: l.noDiscount === true,
        allergens: l.allergens,
        courseId: null,
      }),
      details:
        l.options.length > 0 || (l.note && l.note.trim()) || (l.meal && l.meal.components.length > 0)
          ? {
              v: 1,
              basePrice: shekels(l.baseAgorot),
              modifiers: l.options.map(modifierCodec),
              ...(l.note && l.note.trim() ? { noteText: l.note.trim().slice(0, 300) } : {}),
              // A meal: its components (the till rebuilds the meal line exactly, MealDetails).
              ...(l.meal && l.meal.components.length > 0
                ? {
                    meal: {
                      productId: l.productId,
                      name: l.name,
                      components: l.meal.components.map((c) => ({
                        slotId: c.slotId,
                        slotName: c.slotName,
                        productId: c.productId,
                        name: c.name,
                        ...(c.categoryId ? { categoryId: c.categoryId } : {}),
                        listPrice: shekels(c.listPriceAgorot),
                        qty: 1,
                        upcharge: shekels(c.upchargeAgorot),
                        modifiers: c.options.map(modifierCodec),
                      })),
                      slots: [],
                    },
                  }
                : {}),
            }
          : null,
    })),
  });
}

/** The order's lines as the tills list them and the slip prints them (KioskOpenLine.of). */
export function openLines(lines: readonly WebOrderLine[]): Array<{ name: string; quantity: number; totalAgorot: number; notes?: string }> {
  return lines
    .filter((l) => l.qty > 0)
    .map((l) => {
      const mods = [...l.options.map(optionWords), ...(l.meal?.components ?? []).map((c) => (c.options.length > 0 ? `${c.name} (${c.options.map(optionWords).join(', ')})` : c.name))];
      const notes = [...mods, ...(l.note && l.note.trim() ? [l.note.trim()] : [])].join(' · ');
      return { name: l.name.slice(0, 255), quantity: l.qty, totalAgorot: lineTotalAgorot(l), ...(notes ? { notes: notes.slice(0, 300) } : {}) };
    });
}

/* -------------------------------------------------------------- vouchers */

/** One item of a voucher (lookup's `items`). */
export interface VoucherItem {
  productId: string;
  tillProductId: string | null;
  name: string;
  quantity: number;
  remaining: number;
}

/** What the cloud's redemption took (redeem's `redeemed`). */
export interface VoucherTaken {
  productId: string;
  tillProductId: string | null;
  name: string | null;
  quantity: number;
}

/** A voucher redeemed towards this order. */
export interface VoucherLeg {
  redemptionId: string;
  serial: number;
  amountAgorot: number;
  eventName: string | null;
  redeemed: VoucherTaken[];
}

const matches = (line: Pick<WebOrderLine, 'productId'>, item: { productId: string; tillProductId?: string | null }) =>
  line.productId === item.productId || (!!item.tillProductId && line.productId === item.tillProductId);

/** What a voucher covers of a line: the line's total (after its promotions) in the share of its price that is the dish's own. */
export function voucherCoverable(l: Pick<WebOrderLine, 'qty' | 'unitAgorot' | 'baseAgorot'> & { promotionAgorot?: number }): number {
  const total = lineTotalAgorot(l);
  if (l.unitAgorot <= 0 || l.baseAgorot >= l.unitAgorot) return total;
  return Math.round((total * l.baseAgorot) / l.unitAgorot);
}

/** Units of each line the earlier vouchers already took (by line key), walking the basket in order. */
export function coveredUnits(lines: readonly WebOrderLine[], legs: readonly Pick<VoucherLeg, 'redeemed'>[]): Map<string, number> {
  const used = new Map<string, number>();
  for (const leg of legs) {
    for (const r of leg.redeemed) {
      let left = r.quantity;
      for (const l of lines) {
        if (left <= 0) break;
        if (!matches(l, r)) continue;
        const free = l.qty - (used.get(l.key) ?? 0);
        if (free <= 0) continue;
        const take = Math.min(left, free);
        left -= take;
        used.set(l.key, (used.get(l.key) ?? 0) + take);
      }
    }
  }
  return used;
}

/**
 * Per voucher product, how many to take now: what is left on it, no more than the basket holds of
 * it less what earlier vouchers of this order took (KioskPayRemainder.take). Nothing → empty.
 */
export function voucherTake(items: readonly VoucherItem[], lines: readonly WebOrderLine[], earlier: readonly Pick<VoucherLeg, 'redeemed'>[]): Map<string, number> {
  const used = coveredUnits(lines, earlier);
  const out = new Map<string, number>();
  for (const it of items) {
    const inBasket = lines.filter((l) => matches(l, it)).reduce((n, l) => n + l.qty - (used.get(l.key) ?? 0), 0);
    const q = Math.min(Math.max(0, it.remaining), Math.max(0, inBasket) - (out.get(it.productId) ?? 0));
    if (q > 0) out.set(it.productId, (out.get(it.productId) ?? 0) + q);
  }
  return out;
}

/** A one-time voucher of which only part is taken: what is left is given up (the customer is asked). */
export function voucherForfeits(splitAllowed: boolean, items: readonly VoucherItem[], take: ReadonlyMap<string, number>): boolean {
  return !splitAllowed && !items.every((it) => (take.get(it.productId) ?? 0) === it.remaining);
}

/** What the new redemption pays: the goods it covers (after the earlier ones), never more than the goods still unpaid. */
export function voucherAmount(lines: readonly WebOrderLine[], earlier: readonly VoucherLeg[], redeemed: readonly VoucherTaken[]): number {
  const used = coveredUnits(lines, earlier);
  let covered = 0;
  for (const r of redeemed) {
    let left = r.quantity;
    for (const l of lines) {
      if (left <= 0) break;
      if (!matches(l, r)) continue;
      const free = l.qty - (used.get(l.key) ?? 0);
      if (free <= 0) continue;
      const take = Math.min(left, free);
      left -= take;
      used.set(l.key, (used.get(l.key) ?? 0) + take);
      covered += Math.round((voucherCoverable(l) * take) / l.qty);
    }
  }
  const already = earlier.reduce((s, v) => s + v.amountAgorot, 0);
  return Math.max(0, Math.min(covered, goodsAgorot(lines) - already));
}

/** Left to pay: the goods and the tip less the vouchers, never below zero. */
export function dueAgorot(goods: number, tip: number, legs: readonly Pick<VoucherLeg, 'amountAgorot'>[]): number {
  return Math.max(0, Math.trunc(goods) + Math.trunc(tip) - legs.reduce((s, v) => s + Math.max(0, Math.trunc(v.amountAgorot)), 0));
}

/** A typed or scanned voucher code, normalised ("PV:" and dashes off, upper case), or null when it cannot be one. */
export function voucherCodeOf(raw: string): string | null {
  let text = raw.trim();
  if (text.length > 3 && text[0] === ']' && /[A-Za-z]/.test(text[1]) && /\d/.test(text[2])) text = text.slice(3).trim();
  if (/^pv:/i.test(text)) text = text.slice(3);
  if (/[^\p{L}\p{N}\s-]/u.test(text)) return null;
  const code = text.replace(/[\s-]+/g, '').toUpperCase();
  return code.length >= 4 && code.length <= 32 ? code : null;
}

/* ----------------------------------------------------------------- order */

export interface OpenOrder {
  localId: string;
  createdAtMs: number;
  businessDate: string;
  /** Null: "ללא סוג שירות". */
  serviceType: 'take_away' | 'eat_in' | null;
  tableRef: string | null;
  fulfillmentMode: 'BON' | 'KDS';
  configVersion: string | null;
  customerName: string | null;
  customerPhone: string | null;
  lines: WebOrderLine[];
  tipAgorot: number;
  vouchers: VoucherLeg[];
  pickupNumber: number;
  pickupLabel: string;
  bon: { mode: 'single' | 'routing'; printerId: string | null; copies: number };
  kitchenSent: boolean;
  /** The state the cloud last answered (null: never delivered). */
  cloudState: string | null;
  /** Refused for good ("invalid:…"): kept, never sent again. */
  rejected: string | null;
  /** Refused as `price_changed`: the cloud's lines and prices (kiosk_basket_check.price_lines). */
  refusedLines?: unknown[] | null;
}

/** The slip's code (and the QR on the screen): the till's scanner opens the order with it. */
export function orderCode(localId: string): string {
  return `KO:${localId}`;
}

/**
 * The order as `POST /sync/{m}/kiosk/open-orders` takes it (KioskOpenOrderIn). [customerWaiting]:
 * sent while the customer waits for the slip — the cloud then refuses a basket it prices otherwise
 * (`price_changed`), to be shown and asked again; never on a retry (the slip may be out).
 */
export function openOrderWire(o: OpenOrder, customerWaiting = false): Record<string, unknown> {
  const total = goodsAgorot(o.lines);
  const voucher = o.vouchers.reduce((s, v) => s + v.amountAgorot, 0);
  return {
    localId: o.localId,
    pickupNumber: o.pickupNumber,
    pickupLabel: o.pickupLabel,
    businessDate: o.businessDate,
    serviceType: o.serviceType,
    tableRef: o.tableRef,
    fulfillmentMode: o.fulfillmentMode,
    configVersion: o.configVersion,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    itemCount: o.lines.reduce((n, l) => n + l.qty, 0),
    totalAgorot: total,
    tipAgorot: o.tipAgorot,
    voucherAgorot: voucher,
    dueAgorot: total + o.tipAgorot - voucher,
    createdAt: new Date(o.createdAtMs).toISOString(),
    lines: openLines(o.lines),
    cart: { codec: heldSaleCodec(o.localId, o.lines), bon: o.bon, fulfillment: o.fulfillmentMode },
    vouchers: o.vouchers.map((v) => ({
      redemptionId: v.redemptionId,
      serial: v.serial,
      amountAgorot: v.amountAgorot,
      eventName: v.eventName,
      redeemed: v.redeemed.map((r) => ({ productId: r.productId, tillProductId: r.tillProductId, name: r.name, quantity: r.quantity })),
    })),
    kitchenSent: o.kitchenSent,
    state: 'open',
    ...(customerWaiting ? { customerWaiting: true } : {}),
  };
}

/** The cloud's answer to `kiosk/open-orders`, read the same way by both kiosks. */
export interface OpenOrdersAnswer {
  accepted?: string[];
  rejected?: Array<{ localId?: string; reason?: string; lines?: unknown }>;
  states?: Record<string, { state?: string }>;
}

/** Each sent order as the cloud left it: taken (its state), refused (why, and the cloud's prices), or not named. */
export function answeredOrder(o: OpenOrder, body: OpenOrdersAnswer | null | undefined): OpenOrder | null {
  if ((body?.accepted ?? []).includes(o.localId)) return { ...o, cloudState: body?.states?.[o.localId]?.state ?? 'open' };
  const refused = (body?.rejected ?? []).find((x) => (x.localId ?? '') === o.localId);
  if (!refused) return null;
  return { ...o, rejected: refused.reason ?? 'rejected', refusedLines: Array.isArray(refused.lines) ? refused.lines : null };
}

/** What the till takes for it. */
export function orderDue(o: Pick<OpenOrder, 'lines' | 'tipAgorot' | 'vouchers'>): number {
  return dueAgorot(goodsAgorot(o.lines), o.tipAgorot, o.vouchers);
}

/** Still to deliver: neither taken by the cloud nor refused for good. */
export function orderNeedsUpload(o: Pick<OpenOrder, 'cloudState' | 'rejected'>): boolean {
  return o.cloudState === null && o.rejected === null;
}

/** A random id (RFC 4122 v4), from crypto when there is one. */
export function newId(rand: () => number = Math.random): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (rand === Math.random && c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(rand() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
