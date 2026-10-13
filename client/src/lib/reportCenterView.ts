/**
 * The report center pages on the report framework (P:\specs\reports-upgrade.md §5) — the
 * reconciliation, the transmissions and "דוח שמכיל הכל": their own options as the URL holds
 * them (the shops / tills picked, the statuses shown), and the bridge from the center's sheet
 * builders (lib/reportSheets.ts) to keyed table columns, so a workbook keeps its exact sheets
 * while each column can be chosen for the export.
 *
 * Pure, tested in node (lib/reportSheets.test.ts).
 */
import type { ExcelSheet } from './excelExport';
import {
  RECONCILIATION_CHECKS,
  type ReconciliationCheck,
  type ReconciliationRow,
  type ReconciliationStatus,
} from './reportCenterTypes';

/** `a,b,,a` → `['a', 'b']`: a multi-select's ids as the URL holds them (`?shops=a,b`). */
export function idList(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// ── The reconciliation's own options ─────────────────────────────────────────

/** The statuses in the order the page shows them: what needs looking at first. */
export const RECONCILIATION_STATUSES: readonly ReconciliationStatus[] = ['missing', 'difference', 'pending', 'match'];

/** The URL value of an empty status choice (an empty value would read as the default). */
export const NO_STATUSES = 'none';

/** The list's default: everything but the matches. */
export const DEFAULT_STATUSES = 'missing,difference,pending';

/** The statuses the URL names, in the page's order; '' → the default, `none` → none. */
export function parseStatusList(raw: string | null | undefined): ReconciliationStatus[] {
  const value = (raw ?? '').trim();
  if (value === NO_STATUSES) return [];
  const named = new Set(idList(value || DEFAULT_STATUSES));
  return RECONCILIATION_STATUSES.filter((s) => named.has(s));
}

/** The statuses as the URL holds them, in the page's order (so the default reads as the default). */
export function statusListParam(list: readonly ReconciliationStatus[]): string {
  const chosen = RECONCILIATION_STATUSES.filter((s) => list.includes(s));
  return chosen.length ? chosen.join(',') : NO_STATUSES;
}

/** One status chip clicked: in or out. */
export function toggleStatus(list: readonly ReconciliationStatus[], status: ReconciliationStatus): ReconciliationStatus[] {
  return list.includes(status)
    ? RECONCILIATION_STATUSES.filter((s) => s !== status && list.includes(s))
    : RECONCILIATION_STATUSES.filter((s) => s === status || list.includes(s));
}

/** The checks the URL names that the server knows (the `checks` it runs); none = all. */
export function checkList(raw: string | null | undefined): ReconciliationCheck[] {
  const named = new Set(idList(raw));
  return RECONCILIATION_CHECKS.filter((c) => named.has(c));
}

/** The rows the list shows: one check ('' = all) and the chosen statuses. */
export function reconciliationRows(
  rows: readonly ReconciliationRow[],
  check: string,
  statuses: readonly ReconciliationStatus[],
): ReconciliationRow[] {
  return rows.filter((r) => (!check || r.check === check) && statuses.includes(r.status));
}

// ── Sheets with keyed columns ────────────────────────────────────────────────

export interface KeyedSheet {
  /** The sheet's key (the builder's name for it, e.g. `sheetTips`). */
  key: string;
  /** A stable key per column (`[A-Za-z0-9_:-]`, unique in the sheet), in the sheet's order. */
  columnKeys: string[];
  /** The sheet as the reader gets it. */
  sheet: ExcelSheet;
}

/** A key as the export columns take it: no dots (a main table's keys are bare), ≤ 64 characters. */
function columnKey(raw: string, index: number, used: Set<string>): string {
  const base = raw.replace(/[^A-Za-z0-9_:-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || `col${index + 1}`;
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base}_${n}`;
  used.add(key);
  return key;
}

/**
 * The center's sheet builders name every sheet and column through the translator. Run once
 * with the keys themselves as the "translation" (`keyed`: `t = (k) => k`, a payment method as
 * `pm:cash`) and once for the reader (`sheets`), they zip into sheets whose columns carry
 * stable keys — the same sheets, columns, totals and fills as before, now choosable.
 */
export function keyedSheets(keyed: readonly ExcelSheet[], sheets: readonly ExcelSheet[]): KeyedSheet[] {
  if (keyed.length !== sheets.length) throw new Error('keyedSheets: the keyed run has other sheets');
  return sheets.map((sheet, i) => {
    const names = keyed[i].columns;
    if (names.length !== sheet.columns.length) throw new Error(`keyedSheets: the keyed run of "${keyed[i].name}" has other columns`);
    const used = new Set<string>();
    return { key: keyed[i].name, columnKeys: names.map((c, n) => columnKey(c.header, n, used)), sheet };
  });
}
