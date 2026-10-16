/**
 * "חסומים כעת" / "חסום / אזל" from the Windows till (P:/specs/item-block-control.md): pos-android ItemBlockControlTest and
 * ItemBlocksTest's cases — the policy, the reach, the access of each option, the request on the wire, the release's why,
 * `hhmmOf` — then the engine: the capability on the heartbeat, the cloud's list, a block sent under the approver, a cashier's
 * manager code, offline read from the catalog. Tests only: a fake cloud.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  IB_TEXT,
  LEGACY_POLICY,
  access,
  activeFor,
  blockOf,
  blocksFromCatalog,
  categoryChain,
  effectiveLevel,
  hhmmOf,
  isWide,
  policyOf,
  reachFor,
  reachOf,
  refusalText,
  releaseWhy,
  releaseWhyText,
  requestAccess,
  requestBody,
  requestRefusal,
  untilText,
  type BlockView,
} from '../src/core/till/itemBlocks';
import { MANAGER_PIN, PIN, harness, type Harness } from './tillEngineHarness';

describe('the policy and the reach (ItemBlockControlTest)', () => {
  const local = policyOf({})!;
  const managing = policyOf({ role: 'managing' })!;
  const none = policyOf({ role: 'none' })!;

  it('parsing: the defaults; odd values fall back; the channels in order; not a policy — the old rules', () => {
    expect(local).toEqual({ role: 'local', localMaxLevel: 'area', localChannels: ['pos'], managingMaxLevel: 'shop', releaseMode: 'own_scope', localRelease: true, fromCloud: true });
    expect(policyOf({ role: 'boss', localMaxLevel: 'company', localChannels: ['pos', 'fax'] })).toMatchObject({ role: 'local', localMaxLevel: 'area', localChannels: ['pos'] });
    expect(policyOf({ localChannels: ['kiosk', 'pos'] })!.localChannels).toEqual(['pos', 'kiosk']);
    expect(policyOf('not json')).toBeNull();
    expect(policyOf('[1,2]')).toBeNull();
    expect(policyOf(undefined)).toBeNull();
    expect(reachFor(LEGACY_POLICY, null, true)).toBeNull();
  });

  it('the reach: managing, local, local without an area, a managing cap, none', () => {
    expect(reachOf(managing, true)).toEqual({ levels: ['machine', 'area', 'shop', 'event'], channels: ['pos', 'kiosk', 'online', 'menu'], localLevels: ['machine', 'area'], localChannels: ['pos'], defaultLevel: 'area', defaultChannels: ['pos'] });
    expect(reachOf(local, true)).toMatchObject({ levels: ['machine', 'area'], channels: ['pos'] });
    expect(reachOf(local, false)).toMatchObject({ levels: ['machine'], defaultLevel: 'machine' });
    expect(reachOf(policyOf({ role: 'managing', managingMaxLevel: 'area' })!, true).levels).toEqual(['machine', 'area']);
    expect(reachOf(none, true)).toMatchObject({ levels: [], channels: [], defaultLevel: null });
  });

  it('the access of each option', () => {
    const r = reachOf(local, true);
    expect(access('pos', r.channels, r.localChannels, 'allow')).toBe('open');
    expect(access('kiosk', r.channels, r.localChannels, 'allow')).toBe('locked_till');
    expect(access('shop', r.levels, r.localLevels, 'allow')).toBe('locked_till');
    const m = reachOf(managing, true);
    expect(access('kiosk', m.channels, m.localChannels, 'approval')).toBe('approval');
    expect(access('shop', m.levels, m.localLevels, 'approval')).toBe('approval');
    expect(access('area', m.levels, m.localLevels, 'approval')).toBe('open');
    expect(access('kiosk', m.channels, m.localChannels, 'deny')).toBe('locked_permission');
    expect(requestAccess(m, ['pos'], 'area', 'approval')).toBe('open');
    expect(requestAccess(m, ['pos', 'kiosk'], 'area', 'approval')).toBe('approval');
    expect(requestAccess(m, ['pos'], 'shop', 'deny')).toBe('locked_permission');
    expect(requestAccess(r, ['pos', 'kiosk'], 'area', 'allow')).toBe('locked_till');
    expect(isWide(m, ['pos'], 'machine')).toBe(false);
    expect(isWide(m, ['pos', 'online'], 'machine')).toBe(true);
    expect(isWide(m, ['pos'], 'event')).toBe(true);
    expect(effectiveLevel('machine', 'M2', 'M1')).toBe('area');
    expect(effectiveLevel('machine', 'M1', 'M1')).toBe('machine');
    expect(effectiveLevel('machine', null, 'M1')).toBe('machine');
  });

  it("the item's blocks in force, the department's chain (a loop ends)", () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const b = (o: Partial<Record<string, unknown>>) => blockOf({ id: String(o.id), kind: 'sold_out', channels: ['pos'], ...o })!;
    const list = [
      b({ id: 'own-soldout', productId: 'P1', until: '2026-10-13T13:00:00Z' }),
      b({ id: 'own-blocked', productId: 'P1', kind: 'blocked', until: '2026-10-13T18:00:00Z' }),
      b({ id: 'parent', categoryId: 'ROOT', itemType: 'category' }),
      b({ id: 'gone', productId: 'P1', until: '2026-10-13T11:00:00Z' }),
      b({ id: 'other', productId: 'P2' }),
    ];
    const chain = categoryChain('local-c1', [
      { id: 'local-c1', cloudId: 'C1', parentId: 'local-root' },
      { id: 'local-root', cloudId: 'ROOT', parentId: null },
    ]);
    expect([...chain].sort()).toEqual(['C1', 'ROOT', 'local-c1', 'local-root']);
    expect(activeFor(list, ['P1'], chain, now).map((x) => x.id)).toEqual(['own-blocked', 'own-soldout', 'parent']);
    expect([...categoryChain('A', [{ id: 'A', parentId: 'B' }, { id: 'B', parentId: 'A' }])].sort()).toEqual(['A', 'B']);
  });

  it('why "שחרר" is missing', () => {
    const r = reachOf(managing, true);
    const base = blockOf({ id: 'x', kind: 'sold_out', channels: ['pos'], level: 'area', releasable: false })!;
    expect(releaseWhy({ ...base, source: 'auto' }, true, r, 'allow')).toBe('auto_stock');
    expect(releaseWhy({ ...base, level: 'company' }, true, r, 'allow')).toBe('company');
    expect(releaseWhy({ ...base, releasable: true }, false, r, 'allow')).toBe('offline');
    expect(releaseWhy({ ...base, releasable: true, channels: ['kiosk'] }, true, r, 'deny')).toBe('no_permission');
    expect(releaseWhy({ ...base, releasable: true, channels: ['kiosk'], releaseNeeds: 'ITEM_BLOCK' }, true, r, 'deny')).toBeNull();
    expect(releaseWhy(base, true, r, 'allow')).toBe('managing');
    expect(releaseWhyText('managing', 'שחרור מהענן')).toBe('שחרור מהענן');
    expect(releaseWhyText('no_permission', 'x')).toBe(IB_TEXT.whyNoPermission);
    // The wire: `releasable` over `removable`.
    expect(blockOf({ id: 'y', removable: true, releasable: false })!.releasable).toBe(false);
  });

  it("the cloud's refusals in the till's words", () => {
    expect(refusalText(403, { detail: { code: 'block_scope_not_allowed', message: 'מהקופה הזו אפשר לחסום רק בקופות, עד נקודת המכירה.' } })).toEqual({ text: 'מהקופה הזו אפשר לחסום רק בקופות, עד נקודת המכירה.', needsWide: false });
    expect(refusalText(403, { detail: { code: 'block_scope_not_allowed', needs: 'ITEM_BLOCK_WIDE' } })).toEqual({ text: IB_TEXT.scopeNotAllowed, needsWide: true });
    expect(refusalText(403, { detail: { code: 'item_block_requires_manager', message: 'נדרש אישור מנהל' } }).text).toBe('הענן סירב: נדרש אישור מנהל');
    expect(refusalText(422, { detail: [{ loc: ['x'] }] }).text).toBe('הענן סירב: 422');
  });
});

describe('the request (ItemBlocksTest)', () => {
  it('on the wire: the channels in order, no levelId for the area, the note trimmed, the kiosk display only with the kiosk', () => {
    expect(requestBody({ productId: 'P', kind: 'blocked', channels: ['menu', 'kiosk'], level: 'area', levelId: 'x', kioskDisplay: 'hide', note: '  נגמר  ', duration: { mode: 'end_of_day' } })).toEqual({
      productId: 'P',
      kind: 'blocked',
      channels: ['kiosk', 'menu'],
      level: 'area',
      kioskDisplay: 'hide',
      note: 'נגמר',
      duration: { mode: 'end_of_day' },
    });
    expect(requestBody({ categoryId: 'C', kind: 'sold_out', channels: ['pos'], level: 'machine', levelId: 'M2', kioskDisplay: 'grey', duration: { mode: 'minutes', minutes: 30 } })).toEqual({ categoryId: 'C', kind: 'sold_out', channels: ['pos'], level: 'machine', levelId: 'M2', duration: { mode: 'minutes', minutes: 30 } });
  });

  it('validity', () => {
    const ok = { productId: 'P', kind: 'sold_out' as const, channels: ['pos' as const], level: 'area' as const, duration: { mode: 'none' as const } };
    expect(requestRefusal(ok)).toBeNull();
    expect(requestRefusal({ ...ok, categoryId: 'C' })).toBe('invalid');
    expect(requestRefusal({ ...ok, channels: [] })).toBe(IB_TEXT.pickChannel);
    expect(requestRefusal({ ...ok, level: 'machine', channels: ['online'] })).toBe('invalid');
    expect(requestRefusal({ ...ok, level: 'event' })).toBe(IB_TEXT.pickEvent);
    expect(requestRefusal({ ...ok, duration: { mode: 'time', at: '24:00' } })).toBe(IB_TEXT.badTime);
    expect(requestRefusal({ ...ok, duration: { mode: 'minutes', minutes: 0 } })).toBe('invalid');
  });

  it('hhmmOf and the end in words', () => {
    expect(hhmmOf('9:30')).toBe('09:30');
    expect(hhmmOf('1435')).toBe('14:35');
    expect(hhmmOf('14.35')).toBe('14:35');
    expect(hhmmOf('24:00')).toBeNull();
    expect(hhmmOf('12:60')).toBeNull();
    const now = new Date(2026, 9, 13, 10, 0).getTime();
    expect(untilText(new Date(2026, 9, 13, 23, 5).toISOString(), now)).toBe('עד 23:05');
    expect(untilText(new Date(2026, 9, 14, 4, 0).toISOString(), now)).toBe('עד 14/10 04:00');
    expect(untilText(null, now)).toBe('עד ביטול');
  });

  it('offline: the blocks in force from the stored catalog, read-only', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const rows = blocksFromCatalog(
      [
        { id: 'p1', name: 'קולה', blocks: [{ id: 'b1', kind: 'sold_out', productId: 'p1', channels: ['pos'], until: null }] },
        { id: 'p2', name: 'המבורגר', blocks: [{ id: 'b2', kind: 'blocked', productId: 'p2', channels: ['pos'] }, { id: 'b3', kind: 'blocked', productId: 'p2', until: '2026-10-13T11:00:00Z' }] },
      ],
      now,
    );
    expect(rows.map((r: BlockView) => [r.id, r.itemName, r.releasable])).toEqual([
      ['b2', 'המבורגר', false],
      ['b1', 'קולה', false],
    ]);
  });
});

/* ------------------------------------------------------------------ on the Windows till */

let current: Harness | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

const SHEET = {
  blocks: [{ id: 'blk-1', kind: 'sold_out', productId: 'p-cola', itemType: 'product', itemName: 'קולה', level: 'area', scopeName: 'בר', channels: ['pos'], until: null, by: 'קופה 2 · דנה כהן', origin: 'till', releasable: true, releaseNeeds: 'ITEM_BLOCK' }],
  context: { shopId: 's', shopName: 'הרצליה', areaId: 'a-1', areaName: 'בר', machineId: 'm', machineName: 'קופה 2', isKiosk: false, origin: 'till', kiosksOnly: false },
  areaDevices: [],
  events: [],
  itemBlocks: { role: 'local' },
  allowed: { levels: ['machine', 'area'], channels: ['pos'], localLevels: ['machine', 'area'], localChannels: ['pos'], defaults: { level: 'area', channels: ['pos'] } },
};

describe('"חסומים כעת" on the Windows till', () => {
  it('the capability on the heartbeat; the list and the sheet from the cloud, with the operator', async () => {
    const h = harness({ answers: { 'GET sync/m/item-blocks': () => SHEET } });
    current = h;
    await h.ok('session.login', { pin: PIN });
    const hb = (h.svc as unknown as { remoteHooks(): { heartbeatExtras(): Record<string, unknown> } }).remoteHooks().heartbeatExtras();
    expect(hb.capabilities).toEqual(expect.arrayContaining(['item_block_control_v1']));
    const list = (await h.ok('blocks.list')) as { live: boolean; rows: Array<{ id: string; releasable: boolean; words: { meta: string } }> };
    expect(list.live).toBe(true);
    expect(list.rows[0]).toMatchObject({ id: 'blk-1', releasable: true });
    expect(list.rows[0].words.meta).toBe('עד ביטול · ע״י קופה 2 · דנה כהן · קופה');
    const sheet = (await h.ok('blocks.sheet', { productId: 'p-cola' })) as { title: string; channels: Array<{ v: string; access: string }>; levels: Array<{ v: string; access: string }>; defaults: unknown; rows: unknown[] };
    expect(sheet.title).toBe('חסום / אזל · קולה');
    // "local": only "קופה"; the shop is the managing till's (shown locked — permissionsDeniedUi hides only a permission's).
    expect(sheet.channels.find((c) => c.v === 'pos')?.access).toBe('open');
    expect(sheet.channels.find((c) => c.v === 'kiosk')?.access).toBe('locked_till');
    expect(sheet.levels.find((l) => l.v === 'shop')?.access).toBe('locked_till');
    expect(sheet.defaults).toEqual({ channels: ['pos'], level: 'area', kind: 'sold_out' });
    expect(sheet.rows).toHaveLength(1);
    const asked = h.sent.filter((c) => c.path.startsWith('sync/m/item-blocks'));
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });

  it('a cashier blocks: a manager\'s code, the block under the manager, said; the catalog pulled', async () => {
    const posted: Array<Record<string, unknown> | null> = [];
    const h = harness({
      answers: {
        'GET sync/m/item-blocks': () => SHEET,
        'POST sync/m/item-blocks': (b) => {
          posted.push(b);
          return { __status: 201, block: { id: 'n' }, until: null, rolled: false };
        },
      },
    });
    current = h;
    await h.ok('session.login', { pin: PIN });
    await h.ok('blocks.sheet', { productId: 'p-cola' });
    const r = (await h.ok('blocks.block', { productId: 'p-cola', kind: 'blocked', channels: ['pos'], level: 'area', duration: { mode: 'none' } })) as { dialogId: string };
    expect(h.state().dialog?.title).toBe(IB_TEXT.approve);
    await h.ok('dialog.answer', { dialogId: r.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(posted).toEqual([{ productId: 'p-cola', kind: 'blocked', channels: ['pos'], level: 'area', duration: { mode: 'none' } }]);
    const req = h.sent.filter((c) => c.method === 'POST' && c.path === 'sync/m/item-blocks');
    expect(req).toHaveLength(1);
    const toasts = h.events.filter((e) => e.ev === 'toast').map((e) => (e.data as { text: string }).text);
    expect(toasts).toContain('נחסם · עד ביטול');
  });

  it("beyond the till's reach is refused here (the cloud would refuse it too)", async () => {
    const h = harness({ answers: { 'GET sync/m/item-blocks': () => SHEET } });
    current = h;
    await h.ok('session.login', { pin: MANAGER_PIN });
    await h.ok('blocks.sheet', { productId: 'p-cola' });
    const e = await h.fail('blocks.block', { productId: 'p-cola', kind: 'blocked', channels: ['pos', 'kiosk'], level: 'area', duration: { mode: 'none' } });
    expect(e.message).toBe(IB_TEXT.scopeNotAllowed);
  });

  it('a manager releases; offline the list is the stored catalog\'s, read-only', async () => {
    let online = true;
    const cleared: string[] = [];
    const h = harness({
      answers: {
        'GET sync/m/item-blocks': () => (online ? SHEET : { __status: 503 }),
        'POST sync/m/item-blocks/*': () => {
          cleared.push('x');
          return { id: 'blk-1', inForce: false, removable: false };
        },
      },
      products: [{ id: 'p-cola', name: 'קולה', price: 12.5, categoryId: 'c-drink', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all', blocks: [{ id: 'blk-1', kind: 'sold_out', productId: 'p-cola', channels: ['pos'] }] }],
    });
    current = h;
    await h.ok('session.login', { pin: MANAGER_PIN });
    await h.ok('blocks.list');
    const r = (await h.ok('blocks.release', { ids: ['blk-1'] })) as { ok: boolean; message: string };
    expect(r).toMatchObject({ ok: true, message: 'שוחרר — הפריט חזר למכירה' });
    expect(cleared).toHaveLength(1);
    online = false;
    const off = (await h.ok('blocks.list')) as { live: boolean; banner: string; rows: Array<{ id: string; releasable: boolean }> };
    expect(off).toMatchObject({ live: false, banner: IB_TEXT.offline });
    expect(off.rows).toEqual([expect.objectContaining({ id: 'blk-1', releasable: false })]);
  });
});
