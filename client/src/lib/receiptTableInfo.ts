/**
 * "מספר שולחן על החשבונית" (the owner, 14.10.2026; P:/specs/receipt-table-number.md; pos-server
 * app/services/receipt_table_info.py, pos-android domain/ReceiptTableInfo.kt): the till parameter
 * `receiptTableInfo` — what of the table a table's tax invoice / receipt prints, one line under its
 * title: "שולחן 12 · גן · 4 סועדים · מלצר: דנה". Empty (the default) or `none`: no line, as before.
 *
 * The pure helpers of the till design's field and its preview. The line's rule is the till's and the
 * cloud's, pinned by server/tests/fixtures/receipt_table_line_cases.json (the test reads it). A labelled
 * table ("3B", P:/specs/table-scope.md §6.4) shows its label instead of its number, and the word before it is
 * the till's `tableTerm` ("תא 3B · מפלס 3"; blank — "שולחן").
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export type ReceiptTableField = 'table' | 'zone' | 'guests' | 'waiter';

export const RECEIPT_TABLE_INFO_KEY = 'receiptTableInfo';
/** The line's order. */
export const RECEIPT_TABLE_FIELDS: ReceiptTableField[] = ['table', 'zone', 'guests', 'waiter'];
export const RECEIPT_TABLE_NONE = 'none';
export const RECEIPT_TABLE_SEPARATOR = ' · ';

/** Hebrew for the field's chips (the server's labels). */
export const RECEIPT_TABLE_FIELD_NAMES: Record<ReceiptTableField, string> = {
  table: 'מספר ושם השולחן',
  zone: 'אזור',
  guests: 'סועדים',
  waiter: 'מלצר',
};

/** The table a document paid, as its order recorded it. */
export interface ReceiptTableFacts {
  number: number | null;
  name: string | null;
  zone: string | null;
  guests: number | null;
  waiter: string | null;
  /** "3B" (P:/specs/table-scope.md §6.4): shown instead of the number, which is then an internal one. */
  label?: string | null;
}

/** The preview's table. */
export const SAMPLE_RECEIPT_TABLE: ReceiptTableFacts = { number: 12, name: null, zone: 'גן', guests: 4, waiter: 'דנה' };

/** As the till reads it: the line's order; nothing, blank or `none` — nothing; an unknown code skipped. */
export function parseReceiptTableInfo(value: unknown): ReceiptTableField[] {
  if (typeof value !== 'string') return [];
  const text = value.trim().toLowerCase();
  if (!text || text === RECEIPT_TABLE_NONE) return [];
  const codes = new Set(text.split(',').map((p) => p.trim()));
  return RECEIPT_TABLE_FIELDS.filter((f) => codes.has(f));
}

/** The stored list: the line's order, or `none`. */
export function formatReceiptTableInfo(fields: readonly string[]): string {
  const on = new Set(fields);
  const list = RECEIPT_TABLE_FIELDS.filter((f) => on.has(f));
  return list.length ? list.join(',') : RECEIPT_TABLE_NONE;
}

export function toggleReceiptTableInfo(value: unknown, field: ReceiptTableField): string {
  const list = parseReceiptTableInfo(value);
  return formatReceiptTableInfo(list.includes(field) ? list.filter((f) => f !== field) : [...list, field]);
}

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

/** "12", "12 · VIP 1", "3B", "3B · VIP" — or a restored table by its label alone ("ש-12"). */
export function receiptTableTitle(facts: ReceiptTableFacts): string | null {
  const name = text(facts.name);
  const shown = text(facts.label) ?? (facts.number === null || facts.number === undefined ? null : String(facts.number));
  if (shown === null) return name;
  if (!name) return shown;
  return name.startsWith('ש-') ? name : `${shown}${RECEIPT_TABLE_SEPARATOR}${name}`;
}

/** The word before the table when the till's `tableTerm` is not set (or blank). */
export const RECEIPT_TABLE_WORD = 'שולחן';

/**
 * "שולחן 12 · גן · 4 סועדים · מלצר: דנה" — or null: nothing asked, no table, or none of it known. [term]: the
 * word before the table (`tableTerm`, "תא 3B"); blank or none — "שולחן".
 */
export function receiptTableLine(
  fields: readonly string[],
  facts: ReceiptTableFacts | null,
  term?: string | null,
): string | null {
  const word = text(term) ?? RECEIPT_TABLE_WORD;
  if (!facts || fields.length === 0) return null;
  const wanted = new Set(fields);
  const parts: string[] = [];
  for (const field of RECEIPT_TABLE_FIELDS) {
    if (!wanted.has(field)) continue;
    if (field === 'table') {
      const title = receiptTableTitle(facts);
      if (title) parts.push(`${word} ${title}`);
    } else if (field === 'zone') {
      const zone = text(facts.zone);
      if (zone) parts.push(zone);
    } else if (field === 'guests') {
      const n = facts.guests;
      if (typeof n === 'number' && n > 0) parts.push(n === 1 ? 'סועד אחד' : `${n} סועדים`);
    } else {
      const waiter = text(facts.waiter);
      if (waiter) parts.push(`מלצר: ${waiter}`);
    }
  }
  return parts.length ? parts.join(RECEIPT_TABLE_SEPARATOR) : null;
}
