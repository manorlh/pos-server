/**
 * The printers page's pure rules for the network scan ("חיפוש ברשת") and the per-zone
 * redirect ("הפניה לפי אזור שולחנות") — tested by printRouting.test.ts (`npm test`).
 */

export type PrinterScanStatus = 'pending' | 'scanning' | 'done' | 'failed' | 'expired';

/** The scan is still running on the till. */
export function scanRunning(scan: { status: PrinterScanStatus } | null | undefined): boolean {
  return scan?.status === 'pending' || scan?.status === 'scanning';
}

/** The till can print on it (a raw port): it may fill the network printer form. */
export function scanResultUsable(p: { kind: string }): boolean {
  return p.kind !== 'other';
}

/** The results the dialog offers first: not yet configured, printable, ESC/POS before unknown. */
export function orderScanResults<T extends { kind: string; configuredPrinterId: string | null }>(rows: T[]): T[] {
  const rank = (p: T) => (p.configuredPrinterId ? 2 : 0) + (p.kind === 'escpos' ? 0 : p.kind === 'unknown' ? 0.5 : 1);
  return rows
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
}

/** How a finished / failed scan reads: the i18n key under `kitchenPrinters.scan.errors`, or null. */
export function scanErrorKey(scan: { status: PrinterScanStatus; error: string | null } | null | undefined): string | null {
  if (!scan) return null;
  if (scan.status === 'expired') return scan.error === 'no_report' ? 'noReport' : 'notPickedUp';
  if (scan.status !== 'failed') return null;
  switch (scan.error) {
    case 'not_on_lan':
      return 'notOnLan';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

export interface ZoneRedirectRow {
  fromPrinterId: string;
  toPrinterId: string;
}

/**
 * What is wrong with a zone's rows before saving: `incomplete` (a printer not chosen),
 * `same` (to itself), `duplicate` (one printer redirected twice). Null: fine.
 */
export function zoneRowsProblem(rows: ZoneRedirectRow[]): 'incomplete' | 'same' | 'duplicate' | null {
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.fromPrinterId || !r.toPrinterId) return 'incomplete';
    if (r.fromPrinterId === r.toPrinterId) return 'same';
    if (seen.has(r.fromPrinterId)) return 'duplicate';
    seen.add(r.fromPrinterId);
  }
  return null;
}

/** The rows as the API takes them: `{fromPrinterId: toPrinterId}`. */
export function zoneRowsToMap(rows: ZoneRedirectRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[r.fromPrinterId] = r.toPrinterId;
  return out;
}

/** The rows changed from what was saved (order ignored). */
export function zoneRowsDirty(saved: ZoneRedirectRow[], edited: ZoneRedirectRow[]): boolean {
  const key = (rows: ZoneRedirectRow[]) =>
    rows
      .map((r) => `${r.fromPrinterId}>${r.toPrinterId}`)
      .sort()
      .join('|');
  return key(saved) !== key(edited);
}
