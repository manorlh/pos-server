/**
 * "מזומן בקופה" and vouchers on the Windows kiosk (pos-server docs/SPEC_KIOSK.md §23), as the browser
 * kiosk does (client/src/lib/kioskWebService.ts) and the Android kiosk's KioskPayMethodModel.kt:
 *
 *  - an order the customer pays at the till is an OPEN order (`POST /sync/{m}/kiosk/open-orders`):
 *    no tax document here — the till that takes the money writes it; written here first and sent
 *    again on every beat until the cloud takes it (offline too: the till may still see it later);
 *  - a prepaid voucher is looked up and redeemed online (`prepaid-vouchers/lookup` / `redeem`, one
 *    client request id per attempt so a retry never redeems twice), for the basket's goods it covers
 *    at the dish's own price net of its promotions; it rides on the open order (pending until paid);
 *    one the order no longer needs goes back (`…/reverse`), kept and retried until the cloud answers;
 *  - a voucher never mixes with the card here (one tender per document): the rest is paid at the till.
 *
 * The order's shape and the voucher's arithmetic are the browser kiosk's own pure helpers
 * (client/src/lib/kioskWebOrders.ts): one rule for both kiosks.
 */

import {
  openOrderWire,
  orderNeedsUpload,
  voucherAmount,
  voucherForfeits,
  voucherTake,
  type OpenOrder,
  type VoucherItem,
  type VoucherLeg,
  type VoucherTaken,
  type WebOrderLine,
} from '@dash-lib/kioskWebOrders';
import type { Kv } from '../db/schema';
import type { Api } from '../sync/api';

const ORDERS = 'payAtTill.orders';
const REVERSALS = 'payAtTill.reversals';
/** An order the cloud took (or refused for good) is kept this long, for the admin's list. */
const KEEP_MS = 2 * 86_400_000;

export type VoucherResult =
  | { kind: 'ok'; leg: VoucherLeg }
  | { kind: 'forfeit' }
  | { kind: 'no_match' }
  | { kind: 'offline' }
  | { kind: 'refused'; reason: string };

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

  /** Orders the cloud has not taken yet. */
  pending(): number {
    return this.orders().filter(orderNeedsUpload).length;
  }

  /**
   * A voucher scanned or typed: looked up, then redeemed online against what the basket holds that
   * earlier vouchers did not take (kioskWebService.redeemVoucher).
   */
  async redeem(input: { code: string; lines: readonly WebOrderLine[]; earlier: readonly VoucherLeg[]; forfeitRest?: boolean; clientRequestId: string }): Promise<VoucherResult> {
    const lookup = this.path('prepaid-vouchers/lookup');
    const redeem = this.path('prepaid-vouchers/redeem');
    if (!lookup || !redeem) return { kind: 'offline' };
    const looked = await this.d.api.post<Record<string, unknown>>(lookup, { code: input.code }, { timeoutMs: 12_000 });
    if (looked.kind === 'offline') return { kind: 'offline' };
    if (looked.kind === 'refused') return { kind: 'refused', reason: looked.detail ?? (looked.status === 404 ? 'prepaid_voucher_not_found' : `http_${looked.status}`) };
    const dto = looked.body ?? {};
    if (dto.redeemable === false) return { kind: 'refused', reason: typeof dto.reason === 'string' ? dto.reason : typeof dto.status === 'string' ? `prepaid_voucher_${dto.status}` : 'not_redeemable' };
    const items: VoucherItem[] = (Array.isArray(dto.items) ? (dto.items as Array<Record<string, unknown>>) : [])
      .filter((it) => typeof it.productId === 'string')
      .map((it) => ({
        productId: String(it.productId),
        tillProductId: typeof it.tillProductId === 'string' ? it.tillProductId : null,
        name: String(it.name ?? ''),
        quantity: Number(it.quantity) || 0,
        remaining: Number(it.remaining) || 0,
      }));
    const take = voucherTake(items, input.lines, input.earlier);
    if (take.size === 0) return { kind: 'no_match' };
    if (!input.forfeitRest && voucherForfeits(dto.splitAllowed === true, items, take)) return { kind: 'forfeit' };
    const op = this.d.operator();
    const r = await this.d.api.post<Record<string, unknown>>(
      redeem,
      {
        code: input.code,
        items: [...take.entries()].map(([productId, quantity]) => ({ productId, quantity })),
        clientRequestId: input.clientRequestId,
        forfeitRest: input.forfeitRest === true,
        posUserId: op.id,
        posUserName: op.name,
      },
      { timeoutMs: 15_000 },
    );
    if (r.kind === 'offline') return { kind: 'offline' };
    if (r.kind === 'refused') return { kind: 'refused', reason: r.detail ?? `http_${r.status}` };
    const res = r.body ?? {};
    const redemptionId = typeof res.redemptionId === 'string' ? res.redemptionId : null;
    if (!redemptionId) return { kind: 'refused', reason: 'bad_answer' };
    const redeemed: VoucherTaken[] = (Array.isArray(res.redeemed) ? (res.redeemed as Array<Record<string, unknown>>) : [])
      .filter((x) => typeof x.productId === 'string')
      .map((x) => ({ productId: String(x.productId), tillProductId: typeof x.tillProductId === 'string' ? x.tillProductId : null, name: typeof x.name === 'string' ? x.name : null, quantity: Number(x.quantity) || 0 }));
    const amount = voucherAmount([...input.lines], [...input.earlier], redeemed);
    if (amount <= 0) {
      // Nothing of the basket it could pay: never kept for nothing.
      await this.reverse(redemptionId);
      return { kind: 'no_match' };
    }
    const voucher = (res.voucher ?? dto) as { serial?: unknown; eventName?: unknown };
    return {
      kind: 'ok',
      leg: { redemptionId, serial: typeof voucher.serial === 'number' ? voucher.serial : 0, amountAgorot: amount, eventName: typeof voucher.eventName === 'string' ? voucher.eventName : null, redeemed },
    };
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

  /** The order written, then sent; true when the cloud took it now (else it goes with the next beat). */
  async place(o: OpenOrder): Promise<OpenOrder> {
    this.save(o);
    await this.send([o]);
    return this.order(o.localId) ?? o;
  }

  /** To the cloud; true when it answered. Each order's state (or its refusal) is kept (kioskWebService.sendOrders). */
  private async send(list: OpenOrder[]): Promise<boolean> {
    const p = this.path('kiosk/open-orders');
    if (!p || list.length === 0) return false;
    const r = await this.d.api.post<{ accepted?: string[]; rejected?: Array<{ localId?: string; reason?: string }>; states?: Record<string, { state?: string }> }>(
      p,
      { orders: list.map(openOrderWire) },
      { timeoutMs: 12_000 },
    );
    if (r.kind !== 'ok') return false;
    const accepted = new Set(r.body?.accepted ?? []);
    const rejected = new Map((r.body?.rejected ?? []).map((x) => [x.localId ?? '', x.reason ?? 'rejected']));
    for (const o of list) {
      if (accepted.has(o.localId)) this.save({ ...o, cloudState: r.body?.states?.[o.localId]?.state ?? 'open' });
      else if (rejected.has(o.localId)) {
        this.d.log(`open order ${o.localId} refused: ${rejected.get(o.localId)}`);
        this.save({ ...o, rejected: rejected.get(o.localId) ?? 'rejected' });
      }
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
