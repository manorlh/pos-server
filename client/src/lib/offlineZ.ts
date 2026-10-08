/**
 * A till Z closed with no connection to the cloud, and the card transmission before a Z
 * (pos-server docs/SPEC_OFFLINE_TILL_Z.md). Pure helpers for the Z pages.
 */
import type { ZCardTransmission, ZOfflineDiscrepancy } from './types';

/** A transmission at a Z that did not go through (closed on a confirmation, or unattended). */
export function zTransmissionFailed(t: ZCardTransmission | null | undefined): boolean {
  return !!t && (t.outcome === 'failed' || t.outcome === 'unknown' || t.outcome === 'busy');
}

/** The keys of a discrepancy, in the order a reader checks them. */
const ORDER = [
  'machineSequenceNumber',
  'shiftIds',
  'firstDocumentNumber',
  'lastDocumentNumber',
  'totalSales',
  'totalDiscounts',
  'totalRefunds',
  'totalCash',
  'totalCard',
  'totalExchange',
  'totalTips',
  'vatTotal',
  'transactionsCount',
  'openingCash',
  'expectedCash',
  'countedCash',
  'overShort',
  'cardTipsFromDrawer',
  'drawerCash',
];

export function sortedDiscrepancies(list: ZOfflineDiscrepancy[] | null | undefined): ZOfflineDiscrepancy[] {
  const rank = (k: string) => {
    const i = ORDER.indexOf(k);
    return i < 0 ? ORDER.length : i;
  };
  return [...(list ?? [])].sort((a, b) => rank(a.key) - rank(b.key));
}

/** One side of a discrepancy as text: a list of shifts by count, a number as it is. */
export function discrepancyValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return String(value.length);
  return String(value);
}
