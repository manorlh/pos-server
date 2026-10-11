/**
 * "סיכום השובר": what a voucher will do at the till, in one to four plain Hebrew sentences, built
 * from its settings — the same words in the type editor, the new batch, the batch page and the bulk
 * dialog (the owner, 12.10.2026: "תעבור על הניסוח והתצורה שהיא ברורה להקמה"). Pure: no I/O, no i18n
 * lookup (the dashboard is Hebrew); the terms are P:\specs\voucher-glossary.md's.
 *
 * Example (a punch card): "כרטיסייה: עד 50 פריטים מתוך 'אוכל', לאורך כל חיי השובר. כל פריט שנמסר הוא
 * שימוש אחד: בעסקה עם 6 פריטים מאושרים ינוצלו 6 שימושים בסריקה אחת, והיתרה נשמרת לפעמים הבאות."
 */

import { moneyText, type PrepaidStacking, type PrepaidVoucherKind } from './prepaidVoucherBenefit';
import { zonedParts, type DateInput } from './format';

/** One item group, with the names of what it takes. */
export interface SummaryGroup {
  name: string;
  minQty: number;
  maxQty: number;
  allowRepeat?: boolean;
  allItems?: boolean;
  /** The chosen products' and categories' names. */
  names: string[];
  /** The excluded products' and categories' names. */
  excluded?: string[];
}

export interface SummaryItem {
  name: string;
  quantity: number;
  weighed?: boolean;
  unitLabel?: string | null;
}

export interface SummaryInput {
  kind?: PrepaidVoucherKind | null;
  selection?: 'items' | 'groups' | null;
  items?: SummaryItem[];
  groups?: SummaryGroup[];
  /** "סה״כ פריטים בשובר"; null — the groups' maxima. */
  totalQty?: number | null;
  splitAllowed?: boolean | null;
  includeExtras?: boolean | null;
  pricing?: 'fixed' | 'cover' | null;
  /** ₪ — the voucher's value at the till; null — the items by the menu. */
  tillValue?: number | null;
  allowTopUp?: boolean | null;
  accounting?: 'discount' | 'payment' | 'zero' | null;
  /** A discount voucher's benefit as printed ("₪30 הנחה על כל ההזמנה"). */
  benefit?: string | null;
  usesPerVoucher?: number | null;
  maxUsesPerSale?: number | null;
  maxUsesPerDay?: number | null;
  stacking?: PrepaidStacking | null;
  maxVouchersPerSale?: number | null;
  /** A batch's: vouchers in it. */
  count?: number | null;
  /** A batch's validity (ISO, "yyyy-mm-dd" or "dd/mm/yyyy"); both undefined with [shopNames] — no such sentence (a type). */
  validFrom?: DateInput;
  validUntil?: DateInput;
  /** A batch's shops by name; null or empty — every shop of its company. */
  shopNames?: string[] | null;
  offlineAllowed?: boolean | null;
}

/** "מספר הפריטים בדוגמה": 6, or the quota when it is smaller (the owner's example). */
export const EXAMPLE_UNITS = 6;

const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function dayParts(value: DateInput): { d: number; m: number; y: number } | null {
  if (typeof value === 'string') {
    const dmy = DMY.exec(value.trim());
    if (dmy) return { d: Number(dmy[1]), m: Number(dmy[2]), y: Number(dmy[3]) };
  }
  const p = zonedParts(value);
  return p ? { d: p.day, m: p.month, y: p.year } : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "01/11–31/12/2026", "מ-01/11/2026", "עד 31/12/2026" or null (no dates). */
export function validityText(from: DateInput, until: DateInput): string | null {
  const a = dayParts(from);
  const b = dayParts(until);
  const full = (p: { d: number; m: number; y: number }) => `${pad(p.d)}/${pad(p.m)}/${p.y}`;
  if (a && b) return a.y === b.y ? `${pad(a.d)}/${pad(a.m)}–${full(b)}` : `${full(a)}–${full(b)}`;
  if (a) return `מ-${full(a)}`;
  if (b) return `עד ${full(b)}`;
  return null;
}

/** "'אוכל'", "'קפה', 'כריך' ו-'מיץ'", "'קפה', 'כריך', 'מיץ' ועוד 2". */
export function namesText(names: readonly string[], most = 3): string {
  const clean = names.map((n) => n.trim()).filter(Boolean).map((n) => `'${n}'`);
  if (!clean.length) return '';
  if (clean.length === 1) return clean[0];
  if (clean.length <= most) return `${clean.slice(0, -1).join(', ')} ו-${clean[clean.length - 1]}`;
  return `${clean.slice(0, most).join(', ')} ועוד ${clean.length - most}`;
}

function itemsText(items: readonly SummaryItem[]): string {
  return items.map((i) => {
    if (i.weighed) return `${i.quantity} ${i.unitLabel || 'ק"ג'} ${i.name}`;
    return i.quantity === 1 ? i.name : `${i.quantity}× ${i.name}`;
  }).join(' + ');
}

/** What a group takes: "'אוכל'", "כל התפריט חוץ מ-'אלכוהול'", "פריטים שעוד לא נבחרו". */
function groupSource(g: SummaryGroup): string {
  const base = g.allItems ? 'כל התפריט' : namesText(g.names) || 'פריטים שעוד לא נבחרו';
  const excluded = namesText(g.excluded ?? []);
  return excluded ? `${base} חוץ מ-${excluded}` : base;
}

const qtyText = (min: number, max: number) => (min === max ? `${max}` : min > 0 ? `${min}–${max}` : `עד ${max}`);

/** One group, N in all, the same item again, at most one required: a punch card ("כרטיסייה"). */
export function summaryIsPunchCard(s: SummaryInput): boolean {
  const gs = s.groups ?? [];
  if (s.selection !== 'groups' || gs.length !== 1) return false;
  const g = gs[0];
  const total = s.totalQty ?? g.maxQty;
  return g.maxQty > 1 && total === g.maxQty && g.minQty <= 1 && g.allowRepeat !== false;
}

function contents(s: SummaryInput): string {
  const kind = s.kind ?? 'items';
  if (kind !== 'items') {
    const uses = Math.max(1, s.usesPerVoucher ?? 1);
    const usesText = uses === 1 ? 'שימוש אחד בשובר' : `${uses} שימושים בשובר`;
    const limits = [
      uses > 1 && (s.maxUsesPerSale ?? 1) > 1 ? `עד ${s.maxUsesPerSale} בעסקה` : uses > 1 ? 'שימוש אחד בכל עסקה' : null,
      s.maxUsesPerDay ? `עד ${s.maxUsesPerDay} ביום` : null,
    ].filter(Boolean);
    const what = s.benefit?.trim() || (kind === 'order_discount' ? 'הנחה על כל העסקה (עוד לא נקבע גובה ההנחה)' : 'הנחה על פריטים (עוד לא נקבעו גובה ההנחה והפריטים)');
    return `שובר הנחה: ${what}. ${usesText}${limits.length ? ` (${limits.join(', ')})` : ''}.`;
  }
  const split = !!s.splitAllowed;
  if (s.selection === 'groups') {
    const gs = s.groups ?? [];
    if (!gs.length) return 'שובר פריטים: עוד לא הוגדרו קבוצות פריטים.';
    const sumMax = gs.reduce((a, g) => a + g.maxQty, 0);
    const total = s.totalQty ?? sumMax;
    if (summaryIsPunchCard(s)) {
      const g = gs[0];
      const k = Math.min(EXAMPLE_UNITS, total);
      const head = `כרטיסייה: עד ${total} פריטים מתוך ${groupSource(g)}, לאורך כל חיי השובר.`;
      const scan = `כל פריט שנמסר הוא שימוש אחד: בעסקה עם ${k} פריטים מאושרים ינוצלו ${k} שימושים בסריקה אחת (עד היתרה)`;
      return split
        ? `${head} ${scan}, והיתרה נשמרת לפעמים הבאות.`
        : `${head} ${scan}. מימוש בעסקה אחת: בכל עסקה לפחות פריט אחד, והיתרה נשמרת.`;
    }
    if (total === 1) {
      const names = gs.map(groupSource).join(' או ');
      return `פריט אחד לבחירה מתוך ${names}.`;
    }
    const parts = gs.map((g) => `${qtyText(g.minQty, g.maxQty)} ${g.name || 'פריטים'} (מתוך ${groupSource(g)}${g.allowRepeat === false ? ', כל פריט פעם אחת' : ''})`);
    const head = gs.length === 1 ? `שובר פריטים: ${parts[0]}` : `חבילה: ${parts.join(' + ')}`;
    const totalText = total < sumMax ? `, עד ${total} פריטים בסך הכול` : '';
    const how = split
      ? 'מימוש בחלקים: אפשר לקחת חלק עכשיו ואת השאר בעסקאות הבאות.'
      : 'מימוש בעסקה אחת: בכל עסקה צריך להשלים את המינימום של כל קבוצה.';
    return `${head}${totalText}. ${how}`;
  }
  const items = s.items ?? [];
  if (!items.length) return 'שובר פריטים: עוד לא נבחרו פריטים.';
  const how = split
    ? 'מימוש בחלקים: מה שלא נלקח בעסקה נשמר לפעם הבאה.'
    : 'מימוש בעסקה אחת: מה שלא נלקח בעסקה אובד (באישור הקופאי).';
  return `שובר פריטים: ${itemsText(items)}. ${how}`;
}

const ACCOUNTING: Record<string, string> = {
  discount: 'נרשם כקיזוז מהחשבונית',
  payment: 'נרשם כאמצעי התשלום "שובר הפקה"',
  zero: 'נרשם בשורות ₪0 עם הצגת השווי',
};

function price(s: SummaryInput): string | null {
  if ((s.kind ?? 'items') !== 'items') return null;
  const value = s.tillValue != null && s.tillValue > 0 ? moneyText(Math.round(s.tillValue * 100)) : null;
  let text: string;
  if ((s.pricing ?? 'cover') === 'fixed') {
    text = value
      ? `בקופה: שווי קבוע ${value} — הפריטים שמומשו מסתכמים בשווי השובר${s.splitAllowed ? ' (במימוש בחלקים — לפי חלקם)' : ''}`
      : 'בקופה: שווי קבוע — חסר שווי בקופה';
  } else if (value) {
    text = `בקופה: השובר מכסה עד ${value} לפי מחירי התפריט; ${s.allowTopUp === false ? 'בחירה יקרה יותר חסומה' : 'מעבר לזה הלקוח משלים את ההפרש'}`;
  } else {
    text = 'בקופה: כל פריט מכוסה במחיר התפריט, בלי תקרה';
  }
  const extras = s.includeExtras ? ', כולל תוספות בתשלום' : '';
  const booked = s.accounting ? `; ${ACCOUNTING[s.accounting] ?? ''}` : '';
  return `${text}${extras}${booked}.`;
}

function stacking(s: SummaryInput): string | null {
  if (!s.stacking) return null;
  if (s.stacking === 'single') return 'שובר אחד בעסקה.';
  const which = s.stacking === 'distinct_batches' ? 'רק מסדרות שונות' : 'גם מאותה סדרה';
  return s.maxVouchersPerSale
    ? `ניתן לשלב עד ${s.maxVouchersPerSale} שוברים בעסקה, ${which}.`
    : `ניתן לשלב כמה שוברים בעסקה, ${which}.`;
}

function where(s: SummaryInput): string | null {
  const has = s.validFrom !== undefined || s.validUntil !== undefined || s.shopNames !== undefined;
  const offline = s.offlineAllowed ? ' ניתן לממש גם בלי אינטרנט, בקופה שהסדרה משויכת אליה.' : '';
  if (!has) return offline.trim() || null;
  const range = validityText(s.validFrom, s.validUntil);
  const shops = (s.shopNames ?? []).filter(Boolean);
  const place = shops.length ? `בסניפים ${namesText(shops)}` : 'בכל הסניפים';
  return `${range ? `תקף ${range}` : 'ללא הגבלת תאריך'} ${place}.${offline}`;
}

/** "סיכום השובר": its sentences, in order — the batch, what it gives, the till, the sale, where and when. */
export function voucherSummary(s: SummaryInput): string[] {
  const head = s.count != null && s.count > 0 ? `סדרה של ${s.count} שוברים.` : null;
  return [head, contents(s), price(s), stacking(s), where(s)].filter((x): x is string => !!x && !!x.trim());
}

/** The sentences as one paragraph. */
export function voucherSummaryText(s: SummaryInput): string {
  return voucherSummary(s).join(' ');
}
