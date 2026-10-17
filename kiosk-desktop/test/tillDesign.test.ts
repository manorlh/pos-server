/**
 * "עיצוב קופה" on the Windows till: the pull (main/till/tillDesign.ts — ETag, 304, 404, offline, a restart offline), its
 * place on the parameters' cadence and in the engine's state, and the view the screens draw (core/till/tillDesign.ts —
 * the till parameters' "auto", the bar, `look`, the fields over the order's details, what Windows does not honour yet,
 * the demo's query).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { resolveTillDesign } from '@dash-lib/tillDesign';
import type { ApiReply, RequestOptions } from '../src/main/sync/api';
import { TillDesignService, type TillDesignDeps } from '../src/main/till/tillDesign';
import {
  configOf,
  defaultDesignState,
  demoDesignConfig,
  designFor,
  designParameters,
  designState,
  lookOf,
  themeOf,
  tillDesignProfileOf,
  withTotal,
  type StoredTillDesign,
} from '../src/core/till/tillDesign';
import { orderQuestionsOf } from '../src/core/till/orderDetails';
import { MockTillEngine } from '../src/shared/till/mockEngine';
import { harness, type Harness } from './tillEngineHarness';

const M = 'machine-1';

function bundle(over: Record<string, unknown> = {}, prefix = '') {
  const config = resolveTillDesign(over);
  return { schemaVersion: 1, configVersion: `v-${JSON.stringify(over).length}`, config, updatedAt: '2026-10-17T10:00:00Z', orderNumberPrefix: prefix };
}

type Answer = ApiReply<unknown>;
const ok = (body: unknown, etag: string | null = '"e1"'): Answer => ({ kind: 'ok', status: 200, body, headers: new Headers(etag ? { ETag: etag } : {}) });
const notModified = (): Answer => ({ kind: 'ok', status: 304, body: null, headers: new Headers() });
const refused = (status: number): Answer => ({ kind: 'refused', status, body: null, detail: null, headers: new Headers() });
const offline = (): Answer => ({ kind: 'offline', reason: 'TypeError: fetch failed' });

/** A service over an in-memory store and a scripted cloud. */
function rig(answers: Answer[], store: { v: StoredTillDesign | null } = { v: null }) {
  const calls: Array<{ path: string; opts?: RequestOptions }> = [];
  const logs: string[] = [];
  let changed = 0;
  const deps: TillDesignDeps = {
    api: {
      get: async <T,>(path: string, opts?: RequestOptions) => {
        calls.push({ path, opts });
        return (answers.shift() ?? offline()) as ApiReply<T>;
      },
    },
    machineId: () => M,
    read: () => store.v,
    write: (v) => {
      store.v = v;
    },
    changed: () => {
      changed += 1;
    },
    log: (m) => logs.push(m),
  };
  return { svc: new TillDesignService(deps), calls, logs, store, changes: () => changed };
}

describe('the pull (Android TillDesignRepository.pull)', () => {
  it('asks for everything when nothing is held, keeps the bundle and its ETag, then sends If-None-Match', async () => {
    const r = rig([ok(bundle({ template: 'night' }, '2'), '"abc"'), notModified()]);
    expect(await r.svc.pull()).toBe('stored');
    expect(r.calls[0].path).toBe(`sync/${M}/till-design`);
    expect(r.calls[0].opts?.headers).toEqual({});
    expect(r.store.v?.etag).toBe('"abc"');
    expect(r.store.v?.orderNumberPrefix).toBe('2');
    expect(r.store.v?.configVersion).toMatch(/^v-/);
    expect(r.changes()).toBe(1);
    expect(r.svc.config().template).toBe('night');
    // 304: the held one is current, nothing changes.
    expect(await r.svc.pull()).toBe('current');
    expect(r.calls[1].opts?.headers).toEqual({ 'If-None-Match': '"abc"' });
    expect(r.changes()).toBe(1);
    expect(r.svc.config().template).toBe('night');
  });

  it('404 (a cloud from before the endpoint): what is held stays, quietly', async () => {
    const r = rig([refused(404)]);
    expect(await r.svc.pull()).toBe('no_endpoint');
    expect(r.store.v).toBeNull();
    expect(r.logs).toEqual([]);
    expect(r.svc.config()).toEqual(resolveTillDesign());
    const held = rig([ok(bundle({ template: 'fast' })), refused(404)]);
    await held.svc.pull();
    expect(await held.svc.pull()).toBe('no_endpoint');
    expect(held.svc.config().template).toBe('fast');
  });

  it('offline or refused: the held one stays; the cause logged once', async () => {
    const r = rig([ok(bundle({ template: 'touch' })), offline(), offline(), refused(500)]);
    await r.svc.pull();
    expect(await r.svc.pull()).toBe('offline');
    expect(await r.svc.pull()).toBe('offline');
    expect(await r.svc.pull()).toBe('refused');
    expect(r.svc.config().template).toBe('touch');
    expect(r.logs.filter((l) => l.includes('offline'))).toHaveLength(1);
    expect(r.logs.filter((l) => l.includes('HTTP 500'))).toHaveLength(1);
  });

  it('an answer without a config changes nothing', async () => {
    const r = rig([ok({ schemaVersion: 1 })]);
    expect(await r.svc.pull()).toBe('refused');
    expect(r.store.v).toBeNull();
  });

  it('the same bundle again is not a change; one pull at a time', async () => {
    const b = bundle({ template: 'visual' });
    const r = rig([ok(b, '"x"'), ok(b, '"x"')]);
    const [a, again] = await Promise.all([r.svc.pull(), r.svc.pull()]);
    expect([a, again]).toEqual(['stored', 'stored']);
    expect(r.calls).toHaveLength(1);
    expect(await r.svc.pull()).toBe('current');
    expect(r.changes()).toBe(1);
  });

  it('works offline from the store after a restart', async () => {
    const store = { v: null as StoredTillDesign | null };
    const first = rig([ok(bundle({ template: 'payDock', orderNumber: { atOpen: true } }, '7'))], store);
    await first.svc.pull();
    // The next start: no cloud at all.
    const next = rig([], store);
    expect(next.svc.config().template).toBe('payDock');
    const s = next.svc.state({ parameters: {}, tenders: { fastCard: true, fastCash: true, cash: true }, presets: null, totalAgorot: 11_720 });
    expect(s.profiles.tabletLandscape.template).toBe('payDock');
    expect(s.orderNumber).toEqual({ atOpen: true, prefix: '7' });
    expect(s.quickCash.offered).toEqual([120, 150, 200]);
    expect(next.calls).toHaveLength(0);
  });

  it('caches the view on the config and the parameters; the banknotes follow the total', () => {
    const r = rig([]);
    const params = {};
    const inputs = { parameters: params, tenders: { fastCard: true, fastCash: true, cash: true }, presets: null, totalAgorot: 0 };
    const a = r.svc.state(inputs);
    expect(r.svc.state(inputs)).toBe(a);
    const b = r.svc.state({ ...inputs, totalAgorot: 4_250 });
    expect(b.quickCash.offered).toEqual([50, 60, 100]);
    expect(b.profiles).toBe(a.profiles);
    expect(withTotal(b, 4_250)).toBe(b);
  });
});

describe('the engine: the pull on the parameters\' cadence, the state, a reset', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.stop();
    h = null;
  });

  it('pulls with the parameters and draws what it holds; 404 leaves the defaults', async () => {
    h = harness();
    await h.svc.sync.pulls();
    expect(h.sent.some((s) => s.method === 'GET' && s.path === 'sync/m/till-design')).toBe(true);
    const idx = h.sent.findIndex((s) => s.path === 'sync/m/till-design');
    expect(h.sent.findIndex((s) => s.path === 'sync/m/parameters')).toBeLessThan(idx);
    expect(h.state().design?.configVersion).toBeNull();
    expect(h.state().design?.profiles.tabletLandscape.template).toBe('clean');
  });

  it('a bundle reaches the state, the tile text and the order\'s details; a full reset forgets it', async () => {
    const cfg = bundle({ template: 'night', look: { productNameFit: 'wrap', productNameMaxLines: 2 }, fields: { customerName: 'required' } });
    h = harness({ parameters: { productNameFit: 'clip', askOrderName: false }, answers: { 'GET sync/m/till-design': () => cfg } });
    expect(await h.engine.design.pull()).toBe('stored');
    const s = h.state();
    expect(s.design?.configVersion).toBe(cfg.configVersion);
    expect(s.design?.profiles.tabletLandscape.template).toBe('night');
    expect(s.design?.profiles.tabletLandscape.textSize).toBe('large');
    expect(s.tileText).toEqual({ fit: 'wrap', maxLines: 2, minSize: 's', infoBadge: 'auto' });
    expect(s.design?.look).toEqual(s.tileText);
    expect(s.design?.fields.customerName).toBe('required');
    // night: the accent unset — the settings' brand colour; mode "auto" — the parameter's (none: the system's).
    expect(s.theme).toEqual({ brand: null, mode: 'system', textColor: null });
    // The till kept it where the cloud's copies are: a new engine over the same service reads it offline.
    expect(h.svc.cloud.tillDesign()?.configVersion).toBe(cfg.configVersion);
    h.svc.cloud.setTillDesign(null);
    expect(h.engine.design.config().template).toBe('clean');
  });
});

describe('the view (core/till/tillDesign.ts)', () => {
  it('settles "auto" by the till parameters: tile sizes, the bar, the fields, the dietary words', () => {
    const s = designState(resolveTillDesign(), {
      parameters: { productTileSize: 'קטן', productTileSizeTablet: 'גדול', quickPayButton1: 'מזומן מהיר', askEatInTakeAway: true, showDietaryMarks: true },
    });
    expect(s.profiles.handheld.tileSize).toBe('s');
    expect(s.profiles.tabletLandscape.tileSize).toBe('l');
    expect(s.profiles.tabletPortrait.tileSize).toBe('l');
    expect(s.profiles.tabletLandscape.actionBar.map((a) => a.action)).toEqual(['fastCash', 'cashWithChange', 'pay']);
    expect(s.fields).toEqual({ customerName: 'off', serviceType: 'required', guests: 'off' });
    expect(s.visual.dietary).toBe('show');
    // The design's own wins over the parameters.
    const own = designState(resolveTillDesign({ layout: { tileSize: 'xs' }, fields: { serviceType: 'optional' } }), { parameters: { productTileSize: 'גדול', askEatInTakeAway: true } });
    expect(own.profiles.handheld.tileSize).toBe('xs');
    expect(own.fields.serviceType).toBe('optional');
  });

  it('the bar: tenders not taken left off, a preset only if the till has it, labels', () => {
    const cfg = resolveTillDesign({
      actionBar: {
        quick: [
          { action: 'fastCard', label: '' },
          { action: 'discount', label: '', presetId: 'p-staff' },
          { action: 'discount', label: 'VIP', presetId: 'p-vip' },
          { action: 'discount', label: '', presetId: 'p-gone' },
          { action: 'cashNotes', label: '' },
          { action: 'pay', label: 'סיום' },
        ],
      },
    });
    const presets = [
      { id: 'p-staff', name: 'הנחת עובד' },
      { id: 'p-vip', name: 'אורח' },
    ];
    const bar = designState(cfg, { parameters: {}, tenders: { fastCard: false, fastCash: true, cash: true }, presets }).profiles.tabletLandscape.actionBar;
    expect(bar).toEqual([
      { action: 'discount', label: 'הנחת עובד', primary: false, presetId: 'p-staff' },
      { action: 'discount', label: 'VIP', primary: false, presetId: 'p-vip' },
      { action: 'cashNotes', label: 'שטרות', primary: false },
      { action: 'pay', label: 'סיום', primary: true },
    ]);
    // Presets not known (the demo): kept, the discount's own word.
    const unknown = designState(cfg, { parameters: {}, presets: null }).profiles.handheld.actionBar;
    expect(unknown.filter((a) => a.presetId).map((a) => a.label)).toEqual(['הנחה', 'VIP', 'הנחה']);
  });

  it('a profile\'s own bar and template', () => {
    const cfg = resolveTillDesign({ template: 'touch', profiles: { handheld: { template: 'mobile', actionBar: { quick: [{ action: 'hold', label: '' }, { action: 'pay', label: '' }] } } } });
    const s = designState(cfg, { parameters: {} });
    expect(s.profiles.handheld.template).toBe('mobile');
    expect(s.profiles.handheld.actionBar.map((a) => a.action)).toEqual(['hold', 'pay']);
    expect(s.profiles.tabletLandscape.template).toBe('touch');
    expect(designFor(s, tillDesignProfileOf(390, 844)).summaryCollapsible).toBe(true);
    expect(designFor(s, tillDesignProfileOf(1366, 768)).tileStyle).toBe('photo');
  });

  it('look over the parameters (Android TillDesignLook): a code wins, "base" / unknown leaves the parameter\'s', () => {
    const params = { productNameFit: 'clip', productNameMaxLines: '4', productInfoBadge: 'off' };
    expect(lookOf(params, null)).toEqual({ fit: 'clip', maxLines: 4, minSize: 's', infoBadge: 'off' });
    expect(lookOf(params, { look: { productNameFit: 'fit', productNameMaxLines: 'base', productNameMinTextSize: 'L', productInfoBadge: 'sometimes' } })).toEqual({
      fit: 'fit',
      maxLines: 4,
      minSize: 'l',
      infoBadge: 'off',
    });
    expect(designParameters(params, resolveTillDesign())).toBe(params);
  });

  it('fields over the order\'s details (Android applyTillDesign)', () => {
    const params = { askOrderName: true, askEatInTakeAway: 'true' };
    expect(orderQuestionsOf(designParameters(params, resolveTillDesign())).name).toBe(true);
    const off = designParameters(params, resolveTillDesign({ fields: { customerName: 'optional', serviceType: 'off' } }));
    expect(orderQuestionsOf(off)).toMatchObject({ name: false, dining: false });
    expect(params.askOrderName).toBe(true);
    expect(orderQuestionsOf(designParameters({}, resolveTillDesign({ fields: { customerName: 'required' } }))).name).toBe(true);
  });

  it('names what the Windows till cannot honour yet — only what is set', () => {
    expect(defaultDesignState().unsupported).toEqual([]);
    const cfg = resolveTillDesign({
      template: 'seated',
      profiles: { handheld: { template: 'courses' } },
      actionBar: { table: [{ action: 'send', label: '' }], quick: [{ action: 'customer', label: '' }, { action: 'pay', label: '' }] },
      fields: { guests: 'required' },
      tables: { mapStyle: 'modern' },
      courses: { fireGapMinutes: 10 },
      orderNumber: { atOpen: true },
      flow: { shell: 'flow', home: 'tables', firstStep: 'table', askGuests: 'always' },
      motion: { preset: 'standard' },
    });
    const s = designState(cfg, { parameters: {} });
    expect(s.unsupported).toEqual([
      'actionBar.quick.customer',
      'actionBar.table',
      'courses.fireGapMinutes',
      'features.courseLanes',
      'features.seatCards',
      'fields.guests',
      'flow.askGuests',
      'flow.firstStep',
      'flow.home',
      'motion',
      'orderNumber.atOpen',
      'tables.mapStyle',
      'template.courses',
    ]);
    // The courses' handheld draws clean; seats are a table's — left out of the features.
    expect(s.profiles.handheld.drawn).toBe('clean');
    expect(s.profiles.tabletLandscape.features).toEqual([]);
    expect(s.profiles.tabletLandscape.shell).toBe('flow');
    expect(designState(resolveTillDesign({ motion: { preset: 'none' } }), { parameters: {} }).unsupported).toEqual([]);
  });

  it('colours: a hex accent, else the brand\'s (null)', () => {
    expect(designState(resolveTillDesign({ colors: { accent: '#E11D48', mode: 'dark' } }), { parameters: {} }).colors).toEqual({ accent: '#E11D48', mode: 'dark' });
    expect(designState(resolveTillDesign({ colors: { accent: 'brand' } }), { parameters: {} }).colors.accent).toBeNull();
  });

  it("the theme: the design's accent over brandPrimaryColor, its light / dark over themeMode, textColor", () => {
    const plain = resolveTillDesign();
    expect(themeOf(plain, {}, {})).toEqual({ brand: null, mode: 'system', textColor: null });
    expect(themeOf(plain, { themeMode: 'כהה', textColor: 'שחור' }, { brandPrimaryColor: '#16a34a' })).toEqual({ brand: '#16A34A', mode: 'dark', textColor: '#000000' });
    expect(themeOf(plain, { themeMode: 'בהיר' }, { brandPrimaryColor: 'green' })).toEqual({ brand: null, mode: 'light', textColor: null });
    const designed = resolveTillDesign({ colors: { accent: '#E11D48', mode: 'light' } });
    expect(themeOf(designed, { themeMode: 'dark' }, { brandPrimaryColor: '#16A34A' })).toEqual({ brand: '#E11D48', mode: 'light', textColor: null });
    // "brand" / auto: the settings' and the parameter's.
    expect(themeOf(resolveTillDesign({ colors: { accent: 'brand', mode: 'auto' } }), { themeMode: 'dark' }, { brandPrimaryColor: '#16A34A' })).toEqual({ brand: '#16A34A', mode: 'dark', textColor: null });
  });

  it('an older template name stored is its template', () => {
    expect(configOf({ config: { template: 'nightBar', profiles: { handheld: { template: 'classic' } } } }).template).toBe('fast');
  });
});

describe('the demo design (mock engine, ?design=)', () => {
  afterEach(() => {
    delete (globalThis as { location?: unknown }).location;
  });

  it('reads the query: a template, flow, the accent and the mode', () => {
    expect(demoDesignConfig('')).toBeNull();
    expect(demoDesignConfig('?state=sell')).toBeNull();
    expect(demoDesignConfig('?design=night')?.template).toBe('night');
    const flow = demoDesignConfig('?design=flow&accent=%23e11d48&mode=dark');
    expect(flow?.template).toBe('clean');
    expect(flow?.flow?.shell).toBe('flow');
    expect(flow?.colors).toEqual({ accent: '#E11D48', mode: 'dark' });
    expect(demoDesignConfig('?accent=1E3A8A')?.colors.accent).toBe('#1E3A8A');
    expect(demoDesignConfig('?design=fancy&accent=red')).toBeNull();
  });

  it('the mock engine sends it, from its option or from the page', async () => {
    const plain = new MockTillEngine();
    expect(plain.snapshot().design?.profiles.tabletLandscape.template).toBe('clean');
    expect(plain.snapshot().design?.configVersion).toBeNull();
    (globalThis as { location?: unknown }).location = { search: '?design=visual&mode=dark' };
    const fromPage = new MockTillEngine({ terminal: true });
    const s = fromPage.snapshot().design!;
    expect(s.profiles.tabletLandscape.template).toBe('visual');
    expect(s.profiles.tabletLandscape.billPosition).toBe('drawer');
    expect(s.colors.mode).toBe('dark');
    expect(fromPage.snapshot().theme).toEqual({ brand: null, mode: 'dark', textColor: null });
    (globalThis as { location?: unknown }).location = { search: '?accent=%23E11D48' };
    expect(new MockTillEngine().snapshot().theme?.brand).toBe('#E11D48');
    const given = new MockTillEngine({ design: resolveTillDesign({ template: 'payDock' }) });
    expect(given.snapshot().design?.quickCash.offered).toEqual([]);
    const catalog = await given.call({ id: 1, op: 'catalog.snapshot', args: {} });
    const first = catalog.ok ? (catalog.value as { products: Array<{ id: string }> }).products[0] : null;
    expect(first).not.toBeNull();
    await given.call({ id: 2, op: 'sell.add', args: { productId: first!.id }, clientOpId: 'a1' });
    const after = given.snapshot();
    // No terminal: "אשראי מהיר" is left off the template's own bar.
    expect(after.design?.profiles.tabletLandscape.actionBar.map((a) => a.action)).toEqual(['fastCash', 'cashNotes', 'pay']);
    expect(after.sell.totalAgorot).toBeGreaterThan(0);
    expect(after.design?.quickCash.offered).toEqual(withTotal(defaultDesignState(), after.sell.totalAgorot).quickCash.offered);
  });
});
