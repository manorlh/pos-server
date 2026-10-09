/**
 * "איפוס נתוני קופה (תמיכה)" — a reset of a till's data, ordered from the cloud by support
 * (pos-server docs/SPEC_OFFLINE_TILL_Z.md §4.7). The owner: "איפוס זדים קורה רק מהענן
 * ובאמצעות סופר אדמין בתמיכה". The API, and the pure rules the dialog shows. Kept free of
 * React and of the `@/` alias so `npm test` runs it on its own.
 */

export type TillResetKind = 'transactions' | 'full';

export const TILL_RESET_KINDS: TillResetKind[] = ['transactions', 'full'];

export type TillResetStatus = 'pending' | 'done' | 'refused' | 'failed' | 'expired';

/** The shortest reason the cloud takes (`till_reset.MIN_REASON`). */
export const TILL_RESET_MIN_REASON = 3;

export interface TillResetResult {
  status: 'done' | 'refused' | 'failed';
  code?: string | null;
  message?: string | null;
  reportedAt?: string;
  transactionsDeleted?: number | null;
  outboxPending?: number | null;
  keptZs?: number | null;
  keptZNumbers?: number[] | null;
  keptShopZs?: number | null;
  countersLowered?: { counter: string; before: number; after: number }[];
}

export interface TillResetRecord {
  id: string;
  kind: TillResetKind;
  kindText: string;
  reason: string;
  by: string;
  requestedAt: string;
  expiresAt?: string;
  completedAt?: string | null;
  status: TillResetStatus;
  result?: TillResetResult | null;
  exceptionId?: string | null;
}

export interface TillResetPreview {
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  online: boolean;
  lastHeartbeatAt?: string | null;
  unsynced: {
    outbox?: number | null;
    documents?: number | null;
    at?: string | null;
    offlineTillZs?: number | null;
    offlineTillZConflict?: boolean;
  };
  warnings: string[];
  keptZs: { days: number; numbers: number[]; awaitingOnTill: number };
  counters: {
    stay: boolean;
    lastTillZNumber: number;
    reportedLastZNumber?: number | null;
    documentCounters: { cloud: Record<string, number>; reported?: Record<string, number> | null };
  };
  pending: TillResetRecord | null;
  last: TillResetRecord | null;
}

/** Whether support may send the command now, and if not, why. */
export function tillResetBlock(
  p: TillResetPreview,
  kind: TillResetKind | null,
  reason: string,
): 'pending' | 'kind' | 'reason' | null {
  if (p.pending) return 'pending';
  if (!kind) return 'kind';
  if (reason.trim().length < TILL_RESET_MIN_REASON) return 'reason';
  return null;
}

/** "Z 2–5, 9": the Zs the till keeps, consecutive numbers as ranges. */
export function keptZRanges(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const n of sorted) {
    if (start === null) {
      start = n;
    } else if (prev !== null && n !== prev + 1) {
      parts.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = n;
    }
    prev = n;
  }
  if (start !== null && prev !== null) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join(', ');
}

/** How the machine page shows the last command. */
export function tillResetTone(status: TillResetStatus): 'secondary' | 'outline' | 'destructive' {
  if (status === 'pending') return 'secondary';
  if (status === 'done') return 'outline';
  return 'destructive';
}
