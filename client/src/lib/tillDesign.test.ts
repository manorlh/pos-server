/**
 * Run with `npm test`. "עיצוב קופה" (lib/tillDesign.ts) against the shared fixture
 * server/tests/fixtures/till_design_contract.json (generated from pos-server
 * app/services/till_design.py; the same bytes in pos-android): every case it holds — the defaults
 * and the template table, `forProfile` for every template × profile, the merge and its config
 * version, the banknote buttons, the till parameters' quick-pay buttons, and the validation
 * codes — plus the editor's own helpers (the minimal layer, the menu order, the preview's grid).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTION_LABELS,
  LEGACY_FALLBACK,
  PROFILES,
  TEMPLATES,
  TEMPLATE_DEFAULTS,
  TEXT_DEFAULTS,
  TILL_DESIGN_DEFAULTS,
  actionLabelOf,
  actionsFor,
  canonicalJson,
  canonicalTemplate,
  deepMerge,
  diffConfigs,
  flatProductOrder,
  forProfile,
  formatShekels,
  gridColumns,
  legacyQuickActions,
  menuView,
  orderCategories,
  pruneOverrides,
  quickCashNotes,
  resolveFieldMode,
  resolveTileSize,
  resolveTillDesign,
  sanitizeStoredLayer,
  setPath,
  sideBillWidth,
  textOf,
  tileHeight,
  tillDesignCatalog,
  validateTillDesign,
  validateTillDesignLayer,
  type TillDesignConfig,
  type TillDesignLayer,
} from './tillDesign';

interface Fixture {
  schemaVersion: number;
  defaults: unknown;
  defaultsVersion: string;
  catalog: unknown;
  forProfile: Array<{ name: string; layers?: TillDesignLayer[]; raw?: Record<string, unknown>; profile: string; expected: unknown }>;
  merge: Array<{ name: string; layers: TillDesignLayer[]; expected: unknown; expectedVersion: string }>;
  quickCash: Array<{ totalAgorot: number; notes: number[]; count: number; expected: number[] }>;
  legacyQuickActions: Array<{ parameters: Record<string, unknown>; expected: unknown }>;
  validation: Array<{ name: string; layer: unknown; errors: Array<{ path: string; code: string }> }>;
}

const FIXTURE_PATH = join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'till_design_contract.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

function version(cfg: unknown): string {
  return createHash('sha256').update(canonicalJson(cfg), 'utf8').digest('hex').slice(0, 16);
}

describe('till design: the shared contract fixture', () => {
  it('has the defaults and the catalog the server sends', () => {
    assert.equal(fixture.schemaVersion, 1);
    assert.deepEqual(TILL_DESIGN_DEFAULTS, fixture.defaults);
    assert.equal(version(TILL_DESIGN_DEFAULTS), fixture.defaultsVersion);
    assert.deepEqual(tillDesignCatalog(), fixture.catalog);
  });

  it('settles forProfile like the server, for every case', () => {
    assert.ok(fixture.forProfile.length >= 36);
    for (const c of fixture.forProfile) {
      const cfg = c.raw ? (c.raw as unknown as TillDesignConfig) : resolveTillDesign(...(c.layers ?? []));
      assert.deepEqual(forProfile(cfg, c.profile), c.expected, `${c.name} / ${c.profile}`);
    }
  });

  it('merges the layers (lists replace, null inherits) to the same config and version', () => {
    for (const c of fixture.merge) {
      const resolved = resolveTillDesign(...c.layers);
      assert.deepEqual(resolved, c.expected, c.name);
      assert.equal(version(resolved), c.expectedVersion, c.name);
    }
  });

  it('offers the same banknotes', () => {
    for (const c of fixture.quickCash) {
      assert.deepEqual(quickCashNotes(c.totalAgorot, c.notes, c.count), c.expected, JSON.stringify(c));
    }
  });

  it('reads the till parameters\' quick-pay buttons the same', () => {
    for (const c of fixture.legacyQuickActions) {
      assert.deepEqual(legacyQuickActions(c.parameters), c.expected, JSON.stringify(c.parameters));
    }
  });

  it('refuses a layer with the same paths and codes', () => {
    for (const c of fixture.validation) {
      const { errors } = validateTillDesignLayer(c.layer);
      const got = Array.from(new Set(errors.map((e) => `${e.path}|${e.code}`))).sort();
      const want = c.errors.map((e) => `${e.path}|${e.code}`).sort();
      assert.deepEqual(got, want, c.name);
    }
  });
});

describe('till design: validation of a complete config (the editor\'s draft)', () => {
  it('passes the defaults and every template', () => {
    assert.deepEqual(validateTillDesign(TILL_DESIGN_DEFAULTS), []);
    for (const template of TEMPLATES) {
      assert.deepEqual(validateTillDesign({ ...TILL_DESIGN_DEFAULTS, template }), [], template);
    }
  });

  it('refuses a phase-2 template, also per profile', () => {
    const base = setPath(TILL_DESIGN_DEFAULTS, 'profiles.handheld.template', 'night');
    assert.deepEqual(
      validateTillDesign(base).map((e) => [e.path, e.code]),
      [['profiles.handheld.template', 'template_not_available']],
    );
  });

  it('keeps the required buttons, refuses duplicates and more than 6', () => {
    const noSend = setPath(TILL_DESIGN_DEFAULTS, 'actionBar.table', [{ action: 'bill', label: '' }]);
    assert.deepEqual(validateTillDesign(noSend).map((e) => e.code), ['action_bar_missing_send']);
    const twice = setPath(TILL_DESIGN_DEFAULTS, 'actionBar.quick', [
      { action: 'pay', label: '' },
      { action: 'pay', label: '' },
    ]);
    assert.deepEqual(validateTillDesign(twice).map((e) => [e.path, e.code]), [['actionBar.quick[1]', 'duplicate']]);
    const seven = setPath(
      TILL_DESIGN_DEFAULTS,
      'actionBar.quick',
      ['pay', 'fastCard', 'cashWithChange', 'fastCash', 'cashNotes', 'hold', 'clear'].map((action) => ({ action, label: '' })),
    );
    assert.ok(validateTillDesign(seven).some((e) => e.path === 'actionBar.quick' && e.code === 'too_many'));
  });

  it('checks labels, presets, notes, columns, colours and texts', () => {
    const cases: Array<[string, unknown, string, string]> = [
      ['actionBar.quick', [{ action: 'pay', label: 'x'.repeat(25) }], 'actionBar.quick[0].label', 'too_long'],
      ['bar.quantityPresets', [2, 3], 'bar.quantityPresets', 'quantity_presets_need_one'],
      ['bar.quantityPresets', [1], 'bar.quantityPresets', 'too_few'],
      ['quickCash.notes', [10, 30], 'quickCash.notes[1]', 'invalid_value'],
      ['quickCash.count', 5, 'quickCash.count', 'out_of_range'],
      ['layout.columns', 9, 'layout.columns', 'invalid_value'],
      ['profiles.tabletPortrait.columns', 1, 'profiles.tabletPortrait.columns', 'invalid_value'],
      ['colors.accent', '#12345', 'colors.accent', 'invalid_color'],
      ['texts.pay', 'x'.repeat(41), 'texts.pay', 'too_long'],
    ];
    for (const [path, value, errPath, code] of cases) {
      const errors = validateTillDesign(setPath(TILL_DESIGN_DEFAULTS, path, value));
      assert.ok(errors.some((e) => e.path === errPath && e.code === code), `${path}: ${JSON.stringify(errors)}`);
    }
  });

  it('drops what no longer validates from a stored layer', () => {
    assert.deepEqual(sanitizeStoredLayer({ actionBar: { quick: [{ action: 'fastCash' }] }, template: 'touch' }), { template: 'touch' });
    assert.deepEqual(sanitizeStoredLayer({ bar: { quantityPresets: [2, 3] } }), {});
    assert.deepEqual(sanitizeStoredLayer({ layout: { columns: 1 } }), {});
    assert.deepEqual(sanitizeStoredLayer(null), {});
  });
});

describe('till design: the minimal saved layer', () => {
  it('keeps only what differs from what the level inherits', () => {
    const inherited = resolveTillDesign({ template: 'touch', bar: { favorites: ['p1'] } });
    let draft = setPath(inherited, 'layout.density', 'spacious');
    draft = setPath(draft, 'profiles.handheld.template', 'mobile');
    draft = setPath(draft, 'texts.pay', 'לתשלום');
    assert.deepEqual(pruneOverrides(inherited, draft), {
      layout: { density: 'spacious' },
      profiles: { handheld: { template: 'mobile' } },
      texts: { pay: 'לתשלום' },
    });
    assert.deepEqual(pruneOverrides(inherited, inherited), {});
  });

  it('saves an emptied list (back to "auto") over a parent\'s list', () => {
    const inherited = resolveTillDesign({ actionBar: { quick: [{ action: 'cashNotes', label: '' }, { action: 'pay', label: '' }] } });
    const draft = setPath(inherited, 'actionBar.quick', []);
    const layer = pruneOverrides(inherited, draft);
    assert.deepEqual(layer, { actionBar: { quick: [] } });
    assert.deepEqual(resolveTillDesign({ actionBar: { quick: [{ action: 'cashNotes' }, { action: 'pay' }] } }, layer).actionBar.quick, []);
  });

  it('never saves a null (it inherits) nor an empty text over none', () => {
    const inherited = resolveTillDesign({ colors: { accent: '#1663D6' } });
    const draft = setPath(setPath(inherited, 'colors.accent', null), 'texts.summary', '');
    assert.deepEqual(pruneOverrides(inherited, draft), {});
  });

  it('merges a layer over the effective config as the server does', () => {
    const merged = deepMerge(TILL_DESIGN_DEFAULTS, { texts: { pay: 'א' } }, { texts: { summary: 'ב' }, layout: { columns: 4 } });
    assert.deepEqual(merged.texts, { pay: 'א', summary: 'ב' });
    assert.equal(merged.layout.columns, 4);
    assert.equal(merged.layout.density, 'comfortable');
    assert.deepEqual(diffConfigs(TILL_DESIGN_DEFAULTS, merged).map((c) => c.path).sort(), ['layout.columns', 'texts.pay', 'texts.summary']);
  });
});

describe('till design: what the editor and the preview read', () => {
  it('reads aliases and refuses phase 2 as clean', () => {
    assert.equal(canonicalTemplate('classic'), 'clean');
    assert.equal(canonicalTemplate('speed'), 'fast');
    assert.equal(canonicalTemplate('payDock'), 'clean');
    assert.equal(canonicalTemplate(undefined), 'clean');
  });

  it('settles "auto" with the till parameters', () => {
    const view = forProfile(TILL_DESIGN_DEFAULTS, 'tabletLandscape');
    const legacy = { ...LEGACY_FALLBACK, tileSize: { quick: 's', quickTablet: 'l', table: 'xs', tableTablet: 'm' } } as typeof LEGACY_FALLBACK;
    assert.equal(resolveTileSize(view, 'quick', legacy), 'l');
    assert.equal(resolveTileSize(view, 'table', legacy), 'm');
    assert.equal(resolveTileSize(forProfile(TILL_DESIGN_DEFAULTS, 'handheld'), 'table', legacy), 'xs');
    assert.equal(resolveTileSize({ ...view, tileSize: 's' }, 'quick', legacy), 's');
    assert.equal(resolveFieldMode('auto', 'required'), 'required');
    assert.equal(resolveFieldMode('auto', null), 'off');
    assert.equal(resolveFieldMode('optional', 'off'), 'optional');
    assert.deepEqual(actionsFor(view, 'quick', null).map((a) => a.action), ['fastCard', 'cashWithChange', 'pay']);
    assert.deepEqual(actionsFor(view, 'table', null).map((a) => a.action), ['send']);
  });

  it('words the buttons: own label, then the texts, then the default', () => {
    const cfg = { texts: { sendToKitchen: 'למטבח', pay: '' } };
    assert.equal(actionLabelOf({ action: 'send', label: '' }, cfg), 'למטבח');
    assert.equal(actionLabelOf({ action: 'pay', label: '' }, cfg), TEXT_DEFAULTS.pay);
    assert.equal(actionLabelOf({ action: 'pay', label: 'לתשלום' }, cfg), 'לתשלום');
    assert.equal(actionLabelOf({ action: 'cashNotes', label: '' }, cfg), ACTION_LABELS.cashNotes);
    assert.equal(textOf(cfg, 'summary'), 'סיכום ההזמנה');
  });

  it('writes shekels as the till does', () => {
    assert.equal(formatShekels(10800), '₪108');
    assert.equal(formatShekels(280), '₪2.80');
    assert.equal(formatShekels(123456), '₪1,234.56');
    assert.equal(formatShekels(5), '₪0.05');
  });

  it('orders the menu: chosen first, the rest in the till\'s order; hidden left out of the bar and "הכל"', () => {
    const cats = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    const prods = [
      { id: 'p1', categoryId: 'a' },
      { id: 'p2', categoryId: 'b' },
      { id: 'p3', categoryId: 'a' },
      { id: 'p4', categoryId: 'c' },
    ];
    assert.deepEqual(orderCategories(cats, { categoryOrder: ['c', 'zz'] }).map((c) => c.id), ['c', 'a', 'b']);
    const view = menuView(cats, prods, { categoryOrder: ['b'], productOrder: ['p3'], hiddenCategories: ['c'] });
    assert.deepEqual(view.categories.map((c) => c.id), ['b', 'a']);
    assert.deepEqual(view.products.map((p) => p.id), ['p2', 'p3', 'p1']);
    assert.deepEqual(flatProductOrder(cats, prods, { categoryOrder: ['c'], productOrder: ['p3'] }), ['p4', 'p3', 'p1', 'p2']);
  });

  it('lays the preview out as the brief\'s table (§4)', () => {
    // Handheld: 2 columns of cards / photo tiles, 3 of keys; a side bill never on the handheld.
    assert.equal(gridColumns({ style: 'card', size: 'm', paneWidth: 336, handheld: true }), 2);
    assert.equal(gridColumns({ style: 'photo', size: 'm', paneWidth: 336, handheld: true }), 2);
    assert.equal(gridColumns({ style: 'key', size: 'm', paneWidth: 336, handheld: true }), 3);
    // Tablet portrait (full width): 3 columns of cards; landscape beside a side bill: 3–4.
    assert.equal(gridColumns({ style: 'card', size: 'm', paneWidth: 768, handheld: false }), 3);
    assert.equal(gridColumns({ style: 'card', size: 'm', paneWidth: 1280 - sideBillWidth('seated', 1280) - 32, handheld: false }), 3);
    assert.equal(gridColumns({ style: 'card', size: 'm', paneWidth: 1248, handheld: false }), 5);
    assert.equal(gridColumns({ style: 'photo', size: 'm', paneWidth: 736, handheld: false }), 2);
    assert.equal(gridColumns({ style: 'key', size: 'm', paneWidth: 1280 - sideBillWidth('fast', 1280) - 32, handheld: false }), 5);
    assert.equal(gridColumns({ style: 'row', size: 'm', paneWidth: 700, handheld: false }), 1);
    assert.equal(gridColumns({ style: 'card', size: 'm', paneWidth: 700, handheld: false, columns: 6 }), 6);
    assert.equal(sideBillWidth('touch', 1280), 460);
    assert.equal(sideBillWidth('touch', 1024), 369);
    assert.equal(sideBillWidth('professional', 800), 320);
    assert.equal(tileHeight({ style: 'card', size: 'm', density: 'compact', tileWidth: 200, withPhoto: false }), 128);
    assert.equal(tileHeight({ style: 'key', size: 'm', density: 'comfortable', tileWidth: 140, withPhoto: false }), 72);
  });

  it('settles every template on every profile with a bill position and actions', () => {
    for (const template of TEMPLATES) {
      for (const profile of PROFILES) {
        const v = forProfile({ ...TILL_DESIGN_DEFAULTS, template }, profile);
        assert.equal(v.template, template);
        assert.ok(v.actions.table.length > 0);
        assert.deepEqual(v.actions.table.map((a) => a.action), TEMPLATE_DEFAULTS[template].tableActions);
        if (profile === 'handheld') assert.ok(!['start', 'end'].includes(v.billPosition.table));
      }
    }
  });
});

describe('till design: the editor\'s texts exist in he.json', () => {
  // Every literal key the till design code asks for (t('…') under its useTranslations
  // namespaces) must be in the messages: a missing one shows as its raw path.
  it('has every literal key', () => {
    const root = join(process.cwd(), 'src');
    const messages = JSON.parse(readFileSync(join(root, 'messages', 'he.json'), 'utf8')) as Record<string, unknown>;
    const has = (path: string) =>
      path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), messages) !== undefined;
    const dirs = [join(root, 'components', 'dashboard', 'till-design'), join(root, 'app', 'dashboard', 'till-design')];
    const missing: string[] = [];
    let files = 0;
    for (const dir of dirs.filter((d) => existsSync(d))) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
        files += 1;
        const src = readFileSync(join(dir, file), 'utf8');
        const spaces = new Map<string, Set<string>>();
        for (const [, name, ns] of src.matchAll(/const\s+(\w+)\s*=\s*useTranslations\(\s*'([^']*)'\s*\)/g)) {
          if (!spaces.has(name)) spaces.set(name, new Set());
          spaces.get(name)!.add(ns);
        }
        for (const [name, set] of spaces) {
          const call = new RegExp(String.raw`(?<![\w.])${name}\(\s*'([A-Za-z0-9_.]+)'`, 'g');
          for (const [, key] of src.matchAll(call)) {
            if (![...set].some((ns) => has(ns ? `${ns}.${key}` : key))) missing.push(`${file}: ${[...set].join('|')}.${key}`);
          }
        }
      }
    }
    assert.ok(files > 0);
    assert.deepEqual(missing, []);
    // The words every vocabulary needs (the editor builds these keys from the lists).
    for (const template of TEMPLATES) assert.ok(has(`tillDesign.templates.${template}.name`), template);
    for (const profile of PROFILES) assert.ok(has(`tillDesign.profiles.${profile}`), profile);
    for (const key of Object.keys(TEXT_DEFAULTS)) assert.ok(has(`tillDesign.texts.${key}`), key);
    for (const action of Object.keys(ACTION_LABELS)) assert.ok(has(`tillDesign.actions.${action}`), action);
  });
});
