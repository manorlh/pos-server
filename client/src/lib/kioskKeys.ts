/**
 * The kiosk's own keyboard, as a model (the shared `preview-entry.tsx` draws it, on the dashboard's
 * live preview and on the Windows kiosk): a customer on a kiosk never gets the system's touch
 * keyboard. A 1:1 port of the Android kiosk's domain/KioskKeys.kt — Hebrew as on a standard
 * Israeli keyboard, English QWERTY, a page of digits and signs, and a digits-only pad for the
 * phone, the table and a tip amount. Both sides are pinned by the shared fixture
 * kiosk_keyboard_layout.json (kiosk-desktop/test/fixtures, an equal copy in pos-android).
 *
 * Pure TypeScript (no React): shared through `@/kiosk-shared` like `kioskConfig.ts`.
 */

import type { KioskTextKey } from './kioskConfig';

export type KioskKeyLang = 'he' | 'en';

/** What one key does. `type` types its text exactly as given (a final letter stays the one pressed). */
export type KioskKey =
  | { kind: 'type'; text: string }
  | { kind: 'space' }
  | { kind: 'backspace' }
  | { kind: 'shift' }
  | { kind: 'lang' }
  | { kind: 'page' };

export const KEY = {
  type: (text: string): KioskKey => ({ kind: 'type', text }),
  space: { kind: 'space' } as KioskKey,
  /** Deletes the last character (held: again and again). */
  backspace: { kind: 'backspace' } as KioskKey,
  /** English only: the next letter upper case. */
  shift: { kind: 'shift' } as KioskKey,
  /** To the other language ("English" while Hebrew is on, "עברית" while English is). */
  lang: { kind: 'lang' } as KioskKey,
  /** "123" and back to the letters. */
  page: { kind: 'page' } as KioskKey,
} as const;

/** A key on a row, `width` in key units (a letter is 1, a full row KEY_UNITS). */
export interface KioskKeyCap {
  key: KioskKey;
  width: number;
}

/** What the keyboard shows. It changes on the toggles (and English's shift), never per letter. */
export interface KioskKeyPage {
  lang: KioskKeyLang;
  numbers: boolean;
  shift: boolean;
}

/** The Israeli keyboard's letter rows, left to right, with ' and - for names (ג'ני, בן-דוד). */
export const HEBREW_ROWS = ["קראטוןםפ'-", 'שדגכעיחלךף', 'זסבהנמצתץ'];
export const ENGLISH_ROWS = ['qwertyuiop', 'asdfghjkl', "zxcvbnm'-"];
/** "123": the digits and the signs a name or a note may need. */
export const SIGN_ROWS = ['1234567890', `-'".,?!&()`, '@#/:+*%'];
/** The phone / table / amount pad, left to right; "" an empty place. */
export const DIGIT_ROWS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', 'BACKSPACE'],
];

/** A full row's width in letters. */
export const KEY_UNITS = 10;

/** How long each field may be (the Android kiosk's KioskCustomer.NAME_MAX and KioskKeyboardLayout). */
export const KEY_LIMITS = { name: 30, phone: 10, table: 8, search: 40 } as const;
/** "הערות למנה" on the product sheet. */
export const NOTE_MAX = 80;

const chars = (s: string): KioskKeyCap[] => Array.from(s, (c) => ({ key: KEY.type(c), width: 1 }));

/**
 * The three character rows for `page`, always left to right — the Israeli keyboard's ק is at the
 * top left in Hebrew too, whatever the screen's direction. English starts its third row with the
 * shift.
 */
export function keyRows(page: Pick<KioskKeyPage, 'lang' | 'numbers'>): KioskKeyCap[][] {
  if (page.numbers) return SIGN_ROWS.map(chars);
  if (page.lang === 'he') return HEBREW_ROWS.map(chars);
  return [chars(ENGLISH_ROWS[0]), chars(ENGLISH_ROWS[1]), [{ key: KEY.shift, width: 1 }, ...chars(ENGLISH_ROWS[2])]];
}

/**
 * The bottom row, from the screen's start to its end (in Hebrew from the right): the other
 * language, 123, the space, the backspace.
 */
export const BOTTOM_ROW: KioskKeyCap[] = [
  { key: KEY.lang, width: 2 },
  { key: KEY.page, width: 1.5 },
  { key: KEY.space, width: 4.5 },
  { key: KEY.backspace, width: 2 },
];

/** The words on the special keys are kiosk texts (the built-ins as in the shared fixture). */
export function langTextKey(page: Pick<KioskKeyPage, 'lang'>): KioskTextKey {
  return page.lang === 'he' ? 'kbToEnglish' : 'kbToHebrew';
}

export function pageTextKey(page: Pick<KioskKeyPage, 'lang' | 'numbers'>): KioskTextKey {
  if (!page.numbers) return 'kbNumbers';
  return page.lang === 'he' ? 'kbLettersHe' : 'kbLettersEn';
}

export const SPACE_TEXT_KEY: KioskTextKey = 'kbSpace';

/** What a key shows on `page`: an English letter upper case while shifted. Null for the special keys. */
export function keyLabel(key: KioskKey, page: KioskKeyPage): string | null {
  if (key.kind !== 'type') return null;
  return page.shift && page.lang === 'en' && !page.numbers ? key.text.toUpperCase() : key.text;
}

const RTL_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;
/** Hebrew punctuation that is itself right-to-left (maqaf, paseq, sof pasuq, nun hafukha, geresh, gershayim). */
const RTL_MARKS = /[־׀׃׆׳״]/u;

/** The text's direction by its first strong letter: true right-to-left, false left-to-right, null none yet. */
export function firstStrongRtl(text: string): boolean | null {
  for (const c of text) {
    if (RTL_MARKS.test(c) || (LETTER.test(c) && RTL_SCRIPT.test(c))) return true;
    if (LETTER.test(c)) return false;
  }
  return null;
}

/** The keyboard a field opens on: the language of what is in it, else the screen's (RTL: Hebrew). */
export function langFor(text: string, rtlScreen: boolean): KioskKeyLang {
  const rtl = firstStrongRtl(text);
  if (rtl === true) return 'he';
  if (rtl === false) return 'en';
  return rtlScreen ? 'he' : 'en';
}

/**
 * The text being typed and the keyboard's page. `digits`: the digits pad (digits and the backspace
 * only). `capitalizeWords`: a name — each English word starts upper case on its own.
 */
export interface KioskKeyboardState {
  text: string;
  lang: KioskKeyLang;
  numbers: boolean;
  shift: boolean;
  max: number;
  digits: boolean;
  capitalizeWords: boolean;
}

export function pageOf(s: KioskKeyboardState): KioskKeyPage {
  return { lang: s.lang, numbers: s.numbers, shift: s.shift && s.lang === 'en' && !s.numbers };
}

/** After a change: shifted only where a name's English word starts (a shift by hand was used up). */
function autoShift(s: KioskKeyboardState): KioskKeyboardState {
  return { ...s, shift: s.capitalizeWords && s.lang === 'en' && !s.numbers && (s.text === '' || s.text.endsWith(' ')) };
}

const DIGITS_ONLY = /^[0-9]+$/;

function typeText(s: KioskKeyboardState, t: string): KioskKeyboardState {
  if (t === '' || s.text.length + t.length > s.max) return s;
  if (s.digits && !DIGITS_ONLY.test(t)) return s;
  const typed = pageOf(s).shift ? t.toUpperCase() : t;
  return autoShift({ ...s, text: s.text + typed, shift: false });
}

export function press(s: KioskKeyboardState, key: KioskKey): KioskKeyboardState {
  switch (key.kind) {
    case 'type':
      return typeText(s, key.text);
    case 'backspace':
      return s.text === '' ? s : autoShift({ ...s, text: s.text.slice(0, -1) });
    case 'space':
      // Never a space first or two in a row (the name is trimmed anyway).
      if (s.digits || s.text === '' || s.text.endsWith(' ') || s.text.length >= s.max) return s;
      return autoShift({ ...s, text: `${s.text} ` });
    case 'shift':
      return s.lang === 'en' && !s.numbers ? { ...s, shift: !s.shift } : s;
    case 'lang':
      return autoShift({ ...s, lang: s.lang === 'he' ? 'en' : 'he', numbers: false, shift: false });
    case 'page':
      return autoShift({ ...s, numbers: !s.numbers });
  }
}

/** A field's keyboard as it opens: `text` cut to `max`, in `lang`, shifted when a name starts. */
export function startKeyboard(text: string, lang: KioskKeyLang, max: number, digits = false, capitalizeWords = false): KioskKeyboardState {
  const clean = digits ? text.replace(/[^0-9]/g, '') : text;
  return autoShift({ text: clean.slice(0, max), lang, numbers: false, shift: false, max, digits, capitalizeWords });
}
