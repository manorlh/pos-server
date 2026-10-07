/**
 * The browser kiosk's words (`/k`), exactly as the Windows kiosk's renderer/i18n.ts: the screens'
 * own texts (`texts.*`) and the preview's labels from the dashboard's he.json (`kiosks.builtin`,
 * `kiosks.preview` — the same messages the live preview reads), and the live kiosk's own words
 * (the Android kiosk's kapp_* strings), plus what only a browser kiosk says.
 */

import type { KioskTextKey } from '@/lib/kioskConfig';

/** The live kiosk's own words (as kiosk-desktop/src/renderer/i18n.ts LIVE), and the browser's. */
export const LIVE: Record<string, string> = {
  detailsTitle: 'עוד רגע תשלום',
  continue: 'המשך',
  required: 'חובה',
  idleTitle: 'עדיין כאן?',
  idleBody: 'ההזמנה תתבטל בעוד {n} שניות',
  idleContinue: 'המשך הזמנה',
  idleCancel: 'ביטול ההזמנה',
  leaveTitle: 'לבטל את ההזמנה?',
  leaveBody: 'הפריטים שבחרתם יימחקו.',
  leaveYes: 'כן, לבטל',
  leaveNo: 'להמשיך בהזמנה',
  basketChangedTitle: 'משהו השתנה בהזמנה',
  basketRemoved: 'אזל מאז שהוזמן והוסר: {name}',
  basketRepriced: 'המחיר עודכן: {name}',
  basketNewTotal: 'הסכום לתשלום עכשיו: {total}',
  basketOk: 'הבנתי, להמשיך',
  helpSent: 'קראנו לצוות — מישהו יגיע אליכם בקרוב',
  setupTitle: 'מכינים את הקיוסק',
  setupBody: 'הקיוסק מחובר לענן ומחכה להגדרות. זה ייקח רגע.',
  poweredBy: 'POWERED BY R2M POS',
  // The browser kiosk.
  waitingTitle: 'המכשיר מצומד',
  waitingBody: 'מחכים להגדרות הקיוסק מהענן. אם זה נמשך, ודאו בדשבורד (קיוסקים) שהקיוסק פעיל.',
  notKioskBody: 'המכשיר מצומד, אבל בענן הוא לא מוגדר כקיוסק פעיל. הפעילו אותו בדשבורד ← קיוסקים.',
  loading: 'טוען את הקיוסק…',
  cardOffBrowser: 'לא זמין בקיוסק בדפדפן',
  // "גשר לדפדפן" (§28): the card and the printer through R2M POS for Windows on this PC.
  cardWithVoucher: 'אשראי לא משולב עם שובר — היתרה בקופה',
  bridgeNoAnswer: 'מסופון האשראי לא זמין כרגע. אנא פנו לצוות.',
  bridgeFoundTitle: 'נמצא גשר R2M ל-Windows במחשב',
  bridgeFoundBody: 'כדי לשלם באשראי ולהדפיס מהקיוסק, הקלידו את הקוד שמוצג בחלון הגשר (סמל R2M ליד השעון).',
  bridgeLater: 'לא עכשיו',
  bridgePair: 'צימוד',
  voucherOffline: 'תשלום בשובר אינו זמין כרגע — אין חיבור לרשת',
  placing: 'שולחים את ההזמנה לקופה…',
  placeFailed: 'ההזמנה לא נשלחה. נסו שוב או פנו לצוות.',
  voucherCamera: 'סריקת שובר במצלמה',
  voucherCameraHint: 'כוונו את המצלמה לברקוד שעל השובר',
  voucherCameraDenied: 'אין גישה למצלמה. אפשר להקליד את קוד השובר.',
  voucherAppliedNote: 'השובר נקלט · {amount}',
  voucherChecking: 'בודקים את השובר…',
  voucherForfeitYes: 'לממש בכל זאת',
  voucherForfeitNo: 'לא, תודה',
  close: 'סגירה',
  // The voucher's answers (the till's prepaid_reason_* in short).
  'voucher.prepaid_voucher_not_found': 'השובר לא נמצא',
  'voucher.prepaid_voucher_used': 'השובר כבר מומש',
  'voucher.prepaid_voucher_cancelled': 'השובר בוטל',
  'voucher.prepaid_voucher_expired': 'תוקף השובר פג',
  'voucher.prepaid_voucher_not_yet_valid': 'השובר עדיין לא בתוקף',
  'voucher.prepaid_voucher_wrong_shop': 'השובר אינו תקף בסניף הזה',
  'voucher.prepaid_voucher_partial_not_allowed': 'שובר חד-פעמי: יש לממש את כולו בבת אחת',
  'voucher.prepaid_voucher_insufficient': 'לא נשאר בשובר מספיק',
  'voucher.prepaid_voucher_item_not_on_voucher': 'הפריט אינו כלול בשובר',
  'voucher.other': 'השובר לא נקלט. אפשר לנסות שוב או לשלם בקופה.',
};

export interface KioskWords {
  /** The preview's labels and the live words: `{name}`-style values. */
  t: (key: string, values?: Record<string, string | number>) => string;
  /** A built-in screen text (`kiosks.builtin`) when the business set none. */
  builtin: (key: KioskTextKey) => string;
}

function lookup(tree: unknown, path: string): string | null {
  let cur: unknown = tree;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : null;
}

function fill(s: string, values?: Record<string, string | number>): string {
  if (!values) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] === undefined ? m : String(values[k])));
}

/** The words from the dashboard's messages (next-intl's `useMessages()`: the whole he.json). */
export function kioskWords(messages: Record<string, unknown> | null | undefined): KioskWords {
  const kiosks = (messages?.kiosks ?? {}) as { builtin?: Record<string, string>; preview?: Record<string, unknown> };
  const builtin = kiosks.builtin ?? {};
  const preview = kiosks.preview ?? {};
  return {
    t: (key, values) => fill(LIVE[key] ?? lookup(preview, key) ?? key, values),
    builtin: (key) => builtin[key] || key,
  };
}

/** The voucher's refusal in words (`prepaid_voucher_used` → "השובר כבר מומש"). */
export function voucherReason(words: KioskWords, reason: string): string {
  const key = `voucher.${reason}`;
  return LIVE[key] ? words.t(key) : words.t('voucher.other');
}

const money = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 });

/** Shekels for display, exactly as the dashboard preview's formatCurrency. */
export function formatMoney(shekels: number): string {
  return money.format(shekels);
}
