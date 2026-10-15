/**
 * Cash credits at the kiosk (P:/specs/cash-paylink.md §11.15א): a credit's code taken for this order
 * (`POST /sync/{m}/cash/credits/{code}/redeem`, idempotent by the redemption id the screen made), and
 * given back when the order is not paid (`…/credits/redemptions/{id}/release`) — kept on the disk and
 * retried until the cloud answers, so a credit is never left taken by an order that was not paid.
 */

import type { Api } from '../sync/api';
import type { Kv } from '../db/schema';
import { cashCreditCodeOf, refusalOf } from '../../core/cash/credit';
import type { CashCreditResult } from '../../shared/bridge';

const RELEASES = 'cash.creditReleases';
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const REFUSALS: Record<string, string> = {
  credit_not_found: 'הזיכוי לא נמצא',
  credit_used: 'הזיכוי כבר נוצל',
  amount_exceeds: 'הסכום גדול מיתרת הזיכוי',
  redemption_conflict: 'הזיכוי כבר נקלט בהזמנה אחרת',
  amount: 'אין מה לשלם בזיכוי',
};

export class CashCredits {
  constructor(private readonly d: { api: Api; kv: Kv; machineId(): string | null; log(m: string): void }) {}

  /** The credit [code] towards up to [dueAgorot] of this order's goods. */
  async redeem(raw: unknown): Promise<CashCreditResult> {
    const i = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const code = cashCreditCodeOf(i.code);
    const due = typeof i.dueAgorot === 'number' && Number.isInteger(i.dueAgorot) ? i.dueAgorot : 0;
    const id = typeof i.clientRequestId === 'string' && UUID.test(i.clientRequestId) ? i.clientRequestId : null;
    if (!code) return { ok: false, error: 'קוד הזיכוי אינו תקין' };
    if (due < 1) return { ok: false, error: 'אין מה לשלם בזיכוי' };
    if (!id) return { ok: false, error: 'בקשה לא תקינה' };
    const m = this.d.machineId();
    if (!m) return { ok: false, error: 'הקיוסק לא מחובר' };
    const look = await this.d.api.get<{ credit?: { code?: string; remainingAgorot?: number } }>(`sync/${m}/cash/credits/${encodeURIComponent(code)}`, { timeoutMs: 10_000 });
    if (look.kind === 'offline') return { ok: false, error: 'אין חיבור לענן — אי אפשר לממש זיכוי כעת' };
    if (look.kind === 'refused') return { ok: false, error: this.words(look.body) };
    const remaining = typeof look.body?.credit?.remainingAgorot === 'number' ? look.body.credit.remainingAgorot : 0;
    if (remaining <= 0) return { ok: false, error: REFUSALS.credit_used };
    const amount = Math.min(remaining, due);
    const r = await this.d.api.post<{ redemption?: { id?: string; amountAgorot?: number }; credit?: { code?: string; remainingAgorot?: number } }>(
      `sync/${m}/cash/credits/${encodeURIComponent(code)}/redeem`,
      { redemptionId: id, amountAgorot: amount },
      { timeoutMs: 12_000 },
    );
    if (r.kind === 'offline') {
      // It may have been taken: given back (retried) — the customer scans again.
      this.release(id);
      return { ok: false, error: 'אין חיבור לענן — אי אפשר לממש זיכוי כעת' };
    }
    if (r.kind === 'refused') return { ok: false, error: this.words(r.body) };
    const taken = typeof r.body?.redemption?.amountAgorot === 'number' ? r.body.redemption.amountAgorot : amount;
    this.d.log(`cash credit ${code}: ${taken} taken (${id})`);
    return {
      ok: true,
      credit: { redemptionId: id, code: r.body?.credit?.code ?? code, amountAgorot: taken, remainingAgorot: typeof r.body?.credit?.remainingAgorot === 'number' ? r.body.credit.remainingAgorot : remaining - taken },
    };
  }

  private words(body: unknown): string {
    const r = refusalOf(body);
    return (r.code && REFUSALS[r.code]) || r.message || 'הזיכוי לא התקבל';
  }

  /** Back on the credit (the order was not paid): kept and retried until the cloud answers. */
  release(redemptionId: string): void {
    if (!UUID.test(redemptionId)) return;
    const list = new Set(this.d.kv.getJson<string[]>(RELEASES) ?? []);
    list.add(redemptionId);
    this.d.kv.setJson(RELEASES, [...list]);
    void this.flushOne(redemptionId);
  }

  /** The releases still owed to the cloud (each sync). */
  async flush(): Promise<void> {
    for (const id of this.d.kv.getJson<string[]>(RELEASES) ?? []) await this.flushOne(id);
  }

  private async flushOne(id: string): Promise<void> {
    const m = this.d.machineId();
    if (!m) return;
    const r = await this.d.api.post(`sync/${m}/cash/credits/redemptions/${encodeURIComponent(id)}/release`, {}, { timeoutMs: 12_000 });
    if (r.kind === 'offline') return;
    // Released, never taken (404), or already on a document (409 confirmed): done either way.
    if (r.kind === 'ok' || r.status === 404 || r.status === 409) {
      this.d.kv.setJson(
        RELEASES,
        (this.d.kv.getJson<string[]>(RELEASES) ?? []).filter((x) => x !== id),
      );
    }
  }
}
