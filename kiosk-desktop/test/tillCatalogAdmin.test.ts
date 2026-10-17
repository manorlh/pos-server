/**
 * "ניהול קטלוג" on the Windows till: pos-android CatalogAdminTest / CatalogAdminFilterTest cases (the parameters, the scope,
 * the tags, the gates by the cloud's role matrix, the way in, the product page's diff), ChainAreasTest's "שינוי מחיר מהקופה"
 * cases (core/till/tillPriceLevel.ts), then the module through the engine — a fake cloud: the list and its filters, a cashier's
 * availability with a manager's code, the offline queue, the price at its level (or the shop's on an older cloud), the grant
 * "תמיד באישור מורשה" asks, a shared product, a new product with its picture, "קטלוג למסוף" — and the screen's markup.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_ADMIN_TEXT as T,
  actionsFor,
  adminProductOf,
  applyFilter,
  availabilityBody,
  catalogGate,
  catalogRows,
  catalogSettingsOf,
  createBody,
  defaultScopeFor,
  diffEdit,
  draftError,
  entryShown,
  filterChips,
  filterCounts,
  inScope,
  machineCount,
  machineListToSend,
  matchesState,
  otherChanged,
  parseCatalogView,
  patchOf,
  photoFormatOf,
  priceChanged,
  resolveCatalogView,
  squareCrop,
  toggleCategory,
  toggleChannel,
  twoDecimals,
  validFilter,
  type AdminCategory,
  type AdminProduct,
  type CatalogAdminState,
  type CatalogUserFacts,
} from '../src/core/till/catalogAdmin';
import { decidePriceLevel, priceOptionsOf, priceRefusalMessage } from '../src/core/till/tillPriceLevel';
import { TillCatalogAdmin } from '../src/main/till/tillCatalogAdmin';
import { CatalogAdminScreen, type CatalogAdminActions } from '../src/renderer/roles/till/screens/CatalogAdminScreen';
import { MACHINE, MANAGER_PIN, PIN, harness, roster, type Harness, type HarnessOptions } from './tillEngineHarness';

/* ------------------------------------------------------------------------------------------------------- pure */

function p(id: string, o: Partial<AdminProduct> = {}): AdminProduct {
  return adminProductOf({ id, name: id, price: 10, sku: `sku-${id}`, categoryId: 'c1', ...o })!;
}
const cat = (id: string): AdminCategory => ({ id, name: id, isActive: true, ticketMode: null });

describe('the products filter (CatalogAdminFilterTest)', () => {
  const categories = [cat('drinks'), cat('snacks'), cat('empty')];
  const products = [
    p('cola', { categoryId: 'drinks' }),
    p('kiosk-cola', { categoryId: 'drinks', salesChannel: 'kiosk_only' }),
    p('tea', { categoryId: 'drinks', salesChannel: 'pos_only' }),
    p('bamba', { categoryId: 'snacks', salesChannel: 'kiosk_only', barcode: '7290001' }),
  ];
  const none = { categoryId: null, channel: null, query: '' };
  const ids = (f: typeof none | Parameters<typeof applyFilter>[0]) => applyFilter(f, products).map((x) => x.id);

  it('nothing chosen shows everything; a category chip, and a second tap shows all again', () => {
    expect(ids(none)).toEqual(['cola', 'kiosk-cola', 'tea', 'bamba']);
    const drinks = toggleCategory(none, 'drinks');
    expect(ids(drinks)).toEqual(['cola', 'kiosk-cola', 'tea']);
    expect(toggleCategory(drinks, 'drinks').categoryId).toBeNull();
    expect(toggleCategory(drinks, 'snacks').categoryId).toBe('snacks');
    expect(toggleCategory(drinks, null).categoryId).toBeNull();
  });

  it('it combines with the search and the channel; the search finds a barcode and a SKU', () => {
    const f = { categoryId: 'drinks', channel: null, query: 'COLA' };
    expect(ids(f)).toEqual(['cola', 'kiosk-cola']);
    expect(ids(toggleChannel(f, 'kiosk_only'))).toEqual(['kiosk-cola']);
    expect(ids({ ...f, channel: 'all' })).toEqual(['cola']);
    expect(ids({ ...none, query: '729000' })).toEqual(['bamba']);
    expect(ids({ ...none, query: 'sku-tea' })).toEqual(['tea']);
    expect(toggleChannel({ ...none, channel: 'pos_only' }, 'pos_only').channel).toBeNull();
  });

  it('each chip counts what it would show; the chips are the categories that hold products, and the chosen one', () => {
    expect(filterCounts(none, products)).toEqual({ drinks: 3, snacks: 1, '': 4 });
    expect(filterCounts({ ...none, channel: 'kiosk_only' }, products)).toEqual({ drinks: 1, snacks: 1, '': 2 });
    expect(filterCounts({ ...none, categoryId: 'snacks' }, products)).toEqual(filterCounts(none, products));
    expect(filterChips(none, categories, products).map((c) => c.id)).toEqual(['drinks', 'snacks']);
    expect(filterChips({ ...none, categoryId: 'empty' }, categories, products).map((c) => c.id)).toEqual(['drinks', 'snacks', 'empty']);
    expect(validFilter({ ...none, categoryId: 'deleted' }, categories).categoryId).toBeNull();
    expect(validFilter({ ...none, categoryId: 'snacks' }, categories).categoryId).toBe('snacks');
  });
});

describe('the parameters, the scope, the rows (CatalogAdminTest)', () => {
  it('the four parameters and their defaults', () => {
    expect(catalogSettingsOf({})).toEqual({ enabled: true, scope: 'auto', createFromTill: true, managerWithoutShift: true, photoFromTill: true });
    expect(catalogSettingsOf({ catalogAdminEnabled: 'false', catalogAdminScope: 'till', catalogCreateFromTill: false, catalogWithoutShift: 'never', productPhotoFromTill: 'False' })).toEqual({
      enabled: false,
      scope: 'till',
      createFromTill: false,
      managerWithoutShift: false,
      photoFromTill: false,
    });
    expect(catalogSettingsOf({ catalogAdminScope: 'galaxy' }).scope).toBe('auto');
  });

  const barMenu = { id: 'm-bar', name: 'בר', channel: 'pos', schedule: { always: true, days: null, ranges: [], from: null, to: null }, categories: [], products: [{ id: 'p1' }, { id: 'p3' }] };

  it("the cloud's view as it sent it; an older cloud — the till's menu, else the shop", () => {
    expect(parseCatalogView('{"scope":"menu","menuId":"m-bar","label":"תפריט נקודה: בר"}')).toEqual({ scope: 'menu', menuId: 'm-bar', label: 'תפריט נקודה: בר', fromCloud: true });
    expect(parseCatalogView({ scope: 'shop', label: 'קטלוג הסניף' })).toMatchObject({ scope: 'shop', menuId: null });
    expect(parseCatalogView(null)).toBeNull();
    expect(parseCatalogView('{"scope":"galaxy"}')).toBeNull();
    expect(resolveCatalogView(null, null, new Date())).toEqual({ scope: 'shop', menuId: null, label: null, fromCloud: false });
    const block = { fallback: 'catalog', menus: [barMenu], assignments: [{ menuId: 'm-bar', level: 'machine', depth: 0, priority: 0 }] };
    expect(resolveCatalogView(undefined, block, new Date(2026, 9, 12, 12, 0))).toEqual({ scope: 'menu', menuId: 'm-bar', label: 'תפריט: בר', fromCloud: false });
  });

  it('what each scope lists', () => {
    const rows = [p('p1'), p('p2', { inMachineCatalog: false }), p('p3'), p('p4', { shopListed: false })];
    const block = { menus: [barMenu] };
    expect([...inScope(rows, { scope: 'shop', menuId: null, label: null, fromCloud: true }, block, 'selected')].sort()).toEqual(['p1', 'p2', 'p3']);
    expect([...inScope(rows, { scope: 'menu', menuId: 'm-bar', label: null, fromCloud: true }, block, 'selected')].sort()).toEqual(['p1', 'p3']);
    expect([...inScope(rows, { scope: 'till', menuId: null, label: null, fromCloud: true }, block, 'selected')].sort()).toEqual(['p1', 'p3']);
    // A menu the till does not hold: the shop.
    expect(inScope(rows, { scope: 'menu', menuId: 'm-gone', label: null, fromCloud: true }, block, 'selected').size).toBe(3);
    expect(defaultScopeFor({ scope: 'menu', menuId: 'm', label: null, fromCloud: true }, true)).toBe('area');
    expect(defaultScopeFor({ scope: 'menu', menuId: 'm', label: null, fromCloud: true }, false)).toBe('machine');
    expect(defaultScopeFor({ scope: 'till', menuId: null, label: null, fromCloud: true }, true)).toBe('machine');
  });

  it('out of scope — hidden, or shown after the rest with its tag; blocks read by the shared rules', () => {
    const rows = [p('p1'), p('p2', { isAvailable: false }), p('p3')];
    const inside = catalogRows(rows, new Set(['p1', 'p2']), false, new Set(), 0);
    expect(inside.map((r) => r.product.id)).toEqual(['p1', 'p2']);
    expect(inside[1].tags).toEqual(['inactive']);
    const all = catalogRows(rows, new Set(['p1', 'p2']), true, new Set(['p1']), 0);
    expect(all.map((r) => r.product.id)).toEqual(['p1', 'p2', 'p3']);
    expect(all[2].tags).toEqual(['out_of_scope']);
    expect(all[0].tags).toEqual(['shared']);
    const blocked = adminProductOf({ id: 'b', name: 'b', price: 1, blocks: [{ id: 'k', kind: 'blocked', level: 'shop', until: null }] })!;
    expect(catalogRows([blocked], new Set(['b']), false, new Set(), Date.now())[0].tags).toEqual(['blocked']);
    expect(matchesState({ tags: ['blocked'] }, 'sold_out')).toBe(true);
    expect(matchesState({ tags: ['inactive'] }, 'active')).toBe(false);
    // The row's own lock wins over isAvailable (the till's sale rule).
    expect(adminProductOf({ id: 'x', isAvailable: true, lockAvailable: false })!.isAvailable).toBe(false);
  });
});

describe('the gates (§6.2) and the way in', () => {
  const SERVER_FIXTURES = path.join(__dirname, '..', '..', 'server', 'tests', 'fixtures');
  const matrixFile = path.join(SERVER_FIXTURES, 'till_permissions_matrix.json');

  it.runIf(existsSync(matrixFile))("the role defaults are the cloud's — waiter, cashier, supervisor, manager", () => {
    const text = readFileSync(matrixFile, 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(text).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
    const m = JSON.parse(text) as { roles: Record<string, { states: Record<string, string> }> };
    const codes = ['CATALOG_VIEW', 'CATALOG_AVAILABILITY', 'CATALOG_PRICE', 'CATALOG_EDIT', 'CATALOG_CREATE'];
    const states = (r: string) => codes.map((c) => m.roles[r].states[c]);
    expect(states('waiter')).toEqual(['allow', 'deny', 'deny', 'deny', 'deny']);
    expect(states('cashier')).toEqual(['allow', 'approval', 'deny', 'deny', 'deny']);
    expect(states('supervisor')).toEqual(['allow', 'allow', 'approval', 'approval', 'approval']);
    expect(states('manager')).toEqual(['allow', 'allow', 'allow', 'allow', 'allow']);
  });

  it('each action is gated before the tap — a cashier marks sold out with approval and never sees the price', () => {
    const on = catalogSettingsOf({});
    expect(catalogGate('availability', 'approval', 'hide', on)).toEqual({ kind: 'approval' });
    expect(catalogGate('price', 'denied', 'hide', on)).toEqual({ kind: 'hidden' });
    const disabled = catalogGate('price', 'denied', 'disable', on);
    expect(disabled).toEqual({ kind: 'disabled', reason: 'אין לך הרשאה: ניהול קטלוג — שינוי מחיר' });
    // An approval the screen holds is approval enough.
    expect(catalogGate('availability', 'approval', 'hide', on, true)).toEqual({ kind: 'allowed' });
    expect(catalogGate('create', 'allowed', 'disable', { ...on, createFromTill: false })).toEqual({ kind: 'hidden' });
  });

  it('the way in — off hides it, and with no shift only a manager under catalogWithoutShift', () => {
    const cashier: CatalogUserFacts = { role: 'cashier', fromCloud: true, tillRoleKey: 'cashier', editState: 'deny' };
    const manager: CatalogUserFacts = { role: 'cashier', fromCloud: true, tillRoleKey: 'manager', editState: 'allow' };
    const legacyManager: CatalogUserFacts = { role: 'shop_manager', fromCloud: false, tillRoleKey: null, editState: 'allow' };
    const on = catalogSettingsOf({});
    expect(entryShown(on, true, cashier, 'allowed', 'hide')).toBe(true);
    expect(entryShown({ ...on, enabled: false }, true, manager, 'allowed', 'hide')).toBe(false);
    expect(entryShown(on, false, cashier, 'allowed', 'hide')).toBe(false);
    expect(entryShown(on, false, manager, 'allowed', 'hide')).toBe(true);
    expect(entryShown(on, false, legacyManager, 'allowed', 'hide')).toBe(true);
    expect(entryShown({ ...on, managerWithoutShift: false }, false, manager, 'allowed', 'hide')).toBe(false);
    expect(entryShown(on, true, null, 'allowed', 'hide')).toBe(false);
    expect(entryShown(on, true, cashier, 'denied', 'hide')).toBe(false);
    expect(entryShown(on, true, cashier, 'denied', 'disable')).toBe(true);
  });
});

describe("the product page's save", () => {
  const f = (o: Partial<Parameters<typeof diffEdit>[1]> = {}) => ({ name: 'p1', price: '10.00', categoryId: 'c1', description: '', barcode: '', isOpenPrice: false, isWeighed: false, unitLabel: '', stock: '', ...o });

  it('a price edit stays a price edit', () => {
    const x = p('p1', { price: 12 });
    const edit = diffEdit(x, f({ price: '13.50' }));
    expect(edit).toEqual({ price: 13.5 });
    expect(actionsFor(priceChanged(edit), otherChanged(edit))).toEqual(['price']);
    expect(patchOf(edit)).toEqual({ price: 13.5 });
  });

  it('category, open price, weighed, unit, stock and description are sent; unchanged — nothing', () => {
    const x = p('p1', { isWeighed: true, unitLabel: 'ק"ג', description: 'ישן', stockQuantity: 4 });
    expect(diffEdit(x, f({ description: 'ישן', isWeighed: true, unitLabel: 'ק"ג', stock: '4' }))).toEqual({});
    const edit = diffEdit(x, f({ categoryId: 'c2', description: 'חדש', isOpenPrice: true, isWeighed: true, unitLabel: 'ליטר', stock: '7' }));
    expect(edit).toEqual({ categoryId: 'c2', description: 'חדש', isOpenPrice: true, unitLabel: 'ליטר', stockQuantity: 7 });
    expect(actionsFor(priceChanged(edit), otherChanged(edit))).toEqual(['edit']);
    expect(diffEdit(x, f({ description: 'ישן', stock: '2.5' }))).toEqual({ isWeighed: false });
    expect(patchOf({}, { ticketMode: 'per_unit', salesChannel: 'kiosk_only' })).toEqual({ ticketMode: 'per_unit', salesChannel: 'kiosk_only' });
  });

  it('a new product: what the form posts, and its checks', () => {
    const d = { name: ' סלט ', price: '24,5', categoryId: 'c1', sku: '', barcode: '729', description: '', stockQuantity: '3', isOpenPrice: false, isWeighed: false, unitLabel: 'kg', printTicket: true, salesChannel: 'pos_only' as const };
    expect(createBody(d)).toEqual({ name: 'סלט', price: 24.5, categoryId: 'c1', barcode: '729', stockQuantity: 3, ticketMode: 'per_unit', salesChannel: 'pos_only' });
    expect(draftError({ name: '', price: '1', categoryId: 'c' })).toBe(T.nameRequired);
    expect(draftError({ name: 'a', price: '-1', categoryId: 'c' })).toBe(T.priceInvalid);
    expect(draftError({ name: 'a', price: '1', categoryId: '' })).toBe(T.categoryRequired);
    expect(twoDecimals('5')).toBe('5.00');
    expect(twoDecimals('5,5')).toBe('5.50');
    expect(twoDecimals('abc')).toBeNull();
  });

  it('availability on the wire as the lock queue sends it', () => {
    expect(availabilityBody('off', 'area', true, '2026-10-17T10:00:00.000Z')).toEqual({ scope: 'area', active: false, permanent: true, blockedAt: '2026-10-17T10:00:00.000Z' });
    expect(availabilityBody('sold_out_today', 'machine', null, 'x')).toEqual({ scope: 'machine', active: false, permanent: false, blockedAt: 'x' });
    expect(availabilityBody('on', 'shop', null, 'x')).toEqual({ scope: 'shop', active: true });
    expect(availabilityBody('inherit', 'shop', null, 'x')).toEqual({ scope: 'shop', active: null });
  });

  it('the picture: its format by the signature, the square cut', () => {
    expect(photoFormatOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg');
    expect(photoFormatOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))?.uploadName).toBe('product.png');
    expect(photoFormatOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))?.mime).toBe('image/webp');
    expect(photoFormatOf(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(squareCrop(4000, 3000)).toEqual({ left: 500, top: 0, side: 3000, out: 800 });
    expect(squareCrop(300, 500)).toEqual({ left: 0, top: 100, side: 300, out: 300 });
  });

  it('"קטלוג למסוף": the count and the list sent', () => {
    const rows = [p('b'), p('a'), p('g', { isGeneral: true })];
    expect(machineCount(new Set(['a', 'g']), rows)).toEqual({ selected: 1, total: 2 });
    expect(machineListToSend(new Set(['b', 'a', 'g', 'gone']), rows)).toEqual(['a', 'b']);
  });
});

describe('"שינוי מחיר מהקופה" (ChainAreasTest §9.6)', () => {
  const options = (json: string) => priceOptionsOf(JSON.parse(json));

  it("an older server keeps the shop's price path, and no levels says it is off", () => {
    expect(decidePriceLevel(null)).toEqual({ kind: 'legacy' });
    expect(decidePriceLevel(options('{"levels":[],"ask":true}'))).toEqual({ kind: 'off' });
  });

  it('without ask the default level goes silently', () => {
    expect(decidePriceLevel(options('{"levels":["area","shop"],"defaultLevel":"area","ask":false}'))).toEqual({ kind: 'use', level: 'area' });
    expect(decidePriceLevel(options('{"levels":["shop"],"defaultLevel":"area","ask":true}'))).toEqual({ kind: 'use', level: 'shop' });
  });

  it('ask offers the area first, the default picked, a refused level disabled with its reason', () => {
    const d = decidePriceLevel(options('{"levels":["shop","area"],"defaultLevel":"shop","ask":true,"areaName":"בר","refusals":{"area":null,"shop":null},"prices":{"base":15.0}}'));
    if (d.kind !== 'ask') throw new Error('ask');
    expect(d.choices.map((c) => c.level)).toEqual(['area', 'shop']);
    expect(d.preselected).toBe('shop');
    expect(d.areaName).toBe('בר');
    expect(d.choices.every((c) => c.enabled)).toBe(true);
    const refused = decidePriceLevel(options('{"levels":["area","shop"],"defaultLevel":"shop","ask":true,"refusals":{"shop":"מחירי המוצר נקבעים ע״י הרשת","area":null}}'));
    if (refused.kind !== 'ask') throw new Error('ask');
    expect(refused.preselected).toBe('area');
    expect(refused.choices.find((c) => c.level === 'shop')).toEqual({ level: 'shop', refusal: 'מחירי המוצר נקבעים ע״י הרשת', enabled: false });
    const none = decidePriceLevel(options('{"levels":["area","shop"],"ask":true,"refusals":{"shop":"נעול","area":"נעול"}}'));
    expect(none.kind === 'ask' && none.preselected).toBeNull();
  });

  it("a refused price change says the cloud's Hebrew", () => {
    expect(priceRefusalMessage('{"detail":{"code":"price_policy","reason":"locked","message":"המחיר נעול ע״י הרשת"}}')).toBe('המחיר נעול ע״י הרשת');
    expect(priceRefusalMessage({ detail: { code: 'till_price_off', message: 'שינוי מחיר מהקופה אינו מופעל' } })).toBe('שינוי מחיר מהקופה אינו מופעל');
    expect(priceRefusalMessage('{"detail":"לא ניתן"}')).toBe('לא ניתן');
    expect(priceRefusalMessage('{"detail":"readonly"}')).toBeNull();
    expect(priceRefusalMessage('{"detail":{"code":"x","message":"plain"}}')).toBeNull();
    expect(priceRefusalMessage('not json')).toBeNull();
    expect(priceRefusalMessage(null)).toBeNull();
  });
});

/* ----------------------------------------------------------------------------------------- through the engine */

/** The harness, its ops by name (the coordinator adds `catalog.*` to the protocol's TillOp). */
type H = Omit<Harness, 'ok' | 'fail'> & {
  ok<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T>;
  fail(op: string, args?: Record<string, unknown>): Promise<{ code: string; message: string }>;
};

let current: Harness | H | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

const flush = async (h: H) => {
  for (let i = 0; i < 6; i++) {
    await h.engine.ctx.later(() => undefined);
    await new Promise((r) => setImmediate(r));
  }
};

const view = (h: H) => (h.state() as unknown as Record<string, unknown>).catalogAdmin as CatalogAdminState | undefined;

async function till(o: HarnessOptions & { pin?: string; shift?: boolean; deps?: ConstructorParameters<typeof TillCatalogAdmin>[1] } = {}) {
  const h = harness({ ...o, answers: { 'GET sync/m/parameters': () => ({ parameters: {}, catalogAdminView: { scope: 'shop', label: 'קטלוג הסניף' } }), ...(o.answers ?? {}) } });
  current = h;
  const f = h.engine.register(new TillCatalogAdmin(h.engine.ctx, { ...(o.deps ?? {}) }));
  await h.ok('session.login', { pin: o.pin ?? PIN });
  if (o.shift !== false) await h.ok('shift.open', { openingCashAgorot: 0 });
  return { h: h as unknown as H, f };
}

/** A manager's code into the dialog the engine shows now. */
async function approve(h: H, pin = MANAGER_PIN) {
  const d = h.state().dialog;
  if (!d) throw new Error('no dialog');
  return h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin } });
}

describe('"ניהול קטלוג" through the engine', () => {
  it('the way in: a cashier with a shift; with none only a manager; off — nobody', async () => {
    const { h } = await till({ shift: false });
    expect(view(h)).toMatchObject({ entryShown: false, open: false });
    expect((await h.fail('catalog.open')).code).toBe('shift_not_open');
    await h.ok('session.logout');
    await h.ok('session.login', { pin: MANAGER_PIN });
    expect(view(h)?.entryShown).toBe(true);
    current = null;
    h.stop();
    const off = await till({ parameters: { catalogAdminEnabled: false } });
    expect(view(off.h)?.entryShown).toBe(false);
    expect((await off.h.fail('catalog.open')).code).toBe('permission_denied');
  });

  it("opened: the cloud's view, the rows with their tags and prices, the filters", async () => {
    const { h } = await till({ pin: MANAGER_PIN });
    await h.ok('catalog.open');
    await flush(h);
    const v = view(h)!;
    expect(v.open).toBe(true);
    expect(v.scopeLine).toBe('קטלוג הסניף · 4 מוצרים');
    expect(v.rows.map((r) => r.name)).toEqual(['המבורגר', 'קולה', 'ארוחת ילדים', 'סטייק צוות']);
    expect(v.rows[1].price).toBe('₪12.50');
    expect(v.rows[2].channel).toBe('קיוסק בלבד');
    expect(v.categoryChips.map((c) => c.label)).toEqual(['הכל (4)', 'מנות (3)', 'שתייה (1)']);
    expect(v.gates.create).toMatchObject({ offered: true, usable: true, approval: false });
    expect(h.sent.some((s) => s.method === 'GET' && s.path === 'sync/m/parameters')).toBe(true);
    await h.ok('catalog.filter', { query: 'קולה' });
    expect(view(h)!.rows.map((r) => r.id)).toEqual(['p-cola']);
    await h.ok('catalog.filter', { query: '', categoryId: 'c-main', channel: 'pos_only' });
    expect(view(h)!.rows.map((r) => r.id)).toEqual(['p-pos']);
    await h.ok('catalog.filter', { categoryId: 'c-main' });
    expect(view(h)!.filter.categoryId).toBeNull();
    await h.ok('catalog.close');
    expect(view(h)!.open).toBe(false);
  });

  it("a cashier's availability: the manager's code, sent in the manager's name, applied on the till at once", async () => {
    const { h } = await till({ answers: { 'PUT sync/m/products/p-cola/availability': () => ({ id: 'p-cola', scope: 'shop', active: false }) } });
    const put = vi.spyOn(h.svc.api, 'put');
    await h.ok('catalog.open');
    expect(view(h)!.gates.availability).toMatchObject({ offered: true, approval: true });
    // A cashier never sees the price change of a role that denies it — the legacy cashier asks a manager for it.
    expect(view(h)!.gates.price.approval).toBe(true);
    const r = await h.ok<{ dialogId: string }>('catalog.setAvailable', { productIds: ['p-cola'], change: 'off', scope: 'shop', permanent: true });
    expect(r.dialogId).toBeTruthy();
    await approve(h);
    await flush(h);
    const call = put.mock.calls.find((c) => String(c[0]).endsWith('/availability'))!;
    expect(call[1]).toMatchObject({ scope: 'shop', active: false, permanent: true });
    expect(call[2]?.headers).toEqual({ 'X-Pos-User-Id': 'u-manager' });
    expect(view(h)!.note).toEqual({ text: T.activeSaved, tone: 'ok' });
    expect(view(h)!.approvedBy).toBe('אבי לוי');
    // The approval is kept: the next one goes without a code.
    await h.ok('catalog.setAvailable', { productIds: ['p-cola'], change: 'on', scope: 'shop' });
    expect(h.state().dialog).toBeNull();
    await h.ok('catalog.release');
    expect(view(h)!.approvedBy).toBeNull();
  });

  it('no connection: on this till at once, queued, and delivered later', async () => {
    let down = true;
    const { h, f } = await till({
      pin: MANAGER_PIN,
      answers: {
        'PUT sync/m/products/p-cola/availability': () => {
          if (down) throw new Error('offline');
          return { ok: true };
        },
      },
    });
    await h.ok('catalog.open');
    await h.ok('catalog.setAvailable', { productIds: ['p-cola'], change: 'sold_out_today', scope: 'shop' });
    await flush(h);
    expect(view(h)!.note).toEqual({ text: T.availabilityQueued, tone: 'info' });
    expect(h.svc.cloud.catalog().products.find((x) => x.id === 'p-cola')?.isAvailable).toBe(false);
    expect(view(h)!.rows.find((r) => r.id === 'p-cola')!.tags.map((t) => t.label)).toEqual(['לא פעיל']);
    expect(h.svc.kv.getJson<unknown[]>('catalogAdmin.pendingLocks')).toHaveLength(1);
    down = false;
    await f.retryLocks();
    expect(h.svc.kv.getJson<unknown[]>('catalogAdmin.pendingLocks')).toEqual([]);
    const sent = h.sent.filter((s) => s.path === 'sync/m/products/p-cola/availability');
    expect(sent.at(-1)?.body).toMatchObject({ scope: 'shop', active: false, permanent: false });
  });

  it("the price on an older cloud (no price-options): the shop's, through the product patch", async () => {
    const { h } = await till({ pin: MANAGER_PIN, answers: { 'PUT sync/m/products/p-cola': () => ({ id: 'p-cola' }) } });
    await h.ok('catalog.open');
    await h.ok('catalog.page', { productId: 'p-cola' });
    const page = view(h)!.page!;
    expect(page.draft.price).toBe('12.50');
    await h.ok('catalog.save', { productId: 'p-cola', draft: { ...page.draft, price: '13.5' } });
    await flush(h);
    expect(h.sent.find((s) => s.method === 'PUT' && s.path === 'sync/m/products/p-cola')?.body).toEqual({ price: 13.5 });
    expect(h.sent.some((s) => s.path.endsWith('/price'))).toBe(false);
    expect(view(h)!.page).toBeNull();
    expect(view(h)!.note?.text).toBe(T.saved);
  });

  it('"איפה לשנות?": the levels the cloud allows, the one picked written at its level', async () => {
    const { h } = await till({
      pin: MANAGER_PIN,
      answers: {
        'GET sync/m/products/p-cola/price-options': () => ({ levels: ['area', 'shop'], defaultLevel: 'area', ask: true, areaName: 'בר', refusals: { area: null, shop: null } }),
        'PUT sync/m/products/p-cola/price': (b) => ({ level: b?.level, price: b?.price }),
      },
    });
    await h.ok('catalog.open');
    await h.ok('catalog.page', { productId: 'p-cola' });
    await h.ok('catalog.save', { productId: 'p-cola', draft: { ...view(h)!.page!.draft, price: '14' } });
    await flush(h);
    expect(view(h)!.priceAsk).toEqual({
      title: 'איפה לשנות?',
      choices: [
        { level: 'area', label: 'רק בבר', refusal: null, enabled: true },
        { level: 'shop', label: 'בכל הסניף', refusal: null, enabled: true },
      ],
      preselected: 'area',
    });
    await h.ok('catalog.priceLevel', { level: 'shop' });
    await flush(h);
    expect(h.sent.find((s) => s.path === 'sync/m/products/p-cola/price')?.body).toEqual({ price: 14, level: 'shop' });
    expect(h.sent.some((s) => s.method === 'PUT' && s.path === 'sync/m/products/p-cola')).toBe(false);
    expect(view(h)!.priceAsk).toBeNull();
  });

  it('price change off in the cloud: said, nothing sent; "תמיד באישור מורשה": the grant of an authorised code', async () => {
    let options: Record<string, unknown> = { levels: [], ask: true };
    const { h } = await till({
      pin: MANAGER_PIN,
      answers: {
        'GET sync/m/products/p-cola/price-options': () => options,
        'POST elevation/sessions': () => ({ token: 'grant-1', userName: 'אבי' }),
        'PUT sync/m/products/p-cola/price': () => ({ level: 'shop' }),
      },
    });
    const put = vi.spyOn(h.svc.api, 'put');
    await h.ok('catalog.open');
    await h.ok('catalog.page', { productId: 'p-cola' });
    const draft = view(h)!.page!.draft;
    await h.ok('catalog.save', { productId: 'p-cola', draft: { ...draft, price: '14' } });
    await flush(h);
    expect(view(h)!.note).toEqual({ text: 'שינוי מחיר מהקופה אינו מופעל', tone: 'error' });
    expect(put).not.toHaveBeenCalled();
    options = { levels: ['shop'], defaultLevel: 'shop', ask: false, approvalRequired: true };
    await h.ok('catalog.save', { productId: 'p-cola', draft: { ...draft, price: '14' } });
    await flush(h);
    expect(h.state().dialog?.kind).toBe('manager_approval');
    expect((await h.fail('dialog.answer', { dialogId: h.state().dialog!.id, action: 'approve', answers: { pin: PIN } })).code).toBe('wrong_pin');
    await approve(h);
    await flush(h);
    expect(h.sent.find((s) => s.path === 'elevation/sessions')?.body).toEqual({ posUserId: 'u-manager', pin: MANAGER_PIN, scopes: ['catalog:price'] });
    const call = put.mock.calls.find((c) => String(c[0]).endsWith('/price'))!;
    expect(call[2]?.headers).toMatchObject({ 'X-Elevation-Token': 'grant-1' });
  });

  it('a shared product: the cloud refuses the rename, the till remembers it — only price and availability', async () => {
    const { h } = await till({ pin: MANAGER_PIN, answers: { 'PUT sync/m/products/p-burger': () => ({ __status: 403, detail: 'shared_product_master_readonly' }) } });
    await h.ok('catalog.open');
    await h.ok('catalog.page', { productId: 'p-burger' });
    await h.ok('catalog.save', { productId: 'p-burger', draft: { ...view(h)!.page!.draft, name: 'המבורגר כפול' } });
    await flush(h);
    expect(view(h)!.note).toEqual({ text: T.sharedReadonly, tone: 'error' });
    expect(view(h)!.page!.gates.edit).toMatchObject({ offered: true, usable: false, reason: T.affectsShared });
    expect(view(h)!.rows.find((r) => r.id === 'p-burger')!.tags.map((t) => t.tag)).toEqual(['shared']);
  });

  it('a new product with its picture: created, then the picture through the multipart upload', async () => {
    const uploads: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const fetchSpy = (async (url: string, init: RequestInit) => {
      uploads.push({ url: String(url), body: init.body, headers: init.headers as Record<string, string> });
      return new Response('{"url":"x"}', { status: 200 });
    }) as unknown as typeof fetch;
    const { h } = await till({ pin: MANAGER_PIN, deps: { fetch: fetchSpy }, answers: { 'POST sync/m/products': () => ({ id: 'p-new' }) } });
    await h.ok('catalog.open');
    await h.ok('catalog.page', { productId: null });
    const page = view(h)!.page!;
    expect(page).toMatchObject({ mode: 'new', title: 'מוצר חדש' });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
    await h.ok('catalog.add', { draft: { ...page.draft, name: 'סלט', price: '24' }, photo: { data: jpeg, keepBackground: false, enhance: true } });
    await flush(h);
    expect(h.sent.find((s) => s.method === 'POST' && s.path === 'sync/m/products')?.body).toEqual({ name: 'סלט', price: 24, categoryId: 'c-main', salesChannel: 'all' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe(`${h.svc.api.url(`sync/${MACHINE}/products/p-new/image`)}?keepBackground=false&enhance=true`);
    expect(uploads[0].headers).toMatchObject({ 'X-Pos-User-Id': 'u-manager', Authorization: 'Bearer t' });
    const file = (uploads[0].body as FormData).get('file') as File;
    expect(file.name).toBe('product.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(view(h)!.note?.text).toBe(T.saved);
    // Not a picture: refused before anything is sent.
    expect((await h.fail('catalog.photo', { productId: 'p-cola', data: Buffer.from('hello').toString('base64') })).message).toBe(T.photoUnreadable);
  });

  it('"קטלוג למסוף": a cashier sees only the prompt; a manager\'s code opens it; the list goes whole', async () => {
    const { h } = await till({ answers: { 'PUT sync/m/machine-catalog': () => ({ mode: 'selected', selectedCount: 2, changed: true }) } });
    await h.ok('catalog.open');
    await h.ok('catalog.panel', { panel: 'till' });
    expect(view(h)!.machine).toMatchObject({ authorized: false, groups: [] });
    expect((await h.fail('catalog.machineSave', { mode: 'all', productIds: [] })).message).toBe(T.machineManagerOnly);
    await h.ok('catalog.machineAuth');
    await approve(h);
    const m = view(h)!.machine!;
    expect(m.authorized).toBe(true);
    expect(m.total).toBe(4);
    expect(m.groups.map((g) => g.name)).toEqual(['מנות', 'שתייה']);
    await h.ok('catalog.machineSave', { mode: 'selected', productIds: ['p-cola', 'p-burger', 'p-gone'] });
    await flush(h);
    expect(h.sent.find((s) => s.path === 'sync/m/machine-catalog')?.body).toEqual({ mode: 'selected', productIds: ['p-burger', 'p-cola'] });
    expect(view(h)!.note).toEqual({ text: T.machineSaved, tone: 'ok' });
  });

  it('categories: a new one, offline said in Android words', async () => {
    const { h } = await till({
      pin: MANAGER_PIN,
      answers: {
        'POST sync/m/categories': () => {
          throw new Error('offline');
        },
      },
    });
    await h.ok('catalog.open');
    await h.ok('catalog.panel', { panel: 'categories' });
    await h.ok('catalog.categoryAdd', { name: 'קינוחים' });
    await flush(h);
    expect(view(h)!.note).toEqual({ text: T.needsNetwork, tone: 'error' });
    expect((await h.fail('catalog.categoryAdd', { name: '  ' })).message).toBe(T.nameRequired);
  });

  it('signed out: nothing of it in the state', async () => {
    const { h } = await till({ pin: MANAGER_PIN, users: roster() });
    await h.ok('catalog.open');
    await h.ok('session.logout');
    expect(view(h)).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------------------- the screen */

const g = (o: Partial<CatalogAdminState['gates']['price']> = {}) => ({ offered: true, usable: true, approval: false, reason: null, ...o });

export const CATALOG_ADMIN_FIXTURE: CatalogAdminState = {
  entryShown: true,
  open: true,
  panel: 'products',
  title: 'ניהול קטלוג',
  scopeLine: 'קטלוג הסניף · 42 מוצרים',
  busy: false,
  note: { text: 'עודכן — הקופות יסתנכרנו', tone: 'ok' },
  approvedBy: 'אבי לוי',
  gates: { availability: g(), price: g({ approval: true }), edit: g(), create: g() },
  canSelect: true,
  filter: { query: '', categoryId: null, channel: null, state: 'any', showOutOfScope: false },
  offerOutOfScope: true,
  stateChips: [
    { key: 'any', label: 'מצב: הכל', on: true },
    { key: 'active', label: 'פעילים', on: false },
    { key: 'inactive', label: 'לא פעילים', on: false },
    { key: 'sold_out', label: 'אזל / חסום', on: false },
  ],
  channelChips: [
    { key: '', label: 'כל הערוצים', on: true },
    { key: 'all', label: 'קופות וקיוסק', on: false },
    { key: 'kiosk_only', label: 'קיוסק בלבד', on: false },
    { key: 'pos_only', label: 'קופות בלבד', on: false },
  ],
  categoryChips: [
    { key: '', label: 'הכל (42)', on: true },
    { key: 'c-main', label: 'מנות עיקריות (18)', on: false },
    { key: 'c-drink', label: 'שתייה קלה וחמה (24)', on: false },
  ],
  rows: [
    { id: 'p1', name: 'המבורגר אנטריקוט 300 גרם עם צ׳יפס בטטה ורוטב הבית', price: '₪68.00', imageUrl: null, inScope: true, tags: [], channel: null },
    { id: 'p2', name: 'קולה זירו', price: '₪12.50', imageUrl: null, inScope: true, tags: [{ tag: 'inactive', label: 'לא פעיל' }], channel: 'קופות בלבד' },
    { id: 'p3', name: 'עוגת שוקולד', price: '₪32.00', imageUrl: null, inScope: true, tags: [{ tag: 'sold_out', label: 'אזל' }, { tag: 'shared', label: 'משותף' }], channel: null },
  ],
  total: 42,
  hasArea: true,
  availabilityScope: 'area',
  scopeOptions: [
    { key: 'machine', label: 'בקופה זו', affects: 'ישפיע על הקופה הזו בלבד', enabled: true },
    { key: 'area', label: 'בנקודת המכירה', affects: 'ישפיע על כל נקודת המכירה', enabled: true },
    { key: 'shop', label: 'בכל הסניף', affects: 'ישפיע על כל הסניף', enabled: true },
  ],
  categories: [
    { id: 'c-main', name: 'מנות עיקריות', inactive: false },
    { id: 'c-drink', name: 'שתייה קלה וחמה', inactive: false },
  ],
  page: null,
  priceAsk: null,
  machine: null,
};

const noop = () => undefined;
const actions: CatalogAdminActions = {
  panel: noop,
  filter: noop,
  more: noop,
  page: noop,
  pageClose: noop,
  save: noop,
  add: noop,
  priceLevel: noop,
  priceCancel: noop,
  setAvailable: noop,
  moveCategory: noop,
  categoryAdd: noop,
  categoryRename: noop,
  categoryActive: noop,
  machineAuth: noop,
  machineSave: noop,
  release: noop,
  dismiss: noop,
  block: noop,
};
const render = (v: CatalogAdminState | undefined) => renderToStaticMarkup(createElement(CatalogAdminScreen, { view: v, actions, back: noop }));

describe('the screen', () => {
  it('the bar, the search, one chip row, rows with tags and prices, "עוד", the "+"', () => {
    const html = render(CATALOG_ADMIN_FIXTURE);
    for (const w of ['ניהול קטלוג', 'קטלוג הסניף · 42 מוצרים', 'מאושר על ידי אבי לוי', T.search, T.showOutOfScope, 'מצב: הכל', 'כל הערוצים', 'הכל (42)', 'מנות עיקריות (18)', 'קולה זירו', '₪12.50', 'לא פעיל', 'קופות בלבד', 'אזל', 'משותף', 'עוד (39)', 'עודכן — הקופות יסתנכרנו']) {
      expect(html).toContain(w);
    }
    expect(html).toContain('t-cadm-fab');
    // No buttons on a row but the row itself.
    const row = html.slice(html.indexOf('t-cadm-rows'), html.indexOf('</ul>', html.indexOf('t-cadm-rows')));
    expect((row.match(/<button/g) ?? []).length).toBe(3);
    expect(render(undefined)).toBe('');
    expect(render({ ...CATALOG_ADMIN_FIXTURE, open: false })).toBe('');
  });

  it('the product page: each section as its gate allows, what it changes; the price "באישור מנהל"', () => {
    const page = {
      key: 'pg1',
      mode: 'edit' as const,
      productId: 'p2',
      title: 'קולה זירו',
      draft: { name: 'קולה זירו', price: '12.50', categoryId: 'c-drink', sku: 'K1', barcode: '7290000000011', description: '', stockQuantity: '', isOpenPrice: false, isWeighed: false, unitLabel: '', printTicket: false, salesChannel: 'pos_only' as const },
      isAvailable: false,
      outOfScope: false,
      shared: false,
      imageUrl: null,
      cloudTicket: 'ללא שובר',
      cloudPrintTicket: false,
      gates: { availability: g(), price: g({ approval: true }), edit: g({ usable: false, reason: T.affectsShared }), block: true },
      availabilityAffects: 'ישפיע על כל נקודת המכירה · חל בקופה מיד, גם בלי רשת, ונשלח לענן כשיש',
      photoEnabled: true,
    };
    const html = render({ ...CATALOG_ADMIN_FIXTURE, page });
    for (const w of [T.sectionAvailability, T.makeActive, T.soldOutToday, T.blockMore, T.sectionPrice, T.needsApproval, 'המחיר ישתנה בכל הסניף, כולל כל נקודות המכירה · דורש רשת', T.sectionDetails, T.affectsShared, T.fieldChannel, T.channelHintPosOnly, T.save]) {
      expect(html).toContain(w);
    }
    // The details are greyed (shared): no picture section.
    expect(html).not.toContain(T.photoUpload);
    const editable = render({ ...CATALOG_ADMIN_FIXTURE, page: { ...page, gates: { ...page.gates, edit: g() } } });
    expect(editable).toContain(T.photoUpload);
    expect(editable).toContain('type="file"');
  });

  it('"איפה לשנות?", and "קטלוג למסוף" for a cashier', () => {
    const ask = render({
      ...CATALOG_ADMIN_FIXTURE,
      priceAsk: {
        title: 'איפה לשנות?',
        choices: [
          { level: 'area', label: 'רק בבר', refusal: null, enabled: true },
          { level: 'shop', label: 'בכל הסניף', refusal: 'מחירי המוצר נקבעים ע״י הרשת', enabled: false },
        ],
        preselected: 'area',
      },
    });
    for (const w of ['איפה לשנות?', 'רק בבר', 'בכל הסניף', 'מחירי המוצר נקבעים ע״י הרשת']) expect(ask).toContain(w);
    const machine = render({ ...CATALOG_ADMIN_FIXTURE, panel: 'till', title: T.machineTab, machine: { authorized: false, mode: 'all', selected: [], groups: [], total: 0 } });
    expect(machine).toContain(T.machineManagerOnly);
    expect(machine).toContain(T.machineAskManager);
    const list = render({
      ...CATALOG_ADMIN_FIXTURE,
      panel: 'till',
      machine: { authorized: true, mode: 'selected', selected: ['p1'], groups: [{ categoryId: 'c-main', name: 'מנות עיקריות', products: [{ id: 'p1', name: 'המבורגר', code: '729', locked: true }] }], total: 1 },
    });
    for (const w of [T.machineModeSelected, '1 מתוך 1 מוצרים', 'מנות עיקריות  1/1', T.machineLocked, T.machineSave]) expect(list).toContain(w);
  });
});
