/**
 * The kiosk's orders (SQLite `kiosk_orders`) and its pickup numbers, as the Android kiosk keeps
 * them (pos-android data/repo/KioskRepository.kt KioskOrderStore, allocatePickup):
 *
 *  - an order is written UNPAID before the payment starts; it becomes paid with the document's
 *    id and printed number; a week (≤ 1000) is kept, never one the cloud has not taken;
 *  - the pickup number is allocated AFTER the money: kiosk scope = a local daily sequence saved
 *    before it is shown; shop scope = the cloud's (3 s), else a local one tagged L ("AL-4");
 *  - pushed to the cloud in chunks of 50 whenever what the cloud has differs.
 */

import { localDate, nextPickup, offlinePickupLabel, orderHash, orderNeedsSync, orderWire, pickupLabel, receiptStatusOf, SHOP_PICKUP_TIMEOUT_MS, type KioskOrder, type PickupRules } from '../../core/kioskOrders';
import type { Db } from '../db/sqlite';
import type { Kv } from '../db/schema';
import type { Api } from '../sync/api';

const KEEP = 1000;
const KEEP_MS = 7 * 86_400_000;

/** A stored row as the order it is now: an older row's receipt value made one the cloud takes. */
function readOrder(json: string): KioskOrder {
  const o = JSON.parse(json) as KioskOrder;
  return { ...o, receiptStatus: receiptStatusOf(o.receiptStatus) };
}

export class OrderStore {
  constructor(private readonly db: Db) {}

  all(): KioskOrder[] {
    return this.db.all<{ json: string }>('SELECT json FROM kiosk_orders ORDER BY created_at').map((r) => readOrder(r.json));
  }

  get(localId: string): KioskOrder | null {
    const r = this.db.get<{ json: string }>('SELECT json FROM kiosk_orders WHERE local_id = ?', localId);
    return r ? readOrder(r.json) : null;
  }

  put(o: KioskOrder): KioskOrder {
    this.db.run(
      'INSERT INTO kiosk_orders (local_id, created_at, json) VALUES (?, ?, ?) ON CONFLICT(local_id) DO UPDATE SET json = excluded.json',
      o.localId,
      o.createdAtMs,
      JSON.stringify(o),
    );
    return o;
  }

  update(localId: string, change: (o: KioskOrder) => KioskOrder): KioskOrder | null {
    return this.db.tx(() => {
      const cur = this.get(localId);
      if (!cur) return null;
      return this.put(change(cur));
    });
  }

  prune(nowMs = Date.now()) {
    const all = this.all();
    const keep = new Set(
      all
        .filter((o) => o.createdAtMs >= nowMs - KEEP_MS || orderNeedsSync(o))
        .slice(-KEEP)
        .map((o) => o.localId),
    );
    this.db.tx(() => {
      for (const o of all) if (!keep.has(o.localId)) this.db.run('DELETE FROM kiosk_orders WHERE local_id = ?', o.localId);
    });
  }

  todays(day = localDate(Date.now())): KioskOrder[] {
    return this.all().filter((o) => o.paid && o.businessDate === day);
  }

  /** Every paid order the cloud does not hold as it now stands, oldest first, in chunks of 50. */
  async push(api: Api, machineId: string): Promise<boolean> {
    const due = this.all().filter(orderNeedsSync);
    for (let i = 0; i < due.length; i += 50) {
      const chunk = due.slice(i, i + 50);
      const reply = await api.post<{ accepted?: string[] }>(`sync/${machineId}/kiosk/orders`, { orders: chunk.map(orderWire) }, { timeoutMs: 20_000 });
      if (reply.kind !== 'ok') return false;
      const accepted = new Set(reply.body?.accepted ?? []);
      for (const o of chunk) if (accepted.has(o.localId)) this.update(o.localId, (x) => ({ ...x, syncedHash: orderHash(x) }));
    }
    return true;
  }
}

/** The pickup number of a paid order (allocatePickup). */
export async function allocatePickup(kv: Kv, api: Api | null, machineId: string | null, order: Pick<KioskOrder, 'localId' | 'businessDate'>, rules: PickupRules): Promise<{ number: number; label: string }> {
  const local = (key: string) => {
    const lastDate = kv.get(`${key}.date`);
    const last = kv.getNumber(`${key}.last`);
    const n = nextPickup(lastDate, last, order.businessDate, rules);
    // Saved before it is handed out: never the same number twice after a crash.
    kv.set(`${key}.date`, order.businessDate);
    kv.setNumber(`${key}.last`, n);
    return n;
  };
  if (rules.scope === 'shop' && api && machineId) {
    const reply = await api.post<{ number?: number; label?: string }>(
      `sync/${machineId}/kiosk/pickup-number`,
      { orderKey: order.localId, businessDate: order.businessDate },
      { timeoutMs: SHOP_PICKUP_TIMEOUT_MS },
    );
    if (reply.kind === 'ok' && typeof reply.body?.number === 'number' && reply.body.number > 0) {
      return { number: reply.body.number, label: reply.body.label?.trim() || pickupLabel(rules.prefix, reply.body.number, rules.labelFormat) };
    }
    const n = local('pickup.fallback');
    return { number: n, label: offlinePickupLabel(rules.prefix, n) };
  }
  // "מספר בלבד" never shows a number it drew alone bare (another kiosk may say the same): tagged.
  if (rules.labelFormat === 'number') {
    const n = local('pickup.fallback');
    return { number: n, label: offlinePickupLabel(rules.prefix, n) };
  }
  const n = local('pickup');
  return { number: n, label: pickupLabel(rules.prefix, n, rules.labelFormat) };
}
