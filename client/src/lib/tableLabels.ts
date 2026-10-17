/**
 * "מספר שולחן עם אותיות" — table labels like "3B" (P:/specs/table-scope.md §6, §14.8; the owner's 16.10
 * decisions). The same rules as pos-server app/services/table_labels.py and pos-android
 * domain/TableLabels.kt, pinned by one fixture: server/tests/fixtures/table_label_sort_golden.json (the test
 * reads the server's copy).
 *
 * **What the field takes** (`parse`): "12" is the number 12; anything with a letter is a label. A label is at
 * most `LABEL_MAX` (12) characters of Hebrew and English letters, digits, spaces and "-" (no "/" or "."), with
 * at least one letter; English letters are kept in upper case ("3b" → "3B"); runs of spaces become one.
 *
 * **Unique by its normalised form** (`labelKey`): no spaces, no "-", upper case — "3-B" and "3B" cannot both
 * be live in a shop, and typing "3b" finds "3B".
 *
 * **Natural order** (`compareNatural`, `compareTables`): runs of digits as numbers, runs of letters by the
 * alphabet (Hebrew finals as their plain letters), digits before letters, English before Hebrew, spaces, "-"
 * and case ignored: 1, 2, 3, 3A, 3B, 10, 10A, A1, A2, A10, B1, תא 2. A table without a label is ordered by its
 * number as text, so 3 comes before 3A.
 *
 * **One title** (`tableTitle`): the label, else the number; with the name after it ("3B · VIP"); a table
 * shown by its name alone (`labelOnly`, "ש-12") is its name.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export const LABEL_MAX = 12;
export const NUMBER_MIN = 1;
export const NUMBER_MAX = 99_999;
/** "הוספת טווח": at most this many tables in one go (as the numbers' range). */
export const RANGE_MAX = 500;
/** The keypad's suggestions while typing (§6.3). */
export const SUGGESTIONS_MAX = 8;
/** Between the title and the table's name. */
export const SEPARATOR = ' · ';

/** Hebrew's final letters, read as their plain ones in the order (ך is כ). */
const FINALS: Record<string, string> = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
/** The alphabet a Hebrew range steps through (finals are not letters of their own there). */
export const HEBREW_ALPHABET = 'אבגדהוזחטיכלמנסעפצקרשת';
export const ENGLISH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Why a text is refused (the 422 `table_label_invalid` body's `reason`). */
export type LabelReason =
  | 'empty'
  | 'too_long'
  | 'characters'
  | 'no_letter'
  | 'number_range'
  | 'range_shape'
  | 'range_mixed'
  | 'range_too_many';

export const LABEL_REASONS: readonly LabelReason[] = [
  'empty',
  'too_long',
  'characters',
  'no_letter',
  'number_range',
  'range_shape',
  'range_mixed',
  'range_too_many',
];

/** A table number or label the rules refuse; `reason` is one of `LABEL_REASONS`. */
export class LabelError extends Error {
  readonly reason: LabelReason;

  constructor(reason: LabelReason) {
    super(reason);
    this.name = 'LabelError';
    this.reason = reason;
  }
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isEnglish = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
const isHebrew = (c: string) => c >= '\u05d0' && c <= '\u05ea';
const isLetter = (c: string) => isEnglish(c) || isHebrew(c);
const chars = (text: string): string[] => Array.from(text);

/** English letters in upper case; everything else as it is (Hebrew has no case). */
function upper(text: string): string {
  return chars(text)
    .map((c) => (c >= 'a' && c <= 'z' ? c.toUpperCase() : c))
    .join('');
}

/** Runs of white space as one space, none at the ends (Python's `" ".join(text.split())`). */
function squeezed(text: unknown): string {
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** "3-b" → "3B": no spaces, no "-", English in upper case. null for nothing. */
export function labelKey(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const key = chars(upper(String(label)))
    .filter((c) => c !== ' ' && c !== '-' && c !== '\t')
    .join('');
  return key || null;
}

/** What the field holds: a plain number, or a label with its key (and no number of its own). */
export interface Parsed {
  number: number | null;
  label: string | null;
  key: string | null;
}

const numberOnly = (n: number): Parsed => ({ number: n, label: null, key: null });

/**
 * "12" / 12 → the number 12; "3b" → the label "3B" (key "3B"). LabelError otherwise: `empty`, `number_range`
 * (a number outside 1–99,999), `characters` (anything but Hebrew / English letters, digits, space, "-"),
 * `no_letter` ("3-4"), `too_long` (over 12).
 */
export function parse(value: unknown): Parsed {
  if (typeof value === 'boolean') throw new LabelError('characters');
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < NUMBER_MIN || value > NUMBER_MAX) throw new LabelError('number_range');
    return numberOnly(value);
  }
  if (value === null || value === undefined) throw new LabelError('empty');
  const text = squeezed(value);
  if (!text) throw new LabelError('empty');
  if (chars(text).every(isDigit)) {
    const n = Number(text);
    if (!(n >= NUMBER_MIN && n <= NUMBER_MAX)) throw new LabelError('number_range');
    return numberOnly(n);
  }
  const label = upper(text);
  const list = chars(label);
  if (list.some((c) => !(isDigit(c) || isLetter(c) || c === ' ' || c === '-'))) throw new LabelError('characters');
  if (!list.some(isLetter)) throw new LabelError('no_letter');
  if (list.length > LABEL_MAX) throw new LabelError('too_long');
  return { number: null, label, key: labelKey(label) };
}

/** `parse` without the throw: the parsed value, or why it is refused. */
export function checkTableNumber(value: unknown): { parsed: Parsed; error: null } | { parsed: null; error: LabelReason } {
  try {
    return { parsed: parse(value), error: null };
  } catch (e) {
    if (e instanceof LabelError) return { parsed: null, error: e.reason };
    throw e;
  }
}

/** What the API takes for the parsed field (`POST /tables/tables`, `PATCH`): the number, else the label. */
export function fieldValue(parsed: Parsed): number | string {
  return parsed.label ?? (parsed.number as number);
}

// ── The natural order ─────────────────────────────────────────────────────────────────

type Token = { digits: true; value: string; length: number } | { digits: false; text: string };

function tokens(text: string): Token[] {
  const key = chars(labelKey(text) ?? '')
    .map((c) => FINALS[c] ?? c)
    .join('');
  const list = chars(key);
  const out: Token[] = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    if (isDigit(list[i])) {
      while (j < list.length && isDigit(list[j])) j += 1;
      const run = list.slice(i, j).join('');
      // The run's value without its leading zeros (compared by length, then digit by digit: any length).
      out.push({ digits: true, value: run.replace(/^0+/, ''), length: run.length });
    } else {
      while (j < list.length && !isDigit(list[j])) j += 1;
      out.push({ digits: false, text: list.slice(i, j).join('') });
    }
    i = j;
  }
  return out;
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

function compareToken(a: Token, b: Token): number {
  if (a.digits !== b.digits) return a.digits ? -1 : 1;
  if (a.digits && b.digits) {
    return cmp(a.value.length, b.value.length) || cmp(a.value, b.value) || cmp(a.length, b.length);
  }
  return cmp((a as { text: string }).text, (b as { text: string }).text);
}

/** The natural order's key of a number or a label, computed once (the server's `sort_key`). */
export interface SortKey {
  tokens: Token[];
  key: string;
}

export function sortKey(text: unknown): SortKey {
  const raw = String(text ?? '');
  return { tokens: tokens(raw), key: labelKey(raw) ?? '' };
}

export function compareSortKeys(a: SortKey, b: SortKey): number {
  const n = Math.min(a.tokens.length, b.tokens.length);
  for (let i = 0; i < n; i += 1) {
    const c = compareToken(a.tokens[i], b.tokens[i]);
    if (c) return c;
  }
  return cmp(a.tokens.length, b.tokens.length) || cmp(a.key, b.key);
}

/** "3" < "3A" < "10" < "A1" < "A10" < "B1" < "תא 2". */
export function compareNatural(a: unknown, b: unknown): number {
  return compareSortKeys(sortKey(a), sortKey(b));
}

/** What a table is called by: its label, else its number ("" for neither). */
export function shownOf(number: number | null | undefined, label: string | null | undefined): string {
  const text = (label ?? '').trim();
  if (text) return text;
  return number === null || number === undefined ? '' : String(number);
}

/** A table, as far as its place in the order goes. */
export interface Numbered {
  number?: number | null;
  label?: string | null;
}

/** A table's place in the natural order: by what it is called, then (two "3B"s of the past) its number. */
export function compareTables(a: Numbered, b: Numbered): number {
  return (
    compareSortKeys(sortKey(shownOf(a.number, a.label)), sortKey(shownOf(b.number, b.label))) ||
    cmp(a.number ?? 0, b.number ?? 0)
  );
}

/** [items] (tables, orders, rows…) in the natural order of their labels and numbers — each key computed once. */
export function naturalSorted<T>(
  items: readonly T[],
  numberOf: (x: T) => number | null | undefined,
  labelOf: (x: T) => string | null | undefined,
): T[] {
  return items
    .map((item) => {
      const number = numberOf(item);
      return { item, number: number ?? 0, key: sortKey(shownOf(number, labelOf(item))) };
    })
    .sort((a, b) => compareSortKeys(a.key, b.key) || cmp(a.number, b.number))
    .map((x) => x.item);
}

/** Tables (`{number, label}`) in the natural order. */
export function sortTables<T extends Numbered>(items: readonly T[]): T[] {
  return naturalSorted(items, (t) => t.number, (t) => t.label);
}

// ── Titles ───────────────────────────────────────────────────────────────────────────

/** "12", "3B", "3B · VIP"; a table shown by its name alone ("ש-12") is its name. */
export function tableTitle(
  number: number | null | undefined,
  label?: string | null,
  name?: string | null,
  labelOnly = false,
): string {
  const nm = (name ?? '').trim();
  if (labelOnly && nm) return nm;
  const shown = shownOf(number, label);
  if (!nm) return shown;
  return shown ? `${shown}${SEPARATOR}${nm}` : nm;
}

/**
 * The font size a tile's title fits in across [width] (§6.3: a long label shrinks, as the till's tile does): a
 * number, or a title of up to three characters ("3B"), keeps [size]; never below [min].
 */
export function fittedFont(title: string, size: number, width: number, min = size * 0.4): number {
  const list = chars(title);
  if (list.length <= 3 || list.every(isDigit)) return size;
  return Math.max(min, Math.min(size, (width * 0.86) / (list.length * 0.6)));
}

/** "תא 3B" — the word before the number (`tableTerm`); a table shown by its name alone takes none. */
export function withTerm(term: string | null | undefined, title: string, labelOnly = false): string {
  const word = (term ?? '').trim();
  if (!word || labelOnly || !title) return title;
  return `${word} ${title}`;
}

// ── The internal number of a labelled table ──────────────────────────────────────────

/** The highest number from `top` down that no live table of the shop holds. */
export function internalNumber(taken: Iterable<number>, top = NUMBER_MAX): number {
  const held = new Set(taken);
  for (let n = top; n >= NUMBER_MIN; n -= 1) {
    if (!held.has(n)) return n;
  }
  throw new LabelError('number_range');
}

/** The dashboard's next number for a new table: after the shop's highest plain number (a label's is internal). */
export function nextNumber(tables: readonly Numbered[]): number {
  const plain = tables.filter((t) => !(t.label ?? '').trim()).map((t) => t.number ?? 0);
  return Math.min(NUMBER_MAX, Math.max(0, ...plain) + 1);
}

// ── "הוספת טווח" ─────────────────────────────────────────────────────────────────────

/** "3A" → ["3", "letters", "A"]; "A10" → ["A", "digits", "10"]. */
function lastRun(label: string): [string, 'digits' | 'letters', string] {
  const list = chars(label);
  const digits = isDigit(list[list.length - 1]);
  let i = list.length;
  while (i > 0 && (digits ? isDigit(list[i - 1]) : isLetter(list[i - 1]))) i -= 1;
  return [list.slice(0, i).join(''), digits ? 'digits' : 'letters', list.slice(i).join('')];
}

/**
 * "3A" … "3L" → 3A, 3B, … 3L; "A1" … "A10" → A1 … A10; 1 … 20 → the numbers. The same beginning, a letter or a
 * number at the end. LabelError: `range_mixed` (a number and a label), `range_shape` (another beginning, a
 * letter and a number at the end, more than one letter, letters of two alphabets), `range_too_many`.
 */
export function expandRange(start: unknown, end: unknown, limit = RANGE_MAX): Parsed[] {
  const a = parse(start);
  const b = parse(end);
  if (a.label === null && b.label === null) {
    const [low, high] = [a.number as number, b.number as number].sort((x, y) => x - y);
    if (high - low >= limit) throw new LabelError('range_too_many');
    const out: Parsed[] = [];
    for (let n = low; n <= high; n += 1) out.push(numberOnly(n));
    return out;
  }
  if ((a.label === null) !== (b.label === null)) throw new LabelError('range_mixed');
  const [headA, kindA, runA] = lastRun(a.label as string);
  const [headB, kindB, runB] = lastRun(b.label as string);
  if (headA !== headB || kindA !== kindB) throw new LabelError('range_shape');
  const out: Parsed[] = [];
  if (kindA === 'digits') {
    const [low, high] = [Number(runA), Number(runB)].sort((x, y) => x - y);
    if (high - low >= limit) throw new LabelError('range_too_many');
    const width = runA.length === runB.length && runA.startsWith('0') ? runA.length : 0;
    for (let n = low; n <= high; n += 1) out.push(parse(headA + (width ? String(n).padStart(width, '0') : String(n))));
    return out;
  }
  if (chars(runA).length !== 1 || chars(runB).length !== 1) throw new LabelError('range_shape');
  const alphabet = isEnglish(runA) ? ENGLISH_ALPHABET : HEBREW_ALPHABET;
  const ca = FINALS[runA] ?? runA;
  const cb = FINALS[runB] ?? runB;
  if (!alphabet.includes(ca) || !alphabet.includes(cb)) throw new LabelError('range_shape');
  const [i, j] = [alphabet.indexOf(ca), alphabet.indexOf(cb)].sort((x, y) => x - y);
  if (j - i >= limit) throw new LabelError('range_too_many');
  for (let k = i; k <= j; k += 1) out.push(parse(headA + alphabet[k]));
  return out;
}

/** `expandRange` without the throw: the items, or why the range is refused. */
export function checkRange(start: unknown, end: unknown): { items: Parsed[]; error: null } | { items: null; error: LabelReason } {
  try {
    return { items: expandRange(start, end), error: null };
  } catch (e) {
    if (e instanceof LabelError) return { items: null, error: e.reason };
    throw e;
  }
}

/** A range's end for the API (`POST /tables/zones/{id}/bulk`): digits alone as a number, anything else as typed. */
export function rangeEndValue(text: string): number | string {
  const t = squeezed(text);
  return /^[0-9]+$/.test(t) ? Number(t) : t;
}

// ── The keypad (§6.3) ────────────────────────────────────────────────────────────────

/** What the keypad holds, as it is matched: "3 b" → "3B"; digits alone without leading zeros ("012" → "12"). */
export function typedKey(text: unknown): string {
  let key = labelKey(squeezed(text ?? '')) ?? '';
  if (key && chars(key).every(isDigit)) key = key.replace(/^0+/, '');
  return key;
}

/** The table begins with what was typed ("3" finds 3, 3A, 30…; "3b" finds 3B). */
export function matches(typed: unknown, number: number | null | undefined, label: string | null | undefined): boolean {
  const key = typedKey(typed);
  if (!key) return false;
  const own = label ? (labelKey(label) ?? '') : number !== null && number !== undefined ? String(number) : '';
  return !!own && own.startsWith(key);
}

/** The table is what was typed: its label's key, or (no label) its number. */
export function exact(typed: unknown, number: number | null | undefined, label: string | null | undefined): boolean {
  const key = typedKey(typed);
  if (!key) return false;
  if (label) return labelKey(label) === key;
  return number !== null && number !== undefined && String(number) === key;
}

/** The keypad's suggestions: the tables that begin with what was typed, in the natural order, at most 8. */
export function suggestions<T extends Numbered>(typed: unknown, tables: readonly T[], limit = SUGGESTIONS_MAX): T[] {
  return sortTables(tables.filter((t) => matches(typed, t.number, t.label))).slice(0, limit);
}

/** The keypad's row of letters: those the labels use, English first, then Hebrew, each once. */
export function lettersIn(labels: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const lab of labels) {
    if (!lab) continue;
    for (const c of chars(upper(lab))) if (isLetter(c)) seen.add(c);
  }
  const group = (c: string) => (isEnglish(c) ? 0 : 1);
  return [...seen].sort((a, b) => cmp(group(a), group(b)) || cmp(FINALS[a] ?? a, FINALS[b] ?? b) || cmp(a, b));
}
