/**
 * Kiosk orders, pickup numbers, the bon's write-ahead and the kiosk's identity
 * (pos-android domain/KioskOrders.kt, domain/KioskIdentity.kt, data/repo/KioskRepository.kt;
 * pos-server docs/SPEC_KIOSK.md §3, §14).
 */

/* ---------------------------------------------------------------- pickup */

export interface PickupRules {
  scope: 'kiosk' | 'shop';
  prefix: string;
  start: number;
  max: number;
  /**
   * "מספר הזמנה": with the letter ("A-17", the default) or the number alone ("17"). The number
   * alone comes with `scope: 'shop'` (the config's repair); a number drawn without the cloud keeps
   * its letter and the L tag ("AL-17") in either format, so it is never one of the shop's.
   */
  labelFormat?: 'prefixed' | 'number';
}

/** The next daily number: `start` on a new day, then +1, back to `start` after `max`. */
export function nextPickup(lastDate: string | null, last: number | null, today: string, rules: Pick<PickupRules, 'start' | 'max'>): number {
  const start = Number.isInteger(rules.start) && rules.start >= 1 ? rules.start : 1;
  const max = Number.isInteger(rules.max) && rules.max > start ? rules.max : 999;
  if (lastDate !== today || !last) return start;
  const n = last + 1;
  return n > max || n < start ? start : n;
}

/**
 * "A-17" with a prefix, "17" without — and "17" whatever the prefix with `format: 'number'`
 * ("מספר בלבד", `pickup.labelFormat`; the server's kiosk_pickup.pickup_label, one rule).
 */
export function pickupLabel(prefix: string | null | undefined, n: number, format?: 'prefixed' | 'number' | null): string {
  if (format === 'number') return String(n);
  const p = (prefix ?? '').trim();
  return p ? `${p}-${n}` : String(n);
}

/** A shop-scope kiosk's own number while the cloud did not answer: tagged L ("AL-4"). */
export function offlinePickupLabel(prefix: string | null | undefined, n: number): string {
  return pickupLabel(`${(prefix ?? '').trim()}L`, n);
}

/** How long the cloud gets for a shop-scope number before the local one is used. */
export const SHOP_PICKUP_TIMEOUT_MS = 3_000;

/* --------------------------------------------------------------- identity */

export interface KioskOperator {
  id: string;
  name: string;
}

/**
 * The kiosk runs as itself, never an employee: the cloud's operator when it is a kiosk id,
 * else `kiosk:<machineId>`; the name the cloud's, else the kiosk's, else "קיוסק".
 */
export function kioskOperator(cloud: { id?: unknown; name?: unknown } | null | undefined, machineId: string, kioskName: string | null | undefined): KioskOperator {
  const id = typeof cloud?.id === 'string' && cloud.id.startsWith('kiosk:') ? cloud.id : `kiosk:${machineId}`;
  const name =
    (typeof cloud?.name === 'string' && cloud.name.trim()) || (typeof kioskName === 'string' && kioskName.trim()) || 'קיוסק';
  return { id, name };
}

/** The name on the automatic close and Z. */
export function closerName(op: KioskOperator): string {
  return `קיוסק · ${op.name}`;
}

/* -------------------------------------------------------------------- bon */

export type BonStatus = 'none' | 'queued' | 'sent' | 'printed' | 'failed';

export interface BonState {
  fulfillmentMode: 'BON' | 'KDS';
  paid: boolean;
  bonRequestedAtMs: number | null;
  jobIds: string[];
}

export type BonStep = 'none' | 'wait' | 'enqueue' | 'recover' | 'track';

/**
 * The bon goes out once: "requested" is written BEFORE the jobs are queued, the job ids after.
 * A retry / restart only tracks; a crash between the two recovers (looks for queued jobs of the
 * document) and enqueues only when there are none.
 */
export function bonStep(o: BonState): BonStep {
  if (o.fulfillmentMode !== 'BON') return 'none';
  if (!o.paid) return 'wait';
  if (o.bonRequestedAtMs === null) return 'enqueue';
  if (o.jobIds.length === 0) return 'recover';
  return 'track';
}

/** "printed" only for a printer that confirms paper; "sent" is never reported as printed. */
export function bonStatusOf(input: { requested: boolean; noPrinter: boolean; jobs: Array<'queued' | 'sending' | 'sent' | 'failed'> }): BonStatus {
  if (!input.requested) return 'none';
  if (input.noPrinter) return 'failed';
  if (input.jobs.length === 0) return 'queued';
  if (input.jobs.some((j) => j === 'failed')) return 'failed';
  if (input.jobs.every((j) => j === 'sent')) return 'sent';
  return 'queued';
}

/* ---------------------------------------------------------------- receipt */

/**
 * The customer's receipt as the cloud takes it (pos-android domain/KioskOrders.kt
 * KioskReceiptStatus; pos-server schemas/kiosk.py KioskOrderIn.receiptStatus): "pending" until
 * the "ask" question is answered, "skipped" when none was printed by policy or for a recovered
 * sale (staff re-print), "printed" / "declined" / "failed".
 */
export type ReceiptStatus = 'pending' | 'printed' | 'declined' | 'failed' | 'skipped';

const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['pending', 'printed', 'declined', 'failed', 'skipped'];

/** The receipt right after the money, by the policy (KioskViewModel.onApproved). */
export function receiptAfterApproval(policy: 'always' | 'ask' | 'never', recovered: boolean): ReceiptStatus {
  if (recovered) return 'skipped';
  return policy === 'always' ? 'printed' : policy === 'ask' ? 'pending' : 'skipped';
}

/**
 * Any stored value as one the cloud takes. Orders written by earlier versions said "none" (no receipt:
 * a "never" policy, an unanswered "ask", a recovered sale) or "queued"; the cloud refused both,
 * so those orders were sent again on every sync, forever.
 */
export function receiptStatusOf(v: unknown): ReceiptStatus {
  if (v === 'none') return 'skipped';
  if (v === 'queued') return 'pending';
  return RECEIPT_STATUSES.includes(v as ReceiptStatus) ? (v as ReceiptStatus) : 'pending';
}

/* ------------------------------------------------------------ the order */

export interface KioskOrder {
  localId: string;
  createdAtMs: number;
  businessDate: string;
  /** Null: "ללא סוג שירות". */
  serviceType: 'take_away' | 'eat_in' | null;
  tableRef: string | null;
  fulfillmentMode: 'BON' | 'KDS';
  configVersion: string | null;
  customerName: string | null;
  customerPhone: string | null;
  itemCount: number;
  totalAgorot: number;
  tipAgorot: number;
  paid: boolean;
  paidAt: string | null;
  transactionId: string | null;
  /** As printed: "20000057". */
  transactionNumber: string | null;
  pickupNumber: number | null;
  pickupLabel: string | null;
  bonRequestedAtMs: number | null;
  bonJobIds: string[];
  bonStatus: BonStatus;
  bonDetail: string | null;
  receiptStatus: ReceiptStatus;
  recovered: boolean;
  syncedHash: string | null;
}

/** The order as `POST /sync/{m}/kiosk/orders` takes it (KioskOrder.wire). */
export function orderWire(o: KioskOrder): Record<string, unknown> {
  return {
    localId: o.localId,
    transactionId: o.transactionId,
    transactionNumber: o.transactionNumber,
    pickupNumber: o.pickupNumber ?? 0,
    pickupLabel: o.pickupLabel ?? '',
    businessDate: o.businessDate,
    serviceType: o.serviceType,
    tableRef: o.tableRef,
    fulfillmentMode: o.fulfillmentMode,
    configVersion: o.configVersion,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    itemCount: o.itemCount,
    totalAgorot: o.totalAgorot,
    tipAgorot: o.tipAgorot,
    paidAt: o.paidAt,
    bonStatus: o.bonStatus,
    bonDetail: o.bonDetail,
    receiptStatus: receiptStatusOf(o.receiptStatus),
    status: o.bonStatus === 'failed' ? 'paid_print_failed' : o.recovered ? 'recovered' : 'paid',
  };
}

/** Sent again whenever what the cloud has differs from what the order now says. */
export function orderHash(o: KioskOrder): string {
  const s = JSON.stringify(orderWire(o));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export function orderNeedsSync(o: KioskOrder): boolean {
  return o.paid && o.syncedHash !== orderHash(o);
}

/** A local business date, yyyy-MM-dd (the device's own day, as Clock.today()). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The customer's phone: the Android kiosk's rule, one copy for every TS kiosk (client lib/kioskCustomer.ts). */
export { phoneValid } from '@dash-lib/kioskCustomer';
