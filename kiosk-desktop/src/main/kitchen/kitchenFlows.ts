/**
 * Where a Windows sale's kitchen tickets come from — the two roles, as the Android app does them:
 *
 *  - the till's counter sale (pos-android ui/checkout/CheckoutViewModel.kt `queueKitchen`,
 *    KitchenPrintService.printSaleTickets, ui/kds/KdsBridge.releaseSaleNow): its tickets when "בונים במכירה" is on
 *    (`kitchenTicketsOnSale`, the printers' option or the till parameter) and the KDS does not replace them; its
 *    release to the KDS when the shop runs it (`kdsEnabled`) — a KDS-only shop's tickets held as its fallback;
 *  - the kiosk's paid order (data/repo/KioskBonService.kt `queueTickets`): its bon on the kitchen printers by the
 *    routing, or on the one bon printer it names, headed by the pickup number — once (its job ids derive from the
 *    order), its own share on its own printer only with "בון מטבח במדפסת הקיוסק" on.
 */

import type { SaleLine } from '../../core/sale';
import { bonOnKioskSetting, kioskBonOwnShare, type KioskBonRoute } from '../../core/kioskBonRoute';
import { kdsHoldOf, kdsWorkflowOf } from '../../core/kitchen/kds';
import { kioskBonHeadline, kitchenLinesOfSale, LABELS, saleTicket } from '../../core/kitchen/tickets';
import { kdsSaleRelease, saleDispatchId } from '../kiosk/kdsRelease';
import type { KdsOutbox } from './kdsOutbox';
import type { KitchenService } from './kitchenService';

const flag = (v: unknown): boolean => v === true || ['true', '1', 'yes', 'on', 'כן'].includes(String(v ?? '').trim().toLowerCase());

/** `tablesMode` (TablesMode.parse): anything but a known mode is off. */
export function tablesOff(value: unknown): boolean {
  const v = typeof value === 'string' ? value.trim() : '';
  return !['קופה אחת', 'single', 'מסונכרן בין הקופות', 'synced', 'רשת מקומית (קופה ראשית)', 'lan'].includes(v);
}

export interface TillSaleInput {
  transactionId: string;
  documentType: number;
  /** As the receipt prints it ("20000057"). */
  documentNumber: string;
  lines: readonly SaleLine[];
  cashierName: string | null;
  createdAt: string;
  orderName?: string | null;
  dining?: 'take_away' | 'eat_in' | null;
}

export interface TillKitchenDeps {
  kitchen: KitchenService;
  kds: KdsOutbox;
  params: Record<string, unknown>;
  /** The product's category NOW (the catalog's). */
  categoryOf(productId: string): string | null;
  log(m: string): void;
}

/**
 * A completed counter sale to the kitchen: its tickets (durable before this returns), its KDS release. Never for a
 * credit note. Returns the lines no kitchen printer takes, by name (said to the cashier).
 */
export function tillSaleToKitchen(d: TillKitchenDeps, s: TillSaleInput): { jobIds: string[]; unrouted: string[]; released: boolean } {
  if (s.documentType === 330 || s.documentType === -400) return { jobIds: [], unrouted: [], released: false };
  const lines = kitchenLinesOfSale(s.lines, d.categoryOf);
  if (lines.length === 0) return { jobIds: [], unrouted: [], released: false };
  const wf = kdsWorkflowOf(d.params);
  const config = d.kitchen.config();
  const ticket = () =>
    saleTicket({ lines, orderRef: s.documentNumber, waiterName: s.cashierName, customerName: s.orderName ?? null, dining: s.dining ?? null, createdAt: s.createdAt }).ticket;
  let jobIds: string[] = [];
  let unrouted: string[] = [];
  if (wf.printsTickets && (config.options.kitchenTicketsOnSale || flag(d.params.kitchenTicketsOnSale))) {
    const q = d.kitchen.enqueue(ticket(), lines, { unroutedToTill: tablesOff(d.params.tablesMode), idSeed: `sale:${s.transactionId}`, refId: s.transactionId });
    jobIds = q.jobIds;
    unrouted = q.unrouted;
  }
  let released = false;
  if (wf.reportsOrders) {
    const id = saleDispatchId(s.transactionId);
    if (!d.kds.isPending(id)) {
      const body = {
        ...kdsSaleRelease({
          transactionId: s.transactionId,
          transactionNumber: s.documentNumber,
          order: { serviceType: s.dining ?? null, customerName: s.orderName ?? null, customerPhone: null, pickupNumber: null },
          lines: s.lines,
          categoryOf: d.categoryOf,
          actorName: s.cashierName,
          occurredAt: new Date().toISOString(),
        }),
        source: 'quick',
      };
      // KDS only: its tickets wait held — printed by themselves when the KDS misses it (the fallback on), or shown.
      let hold: string | null = null;
      if (!wf.printsTickets) {
        const h = kdsHoldOf(id);
        const t = ticket();
        const prepared = d.kitchen.enqueue({ ...t, notice: t.notice ?? LABELS.kdsFallback }, lines, { hold: h, idSeed: `kds:${id}`, refId: s.transactionId });
        if (prepared.jobIds.length > 0) hold = h;
      }
      d.kds.enqueue(id, body, hold, wf.printsOnFallback);
      released = true;
    }
  }
  if (unrouted.length > 0) d.log(`kitchen: sale ${s.documentNumber} — no kitchen printer takes: ${unrouted.join(', ')}`);
  return { jobIds, unrouted, released };
}

export interface KioskBonInput {
  orderId: string;
  pickupLabel: string | null;
  customerName: string | null;
  tableRef: string | null;
  /** As printed ("40000057"); null before payment. */
  transactionNumber: string | null;
  service: 'take_away' | 'eat_in' | null;
  createdAt: string;
  kioskName: string;
  lines: readonly SaleLine[];
  copies: number;
  /** "הדפסה חוזרת" / "ממתין לתשלום בקופה" — a band on every copy. */
  notice: string | null;
  /** A person's reprint: fresh jobs (never the first ones' ids). */
  nonce?: string | null;
}

/**
 * A kiosk order's bon through the kitchen queue ([route]: kitchen — by the routing; single — the one bon printer the
 * kiosk names, not its own). The job ids, and why nothing was queued when nothing was.
 */
export function kioskBonToKitchen(
  kitchen: KitchenService,
  route: KioskBonRoute,
  printing: { bonPrinterId?: string | null; bonOnKiosk?: boolean | string | null },
  b: KioskBonInput,
  categoryOf: (productId: string) => string | null,
): { jobIds: string[]; detail: string | null } {
  const lines = kitchenLinesOfSale(b.lines, categoryOf);
  if (lines.length === 0) return { jobIds: [], detail: null };
  const headline = kioskBonHeadline(b.pickupLabel, b.customerName, b.tableRef);
  const ids: string[] = [];
  let detail: string | null = null;
  if (route === 'kitchen') {
    const unrouted = kitchen.unroutedOf(lines);
    if (unrouted.length > 0) detail = `פריטים שלא נותבו למדפסת: ${unrouted.join(', ')}`;
  }
  const copies = Math.max(1, Math.min(5, b.copies || 1));
  for (let copy = 1; copy <= copies; copy++) {
    const notice = [b.notice, copy > 1 ? `עותק ${copy}` : null].filter(Boolean).join(' · ') || null;
    const { ticket } = saleTicket({ lines, orderRef: b.transactionNumber, waiterName: b.kioskName, customerName: headline, dining: b.service, notice, createdAt: b.createdAt });
    const q = kitchen.enqueue(ticket, lines, {
      unroutedToTill: false,
      onlyPrinterId: route === 'single' ? (printing.bonPrinterId ?? null) : null,
      // The till copy on the kiosk's own printer only with the setting on.
      ownPrinter: kioskBonOwnShare(route, bonOnKioskSetting(printing.bonOnKiosk)),
      idSeed: `kiosk-bon:${b.orderId}:${b.nonce ?? 'first'}:${copy}`,
      refId: b.orderId,
    });
    ids.push(...q.jobIds);
  }
  return { jobIds: ids, detail };
}
