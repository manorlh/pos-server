/**
 * The public legal / consent / accessibility components' own words, in Hebrew (RTL) and English
 * (LTR). Kept here — not in next-intl — so every public page can use the components without the
 * dashboard's message bundle, and the component tests render them in Node.
 */
import type { PublicLang } from '../../lib/legalDocs';

export type { PublicLang };

export function dirOf(lang: PublicLang): 'rtl' | 'ltr' {
  return lang === 'he' ? 'rtl' : 'ltr';
}

export const STRINGS = {
  he: {
    skipToContent: 'דלג לתוכן',
    footerLabel: 'מידע משפטי ונגישות',
    cookieSettings: 'הגדרות עוגיות',
    consentTitle: 'עוגיות ופרטיות',
    consentBody:
      'אנחנו משתמשים בעוגיות חיוניות כדי שהאתר יעבוד. עוגיות סטטיסטיקה ושיווק מופעלות רק אם תאשרו. אפשר לשנות את הבחירה בכל עת בקישור "הגדרות עוגיות" בתחתית העמוד.',
    acceptAll: 'אישור הכול',
    essentialOnly: 'רק חיוניות',
    customize: 'בחירה לפי סוג',
    save: 'שמירת הבחירה',
    close: 'סגירה',
    revoke: 'ביטול כל ההסכמות',
    cookiePolicy: 'מדיניות העוגיות',
    categories: {
      essential: { title: 'חיוניות', body: 'הסל, השפה, הגדרות הנגישות ושמירת הבחירה הזו. תמיד פעילות.' },
      analytics: { title: 'סטטיסטיקה', body: 'מידע על השימוש באתר (צפיות ולחיצות) כדי לשפר את התפריט.' },
      marketing: { title: 'שיווק', body: 'התאמת תוכן שיווקי.' },
    },
    alwaysOn: 'תמיד פעיל',
    on: 'פעיל',
    off: 'כבוי',
    savedNotice: 'הבחירה נשמרה.',
    a11yOpen: 'סרגל נגישות',
    a11yTitle: 'התאמות תצוגה',
    a11yFontSmaller: 'הקטנת טקסט',
    a11yFontReset: 'גודל רגיל',
    a11yFontLarger: 'הגדלת טקסט',
    a11yFontLevel: (n: number) => `גודל טקסט: ${n === 0 ? 'רגיל' : `+${n}`}`,
    a11yContrast: 'ניגודיות גבוהה',
    a11yLinks: 'הדגשת קישורים',
    a11yStill: 'עצירת אנימציות',
    a11yReset: 'איפוס',
    a11yNote: 'הסרגל הוא עזר נוסף בלבד ואינו מחליף את התאמת האתר לתקן הנגישות.',
    a11yStatement: 'להצהרת הנגישות',
    marketingLegend: 'דיוור שיווקי (רשות)',
    privacyLink: 'מדיניות הפרטיות',
    contrastTitle: 'בדיקת ניגודיות (WCAG AA)',
    contrastPass: 'עובר',
    contrastFail: 'לא עובר',
    contrastInvalid: 'צבע לא תקין',
    contrastSample: 'דוגמה',
    contrastRatio: 'יחס',
    contrastResult: 'תוצאה',
    contrastBlocked: 'לא ניתן לפרסם: יש צבעים שאינם עומדים בניגודיות AA.',
    contrastOk: 'כל צבעי הערכה עומדים בניגודיות AA.',
    contrastPairs: {
      text_on_background: 'טקסט על רקע',
      text_on_surface: 'טקסט על כרטיס',
      button_text: 'טקסט על כפתור',
      link_on_background: 'קישור / צבע ראשי על רקע',
      focus_on_background: 'מסגרת פוקוס על רקע',
      muted_text_on_background: 'טקסט משני על רקע',
      accent_on_background: 'צבע הדגשה על רקע',
    } as Record<string, string>,
    loading: 'טוען…',
    unavailable: 'הדף אינו זמין כרגע.',
    retry: 'נסו שוב',
    publishedOn: (date: string, version: number) => `גרסה ${version} · עודכן ${date}`,
  },
  en: {
    skipToContent: 'Skip to content',
    footerLabel: 'Legal and accessibility',
    cookieSettings: 'Cookie settings',
    consentTitle: 'Cookies and privacy',
    consentBody:
      'We use essential cookies so the site works. Statistics and marketing cookies are used only if you allow them. You can change your choice at any time from "Cookie settings" at the bottom of the page.',
    acceptAll: 'Accept all',
    essentialOnly: 'Essential only',
    customize: 'Choose by type',
    save: 'Save my choice',
    close: 'Close',
    revoke: 'Withdraw all consent',
    cookiePolicy: 'Cookie policy',
    categories: {
      essential: { title: 'Essential', body: 'Your cart, language, accessibility settings and this choice. Always on.' },
      analytics: { title: 'Statistics', body: 'How the site is used (views and clicks), to improve the menu.' },
      marketing: { title: 'Marketing', body: 'Personalised marketing content.' },
    },
    alwaysOn: 'Always on',
    on: 'On',
    off: 'Off',
    savedNotice: 'Your choice was saved.',
    a11yOpen: 'Accessibility toolbar',
    a11yTitle: 'Display adjustments',
    a11yFontSmaller: 'Smaller text',
    a11yFontReset: 'Normal size',
    a11yFontLarger: 'Larger text',
    a11yFontLevel: (n: number) => `Text size: ${n === 0 ? 'normal' : `+${n}`}`,
    a11yContrast: 'High contrast',
    a11yLinks: 'Highlight links',
    a11yStill: 'Stop animations',
    a11yReset: 'Reset',
    a11yNote: 'This toolbar is an extra aid only; it does not replace making the site conform to the accessibility standard.',
    a11yStatement: 'Accessibility statement',
    marketingLegend: 'Marketing messages (optional)',
    privacyLink: 'Privacy policy',
    contrastTitle: 'Contrast check (WCAG AA)',
    contrastPass: 'Pass',
    contrastFail: 'Fail',
    contrastInvalid: 'Invalid colour',
    contrastSample: 'Sample',
    contrastRatio: 'Ratio',
    contrastResult: 'Result',
    contrastBlocked: 'Cannot publish: some colours are below AA contrast.',
    contrastOk: 'All theme colours meet AA contrast.',
    contrastPairs: {
      text_on_background: 'Text on background',
      text_on_surface: 'Text on card',
      button_text: 'Button label',
      link_on_background: 'Link / primary on background',
      focus_on_background: 'Focus ring on background',
      muted_text_on_background: 'Secondary text on background',
      accent_on_background: 'Accent on background',
    } as Record<string, string>,
    loading: 'Loading…',
    unavailable: 'This page is not available right now.',
    retry: 'Try again',
    publishedOn: (date: string, version: number) => `Version ${version} · updated ${date}`,
  },
};

export type PublicStrings = (typeof STRINGS)['he'];

export function stringsFor(lang: PublicLang): PublicStrings {
  return STRINGS[lang] as PublicStrings;
}
