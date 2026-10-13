/**
 * "ביטול שולחן מהדשבורד" in the LAN mode (P:/specs/remote-table-cancel.md): the cancel is a command to
 * the shop's tables host, followed by `GET /device-commands/{id}` (pos-server
 * app/services/remote_table_cancel.py `view`). Pure: what the live tables dialog shows for it.
 */

/** How the dashboard may cancel an order (the live view's `cancel` per table). */
export type TableCancelMode = 'direct' | 'via_till' | 'blocked';

export interface TableCancelRoute {
  mode: TableCancelMode;
  /** direct: "cloud" | "single" | "hostless"; blocked: "setting" | "no_capability". */
  why: string | null;
  hostName: string | null;
  timeoutSeconds: number | null;
}

/** The cancel as the cloud follows it (by the first command's id). */
export interface RemoteCancelStatus {
  id: string;
  currentId: string;
  status: string;
  outcome: 'waiting' | 'done' | 'refused' | 'timeout' | 'failed' | 'cancelled';
  reason: string | null;
  retargeted: boolean;
  voidedPrinters: string[];
  kds: boolean | null;
  hostName: string | null;
  tableLabel: string | null;
  expiresAt: string | null;
}

/** The 202 of `POST /tables/tables/{id}/cancel` in the LAN mode. */
export interface RemoteCancelRequested {
  mode: 'via_till';
  commandId: string;
  status: string;
  orderId: string | null;
  tableLabel: string | null;
  hostMachineId: string;
  hostName: string | null;
  timeoutSeconds: number;
  expiresAt: string | null;
}

export type RemoteCancelPhase = 'sending' | 'done' | 'refused' | 'timeout' | 'failed';

export interface RemoteCancelView {
  phase: RemoteCancelPhase;
  /** A key under `tables.remoteCancel`. */
  key: string;
  values?: Record<string, string>;
  /** The floor is stale: refresh it now. */
  refresh: boolean;
}

/** The host's refusals the dashboard words (spec §סירובים); any other is shown with its code. */
export const REFUSAL_KEYS: Record<string, string> = {
  table_not_open: 'refused.table_not_open',
  payment_in_progress: 'refused.payment_in_progress',
  not_host: 'refused.not_host',
  order_changed: 'refused.order_changed',
};

/** Past the timeout by this much with no word from the cloud either: "לא זמינה" all the same. */
export const GRACE_MS = 15_000;

/** "בוטל בקופה ✓", and what reached the kitchen: the void ticket printed, the KDS told, or both. */
export function doneKey(voidedPrinters: readonly string[] | null | undefined, kds: boolean | null | undefined): string {
  const printed = (voidedPrinters?.length ?? 0) > 0;
  if (printed && kds) return 'donePrintedKds';
  if (printed) return 'donePrinted';
  if (kds) return 'doneKds';
  return 'done';
}

/**
 * What the dialog shows for the cancel: [status] as last read (null before the first read), sent at
 * [startedAtMs] with the host's [timeoutSeconds], now [nowMs].
 */
export function remoteCancelView(
  status: RemoteCancelStatus | null,
  startedAtMs: number,
  timeoutSeconds: number,
  nowMs: number,
): RemoteCancelView {
  const outcome = status?.outcome ?? 'waiting';
  switch (outcome) {
    case 'done':
      return { phase: 'done', key: doneKey(status?.voidedPrinters, status?.kds), refresh: true };
    case 'refused': {
      const reason = status?.reason ?? '';
      const key = REFUSAL_KEYS[reason];
      return {
        phase: 'refused',
        key: key ?? 'refused.other',
        values: key ? undefined : { reason: reason || '?' },
        refresh: reason === 'order_changed' || reason === 'table_not_open',
      };
    }
    case 'timeout':
    case 'cancelled':
      return { phase: 'timeout', key: 'timeout', refresh: false };
    case 'failed':
      return { phase: 'failed', key: 'failed', refresh: false };
    default:
      if (nowMs - startedAtMs > timeoutSeconds * 1000 + GRACE_MS) {
        return { phase: 'timeout', key: 'timeout', refresh: false };
      }
      return { phase: 'sending', key: status?.retargeted ? 'retargeting' : 'sending', refresh: false };
  }
}

/** Still following it: poll again. */
export function stillSending(view: RemoteCancelView): boolean {
  return view.phase === 'sending';
}
