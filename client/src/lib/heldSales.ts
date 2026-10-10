/**
 * Held sales ("מכירות מושהות") at a remote close (pos-server app/services/held_sales_close.py): the list
 * a till reported when it deferred, and the two choices — "בטל מכירות מושהות וסגור" (the shop's
 * `remoteCancelHeldSales`, on by default; a reason) and "סגור והשאר מושהות" (the shop's
 * `allowCloseWithHeldSales`, or a super admin with a reason). The pure parts.
 */

export interface HeldSale {
  id: string;
  at: string | null;
  cashier: string | null;
  itemCount: number;
  total: string | null;
  items: string[];
}

export interface HeldSalesOffer {
  allowed: boolean;
  needsReason: boolean;
  whyNot?: string;
}

export interface HeldSaleCancelled {
  heldSaleId: string | null;
  reason: string | null;
  by: string | null;
  total: string | null;
  items: unknown;
  at: string | null;
}

/** The fields a deferral on held sales adds to a run item or a till's pending close. */
export interface HeldSalesState {
  heldSales?: number | null;
  heldSalesList?: HeldSale[];
  keepHeldSales?: HeldSalesOffer | boolean | null;
  cancelHeldSales?: HeldSalesOffer | null;
  heldSalesCancelled?: HeldSaleCancelled[];
}

export const CANCEL_LABEL = 'בטל מכירות מושהות וסגור';
export const KEEP_LABEL = 'סגור והשאר מושהות';

/** "17:40 · דנה · 2 פריטים · ₪42.50" */
export function heldSaleLine(s: HeldSale): string {
  const time = s.at ? new Date(s.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '—';
  const items = s.itemCount === 1 ? 'פריט אחד' : `${s.itemCount} פריטים`;
  const total = s.total != null && s.total !== '' ? `₪${Number(s.total).toFixed(2)}` : '—';
  return [time, s.cashier || '—', items, total].join(' · ');
}

/** The keep offer as an object (a till's pending close says only whether it was already kept). */
export function asOffer(v: HeldSalesOffer | boolean | null | undefined): HeldSalesOffer | null {
  return v && typeof v === 'object' ? v : null;
}

/** A typed reason, as the server takes it (≥ 5 characters). */
export function reasonOk(reason: string): boolean {
  return reason.trim().length >= 5;
}

/** Whether a choice can be sent now: offered, and a reason typed when one is needed. */
export function canSend(offer: HeldSalesOffer | null, reason: string): boolean {
  return !!offer && offer.allowed && (!offer.needsReason || reasonOk(reason));
}
