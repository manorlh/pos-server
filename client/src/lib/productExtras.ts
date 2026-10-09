/**
 * "הודעות לעובד על פריט" and "פריטים נלווים" (pos-server app/services/product_alerts.py):
 * the shapes the product form edits and the pure rules it applies. Self-contained, so
 * `npm test` compiles it alone.
 *
 * - Alerts: shown on the till when the product is added, before it enters the order. Each
 *   has a text (up to 200), a kind (מידע / אזהרה / אלרגן), "חובה לאשר" and where it is
 *   shown. "הצג אזהרת אלרגנים" adds one more, built from the product's allergens.
 * - Companions: products the till adds with this one as lines of their own, per unit of
 *   it — at the item's price, free, or a set price — and whether the kitchen prints them.
 */

export type ProductAlertKind = 'info' | 'warning' | 'allergen';
export type ProductAlertPlace = 'quick' | 'tables' | 'both';

export interface ProductAlert {
  text: string;
  kind: ProductAlertKind;
  requireAck: boolean;
  whereShown: ProductAlertPlace;
}

export type CompanionPriceMode = 'item' | 'free' | 'custom';

export interface ProductCompanion {
  productId: string;
  /** As the server last named it; display only. */
  name?: string | null;
  quantity: number;
  priceMode: CompanionPriceMode;
  /** For "custom" only. */
  price?: number | null;
  /** null: as the companion's own routing; true: with the product; false: not printed. */
  kitchenPrint?: boolean | null;
}

/** "הדפס במטבח" as the form offers it. */
export type KitchenPrintChoice = 'own' | 'parent' | 'none';

export const ALERT_TEXT_MAX = 200;
export const ALERTS_MAX = 10;
export const COMPANIONS_MAX = 10;
export const COMPANION_QTY_MAX = 99;

export const ALERT_KINDS: ProductAlertKind[] = ['info', 'warning', 'allergen'];
export const ALERT_PLACES: ProductAlertPlace[] = ['both', 'quick', 'tables'];
export const COMPANION_PRICE_MODES: CompanionPriceMode[] = ['item', 'free', 'custom'];

/** The allergens in the till's and the cloud's fixed order. */
export const ALLERGEN_ORDER = [
  'gluten', 'milk', 'nuts', 'eggs', 'peanuts', 'fish', 'soy', 'sesame',
  'celery', 'mustard', 'sulphites', 'lupin', 'molluscs', 'crustaceans',
] as const;

/** A fresh alert: information, shown everywhere, not to be confirmed. */
export function newAlert(): ProductAlert {
  return { text: '', kind: 'info', requireAck: false, whereShown: 'both' };
}

/** An allergen alert asks to be confirmed by default; a new kind keeps what was chosen otherwise. */
export function withKind(alert: ProductAlert, kind: ProductAlertKind): ProductAlert {
  return { ...alert, kind, requireAck: kind === 'allergen' ? true : alert.requireAck };
}

/** [list] with the item at [index] moved one place up (-1) or down (+1); unchanged at an end. */
export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/**
 * "מכיל: ביצים, גלוטן — עדכנו את הלקוח!" — what the till shows for the allergen alert
 * (its `ProductAlerts.allergenText`, the cloud's `allergen_alert_text`). Null: none known.
 */
export function allergenAlertText(codes: readonly string[] | null | undefined, labelOf: (code: string) => string): string | null {
  const wanted = new Set((codes ?? []).map((c) => c.trim().toLowerCase()));
  const names = ALLERGEN_ORDER.filter((c) => wanted.has(c)).map((c) => labelOf(c));
  if (names.length === 0) return null;
  return `מכיל: ${names.join(', ')} — עדכנו את הלקוח!`;
}

/** The stored alerts as the form edits them, anything unreadable dropped. */
export function alertsOf(value: unknown): ProductAlert[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const a = raw as Record<string, unknown>;
    const kind = ALERT_KINDS.includes(a.kind as ProductAlertKind) ? (a.kind as ProductAlertKind) : 'info';
    const where = ALERT_PLACES.includes(a.whereShown as ProductAlertPlace) ? (a.whereShown as ProductAlertPlace) : 'both';
    return [{ text: typeof a.text === 'string' ? a.text : '', kind, requireAck: a.requireAck === true, whereShown: where }];
  });
}

/** What is wrong with the alerts, for the form: an empty text, one too long, too many. */
export function alertsProblem(alerts: ProductAlert[]): 'empty' | 'tooLong' | 'tooMany' | null {
  if (alerts.length > ALERTS_MAX) return 'tooMany';
  if (alerts.some((a) => !a.text.trim())) return 'empty';
  if (alerts.some((a) => a.text.trim().length > ALERT_TEXT_MAX)) return 'tooLong';
  return null;
}

/** The alerts as the server takes them: trimmed. */
export function alertsPayload(alerts: ProductAlert[]): ProductAlert[] {
  return alerts.map((a) => ({ ...a, text: a.text.trim() }));
}

/** The stored companions as the form edits them. */
export function companionsOf(value: unknown): ProductCompanion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const c = raw as Record<string, unknown>;
    if (typeof c.productId !== 'string' || !c.productId) return [];
    const mode = COMPANION_PRICE_MODES.includes(c.priceMode as CompanionPriceMode) ? (c.priceMode as CompanionPriceMode) : 'item';
    return [
      {
        productId: c.productId,
        name: typeof c.name === 'string' ? c.name : null,
        quantity: clampQty(Number(c.quantity ?? 1)),
        priceMode: mode,
        price: mode === 'custom' && typeof c.price === 'number' ? c.price : null,
        kitchenPrint: typeof c.kitchenPrint === 'boolean' ? c.kitchenPrint : null,
      },
    ];
  });
}

export function clampQty(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(COMPANION_QTY_MAX, Math.max(1, Math.round(n)));
}

/**
 * The picker's ids as companions: the rows already configured kept as they are, a new one
 * at one per unit and the item's own price; never the product itself, never twice.
 */
export function companionsFromIds(ids: string[], current: ProductCompanion[], selfId?: string | null): ProductCompanion[] {
  const seen = new Set<string>();
  const out: ProductCompanion[] = [];
  for (const id of ids) {
    if (!id || id === selfId || seen.has(id)) continue;
    seen.add(id);
    out.push(current.find((c) => c.productId === id) ?? { productId: id, quantity: 1, priceMode: 'item', price: null, kitchenPrint: null });
  }
  return out.slice(0, COMPANIONS_MAX);
}

/** What is wrong with the companions, for the form: a set price missing or negative. */
export function companionsProblem(list: ProductCompanion[]): 'customPrice' | 'tooMany' | null {
  if (list.length > COMPANIONS_MAX) return 'tooMany';
  if (list.some((c) => c.priceMode === 'custom' && !(typeof c.price === 'number' && Number.isFinite(c.price) && c.price >= 0))) {
    return 'customPrice';
  }
  return null;
}

/** The companions as the server takes them: a price only for "custom". */
export function companionsPayload(list: ProductCompanion[]): ProductCompanion[] {
  return list.map((c) => ({
    productId: c.productId,
    quantity: clampQty(c.quantity),
    priceMode: c.priceMode,
    price: c.priceMode === 'custom' ? Math.round(Number(c.price ?? 0) * 100) / 100 : null,
    kitchenPrint: c.kitchenPrint ?? null,
  }));
}

export function kitchenPrintChoice(v: boolean | null | undefined): KitchenPrintChoice {
  return v === true ? 'parent' : v === false ? 'none' : 'own';
}

export function kitchenPrintValue(choice: KitchenPrintChoice): boolean | null {
  return choice === 'parent' ? true : choice === 'none' ? false : null;
}

/** What one comes to on the till, per unit: the item's price, ₪0, or the set one. */
export function companionUnitPrice(c: ProductCompanion, itemPrice: number | null | undefined): number | null {
  if (c.priceMode === 'free') return 0;
  if (c.priceMode === 'custom') return typeof c.price === 'number' ? c.price : null;
  return typeof itemPrice === 'number' ? itemPrice : null;
}
