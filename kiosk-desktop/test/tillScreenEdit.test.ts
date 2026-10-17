/**
 * "עריכת מסך" (core/till/screenEdit.ts, main/till/tillScreenEdit.ts, parts/ScreenEditOverlay.tsx, ProductGrid's `arrange`):
 * the Android rules (domain/ProductOrder.kt, ui/sell/ArrangeMode.kt, SellViewModel finishArrange / setProductLocked) — the
 * shared "סדר תצוגה" golden's mergeShown cases pinned byte-for-byte, the service through the engine harness (a manager at
 * once, a cashier with a manager's code, where "סיום" saves, the notices, ✕ / +), and the markup.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCREEN_EDIT_TEXT,
  arrangeCatalog,
  doneScope,
  lockBody,
  lockNotice,
  mergeShownOrder,
  moveAmongShown,
  moveCategory,
  onUnlessFalse,
  orderBy,
  parseOrder,
  parseOrderScope,
  saveNotice,
  scopeChoices,
  screenEditEnabled,
  writeOutcome,
  type ScreenEditState,
} from '../src/core/till/screenEdit';
import { TillScreenEdit } from '../src/main/till/tillScreenEdit';
import { ProductGrid, arrangeTap } from '../src/renderer/roles/till/parts/ProductGrid';
import { ScreenEditBar, ScreenEditCategoryRow } from '../src/renderer/roles/till/parts/ScreenEditOverlay';
import type { Catalog, EngineDialog, TillOp } from '../src/shared/till/protocol';
import { MACHINE, MANAGER_PIN, PIN, harness, type Harness, type HarnessOptions } from './tillEngineHarness';

const GOLDEN_FILE = path.join(__dirname, 'fixtures/display_ordering_golden.json');
/** pos-server tests/test_display_ordering.py GOLDEN_SHA256 (LF bytes). */
const GOLDEN_SHA256 = '38b577d103c821bbb1480e4f2d6d7d90652e7fbd367dff81acf2fa81bb872446';

/* ------------------------------------------------------------------ the golden */

describe('the shared "סדר תצוגה" golden', () => {
  const raw = readFileSync(GOLDEN_FILE).toString('utf8').replace(/\r\n/g, '\n');
  it('is the same bytes as pos-server', () => {
    expect(createHash('sha256').update(raw, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
  });
  it('mergeShown: the buttons on screen take their places in the whole order', () => {
    const cases = (JSON.parse(raw) as { mergeShown: Array<{ full: string[]; shown: string[]; expect: string[] }> }).mergeShown;
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) expect(mergeShownOrder(c.full, c.shown)).toEqual(c.expect);
  });
});

/* ------------------------------------------------------------------ the rules */

describe('core/till/screenEdit', () => {
  it('Android words, word for word', () => {
    expect(SCREEN_EDIT_TEXT.title).toBe('עריכת מסך');
    expect(SCREEN_EDIT_TEXT.doneSave).toBe('שמור');
    expect(SCREEN_EDIT_TEXT.needsManager).toBe('שמירה מהקופה דורשת מנהל או אישור מנהל.');
    expect(SCREEN_EDIT_TEXT.offline).toBe('אין חיבור לענן — הסידור לא נשמר. נסו שוב כשהחיבור יחזור.');
    expect(SCREEN_EDIT_TEXT.removeTitle('קולה')).toBe('להפוך את “קולה” ללא פעיל?');
    expect(SCREEN_EDIT_TEXT.removeIn(SCREEN_EDIT_TEXT.scopeShop)).toBe('ללא פעיל בכל הסניף');
    expect(SCREEN_EDIT_TEXT.restoreIn(SCREEN_EDIT_TEXT.scopeMachine)).toBe('פעיל שוב בקופה הזו');
    expect(SCREEN_EDIT_TEXT.saveFor(SCREEN_EDIT_TEXT.scopeArea)).toBe('לשמור בנקודת המכירה');
    expect(SCREEN_EDIT_TEXT.locked('קולה')).toBe('קולה ננעל למכירה.');
  });

  it('"עריכת מסך בקופה" is on unless the cloud says false', () => {
    expect(screenEditEnabled({})).toBe(true);
    expect(screenEditEnabled({ screenEditEnabled: 'true' })).toBe(true);
    for (const off of [false, 'false', ' FALSE ', '0', 0, 'לא', 'no']) expect(onUnlessFalse(off)).toBe(false);
  });

  it('productOrderScope: the Hebrew options or the codes; unset — the shop; a point of sale without one asks', () => {
    expect(parseOrderScope(undefined)).toBe('shop');
    expect(parseOrderScope('נקודת מכירה')).toBe('area');
    expect(parseOrderScope('קופה')).toBe('machine');
    expect(parseOrderScope('לשאול בקופה')).toBe('ask');
    expect(parseOrderScope('machine')).toBe('machine');
    expect(doneScope('area', false)).toBe('ask');
    expect(doneScope('area', true)).toBe('area');
    expect(scopeChoices(false).map((c) => c.scope)).toEqual(['machine', 'shop']);
    expect(scopeChoices(true).map((c) => c.label)).toEqual(['בקופה הזו', 'בנקודת המכירה', 'בכל הסניף']);
  });

  it('a stored list: JSON, the sync\'s [a,b,c], or none', () => {
    expect(parseOrder(['a', 'b', 'a', ''])).toEqual(['a', 'b']);
    expect(parseOrder('[a, b,"c"]')).toEqual(['a', 'b', 'c']);
    expect(parseOrder('["x","y"]')).toEqual(['x', 'y']);
    expect(parseOrder('a,b')).toEqual([]);
    expect(parseOrder(null)).toEqual([]);
  });

  it('orderBy: listed first, the rest after as they came (stable)', () => {
    expect(orderBy(['a', 'b', 'c', 'd'], ['c', 'x', 'a'], (x) => x)).toEqual(['c', 'a', 'b', 'd']);
    expect(orderBy(['a'], ['b'], (x) => x)).toEqual(['a']);
  });

  it('a tile dropped among those on screen; a category on another', () => {
    expect(moveAmongShown(['a', 'b', 'c', 'd'], ['b', 'd'], 'd', 'b')).toEqual(['a', 'd', 'c', 'b']);
    expect(moveAmongShown(['a', 'b'], ['a', 'b'], 'a', 'a')).toBeNull();
    expect(moveAmongShown(['a', 'b'], ['a'], 'a', 'b')).toBeNull();
    expect(moveCategory(['x', 'y', 'z'], 'z', 'x')).toEqual(['z', 'x', 'y']);
  });

  it('arrangeCatalog: the order laid over the snapshot; departments keep their colours', () => {
    const cat: Catalog = {
      version: 1,
      departments: [
        { id: 'c1', name: 'מנות', color: '#111111' },
        { id: 'c2', name: 'שתייה', color: '#222222' },
      ],
      products: [
        { id: 'p1', departmentId: 'c1', name: 'א', priceAgorot: 100 },
        { id: 'p2', departmentId: 'c2', name: 'ב', priceAgorot: 100 },
        { id: 'p3', departmentId: 'c1', name: 'ג', priceAgorot: 100 },
      ],
    };
    expect(arrangeCatalog(cat, null)).toBe(cat);
    const out = arrangeCatalog(cat, { productIds: ['p3', 'p1'], categoryIds: ['c2'] });
    expect(out.products.map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    expect(out.departments).toEqual([
      { id: 'c2', name: 'שתייה', color: '#222222' },
      { id: 'c1', name: 'מנות', color: '#111111' },
    ]);
    expect(arrangeCatalog(cat, { productIds: null, categoryIds: ['c2'] }).products).toBe(cat.products);
  });

  it('the answers and their notices', () => {
    expect(writeOutcome({ kind: 'ok' })).toBe('ok');
    expect(writeOutcome({ kind: 'offline' })).toBe('offline');
    expect(writeOutcome({ kind: 'refused', status: 403 })).toBe('manager');
    expect(writeOutcome({ kind: 'refused', status: 404 })).toBe('missing');
    expect(saveNotice('ok')).toBeNull();
    expect(saveNotice('manager')).toBe(SCREEN_EDIT_TEXT.needsManager);
    expect(saveNotice('refused')).toBe(SCREEN_EDIT_TEXT.offline);
    expect(lockNotice('ok', 'קולה', false)).toBe('הנעילה של קולה שוחררה.');
    expect(lockNotice('refused', 'קולה', true)).toBe('הענן לא אישר את שינוי הנעילה של קולה, והמוצר הוחזר למצבו בענן.');
    expect(lockNotice('offline', 'קולה', true)).toBe('לא ניתן היה לשנות את הנעילה של קולה.');
    expect(lockBody('area', true)).toEqual({ scope: 'area', active: false });
    expect(lockBody('machine', false)).toEqual({ scope: 'machine', active: null });
  });

  it('a tap while arranging: pick, place, let go', () => {
    expect(arrangeTap(null, 'a')).toEqual({ picked: 'a', move: null });
    expect(arrangeTap('a', 'a')).toEqual({ picked: null, move: null });
    expect(arrangeTap('a', 'b')).toEqual({ picked: null, move: ['a', 'b'] });
  });
});

/* ------------------------------------------------------------------ the service */

const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

let h: Harness | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});

async function signedIn(pin: string, o: HarnessOptions = {}) {
  const x = harness(o);
  h = x;
  const f = x.engine.register(new TillScreenEdit(x.engine.ctx));
  await x.ok('session.login', { pin });
  return { h: x, f };
}

const op = (name: string) => name as TillOp;
const se = (x: Harness) => (x.state() as unknown as Record<string, unknown>).screenEdit as ScreenEditState | undefined;
const dialog = (x: Harness) => x.state().dialog as EngineDialog;
const snapshotIds = async (x: Harness, f: TillScreenEdit) => arrangeCatalog(await x.ok<Catalog>('catalog.snapshot'), f.overlay()).products.map((p) => p.id);

describe('TillScreenEdit', () => {
  it('nobody signed in: no state', () => {
    h = harness();
    h.engine.register(new TillScreenEdit(h.engine.ctx));
    expect((h.state() as unknown as Record<string, unknown>).screenEdit).toBeUndefined();
  });

  it('a manager arranges at once; "שמור" saves at the shop; shown at once, then the settings bring it back', async () => {
    let saved: string[] = [];
    const { h: x, f } = await signedIn(MANAGER_PIN, {
      answers: {
        'PUT sync/m/product-order': (b) => {
          saved = (b?.productIds as string[]) ?? [];
          return { scope: b?.scope, count: saved.length };
        },
        'GET sync/m/settings*': () => ({ syncType: 'full', settings: { globalTaxRate: 18, productOrder: saved }, businessInfo: null, settingsUpdatedAt: '2026-10-17T10:00:00Z' }),
      },
    });
    expect(se(x)).toMatchObject({ available: true, on: false, dirty: false });
    await x.ok(op('screenEdit.start'));
    expect(se(x)).toMatchObject({ on: true, dirty: false });
    const before = await snapshotIds(x, f);
    expect(before).toEqual(['p-burger', 'p-pos', 'p-cola']);
    const v0 = f.rev();
    await x.ok(op('screenEdit.move'), { fromId: 'p-cola', toId: 'p-burger', shown: before });
    expect(f.rev()).toBeGreaterThan(v0);
    expect(se(x)?.dirty).toBe(true);
    expect(await snapshotIds(x, f)).toEqual(['p-cola', 'p-burger', 'p-pos']);
    await x.ok(op('screenEdit.done'));
    await settle();
    const put = x.sent.find((s) => s.method === 'PUT' && s.path === 'sync/m/product-order');
    expect(put?.body).toEqual({ scope: 'shop', productIds: ['p-cola', 'p-burger', 'p-pos'] });
    expect(se(x)).toMatchObject({ on: false, saving: false, dirty: false });
    // The settings came back with it: the catalog itself is built in that order now, nothing laid over it.
    expect(x.sent.some((s) => s.method === 'GET' && s.path.startsWith('sync/m/settings'))).toBe(true);
    expect(f.overlay()).toBeNull();
    expect((await x.ok<Catalog>('catalog.snapshot')).products.map((p) => p.id)).toEqual(['p-cola', 'p-burger', 'p-pos']);
  });

  it('a product moved inside one category keeps the others in their places', async () => {
    const { h: x, f } = await signedIn(MANAGER_PIN);
    await x.ok(op('screenEdit.start'));
    // "מנות" on screen: p-burger, p-pos (p-cola elsewhere).
    await x.ok(op('screenEdit.move'), { fromId: 'p-pos', toId: 'p-burger', shown: ['p-burger', 'p-pos'] });
    expect(await snapshotIds(x, f)).toEqual(['p-pos', 'p-burger', 'p-cola']);
    await x.ok(op('screenEdit.moveCategory'), { fromId: 'c-drink', toId: 'c-main' });
    const snap = arrangeCatalog(await x.ok<Catalog>('catalog.snapshot'), f.overlay());
    expect(snap.departments.map((d) => d.id)).toEqual(['c-drink', 'c-main']);
  });

  it('a cashier: a manager\'s code opens it, and the manager is the one the cloud hears', async () => {
    const { h: x } = await signedIn(PIN);
    const r = await x.ok<{ dialogId: string }>(op('screenEdit.start'));
    expect(r.dialogId).toBeTruthy();
    expect(dialog(x)).toMatchObject({ kind: 'manager_approval', title: 'עריכת מסך', body: 'עריכת מסך הקופה — סידור פריטים' });
    expect(se(x)?.on).toBe(false);
    await x.ok('dialog.answer', { dialogId: r.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(se(x)?.on).toBe(true);
  });

  it('"לשאול בקופה": the till asks where; no point of sale — this till or the shop', async () => {
    const { h: x } = await signedIn(MANAGER_PIN, { parameters: { productOrderScope: 'לשאול בקופה' }, answers: { 'PUT sync/m/product-order': () => ({ scope: 'machine', count: 0 }) } });
    await x.ok(op('screenEdit.start'));
    await x.ok(op('screenEdit.moveCategory'), { fromId: 'c-drink', toId: 'c-main' });
    await x.ok(op('screenEdit.done'));
    const d = dialog(x);
    expect(d.title).toBe('איפה לשמור את סידור הפריטים?');
    expect(d.actions.map((a) => a.label)).toEqual(['לשמור בכל הסניף', 'לשמור בקופה הזו', 'ביטול']);
    await x.ok('dialog.answer', { dialogId: d.id, action: 'machine', answers: {} });
    await settle();
    expect(x.sent.find((s) => s.path === 'sync/m/product-order')?.body).toEqual({ scope: 'machine', categoryIds: ['c-drink', 'c-main'] });
  });

  it('a till in a point of sale: "נקודת מכירה" is offered', async () => {
    const { h: x } = await signedIn(MANAGER_PIN, { parameters: { productOrderScope: 'ask' } });
    x.svc.cloud.setMachine({ ...x.svc.cloud.machine()!, machineId: MACHINE, area: { id: 'a-1', name: 'בר' } });
    await x.ok(op('screenEdit.start'));
    await x.ok(op('screenEdit.moveCategory'), { fromId: 'c-drink', toId: 'c-main' });
    await x.ok(op('screenEdit.done'));
    expect(dialog(x).actions.map((a) => a.id)).toEqual(['shop', 'area', 'machine', 'cancel']);
  });

  it('nothing moved: "סיום" just leaves', async () => {
    const { h: x } = await signedIn(MANAGER_PIN);
    await x.ok(op('screenEdit.start'));
    await x.ok(op('screenEdit.done'));
    expect(se(x)?.on).toBe(false);
    expect(x.sent.some((s) => s.path === 'sync/m/product-order')).toBe(false);
  });

  it('offline / refused: Android\'s notice, and the arrangement stays open', async () => {
    const { h: x } = await signedIn(MANAGER_PIN, { answers: { 'PUT sync/m/product-order': () => ({ __status: 503 }) } });
    await x.ok(op('screenEdit.start'));
    await x.ok(op('screenEdit.moveCategory'), { fromId: 'c-drink', toId: 'c-main' });
    await x.ok(op('screenEdit.done'));
    await settle();
    expect(dialog(x)).toMatchObject({ title: 'עריכת מסך', body: SCREEN_EDIT_TEXT.offline });
    expect(se(x)).toMatchObject({ on: true, saving: false, dirty: true });
  });

  it('401: "שמירה מהקופה דורשת מנהל"', async () => {
    const { h: x } = await signedIn(MANAGER_PIN, { answers: { 'PUT sync/m/product-order': () => ({ __status: 401, detail: 'elevation_required' }) } });
    await x.ok(op('screenEdit.start'));
    await x.ok(op('screenEdit.moveCategory'), { fromId: 'c-drink', toId: 'c-main' });
    await x.ok(op('screenEdit.done'));
    await settle();
    expect(dialog(x).body).toBe(SCREEN_EDIT_TEXT.needsManager);
  });

  it('an older cloud (404): the row goes', async () => {
    const { h: x } = await signedIn(MANAGER_PIN);
    await x.ok(op('screenEdit.start'));
    await x.ok(op('screenEdit.moveCategory'), { fromId: 'c-drink', toId: 'c-main' });
    await x.ok(op('screenEdit.done'));
    await settle();
    expect(se(x)).toMatchObject({ available: false, on: false });
    expect((await x.fail(op('screenEdit.start'))).code).toBe('invalid_args');
  });

  it('"עריכת מסך בקופה" off in the cloud: not offered, not opened', async () => {
    const { h: x } = await signedIn(MANAGER_PIN, { parameters: { screenEditEnabled: 'false' } });
    expect(se(x)?.available).toBe(false);
    expect((await x.fail(op('screenEdit.start'))).code).toBe('invalid_args');
  });

  it('✕: where — then the availability write, a full catalog pull and the notice', async () => {
    const { h: x } = await signedIn(MANAGER_PIN, { answers: { 'PUT sync/m/products/p-cola/availability': () => ({ id: 'p-cola', scope: 'machine', active: false, effectiveActive: false }) } });
    await x.ok(op('screenEdit.start'));
    await x.ok(op('screenEdit.lock'), { productId: 'p-cola', locked: true });
    const d = dialog(x);
    expect(d.title).toBe('להפוך את “קולה” ללא פעיל?');
    expect(d.body).toBe(SCREEN_EDIT_TEXT.removeBody);
    expect(d.actions.map((a) => a.label)).toEqual(['ללא פעיל בקופה הזו', 'ללא פעיל בכל הסניף', 'ביטול']);
    await x.ok('dialog.answer', { dialogId: d.id, action: 'machine', answers: {} });
    await settle();
    expect(x.sent.find((s) => s.method === 'PUT' && s.path === 'sync/m/products/p-cola/availability')?.body).toEqual({ scope: 'machine', active: false });
    expect(x.sent.some((s) => s.method === 'GET' && s.path === 'sync/m/catalog')).toBe(true);
    expect(dialog(x)).toMatchObject({ title: 'נעילת מוצר', body: 'קולה ננעל למכירה.' });
    expect(se(x)?.lockBusy).toBeNull();
  });

  it('+ releases this level (active: null); outside the edit mode — refused', async () => {
    const { h: x } = await signedIn(MANAGER_PIN, { answers: { 'PUT sync/m/products/*': () => ({}) } });
    expect((await x.fail(op('screenEdit.lock'), { productId: 'p-cola', locked: false })).code).toBe('invalid_args');
    await x.ok(op('screenEdit.start'));
    await x.ok(op('screenEdit.lock'), { productId: 'p-cola', locked: false });
    expect(dialog(x).title).toBe('להפעיל שוב את “קולה”?');
    await x.ok('dialog.answer', { dialogId: dialog(x).id, action: 'shop', answers: {} });
    await settle();
    expect(x.sent.find((s) => s.method === 'PUT')?.body).toEqual({ scope: 'shop', active: null });
  });

  it('bad args are refused; signing out drops an unsaved arrangement', async () => {
    const { h: x, f } = await signedIn(MANAGER_PIN);
    await x.ok(op('screenEdit.start'));
    expect((await x.fail(op('screenEdit.move'), { fromId: 'p-cola', toId: 'p-burger' })).code).toBe('invalid_args');
    expect((await x.fail(op('screenEdit.lock'), { productId: 'nope', locked: true })).code).toBe('invalid_args');
    await x.ok(op('screenEdit.moveCategory'), { fromId: 'c-drink', toId: 'c-main' });
    await x.ok('session.logout');
    expect(se(x)).toBeUndefined();
    expect(f.overlay()).toBeNull();
  });
});

/* ------------------------------------------------------------------ the markup */

describe('the edit mode on screen', () => {
  const view: ScreenEditState = { available: true, on: true, saving: false, dirty: false, lockBusy: null };
  const noop = () => undefined;

  it('the bar: "ביטול", the title and hint, "סיום" — "שמור" once something moved', () => {
    const html = renderToStaticMarkup(createElement(ScreenEditBar, { view, actions: { done: noop, cancel: noop } }));
    expect(html).toContain('עריכת מסך');
    expect(html).toContain(SCREEN_EDIT_TEXT.hint);
    expect(html).toContain('>סיום<');
    expect(html).toContain('>ביטול<');
    expect(renderToStaticMarkup(createElement(ScreenEditBar, { view: { ...view, dirty: true }, actions: { done: noop, cancel: noop } }))).toContain('>שמור<');
    expect(renderToStaticMarkup(createElement(ScreenEditBar, { view: { ...view, saving: true }, actions: { done: noop, cancel: noop } }))).toContain('disabled');
  });

  it('the category row: the hint, "הכל", the categories to drag', () => {
    const html = renderToStaticMarkup(
      createElement(ScreenEditCategoryRow, {
        departments: [
          { id: 'c1', name: 'מנות', color: '#111111' },
          { id: 'c2', name: 'שתייה', color: '#222222' },
        ],
        selectedId: 'c2',
        allLabel: 'הכל',
        onSelect: noop,
        onMove: noop,
      }),
    );
    expect(html).toContain('החזיקו מחלקה וגררו אותה למקומה');
    expect(html).toContain('data-cid="c1"');
    expect(html).toMatch(/data-cid="c2"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-cid="c2"/);
  });

  it('the tiles: ✕ on an active one, + on an inactive one, no "i"', () => {
    const html = renderToStaticMarkup(
      createElement(ProductGrid, {
        products: [
          { id: 'p1', departmentId: 'c1', name: 'המבורגר', priceAgorot: 4200, description: 'בשר' },
          { id: 'p2', departmentId: 'c1', name: 'קולה', priceAgorot: 1250, sale: 'unavailable' },
        ],
        departments: [{ id: 'c1', name: 'מנות', color: '#111111' }],
        columns: 4,
        tileHeight: 96,
        onAdd: noop,
        onInfo: noop,
        tileText: { fit: 'fit', maxLines: 3, minSize: 'm', infoBadge: 'always' },
        arrange: { onMove: noop, onLock: noop, busyId: null },
      }),
    );
    expect(html).toContain('data-pid="p1"');
    expect(html).toContain('aria-label="להפוך את “המבורגר” ללא פעיל?"');
    expect(html).toContain('aria-label="להפעיל שוב את “קולה”?"');
    expect(html).toContain('>✕<');
    expect(html).toContain('>+<');
    expect(html).not.toContain('t-tile-info');
  });
});
