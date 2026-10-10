/**
 * The till's Hebrew texts and money format (one place). Where the Android till has the screen, its sentence is used
 * word for word (pos-android res/values/strings*.xml); the real strings come from the APK's XML through the engine's
 * `Strings` in P0 — until then, these.
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
  // ── the Android till's own words ──
  loginTitle: 'הזן קוד אישי',
  loginSignIn: 'כניסה',
  searchOrScan: 'חיפוש או סריקה',
  emptyCatalog: 'אין מוצרים. סנכרן את הקטלוג מההגדרות.',
  noMatch: 'לא נמצאו תוצאות לחיפוש.',
  barEmpty: 'הוסף מוצרים לגבייה',
  cartClear: 'נקה',
  charge: 'לתשלום',
  amountDue: 'סכום לתשלום',
  fastCash: 'מזומן מהיר',
  cashWithChange: 'מזומן עם עודף',
  cashChangeCaption: 'סכום אחר · חישוב עודף',
  cardPay: 'אשראי',
  tendered: 'התקבל',
  changeLabel: 'עודף',
  changeToCustomer: 'עודף ללקוח',
  missing: 'חסר',
  confirmCash: 'אשר תשלום מזומן',
  checkoutBack: 'חזרה לסל',
  paidSoFar: 'התקבל עד כה',
  remaining: 'נותר לתשלום',
  splitProgress: (paid: string, left: string) => `התקבל ${paid} · נותר ${left}`,
  takePartial: (paid: string, left: string) => `קבל ${paid} במזומן — יישאר ${left}`,
  insufficient: 'הסכום שהתקבל קטן מהסכום לתשלום',
  checkoutCancel: 'בטל',
  checkoutCancelPayment: 'בטל תשלום',
  retry: 'נסה שוב',
  done: 'המכירה הושלמה',
  newSaleBtn: 'מכירה חדשה',
  printCopy: 'הדפס העתק',
  printRetry: 'הדפס שוב',
  askPrint: 'להדפיס חשבונית?',
  askPrintYes: 'הדפס',
  askPrintNo: 'בלי הדפסה',
  checkoutItems: (n: number) => `${n} פריטים`,
  noShift: 'אין משמרת פתוחה',
  noShiftBlocksSale: 'לא ניתן לגבות לפני פתיחת משמרת.',
  openShiftWhy: 'כל מכירה משויכת למשמרת הפתוחה ונכללת בדו״ח X שלה.',
  shiftNone: 'אין משמרת פתוחה. לא ניתן למכור עד שתיפתח משמרת.',
  shiftTitle: 'משמרת',
  shiftNumber: (n: number | string) => `משמרת #${n}`,
  shiftCloseSection: 'סגירת משמרת',
  shiftCloseNote: 'הסגירה סופרת את הקופה, מדפיסה דו״ח X ושולחת את המשמרת לענן. דו״ח Z מופק בענן. אפשר לפתוח משמרת חדשה מיד, גם בלי חיבור.',
  shiftCloseNoteTill: 'הסגירה סופרת את הקופה, מדפיסה דו״ח X ושולחת את המשמרת לענן. דו״ח Z מופק בקופה, בלחיצה על ״הפק Z״. אפשר לפתוח משמרת חדשה מיד, גם בלי חיבור.',
  produceZ: 'הפק Z',
  zTitle: 'הפקת דו״ח Z',
  zConfirmNote: 'דו״ח Z מסכם את יום העסקים ומקבל מספר מהענן. נדרש חיבור לאינטרנט.',
  closeAndProduceZ: 'סגירת משמרת והפקת Z',
  zConfirmOpenShift: (n: number | string) => `משמרת #${n} פתוחה. היא תיסגר קודם: ספירת הקופה והדפסת דו״ח X, ואז יופק דו״ח Z.`,
  openingFloat: 'קופה פותחת',
  menu: 'תפריט',
  history: 'היסטוריה',
  signOut: 'יציאה מהמשתמש',
  switchUser: 'החלפת משתמש',
  soon: 'בקרוב',
  soldOutBadge: 'אזל',
  blockedBadge: 'חסום',
  unavailableBadge: 'לא זמין',
  workModeBanner: 'מצב קופה — הקיוסק מושבת ללקוחות',
  workModeCountdown: (n: number) => `חוזר לקיוסק בעוד ${n} שניות`,
  workModeStay: 'נשארים',
  cardUnknownHelp: 'עסקת האשראי לא הוכרעה. אין לגבות שוב לפני בירור.',
  recheck: 'בדוק שוב',
  markNotApproved: 'סמן כלא אושר והמשך',
  cancelling: 'מבטל… ממתין לתשובת המסוף',
  historyEmpty: 'אין מסמכים היום',
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
