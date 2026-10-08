/**
 * Run with `npm test`. "מבנה הקיוסק" (lib/kioskLayout.ts), the category icons (lib/kioskIcons.ts)
 * and the text registry (lib/kioskTexts.ts): the three shared golden fixtures of
 * server/tests/fixtures — kiosk_layout_templates.json, kiosk_category_icons.json,
 * kiosk_text_registry.json, the same bytes in pos-android, their SHA-256 pinned here, there and in
 * the server's tests — against the dashboard's tables, and every case they hold.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIOSK_DEFAULTS,
  getPath,
  rebaseInherited,
  resolveKioskConfig,
  validateKioskConfig,
  type KioskConfig,
} from './kioskConfig';
import {
  KIOSK_LAYOUT_DEFAULTS,
  KIOSK_LAYOUT_TEMPLATES,
  LAYOUT_BACK_COMPAT,
  LAYOUT_TEMPLATES_READY,
  LAYOUT_VOCABULARY,
  attractStackOrderIds,
  addPathOnTap,
  basketDocked,
  basketFloats,
  basketKindOf,
  catalogKindOf,
  guidedBar,
  heroShown,
  itemViewOf,
  layoutValueReady,
  LAYOUT_CATALOGS_READY,
  LAYOUT_VALUES_READY,
  listColumns,
  mealViewOf,
  railMeasures,
  shelfCardDp,
  storyHeightDp,
  wallColumns,
  reachLow,
  rebaseLayout,
  switchLayoutTemplate,
  welcomePlacement,
} from './kioskLayout';
import { KIOSK_ICONS, categoryIconOf, iconPaths, kioskIcon, suggestCategoryIcon, validateCategoryIconIds } from './kioskIcons';
import { KIOSK_ICON_DATA } from './kioskIconData';
import { KIOSK_TEXT_REGISTRY_DATA } from './kioskTextRegistryData';
import { KIOSK_TEXTS, configuredText, defaultText, isKioskTextKey, kioskTextOf, textShownUnder, validateKioskTexts, webTextOverride } from './kioskTexts';

const TEMPLATES_SHA256 = 'bf83cc7ab875bec0e3411b0e927fb1b5ef013c9d09e72927f48bb975867324b1';
const ICONS_SHA256 = '75ac9c79776f320370b5c73429009e4daa77a13bf3d90fbdccd8b94dd5c64fa6';
const REGISTRY_SHA256 = '604e2b58954849c25cb1883a74705114ae56d12e0f60003a0d892acec56ee5a6';

function fixture(name: string): string {
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `fixture not found at ${candidates.join(' or ')}`);
  return readFileSync(found, 'utf8').replace(/\r\n/g, '\n');
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type Layers = Array<Record<string, unknown>>;
interface TemplatesFixture {
  vocabulary: Record<string, unknown[]>;
  defaults: Record<string, unknown>;
  templates: Record<string, Record<string, unknown>>;
  implemented: string[];
  backCompat: Record<string, Record<string, string>>;
  welcome: { defaults: Record<string, unknown> };
  resolveCases: Array<{ name: string; layers: Layers; expect: Record<string, unknown> }>;
}

describe('the layout templates fixture (the server, the till and the dashboard agree)', () => {
  const text = fixture('kiosk_layout_templates.json');
  const fx = JSON.parse(text) as TemplatesFixture;

  it('is the pinned one', () => {
    assert.equal(sha(text), TEMPLATES_SHA256);
  });

  it('has the dashboard’s vocabulary, defaults, templates and back-compat', () => {
    assert.deepEqual(Object.keys(fx.vocabulary).sort(), Object.keys(LAYOUT_VOCABULARY).sort());
    for (const [k, list] of Object.entries(fx.vocabulary)) assert.deepEqual(list, (LAYOUT_VOCABULARY as Record<string, readonly unknown[]>)[k], k);
    assert.deepEqual(fx.defaults, KIOSK_LAYOUT_DEFAULTS);
    assert.deepEqual(fx.templates, KIOSK_LAYOUT_TEMPLATES);
    assert.deepEqual(fx.implemented, LAYOUT_TEMPLATES_READY);
    assert.deepEqual(fx.backCompat, LAYOUT_BACK_COMPAT);
    assert.deepEqual(fx.welcome.defaults, KIOSK_DEFAULTS.attract.welcome);
    assert.deepEqual(KIOSK_DEFAULTS.layout, KIOSK_LAYOUT_DEFAULTS);
  });

  for (const c of fx.resolveCases) {
    it(`resolves: ${c.name}`, () => {
      const cfg = resolveKioskConfig(...c.layers);
      for (const [path, want] of Object.entries(c.expect)) assert.deepEqual(getPath(cfg, path), want, path);
      // What a kiosk gets always validates.
      assert.deepEqual(validateKioskConfig(cfg).filter((e) => e.path.startsWith('layout') || e.path.startsWith('attract.welcome')), []);
    });
  }
});

describe('the layout in the editor and on the screens', () => {
  it('standard changes nothing: the config of today resolves as before', () => {
    const cfg = resolveKioskConfig({ theme: { uiStyle: 'classic' } });
    assert.equal(cfg.theme.cartStyle, 'panel');
    assert.equal(cfg.theme.categoryLayout, 'side');
    assert.equal(catalogKindOf(cfg), null);
    assert.equal(basketKindOf(cfg, 1280), 'panel');
    assert.equal(basketKindOf(cfg, 540), 'bar');
  });

  it('picks a template: the keys that followed the old one move, a key set here stays', () => {
    const parent = resolveKioskConfig({});
    const draft: KioskConfig = JSON.parse(JSON.stringify(parent));
    draft.layout.railSize = 's';
    const oldBase = rebaseLayout(parent, {}, 'standard', KIOSK_DEFAULTS);
    const newBase = rebaseLayout(parent, {}, 'fastfood', KIOSK_DEFAULTS);
    const moved = switchLayoutTemplate(draft, oldBase, newBase, 'fastfood');
    assert.equal(moved.layout.template, 'fastfood');
    assert.equal(moved.layout.catalog, 'rail');
    assert.equal(moved.layout.mealUpsell, 'first');
    assert.equal(moved.layout.railSize, 's');
    const back = switchLayoutTemplate(moved, newBase, rebaseLayout(parent, {}, 'tabs', KIOSK_DEFAULTS), 'tabs');
    assert.equal(back.layout.catalog, 'top');
    assert.equal(back.catalog.oneCategory, false);
  });

  it('rebases what a level inherits onto its template; a parent’s explicit key stays', () => {
    const parentLayers = { layout: { template: 'tabs', categoryIcons: 'line' } };
    const inherited = resolveKioskConfig(parentLayers);
    const base = rebaseLayout(rebaseInherited(inherited, parentLayers, 'wolt'), parentLayers, 'landing', KIOSK_DEFAULTS);
    assert.equal(base.layout.catalog, 'landing');
    assert.equal(base.layout.categoryIcons, 'line');
    assert.equal(base.catalog.oneCategory, true);
  });

  it('validates the layout and the welcome block', () => {
    const cfg = resolveKioskConfig({});
    const bad = JSON.parse(JSON.stringify(cfg)) as { layout: Record<string, unknown>; attract: { welcome: Record<string, unknown> } };
    bad.layout.template = 'spaceship';
    bad.layout.railSize = 'xxl';
    bad.layout.nameAvatars = ['🦊 שועל', '🦊 שועל'];
    bad.attract.welcome.maxWidthPct = 10;
    bad.attract.welcome.titleColor = 'red';
    const paths = validateKioskConfig(bad as unknown as KioskConfig).map((e) => e.path);
    for (const p of ['layout.template', 'layout.railSize', 'layout.nameAvatars', 'attract.welcome.maxWidthPct', 'attract.welcome.titleColor']) assert.ok(paths.includes(p), p);
  });

  it('reach: as configured, turned over by the customer only where the toggle is', () => {
    const cfg = resolveKioskConfig({});
    assert.equal(reachLow(cfg, true), false);
    assert.equal(reachLow(resolveKioskConfig({ layout: { reach: 'low' } }), false), true);
    assert.equal(reachLow(resolveKioskConfig({ layout: { reachToggle: true } }), true), true);
    assert.equal(reachLow(resolveKioskConfig({ layout: { reach: 'low', reachToggle: true } }), true), false);
  });

  it('the rail, as the till measures it', () => {
    assert.deepEqual(
      ['s', 'm', 'l'].map((s) => railMeasures(s as 's' | 'm' | 'l', 785, 1200).itemDp),
      [100, 150, 200],
    );
  });

  it('the guided step bar', () => {
    const bar = guidedBar(true, ['tip'], 'basket');
    assert.deepEqual(bar.map((b) => b.key), ['service', 'menu', 'basket', 'tip', 'pay']);
    assert.deepEqual(bar.map((b) => b.state), ['done', 'done', 'current', 'next', 'next']);
    for (const b of bar) assert.ok(isKioskTextKey(b.textKey), b.textKey);
  });

  it('the editor offers as ready only values a ready template may need, and every ready template draws all its own', () => {
    for (const [key, values] of Object.entries(LAYOUT_VALUES_READY)) {
      const vocab = (LAYOUT_VOCABULARY as Record<string, readonly unknown[]>)[key];
      if (key === 'magazineFeed') continue;
      for (const v of values ?? []) if (v !== null) assert.ok(vocab.includes(v), `${key}=${String(v)}`);
    }
    for (const template of LAYOUT_TEMPLATES_READY) {
      const layer = (KIOSK_LAYOUT_TEMPLATES[template].layout ?? {}) as Record<string, unknown>;
      // The service / name screens' variants are phase 2's: until then the kiosk shows today's screen.
      for (const [key, v] of Object.entries(layer)) {
        if (key === 'service' || key === 'name') continue;
        assert.ok(layoutValueReady(key as never, v), `${template}: ${key}=${String(v)}`);
      }
    }
    // Phase 2: every template is drawn; the service / name screens' variants are still to come.
    for (const template of Object.keys(KIOSK_LAYOUT_TEMPLATES)) assert.equal(layoutValueReady('template', template), true, template);
    assert.equal(layoutValueReady('reach', 'low'), true);
    assert.equal(layoutValueReady('service', 'rows'), false);
    assert.equal(layoutValueReady('name', 'avatar'), false);
  });

  it('phase 2: the five templates draw their own catalog, basket, dish window and meal', () => {
    const of = (template: string) => resolveKioskConfig({ layout: { template } });
    assert.deepEqual(LAYOUT_CATALOGS_READY, LAYOUT_VOCABULARY.catalog);
    assert.equal(catalogKindOf(of('cafe')), 'shelves');
    assert.equal(catalogKindOf(of('combo')), 'top');
    assert.equal(catalogKindOf(of('list')), 'list');
    assert.equal(catalogKindOf(of('magazine')), 'magazine');
    assert.equal(catalogKindOf(of('wall')), 'wall');
    assert.equal(basketKindOf(of('cafe'), 785), 'fab');
    assert.equal(basketKindOf(of('list'), 785), 'drawer');
    assert.equal(basketKindOf(of('wall'), 785), 'receipt');
    assert.equal(basketKindOf(of('combo'), 785), 'summary');
    assert.equal(itemViewOf(of('list')), 'inline');
    assert.equal(itemViewOf(of('wall')), 'popover');
    assert.equal(itemViewOf(of('cafe')), 'full');
    assert.equal(mealViewOf(of('combo')), 'tray');
    assert.equal(mealViewOf(of('standard')), 'sheet');
    // The list turns the search on; the wall adds on a tap.
    assert.equal(of('list').general.searchEnabled, true);
    assert.equal(of('wall').layout.quickAdd, 'always');
    for (const k of ['bar', 'fab', 'drawer']) assert.ok(basketFloats(k) && !basketDocked(k), k);
    for (const k of ['summary', 'receipt']) assert.ok(basketDocked(k) && !basketFloats(k), k);
    assert.ok(!basketFloats('panel') && !basketDocked('panel'));
  });

  it('phase 2: the featured banner, quickAdd always and the measures — the till’s numbers', () => {
    const cafe = resolveKioskConfig({ layout: { template: 'cafe' } });
    assert.equal(heroShown(cafe, 3), true);
    assert.equal(heroShown(cafe, 0), false);
    assert.equal(heroShown(resolveKioskConfig({ layout: { template: 'cafe', hero: 'off' } }), 3), false);
    assert.equal(heroShown(resolveKioskConfig({ layout: { template: 'tabs', hero: 'auto' } }), 1), true);
    assert.equal(heroShown(resolveKioskConfig({ layout: { template: 'fastfood', hero: 'manual' } }), 2), false);
    assert.equal(addPathOnTap('sheet', 'always', false, true), 'direct');
    assert.equal(addPathOnTap('sheet', 'always', false, false), 'sheet');
    assert.equal(addPathOnTap('sheet', 'always', true, true), 'sheet');
    assert.equal(addPathOnTap('sheet', 'no_required', false, true), 'sheet');
    assert.equal(addPathOnTap('none', 'always', false, true), 'none');
    // KioskLayoutPhase2Test, number for number.
    assert.deepEqual(['m', 's', 'l'].map((s) => shelfCardDp(785, s as 'm')), [304, 217, 436]);
    assert.equal(shelfCardDp(200, 's'), 150);
    assert.equal(shelfCardDp(2000, 'l'), 460);
    assert.deepEqual([listColumns(785), listColumns(1280)], [1, 2]);
    assert.deepEqual(['m', 's', 'l'].map((s) => storyHeightDp(1200, s as 'm')), [936, 744, 1080]);
    assert.equal(storyHeightDp(300, 'm'), 320);
    assert.deepEqual(['m', 's', 'l'].map((s) => wallColumns(785, s as 'm')), [3, 4, 2]);
    assert.equal(wallColumns(420, 'm'), 2);
    assert.equal(wallColumns(1280, 'm'), 5);
  });

  it('the welcome block first unless moved, nowhere when off', () => {
    assert.deepEqual(welcomePlacement(undefined, ['hero', 'categories']), { position: 'bottom', index: 0 });
    assert.deepEqual(welcomePlacement({ enabled: true, position: 'middle' }, ['categories', 'welcome']), { position: 'middle', index: 1 });
    assert.equal(welcomePlacement({ enabled: false, position: 'bottom' }, ['welcome']), null);
    assert.deepEqual(attractStackOrderIds(['hero', 'categories', 'welcome', 'club'], { enabled: true, position: 'bottom' }), ['categories', 'welcome', 'club']);
  });
});

describe('the category icons fixture', () => {
  const text = fixture('kiosk_category_icons.json');
  const fx = JSON.parse(text) as { icons: unknown[]; cases: Array<{ name: string; id: string | null }> };

  it('is the pinned one and the dashboard’s data is it', () => {
    assert.equal(sha(text), ICONS_SHA256);
    assert.deepEqual(KIOSK_ICON_DATA.icons, fx.icons);
    assert.deepEqual(KIOSK_ICON_DATA.cases, fx.cases);
    assert.ok(KIOSK_ICONS.length >= 40);
  });

  it('suggests every case’s icon from the category’s name', () => {
    for (const c of fx.cases) assert.equal(suggestCategoryIcon(c.name), c.id, c.name);
    assert.equal(suggestCategoryIcon('המבורגר'), 'burger');
    assert.equal(suggestCategoryIcon('בורגר'), 'burger');
    assert.equal(suggestCategoryIcon('שתייה'), 'drink');
    assert.equal(suggestCategoryIcon('קפה'), 'coffee');
    assert.equal(suggestCategoryIcon('קינוחים'), 'dessert');
  });

  it('a set icon beats the suggestion; an unknown one is refused', () => {
    assert.equal(categoryIconOf('c1', 'המבורגרים', { c1: 'pizza' }), 'pizza');
    assert.equal(categoryIconOf('c1', 'המבורגרים', { c1: 'nope' }), 'burger');
    assert.deepEqual(validateCategoryIconIds({ c1: 'pizza' }), []);
    assert.equal(validateCategoryIconIds({ c1: 'nope' })[0]?.path, 'catalog.categoryIconIds.c1');
  });

  it('draws one set of paths three ways', () => {
    const burger = kioskIcon('burger')!;
    assert.ok(iconPaths(burger, 'line').every((p) => !p.fill && p.stroke === 'color'));
    assert.equal(iconPaths(burger, 'filled').filter((p) => p.stroke === 'knock').length, burger.i.length);
    assert.ok(iconPaths(burger, 'duotone').filter((p) => p.fill).every((p) => p.fillOpacity === 0.28));
  });
});

describe('the text registry fixture', () => {
  const text = fixture('kiosk_text_registry.json');

  it('is the pinned one and the dashboard’s data is it', () => {
    assert.equal(sha(text), REGISTRY_SHA256);
    assert.deepEqual(KIOSK_TEXT_REGISTRY_DATA, JSON.parse(text));
  });

  it('holds every flat text key of before (TEXT_KEYS), and many more', async () => {
    const { TEXT_KEYS } = await import('./kioskConfig');
    for (const k of TEXT_KEYS) assert.ok(isKioskTextKey(k), k);
    assert.ok(KIOSK_TEXTS.length >= 250);
  });

  it('looks a text up: the language’s own, the first language’s flat text, the default', () => {
    const cfg = { general: { languages: ['he', 'en'] }, texts: { cartTitle: 'הסל' }, textsByLang: { en: { cartTitle: 'Basket' } } } as unknown as KioskConfig;
    assert.equal(configuredText(cfg, 'he', 'cartTitle'), 'הסל');
    assert.equal(configuredText(cfg, 'en', 'cartTitle'), 'Basket');
    assert.equal(configuredText({ ...cfg, textsByLang: {} } as KioskConfig, 'en', 'cartTitle'), null);
    assert.equal(kioskTextOf(cfg, 'ru', 'cartTitle'), defaultText('ru', 'cartTitle'));
    assert.equal(kioskTextOf(cfg, 'he', 'guidedToBasket', { count: 2, total: '₪10' }).includes('₪10'), true);
  });

  it('replaces a web label only where the business set its text', () => {
    const def = KIOSK_TEXTS.find((d) => d.web.length > 0)!;
    const web = typeof def.web[0] === 'string' ? def.web[0] : def.web[0].key;
    assert.equal(webTextOverride({ texts: {}, general: { languages: ['he'] } } as unknown as KioskConfig, 'he', web), null);
    assert.equal(webTextOverride({ texts: { [def.key]: 'משהו אחר' }, general: { languages: ['he'] } } as unknown as KioskConfig, 'he', web), 'משהו אחר');
  });

  it('validates textsByLang: the key, its max, its placeholders', () => {
    const errors = validateKioskTexts({ texts: {}, textsByLang: { en: { nope: 'x', cartTitle: 'x'.repeat(500), guidedToBasket: '{count} {foo}' }, xx: {} } });
    const codes = errors.map((e) => `${e.path}:${e.code}`);
    assert.ok(codes.includes('textsByLang.en.nope:unknownTextKey'));
    assert.ok(codes.includes('textsByLang.en.cartTitle:tooLong'));
    assert.ok(codes.includes('textsByLang.en.guidedToBasket:textPlaceholder'));
    assert.ok(codes.includes('textsByLang.xx:unknownKey'));
  });

  it('shows a layout’s texts only under that layout', () => {
    assert.equal(textShownUnder({ catalog: ['landing'] }, { catalog: 'landing' }), true);
    assert.equal(textShownUnder({ catalog: ['landing'] }, { catalog: 'rail' }), false);
    assert.equal(textShownUnder({ any: [{ reach: ['low'] }, { reachToggle: [true] }] }, { reach: 'normal', reachToggle: true }), true);
    assert.equal(textShownUnder(null, {}), true);
  });
});

import { LAYOUT_PRODUCT_SIZES, productColumns, validateLayout } from './kioskLayout';

describe('"גודל מוצרים" (layout.productSize — the Android kiosk\'s KioskLayouts.productColumns)', () => {
  it('m is today; s a column more; l a column fewer, never under two tiles from a 400 dp grid', () => {
    assert.deepEqual(LAYOUT_PRODUCT_SIZES, ['s', 'm', 'l']);
    assert.equal(KIOSK_LAYOUT_DEFAULTS.productSize, 'm');
    assert.equal(productColumns(3, 'm', 720), 3);
    assert.equal(productColumns(3, undefined, 720), 3);
    assert.equal(productColumns(3, 's', 720), 4);
    assert.equal(productColumns(3, 'l', 720), 2);
    assert.equal(productColumns(2, 'l', 720), 2);
    assert.equal(productColumns(2, 'l', 360), 1);
    assert.equal(productColumns(1, 'l', 800), 1);
    assert.equal(productColumns(1, 's', 720, true), 1, 'rows keep theirs');
    assert.equal(productColumns(4, 's', 1200), 5);
  });

  it('validated with the rest of the layout', () => {
    const bad = validateLayout({ layout: { ...KIOSK_LAYOUT_DEFAULTS, productSize: 'xl' as never }, attract: KIOSK_DEFAULTS.attract });
    assert.ok(bad.some((e) => e.path === 'layout.productSize'));
    const ok = validateLayout({ layout: { ...KIOSK_LAYOUT_DEFAULTS, productSize: 'l' }, attract: KIOSK_DEFAULTS.attract });
    assert.equal(ok.filter((e) => e.path === 'layout.productSize').length, 0);
  });
});
