/**
 * "בון לא הודפס" — the tickets that need a person, as the cloud's alerts take them (`POST /sync/{m}/kitchen/bon-alerts`,
 * pos-server app/routers/printers.py): the port of pos-android hardware/kitchen/PrintQueueView.kt `BonReason`,
 * `alertState`, `alerts`, `titleOf`, `itemsOf`. Pure.
 */

import { codeOf, HOST_SILENT, KDS_HOLD_PREFIX, needsAttention, type KitchenJob } from './queue';
import { TILL_PRINTER_ID } from './routing';
import type { WireTicket } from './tickets';

export type BonReason = 'no_paper' | 'cover_open' | 'printer_error' | 'offline' | 'uncertain' | 'unconfirmed' | 'kds_not_taken' | 'host_silent' | 'slow' | 'expired' | 'refused' | 'error';

/** What [LAN_UNREACHABLE] says on a job whose print server did not answer the status question. */
export const LAN_UNREACHABLE = 'print server not reached';

function looksOffline(error: string): boolean {
  const e = error.toLowerCase();
  return ['refused', 'no answer', 'timed out', 'timeout', 'unreachable', 'connect', 'host', 'reset', 'econn', 'ehostunreach', 'enetunreach'].some((w) => e.includes(w));
}

export function bonReason(job: Pick<KitchenJob, 'lastError' | 'state' | 'attempts'>): BonReason | null {
  const error = job.lastError;
  if (!error) return null;
  const code = codeOf(error);
  switch (code) {
    case 'no_paper':
    case 'cover_open':
    case 'printer_error':
    case 'uncertain':
    case 'kds_not_taken':
    case 'slow':
      return code;
    case KDS_HOLD_PREFIX:
      return null;
  }
  if (error === HOST_SILENT || error === LAN_UNREACHABLE) return 'host_silent';
  if (error === 'expired') return 'expired';
  if (job.state === 'failed' && job.attempts <= 1 && !looksOffline(error)) return 'refused';
  if (looksOffline(error)) return 'offline';
  return 'error';
}

export function alertState(job: KitchenJob, reason: BonReason | null): string {
  if (reason === 'uncertain') return 'uncertain';
  if (reason === 'unconfirmed') return 'unconfirmed';
  if (reason === 'kds_not_taken') return 'kds_not_taken';
  if (job.state === 'relayed') return 'waiting_host';
  if (job.state === 'pending') return 'retrying';
  return 'failed';
}

/** "שולחן 12", "דנה · 20000057", "הזמנה 20000057". */
export function titleOf(ticket: WireTicket | null): string | null {
  if (!ticket || ticket.source === 'test') return null;
  const table = ticket.tableName?.trim();
  const name = ticket.customerName?.trim();
  const ref = ticket.orderRef?.trim();
  if (table) return `שולחן ${table}`;
  if (name && ref) return `${name} · ${ref}`;
  if (ref) return `הזמנה ${ref}`;
  return name || null;
}

export function itemsOf(ticket: WireTicket | null): number {
  return (ticket?.lines ?? []).reduce((n, l) => n + Math.max(1, Math.ceil(Math.abs(l.quantity))), 0);
}

export interface BonAlert {
  id: string;
  state: string;
  reason: string | null;
  printerId: string | null;
  printerName: string;
  title: string | null;
  items: number;
  attempts: number;
  since: string;
  error?: string | null;
  handledBy?: string | null;
  handledNote?: string | null;
}

const ticketOf = (j: KitchenJob): WireTicket | null => {
  try {
    return JSON.parse(j.ticketJson) as WireTicket;
  } catch {
    return null;
  }
};

/** The device's list for the cloud: every ticket that needs a person, and those a person handled since the last report. */
export function bonAlerts(jobs: readonly KitchenJob[], handled: ReadonlyMap<string, { job: KitchenJob; by: string }>): BonAlert[] {
  const open = jobs
    .filter((j) => j.kind !== 'test' && needsAttention(j))
    .map((j): BonAlert => {
      const t = ticketOf(j);
      const reason = bonReason(j);
      return {
        id: j.id,
        state: alertState(j, reason),
        reason: reason ?? 'error',
        printerId: j.printerId === TILL_PRINTER_ID ? null : j.printerId,
        printerName: j.printerName.slice(0, 80),
        title: titleOf(t)?.slice(0, 80) ?? null,
        items: itemsOf(t),
        attempts: j.attempts,
        since: new Date(j.createdAt).toISOString(),
        error: j.lastError?.slice(0, 200) ?? null,
      };
    });
  const openIds = new Set(open.map((o) => o.id));
  const done = [...handled.values()]
    .filter(({ job }) => job.kind !== 'test' && !openIds.has(job.id))
    .map(({ job, by }): BonAlert => {
      const t = ticketOf(job);
      return {
        id: job.id,
        state: 'handled',
        reason: bonReason(job),
        printerId: job.printerId === TILL_PRINTER_ID ? null : job.printerId,
        printerName: job.printerName.slice(0, 80),
        title: titleOf(t)?.slice(0, 80) ?? null,
        items: itemsOf(t),
        attempts: job.attempts,
        since: new Date(job.createdAt).toISOString(),
        handledBy: by.slice(0, 80),
        handledNote: job.discardReason?.slice(0, 200) ?? null,
      };
    });
  return [...open, ...done];
}
