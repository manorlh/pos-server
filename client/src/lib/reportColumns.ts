/**
 * Report columns (P:\specs\reports-upgrade.md §2א–ב): which columns a reader sees and in
 * what order, which go out in an export, and how the table sorts.
 *
 * * What a user sees is theirs: `{ order, hidden }` per table, kept on the server in
 *   `users.preferences.reportColumns[reportKey]` (or in this browser while the server has
 *   no such key). Saved choices name column keys; a column the report gained since is
 *   shown at its own place, and a key the report no longer has is ignored.
 * * An export's columns, first match wins: the choice for this export → the company's
 *   default for the report → what the user sees → every column. A source that names
 *   none of a table's columns does not count for that table.
 *
 * Export column keys are qualified per table: the main table's keys as they are, another
 * table's as `table.key` (`byMethod.amount`), so one list covers a report of several
 * tables and a company default is one list per report.
 *
 * Pure, tested in node.
 */

export interface ColumnPrefs {
  /** Column keys in the reader's order (may be partial or stale). */
  order: string[];
  /** Column keys the reader hid. */
  hidden: string[];
}

/** The minimum a column needs here. */
export interface ColumnInfo {
  key: string;
  /** Cannot be hidden (the row's name). */
  required?: boolean;
  /** Hidden until the reader shows it. */
  defaultHidden?: boolean;
}

export const MAIN_TABLE = 'main';

/** `byMethod` + `amount` → `byMethod.amount`; the main table's keys stay bare. */
export function qualifiedKey(tableId: string, key: string): string {
  return tableId === MAIN_TABLE ? key : `${tableId}.${key}`;
}

/** The reader's order: saved keys first (those that still exist), then new ones in place. */
export function orderedColumnKeys(columns: readonly ColumnInfo[], prefs: ColumnPrefs | null | undefined): string[] {
  const known = columns.map((c) => c.key);
  if (!prefs || prefs.order.length === 0) return known;
  const saved = prefs.order.filter((k, i) => known.includes(k) && prefs.order.indexOf(k) === i);
  const out = [...saved];
  // A column the saved order does not name goes right after its predecessor in the
  // report's own order, so a new column lands next to its neighbours, not at the end.
  known.forEach((key, i) => {
    if (out.includes(key)) return;
    const before = known.slice(0, i).reverse().find((k) => out.includes(k));
    const at = before === undefined ? 0 : out.indexOf(before) + 1;
    out.splice(at, 0, key);
  });
  return out;
}

/** The columns on screen, in order. A required column can never be hidden. */
export function visibleColumnKeys(columns: readonly ColumnInfo[], prefs: ColumnPrefs | null | undefined): string[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const hidden = new Set(
    prefs ? prefs.hidden : columns.filter((c) => c.defaultHidden).map((c) => c.key),
  );
  return orderedColumnKeys(columns, prefs).filter((k) => byKey.get(k)?.required || !hidden.has(k));
}

/** Show or hide one column. */
export function toggleColumn(
  columns: readonly ColumnInfo[],
  prefs: ColumnPrefs | null | undefined,
  key: string,
  visible: boolean,
): ColumnPrefs {
  const order = orderedColumnKeys(columns, prefs);
  const hidden = new Set(prefs ? prefs.hidden : columns.filter((c) => c.defaultHidden).map((c) => c.key));
  const column = columns.find((c) => c.key === key);
  if (visible || column?.required) hidden.delete(key);
  else hidden.add(key);
  return { order, hidden: order.filter((k) => hidden.has(k)) };
}

/** Move a column from one place in the reader's order to another (a drag, or ↑/↓). */
export function moveColumn(
  columns: readonly ColumnInfo[],
  prefs: ColumnPrefs | null | undefined,
  key: string,
  toIndex: number,
): ColumnPrefs {
  const order = orderedColumnKeys(columns, prefs);
  const from = order.indexOf(key);
  if (from < 0) return { order, hidden: prefs?.hidden ?? defaultHidden(columns) };
  order.splice(from, 1);
  order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, key);
  return { order, hidden: prefs?.hidden ?? defaultHidden(columns) };
}

function defaultHidden(columns: readonly ColumnInfo[]): string[] {
  return columns.filter((c) => c.defaultHidden).map((c) => c.key);
}

/** A saved value read back from storage or the server; anything malformed is null. */
export function parseColumnPrefs(raw: unknown): ColumnPrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80) : null;
  const order = list(r.order);
  const hidden = list(r.hidden);
  if (!order || !hidden) return null;
  return { order: order.slice(0, 200), hidden: hidden.slice(0, 200) };
}

// ── On the server (P:\specs\reports-upgrade.md §4.4) ──────────────────────────────

/** The server's shape: what is shown, and the order of every column. */
export interface ServerColumnPrefs {
  visible: string[];
  order: string[];
}

export interface ReportColumnPrefsState {
  /** True when the server keeps them; false: this browser's storage. */
  server: boolean;
  /** By report key (`product-sales`, `tips.days`…). */
  byReport: Record<string, ColumnPrefs>;
}

/** `{visible, order}` → `{order, hidden}`: hidden is what the order names and visible does not. */
export function fromServerPrefs(raw: unknown): ColumnPrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ServerColumnPrefs>;
  if (!Array.isArray(r.visible) || !Array.isArray(r.order)) return null;
  const visible = new Set(r.visible);
  return parseColumnPrefs({ order: r.order, hidden: r.order.filter((k) => !visible.has(k)) });
}

export function toServerPrefs(prefs: ColumnPrefs): ServerColumnPrefs {
  const hidden = new Set(prefs.hidden);
  return { order: prefs.order.slice(0, 100), visible: prefs.order.filter((k) => !hidden.has(k)).slice(0, 100) };
}

// ── Export columns ───────────────────────────────────────────────────────────

export type ExportColumnSource = 'current' | 'company' | 'visible' | 'all';

export interface ExportTableColumns {
  tableId: string;
  /** Every exportable column of the table, in the report's order. */
  keys: string[];
  /** What the reader sees of it, in their order (null: the table is not on screen). */
  visible?: string[] | null;
}

/**
 * One table's export columns (bare keys, in order) and where they came from:
 * the choice for this export → the company default → what the user sees → all.
 */
export function resolveExportColumns(
  table: ExportTableColumns,
  sources: { current?: readonly string[] | null; company?: readonly string[] | null },
): { keys: string[]; source: ExportColumnSource } {
  const pick = (list: readonly string[] | null | undefined): string[] | null => {
    if (!list) return null;
    const keys = list
      .map((q) => unqualify(table.tableId, q))
      .filter((k): k is string => k !== null && table.keys.includes(k));
    return keys.length ? Array.from(new Set(keys)) : null;
  };
  const current = pick(sources.current);
  if (current) return { keys: current, source: 'current' };
  const company = pick(sources.company);
  if (company) return { keys: company, source: 'company' };
  const visible = (table.visible ?? []).filter((k) => table.keys.includes(k));
  if (visible.length) return { keys: visible, source: 'visible' };
  return { keys: [...table.keys], source: 'all' };
}

/** `byMethod.amount` in the table `byMethod` → `amount`; another table's key → null. */
export function unqualify(tableId: string, qualified: string): string | null {
  if (tableId === MAIN_TABLE) return qualified.includes('.') ? null : qualified;
  const prefix = `${tableId}.`;
  return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : null;
}

/** Every table's resolved columns as one qualified list — what a company default saves. */
export function qualifiedExportList(tables: { tableId: string; keys: string[] }[]): string[] {
  return tables.flatMap((t) => t.keys.map((k) => qualifiedKey(t.tableId, k)));
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDirection;
}

/** A click on a header: unsorted → ascending → descending → back to the report's order. */
export function nextSort(current: SortState | null, key: string, firstDir: SortDirection = 'asc'): SortState | null {
  if (!current || current.key !== key) return { key, dir: firstDir };
  if (current.dir === firstDir) return { key, dir: firstDir === 'asc' ? 'desc' : 'asc' };
  return null;
}

export type SortValue = string | number | null | undefined;

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('he', { numeric: true, sensitivity: 'base' }) : null;

function asNumber(v: SortValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/**
 * Rows sorted by one value, stably (equal values keep the report's order). Empty values
 * always go last, whichever the direction; numbers — including the API's decimal strings
 * ("12.50") — compare as numbers, text in Hebrew order with digits as numbers.
 */
export function sortRows<R>(rows: readonly R[], value: (row: R) => SortValue, dir: SortDirection): R[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      const aEmpty = a.v === null || a.v === undefined || a.v === '';
      const bEmpty = b.v === null || b.v === undefined || b.v === '';
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
      const an = asNumber(a.v);
      const bn = asNumber(b.v);
      let cmp: number;
      if (an !== null && bn !== null) cmp = an - bn;
      else {
        const as = String(a.v);
        const bs = String(b.v);
        cmp = collator ? collator.compare(as, bs) : as < bs ? -1 : as > bs ? 1 : 0;
      }
      return cmp === 0 ? a.index - b.index : cmp * sign;
    })
    .map((x) => x.row);
}
