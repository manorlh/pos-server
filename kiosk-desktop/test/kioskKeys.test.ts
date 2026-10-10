import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOTTOM_ROW,
  DIGIT_ROWS,
  KEY,
  KEY_LIMITS,
  KEY_UNITS,
  firstStrongRtl,
  keyLabel,
  keyRows,
  langFor,
  langTextKey,
  pageOf,
  pageTextKey,
  press,
  SPACE_TEXT_KEY,
  start,
  type KioskKey,
  type KioskKeyCap,
  type KioskKeyboardState,
} from '../src/core/kioskKeys';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'kiosk_keyboard_layout.json'), 'utf8')) as {
  rows: { he: string[][]; en: string[][]; signs: string[][] };
  bottom: string[];
  digits: string[][];
  labels: Record<string, string>;
  limits: Record<string, number>;
};
const he = JSON.parse(readFileSync(path.join(here, '..', '..', 'client', 'src', 'messages', 'he.json'), 'utf8')) as {
  kiosks: { builtin: Record<string, string>; texts?: Record<string, string>; fields: { texts: Record<string, string> } };
};

/** A key as the fixture writes it: a character as itself, a special one NAME:width. */
const cell = (c: KioskKeyCap) => (c.key.kind === 'type' ? c.key.text : `${c.key.kind.toUpperCase()}:${c.width}`);
const rowsOf = (page: { lang: 'he' | 'en'; numbers: boolean }) => keyRows(page).map((r) => r.map(cell));
const typeAll = (s: KioskKeyboardState, text: string) => Array.from(text).reduce((st, c) => press(st, c === ' ' ? KEY.space : KEY.type(c)), s);
const pressAll = (s: KioskKeyboardState, ...keys: KioskKey[]) => keys.reduce(press, s);

describe('the kiosk keyboard (the Android kiosk’s KioskKeys.kt, pinned by kiosk_keyboard_layout.json)', () => {
  it('has the fixture’s rows: Hebrew, English, the signs, the bottom row and the digits pad', () => {
    expect(rowsOf({ lang: 'he', numbers: false })).toEqual(fixture.rows.he);
    expect(rowsOf({ lang: 'en', numbers: false })).toEqual(fixture.rows.en);
    expect(rowsOf({ lang: 'he', numbers: true })).toEqual(fixture.rows.signs);
    expect(rowsOf({ lang: 'en', numbers: true })).toEqual(fixture.rows.signs);
    expect(BOTTOM_ROW.map(cell)).toEqual(fixture.bottom);
    expect(DIGIT_ROWS).toEqual(fixture.digits);
  });

  it('the first row and the bottom row are a full row wide (10 units)', () => {
    for (const page of [{ lang: 'he' as const, numbers: false }, { lang: 'en' as const, numbers: false }, { lang: 'en' as const, numbers: true }]) {
      expect(keyRows(page)[0].reduce((s, c) => s + c.width, 0)).toBe(KEY_UNITS);
    }
    expect(BOTTOM_ROW.reduce((s, c) => s + c.width, 0)).toBe(KEY_UNITS);
  });

  it('its words are kiosk texts whose built-ins are the fixture’s, each with an editor label', () => {
    for (const [key, value] of Object.entries(fixture.labels)) {
      expect(he.kiosks.builtin[key], key).toBe(value);
      expect(typeof he.kiosks.fields.texts[key], key).toBe('string');
    }
    // The language key names the OTHER language; the page key the way back to the letters.
    expect(langTextKey({ lang: 'he' })).toBe('kbToEnglish');
    expect(langTextKey({ lang: 'en' })).toBe('kbToHebrew');
    expect(pageTextKey({ lang: 'he', numbers: false })).toBe('kbNumbers');
    expect(pageTextKey({ lang: 'he', numbers: true })).toBe('kbLettersHe');
    expect(pageTextKey({ lang: 'en', numbers: true })).toBe('kbLettersEn');
    expect(SPACE_TEXT_KEY).toBe('kbSpace');
  });

  it('has the fixture’s limits', () => {
    expect(KEY_LIMITS).toEqual(fixture.limits);
  });

  it('toggles the language (back to the letters) and the signs page', () => {
    const s = start('', 'he', 30);
    const en = press(s, KEY.lang);
    expect(en.lang).toBe('en');
    const signs = press(en, KEY.page);
    expect(signs.numbers).toBe(true);
    expect(pageTextKey(pageOf(signs))).toBe('kbLettersEn');
    expect(press(signs, KEY.lang)).toMatchObject({ lang: 'he', numbers: false });
    expect(press(press(s, KEY.page), KEY.page).numbers).toBe(false);
  });

  it('types the final letters exactly as pressed, and deletes the last character', () => {
    let s = typeAll(start('', 'he', 30), 'שלום ך');
    expect(s.text).toBe('שלום ך');
    s = press(s, KEY.type('ם'));
    expect(s.text).toBe('שלום ךם');
    s = pressAll(s, KEY.backspace, KEY.backspace);
    expect(s.text).toBe('שלום ');
    expect(press(start('', 'he', 30), KEY.backspace).text).toBe('');
    expect(typeAll(start('', 'he', 30), "ג'ני בן-דוד").text).toBe("ג'ני בן-דוד");
  });

  it('never a space first, never two in a row', () => {
    const s = start('', 'he', 30);
    expect(press(s, KEY.space).text).toBe('');
    expect(pressAll(s, KEY.type('א'), KEY.space, KEY.space).text).toBe('א ');
  });

  it('stops at the field’s length', () => {
    const s = typeAll(start('', 'he', 3), 'אבגד');
    expect(s.text).toBe('אבג');
    expect(press(s, KEY.space).text).toBe('אבג');
    expect(start('abcdef', 'en', 4).text).toBe('abcd');
    expect(typeAll(start('', 'he', KEY_LIMITS.name), 'א'.repeat(40)).text).toHaveLength(30);
  });

  it('a name: each English word starts upper case on its own; a shift by hand is used up', () => {
    let s = start('', 'en', KEY_LIMITS.name, false, true);
    expect(pageOf(s).shift).toBe(true);
    s = typeAll(s, 'dana levi');
    expect(s.text).toBe('Dana Levi');
    const plain = press(press(start('', 'en', 30), KEY.shift), KEY.type('a'));
    expect(plain.text).toBe('A');
    expect(plain.shift).toBe(false);
    expect(press(plain, KEY.type('b')).text).toBe('Ab');
    // Hebrew has no shift; on the signs page neither.
    expect(press(start('', 'he', 30), KEY.shift).shift).toBe(false);
    expect(press(press(start('', 'en', 30), KEY.page), KEY.shift).shift).toBe(false);
    expect(keyLabel(KEY.type('q'), { lang: 'en', numbers: false, shift: true })).toBe('Q');
    expect(keyLabel(KEY.space, { lang: 'en', numbers: false, shift: true })).toBeNull();
  });

  it('the digits pad takes digits only, no space', () => {
    let s = start('05a2-1', 'en', KEY_LIMITS.phone, true);
    expect(s.text).toBe('0521');
    s = pressAll(s, KEY.type('x'), KEY.space, KEY.type('9'));
    expect(s.text).toBe('05219');
    expect(typeAll(start('', 'en', KEY_LIMITS.table, true), '1234567890').text).toBe('12345678');
  });

  it('opens on the language of what is typed, else the screen’s', () => {
    expect(firstStrongRtl('123 דנה')).toBe(true);
    expect(firstStrongRtl('12 Dana')).toBe(false);
    expect(firstStrongRtl('123')).toBeNull();
    expect(langFor('', true)).toBe('he');
    expect(langFor('', false)).toBe('en');
    expect(langFor('Dana', true)).toBe('en');
    expect(langFor('דנה', false)).toBe('he');
  });
});
