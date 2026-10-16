/**
 * "דוח X סניפי" over the LAN — this till's part (P:/specs/shop-x-report.md §2.4–§2.5, §7): pos-android ShopXLanTest's
 * participant cases — the ask rides on the shop-close board's answer, the part is this till's figures since its last Z
 * (the closed shifts no Z took and the open shift's interim X), posted once, a 409 ends it — and the Windows guard: only while
 * the cloud lists this till closing through the cloud. Tests only: a fake LAN, a fake cloud.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { answersShopXOverLan, ownShopXSection, pendingPath, shopXAskOf, shopXPart, sumFigures } from '../src/core/till/shopXLan';
import type { LanCall } from '../src/main/kitchen/kitchenNet';
import { MACHINE, PIN, harness, type Harness } from './tillEngineHarness';

describe('the rules', () => {
  it('the board is asked with who asks; its ask is the round\'s id', () => {
    expect(pendingPath('m-1', '3', 'קופה 3')).toBe('/shop-close/pending?machineId=m-1&posNumber=3&name=%D7%A7%D7%95%D7%A4%D7%94%203');
    expect(pendingPath('m-1', ' ', null)).toBe('/shop-close/pending?machineId=m-1');
    expect(shopXAskOf({ request: null, assigned: [], shopX: { requestId: 'r-1' } })).toBe('r-1');
    expect(shopXAskOf({ request: null, assigned: [] })).toBeNull();
    expect(shopXPart('r-1', 'm-1', null, '  ')).toEqual({ requestId: 'r-1', machineId: 'm-1', section: null, error: null });
  });

  it('only while the cloud lists this till in a local shop Z, closing through the cloud, the main till another', () => {
    const h = (o: Record<string, unknown> = {}) => ({ localMode: true, mainTill: { machineId: 'main' }, participants: [{ machineId: 'me', remote: true }], ...o });
    expect(answersShopXOverLan(h(), 'me')).toBe(true);
    expect(answersShopXOverLan(h({ localMode: false }), 'me')).toBe(false);
    expect(answersShopXOverLan(h({ mainTill: { machineId: 'me' } }), 'me')).toBe(false);
    expect(answersShopXOverLan(h({ participants: [{ machineId: 'me', remote: false }] }), 'me')).toBe(false);
    expect(answersShopXOverLan(h({ participants: [] }), 'me')).toBe(false);
    expect(answersShopXOverLan(null, 'me')).toBe(false);
  });

  it('the figures summed as the local shop Z sums them; no shift — no figures', () => {
    expect(sumFigures([{ totalSales: 10.1, totalCash: 5.05, transactionsCount: 2 }, { totalSales: 0.2, totalCard: 1, transactionsCount: 1 }])).toEqual({
      totalSales: 10.3,
      totalDiscounts: 0,
      totalRefunds: 0,
      totalCash: 5.05,
      totalCard: 1,
      totalExchange: 0,
      totalTips: 0,
      vatTotal: 0,
      transactionsCount: 3,
    });
    const none = ownShopXSection({ machineId: 'm', posNumber: '2', machineName: 'קופה 2' }, []);
    expect(none).toMatchObject({ machineId: 'm', posNumber: '2', machineName: 'קופה 2', shiftIds: [], till: null, manifest: null, late: false, label: null });
  });
});

/* ------------------------------------------------------------------ on the Windows till */

let current: Harness | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

const PRINTERS = { syncType: 'full', etag: 'e', printers: [], printSecret: 'shop-secret', printHost: { machineId: 'main', name: 'קופה 1', isSelf: false, lanAddress: '10.0.0.2', port: 8399 } };

function rig(history: Record<string, unknown>, board: (path: string) => unknown) {
  const seen: Array<{ method: string; path: string; body: unknown; secret: string }> = [];
  const lanCall: LanCall = async (_t, secret, method, path, body) => {
    seen.push({ method, path, body, secret });
    if (method === 'GET') return { status: 200, body: board(path) };
    return { status: 200, body: { ok: true } };
  };
  const h = harness({ answers: { 'GET sync/m/printers': () => PRINTERS, 'GET sync/m/shop-z/history': () => history }, shopXLan: { lanCall, manual: true, sleep: async () => undefined } });
  current = h;
  return { h, seen };
}

const LISTED = { localMode: true, mainTill: { machineId: 'main' }, participants: [{ machineId: MACHINE, remote: true }] };

describe('this till\'s part on the Windows till', () => {
  it('the ask answered once with this till\'s figures since its last Z (the open shift\'s interim X)', async () => {
    const { h, seen } = rig(LISTED, () => ({ request: null, assigned: [], shopX: { requestId: 'round-1' } }));
    await h.svc.kitchen.pull(true);
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 5_000 });
    await h.engine.shopXLan.pollOnce();
    await h.engine.shopXLan.pollOnce();
    const gets = seen.filter((c) => c.method === 'GET');
    expect(gets[0].path).toBe(`/shop-close/pending?machineId=${MACHINE}&posNumber=2&name=${encodeURIComponent('קופה 2')}`);
    expect(gets[0].secret).toBe('shop-secret');
    const posts = seen.filter((c) => c.method === 'POST');
    // Once per round.
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe('/shop-x/v1/part');
    const part = posts[0].body as { requestId: string; machineId: string; section: { till: Record<string, number>; shiftIds: string[] }; error: null };
    expect(part.requestId).toBe('round-1');
    expect(part.machineId).toBe(MACHINE);
    expect(part.error).toBeNull();
    expect(part.section.shiftIds).toHaveLength(1);
    expect(part.section.till.totalSales).toBe(42);
    expect(part.section.till.totalCash).toBe(42);
    expect(part.section.till.transactionsCount).toBe(1);
  });

  it('not listed as closing through the cloud: the board is never asked', async () => {
    const { h, seen } = rig({ ...LISTED, participants: [{ machineId: MACHINE, remote: false }] }, () => ({ shopX: { requestId: 'r' } }));
    await h.svc.kitchen.pull(true);
    await h.engine.shopXLan.pollOnce();
    expect(seen).toEqual([]);
  });

  it('no round asking: nothing posted', async () => {
    const { h, seen } = rig(LISTED, () => ({ request: null, assigned: [] }));
    await h.svc.kitchen.pull(true);
    await h.engine.shopXLan.pollOnce();
    expect(seen.map((c) => c.method)).toEqual(['GET']);
  });
});
