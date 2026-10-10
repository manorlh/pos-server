/**
 * The kiosk's fiscal ledger, as a till's (pos-android data/repo/SaleRepository.kt,
 * ShiftRepository.kt): documents, shifts and the per-series counters, in one SQLite file.
 *
 *  - a card sale is written as a `pending` document (with its number, saved before use) BEFORE
 *    the terminal is touched; approved → `completed`, declined/not found → `cancelled` (the number
 *    is burned, never reused; a retry is a new document); unknown → stays `pending` and blocks;
 *  - only final documents go to the outbox (one `transaction` row, at completion or void);
 *  - vouchers (docs/SPEC_VOUCHER_PRODUCTION.md §7): a discount voucher is a discount on the document
 *    (`items[].voucherDiscount`, `voucherDiscounts[]`, inside `documentDiscount`), a goods voucher a
 *    `production_voucher` payment leg beside the card for what it does not cover — a sale the vouchers
 *    pay whole is completed with no card at all;
 *  - shifts open and close as the kiosk itself (`kiosk:<machineId>`), float 0; the close freezes the
 *    X and goes to the outbox after the shift's documents.
 */

import { randomUUID } from 'node:crypto';
import type { VoucherOutcome } from '@dash-lib/kioskVouchers';
import { DocumentCounters, seriesOf, type CounterStore } from '../../core/documentNumbers';
import { localDate } from '../../core/kioskOrders';
import { toShekels } from '../../core/money';
import {
  buildXTill,
  lastTransactionNumberOf,
  lineGross,
  optionCharged,
  unitAgorot,
  type SaleLine,
  type SaleOption,
  type SaleTotals,
  type XDoc,
} from '../../core/sale';
import type { Db } from '../db/sqlite';
import type { Kv } from '../db/schema';
import type { ApprovedCard } from '../payment/provider';
import type { Outbox } from '../sync/outbox';

export type DocStatus = 'pending' | 'completed' | 'cancelled';

/** Everything a document is, as stored (the wire is built from it). */
export interface DocDraft {
  id: string;
  documentType: number;
  number: number;
  prefix: string | null;
  status: DocStatus;
  createdAt: string;
  updatedAt: string;
  shiftId: string;
  businessDate: string;
  cashierId: string;
  cashierName: string;
  branchId: string | null;
  orderId: string | null;
  lines: SaleLine[];
  itemIds: string[];
  /** Products whose stock the cloud tracks: a sale movement goes with them. */
  tracked: string[];
  totals: SaleTotals;
  /** The promotions the sale was priced with ("מבצעים"): what the receipt prints and the cloud reports. */
  promotions?: AppliedPromotionRow[];
  /** The discount vouchers that took something off the sale ("שוברי הנחה"): what each took, the hold the document confirms. */
  voucherDiscounts?: DocVoucherDiscount[];
  /** The goods vouchers that paid part of it: each its own `production_voucher` leg; the card pays the rest. */
  voucherLegs?: DocVoucherLeg[];
  /** Discount vouchers held for the sale that took nothing off it: given back once the sale is written. */
  voucherReleases?: string[];
  /** The card's leg; null with the vouchers alone paying the sale (nothing was charged). */
  card: ApprovedCard | null;
  paymentId: string;
  /** The lookup's evidence on a voided document. */
  voidMeta: Record<string, unknown> | null;
}

export interface ShiftRow {
  id: string;
  sequence_number: number;
  business_date: string;
  opened_at: string;
  opened_by_id: string | null;
  opened_by_name: string | null;
  opening_cash: number;
  status: 'open' | 'closing' | 'closed' | 'retired';
  closed_at: string | null;
  close_payload: string | null;
  close_accepted_at: string | null;
  z_report_id: string | null;
  z_number: number | null;
}

/** One discount voucher on the document (VoucherDiscountJson): the reservation it confirms, what it took, and from which lines. */
export interface DocVoucherDiscount {
  reservationId: string;
  voucherId: string;
  batchId: string;
  serial: number;
  batchName: string;
  kind: 'order_discount' | 'item_discount';
  uses: number;
  amountAgorot: number;
  /** By the basket line's key (the document's item is the line's index). */
  lines: Array<{ lineKey: string; amountAgorot: number }>;
}

/** One goods voucher that paid towards the document: its redemption (linked once the sale is written) and what it paid. */
export interface DocVoucherLeg {
  redemptionId: string;
  serial: number;
  amountAgorot: number;
}

/** What the vouchers' legs pay. */
export function legsAgorot(d: Pick<DocDraft, 'voucherLegs'>): number {
  return (d.voucherLegs ?? []).reduce((s, l) => s + Math.max(0, l.amountAgorot), 0);
}

/** What is left of the goods after every discount for the card: the goods less the legs, never below zero. */
export function cardPrincipalAgorot(d: Pick<DocDraft, 'totals' | 'voucherLegs'>): number {
  return Math.max(0, d.totals.totalAgorot - legsAgorot(d));
}

/** The vouchers' outcomes as the document keeps them: those that took something off, their lines by the basket's key. */
export function docVoucherDiscounts(outcomes: readonly VoucherOutcome[]): DocVoucherDiscount[] {
  return outcomes
    .filter((o) => o.amountAgorot > 0)
    .map((o) => ({
      reservationId: o.voucher.reservationId,
      voucherId: o.voucher.voucherId,
      batchId: o.voucher.batchId,
      serial: o.voucher.serial,
      batchName: o.voucher.batchName,
      kind: o.voucher.benefit.kind === 'item_discount' ? ('item_discount' as const) : ('order_discount' as const),
      uses: o.voucher.uses,
      amountAgorot: o.amountAgorot,
      lines: Object.entries(o.shares)
        .filter(([, a]) => a > 0)
        .map(([lineKey, amountAgorot]) => ({ lineKey, amountAgorot })),
    }));
}

/** One promotion on the document (PromotionJson): how often it applied and what it took off. */
export interface AppliedPromotionRow {
  promotionId: string;
  name: string;
  type: string;
  applications: number;
  discountAgorot: number;
}

const SHIFT_SEQ_KEY = 'shift.lastSequence';

export class Ledger {
  readonly counters: DocumentCounters;

  constructor(
    private readonly db: Db,
    private readonly kv: Kv,
    private readonly outbox: Outbox,
  ) {
    const store: CounterStore = {
      read: (key) => kv.getNumber(key),
      write: (key, value) => kv.setNumber(key, value),
      ledgerMax: (series) =>
        series === undefined
          ? (db.get<{ m: number | null }>('SELECT MAX(number) AS m FROM documents')?.m ?? 0)
          : (db.get<{ m: number | null }>('SELECT MAX(number) AS m FROM documents WHERE series = ?', series)?.m ?? 0),
    };
    this.counters = new DocumentCounters(store);
    this.counters.prime();
  }

  /* --------------------------------------------------------------- shifts */

  currentShift(): ShiftRow | null {
    return this.db.get<ShiftRow>("SELECT * FROM shifts WHERE status = 'open' ORDER BY sequence_number DESC LIMIT 1") ?? null;
  }

  shift(id: string): ShiftRow | null {
    return this.db.get<ShiftRow>('SELECT * FROM shifts WHERE id = ?', id) ?? null;
  }

  /** The shift number: max(ledger + 1, the stored last + 1), saved before use (survives a DB reset). */
  private nextShiftNumber(): number {
    const fromDb = (this.db.get<{ m: number | null }>('SELECT MAX(sequence_number) AS m FROM shifts')?.m ?? 0) + 1;
    const fromKv = (this.kv.getNumber(SHIFT_SEQ_KEY) ?? 0) + 1;
    const next = Math.max(fromDb, fromKv);
    this.kv.setNumber(SHIFT_SEQ_KEY, next);
    return next;
  }

  /** The cloud's last closed shift number (at pairing): only ever up. */
  raiseShiftSequence(atLeast: number | null | undefined) {
    if (!atLeast || atLeast <= (this.kv.getNumber(SHIFT_SEQ_KEY) ?? 0)) return;
    this.kv.setNumber(SHIFT_SEQ_KEY, atLeast);
  }

  /** The open shift, or a new one as the kiosk itself (float 0). */
  openShift(operator: { id: string; name: string }, now = new Date()): ShiftRow {
    return this.db.tx(() => {
      const open = this.currentShift();
      if (open) return open;
      const row: ShiftRow = {
        id: randomUUID(),
        sequence_number: this.nextShiftNumber(),
        business_date: localDate(now.getTime()),
        opened_at: now.toISOString(),
        opened_by_id: operator.id,
        opened_by_name: operator.name,
        opening_cash: 0,
        status: 'open',
        closed_at: null,
        close_payload: null,
        close_accepted_at: null,
        z_report_id: null,
        z_number: null,
      };
      this.db.run(
        'INSERT INTO shifts (id, sequence_number, business_date, opened_at, opened_by_id, opened_by_name, opening_cash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        row.id,
        row.sequence_number,
        row.business_date,
        row.opened_at,
        row.opened_by_id,
        row.opened_by_name,
        0,
        'open',
      );
      this.outbox.enqueue('shift_open', row.id);
      return row;
    });
  }

  /** The wire of a shift's open (POST /sync/{m}/shifts). */
  shiftOpenWire(s: ShiftRow): Record<string, unknown> {
    return {
      id: s.id,
      businessDate: s.business_date,
      sequenceNumber: s.sequence_number,
      openedAt: s.opened_at,
      openingCash: toShekels(s.opening_cash),
      openedByUserId: s.opened_by_id,
      openedByName: s.opened_by_name,
    };
  }

  pendingInShift(shiftId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM documents WHERE status = 'pending' AND (shift_id = ? OR shift_id IS NULL)", shiftId)?.n ?? 0;
  }

  /**
   * Close the open shift (the kiosk's automatic close): the X frozen into it, counted = expected
   * (a card-only kiosk: 0), in one transaction with its outbox row. Refused while a payment is
   * pending in it.
   */
  closeShift(input: { closedByName: string; closedByUserId?: string | null; unattended?: boolean; closeRequestId?: string | null; vatRate: number; now?: Date }):
    | { kind: 'closed'; shift: ShiftRow; payload: Record<string, unknown> }
    | { kind: 'none' }
    | { kind: 'pending'; count: number } {
    return this.db.tx(() => {
      const shift = this.currentShift();
      if (!shift) return { kind: 'none' as const };
      const pending = this.pendingInShift(shift.id);
      if (pending > 0) return { kind: 'pending' as const, count: pending };
      const now = (input.now ?? new Date()).toISOString();
      const payload = shiftCloseWire(shift, this.docsOfShift(shift.id), { ...input, now });
      this.db.run("UPDATE shifts SET status = 'closing', closed_at = ?, close_payload = ? WHERE id = ?", now, JSON.stringify(payload), shift.id);
      this.outbox.enqueue('shift_close', shift.id);
      return { kind: 'closed' as const, shift: { ...shift, status: 'closing' as const, closed_at: now, close_payload: JSON.stringify(payload) }, payload };
    });
  }

  markCloseAccepted(shiftId: string, z: { zReportId?: string | null; zNumber?: number | null }) {
    this.db.run(
      "UPDATE shifts SET status = 'closed', close_accepted_at = ?, z_report_id = COALESCE(?, z_report_id), z_number = COALESCE(?, z_number) WHERE id = ?",
      new Date().toISOString(),
      z.zReportId ?? null,
      z.zNumber ?? null,
      shiftId,
    );
  }

  /** The cloud names a shift in a Z (heartbeat recentShiftZs, a till-z answer). */
  markShiftsInZ(shiftIds: string[], zReportId: string, zNumber: number | null) {
    this.db.tx(() => {
      for (const id of shiftIds) this.db.run('UPDATE shifts SET z_report_id = ?, z_number = COALESCE(?, z_number) WHERE id = ?', zReportId, zNumber, id);
    });
  }

  /** The shift belongs to another machine (403): retired here, its documents go with no shift. */
  retireShift(shiftId: string) {
    this.db.run("UPDATE shifts SET status = 'retired' WHERE id = ?", shiftId);
  }

  /** The shift a close request already closed (its close carries the request id), or null. */
  shiftByCloseRequest(requestId: string): ShiftRow | null {
    return (
      this.db.get<ShiftRow>(
        "SELECT * FROM shifts WHERE status IN ('closing', 'closed') AND json_extract(close_payload, '$.closeRequestId') = ? ORDER BY sequence_number DESC LIMIT 1",
        requestId,
      ) ?? null
    );
  }

  /** Shifts closed (and accepted, or still closing) that no Z covers yet. */
  unreportedShifts(): ShiftRow[] {
    return this.db.all<ShiftRow>("SELECT * FROM shifts WHERE status IN ('closing', 'closed') AND z_report_id IS NULL ORDER BY sequence_number");
  }

  closingCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM shifts WHERE status = 'closing'")?.n ?? 0;
  }

  lastClosedShift(): ShiftRow | null {
    return this.db.get<ShiftRow>("SELECT * FROM shifts WHERE status IN ('closing', 'closed') ORDER BY sequence_number DESC, closed_at DESC LIMIT 1") ?? null;
  }

  /* ------------------------------------------------------------ documents */

  /**
   * The pending card sale, numbered in its series (the counter saved first), BEFORE the terminal
   * is touched. Refused (null) without an open shift.
   */
  openCardSale(input: {
    documentType: number;
    prefix: string | null;
    branchId: string | null;
    operator: { id: string; name: string };
    orderId: string | null;
    lines: SaleLine[];
    tracked: string[];
    totals: SaleTotals;
    promotions?: AppliedPromotionRow[];
    voucherDiscounts?: DocVoucherDiscount[];
    voucherReleases?: string[];
    voucherLegs?: DocVoucherLeg[];
    now?: Date;
  }): DocDraft | null {
    return this.db.tx(() => {
      const shift = this.currentShift();
      if (!shift) return null;
      const now = (input.now ?? new Date()).toISOString();
      const number = this.counters.next(input.documentType);
      const draft: DocDraft = {
        id: randomUUID(),
        documentType: input.documentType,
        number,
        prefix: input.prefix,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        shiftId: shift.id,
        businessDate: shift.business_date,
        cashierId: input.operator.id,
        cashierName: input.operator.name,
        branchId: input.branchId,
        orderId: input.orderId,
        lines: input.lines,
        itemIds: input.lines.map(() => randomUUID()),
        tracked: input.tracked,
        totals: input.totals,
        ...(input.promotions && input.promotions.length > 0 ? { promotions: input.promotions } : {}),
        ...(input.voucherDiscounts && input.voucherDiscounts.length > 0 ? { voucherDiscounts: input.voucherDiscounts } : {}),
        ...(input.voucherLegs && input.voucherLegs.length > 0 ? { voucherLegs: input.voucherLegs } : {}),
        ...(input.voucherReleases && input.voucherReleases.length > 0 ? { voucherReleases: input.voucherReleases } : {}),
        card: null,
        paymentId: randomUUID(),
        voidMeta: null,
      };
      this.db.run(
        'INSERT INTO documents (id, document_type, series, number, prefix, status, shift_id, order_id, created_at, updated_at, total_agorot, tip_agorot, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        draft.id,
        draft.documentType,
        seriesOf(draft.documentType),
        number,
        draft.prefix,
        'pending',
        shift.id,
        draft.orderId,
        now,
        now,
        draft.totals.totalAgorot,
        draft.totals.tipAgorot,
        JSON.stringify(draft),
      );
      return draft;
    });
  }

  doc(id: string): DocDraft | null {
    const row = this.db.get<{ payload: string }>('SELECT payload FROM documents WHERE id = ?', id);
    return row ? (JSON.parse(row.payload) as DocDraft) : null;
  }

  /**
   * Approved: completed with its card leg (none when the vouchers paid the whole sale), in one transaction with its
   * outbox row. Only from pending.
   */
  completeCardSale(id: string, card: ApprovedCard | null, now = new Date()): DocDraft | null {
    return this.db.tx(() => {
      const d = this.doc(id);
      if (!d || d.status !== 'pending') return d;
      const next: DocDraft = { ...d, status: 'completed', card, updatedAt: now.toISOString() };
      this.db.run("UPDATE documents SET status = 'completed', updated_at = ?, payload = ? WHERE id = ?", next.updatedAt, JSON.stringify(next), id);
      this.outbox.enqueue('transaction', id);
      return next;
    });
  }

  /** Certainly not charged: cancelled (the number stays burned), with the lookup's evidence. */
  voidCardSale(id: string, voidMeta: Record<string, unknown> | null, now = new Date()): DocDraft | null {
    return this.db.tx(() => {
      const d = this.doc(id);
      if (!d || d.status !== 'pending') return d;
      const next: DocDraft = { ...d, status: 'cancelled', voidMeta, updatedAt: now.toISOString() };
      this.db.run("UPDATE documents SET status = 'cancelled', updated_at = ?, payload = ? WHERE id = ?", next.updatedAt, JSON.stringify(next), id);
      this.outbox.enqueue('transaction', id);
      return next;
    });
  }

  markSynced(ids: string[]) {
    const at = new Date().toISOString();
    this.db.tx(() => {
      for (const id of ids) this.db.run('UPDATE documents SET synced_at = ? WHERE id = ?', at, id);
    });
  }

  pendingDocs(): DocDraft[] {
    return this.db.all<{ payload: string }>("SELECT payload FROM documents WHERE status = 'pending'").map((r) => JSON.parse(r.payload) as DocDraft);
  }

  docsOfShift(shiftId: string): DocDraft[] {
    return this.db.all<{ payload: string }>('SELECT payload FROM documents WHERE shift_id = ? ORDER BY series, number', shiftId).map((r) => JSON.parse(r.payload) as DocDraft);
  }

  todaysDocs(day: string): DocDraft[] {
    return this.db
      .all<{ payload: string }>("SELECT payload FROM documents WHERE status = 'completed' AND created_at >= ? ORDER BY created_at DESC", new Date(`${day}T00:00:00`).toISOString())
      .map((r) => JSON.parse(r.payload) as DocDraft);
  }
}

/**
 * The close of a shift as POST /sync/{m}/shifts/{id}/close takes it (ShiftCloseRequest, with the
 * open repeated so a close whose open was lost still lands): the X frozen from its documents.
 */
export function shiftCloseWire(
  shift: ShiftRow,
  docs: readonly DocDraft[],
  input: { closedByName: string; closedByUserId?: string | null; unattended?: boolean; closeRequestId?: string | null; vatRate: number; now: string },
): Record<string, unknown> {
  const { till, reportableIds } = buildXTill(docs.map(xDocOf), shift.opening_cash, input.vatRate);
  const unattended = input.unattended ?? false;
  const payload: Record<string, unknown> = {
    closedAt: input.now,
    ...(input.closedByUserId ? { closedByUserId: input.closedByUserId } : {}),
    closedByName: input.closedByName,
    unattended,
    ...(unattended ? {} : { countedCash: till.expectedCash }),
    expectedCash: till.expectedCash,
    transactionIds: reportableIds,
    lastTransactionNumber: lastTransactionNumberOf(docs.map((d) => ({ status: d.status, transactionNumber: d.number }))),
    till,
    ...(input.closeRequestId ? { closeRequestId: input.closeRequestId } : {}),
    businessDate: shift.business_date,
    sequenceNumber: shift.sequence_number,
    openedAt: shift.opened_at,
    openingCash: toShekels(shift.opening_cash),
    openedByUserId: shift.opened_by_id,
    openedByName: shift.opened_by_name,
  };
  for (const k of Object.keys(payload)) if (payload[k] === null || payload[k] === undefined) delete payload[k];
  return payload;
}

/** The X's view of a document. */
export function xDocOf(d: DocDraft): XDoc {
  return {
    id: d.id,
    status: d.status,
    documentType: d.documentType,
    transactionNumber: d.number,
    grossAgorot: d.totals.grossAgorot,
    itemsQty: d.lines.reduce((s, l) => s + l.qty, 0),
    documentDiscountAgorot: d.totals.discountAgorot,
    // The vouchers' legs and the card's (what is left of the goods): the X counts the card's, never the vouchers'.
    payments:
      d.status === 'completed'
        ? [
            ...(d.voucherLegs ?? []).map((l) => ({ method: 'production_voucher', amountAgorot: l.amountAgorot })),
            ...(d.card ? [{ method: 'card', amountAgorot: cardPrincipalAgorot(d) }] : []),
          ]
        : [],
    paymentMethod: d.card || (d.voucherLegs ?? []).length === 0 ? 'card' : 'production_voucher',
    vatAgorot: d.totals.vatAgorot,
    vatRate: d.totals.vatRate,
    tipAgorot: d.totals.tipAgorot,
    tipPaymentMethod: d.totals.tipAgorot > 0 ? 'card' : null,
  };
}

/** The meta on the wire: every top-level value a string, the nested `result` JSON-encoded (OutboxSync.nayaxMetaObject). */
export function flattenMeta(meta: Record<string, unknown> | null | undefined): Record<string, string> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

const r2 = (agorot: number) => toShekels(agorot);

/** A choice on the wire (LineDetailsCodec modifier): its price, quantity, "מעט / הרבה / בצד", and what it was charged per unit of the dish. */
function modifierWire(o: SaleOption): Record<string, unknown> {
  return {
    groupId: o.groupId,
    ...(o.groupName ? { groupName: o.groupName } : {}),
    ...(o.kind ? { kind: o.kind } : {}),
    optionId: o.optionId,
    name: o.name,
    price: r2(o.priceAgorot),
    qty: o.qty,
    pre: o.pre ?? null,
    charged: r2(optionCharged(o)),
  };
}

/** The document as POST /sync/{m}/transactions takes it (TransactionPayload). */
export function documentWire(d: DocDraft): Record<string, unknown> {
  const items = d.lines.map((l, i) => {
    const unit = unitAgorot(l);
    const item: Record<string, unknown> = {
      id: d.itemIds[i],
      productId: /^[0-9a-f-]{36}$/i.test(l.productId) ? l.productId : undefined,
      productName: l.name,
      sku: l.sku ?? undefined,
      quantity: l.qty,
      unitPrice: r2(unit),
      totalPrice: r2(lineGross(l)),
      transactionType: 2,
    };
    const meal = l.meal && l.meal.components.length > 0 ? l.meal : null;
    if (l.options.length > 0 || l.notes.length > 0 || meal) {
      item.details = {
        v: 1,
        basePrice: r2(l.basePriceAgorot),
        ...(l.options.length > 0 ? { modifiers: l.options.map(modifierWire) } : {}),
        ...(l.notes.length > 0 ? { notes: l.notes } : {}),
        // A meal's components (LineDetailsCodec meal): the cloud allocates the line over them.
        ...(meal
          ? {
              meal: {
                productId: meal.productId,
                name: meal.name,
                components: meal.components.map((c) => ({
                  slotId: c.slotId,
                  slotName: c.slotName,
                  productId: c.productId,
                  name: c.name,
                  ...(c.categoryId ? { categoryId: c.categoryId } : {}),
                  listPrice: r2(c.listPriceAgorot),
                  qty: 1,
                  upcharge: r2(c.upchargeAgorot),
                  modifiers: c.options.map(modifierWire),
                })),
              },
            }
          : {}),
      };
    }
    // The customer's notes, after the mark of the goods voucher that paid for the line ("כלול בשובר #7 (1) · בלי בצל") — as the till's line note.
    const noteParts = [...(l.voucherMark ? [l.voucherMark] : []), ...l.notes];
    if (noteParts.length > 0) item.notes = noteParts.join(' · ');
    // The promotions' share ("מבצעים"): inside the document's discount, never in totalPrice.
    if ((l.promotionAgorot ?? 0) > 0) {
      item.promotionDiscount = r2(l.promotionAgorot!);
      if (l.promotionId) item.promotionId = l.promotionId;
    }
    // The discount vouchers' share ("שוברי הנחה"): inside the same discount, a discount and never a tender.
    if ((l.voucherAgorot ?? 0) > 0) item.voucherDiscount = r2(l.voucherAgorot!);
    // "תפריטים": the menu active when the line was added and where its price came from — the sales-by-menu report (SPEC_MENUS §6).
    if (l.menuId) {
      item.menuId = l.menuId;
      if (l.menuName) item.menuName = l.menuName;
      item.priceSource = l.priceSource ?? 'catalog';
    }
    for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
    return item;
  });
  const meta = d.status === 'completed' ? flattenMeta(d.card?.meta) : flattenMeta(d.voidMeta);
  const wire: Record<string, unknown> = {
    id: d.id,
    transactionNumber: String(d.number),
    documentPrefix: d.prefix ?? undefined,
    status: d.status,
    documentType: d.documentType,
    documentProductionDate: d.createdAt,
    // A sale the vouchers paid whole names them, as the till's (CheckoutViewModel: PRODUCTION_VOUCHER); else the card's.
    paymentMethod: !d.card && (d.voucherLegs ?? []).length > 0 ? 'production_voucher' : 'card',
    tipAmount: r2(d.totals.tipAgorot),
    tipPaymentMethod: d.totals.tipAgorot > 0 ? 'card' : undefined,
    totalAmount: r2(d.totals.grossAgorot),
    netAmount: r2(d.totals.netAgorot),
    vatAmount: r2(d.totals.vatAgorot),
    vatRate: d.totals.vatRate,
    documentDiscount: d.totals.discountAgorot > 0 ? r2(d.totals.discountAgorot) : undefined,
    cashierId: d.cashierId,
    branchId: d.branchId ?? undefined,
    nayaxMeta: meta,
    shiftId: d.shiftId,
    businessDate: d.businessDate,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    items,
    // The discount vouchers ("שוברי הנחה"): what each took, the lines it took it from, the hold the document confirms.
    ...(d.voucherDiscounts && d.voucherDiscounts.length > 0
      ? {
          voucherDiscounts: d.voucherDiscounts.map((v) => ({
            reservationId: v.reservationId,
            voucherId: v.voucherId,
            batchId: v.batchId,
            serial: v.serial,
            batchName: v.batchName,
            kind: v.kind,
            uses: v.uses,
            amount: r2(v.amountAgorot),
            lines: v.lines.flatMap((l) => {
              const i = d.lines.findIndex((x) => x.key === l.lineKey);
              return i >= 0 && d.itemIds[i] ? [{ itemId: d.itemIds[i], amount: r2(l.amountAgorot) }] : [];
            }),
          })),
        }
      : {}),
    // The promotions ("מבצעים") the sale was priced with.
    ...(d.promotions && d.promotions.length > 0
      ? { promotions: d.promotions.map((p) => ({ promotionId: p.promotionId, name: p.name, type: p.type, applications: p.applications, discount: r2(p.discountAgorot) })) }
      : {}),
  };
  if (d.status === 'completed' && (d.card || (d.voucherLegs ?? []).length > 0)) {
    const legs = (d.voucherLegs ?? []).filter((l) => l.amountAgorot > 0);
    // The goods vouchers' legs first ("שובר הפקה"), then the card's for what they did not cover: the legs add up to the goods after discounts.
    wire.payments = [
      ...legs.map((l, i) => ({
        id: stableUuid(`${d.id}:voucher:${l.redemptionId}`),
        sequence: i + 1,
        method: 'production_voucher',
        amount: r2(l.amountAgorot),
        createdAt: d.updatedAt,
      })),
      ...(d.card
        ? [
            {
              id: d.paymentId,
              sequence: legs.length + 1,
              method: 'card',
              amount: r2(cardPrincipalAgorot(d)),
              nayaxMeta: flattenMeta(d.card.meta),
              creditPayments: d.card.payments ?? undefined,
              cardBrand: d.card.brand !== 'other' ? d.card.brand : undefined,
              createdAt: d.updatedAt,
            },
          ]
        : []),
    ];
    const moves = d.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => d.tracked.includes(l.productId))
      .map(({ l, i }) => ({
        id: stableUuid(`${d.id}:stock:${d.itemIds[i]}`),
        productId: l.productId,
        delta: -l.qty,
        reason: 'sale',
        transactionItemId: d.itemIds[i],
        occurredAt: d.createdAt,
      }));
    if (moves.length > 0) wire.stockMovements = moves;
  } else {
    wire.payments = [];
  }
  for (const k of Object.keys(wire)) if (wire[k] === undefined) delete wire[k];
  return wire;
}

/** A UUID-shaped id derived from a string (the same input → the same id, so a re-push is idempotent). */
export function stableUuid(input: string): string {
  // FNV-1a over four lanes → 128 bits, shaped as a v4-looking UUID.
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    for (let j = 0; j < 4; j++) lanes[j] = Math.imul(lanes[j] ^ (c + j), 0x01000193) >>> 0;
  }
  const hex = lanes.map((x) => x.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
