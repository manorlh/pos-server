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
 *    card pays the rest); on this path — the order to the till — the till takes what it leaves;
 *  - the cloud away (or refusing): the order is handed to the shop's LAN host — the print server — as the Android kiosk
 *    does (core/lanOpenOrders.ts): its till lists it and takes the money; what it did with the order is asked again
 *    while the cloud is away and goes up with the order when the cloud is back (paid there: never listed open again).
 *
 * The order's shape and the voucher's arithmetic are the browser kiosk's own pure helpers
 * (client/src/lib/kioskWebOrders.ts): one rule for both kiosks.
 */

import { answeredOrder, newId, openOrderWire, orderNeedsUpload, type OpenOrder, type OpenOrdersAnswer, type VoucherLeg, type WebOrderLine } from '@dash-lib/kioskWebOrders';
import { confirmDiscount, redeemVoucherCode, releaseDiscount, type VoucherPost, type VoucherResult } from '@dash-lib/kioskVoucherClient';
import type { AppliedDiscountVoucher } from '@dash-lib/kioskVouchers';
import { LAN_OPEN_ORDERS_PATH, lanOrdersBody, lanStatesOf, nextLanRecord, withLanState, type LanRecord, type LanTarget } from '../../core/lanOpenOrders';
import type { Kv } from '../db/schema';
import type { Api } from '../sync/api';
import { lanPost as defaultLanPost, type LanPost } from './lanClient';

const ORDERS = 'payAtTill.orders';
const REVERSALS = 'payAtTill.reversals';
/** Orders handed to the shop's LAN host, and what its till did with each (core/lanOpenOrders.ts LanRecord). */
const LAN = 'payAtTill.lan';
/** At most this many orders in one hand-over. */
const LAN_CHUNK = 50;
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
  /** The shop's LAN host (its print server) as the cloud last named it; null: none — an independent kiosk has none. */
  lanTarget?: () => LanTarget | null;
  /** This kiosk's name on the host's list. */
  kioskName?: () => string | null;
  /** Tests: the LAN request (default: main/kiosk/lanClient.ts). */
  lanPost?: LanPost;
}

export class PayAtTill {
  /** The host answered the last hand-over (null: none tried yet) — a change is logged once. */
  private lanOk: boolean | null = null;

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
    this.dropLan([localId]);
  }

  /** What the shop's LAN host said of the order; null: never handed over the LAN. */
  lanRecord(localId: string): LanRecord | null {
    return (this.d.kv.getJson<Record<string, LanRecord>>(LAN) ?? {})[localId] ?? null;
  }

  /** The shop's LAN host has it (its till lists it): the customer's slip is not "waiting to sync". */
  lanDelivered(localId: string): boolean {
    return this.lanRecord(localId) !== null;
  }

  private dropLan(ids: readonly string[]) {
    const all = this.d.kv.getJson<Record<string, LanRecord>>(LAN);
    if (!all || !ids.some((id) => id in all)) return;
    for (const id of ids) delete all[id];
    this.d.kv.setJson(LAN, all);
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
   * The cloud not taking it (no answer, a refusal of the request): the shop's LAN host gets it now. [offline]: the
   * kiosk knows the cloud is away — the customer does not wait on it; the LAN host at once, the cloud with the next beat.
   */
  async place(o: OpenOrder, opts: { offline?: boolean } = {}): Promise<OpenOrder> {
    this.save(o);
    const answered = opts.offline ? false : await this.send([o], true);
    const now = this.order(o.localId) ?? o;
    if (!answered && now.cloudState === null && now.rejected === null) await this.lanRound([now]);
    return this.order(o.localId) ?? o;
  }

  /** To the cloud; true when it answered. Each order's state (or its refusal) is kept (kioskWebService.sendOrders). */
  private async send(list: OpenOrder[], customerWaiting = false): Promise<boolean> {
    const p = this.path('kiosk/open-orders');
    if (!p || list.length === 0) return false;
    // One a LAN till took while the cloud was away goes up as that till left it (paid / cancelled there).
    const lan = this.d.kv.getJson<Record<string, LanRecord>>(LAN) ?? {};
    const orders = list.map((o) => withLanState(openOrderWire(o, customerWaiting), lan[o.localId] ?? null));
    const r = await this.d.api.post<OpenOrdersAnswer>(p, { orders }, { timeoutMs: 12_000 });
    if (r.kind !== 'ok') return false;
    for (const o of list) {
      const next = answeredOrder(o, r.body);
      if (!next) continue;
      if (next.rejected) this.d.log(`open order ${o.localId} refused: ${next.rejected}`);
      this.save(next);
    }
    return true;
  }

  /**
   * The shop's LAN host (`POST /kiosk/open-orders` with the shop's print secret): the orders it should list, and what
   * its till did with each. True when it answered. Never from a kiosk the cloud gave no LAN host (an independent one).
   */
  private async lanRound(list: readonly OpenOrder[]): Promise<boolean> {
    const target = this.d.lanTarget?.() ?? null;
    const me = this.d.machineId();
    if (!target || !me || list.length === 0) return false;
    const post = this.d.lanPost ?? defaultLanPost;
    for (let i = 0; i < list.length; i += LAN_CHUNK) {
      const chunk = list.slice(i, i + LAN_CHUNK);
      const r = await post(target, LAN_OPEN_ORDERS_PATH, lanOrdersBody(me, this.d.kioskName?.() ?? null, chunk)).catch(() => null);
      if (!r || r.status !== 200) {
        if (this.lanOk !== false) this.d.log(`pay at till: the LAN host ${target.address}:${target.port} did not take the orders (${r ? `HTTP ${r.status}` : 'no answer'})`);
        this.lanOk = false;
        return false;
      }
      if (this.lanOk !== true) this.d.log(`pay at till: the LAN host ${target.address}:${target.port} takes the orders`);
      this.lanOk = true;
      const states = lanStatesOf(r.body);
      // Read again just before writing: another round may have answered meanwhile.
      const all = this.d.kv.getJson<Record<string, LanRecord>>(LAN) ?? {};
      for (const o of chunk) all[o.localId] = nextLanRecord(all[o.localId] ?? null, states.get(o.localId) ?? null, this.now());
      this.d.kv.setJson(LAN, all);
    }
    return true;
  }

  /**
   * The cloud away (the service asks it every 30 s): the orders the cloud has not taken handed to the LAN host again —
   * the ones it does not have yet, and the ones it has, to learn what its till did with them. Nothing without a host.
   */
  async lanRetry(): Promise<void> {
    const due = this.orders().filter((o) => orderNeedsUpload(o) && (this.lanRecord(o.localId)?.state ?? 'open') === 'open');
    if (due.length > 0) await this.lanRound(due);
  }

  /** After a good beat: the orders the cloud has not taken, the vouchers to give back; old ones forgotten. */
  async flush(): Promise<void> {
    const due = this.orders().filter(orderNeedsUpload);
    // Handed over the LAN while the cloud was away: what the host's till did with them first, so one it already paid
    // goes up paid and is never listed open at the other tills (KioskPayAtTillKiosk.deliver).
    const viaLan = due.filter((o) => this.lanRecord(o.localId)?.state === 'open');
    if (viaLan.length > 0) await this.lanRound(viaLan);
    for (let i = 0; i < due.length; i += 50) {
      if (!(await this.send(due.slice(i, i + 50).map((o) => this.order(o.localId) ?? o)))) break;
    }
    for (const id of this.d.kv.getJson<string[]>(REVERSALS) ?? []) if (!(await this.flushReversal(id))) break;
    const all = this.d.kv.getJson<Record<string, OpenOrder>>(ORDERS) ?? {};
    const keepFrom = this.now() - KEEP_MS;
    const gone: string[] = [];
    for (const [id, o] of Object.entries(all)) {
      if (!orderNeedsUpload(o) && o.createdAtMs < keepFrom) {
        delete all[id];
        gone.push(id);
      }
    }
    if (gone.length > 0) this.d.kv.setJson(ORDERS, all);
    // The LAN's word is kept only as long as its order.
    this.dropLan(Object.keys(this.d.kv.getJson<Record<string, LanRecord>>(LAN) ?? {}).filter((id) => !(id in all)));
  }
}
