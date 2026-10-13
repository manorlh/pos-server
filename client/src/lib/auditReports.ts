/**
 * The pure parts of the control reports on the report framework (P:\specs\reports-upgrade.md
 * §5): cash variance, document sequence, offline authorizations and promotions.
 *
 * No React and no `@/` imports — tested in node (lib/reportFramework.test.ts). The row shapes
 * are the reports' own (lib/salesReportsApi.ts, lib/types.ts, lib/promotionsApi.ts), restated
 * here only as far as these helpers read them.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id the server's `uuid.UUID` query params accept (anything else is a 422). */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value.trim());
}

/* ---------------- cash variance (הפרשי קופה) ---------------- */

/** How a cash difference is shown: over (+, green), short (red), even (plain). */
export function varianceTone(value: number): 'over' | 'short' | 'even' {
  return value > 0 ? 'over' : value < 0 ? 'short' : 'even';
}

/**
 * The per-cashier table's totals row, as the report has always had it: every closed shift,
 * the counted ones (an uncounted shift has no difference, so it is not in the sums), Σ over,
 * Σ short, and the net — the report's total variance.
 */
export function cashVarianceTotals(
  byCashier: readonly { over: number; short: number }[],
  shiftCount: number,
  uncounted: number,
  totalVariance: number,
): { shifts: number; counted: number; over: number; short: number; net: number } {
  return {
    shifts: shiftCount,
    counted: shiftCount - uncounted,
    over: round2(byCashier.reduce((s, r) => s + r.over, 0)),
    short: round2(byCashier.reduce((s, r) => s + r.short, 0)),
    net: totalVariance,
  };
}

/* ---------------- document sequence (רצף מסמכים) ---------------- */

export interface SequenceGap {
  fromNumber: number;
  toNumber: number;
  missing: number;
}

/** "1043" for one missing number, "1043–1047" for a run (left to right). */
export function sequenceGapText(g: Pick<SequenceGap, 'fromNumber' | 'toNumber'>): string {
  return g.fromNumber === g.toNumber ? String(g.fromNumber) : `${g.fromNumber}–${g.toNumber}`;
}

export interface SequenceGapRow extends SequenceGap {
  key: string;
  machineId: string;
  machineName: string | null;
  shopName: string | null;
  documentType: number | null;
}

/** Every gap of every till × document type, one row each (the "חוסרים" sheet). */
export function sequenceGapRows(
  rows: readonly {
    machineId: string;
    machineName?: string | null;
    shopName?: string | null;
    documentType?: number | null;
    gaps: readonly SequenceGap[];
  }[],
): SequenceGapRow[] {
  return rows.flatMap((r) =>
    r.gaps.map((g) => ({
      key: `${r.machineId}:${r.documentType ?? ''}:${g.fromNumber}`,
      machineId: r.machineId,
      machineName: r.machineName ?? null,
      shopName: r.shopName ?? null,
      documentType: r.documentType ?? null,
      fromNumber: g.fromNumber,
      toNumber: g.toNumber,
      missing: g.missing,
    })),
  );
}

/* ---------------- offline authorizations (עסקאות במצב לא מקוון) ---------------- */

/** Each declined uid of each run, with the run it came from (the "מסמכים שנדחו" sheet). */
export function offlineDeclinedRows<L, R extends { id: string; declined: readonly L[] }>(
  runs: readonly R[],
): { key: string; run: R; leg: L }[] {
  return runs.flatMap((run) => run.declined.map((leg, i) => ({ key: `${run.id}:${i}`, run, leg })));
}

/* ---------------- promotions (דוח מבצעים) ---------------- */

/**
 * The promotion filter's choices: the tenant's promotions, and any the report names that the
 * list no longer has (a deleted one still has its history). One per id, by name.
 */
export function promotionChoices(
  promotions: readonly { id: string; name: string }[],
  reported: readonly { promotionId: string | null; name: string | null }[],
): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const p of promotions) if (p.id) byId.set(p.id, p.name);
  for (const r of reported) if (r.promotionId && !byId.has(r.promotionId)) byId.set(r.promotionId, r.name ?? '');
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he') || a.id.localeCompare(b.id));
}
