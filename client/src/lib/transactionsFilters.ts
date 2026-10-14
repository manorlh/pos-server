/**
 * The transactions list's own filters (P:\specs\reports-upgrade.md §2א): beside the days and
 * the free search of the report bar, everything `GET /transactions` (and its export) takes —
 * several tills, document types, employees and statuses, a card's last four digits, a
 * product, the tender, an amount range, a document number, a table ("שולחן": "12" is table 12, other
 * text a table's name — lib/tableSearch.ts) and a basket. They live in the URL
 * as the report's `extras` (lists comma-separated), so a link is the search.
 *
 * Pure — no React, no network — so the query it builds is tested in node.
 */

/**
 * The tender filter: a tender of the document or of any of its legs; split; credit notes;
 * and `failed` — the failed payment attempts, which are no documents at all (their own list,
 * docs/SPEC_FAILED_PAYMENTS.md), so it is never sent as `method`.
 */
export const TX_METHODS = ['cash', 'card', 'voucher', 'split', 'refunds', 'failed'] as const;
export type TxMethod = (typeof TX_METHODS)[number];

/** The document types a search can narrow to (docs/SPEC_REPORTS.md §1); -400: an exempt dealer's refund. */
export const TX_DOCUMENT_TYPES = [320, 330, 400, -400] as const;
export const TX_STATUSES = ['completed', 'refunded', 'partial_refund', 'cancelled', 'pending'] as const;

/** URL keys of the extras, with their defaults (none narrows anything). */
export const TX_EXTRAS = {
  card: '',
  item: '',
  method: '',
  tills: '',
  types: '',
  employees: '',
  statuses: '',
  amountMin: '',
  amountMax: '',
  doc: '',
  table: '',
  basket: '',
} as const satisfies Record<string, string>;

export type TxExtras = Record<keyof typeof TX_EXTRAS, string>;

/** `a,b,,c ` → `['a','b','c']`. */
export function listOf(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The list back into its URL value, in a stable order. */
export function listValue(values: readonly string[]): string {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].join(',');
}

/** The extras with defaults for what the URL does not say. */
export function txExtrasOf(raw: Record<string, string> | null | undefined): TxExtras {
  const out = { ...TX_EXTRAS } as TxExtras;
  for (const key of Object.keys(TX_EXTRAS) as (keyof TxExtras)[]) out[key] = (raw?.[key] ?? '').trim();
  return out;
}

export function txMethodOf(value: string): TxMethod | '' {
  return (TX_METHODS as readonly string[]).includes(value) ? (value as TxMethod) : '';
}

const DECIMAL = /^-?\d+(\.\d+)?$/;
const UUIDISH = /^[0-9a-fA-F-]{8,64}$/;

export interface TxQueryInput {
  /** The applied days; none on a first visit (the newest documents of every day). */
  from?: string | null;
  to?: string | null;
  /** The free search (number, amount, pickup number, customer). */
  q?: string | null;
  extras: TxExtras;
  shopId?: string | null;
  machineId?: string | null;
}

/**
 * What `GET /transactions` and `GET /transactions/export` get (lists as repeated params). The
 * scope's till wins over a list of tills; nonsense in the URL is dropped, never sent.
 */
export function transactionsQuery(input: TxQueryInput): Record<string, string | string[]> {
  const e = input.extras;
  const p: Record<string, string | string[]> = {};
  if (input.machineId) p.machineId = input.machineId;
  if (input.shopId) p.shopId = input.shopId;
  if (input.from) p.from = input.from;
  if (input.to) p.to = input.to;
  const q = (input.q ?? '').trim();
  if (q) p.q = q.slice(0, 60);
  if (/^\d{4}$/.test(e.card)) p.cardLast4 = e.card;
  if (e.item) p.item = e.item.slice(0, 80);
  const method = txMethodOf(e.method);
  if (method && method !== 'failed') p.method = method;
  const tills = listOf(e.tills);
  if (tills.length && !input.machineId) p.machineIds = tills;
  const types = listOf(e.types).filter((t) => /^-?\d{1,4}$/.test(t));
  if (types.length) p.documentTypes = types;
  const employees = listOf(e.employees);
  if (employees.length) p.cashierIds = employees;
  const statuses = listOf(e.statuses).filter((s) => (TX_STATUSES as readonly string[]).includes(s));
  if (statuses.length) p.statuses = statuses;
  if (DECIMAL.test(e.amountMin)) p.amountMin = e.amountMin;
  if (DECIMAL.test(e.amountMax)) p.amountMax = e.amountMax;
  const doc = e.doc.replace(/[^\d-]/g, '').slice(0, 40);
  if (doc) p.documentNumber = doc;
  const table = e.table.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (table) p.table = table;
  if (UUIDISH.test(e.basket)) p.basketId = e.basket;
  return p;
}

/** The extras that narrow anything (for "N filters" and the export's filter line). */
export function activeTxExtras(e: TxExtras): (keyof TxExtras)[] {
  return (Object.keys(TX_EXTRAS) as (keyof TxExtras)[]).filter((k) => e[k] !== '');
}
