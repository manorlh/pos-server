/**
 * Finding a table's documents in the transactions list — "בהיסטוריית עסקאות תוסיף גם חיפוש לפי
 * מספר שולחן" (the owner, 14.10.2026; P:\specs\history-table-search.md). The same rule as the
 * server's app/services/table_documents.py `parse_table_query` and the till's history search:
 *  - spaces collapsed; empty → not a table search;
 *  - "ש12", "ש 12", "ש-12", "שולחן 12", "תא 12", "t12", "table 12" (any case) ask for table 12 and only for
 *    it — the text itself is also a name ("ש-12" is a restored table's label), matched as a whole:
 *    the name starts with it and does not go on with a digit ("ש-12 (2)", not "ש-120"; "שולחן 1"
 *    is not "שולחן 10");
 *  - with the "שולחן" filter (`chip`), digits alone are a table number and any other text a name;
 *  - without it, text with a letter ("VIP 1", "בר 3") may also be a table's name; digits alone are
 *    the document number / amount search, not a table. Any name search but the explicit form's is
 *    a substring ("VIP" finds "VIP 1").
 *
 * Labels ("3B", P:/specs/table-scope.md §6.4, §14.10): "ש3B", "שולחן 3B", "תא 3B", "t3b" — a table word and a
 * label that begins with a digit — and "שולחן VIP" / "תא VIP" (a word, a space, a label of letters) ask for the
 * labelled table, matched by the label's normalised form (lib/tableLabels.ts `labelKey`: "3-b" is "3B"); with
 * the chip, "3B" alone; any other text that is a label also matches labels. "תא" is a table word too
 * (`tableTerm`).
 */

import { LabelError, labelKey, parse } from './tableLabels';

/** The explicit form: a table word, an optional dash / "#" / maqaf, the number. */
const EXPLICIT = /^(?:שולחן|ש|תא|table|t)\s*[-#\u05be]?\s*(\d{1,5})$/i;
/**
 * A label after a table word: one that begins with a digit ("ש3B", "תא 3B"), or — after a whole word and a
 * space — one of letters ("שולחן VIP", "תא A1").
 */
const EXPLICIT_LABEL = /^(?:שולחן|ש|תא|table|t)\s*[-#\u05be]?\s*(\d[0-9A-Za-z\u05d0-\u05ea \-]*)$/i;
const WORD_LABEL = /^(?:שולחן|תא|table)\s+([A-Za-z\u05d0-\u05ea][0-9A-Za-z\u05d0-\u05ea \-]*)$/i;
const DIGITS = /^\d{1,5}$/;
const LETTER = /\p{L}/u;

/** The normalised label [text] is ("3-b" → "3B"), null when it is not one (a number, a refused character). */
function labelKeyOf(text: string): string | null {
  try {
    return parse(text).key;
  } catch (e) {
    if (e instanceof LabelError) return null;
    throw e;
  }
}

export interface TableQuery {
  /** The table's number, or null (a name only). */
  number: number | null;
  /** Text the table's name contains, or null. */
  name: string | null;
  /** Asks for a table and nothing else (the explicit form, or the table filter). */
  explicit: boolean;
  /** The explicit form: the name starts with [name] and does not go on with a digit. */
  nameWhole: boolean;
  /** A label's normalised form ("3B" for "3-b"), matched against the order's label read the same way; or null. */
  labelKey: string | null;
}

/** What the box (or the "שולחן" filter, `chip`) asks as a table, or null. */
export function parseTableQuery(text: string | null | undefined, chip = false): TableQuery | null {
  const t = (text ?? '').split(/\s+/).filter(Boolean).join(' ');
  if (!t) return null;
  const m = EXPLICIT.exec(t);
  if (m) return { number: Number(m[1]), name: t, explicit: true, nameWhole: true, labelKey: null };
  for (const pattern of [EXPLICIT_LABEL, WORD_LABEL]) {
    const lm = pattern.exec(t);
    const key = lm ? labelKeyOf(lm[1]) : null;
    // The table word's own text is also a restored table's name ("ש-3B").
    if (key !== null) return { number: null, name: t, explicit: true, nameWhole: true, labelKey: key };
  }
  if (chip) {
    return DIGITS.test(t)
      ? { number: Number(t), name: null, explicit: true, nameWhole: false, labelKey: null }
      : { number: null, name: t, explicit: true, nameWhole: false, labelKey: labelKeyOf(t) };
  }
  return LETTER.test(t) ? { number: null, name: t, explicit: false, nameWhole: false, labelKey: labelKeyOf(t) } : null;
}

/** Does the order of table [number] named [name] (labelled [label], "3B") answer [query]? */
export function tableMatches(
  query: TableQuery,
  number: number | null | undefined,
  name: string | null | undefined,
  label?: string | null,
): boolean {
  if (query.number !== null && typeof number === 'number' && number === query.number) return true;
  if (query.labelKey !== null && label && labelKey(label) === query.labelKey) return true;
  if (!query.name) return false;
  const wanted = query.name.toLowerCase();
  const have = (name ?? '').trim().toLowerCase();
  if (!query.nameWhole) return have.includes(wanted);
  return have.startsWith(wanted) && !/^[0-9]/.test(have.slice(wanted.length));
}

/**
 * Beside a document's number: "שולחן 12", with the name when it says more ("שולחן 9012 · ש-12",
 * "שולחן 31 · VIP 1"); a labelled table by its label ("שולחן 3B · VIP"); the name alone without a
 * number; null for a document of no table. [word] is the caption ("שולחן", from the messages).
 */
export function tableLabel(
  word: string,
  number: number | null | undefined,
  name: string | null | undefined,
  label?: string | null,
): string | null {
  const n = (label ?? '').trim() || (typeof number === 'number' ? String(number) : '');
  const nm = (name ?? '').trim();
  if (!n) return nm || null;
  return nm && nm !== n ? `${word} ${n} · ${nm}` : `${word} ${n}`;
}
