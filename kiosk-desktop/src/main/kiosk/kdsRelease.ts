/**
 * A paid kiosk order to the cloud's kitchen engine (pos-server docs/SPEC_KDS.md §4,
 * `POST /sync/{m}/kds/release`) — the same release the Android kiosk sends
 * (pos-android ui/kds/KdsBridge.kt `releaseSale`, domain/KdsRelease.kt):
 *
 *  - `source: "kiosk"`, the sale's document as `sourceRef`, `trigger: "payment"`, `paid: true`;
 *  - the id is the idempotency key, derived from the document (`saleDispatchId`, the same
 *    derivation as the till's `KdsRelease.saleDispatchId`): a retry, a restart or a second
 *    enqueue of the same sale is the same release — never a second round;
 *  - the header as the bon prints it: the document number (prefix and all), the pickup number
 *    the kiosk gave the customer (so the board shows the number on the customer's slip), the
 *    name and phone the customer left, the service type;
 *  - every line once, keyed `<line>:0`; its options as the kitchen reads them (`mods`), its
 *    notes, and its category (the routing to a station).
 *
 * Sent only for an order taken in KDS mode (`fulfillmentMode: "KDS"`) in a shop that runs the
 * KDS (`kdsEnabled`, KdsWorkflowConfig.reportsOrders on the till) — a BON order prints its bon
 * and never appears on a kitchen screen. Pure but for the hash; tested in test/kdsRelease.test.ts.
 */

import { createHash } from 'node:crypto';
import type { KioskOrder } from '../../core/kioskOrders';
import type { SaleLine } from '../../core/sale';

/** A name-based (version 3, MD5) UUID of the bytes alone — Java's `UUID.nameUUIDFromBytes`. */
export function nameUuid(name: string): string {
  const b = createHash('md5').update(Buffer.from(name, 'utf8')).digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The release id of a paid sale: one per document, whoever sends it and however often. */
export function saleDispatchId(transactionId: string): string {
  return nameUuid(`kds-release:sale:${transactionId}`);
}

/** Does this order go to the kitchen screens (else its bon prints)? */
export function releasesToKds(order: Pick<KioskOrder, 'fulfillmentMode'>, kdsEnabled: boolean): boolean {
  return order.fulfillmentMode === 'KDS' && kdsEnabled;
}

export interface KdsSaleInput {
  transactionId: string;
  /** As printed: `40000057`. */
  transactionNumber: string | null;
  order: Pick<KioskOrder, 'serviceType' | 'customerName' | 'customerPhone' | 'pickupNumber'>;
  lines: readonly SaleLine[];
  /** productId → its category, from the catalog (the station routing). */
  categoryOf: (productId: string) => string | null;
  /** The kiosk's name: who "served" it. */
  actorName: string | null;
  occurredAt: string;
}

const cut = (s: string | null | undefined, n: number): string | null => {
  const t = (s ?? '').trim();
  return t ? t.slice(0, n) : null;
};

export function kdsSaleRelease(input: KdsSaleInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: saleDispatchId(input.transactionId),
    source: 'kiosk',
    sourceRef: input.transactionId,
    trigger: 'payment',
    paid: true,
    fallbackPrinted: false,
    occurredAt: input.occurredAt,
  };
  const actor = cut(input.actorName, 200);
  if (actor) {
    body.actorName = actor;
    body.waiterName = actor;
  }
  if (input.order.serviceType === 'eat_in' || input.order.serviceType === 'take_away') body.serviceType = input.order.serviceType;
  const name = cut(input.order.customerName, 100);
  if (name) body.pickupName = name;
  const phone = cut(input.order.customerPhone, 30);
  if (phone) body.contactPhone = phone;
  if (input.transactionNumber) body.transactionNumber = input.transactionNumber.slice(0, 50);
  const pickup = input.order.pickupNumber;
  if (typeof pickup === 'number' && Number.isInteger(pickup) && pickup >= 1 && pickup <= 9999) body.pickupNumber = pickup;
  body.items = input.lines
    .filter((l) => l.qty > 0)
    .map((l) => {
      const item: Record<string, unknown> = {
        lineKey: `${l.key}:0`.slice(0, 120),
        productId: l.productId.slice(0, 64),
        name: l.name.slice(0, 200),
        quantity: l.qty,
      };
      const category = input.categoryOf(l.productId);
      if (category) item.categoryId = category.slice(0, 64);
      const notes = cut(l.notes.join(' · '), 500);
      if (notes) item.notes = notes;
      const mods = [
        ...l.options.map((o) => (o.qty > 1 ? `${o.qty}× ${o.name}` : o.name)),
        // A meal: its components, for the kitchen to make.
        ...(l.meal?.components ?? []).map((c) => c.name),
      ]
        .filter((m) => m.trim())
        .slice(0, 40);
      if (mods.length > 0) item.mods = mods;
      return item;
    });
  body.noteUpdates = [];
  return body;
}
