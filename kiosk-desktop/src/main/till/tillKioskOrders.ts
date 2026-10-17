/**
 * "הזמנות קיוסק לתשלום" on the Windows till (pos-android data/repo/KioskPayAtTill.kt `KioskPayAtTillTill`,
 * ui/sell/KioskOpenOrdersUi.kt; pos-server routers/kiosk_open_orders.py — core/till/kioskOrders.ts holds the rules):
 *
 *  - the list from the cloud (`GET /sync/{m}/kiosk/open-orders`, narrowed by the cloud to this till's point of sale), fetched
 *    at most every 10 s while someone is signed in and nothing is being paid, and at once on demand; an older cloud (404) or a
 *    kiosk (403): none; offline: the orders it already has (kept in the kv);
 *  - "לתשלום": locked to this till (`…/{ref}/lock`, "בטיפול בקופה X" for the others) — offline, the order as this till has it
 *    (the cloud learns of it on `paid`) — its basket rebuilt line for line in the cart (the engine's `load`), and the payment
 *    opens with the kiosk's vouchers as legs taken first and its tip; the basket is never edited: backing out of the payment
 *    puts the order back (`…/release`) and empties the cart;
 *  - the till's document took the money: reported `paid` (transaction id and number, who, when) — kept in the kv and sent
 *    again until the cloud has it (a 409: another document paid it first, logged; a 404 a day at most); the bon / KDS goes
 *    with the sale unless the kiosk sent it before payment;
 *  - "ביטול הזמנה" with a reason (`…/cancel`): its vouchers go back on the cloud;
 *  - the slip's code ("KO:…") scanned on the sell screen opens its order.
 *
 * The LAN board (a kiosk handing its order to the shop's LAN host while the cloud is away) is the Android till's own: the
 * Windows LAN host does not take open orders (P:/specs/windows-till-menu-parity.md, gap).
 */

import { formatShekelSign } from '../../core/money';
import {
  KPAY_TEXT,
  byCode,
  cancelRefusal,
  decodeBasket,
  heldElsewhere,
  lockRefusal,
  orderOf,
  ordersOf,
  reportDone,
  rowOf,
  slipCode,
  waiting,
  waitingCount,
  type KioskBasketLine,
  type KioskOpenOrder,
  type KioskOrdersState,
  type PaidReport,
} from '../../core/till/kioskOrders';

export type { KioskOrdersState };
import { displayName } from '../../core/till/staff';
import type { TillContext, TillFeature } from './tillContext';

const CACHE = 'kioskOrders.cache';
const REPORTS = 'kioskOrders.paidReports';
/** The order this till is paying now (kept across a restart: a payment that ends after it still reports it paid). */
const ACTIVE = 'kioskOrders.active';
const FETCH_EVERY_MS = 10_000;

/** What the engine does for the module: the cart, the payment. */
export interface KioskOrdersEngine {
  /** Something is rung up or being paid: an order cannot be opened over it. */
  basketBusy(): boolean;
  /** The order's basket into the cart and onto the payment; the refusal's words, or null when it opened. */
  load(order: KioskOpenOrder, lines: KioskBasketLine[]): string | null;
}

export const KIOSK_ORDERS_OPS = ['kioskOrders.refresh', 'kioskOrders.pay', 'kioskOrders.cancel', 'kioskOrders.scan', 'kioskOrders.dismiss'] as const;
export const KIOSK_ORDERS_MUTATING = ['kioskOrders.pay', 'kioskOrders.cancel', 'kioskOrders.scan', 'kioskOrders.dismiss'] as const;

export class TillKioskOrders implements TillFeature {
  readonly key = 'kioskOrders';
  readonly ops = KIOSK_ORDERS_OPS;
  readonly mutating = KIOSK_ORDERS_MUTATING;
  private orders: KioskOpenOrder[];
  private lastFetchAt = 0;
  private fetching = false;
  private busyId: string | null = null;
  private notice: string | null = null;
  private active: KioskOpenOrder | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly c: TillContext,
    private readonly engine: KioskOrdersEngine,
    private readonly opts: { timers?: boolean } = {},
  ) {
    this.orders = ordersOf({ orders: c.svc.kv.getJson<unknown[]>(CACHE) ?? [] });
    this.active = orderOf(c.svc.kv.getJson<unknown>(ACTIVE));
  }

  start() {
    if (this.opts.timers === false || this.timer) return;
    this.timer = setInterval(() => {
      if (!this.c.operator() || this.c.paying()) return;
      void this.c.later(() => this.refresh(false));
    }, FETCH_EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): KioskOrdersState | undefined {
    if (!this.c.operator()) return undefined;
    const now = this.c.now();
    return {
      waiting: waitingCount(this.orders),
      rows: this.orders.filter(waiting).map((o) => rowOf(o, now, (a) => formatShekelSign(a))),
      busyId: this.busyId,
      notice: this.notice,
      active: this.active ? { id: this.active.id, label: this.active.pickupLabel } : null,
    };
  }

  apply(op: string, a: Record<string, unknown>): unknown {
    this.c.signedIn();
    switch (op) {
      case 'kioskOrders.refresh':
        return this.refresh(true);
      case 'kioskOrders.pay':
        return this.pay(String(a.id ?? ''));
      case 'kioskOrders.cancel':
        return this.cancel(String(a.id ?? ''), a.reason);
      case 'kioskOrders.scan':
        return this.scan(a.code);
      case 'kioskOrders.dismiss':
        this.notice = null;
        return undefined;
    }
    return this.c.refuse('invalid_args');
  }

  private path(rest: string): string | null {
    const m = this.c.svc.machineId;
    return m ? `sync/${m}/kiosk/open-orders${rest}` : null;
  }

  private who(): { posUserId: string; posUserName: string } {
    const u = this.c.signedIn();
    return { posUserId: u.id, posUserName: displayName(u) };
  }

  /** On the beat (at most every 10 s) and on demand: the list, the "paid" reports first. */
  async refresh(force: boolean): Promise<void> {
    const p = this.path('');
    if (!p || this.fetching) return;
    if (!force && this.c.now() - this.lastFetchAt < FETCH_EVERY_MS) return;
    this.lastFetchAt = this.c.now();
    this.fetching = true;
    try {
      await this.flushReports();
      const r = await this.c.svc.api.get(p, { timeoutMs: 15_000 });
      if (r.kind === 'ok') {
        const list = (r.body ?? {}) as { orders?: unknown[] };
        this.orders = ordersOf(list);
        this.c.svc.kv.setJson(CACHE, Array.isArray(list.orders) ? list.orders : []);
      } else if (r.kind === 'refused' && (r.status === 404 || r.status === 403)) {
        // An older cloud, or a device that is not a till: none.
        this.orders = [];
        this.c.svc.kv.setJson(CACHE, []);
      }
    } catch (e) {
      this.c.log(`kiosk orders: ${String(e)}`);
    } finally {
      this.fetching = false;
      this.c.changed();
    }
  }

  /** "לתשלום": lock it, rebuild its basket, open the payment. */
  private async pay(id: string): Promise<unknown> {
    const order = this.orders.find((o) => o.id === id);
    if (!order || !waiting(order)) return this.refuseWith(KPAY_TEXT.notFound);
    if (heldElsewhere(order)) return this.refuseWith(KPAY_TEXT.lockedBy(order.lockedBy ?? ''));
    return this.open(order);
  }

  /** Refused in the cashier's words (the screen says them). */
  private refuseWith(text: string): never {
    return this.c.refuse('invalid_args', text);
  }

  private async open(order: KioskOpenOrder): Promise<unknown> {
    if (this.engine.basketBusy()) return this.refuseWith(KPAY_TEXT.basketBusy);
    const p = this.path(`/${encodeURIComponent(order.id)}/lock`);
    if (!p) return this.refuseWith(KPAY_TEXT.notFound);
    this.busyId = order.id;
    this.c.changed();
    let fresh: KioskOpenOrder = order;
    try {
      const r = await this.c.svc.api.post(p, { posUserName: this.who().posUserName }, { timeoutMs: 15_000 });
      if (r.kind === 'ok') {
        fresh = orderOf(r.body) ?? order;
        this.orders = this.orders.map((o) => (o.id === fresh.id ? fresh : o));
      } else if (r.kind === 'refused') {
        void this.c.later(() => this.refresh(true));
        return this.refuseWith(lockRefusal(r.status, r.body));
      } else if (!order.cartCodec) {
        // "קופה לא מחוברת": the order as this till has it — never one without its basket.
        return this.refuseWith(KPAY_TEXT.notFound);
      }
    } finally {
      this.busyId = null;
    }
    const lines = decodeBasket(fresh.cartCodec);
    if (!lines) {
      this.release(fresh);
      return this.refuseWith(KPAY_TEXT.notFound);
    }
    if (this.engine.basketBusy()) {
      this.release(fresh);
      return this.refuseWith(KPAY_TEXT.basketBusy);
    }
    const refused = this.engine.load(fresh, lines);
    if (refused) {
      this.release(fresh);
      return this.refuseWith(refused);
    }
    this.active = fresh;
    this.c.svc.kv.setJson(ACTIVE, this.rawOf(fresh));
    this.notice = null;
    return { opened: fresh.id };
  }

  /** The order as the cloud sent it, kept for a restart. */
  private rawOf(o: KioskOpenOrder): Record<string, unknown> {
    return {
      id: o.id,
      localId: o.localId,
      kioskName: o.kioskName,
      state: o.state,
      pickupLabel: o.pickupLabel,
      customerName: o.customerName,
      serviceType: o.service,
      tableRef: o.tableRef,
      itemCount: o.itemCount,
      totalAgorot: o.totalAgorot,
      tipAgorot: o.tipAgorot,
      voucherAgorot: o.voucherAgorot,
      dueAgorot: o.dueAgorot,
      kitchenSent: o.kitchenSent,
      fulfillmentMode: o.fulfillment,
      vouchers: o.vouchers,
    };
  }

  /** This till's lock goes (back to the list for any till); in the background, never holding the till. */
  private release(o: KioskOpenOrder) {
    const p = this.path(`/${encodeURIComponent(o.id)}/release`);
    if (!p) return;
    void this.c.svc.api
      .post(p, {}, { timeoutMs: 15_000 })
      .catch(() => undefined)
      .then(() => this.c.later(() => this.refresh(true)));
  }

  /** The order on the payment now (the engine's payment carries it to `paid`). */
  current(): KioskOpenOrder | null {
    return this.active;
  }

  /** The cashier backed out of the payment (or the till lost it): the order goes back to the list. */
  abandoned() {
    const o = this.active;
    if (!o) return;
    this.active = null;
    this.c.svc.kv.delete(ACTIVE);
    this.release(o);
  }

  /**
   * The till's document took the money for the order: reported paid (kept until the cloud has it); the list shows it gone.
   * [number]: the document's number as printed.
   */
  paid(o: KioskOpenOrder, transactionId: string, number: string | null) {
    if (this.active?.id === o.id) {
      this.active = null;
      this.c.svc.kv.delete(ACTIVE);
    }
    const by = this.c.operator();
    const report: PaidReport = {
      ref: o.id,
      transactionId,
      transactionNumber: number,
      by: by ? displayName(by) : null,
      paidAt: new Date(this.c.now()).toISOString(),
      firstAt: this.c.now(),
    };
    this.c.svc.kv.setJson(REPORTS, [...(this.c.svc.kv.getJson<PaidReport[]>(REPORTS) ?? []), report]);
    this.orders = this.orders.map((x) => (x.id === o.id ? { ...x, state: 'paid' as const, paidBy: report.by } : x));
    this.c.changed();
    void this.c.later(() => this.refresh(true));
  }

  /** The "paid" reports the cloud has not answered yet. */
  pendingReports(): number {
    return (this.c.svc.kv.getJson<PaidReport[]>(REPORTS) ?? []).length;
  }

  private async flushReports() {
    const list = this.c.svc.kv.getJson<PaidReport[]>(REPORTS) ?? [];
    if (list.length === 0) return;
    const keep: PaidReport[] = [];
    for (const r of list) {
      const p = this.path(`/${encodeURIComponent(r.ref)}/paid`);
      if (!p) {
        keep.push(r);
        continue;
      }
      const reply = await this.c.svc.api.post(
        p,
        { transactionId: r.transactionId, transactionNumber: r.transactionNumber, posUserName: r.by, paidAt: r.paidAt },
        { timeoutMs: 15_000 },
      );
      const done = reportDone(reply.kind === 'refused' ? { kind: 'refused', status: reply.status } : { kind: reply.kind === 'ok' ? 'ok' : 'offline' }, r.firstAt, this.c.now());
      if (reply.kind === 'refused' && reply.status === 409) this.c.log(`kiosk order ${r.ref} was already closed when this till's payment reached the cloud`);
      if (!done) keep.push(r);
    }
    this.c.svc.kv.setJson(REPORTS, keep);
  }

  /** "ביטול הזמנה" with a reason. */
  private async cancel(id: string, reasonRaw: unknown): Promise<unknown> {
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, 300) : '';
    if (!reason) return this.c.refuse('invalid_args', KPAY_TEXT.cancelReason);
    const order = this.orders.find((o) => o.id === id);
    if (!order) return this.refuseWith(KPAY_TEXT.notFound);
    if (heldElsewhere(order)) return this.refuseWith(KPAY_TEXT.lockedBy(order.lockedBy ?? ''));
    const p = this.path(`/${encodeURIComponent(order.id)}/cancel`);
    if (!p) return this.refuseWith(KPAY_TEXT.notFound);
    const r = await this.c.svc.api.post(p, { reason, ...this.who() }, { timeoutMs: 15_000 });
    if (r.kind === 'offline') return this.refuseWith(KPAY_TEXT.offline);
    await this.refresh(true);
    if (r.kind === 'refused') return this.refuseWith(cancelRefusal(r.status, r.body));
    this.c.toast(KPAY_TEXT.cancelDone(order.pickupLabel), 'ok');
    return { cancelled: order.id };
  }

  /** The slip scanned: its order opens to be paid (fetched first when this till does not have it). */
  private async scan(raw: unknown): Promise<unknown> {
    const code = slipCode(raw);
    if (!code) return this.c.refuse('invalid_args');
    let order = byCode(this.orders, code);
    if (!order) {
      await this.refresh(true);
      order = byCode(this.orders, code);
    }
    if (!order || !waiting(order)) return this.refuseWith(KPAY_TEXT.notFound);
    if (heldElsewhere(order)) return this.refuseWith(KPAY_TEXT.lockedBy(order.lockedBy ?? ''));
    return this.open(order);
  }
}
