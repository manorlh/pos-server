/**
 * The held sales on this till ("מכירות בהמתנה", core/till/heldSales.ts) — the Android HeldSaleRepository on the kiosk core's
 * key-value table: a snapshot per sale, never a document, never sent to the cloud. Resuming TAKES the row (never two live
 * copies of one basket); a cancel at a close records its till event through the caller.
 */

import { randomUUID } from 'node:crypto';
import { heldItemCount, heldSaleOf, summaryOf, type HeldLine, type HeldSale, type HeldSaleSummary } from '../../core/till/heldSales';

/** The kv the store keeps its list in (KioskService.kv). */
export interface HeldKv {
  getJson<T>(key: string): T | null;
  setJson(key: string, value: unknown): void;
}

const KEY = 'till.heldSales';

export class HeldStore {
  constructor(
    private readonly kv: HeldKv,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Every held sale, oldest first. */
  all(): HeldSale[] {
    const raw = this.kv.getJson<unknown[]>(KEY);
    return Array.isArray(raw) ? raw.map(heldSaleOf).filter((x): x is HeldSale => x !== null) : [];
  }

  count(): number {
    return this.all().length;
  }

  summaries(): HeldSaleSummary[] {
    return this.all().map(summaryOf);
  }

  /** Park [lines]; the id, or null for an empty basket. */
  hold(lines: HeldLine[], cashier: { id: string; name: string | null }, label: string | null, totalAgorot: number): string | null {
    if (lines.length === 0) return null;
    const sale: HeldSale = {
      id: randomUUID(),
      label,
      itemCount: heldItemCount(lines.map((l) => l.qty)),
      totalAgorot,
      lines,
      cashierId: cashier.id,
      cashierName: cashier.name,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.kv.setJson(KEY, [...this.all(), sale]);
    return sale.id;
  }

  /** Read without taking it (to ask about it first). */
  peek(id: string): HeldSale | null {
    return this.all().find((h) => h.id === id) ?? null;
  }

  /** Read back and removed in one step — null when it is gone (taken by another resume or a cancel). */
  resume(id: string): HeldSale | null {
    const list = this.all();
    const found = list.find((h) => h.id === id) ?? null;
    if (!found) return null;
    this.kv.setJson(KEY, list.filter((h) => h.id !== id));
    return found;
  }

  /** True only when this call removed it. */
  discard(id: string): boolean {
    return this.resume(id) !== null;
  }
}
