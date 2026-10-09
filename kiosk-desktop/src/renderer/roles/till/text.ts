/**
 * The till's Hebrew texts and money format (one place; the real strings come from the APK's XML
 * through the engine's `Strings` in P0 — until then, these).
 */

export const T = {
  appName: 'R2M POS',
  demoBadge: 'מצב הדגמה — שום דבר כאן אינו מסמך אמיתי',
  sell: 'מכירה',
  shift: 'משמרת',
  caps: 'יכולות המכשיר',
  allDepartments: 'הכול',
  searchPlaceholder: 'חיפוש מוצר',
  cart: 'סל',
  cartEmpty: 'הסל ריק — בחרו מוצר',
  items: 'פריטים',
  total: 'סה״כ',
  vatIncluded: 'כולל מע״מ',
  pay: 'לתשלום',
  clear: 'ניקוי',
  remove: 'הסרה',
  discount: 'הנחה',
  toPay: 'לתשלום',
  paid: 'שולם',
  due: 'יתרה',
  change: 'עודף',
  cashExact: 'מזומן מדויק',
  cash: 'מזומן',
  card: 'אשראי',
  cancel: 'ביטול',
  back: 'חזרה',
  cardWaiting: 'ממתין למסופון… העבירו או הצמידו כרטיס',
  saleDone: 'המכירה הושלמה',
  newSale: 'מכירה חדשה',
  document: 'מסמך',
  shiftOpen: 'משמרת פתוחה',
  shiftClosed: 'המשמרת סגורה',
  openShift: 'פתיחת משמרת',
  closeShift: 'סגירת משמרת',
  openingCash: 'קופה פותחת',
  countedCash: 'מזומן שנספר',
  xReport: 'דוח X',
  zReport: 'דוח Z',
  sales: 'מכירות',
  expectedCash: 'מזומן צפוי במגירה',
  difference: 'הפרש',
  locked: 'הקופה נעולה',
  enterCode: 'הקלידו קוד עובד',
  login: 'כניסה',
  logout: 'נעילה',
  engineStarting: 'מנוע הקופה עולה…',
  engineOffline: 'אין חיבור למנוע הקופה — לא מוכרים עד שהוא חוזר',
  updateRequired: 'נדרש עדכון — המסך והמנוע בגרסאות שונות. לא מוכרים עד העדכון.',
  close: 'סגירה',
  online: 'מחובר',
  offline: 'לא מחובר',
  printer: 'מדפסת',
  terminal: 'מסופון',
} as const;

/** Agorot → "₪1,234.50" (the shekel sign before, as on the till's screens). */
export function money(agorot: number): string {
  const neg = agorot < 0;
  const abs = Math.abs(Math.round(agorot));
  const shekels = Math.floor(abs / 100);
  const cents = abs % 100;
  const whole = String(shekels).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}₪${whole}.${cents < 10 ? '0' : ''}${cents}`;
}

/** Cash a customer is likely to hand over for `due`: the next round notes (₪20, ₪50, ₪100, ₪200). */
export function quickCash(dueAgorot: number): number[] {
  if (dueAgorot <= 0) return [];
  const out: number[] = [];
  for (const note of [2_000, 5_000, 10_000, 20_000]) {
    const v = Math.ceil(dueAgorot / note) * note;
    if (v > dueAgorot && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 3);
}
