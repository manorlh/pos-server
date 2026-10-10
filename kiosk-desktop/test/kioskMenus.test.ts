/**
 * "תפריטים" on the Windows kiosk (client lib/kioskMenus.ts, main/kiosk/catalog.ts, the service's clock and basket check) —
 * the Android kiosk's CatalogMenus.kt / KioskCatalogView.kt, pinned to the shared golden
 * server/tests/fixtures/catalog_menus_golden.json that the cloud, the Android till and kiosk and the browser kiosk run too:
 *
 *  - the file is the pinned one (SHA-256, line endings as LF);
 *  - every KIOSK case through this kiosk's own path: the catalog it builds from the pull (`buildKioskCatalog`), the kiosk's order
 *    rules over it (`kioskCatalogView` with `withMenuOrder`) — the golden's categories, products, order and prices, to the agora;
 *  - the service: the block is kept with the catalog (whole when sent, kept by a delta that carries none); the clock looks once
 *    per minute boundary, offline too, and the view is built again only when the menu changes; an open basket keeps its prices;
 *    a line added under a menu that ended stays; the document's items name the menu.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kioskCatalogView, resolveKioskConfig } from '@dash-lib/kioskConfig';
import { agorotText, withMenuOrder } from '@dash-lib/kioskMenus';
import type { MenuBlock } from '@dash-lib/menuSchedule';
import { buildKioskCatalog, catalogMedia } from '../src/main/kiosk/catalog';
import { saleTotals, type SaleLine } from '../src/core/sale';
import { documentWire, type DocDraft } from '../src/main/fiscal/ledger';
import { KioskService } from '../src/main/service';
import type { BasketChange, StartPaymentIn } from '../src/shared/bridge';
import type { Transport } from '../src/main/printer/transports';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FIXTURE = path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'catalog_menus_golden.json');
/** The cloud's test_catalog_menus.py, pos-android's CatalogMenusTest and the dashboard's kioskMenus.test.ts hold the same constant. */
const GOLDEN_SHA256 = '700bf232905063013a6adb1ad9f74383b9d3621bf8fad3fbe1342e10f8ed2395';

type Row = Record<string, unknown>;
interface Golden {
  products: Array<{ id: string; categoryId: string; price: number }>;
  blocks: Record<string, MenuBlock>;
  cases: Array<{
    name: string;
    at: string;
    surface: 'pos' | 'kiosk';
    block: string;
    expected: {
      resolution: { mode: string; menuId: string | null; menuName: string | null; level: string | null };
      applied: { categories: string[]; products: Array<{ id: string; categoryId: string; price: string; priceSource: string }> } | null;
    };
  }>;
}

const text = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n') : '{"products":[],"blocks":{},"cases":[]}';
const golden = JSON.parse(text) as Golden;

/** The epoch ms whose LOCAL wall clock reads `at` ("YYYY-MM-DDTHH:MM[:SS]"). */
function localMs(at: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(at)!;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)).getTime();
}

function goldenCatalog(block: MenuBlock | null, extra: (rows: Row[]) => Row[] = (r) => r) {
  const categoryIds = [...new Set(golden.products.map((p) => p.categoryId))];
  if (!categoryIds.includes('c-empty')) categoryIds.push('c-empty');
  const rows: Row[] = golden.products.map((p) => ({ id: p.id, name: p.id, categoryId: p.categoryId, price: p.price, inStock: true, isAvailable: true }));
  return {
    catalog: {
      products: extra(rows),
      categories: categoryIds.map((id, i) => ({ id, name: id, isActive: true, sortOrder: i })) as Row[],
      menu: null,
      machineCatalog: null as { mode?: string } | null,
      catalogMenus: block,
    },
    settings: { productOrder: golden.products.map((p) => p.id), categoryOrder: categoryIds } as Record<string, unknown>,
  };
}

function shown(g: ReturnType<typeof goldenCatalog>, at: string) {
  const built = buildKioskCatalog(g.catalog, g.settings, () => null, { stock: {}, nowMs: localMs(at) });
  const cfg = withMenuOrder(resolveKioskConfig(null), built.menu);
  const view = kioskCatalogView(built.categories, built.products, cfg);
  return { built, categories: view.categories.map((c) => c.category.id), products: view.categories.flatMap((c) => c.products.map((x) => x.product)) };
}

describe.runIf(existsSync(FIXTURE))('the golden (catalog_menus_golden.json), through the Windows kiosk', () => {
  it('is the pinned one — the same bytes in the cloud, the Android till and kiosk, the browser kiosk and here', () => {
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
    expect(golden.cases.filter((c) => c.surface === 'kiosk').length).toBeGreaterThanOrEqual(13);
  });

  const tillOrder = golden.products.map((p) => p.id);
  for (const c of golden.cases.filter((x) => x.surface === 'kiosk')) {
    it(`${c.block} ${c.at}: ${c.name}`, () => {
      const s = shown(goldenCatalog(golden.blocks[c.block]), c.at);
      const want = c.expected;
      expect({ mode: s.built.menu.mode, menuId: s.built.menu.menuId, menuName: s.built.menu.menuName, level: s.built.menu.level }).toEqual({
        mode: want.resolution.mode,
        menuId: want.resolution.menuId,
        menuName: want.resolution.menuName,
        level: want.resolution.level,
      });
      if (want.applied === null) {
        // No menu: the catalog as it is — every product, the till's own order, nothing held.
        expect(s.products.map((p) => p.id)).toEqual(tillOrder);
        expect(s.products.every((p) => p.menuId === undefined && p.catalogPriceAgorot === undefined)).toBe(true);
        expect(s.built.held).toEqual([]);
        return;
      }
      expect(s.categories).toEqual(want.applied.categories);
      expect(s.products.map((p) => ({ id: p.id, categoryId: p.categoryId, price: agorotText(p.priceAgorot), priceSource: p.priceSource }))).toEqual(want.applied.products);
    });
  }

  it('"אזל" and blocks stay in force inside a menu; the menu beats the machine list; what it does not place is held', () => {
    const day = golden.blocks.kioskHours;
    const g = goldenCatalog(day, (rows) =>
      rows.map((r) => {
        if (r.id === 'p-cola') return { ...r, isAvailable: false, lockAvailable: false };
        if (r.id === 'p-pasta') return { ...r, inMachineCatalog: false };
        if (r.id === 'p-beer') return { ...r, salesChannel: 'pos_only' };
        return r;
      }),
    );
    g.catalog.machineCatalog = { mode: 'selected' };
    const s = shown(g, '2026-10-06T12:00');
    const byId = new Map(s.products.map((p) => [p.id, p]));
    // Lunch lists the pasta (not on this machine's list: the menu is over it) at 39.90; the cola is still there, sold out; "קופות בלבד" is not.
    expect([...byId.keys()]).toEqual(['p-pasta', 'p-burger', 'p-coffee', 'p-cola', 'p-water']);
    expect(byId.get('p-pasta')?.priceAgorot).toBe(3990);
    expect(byId.get('p-cola')?.soldOut).toBe(true);
    // Outside its hours the machine's list is back: the pasta is not sold, the dishes the list holds are.
    const out = shown(g, '2026-10-06T15:00');
    expect(out.built.menu.mode).toBe('catalog');
    expect(out.products.map((p) => p.id)).not.toContain('p-pasta');
  });

  it('keeps the pictures of whatever a menu may place, over the machine\'s list, so a menu starting offline finds them', () => {
    const g = goldenCatalog(golden.blocks.kioskHours, (rows) => rows.map((r) => ({ ...r, imageUrl: `https://img.test/${String(r.id)}.jpg`, ...(r.id === 'p-pasta' ? { inMachineCatalog: false } : {}) })));
    g.catalog.machineCatalog = { mode: 'selected' };
    const urls = catalogMedia(g.catalog, { categories: [], products: [] }).map((m) => m.url);
    expect(urls).toContain('https://img.test/p-pasta.jpg');
    const plain = goldenCatalog(null, (rows) => rows.map((r) => ({ ...r, imageUrl: `https://img.test/${String(r.id)}.jpg`, ...(r.id === 'p-pasta' ? { inMachineCatalog: false } : {}) })));
    plain.catalog.machineCatalog = { mode: 'selected' };
    expect(catalogMedia(plain.catalog, { categories: [], products: [] }).map((m) => m.url)).not.toContain('https://img.test/p-pasta.jpg');
  });
});

const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };

/** A kiosk with a cloud catalog: a burger (54), a pasta (46) and a drink (8); lunch 11:00-14:00 lists the burger at 40. */
function kiosk(block: Record<string, unknown> | null = lunchBlock()) {
  const svc = new KioskService({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-menus-')), appVersion: '0.4.1', deviceInfo: {}, transport: noPrinter, downloader: async () => { throw new Error('no media'); } });
  const body: Record<string, unknown> = {
    syncType: 'full',
    serverTime: 'x',
    categories: [{ id: 'c1', name: 'מנות', isActive: true }, { id: 'c2', name: 'שתייה', isActive: true }],
    products: [
      { id: 'p1', categoryId: 'c1', name: 'המבורגר', price: 54 },
      { id: 'p2', categoryId: 'c1', name: 'פסטה', price: 46 },
      { id: 'p4', categoryId: 'c2', name: 'קולה', price: 8 },
    ],
    menu: null,
    machineCatalog: { mode: 'all' },
  };
  if (block) body.catalogMenus = block;
  svc.cloud.applyCatalog(body);
  return svc;
}

function lunchBlock(): Record<string, unknown> {
  return {
    updatedAt: '2026-10-07T00:00:00+00:00',
    fallback: 'catalog',
    menus: [
      {
        id: 'lunch',
        name: 'צהריים',
        channel: 'kiosk',
        schedule: { always: false, days: null, ranges: [['11:00', '14:00']], from: null, to: null },
        categories: [{ id: 'c1', all: false }],
        products: [{ id: 'p1', price: 40 }],
      },
    ],
    assignments: [{ menuId: 'lunch', level: 'shop', depth: 0, priority: 0 }],
  };
}

type Data = ReturnType<typeof buildKioskCatalog>;
const dataOf = (svc: KioskService) => (svc as unknown as { catalogData(): Data }).catalogData();
type Priced = { lines: SaleLine[]; changes: BasketChange[] };
const priceOf = (svc: KioskService, input: StartPaymentIn) => (svc as unknown as { priceBasket(i: StartPaymentIn, now?: Date): Priced }).priceBasket(input);

/** The kiosk as the cloud pairs it: credentials and a kiosk snapshot, so that `view()` builds the screens' catalog. */
function paired(svc: KioskService) {
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: 'm1', machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.cloud.setKioskSnapshot({ kiosk: true, configVersion: 'v1', operator: { id: 'kiosk:m1', name: 'קיוסק' }, config: {} });
  return svc;
}

const basket = (lines: StartPaymentIn['lines']): StartPaymentIn => ({ lines, service: 'take_away', customerName: null, customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null });
const line = (over: Partial<StartPaymentIn['lines'][number]> = {}): StartPaymentIn['lines'][number] => ({ key: 'a', productId: 'p1', qty: 1, options: [], notes: [], ...over });

afterEach(() => {
  vi.useRealTimers();
});

describe('the Windows kiosk\'s service and "תפריטים"', () => {
  it('keeps the block with the catalog: whole when sent, kept by a delta that carries none, none from an older cloud', () => {
    const svc = kiosk();
    expect((svc.cloud.catalog().catalogMenus as { menus: unknown[] }).menus).toHaveLength(1);
    svc.cloud.applyCatalog({ syncType: 'delta', products: [{ id: 'p2', categoryId: 'c1', name: 'פסטה', price: 48 }], categories: [] });
    expect((svc.cloud.catalog().catalogMenus as { menus: unknown[] }).menus).toHaveLength(1);
    svc.cloud.applyCatalog({ syncType: 'full', products: [{ id: 'p1', categoryId: 'c1', name: 'x', price: 1 }], categories: [], catalogMenus: { updatedAt: 'x', fallback: 'catalog', menus: [], assignments: [] } });
    expect((svc.cloud.catalog().catalogMenus as { menus: unknown[] }).menus).toHaveLength(0);
    expect(kiosk(null).cloud.catalog().catalogMenus).toBeNull();
  });

  it('builds the catalog under the menu its own clock says', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = kiosk();
    vi.setSystemTime(localMs('2026-10-07T10:30:00'));
    expect(dataOf(svc).menu.mode).toBe('catalog');
    expect(dataOf(svc).products.map((p) => [p.id, p.priceAgorot])).toEqual([['p1', 5400], ['p2', 4600], ['p4', 800]]);
    vi.setSystemTime(localMs('2026-10-07T12:00:00'));
    const d = dataOf(svc);
    expect(d.menu.menuName).toBe('צהריים');
    expect(d.products.map((p) => [p.id, p.priceAgorot, p.catalogPriceAgorot, p.priceSource])).toEqual([['p1', 4000, 5400, 'menu']]);
    expect(d.held.map((p) => p.id)).toEqual(['p2', 'p4']);
    svc.stop();
  });

  it('looks at the clock at each minute boundary — offline, with no call — and rebuilds the view only when the menu changes', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = paired(kiosk());
    vi.setSystemTime(localMs('2026-10-07T10:59:35'));
    // The screens' view is built: the catalog under no menu, and the clock looks again at the next minute boundary.
    expect(svc.view().catalog.menu?.mode).toBe('catalog');
    const rebuilt = vi.spyOn(svc as unknown as { dirty(): void }, 'dirty');
    // 10:59:59: nothing has happened — the first look is on the far side of the boundary.
    vi.advanceTimersByTime(24_000);
    expect(rebuilt).not.toHaveBeenCalled();
    // 11:00:00.000 — lunch has started, the look is 25 ms away. A basket priced just then reads the catalog by the clock
    // (under lunch) — which must not hide the change from the screens.
    vi.advanceTimersByTime(1_000);
    expect(dataOf(svc).menu.menuId).toBe('lunch');
    expect(rebuilt).not.toHaveBeenCalled();
    // The look: lunch starts, by the clock alone — the view is built again.
    vi.advanceTimersByTime(100);
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect(svc.view().catalog.menu?.menuId).toBe('lunch');
    // Minute after minute the look finds the same answer and rebuilds nothing, until 14:00.
    vi.advanceTimersByTime(60_000 * 100);
    expect(rebuilt).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000 * 100);
    expect(rebuilt).toHaveBeenCalledTimes(2);
    expect(svc.view().catalog.menu?.mode).toBe('catalog');
    svc.stop();
  });

  it('an open basket keeps its prices when the menu changes under it — and a real change of the catalog\'s price is a change', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = kiosk();
    // Added at 13:30 under lunch: the burger at 40, the catalog's 54 remembered.
    const added = line({ unitAgorot: 4000, listAgorot: 4000, catalogAgorot: 5400, menuId: 'lunch', priceSource: 'menu' });
    vi.setSystemTime(localMs('2026-10-07T13:30:00'));
    let r = priceOf(svc, basket([added]));
    expect([r.changes, r.lines[0].basePriceAgorot, r.lines[0].menuId, r.lines[0].menuName, r.lines[0].priceSource]).toEqual([[], 4000, 'lunch', 'צהריים', 'menu']);
    // 14:00: lunch ends, the burger is 54 again for a new line — the line in the basket stays at 40.
    vi.setSystemTime(localMs('2026-10-07T14:00:00'));
    expect(dataOf(svc).products.find((p) => p.id === 'p1')?.priceAgorot).toBe(5400);
    r = priceOf(svc, basket([added]));
    expect([r.changes, r.lines[0].basePriceAgorot, r.lines[0].catalogPriceAgorot]).toEqual([[], 4000, 5400]);
    // 54 became 60 in the cloud meanwhile: a real change — shown, repriced to what the kiosk sells it at now.
    svc.cloud.applyCatalog({ syncType: 'delta', products: [{ id: 'p1', categoryId: 'c1', name: 'המבורגר', price: 60 }], categories: [] });
    r = priceOf(svc, basket([added]));
    expect(r.changes.map((c) => (c.kind === 'repriced' ? [c.key, c.from, c.to] : [c.key]))).toEqual([['a', 4000, 6000]]);
    svc.stop();
  });

  it('a price the line carries that no menu sets is not kept; a line of an older screen is sold at what the kiosk sells it for now', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = kiosk();
    vi.setSystemTime(localMs('2026-10-07T12:00:00'));
    const forged = priceOf(svc, basket([line({ unitAgorot: 100, listAgorot: 100, catalogAgorot: 5400, menuId: 'lunch' })]));
    expect(forged.lines[0].basePriceAgorot).toBe(4000);
    expect(forged.changes.map((c) => c.kind)).toEqual(['repriced']);
    const old = priceOf(svc, basket([line({ unitAgorot: 4000 })]));
    expect([old.changes, old.lines[0].basePriceAgorot]).toEqual([[], 4000]);
    svc.stop();
  });

  it('a line added under a menu that left its product out stays while it is still sold; one added with no menu goes', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = kiosk();
    vi.setSystemTime(localMs('2026-10-07T12:00:00'));
    // The drink is not on lunch's menu: a line of it added under another menu stays (held), one added with none goes.
    const under = priceOf(svc, basket([line({ key: 'd', productId: 'p4', unitAgorot: 800, listAgorot: 800, catalogAgorot: 800, menuId: 'lunch' })]));
    expect([under.changes, under.lines[0]?.basePriceAgorot]).toEqual([[], 800]);
    const plain = priceOf(svc, basket([line({ key: 'd', productId: 'p4', unitAgorot: 800, listAgorot: 800 })]));
    expect(plain.changes.map((c) => [c.kind, c.key])).toEqual([['removed', 'd']]);
    svc.stop();
  });

  it('a line added under a menu goes once its product is no longer sold on the kiosk at all — the Android kiosk keeps it (anyProduct), this one must not', () => {
    // docs/SPEC_MENUS.md: a line added under a menu stays "as long as the product is still sold here". Android's `outsideMenu`
    // is every product the till lists, so it keeps a "קופות בלבד" / manager's-code / delisted line and PAYS it; here the line
    // stays only while the kiosk's own catalog rules (not the menu's placing) still sell the product.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = kiosk();
    vi.setSystemTime(localMs('2026-10-07T12:00:00'));
    const dish = (id: string, over: Row = {}, categoryId = 'c2') => ({ id, categoryId, name: id, price: 10, ...over });
    const ids = ['x-pos', 'x-mgr', 'x-cat', 'x-mgrcat', 'x-out', 'x-open', 'x-weigh', 'x-general'];
    // Lunch is on (it lists only the burger): these are sold by the catalog, held, and a line added under lunch stays.
    svc.cloud.applyCatalog({
      syncType: 'delta',
      products: ids.map((id) => dish(id, {}, id === 'x-cat' ? 'c3' : id === 'x-mgrcat' ? 'c4' : 'c2')),
      categories: [{ id: 'c3', name: 'ג', isActive: true }, { id: 'c4', name: 'ד', isActive: true }],
    });
    const lines = ids.map((id) => line({ key: id, productId: id, unitAgorot: 1000, listAgorot: 1000, catalogAgorot: 1000, menuId: 'lunch' }));
    expect(priceOf(svc, basket(lines)).changes).toEqual([]);
    // Then the shop stops selling each at a kiosk — one way each.
    svc.cloud.applyCatalog({
      syncType: 'delta',
      products: [
        dish('x-pos', { salesChannel: 'pos_only' }),
        dish('x-mgr', { requiresManagerApproval: true }),
        dish('x-cat', {}, 'c3'),
        dish('x-mgrcat', {}, 'c4'),
        dish('x-out', { inStock: false }),
        dish('x-open', { isOpenPrice: true }),
        dish('x-weigh', { isWeighed: true }),
        dish('x-general', { isGeneral: true }),
      ],
      categories: [{ id: 'c3', name: 'ג', isActive: false }, { id: 'c4', name: 'ד', isActive: true, requiresManagerApproval: true }],
    });
    const r = priceOf(svc, basket(lines));
    expect(r.changes.map((c) => [c.kind, c.key])).toEqual(ids.map((id) => ['removed', id]));
    expect(r.lines).toEqual([]);
    // The same lines added with no menu go too: no way back for them.
    expect(priceOf(svc, basket(lines.map((l) => ({ ...l, menuId: undefined })))).changes.map((c) => [c.kind, c.key])).toEqual(ids.map((id) => ['removed', id]));
    svc.stop();
  });

  it('the cloud\'s word beats a held line: the pasta is held by the menu, the cloud says it is gone — removed (Android\'s outsideMenu lookup ignores the cloud)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = paired(kiosk());
    vi.setSystemTime(localMs('2026-10-07T12:00:00'));
    expect(dataOf(svc).held.map((p) => p.id)).toEqual(['p2', 'p4']);
    vi.spyOn(svc.api, 'post').mockImplementation(
      async () =>
        ({
          kind: 'ok',
          status: 200,
          headers: new Headers(),
          body: { ok: false, lines: [{ productId: 'p2', available: false, reason: 'not_on_kiosk', priceAgorot: null, priceChanged: false }, { productId: 'p4', available: true, reason: null, priceAgorot: 800, priceChanged: false }] },
        }) as never,
    );
    // The cloud's verdict pulls the catalog (ok: false): no real call from a test.
    vi.spyOn(svc.sync, 'pullCatalog').mockResolvedValue(undefined as never);
    const input = basket([
      line({ key: 'pasta', productId: 'p2', unitAgorot: 4600, listAgorot: 4600, catalogAgorot: 4600, menuId: 'breakfast' }),
      line({ key: 'drink', productId: 'p4', unitAgorot: 800, listAgorot: 800, catalogAgorot: 800, menuId: 'breakfast' }),
    ]);
    await (svc as unknown as { cloudBasketCheck(i: StartPaymentIn): Promise<void> }).cloudBasketCheck(input);
    const r = priceOf(svc, input);
    expect(r.changes.map((c) => [c.kind, c.key])).toEqual([['removed', 'pasta']]);
    expect(r.lines.map((l) => l.key)).toEqual(['drink']);
    svc.stop();
  });

  it('asks the cloud the catalog price each line REMEMBERS — what the customer saw — not the catalog\'s now (Android: line.product.basePrice)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = paired(kiosk());
    vi.setSystemTime(localMs('2026-10-07T10:30:00'));
    const asked: Array<{ path: string; body: unknown }> = [];
    // The cloud as it is: the burger is 54 now; a line is "changed" when the price it was sent differs.
    vi.spyOn(svc.api, 'post').mockImplementation(async (path, body) => {
      asked.push({ path, body });
      const lines = (body as { lines: Array<{ productId: string; unitPriceAgorot?: number }> }).lines;
      return { kind: 'ok', status: 200, headers: new Headers(), body: { ok: true, lines: lines.map((l) => ({ productId: l.productId, available: true, reason: null, priceAgorot: 5400, priceChanged: l.unitPriceAgorot !== 5400 })) } } as never;
    });
    const input = basket([
      // Added when the burger was 50, with no menu: it remembers 50.
      line({ key: 'a', unitAgorot: 5000, listAgorot: 5000 }),
      // Added under lunch at the menu's 40, the catalog's 52 then: it remembers 52 — not the menu's 40.
      line({ key: 'b', unitAgorot: 4000, listAgorot: 4000, catalogAgorot: 5200, menuId: 'lunch' }),
      // A line of an older screen remembers nothing: the catalog the kiosk holds stands in.
      line({ key: 'c', unitAgorot: 5400 }),
      // Two units of the same dish: one line, its quantity.
      line({ key: 'd', unitAgorot: 5400, listAgorot: 5400, qty: 2 }),
    ]);
    await (svc as unknown as { cloudBasketCheck(i: StartPaymentIn): Promise<void> }).cloudBasketCheck(input);
    expect(asked).toEqual([
      {
        path: 'sync/m1/kiosk/basket-check',
        body: {
          lines: [
            { productId: 'p1', quantity: 1, unitPriceAgorot: 5000 },
            { productId: 'p1', quantity: 1, unitPriceAgorot: 5200 },
            { productId: 'p1', quantity: 1, unitPriceAgorot: 5400 },
            { productId: 'p1', quantity: 2, unitPriceAgorot: 5400 },
          ],
        },
      },
    ]);
    // What the cloud says moved is shown, as before: 50 → 54 and the lunch line (52 then) → the catalog's 54.
    expect(priceOf(svc, input).changes.map((c) => (c.kind === 'repriced' ? [c.key, c.from, c.to] : [c.key]))).toEqual([['a', 5000, 5400], ['b', 4000, 5400]]);
    svc.stop();
  });

  it('"אזל" still removes a line inside a menu', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const svc = kiosk();
    svc.cloud.applyCatalog({ syncType: 'delta', products: [{ id: 'p1', categoryId: 'c1', name: 'המבורגר', price: 54, isAvailable: false, lockAvailable: false }], categories: [] });
    vi.setSystemTime(localMs('2026-10-07T12:00:00'));
    const r = priceOf(svc, basket([line({ unitAgorot: 4000, listAgorot: 4000, catalogAgorot: 5400, menuId: 'lunch' })]));
    expect(r.changes.map((c) => [c.kind, c.key])).toEqual([['removed', 'a']]);
    svc.stop();
  });

  it('the fiscal document\'s items name the menu a line was added under, and where its price came from', () => {
    const base: SaleLine = { key: 'a', productId: 'p1', name: 'המבורגר', sku: null, basePriceAgorot: 4000, options: [], notes: [], qty: 1 };
    const itemsOf = (lines: SaleLine[]) => {
      const totals = saleTotals(lines, 0.18);
      const doc = {
        id: '00000000-0000-4000-8000-000000000001', documentType: 320, number: 1, prefix: null, status: 'completed', createdAt: '', updatedAt: '', shiftId: 's',
        businessDate: '2026-10-07', cashierId: 'kiosk:m', cashierName: 'קיוסק', branchId: null, orderId: null, lines,
        itemIds: lines.map((_, i) => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`), tracked: [], totals, promotions: [],
        card: { brand: 'visa', last4: '1', authNum: '1', uid: 'u', payments: null, firstPaymentAgorot: null, chargedAgorot: totals.chargeAgorot, meta: {} },
        paymentId: 'p', voidMeta: null,
      } as unknown as DocDraft;
      return documentWire(doc).items as Array<Record<string, unknown>>;
    };
    const [plain, under] = itemsOf([base, { ...base, key: 'b', menuId: 'lunch', menuName: 'צהריים', priceSource: 'menu' }]);
    expect('menuId' in plain || 'priceSource' in plain).toBe(false);
    expect([under.menuId, under.menuName, under.priceSource, under.unitPrice]).toEqual(['lunch', 'צהריים', 'menu', 40]);
  });
});
