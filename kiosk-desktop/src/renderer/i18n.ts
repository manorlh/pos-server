/**
 * The kiosk's words. The screens' own texts (`texts.*`) and the preview's labels come from the
 * dashboard's he.json (virtual:kiosk-strings), so the preview and the kiosk say the same thing;
 * the rest — the real payment, the details, the staff screens — are the Android kiosk's Hebrew
 * strings (pos-android res/values/strings_kiosk_app.xml).
 */

import strings from 'virtual:kiosk-strings';
import type { KioskTextKey } from '@dash-lib/kioskConfig';

const builtin = strings.builtin as Record<string, string>;
const preview = strings.preview as Record<string, unknown>;

/** The live kiosk's own words (Android's kapp_* strings). */
export const LIVE: Record<string, string> = {
  // (The live pay / success / back words the shared screens ask are in he.json kiosks.preview.)
  payBlockedTerminal: 'מסופון האשראי לא זמין כרגע. אנא פנו לצוות.',
  detailsTitle: 'עוד רגע תשלום',
  nameLabel: 'שם לקריאה בדלפק',
  nameHint: 'השם שנקרא כשההזמנה מוכנה',
  phoneLabel: 'טלפון',
  phoneInvalid: 'מספר הטלפון לא תקין',
  tableLabel: 'מספר שולחן / שלט',
  tipTitle: 'טיפ לצוות',
  tipNone: 'בלי טיפ',
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
  basketOk: 'הבנתי, להמשיך',
  helpSent: 'קראנו לצוות — מישהו יגיע אליכם בקרוב',
  setupTitle: 'מכינים את הקיוסק',
  setupBody: 'הקיוסק מחובר לענן ומחכה להגדרות. זה ייקח רגע.',
  waitingTitle: 'הקופה מצומדת',
  waitingBody: 'הקיוסק יתחיל לפעול כשיוגדר בדשבורד כקיוסק (קיוסקים ← "הפוך קופה לקיוסק").',
  notePlaceholder: 'הערה למטבח…',
  staffOffline: 'אין אינטרנט',
  staffTerminal: 'המסופון לא זמין',
  staffBons: 'בונים לא הודפסו',
  staffPrinter: 'תקלת מדפסת',
  staffCard: 'תשלום לבירור',
  poweredBy: 'POWERED BY R2M POS',
};

function lookup(path: string): string | null {
  if (LIVE[path] !== undefined) return LIVE[path];
  let cur: unknown = preview;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : null;
}

/** `{name}`-style values (the next-intl messages' simple placeholders). */
export function t(key: string, values?: Record<string, string | number>): string {
  const s = lookup(key) ?? key;
  if (!values) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] === undefined ? m : String(values[k])));
}

/** A screen text: the config's own (`texts.*`), else the built-in one. */
export function txtOf(texts: Partial<Record<KioskTextKey, string>> | undefined, key: KioskTextKey): string {
  return texts?.[key] || builtin[key] || key;
}

const money = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 });

/** Shekels for display, exactly as the dashboard preview's formatCurrency. */
export function formatMoney(shekels: number): string {
  return money.format(shekels);
}
