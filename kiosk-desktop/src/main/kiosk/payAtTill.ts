/**
 * "מזומן בקופה" and vouchers on the Windows kiosk (pos-server docs/SPEC_KIOSK.md §23), as the browser
 * kiosk does (client/src/lib/kioskWebService.ts) and the Android kiosk's KioskPayMethodModel.kt:
 *
 *  - an order the customer pays at the till is an OPEN order (`POST /sync/{m}/kiosk/open-orders`):
 *    no tax document here — the till that takes the money writes it; written here first and sent
 *    again on every beat until the cloud takes it (offline too: the till may still see it later);
 *  - a prepaid voucher is looked up and — by what it is — redeemed online (`prepaid-vouchers/lookup` / `redeem`, one
 *    client request id per attempt so a retry never redeems twice), for the basket's goods it covers
 *    at the dish's own price net of its promotions; it rides on the open order (pending until paid);
 *    one the order no longer needs goes back (`…/reverse`), kept and retried until the cloud answers —
 *    or held in the cloud as a discount on the order (`…/reserve`, "שוברי הנחה"), paid here by the card, never taken
 *    to a till (lib/kioskVoucherClient.ts, the browser kiosk's own flow: one copy for both);
 *  - a goods voucher is a leg of the kiosk's own payment too (service.startPayment: the document carries it and the
 *    card pays the rest); on this path — the order to the till — the till takes what it leaves.
 *
 * The order's shape and the voucher's arithmetic are the browser kiosk's own pure helpers
 * (client/src/lib/kioskWebOrders.ts): one rule for both kiosks.
 */

import { answeredOrder, newId, openOrderWire, orderNeedsUpload, type OpenOrder, type OpenOrdersAnswer, type VoucherLeg, type WebOrderLine } from '@dash-lib/kioskWebOrders';
import { confirmDiscount, redeemVoucherCode, releaseDiscount, type VoucherPost, type VoucherResult } from '@dash-lib/kioskVoucherClient';
import type { AppliedDiscountVoucher } from '@dash-lib/kioskVouchers';
import type { Kv } from '../db/schema';
import type { Api } from '../sync/api';

const ORDERS = 'payAtTill.orders';
const REVERSALS = 'payAtTill.reversals';
/** An order the cloud took (or refused for good) is kept this long, for the admin's list. */
const KEEP_MS = 2 * 86_400_000;

export type { VoucherResult };

export interface PayAtTillDeps {
  kv: Kv;
  api: Api;
  machineId: () => string | null;
  operator: () => { id: string; name: string };
  log: (m: string) => void;
  now?: () => number;
}

export class PayAtTill {
  constructor(private readonly d: PayAtTillDeps) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private path(rest: string): string | null {
    const m = this.d.machineId();
    return m ? `sync/${m}/${rest}` : null;
  }

  /** Every open order this kiosk placed (the last two days, and any the cloud has not taken). */
  orders(): OpenOrder[] {
    return Object.values(this.d.kv.getJson<Record<string, OpenOrder>>(ORDERS) ?? {}).sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  order(localId: string): OpenOrder | null {
    return (this.d.kv.getJson<Record<string, OpenOrder>>(ORDERS) ?? {})[localId] ?? null;
  }

  private save(o: OpenOrder) {
    const all = this.d.kv.getJson<Record<string, OpenOrder>>(ORDERS) ?? {};
    all[o.localId] = o;
    this.d.kv.setJson(ORDERS, all);
  }

  /** An order that never went out (the cloud refused its prices while the customer waited): gone. */
  forget(localId: string) {
    const all = this.d.kv.getJson<Record<string, OpenOrder>>(ORDERS) ?? {};
    delete all[localId];
    this.d.kv.setJson(ORDERS, all);
  }

  /** Orders the cloud has not taken yet. */
  pending(): number {
    return this.orders().filter(orderNeedsUpload).length;
  }

  /** The cloud's voucher calls for the shared voucher flow (lib/kioskVoucherClient.ts): this kiosk's machine path. */
  private readonly post: VoucherPost = async (rest, body, timeoutMs) => {
    const p = this.path(rest);
    if (!p) return { kind: 'offline' };
    const r = await this.d.api.post<Record<string, unknown>>(p, body, { timeoutMs });
    if (r.kind === 'ok') return { kind: 'ok', body: r.body as never };
    if (r.kind === 'refused') return { kind: 'refused', status: r.status, body: r.body, detail: r.detail };
    return { kind: 'offline' };
  };

  /**
   * A voucher scanned or typed: looked up (this kiosk applies goods and both discount kinds), then — by what it is —
   * redeemed online against what the basket holds that earlier vouchers did not take (kioskWebService.redeemVoucher,
   * the same code), or held in the cloud as a discount on this order.
   */
  async redeem(input: {
    code: string;
    lines: readonly WebOrderLine[];
    earlier: readonly VoucherLeg[];
    discounts?: readonly AppliedDiscountVoucher[];
    forfeitRest?: boolean;
    clientRequestId: string;
    saleRef?: string;
  }): Promise<VoucherResult> {
    if (!this.path('prepaid-vouchers/lookup')) return { kind: 'offline' };
    return redeemVoucherCode(this.post, {
      code: input.code,
      lines: input.lines,
      earlier: input.earlier,
      discounts: input.discounts ?? [],
      forfeitRest: input.forfeitRest,
      clientRequestId: input.clientRequestId,
      saleRef: input.saleRef ?? input.clientRequestId,
      operator: this.d.operator(),
      newId,
      reverse: (id) => this.reverse(id),
    });
  }

  /** Discount vouchers given back (removed, the order left): the cloud lets the hold go; best effort, retried. */
  releaseDiscounts(vouchers: ReadonlyArray<{ reservationId: string }>): void {
    for (const v of vouchers) void releaseDiscount(this.post, v);
  }

  /**
   * The sale [transactionId] was written (PrepaidVoucherRepository.settleSale): each discount voucher that took something
   * off is confirmed (its uses taken), each that took nothing is given back, each goods voucher is linked to the document
   * (`…/attach`). Best effort, retried a few times: the document itself confirms the discount vouchers in the cloud too.
   */
  async settle(
    transactionId: string,
    discounts: ReadonlyArray<{ reservationId: string; uses: number; amountAgorot: number }>,
    releases: readonly string[],
    legs: ReadonlyArray<{ redemptionId: string }>,
  ): Promise<void> {
    for (const v of discounts) await confirmDiscount(this.post, v, { transactionId, amountAgorot: v.amountAgorot });
    for (const reservationId of releases) await releaseDiscount(this.post, { reservationId });
    for (const l of legs) await this.post(`prepaid-vouchers/redemptions/${encodeURIComponent(l.redemptionId)}/attach`, { transactionId }, 12_000);
  }

  /** The voucher goes back on itself (removed, the order left, the kiosk reset); kept until the cloud answers. */
  async reverse(redemptionId: string): Promise<void> {
    const list = new Set(this.d.kv.getJson<string[]>(REVERSALS) ?? []);
    list.add(redemptionId);
    this.d.kv.setJson(REVERSALS, [...list]);
    await this.flushReversal(redemptionId);
  }

  private async flushReversal(id: string): Promise<boolean> {
    const p = this.path(`prepaid-vouchers/redemptions/${encodeURIComponent(id)}/reverse`);
    if (!p) return false;
    const r = await this.d.api.post(p, {}, { timeoutMs: 12_000 });
    if (r.kind === 'offline') return false;
    // Reversed, or nothing to reverse (404 / 409): either way it is done.
    if (r.kind === 'ok' || r.status === 404 || r.status === 409) {
      this.d.kv.setJson(REVERSALS, (this.d.kv.getJson<string[]>(REVERSALS) ?? []).filter((x) => x !== id));
      return true;
    }
    return false;
  }

  /**
   * The order written, then sent while its customer waits (the cloud refuses a basket it prices
   * otherwise: `price_changed`, with its prices); as the cloud left it (else it goes with the next beat).
   */
  async place(o: OpenOrder): Promise<OpenOrder> {
    this.save(o);
    await this.send([o], true);
    return this.order(o.localId) ?? o;
  }

  /** To the cloud; true when it answered. Each order's state (or its refusal) is kept (kioskWebService.sendOrders). */
  private async send(list: OpenOrder[], customerWaiting = false): Promise<boolean> {
    const p = this.path('kiosk/open-orders');
    if (!p || list.length === 0) return false;
    const r = await this.d.api.post<OpenOrdersAnswer>(p, { orders: list.map((o) => openOrderWire(o, customerWaiting)) }, { timeoutMs: 12_000 });
    if (r.kind !== 'ok') return false;
    for (const o of list) {
      const next = answeredOrder(o, r.body);
      if (!next) continue;
      if (next.rejected) this.d.log(`open order ${o.localId} refused: ${next.rejected}`);
      this.save(next);
    }
    return true;
  }

  /** After a good beat: the orders the cloud has not taken, the vouchers to give back; old ones forgotten. */
  async flush(): Promise<void> {
    const due = this.orders().filter(orderNeedsUpload);
    for (let i = 0; i < due.length; i += 50) {
      if (!(await this.send(due.slice(i, i + 50)))) break;
    }
    for (const id of this.d.kv.getJson<string[]>(REVERSALS) ?? []) if (!(await this.flushReversal(id))) break;
    const all = this.d.kv.getJson<Record<string, OpenOrder>>(ORDERS) ?? {};
    const keepFrom = this.now() - KEEP_MS;
    let changed = false;
    for (const [id, o] of Object.entries(all)) {
      if (!orderNeedsUpload(o) && o.createdAtMs < keepFrom) {
        delete all[id];
        changed = true;
      }
    }
    if (changed) this.d.kv.setJson(ORDERS, all);
  }
}
