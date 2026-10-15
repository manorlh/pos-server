/**
 * Finding a table's documents in the transactions list — "בהיסטוריית עסקאות תוסיף גם חיפוש לפי
 * מספר שולחן" (the owner, 14.10.2026; P:\specs\history-table-search.md). The same rule as the
 * server's app/services/table_documents.py `parse_table_query` and the till's history search:
 *  - spaces collapsed; empty → not a table search;
 *  - "ש12", "ש 12", "ש-12", "שולחן 12", "t12", "table 12" (any case) ask for table 12 and only for
 *    it — the text itself is also a name ("ש-12" is a restored table's label), matched as a whole:
 *    the name starts with it and does not go on with a digit ("ש-12 (2)", not "ש-120"; "שולחן 1"
 *    is not "שולחן 10");
 *  - with the "שולחן" filter (`chip`), digits alone are a table number and any other text a name;
 *  - without it, text with a letter ("VIP 1", "בר 3") may also be a table's name; digits alone are
 *    the document number / amount search, not a table. Any name search but the explicit form's is
 *    a substring ("VIP" finds "VIP 1").
 */

/** The explicit form: a table word, an optional dash / "#" / maqaf, the number. */
const EXPLICIT = /^(?:שולחן|ש|table|t)\s*[-#\u05be]?\s*(\d{1,5})$/i;
const DIGITS = /^\d{1,5}$/;
const LETTER = /\p{L}/u;

export interface TableQuery {
  /** The table's number, or null (a name only). */
  number: number | null;
  /** Text the table's name contains, or null. */
  name: string | null;
  /** Asks for a table and nothing else (the explicit form, or the table filter). */
  explicit: boolean;
  /** The explicit form: the name starts with [name] and does not go on with a digit. */
  nameWhole: boolean;
}

/** What the box (or the "שולחן" filter, `chip`) asks as a table, or null. */
export function parseTableQuery(text: string | null | undefined, chip = false): TableQuery | null {
  const t = (text ?? '').split(/\s+/).filter(Boolean).join(' ');
  if (!t) return null;
  const m = EXPLICIT.exec(t);
  if (m) return { number: Number(m[1]), name: t, explicit: true, nameWhole: true };
  if (chip) {
    return DIGITS.test(t)
      ? { number: Number(t), name: null, explicit: true, nameWhole: false }
      : { number: null, name: t, explicit: true, nameWhole: false };
  }
  return LETTER.test(t) ? { number: null, name: t, explicit: false, nameWhole: false } : null;
}

/** Does the order of table [number] named [name] answer [query]? */
export function tableMatches(query: TableQuery, number: number | null | undefined, name: string | null | undefined): boolean {
  if (query.number !== null && typeof number === 'number' && number === query.number) return true;
  if (!query.name) return false;
  const wanted = query.name.toLowerCase();
  const have = (name ?? '').trim().toLowerCase();
  if (!query.nameWhole) return have.includes(wanted);
  return have.startsWith(wanted) && !/^[0-9]/.test(have.slice(wanted.length));
}

/**
 * Beside a document's number: "שולחן 12", with the name when it says more ("שולחן 9012 · ש-12",
 * "שולחן 31 · VIP 1"); the name alone without a number; null for a document of no table.
 * [word] is the caption ("שולחן", from the messages).
 */
export function tableLabel(word: string, number: number | null | undefined, name: string | null | undefined): string | null {
  const n = typeof number === 'number' ? String(number) : '';
  const nm = (name ?? '').trim();
  if (!n) return nm || null;
  return nm && nm !== n ? `${word} ${n} · ${nm}` : `${word} ${n}`;
}
