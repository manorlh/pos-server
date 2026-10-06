/**
 * "הפקת Z מהענן ע״י התמיכה" — support produces a dead till's Z from the cloud
 * (pos-server docs/SPEC_OFFLINE_TILL_Z.md §4.6). The API, and the pure rules the dialog
 * shows. Kept free of React and of the `@/` alias so `npm test` runs it on its own.
 */

export type SupportZReason = 'destroyed' | 'lost' | 'permanent_failure';

export const SUPPORT_Z_REASONS: SupportZReason[] = ['destroyed', 'lost', 'permanent_failure'];

export interface SupportZCounterGap {
  series: string;
  cloudMax: number;
  reported: number;
  from: number;
  to: number;
  count: number;
}

export interface SupportZPreview {
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  zMode: { kind: 'till' } | { kind: 'shop'; local: boolean };
  online: boolean;
  lastHeartbeatAt?: string | null;
  shifts: {
    id: string;
    sequenceNumber?: number | null;
    status: string;
    openedAt?: string | null;
    closedAt?: string | null;
    willClose: boolean;
    businessDate?: string | null;
  }[];
  documents: {
    count: number;
    firstDocumentNumber?: string | null;
    lastDocumentNumber?: string | null;
    totalSales?: string | null;
    totalRefunds?: string | null;
    totalCash?: string | null;
    totalCard?: string | null;
    vatTotal?: string | null;
  } | null;
  zNumber: number | null;
  cloudLastZNumber: number;
  reportedLastZNumber?: number | null;
  reportedPendingZs?: number | null;
  skippedNumbers: number[];
  documentCounters: { gaps: SupportZCounterGap[] };
  lastReportedPendingDocuments?: number | null;
  alreadyProduced?: SupportZRecord | null;
}

export interface SupportZRecord {
  at: string;
  by: string;
  reason: SupportZReason;
  reasonText: string;
  note?: string | null;
  zReportId?: string | null;
  zNumber?: number | null;
  closedShiftIds: string[];
  shiftIds: string[];
  skippedNumbers: number[];
  skippedLabel?: string | null;
  exceptionId?: string | null;
}

/** "3–5, 8": consecutive numbers as ranges, for "printed on the device and never sent". */
export function numberRanges(numbers: readonly number[]): string {
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

/** Whether support may act now: a till that is online closes itself; one with nothing to do waits. */
export function supportZBlock(p: SupportZPreview): 'online' | 'nothing' | null {
  if (p.online) return 'online';
  if (p.shifts.length === 0) return 'nothing';
  return null;
}
