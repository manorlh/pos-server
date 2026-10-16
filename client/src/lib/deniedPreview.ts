/**
 * "מה יראה מלצר" — the roles page's preview of "כשאין הרשאה" (P:/specs/denied-actions-ui.md §3, §5): for one role,
 * which of the till's options are hidden, which ask a manager's code, and which are shown with "אין הרשאה" on tap.
 *
 * The entries are the till's places (pos-android domain/DeniedActions.kt and the screens that ask it), one per
 * option the owner would look for, with the permission codes it is offered by; the rule is the till's:
 *
 *  * a role allowed any of an entry's codes — shown, done alone; asked a manager for one — shown, on a code;
 *  * every code denied: under "לבקש קוד מנהל" — on a manager's code; under "להסתיר" — hidden; under "להציג" —
 *    shown, "אין הרשאה" on tap, except the entries that always read the older `permissionsDeniedUi` (hidden when it
 *    says "הסתר", the default) and those the till hides whenever denied;
 *  * the safety entries are never hidden (spec §4).
 *
 * Pure: the page passes the draft matrix (unsaved edits included) and the level's answers.
 */
import type { DeniedUi, PermState } from './tillRoles';

/** option: hidden under "להסתיר"; legacy: under "להציג" as `permissionsDeniedUi`; always: hidden whenever denied
 * (under "להציג" too, as today); safety: never hidden. */
export type PreviewKind = 'option' | 'legacy' | 'always' | 'safety';

export interface TillEntry {
  key: string;
  label: string;
  where: string;
  codes: string[];
  kind: PreviewKind;
}

export const TILL_ENTRIES: TillEntry[] = [
  // ☰
  { key: 'shift_close', label: 'סגירת משמרת', where: 'תפריט ☰', codes: ['SHIFT_CLOSE'], kind: 'option' },
  { key: 'till_z', label: 'הפק Z', where: 'תפריט ☰, מסך המשמרת', codes: ['Z'], kind: 'option' },
  { key: 'refund', label: 'זיכוי, בצע זיכוי, חשבונית על שם לקוח', where: 'תפריט ☰, היסטוריה', codes: ['REFUND'], kind: 'option' },
  { key: 'open_drawer', label: 'פתיחת מגירה', where: 'תפריט ☰', codes: ['CASH_DRAWER.OPEN_MANUALLY', 'CASH_DRAWER.OPEN_FOR_CHANGE'], kind: 'legacy' },
  { key: 'open_remote', label: 'פתיחת מגירה בקופה אחרת', where: 'תפריט ☰', codes: ['CASH_DRAWER.OPEN_REMOTE'], kind: 'legacy' },
  { key: 'cash_in', label: 'הכנסת מזומן', where: 'מזומן במגירה', codes: ['CASH_DRAWER.CASH_IN'], kind: 'legacy' },
  { key: 'cash_out', label: 'הוצאת מזומן', where: 'מזומן במגירה', codes: ['CASH_DRAWER.CASH_OUT'], kind: 'legacy' },
  { key: 'deposit', label: 'הפקדה / ריקון חלקי', where: 'מזומן במגירה', codes: ['CASH_DRAWER.DEPOSIT'], kind: 'legacy' },
  { key: 'count', label: 'ספירת מגירה', where: 'מזומן במגירה', codes: ['CASH_DRAWER.COUNT'], kind: 'legacy' },
  { key: 'wallet_deposit', label: 'הפקדת מזומן מעובד', where: 'מזומן במגירה', codes: ['CASH_DRAWER.WALLET_DEPOSIT'], kind: 'legacy' },
  { key: 'drawer_log', label: 'לוג פתיחות מגירה', where: 'מזומן במגירה', codes: ['CASH_DRAWER.VIEW_LOG', 'CASH_DRAWER.VIEW_CASH_MOVEMENTS'], kind: 'legacy' },
  { key: 'catalog_admin', label: 'ניהול קטלוג', where: 'תפריט ☰, לחיצה ארוכה על מוצר', codes: ['CATALOG_VIEW'], kind: 'legacy' },
  { key: 'reports', label: 'דוחות', where: 'תפריט ☰', codes: ['VIEW_REPORTS'], kind: 'legacy' },
  { key: 'shop_x', label: 'דוח X סניפי', where: 'תפריט ☰ — דוחות', codes: ['SHOP_X_REPORT'], kind: 'legacy' },
  { key: 'screen_edit', label: 'עריכת מסך', where: 'תפריט ☰', codes: ['CATALOG_WRITE'], kind: 'option' },
  // The bar and the shift screen.
  { key: 'calculator', label: 'מחשבון', where: 'סרגל תחתון', codes: ['CALCULATOR.USE'], kind: 'legacy' },
  { key: 'quick_order', label: 'הזמנה מהירה', where: 'סרגל תחתון', codes: ['SELL'], kind: 'legacy' },
  { key: 'tables', label: 'שולחנות', where: 'סרגל תחתון', codes: ['TABLES.USE'], kind: 'legacy' },
  { key: 'x_print', label: 'הדפסת X', where: 'מסך המשמרת', codes: ['X'], kind: 'option' },
  // A sale.
  { key: 'discount', label: 'הנחה לחשבון והנחה לשורה', where: 'מסך המכירה, שולחן', codes: ['DISCOUNT'], kind: 'option' },
  { key: 'line_void', label: 'הסר שורה (וגם החלקה ו־"−" עד 0)', where: 'מסך המכירה, שולחן', codes: ['LINE_VOID'], kind: 'option' },
  { key: 'oth', label: 'OTH — על חשבון הבית', where: 'מסך המכירה, שולחן', codes: ['OTH'], kind: 'option' },
  { key: 'held_cancel', label: 'מחיקת מכירה מושהית', where: 'מכירות מושהות', codes: ['HELD_SALE_CANCEL'], kind: 'option' },
  // Tables.
  { key: 'table_reprint', label: 'הדפסה חוזרת', where: 'שולחן ⋮', codes: ['REPRINT'], kind: 'option' },
  { key: 'table_cancel', label: 'ביטול שולחן', where: 'שולחן ⋮, חלון שולחן', codes: ['TABLE_CANCEL'], kind: 'option' },
  { key: 'table_assign', label: 'שיוך מלצרים', where: 'מפת השולחנות', codes: ['TABLES.ASSIGN'], kind: 'always' },
  { key: 'waiter_assign', label: '"גם השיוך" בהחלפת מלצר', where: 'שולחן ⋮', codes: ['TABLES.ASSIGN'], kind: 'option' },
  {
    key: 'payment_reverse', label: 'זיכוי או ביטול תשלום בשולחן', where: 'שולחן — תשלומים',
    codes: ['PAYMENT_REVERSE_CASH', 'PAYMENT_REVERSE_CARD', 'PAYMENT_REVERSE_OTHER'], kind: 'option',
  },
  { key: 'table_edit', label: 'עריכת המפה, שינוי שם שולחן', where: 'מפת השולחנות', codes: ['CATALOG_WRITE'], kind: 'option' },
  { key: 'table_restore', label: 'שחזר שולחן', where: 'נסגרו היום', codes: ['TABLE_RESTORE'], kind: 'option' },
  // Blocks and kiosks.
  { key: 'item_block', label: 'חסום פריט, שחרר', where: 'חסומים כעת', codes: ['ITEM_BLOCK'], kind: 'option' },
  { key: 'item_block_tile', label: 'חסום / אזל', where: 'לחיצה ארוכה על מוצר', codes: ['ITEM_BLOCK'], kind: 'always' },
  { key: 'kiosk_control', label: 'נעילת קיוסק ופתיחה אוטומטית', where: 'קיוסקים', codes: ['KIOSK_CONTROL'], kind: 'option' },
  // Never hidden (spec §4).
  { key: 'shift_open', label: 'פתיחת משמרת', where: 'מסך המשמרת', codes: ['SHIFT_OPEN'], kind: 'safety' },
  { key: 'card_unresolved', label: 'עסקת אשראי לא ידועה', where: 'תשלום', codes: ['CARD_UNRESOLVED'], kind: 'safety' },
  { key: 'transmit', label: 'שידור עסקאות אשראי', where: 'פעולות אשראי', codes: ['TRANSMIT'], kind: 'safety' },
  { key: 'attendance', label: 'אישור מנהל ליציאה ממשמרת', where: 'נוכחות', codes: ['ATTENDANCE_MANAGE'], kind: 'safety' },
];

/** What the role's operator gets for one entry. */
export type PreviewOutcome = 'alone' | 'approval' | 'code' | 'hidden' | 'denied';

export function entryOutcome(
  entry: Pick<TillEntry, 'codes' | 'kind'>,
  states: Record<string, PermState | undefined>,
  mode: DeniedUi,
  legacyHide: boolean,
): PreviewOutcome {
  const all = entry.codes.map((c) => states[c] ?? 'deny');
  if (all.includes('allow')) return 'alone';
  if (all.includes('approval')) return 'approval';
  if (mode === 'code') return 'code';
  if (entry.kind === 'safety') return 'denied';
  if (mode === 'hide') return 'hidden';
  if (entry.kind === 'always') return 'hidden';
  if (entry.kind === 'legacy' && legacyHide) return 'hidden';
  return 'denied';
}

export interface DeniedPreview {
  hidden: TillEntry[];
  /** On a manager's code: the role's "דורש אישור מנהל", and its "אסור" under "לבקש קוד מנהל". */
  code: TillEntry[];
  /** Shown; a tap says "אין הרשאה". */
  denied: TillEntry[];
}

/** The preview for [states] under [mode] (the role's own, else the level's) and the older parameter. */
export function deniedPreview(
  states: Record<string, PermState | undefined>,
  mode: DeniedUi,
  legacyHide: boolean,
  entries: TillEntry[] = TILL_ENTRIES,
): DeniedPreview {
  const out: DeniedPreview = { hidden: [], code: [], denied: [] };
  for (const e of entries) {
    const o = entryOutcome(e, states, mode, legacyHide);
    if (o === 'hidden') out.hidden.push(e);
    else if (o === 'code' || o === 'approval') out.code.push(e);
    else if (o === 'denied') out.denied.push(e);
  }
  return out;
}

/** The answer a role gets: its own, else the level's (null: "show"). */
export function effectiveDeniedUi(roleValue: DeniedUi | null | undefined, levelValue: unknown): DeniedUi {
  if (roleValue === 'show' || roleValue === 'hide' || roleValue === 'code') return roleValue;
  if (levelValue === 'show' || levelValue === 'hide' || levelValue === 'code') return levelValue;
  return 'show';
}

/** The older `permissionsDeniedUi` says "הסתר" (its default) — the value the level resolves to, or unset. */
export function legacyHides(levelValue: unknown): boolean {
  return levelValue !== 'הצג מושבת עם הסבר';
}
