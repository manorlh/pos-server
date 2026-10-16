/**
 * Vouchers without internet through the shop's LAN host (pos-android ProductionVoucherService `open` → `openOffline`,
 * `redeemAt` HOST, `settle` → attach, `giveBack` → reverse; OfflineVouchersTest's `offlineUsedText`): the cloud away (or the
 * batch assigned to the main till), the voucher looked up on the host, priced here, taken there by this till's request id
 * (sent again when the answer is lost), attached to its document — or given back. No host: "אין חיבור לענן, והשובר אינו
 * משויך…". Tests only: a fake LAN, a fake cloud.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { VOUCHER_LAN_TEXT, dtoOfSnapshot, hostLookupOf, hostRedeemBody, localPriced, offlineUsedText } from '../src/core/till/voucherLan';
import { termsOf, type TillVoucherUnit } from '../src/core/till/vouchers';
import type { LanCall } from '../src/main/kitchen/kitchenNet';
import { readyTill, type Harness } from './tillEngineHarness';
import { PRINT_KEY } from './support/kitchenFakes';

const SNAPSHOT = {
  typeName: 'שובר ארוחה',
  pricing: 'cover',
  redemptionAccounting: 'payment',
  countsAsPayment: true,
  totalMax: 2,
  totalRemaining: 2,
  groups: [{ key: 'main', name: 'מנה', minQty: 0, maxQty: 1, remaining: 1, frozenIds: ['p-burger'] }],
};

const unit = (id: string, price: number, productId = 'p-burger'): TillVoucherUnit => ({ id, lineKey: id.split('#')[0], productId, name: 'המבורגר', categoryId: 'c-main', price, listValue: price, discountable: true });

describe('the rules', () => {
  it('the host\'s lookup read; its snapshot as the voucher flow reads a cloud lookup', () => {
    const l = hostLookupOf({ ok: true, voucherId: 'v1', batchId: 'b1', serial: 12, eventName: 'קיץ', snapshot: SNAPSHOT, refusal: null, refusalText: null })!;
    const terms = termsOf(dtoOfSnapshot(l));
    expect(terms.groups.map((g) => [g.key, [...g.productIds], g.maxUnits])).toEqual([['main', ['p-burger'], 1]]);
    expect([terms.pricing, terms.accounting, terms.maxUnits]).toEqual(['cover', 'payment', 2]);
    expect(hostLookupOf({ ok: false, reason: 'not_assigned' })).toMatchObject({ ok: false, reason: 'not_assigned' });
    expect(hostLookupOf('x')).toBeNull();
  });

  it('priced here: cover at the price, zero at ₪0, a fixed value shared by the prices', () => {
    const units = [unit('l1#0', 6_000), unit('l2#0', 2_000)];
    const assigned = { 'l1#0': 'main', 'l2#0': 'main' };
    const groups = [{ key: 'main', name: 'מנה' }] as never;
    expect(localPriced({ accounting: 'payment', pricing: 'cover', tillValue: null, groups }, units, assigned).map((u) => [u.salePrice, u.covered])).toEqual([
      [6_000, 6_000],
      [2_000, 2_000],
    ]);
    expect(localPriced({ accounting: 'zero', pricing: 'cover', tillValue: null, groups }, units, assigned).map((u) => u.covered)).toEqual([0, 0]);
    expect(localPriced({ accounting: 'payment', pricing: 'fixed', tillValue: 4_000, groups }, units, assigned).map((u) => u.covered)).toEqual([3_000, 1_000]);
  });

  it('the redeem body, the words', () => {
    const b = hostRedeemBody({ code: 'PV1', id: 'r-1', saleRef: 'cart', units: [unit('l1#0', 6_000)], assigned: { 'l1#0': 'main', 'zz#0': 'x' }, user: { id: 'u', name: 'דנה' }, machineId: 'm', by: 'קופה 2' });
    expect(b).toEqual({
      code: 'PV1',
      id: 'r-1',
      saleRef: 'cart',
      units: [{ id: 'l1#0', lineId: 'l1', productIds: ['p-burger'], categoryId: 'c-main', parentCategoryIds: [], price: 6_000, discountable: true, name: 'המבורגר', listValue: 6_000, quantity: 1 }],
      assigned: { 'l1#0': 'main' },
      approval: null,
      posUserId: 'u',
      posUserName: 'דנה',
      machineId: 'm',
      by: 'קופה 2',
    });
    expect(offlineUsedText('קופה 3', '22:14')).toBe('השובר כבר מומש במלואו בקופה 3 בשעה 22:14 — אין יתרה');
    expect(offlineUsedText(null, null)).toBe('השובר כבר מומש במלואו — אין יתרה');
  });
});

/* ------------------------------------------------------------------ on the Windows till */

let current: Harness | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

const PRINTERS = { syncType: 'full', etag: 'e', printers: [], printSecret: PRINT_KEY, printHost: { machineId: 'main', name: 'קופה 1', isSelf: false, lanAddress: '10.0.0.2', port: 8399 } };

async function rig(host: (path: string, body: Record<string, unknown>) => { status: number; body: unknown } | 'lost') {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const lanCall: LanCall = async (_t, secret, _method, path, body) => {
    expect(secret).toBe(PRINT_KEY);
    seen.push({ path, body: body as Record<string, unknown> });
    const a = host(path, body as Record<string, unknown>);
    if (a === 'lost') throw new Error('no answer');
    return a;
  };
  const h = await readyTill({ answers: { 'GET sync/m/printers': () => PRINTERS, 'POST sync/m/prepaid-vouchers/lookup': () => ({ __status: 503 }) }, voucherLan: lanCall });
  current = h;
  await h.svc.kitchen.pull(true);
  return { h, seen };
}

async function payWithVoucher(h: Harness) {
  await h.ok('sell.add', { productId: 'p-burger' });
  await h.ok('checkout.start');
  await h.ok('checkout.voucher', { code: 'PV-1234' });
  await h.engine.vouchers.lastScan;
}

describe('a voucher through the LAN host on the Windows till', () => {
  it('no cloud: looked up and taken by the host, priced here, the sale paid by it; attached to its document', async () => {
    const { h, seen } = await rig((path) => {
      if (path === '/vouchers/lookup') return { status: 200, body: { ok: true, voucherId: 'v1', batchId: 'b1', serial: 12, eventName: 'קיץ', snapshot: SNAPSHOT, refusal: null, refusalText: null } };
      if (path === '/vouchers/redeem') return { status: 200, body: { ok: true, redemptionId: 'x' } };
      return { status: 200, body: { ok: true } };
    });
    await payWithVoucher(h);
    const redeem = seen.find((c) => c.path === '/vouchers/redeem')!;
    expect(redeem.body).toMatchObject({ code: 'PV1234', assigned: { [Object.keys(redeem.body.assigned as object)[0]]: 'main' }, machineId: expect.any(String) });
    const id = String(redeem.body.id);
    expect(h.state().checkout.phase).toBe('done');
    await new Promise((r) => setTimeout(r, 20));
    const attach = seen.find((c) => c.path === '/vouchers/attach');
    expect(attach?.body).toEqual({ id, transactionId: h.state().checkout.documentId });
  });

  it('the redeem\'s answer lost: sent again by the same id', async () => {
    let n = 0;
    const { h, seen } = await rig((path) => {
      if (path === '/vouchers/lookup') return { status: 200, body: { ok: true, voucherId: 'v1', batchId: 'b1', serial: 12, snapshot: SNAPSHOT } };
      if (path === '/vouchers/redeem') return n++ === 0 ? 'lost' : { status: 200, body: { ok: true, redemptionId: 'x', replayed: true } };
      return { status: 200, body: { ok: true } };
    });
    await payWithVoucher(h);
    const redeems = seen.filter((c) => c.path === '/vouchers/redeem');
    expect(redeems).toHaveLength(2);
    expect(redeems[0].body.id).toBe(redeems[1].body.id);
  });

  it('the host refuses (used there): its words; nothing taken', async () => {
    const { h } = await rig((path) => {
      if (path === '/vouchers/lookup') return { status: 200, body: { ok: true, voucherId: 'v1', snapshot: SNAPSHOT, refusal: 'prepaid_voucher_used', refusalText: offlineUsedText('קופה 3', '22:14') } };
      return { status: 200, body: { ok: true } };
    });
    await payWithVoucher(h);
    expect(h.state().checkout.vouchers?.error).toBe('השובר כבר מומש במלואו בקופה 3 בשעה 22:14 — אין יתרה');
    expect(h.state().checkout.phase).toBe('tender');
  });

  it('no host holds it: "אין חיבור לענן, והשובר אינו משויך…"', async () => {
    const { h } = await rig(() => ({ status: 200, body: { ok: false, reason: 'not_assigned' } }));
    await payWithVoucher(h);
    expect(h.state().checkout.vouchers?.error).toBe(VOUCHER_LAN_TEXT.notAssigned);
  });

  it('given back over the LAN when the voucher is taken off', async () => {
    const { h, seen } = await rig((path) => {
      if (path === '/vouchers/lookup') return { status: 200, body: { ok: true, voucherId: 'v1', batchId: 'b1', serial: 12, snapshot: { ...SNAPSHOT, totalMax: 1, totalRemaining: 1 } } };
      return { status: 200, body: { ok: true } };
    });
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.voucher', { code: 'PV-1234' });
    await h.engine.vouchers.lastScan;
    const item = h.state().checkout.vouchers!.items[0];
    await h.ok('checkout.removeVoucher', { id: item.id });
    await new Promise((r) => setTimeout(r, 20));
    const redeem = seen.find((c) => c.path === '/vouchers/redeem')!;
    expect(seen.find((c) => c.path === '/vouchers/reverse')?.body).toEqual({ id: redeem.body.id });
  });
});
