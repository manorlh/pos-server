/**
 * Run with `npm test`. The self-order kiosk's configuration rules (lib/kioskConfig.ts):
 * the layer merge, the minimal layer to save, validation, the kiosk's catalog order and
 * the pickup label — the same rules the server and the till apply.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  FONT_CATALOG,
  KIOSK_DEFAULTS,
  buttonRadius,
  categoryProductIds,
  cloneJson,
  contrastText,
  deepMergeKiosk,
  diffKioskConfigs,
  getPath,
  googleFontsCssUrl,
  gridColumns,
  isoDayInZone,
  kioskCatalogView,
  kioskConnection,
  kioskOffline,
  layerHas,
  moveItem,
  nextMessageId,
  pickupLabel,
  pruneOverrides,
  resolveThemeColors,
  setPath,
  stripNulls,
  toggleInList,
  validateKioskConfig,
  bonPrinted,
  KIOSK_UI_PRESETS,
  PRESET_THEME_KEYS,
  UI_STYLES,
  categoryRailImage,
  dietaryTagsOf,
  messagePlacement,
  motionSpec,
  presetLayer,
  rebaseInherited,
  repairKioskConfig,
  resolveKioskConfig,
  styleOf,
  switchUiStyle,
  typeScaleFactor,
  typeWeights,
  TEXT_KEYS,
  CTA_LAYOUT,
  CTA_POSITIONS,
  CTA_SIZES,
  KIOSK_UI_PRESET_CTA,
  PRESET_CTA_KEYS,
  ctaAnimation,
  ctaBounceLift,
  ctaBox,
  ctaFontSp,
  ctaRadiusPx,
  ctaSize,
  attractSpans,
  fittingCount,
  cartPanelShown,
  CTA_HINT_BLOCK,
  ATTRACT_CONTENT_GAP,
  ctaSubtitleSp,
  type KioskConfig,
  type KioskCta,
  type MediaRef,
} from './kioskConfig';

const logo: MediaRef = { url: 'https://cdn.example/logo.png', kind: 'image', sha256: 'a'.repeat(64), bytes: 1200 };
const logo2: MediaRef = { url: 'https://cdn.example/logo2.png', kind: 'image', sha256: null, bytes: null };

function cfg(patch: Record<string, unknown> = {}): KioskConfig {
  return deepMergeKiosk(KIOSK_DEFAULTS, patch);
}

describe('deepMergeKiosk', () => {
  it('deep-merges dicts and leaves the inputs alone', () => {
    const before = cloneJson(KIOSK_DEFAULTS);
    const out = deepMergeKiosk(KIOSK_DEFAULTS, { theme: { primaryColor: '#000000' } });
    assert.equal(out.theme.primaryColor, '#000000');
    assert.equal(out.theme.accentColor, KIOSK_DEFAULTS.theme.accentColor);
    assert.equal(out.general.skipCart, 'off');
    assert.deepEqual(KIOSK_DEFAULTS, before);
  });

  it('replaces lists instead of merging them', () => {
    const out = deepMergeKiosk(KIOSK_DEFAULTS, { general: { serviceTypes: ['eat_in'] } });
    assert.deepEqual(out.general.serviceTypes, ['eat_in']);
    const out2 = deepMergeKiosk(KIOSK_DEFAULTS, { attract: { sections: ['club'] } }, { attract: { sections: ['hero'] } });
    assert.deepEqual(out2.attract.sections, ['hero']);
  });

  it('replaces a MediaRef whole, never key by key', () => {
    const company = { theme: { logo } };
    const shop = { theme: { logo: logo2 } };
    const out = deepMergeKiosk(KIOSK_DEFAULTS, company, shop);
    assert.deepEqual(out.theme.logo, logo2);
    assert.equal(out.theme.logo?.sha256, null);
  });

  it('treats null as inherit at every level', () => {
    const out = deepMergeKiosk(
      KIOSK_DEFAULTS,
      { theme: { logo, primaryColor: '#111111' } },
      { theme: { logo: null, primaryColor: null } },
    );
    assert.deepEqual(out.theme.logo, logo);
    assert.equal(out.theme.primaryColor, '#111111');
  });

  it('merges keyed maps (texts, categoryImages, productOrder) key by key in order company → shop → machine', () => {
    const out = deepMergeKiosk(
      KIOSK_DEFAULTS,
      { texts: { attractTitle: 'A', cartTitle: 'C' }, catalog: { productOrder: { c1: ['p1', 'p2'] } } },
      { texts: { attractTitle: 'B' }, catalog: { productOrder: { c2: ['p9'] }, categoryImages: { c1: logo } } },
      { texts: { cartTitle: 'D' } },
    );
    assert.deepEqual(out.texts, { attractTitle: 'B', cartTitle: 'D' });
    assert.deepEqual(out.catalog.productOrder, { c1: ['p1', 'p2'], c2: ['p9'] });
    assert.deepEqual(out.catalog.categoryImages, { c1: logo });
  });

  it('skips missing layers', () => {
    assert.deepEqual(deepMergeKiosk(KIOSK_DEFAULTS, null, undefined), KIOSK_DEFAULTS);
  });
});

describe('pruneOverrides', () => {
  it('keeps only what differs from the inherited value', () => {
    const parent = cfg({ theme: { primaryColor: '#123456' } });
    const edited = setPath(setPath(parent, 'theme.cornerRadius', 8), 'general.skipCart', 'direct');
    assert.deepEqual(pruneOverrides(parent, edited), { theme: { cornerRadius: 8 }, general: { skipCart: 'direct' } });
  });

  it('is empty when nothing changed, and the merge of the result gives the edit back', () => {
    const parent = cfg({ texts: { attractTitle: 'שלום' } });
    assert.deepEqual(pruneOverrides(parent, cloneJson(parent)), {});
    const edited = setPath(setPath(parent, 'messages', [{ id: 'm1' }]), 'texts.cartTitle', 'הסל');
    const layer = pruneOverrides(parent, edited);
    assert.deepEqual(layer, { messages: [{ id: 'm1' }], texts: { cartTitle: 'הסל' } });
    assert.deepEqual(deepMergeKiosk(parent, layer), edited);
  });

  it('saves a whole list when one item changed', () => {
    const parent = cfg();
    const edited = setPath(parent, 'payment.tipPresets', [10, 12, 18]);
    assert.deepEqual(pruneOverrides(parent, edited), { payment: { tipPresets: [10, 12, 18] } });
  });

  it('cannot save a null (it means inherit) and drops an empty text over no parent text', () => {
    const parent = cfg({ theme: { logo } });
    const edited = setPath(setPath(parent, 'theme.logo', null), 'texts.helpText', '');
    assert.deepEqual(pruneOverrides(parent, edited), {});
  });

  it('keeps an empty text that overrides a parent text', () => {
    const parent = cfg({ texts: { helpText: 'עזרה' } });
    const edited = setPath(parent, 'texts.helpText', '');
    assert.deepEqual(pruneOverrides(parent, edited), { texts: { helpText: '' } });
  });

  it('writes a MediaRef whole', () => {
    const parent = cfg({ theme: { logo } });
    const edited = setPath(parent, 'theme.logo', logo2);
    assert.deepEqual(pruneOverrides(parent, edited), { theme: { logo: logo2 } });
  });

  it('stripNulls drops inherit markers and empty dicts', () => {
    assert.deepEqual(stripNulls({ theme: { logo: null }, texts: {}, general: { skipCart: 'off' } }), {
      general: { skipCart: 'off' },
    });
  });
});

describe('paths and diff', () => {
  it('reads and writes dotted paths without mutating', () => {
    const base = cfg();
    const next = setPath(base, 'theme.cornerRadius', 4);
    assert.equal(getPath(next, 'theme.cornerRadius'), 4);
    assert.equal(base.theme.cornerRadius, 20);
    assert.equal(getPath(base, 'nope.deeper'), undefined);
    assert.equal(getPath(setPath(base, 'texts.cartTitle', undefined), 'texts.cartTitle'), undefined);
  });

  it('layerHas sees set leaves and non-empty dicts', () => {
    const layer = { theme: { logo: null, primaryColor: '#000000' }, texts: {} };
    assert.equal(layerHas(layer, 'theme.primaryColor'), true);
    assert.equal(layerHas(layer, 'theme'), true);
    assert.equal(layerHas(layer, 'theme.logo'), false);
    assert.equal(layerHas(layer, 'texts'), false);
    assert.equal(layerHas(layer, 'general'), false);
  });

  it('diffs leaves by path, lists and MediaRefs as one value', () => {
    const a = cfg();
    const b = cfg({ theme: { logo, cornerRadius: 10 }, general: { serviceTypes: ['eat_in'] }, texts: { cartTitle: 'x' } });
    const changes = diffKioskConfigs(a, b).map((c) => c.path).sort();
    assert.deepEqual(changes, ['general.serviceTypes', 'texts.cartTitle', 'theme.cornerRadius', 'theme.logo']);
    const logoChange = diffKioskConfigs(a, b).find((c) => c.path === 'theme.logo');
    assert.equal(logoChange?.before, null);
    assert.deepEqual(logoChange?.after, logo);
  });
});

describe('validateKioskConfig', () => {
  const codes = (c: KioskConfig, opts = {}) => validateKioskConfig(c, opts).map((e) => `${e.path}:${e.code}`);

  it('accepts the defaults', () => {
    assert.deepEqual(codes(cfg()), []);
  });

  it('refuses bad colours, ranges and fonts', () => {
    const c = cfg({ theme: { primaryColor: 'blue', buttonColor: '#12345', cornerRadius: 41, font: 'comic' } });
    assert.deepEqual(codes(c).sort(), [
      'theme.buttonColor:color',
      'theme.cornerRadius:range',
      'theme.font:unknownFont',
      'theme.primaryColor:color',
    ]);
  });

  it('needs the warning shorter than the inactivity timer', () => {
    assert.ok(codes(cfg({ timers: { inactivitySec: 30, warningSec: 30 } })).includes('timers.warningSec:warningBelowInactivity'));
    assert.deepEqual(codes(cfg({ timers: { inactivitySec: 30, warningSec: 29 } })), []);
    assert.ok(codes(cfg({ timers: { inactivitySec: 10 } })).includes('timers.inactivitySec:range'));
  });

  it('needs a bon printer for single mode', () => {
    assert.ok(codes(cfg({ printing: { bonMode: 'single' } })).includes('printing.bonPrinterId:bonPrinterRequired'));
    assert.deepEqual(codes(cfg({ printing: { bonMode: 'single', bonPrinterId: 'p1' } })), []);
  });

  it('refuses KDS while it is not available', () => {
    assert.ok(codes(cfg({ general: { fulfillmentMode: 'KDS' } })).includes('general.fulfillmentMode:kds_not_available'));
    assert.deepEqual(codes(cfg({ general: { fulfillmentMode: 'KDS' } }), { kdsAvailable: true }), []);
  });

  it('refuses unknown text keys and long texts', () => {
    const c = cfg({ texts: { madeUp: 'x', cartTitle: 'y'.repeat(201) } });
    assert.deepEqual(codes(c).sort(), ['texts.cartTitle:tooLong', 'texts.madeUp:unknownTextKey']);
  });

  it('checks service types, languages, cash and tips', () => {
    assert.ok(codes(cfg({ general: { serviceTypes: [] } })).includes('general.serviceTypes:atLeastOne'));
    assert.ok(codes(cfg({ general: { languages: ['he', 'he'] } })).includes('general.languages:enum'));
    assert.ok(codes(cfg({ payment: { methods: ['card', 'cash'] } })).includes('payment.methods:cash_not_supported'));
    assert.ok(codes(cfg({ payment: { tipPresets: [5, 10, 15, 20, 25] } })).includes('payment.tipPresets:tooMany'));
    assert.ok(codes(cfg({ payment: { tipPresets: [0] } })).includes('payment.tipPresets:range'));
  });

  it('checks the pickup numbering', () => {
    assert.ok(codes(cfg({ pickup: { prefix: 'ABCD' } })).includes('pickup.prefix:pickupPrefix'));
    assert.ok(codes(cfg({ pickup: { prefix: 'A!' } })).includes('pickup.prefix:pickupPrefix'));
    assert.deepEqual(codes(cfg({ pickup: { prefix: 'א-1' } })), []);
    assert.ok(codes(cfg({ pickup: { start: 50, max: 50 } })).includes('pickup.start:startBelowMax'));
    assert.ok(codes(cfg({ pickup: { max: 10000 } })).includes('pickup.max:range'));
    assert.ok(codes(cfg({ pickup: { start: 1, max: 1 } })).includes('pickup.max:range'));
  });

  it('applies the server cross-field rules: tips need presets, hours need a range, only a banner opens a product', () => {
    assert.ok(codes(cfg({ payment: { tipEnabled: true, tipPresets: [] } })).includes('payment.tipPresets:tipPresetsRequired'));
    assert.deepEqual(codes(cfg({ payment: { tipEnabled: false, tipPresets: [] } })), []);
    assert.ok(codes(cfg({ hours: { enabled: true, ranges: [] } })).includes('hours.ranges:atLeastOne'));
    const notice = {
      id: 'n1', kind: 'notice', enabled: true, title: 'x', body: '', image: null, screens: ['catalog'],
      style: 'info', productId: 'p1', startsAt: null, endsAt: null,
    };
    assert.deepEqual(codes(cfg({ messages: [notice] })), ['messages.0.productId:bannerOnly']);
  });

  it('checks messages: ids, lengths, dates', () => {
    const msg = {
      id: 'm1',
      kind: 'banner',
      enabled: true,
      title: 'x'.repeat(81),
      body: '',
      image: null,
      screens: ['attract'],
      style: 'promo',
      productId: null,
      startsAt: '2026-10-07T10:00:00Z',
      endsAt: '2026-10-07T09:00:00Z',
    };
    const c = cfg({ messages: [msg, { ...msg, title: 'ok', startsAt: null, endsAt: null }] });
    assert.deepEqual(codes(c).sort(), ['messages.0.endsAt:endsBeforeStarts', 'messages.0.title:tooLong', 'messages.1.id:duplicate']);
  });

  it('checks media refs, hours, club and the daily close time', () => {
    const bad = { url: 'ftp://x', kind: 'image', sha256: 'XYZ', bytes: 1 };
    const c = cfg({
      theme: { backgroundImage: bad },
      hours: { ranges: [{ days: [], open: '25:00', close: '10:00' }] },
      club: { enabled: true, joinUrl: 'example.com' },
      operations: { autoCloseAt: '4:00' },
    });
    assert.deepEqual(codes(c).sort(), [
      'club.joinUrl:url',
      'hours.ranges.0.days:atLeastOne',
      'hours.ranges.0.open:time',
      'operations.autoCloseAt:time',
      'theme.backgroundImage.sha256:mediaSha',
      'theme.backgroundImage.url:mediaUrl',
    ]);
    assert.deepEqual(codes(cfg({ operations: { autoCloseAt: '04:00' }, club: { enabled: true, joinUrl: 'https://x.co/j' } })), []);
  });

  it('caps the playlist durations and the featured row', () => {
    const item = { media: logo, durationSec: 1 };
    assert.ok(codes(cfg({ attract: { playlist: [item] } })).includes('attract.playlist.0.durationSec:range'));
    const ids = Array.from({ length: 13 }, (_, i) => `p${i}`);
    assert.ok(codes(cfg({ catalog: { featuredProductIds: ids } })).includes('catalog.featuredProductIds:tooMany'));
  });
});

describe('kioskCatalogView', () => {
  const categories = [{ id: 'drinks' }, { id: 'mains' }, { id: 'desserts' }, { id: 'empty' }];
  const products = [
    { id: 'cola', categoryId: 'drinks' },
    { id: 'water', categoryId: 'drinks' },
    { id: 'juice', categoryId: 'drinks', available: false },
    { id: 'burger', categoryId: 'mains' },
    { id: 'salad', categoryId: 'mains' },
    { id: 'cake', categoryId: 'desserts' },
    { id: 'orphan', categoryId: null },
  ];
  const view = (catalog: Partial<KioskConfig['catalog']>, soldOutMode: 'disable' | 'hide' = 'disable', includeHidden = false) =>
    kioskCatalogView(
      categories,
      products,
      { catalog: { ...KIOSK_DEFAULTS.catalog, ...catalog }, general: { soldOutMode } },
      { includeHidden },
    );
  const shape = (v: ReturnType<typeof view>) =>
    v.categories.map((c) => `${c.category.id}:${c.products.map((p) => p.product.id).join(',')}`);

  it("keeps the till's order when the kiosk sets none, and drops empty categories", () => {
    assert.deepEqual(shape(view({})), ['drinks:cola,water,juice', 'mains:burger,salad', 'desserts:cake']);
  });

  it('puts the listed categories first and the rest after them in the till order', () => {
    assert.deepEqual(shape(view({ categoryOrder: ['desserts', 'gone'] })), [
      'desserts:cake',
      'drinks:cola,water,juice',
      'mains:burger,salad',
    ]);
  });

  it('puts the listed products first in their category, the rest after', () => {
    assert.deepEqual(shape(view({ productOrder: { drinks: ['juice', 'cola'], mains: ['salad'] } })), [
      'drinks:juice,cola,water',
      'mains:salad,burger',
      'desserts:cake',
    ]);
  });

  it('leaves hidden categories and products out, and a category emptied by hiding', () => {
    assert.deepEqual(shape(view({ hiddenCategories: ['mains'], hiddenProducts: ['cake', 'water'] })), ['drinks:cola,juice']);
  });

  it('marks sold-out products, or leaves them out in hide mode', () => {
    const disabled = view({});
    assert.equal(disabled.categories[0].products.find((p) => p.product.id === 'juice')?.soldOut, true);
    assert.deepEqual(shape(view({}, 'hide')), ['drinks:cola,water', 'mains:burger,salad', 'desserts:cake']);
  });

  it('keeps everything, marked, for the editor', () => {
    const v = view({ hiddenCategories: ['mains'], hiddenProducts: ['cake'] }, 'disable', true);
    assert.deepEqual(shape(v), ['drinks:cola,water,juice', 'mains:burger,salad', 'desserts:cake', 'empty:']);
    assert.equal(v.categories[1].hidden, true);
    assert.equal(v.categories[2].products[0].hidden, true);
  });

  it('builds the featured row in its own order from shown products only', () => {
    const v = view({ featuredProductIds: ['cake', 'burger', 'missing', 'water'], hiddenProducts: ['water'] });
    assert.deepEqual(
      v.featured.map((p) => p.product.id),
      ['cake', 'burger'],
    );
    assert.equal(v.categories[1].products[0].featured, true);
  });

  it('gives the full product order of a category for saving', () => {
    assert.deepEqual(categoryProductIds(products, 'drinks', { drinks: ['juice'] }), ['juice', 'cola', 'water']);
    assert.deepEqual(categoryProductIds(products, 'mains', undefined), ['burger', 'salad']);
  });
});

describe('helpers', () => {
  it('labels pickup numbers like the server', () => {
    assert.equal(pickupLabel('A', 17), 'A-17');
    assert.equal(pickupLabel('', 17), '17');
    assert.equal(pickupLabel(null, 5), '5');
    assert.equal(pickupLabel(' B ', 3), 'B-3');
  });

  it('moves and toggles', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -2), ['c', 'a', 'b']);
    assert.deepEqual(moveItem(['a'], 5, 1), ['a']);
    assert.deepEqual(toggleInList(['a', 'b'], 'a'), ['b']);
    assert.deepEqual(toggleInList(['a'], 'b'), ['a', 'b']);
  });

  it('picks a free message id', () => {
    assert.equal(nextMessageId([]), 'm1');
    assert.equal(nextMessageId([{ id: 'm2' }]), 'm3');
    assert.equal(nextMessageId([{ id: 'm1' }, { id: 'm3' }]), 'm4');
  });

  it('resolves theme colours and contrast', () => {
    const light = resolveThemeColors(KIOSK_DEFAULTS.theme);
    assert.equal(light.button, KIOSK_DEFAULTS.theme.primaryColor);
    assert.equal(light.buttonText, '#FFFFFF');
    assert.equal(contrastText('#FFE066'), '#111111');
    const dark = resolveThemeColors({ ...KIOSK_DEFAULTS.theme, mode: 'dark', buttonColor: '#FFFFFF', buttonTextColor: '#FF0000' });
    assert.notEqual(dark.background, light.background);
    assert.equal(dark.buttonText, '#FF0000');
  });

  it('maps shapes and densities', () => {
    assert.equal(buttonRadius({ buttonShape: 'pill', cornerRadius: 20 }), 999);
    assert.equal(buttonRadius({ buttonShape: 'rounded', cornerRadius: 20 }), 12);
    assert.equal(buttonRadius({ buttonShape: 'square', cornerRadius: 20 }), 4);
    assert.equal(gridColumns('comfortable', false), 2);
    assert.equal(gridColumns('compact', true), 4);
  });

  it('builds the Google Fonts URL for the preview', () => {
    assert.equal(googleFontsCssUrl([FONT_CATALOG[0]]), null);
    const url = googleFontsCssUrl(FONT_CATALOG.filter((f) => f.id === 'rubik' || f.id === 'alef' || f.id === 'suez_one'));
    assert.equal(
      url,
      'https://fonts.googleapis.com/css2?family=Rubik:wght@400..800&family=Alef:wght@400;700&family=Suez+One&display=swap',
    );
  });

  it('never reads an offline kiosk as live, and only "printed" as printed', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    assert.equal(kioskConnection({ online: true, lastKioskSyncAt: null, lastSeenAt: '2026-10-06T11:59:30Z' }, now), 'online');
    assert.equal(kioskConnection({ online: true, lastKioskSyncAt: '2026-10-06T11:55:00Z', lastSeenAt: '2026-10-06T11:55:00Z' }, now), 'stale');
    assert.equal(kioskConnection({ online: false, lastKioskSyncAt: '2026-10-06T11:55:00Z', lastSeenAt: null }, now), 'stale');
    assert.equal(kioskConnection({ online: false, lastKioskSyncAt: '2026-10-06T10:00:00Z', lastSeenAt: null }, now), 'offline');
    assert.equal(kioskConnection({ online: false, lastKioskSyncAt: null, lastSeenAt: null }, now), 'never');
    assert.equal(bonPrinted('printed'), true);
    assert.equal(bonPrinted('sent'), false);
    assert.equal(bonPrinted('queued'), false);
  });

  it('gives the calendar day in a time zone', () => {
    assert.equal(isoDayInZone(new Date('2026-10-06T22:30:00Z'), 'Asia/Jerusalem'), '2026-10-07');
    assert.equal(isoDayInZone(new Date('2026-10-06T22:30:00Z'), 'UTC'), '2026-10-06');
  });
});

describe('"סגנון ממשק" presets', () => {
  const presetOf = (cfg: KioskConfig) => Object.fromEntries(PRESET_THEME_KEYS.map((k) => [k, cfg.theme[k]]));

  it('wolt is the default look, and the defaults hold it', () => {
    assert.equal(KIOSK_DEFAULTS.theme.uiStyle, 'wolt');
    assert.deepEqual(presetOf(KIOSK_DEFAULTS), KIOSK_UI_PRESETS.wolt);
    assert.deepEqual(resolveKioskConfig(), KIOSK_DEFAULTS);
  });

  it('resolves each style to its preset values, like the server', () => {
    for (const style of UI_STYLES) {
      const cfg = resolveKioskConfig({ theme: { uiStyle: style } });
      assert.equal(cfg.theme.uiStyle, style);
      assert.deepEqual(presetOf(cfg), KIOSK_UI_PRESETS[style], style);
    }
  });

  it('lets an explicit value at any level beat the preset; the last layer that sets the style picks it', () => {
    const company = { theme: { primaryColor: '#FF6600' } };
    const shop = { theme: { uiStyle: 'minimal_dark' } };
    const kiosk = { theme: { cornerRadius: 30 } };
    const cfg = resolveKioskConfig(company, shop, kiosk);
    assert.equal(cfg.theme.uiStyle, 'minimal_dark');
    assert.equal(cfg.theme.primaryColor, '#FF6600');
    assert.equal(cfg.theme.cornerRadius, 30);
    assert.equal(cfg.theme.mode, 'dark');
    assert.equal(styleOf(shop, { theme: { uiStyle: 'classic' } }), 'classic');
    assert.equal(styleOf(shop, { theme: { uiStyle: null } }), 'minimal_dark');
    assert.equal(styleOf({ theme: { uiStyle: 'material' } }), 'wolt');
    assert.deepEqual(presetLayer('ios'), { theme: KIOSK_UI_PRESETS.ios, attract: { cta: KIOSK_UI_PRESET_CTA.ios } });
  });

  it('repairs what a parent change broke below it, like the server', () => {
    const broken = deepMergeKiosk(KIOSK_DEFAULTS, {
      timers: { inactivitySec: 20, warningSec: 30 },
      printing: { bonMode: 'single' },
      club: { enabled: true, joinUrl: '' },
      general: { fulfillmentMode: 'KDS' },
      payment: { tipEnabled: true, tipPresets: [] },
      hours: { enabled: true, ranges: [] },
      pickup: { start: 10, max: 5 },
    });
    const fixed = repairKioskConfig(broken);
    assert.equal(fixed.timers.warningSec, 19);
    assert.equal(fixed.printing.bonMode, 'routing');
    assert.equal(fixed.club.enabled, false);
    assert.equal(fixed.general.fulfillmentMode, 'BON');
    assert.deepEqual(fixed.payment.tipPresets, [10, 12, 15]);
    assert.equal(fixed.hours.enabled, false);
    assert.deepEqual([fixed.pickup.start, fixed.pickup.max], [1, 999]);
  });

  it('rebases what a level inherits onto its style, keeping what the parents set (inheritedLayers)', () => {
    const parents = { theme: { uiStyle: 'ios', cornerRadius: 9 } };
    const inherited = resolveKioskConfig(parents);
    assert.equal(inherited.theme.typeScale, 'large');
    const base = rebaseInherited(inherited, parents, 'classic');
    assert.equal(base.theme.uiStyle, 'ios'); // the parents' style; the level's own pick is its override
    assert.equal(base.theme.cornerRadius, 9); // explicit in a parent: kept
    assert.equal(base.theme.typeScale, 'xlarge'); // followed the preset: now the classic one
    assert.equal(base.theme.font, 'heebo');
    assert.equal(base.theme.textColor, '#000000');
    // Back on the parents' own style it is what they gave.
    assert.deepEqual(rebaseInherited(inherited, parents, 'ios'), inherited);
    // Onto wolt, a preset's null colour goes back to the default (null).
    assert.equal(rebaseInherited(inherited, parents, 'wolt').theme.backgroundColor, null);
  });

  it('rebases without inheritedLayers by comparing with the parents own preset', () => {
    const inherited = resolveKioskConfig({ theme: { uiStyle: 'ios', cornerRadius: 9 } });
    const base = rebaseInherited(inherited, null, 'minimal_dark');
    assert.equal(base.theme.cornerRadius, 9); // differs from the ios preset: taken as explicit
    assert.equal(base.theme.mode, 'dark');
    assert.equal(base.theme.typeWeight, 'light');
  });

  it('a draft that follows the style saves nothing but the style; switching keeps explicit values', () => {
    const parents = { theme: { cornerRadius: 9 } };
    const inherited = resolveKioskConfig(parents);
    const draft = deepMergeKiosk(inherited, { theme: { primaryColor: '#123456' } });
    const oldBase = rebaseInherited(inherited, parents, draft.theme.uiStyle);
    const newBase = rebaseInherited(inherited, parents, 'classic');
    const next = switchUiStyle(draft, oldBase, newBase, 'classic');
    assert.equal(next.theme.uiStyle, 'classic');
    assert.equal(next.theme.primaryColor, '#123456'); // chosen here: stays
    assert.equal(next.theme.cornerRadius, 9); // the parent's explicit value: stays
    assert.equal(next.theme.cartStyle, 'panel'); // followed the preset: moves
    assert.equal(next.theme.categoryStyle, 'images');
    assert.deepEqual(pruneOverrides(newBase, next), { theme: { uiStyle: 'classic', primaryColor: '#123456' } });
    // What the kiosk then gets is exactly the draft.
    assert.deepEqual(resolveKioskConfig(parents, pruneOverrides(newBase, next)), next);
  });
});

describe('preview rules', () => {
  const ref = (url: string): MediaRef => ({ url, kind: 'image', sha256: null, bytes: null });

  it('picks the rail image: the kiosk image, then the catalog image, then none (an initial)', () => {
    const cat = { categoryImages: { a: ref('https://k/a.png') } };
    const tillImages = { a: 'https://t/a.png', b: 'https://t/b.png' };
    assert.equal(categoryRailImage('a', cat, tillImages), 'https://k/a.png');
    assert.equal(categoryRailImage('b', cat, tillImages), 'https://t/b.png');
    assert.equal(categoryRailImage('c', cat, tillImages), null);
    assert.equal(categoryRailImage('c', { categoryImages: {} }, { c: '' }), null);
  });

  it('places messages centred: inline on the calm screens, an overlay while ordering, never on pay', () => {
    for (const s of ['attract', 'success', 'paused', 'closed']) assert.equal(messagePlacement(s), 'inline-center');
    for (const s of ['service', 'catalog', 'cart']) assert.equal(messagePlacement(s), 'overlay-center');
    assert.equal(messagePlacement('pay'), 'none');
    assert.equal(messagePlacement('product'), 'none');
  });

  it('turns all motion off with reduceMotion, and scales it by the animation level', () => {
    assert.deepEqual(motionSpec({ animation: 'lively' }, { reduceMotion: true }), { flyMs: 0, bounce: 0, countUpMs: 0, flyImage: false });
    assert.deepEqual(motionSpec({ animation: 'subtle' }, { reduceMotion: true }), { flyMs: 0, bounce: 0, countUpMs: 0, flyImage: false });
    const subtle = motionSpec({ animation: 'subtle' }, { reduceMotion: false });
    const lively = motionSpec({ animation: 'lively' }, { reduceMotion: false });
    assert.equal(subtle.flyImage, false);
    assert.equal(lively.flyImage, true);
    assert.ok(subtle.flyMs > 0 && subtle.flyMs < lively.flyMs && lively.flyMs < 600);
    assert.ok(lively.bounce > subtle.bounce && subtle.bounce > 1);
  });

  it('keeps only known dietary tags, once, in the fixed order', () => {
    assert.deepEqual(dietaryTagsOf(['spicy', 'vegan', 'spicy', 'keto', 3]), ['vegan', 'spicy']);
    assert.deepEqual(dietaryTagsOf(undefined), []);
    assert.deepEqual(dietaryTagsOf('vegan'), []);
  });

  it('scales and weighs the type', () => {
    assert.deepEqual([typeScaleFactor('normal'), typeScaleFactor('large'), typeScaleFactor('xlarge')], [1, 1.12, 1.25]);
    assert.ok(typeWeights('light').bold < typeWeights('regular').bold && typeWeights('regular').bold < typeWeights('bold').bold);
    assert.equal(typeWeights('bold').bold, 700);
  });

  it('knows the no-payment and offline screen texts', () => {
    for (const key of ['noPaymentTitle', 'noPaymentBody', 'offlineTitle', 'offlineBody']) {
      assert.ok((TEXT_KEYS as readonly string[]).includes(key), key);
    }
  });

  it('reads a kiosk as offline after 2 minutes unseen, never seen, or not online', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const seen = (sec: number) => new Date(now - sec * 1000).toISOString();
    assert.equal(kioskOffline({ online: true, lastSeenAt: seen(5) }, now), false);
    assert.equal(kioskOffline({ online: true, lastSeenAt: seen(119) }, now), false);
    assert.equal(kioskOffline({ online: true, lastSeenAt: seen(121) }, now), true);
    assert.equal(kioskOffline({ online: true, lastSeenAt: null }, now), true);
    assert.equal(kioskOffline({ online: false, lastSeenAt: seen(5) }, now), true);
    assert.equal(kioskOffline({ online: true, lastSeenAt: seen(200) }, now, 300_000), false);
  });
});

describe('validation of the new keys', () => {
  const codes = (c: KioskConfig) => validateKioskConfig(c).map((e) => `${e.path}:${e.code}`);

  it('accepts every style and the new enums', () => {
    for (const style of UI_STYLES) assert.deepEqual(codes(resolveKioskConfig({ theme: { uiStyle: style } })), [], style);
    const c = cfg({
      theme: { categoryLayout: 'top', typeScale: 'xlarge', typeWeight: 'light', cartStyle: 'panel', animation: 'subtle' },
      general: { showDietary: false, reduceMotion: true, offlineSound: true },
      texts: { noPaymentTitle: 'x', noPaymentBody: 'y', offlineTitle: 'z', offlineBody: 'w' },
    });
    assert.deepEqual(codes(c), []);
  });

  it('refuses unknown values and non-booleans', () => {
    const c = cfg({
      theme: { uiStyle: 'material', categoryLayout: 'bottom', typeScale: 'huge', typeWeight: 'black', cartStyle: 'drawer', animation: 'crazy' },
      general: { showDietary: 'yes', reduceMotion: 1, offlineSound: null },
    });
    // A null in a layer inherits: offlineSound stays a boolean.
    assert.deepEqual(codes(c).sort(), [
      'general.reduceMotion:enum',
      'general.showDietary:enum',
      'theme.animation:enum',
      'theme.cartStyle:enum',
      'theme.categoryLayout:enum',
      'theme.typeScale:enum',
      'theme.typeWeight:enum',
      'theme.uiStyle:enum',
    ]);
  });
});

describe('"כפתור מסך הפתיחה" — the attract button', () => {
  const base: KioskCta = KIOSK_DEFAULTS.attract.cta;
  const make = (patch: Partial<KioskCta>): KioskCta => ({ ...base, ...patch });
  const at = (b: { x: number; y: number }) => [b.x, b.y];

  it('defaults to the wolt button the kiosk always had, tap-anywhere on', () => {
    for (const key of PRESET_CTA_KEYS) assert.deepEqual(base[key], KIOSK_UI_PRESET_CTA.wolt[key], key);
    assert.equal(base.position, 'bottom_full');
    assert.equal(base.tapAnywhere, true);
    assert.equal(base.fillColor, null);
  });

  it('each style brings its own button; explicit values beat it at any level', () => {
    for (const style of UI_STYLES) {
      const c = resolveKioskConfig({ theme: { uiStyle: style } }).attract.cta;
      for (const key of PRESET_CTA_KEYS) {
        assert.deepEqual(c[key], KIOSK_UI_PRESET_CTA[style][key] ?? base[key], `${style}.${key}`);
      }
    }
    assert.equal(resolveKioskConfig({ theme: { uiStyle: 'minimal_dark' } }).attract.cta.borderColor, '#C9A227');
    const c = resolveKioskConfig(
      { attract: { cta: { position: 'custom', x: 30, y: 70 } } },
      { theme: { uiStyle: 'classic' } },
      { attract: { cta: { animation: 'none', subtitle: 'touch' } } },
    ).attract.cta;
    assert.deepEqual([c.position, c.x, c.y, c.animation, c.subtitle], ['custom', 30, 70, 'none', 'touch']);
    assert.deepEqual([c.size, c.icon, c.iconPosition, c.fontWeight], ['xl', 'cart', 'start', 'black']);
  });

  it('rebases and switches the button with the style, keeping explicit values', () => {
    const parents = { attract: { cta: { icon: 'star' } } };
    const inherited = resolveKioskConfig(parents);
    const draft = deepMergeKiosk(inherited, { attract: { cta: { fontSize: 40 } } });
    const oldBase = rebaseInherited(inherited, parents, 'wolt');
    const newBase = rebaseInherited(inherited, parents, 'minimal_dark');
    assert.equal(newBase.attract.cta.icon, 'star'); // a parent's explicit value
    assert.equal(newBase.attract.cta.position, 'bottom_center');
    const next = switchUiStyle(draft, oldBase, newBase, 'minimal_dark');
    assert.equal(next.attract.cta.fontSize, 40); // chosen here
    assert.equal(next.attract.cta.icon, 'star');
    assert.deepEqual([next.attract.cta.size, next.attract.cta.animation, next.attract.cta.borderWidth], ['m', 'glow', 1]);
    assert.deepEqual(pruneOverrides(newBase, next), { theme: { uiStyle: 'minimal_dark' }, attract: { cta: { fontSize: 40 } } });
    assert.deepEqual(resolveKioskConfig(parents, pruneOverrides(newBase, next)), next);
    // Without inheritedLayers: a value off the parents' own preset counts as theirs.
    assert.equal(rebaseInherited(inherited, null, 'classic').attract.cta.icon, 'star');
    assert.equal(rebaseInherited(inherited, null, 'classic').attract.cta.size, 'xl');
  });

  it('sizes by screen, the full width at the bottom, never below a finger', () => {
    assert.deepEqual(ctaSize(make({ size: 'l', position: 'bottom_center' }), 800, 1280), { w: 560, h: 84 });
    assert.deepEqual(ctaSize(make({ size: 'xl', position: 'bottom_center' }), 800, 1280), { w: 680, h: 112 });
    assert.deepEqual(ctaSize(make({ size: 'm', position: 'top_left' }), 800, 1280), { w: 440, h: 72 });
    assert.deepEqual(ctaSize(make({ size: 'l' }), 800, 1280), { w: 744, h: 84 });
    assert.equal(ctaSize(make({ size: 's', position: 'top_left' }), 360, 640).w, 160);
    assert.equal(ctaSize(make({ size: 'custom', widthPct: 100, position: 'top_left' }), 360, 640).w, 304);
    assert.equal(ctaSize(make({ size: 'custom', heightDp: 200 }), 360, 640).h, 192);
    assert.equal(ctaSize(make({ size: 'xl' }), 320, 150).h, 56);
    assert.deepEqual(ctaSize(make({ size: 'm', position: 'top_right' }), 1280, 800), { w: 704, h: 72 });
    assert.deepEqual(ctaSize(make({ size: 'l' }), 1920, 1080), { w: 1864, h: 84 });
  });

  it('places the 3x3 grid physically (right is the screen right): 800x1280, size m', () => {
    const m = make({ size: 'm' });
    assert.deepEqual(at(ctaBox({ ...m, position: 'top_right' }, 800, 1280)), [332, 150]);
    assert.deepEqual(at(ctaBox({ ...m, position: 'top_left' }, 800, 1280)), [28, 150]);
    assert.deepEqual(at(ctaBox({ ...m, position: 'middle_center' }, 800, 1280)), [180, 604]);
    assert.equal(ctaBox({ ...m, position: 'bottom_center' }, 800, 1280).y, 1148);
    assert.equal(ctaBox({ ...m, position: 'bottom_center', tapAnywhere: false }, 800, 1280).y, 1180);
    assert.deepEqual(ctaBox(make({ size: 'l' }), 800, 1280), { x: 28, y: 1136, w: 744, h: 84 });
    assert.equal(ctaBox({ ...m, position: 'top_right' }, 1280, 800).x, 1280 - 28 - 704);
    assert.deepEqual(ctaBox({ ...m, position: 'middle_left' }, 1920, 1080), { x: 28, y: 504, w: 1056, h: 72 });
    assert.deepEqual(ctaBox(make({ size: 'l' }), 360, 640), { x: 28, y: 640 - 60 - 84, w: 304, h: 84 });
  });

  it('keeps a custom place (the centre, in percent) on the screen', () => {
    const m = make({ size: 'm', position: 'custom' });
    assert.deepEqual(at(ctaBox({ ...m, x: 50, y: 50 }, 800, 1280)), [180, 604]);
    assert.deepEqual(at(ctaBox({ ...m, x: 0, y: 0 }, 800, 1280)), [28, 28]);
    assert.deepEqual(at(ctaBox({ ...m, x: 100, y: 100 }, 800, 1280)), [332, 1180]);
    const b = ctaBox({ ...m, x: 50, y: 50 }, 1080, 1920);
    assert.equal(b.x + Math.trunc(b.w / 2), 540);
  });

  it('fits every size and place on every screen and stays touchable', () => {
    const screens: Array<[number, number]> = [[360, 640], [600, 1024], [800, 1280], [1080, 1920], [1280, 800], [1920, 1080], [320, 200]];
    for (const [w, h] of screens) {
      for (const size of CTA_SIZES) {
        for (const position of CTA_POSITIONS) {
          for (const tapAnywhere of [true, false]) {
            const b = ctaBox(make({ size, position, x: 95, y: 5, widthPct: 100, heightDp: 200, tapAnywhere }), w, h);
            const what = `${size}/${position} on ${w}x${h}`;
            assert.ok(b.h >= CTA_LAYOUT.MIN_H, what);
            assert.ok(b.w >= Math.min(CTA_LAYOUT.MIN_W, w - 2 * CTA_LAYOUT.MARGIN), what);
            assert.ok(b.x >= 0 && b.x + b.w <= w, what);
            assert.ok(b.y >= 0 && b.y + b.h <= h, what);
          }
        }
      }
    }
  });

  it('fits the label, and the motion rules', () => {
    assert.equal(ctaFontSp(make({ fontSize: 24 }), 84), 24);
    assert.equal(ctaFontSp(make({ fontSize: 64 }), 84), 37);
    const two = make({ fontSize: 64, subtitle: 'touch to start' });
    assert.equal(ctaFontSp(two, 84), 28);
    assert.equal(ctaSubtitleSp(two, 84), 15);
    assert.equal(ctaAnimation(make({ animation: 'bounce' }), { reduceMotion: false }), 'bounce');
    assert.equal(ctaAnimation(make({ animation: 'bounce' }), { reduceMotion: true }), 'none');
    assert.equal(ctaBounceLift(0), 0);
    assert.ok(Math.abs(ctaBounceLift(0.0999) - 1) < 0.01);
    assert.equal(ctaBounceLift(0.5), 0);
    for (let i = 0; i <= 100; i++) assert.ok(ctaBounceLift(i / 100) >= 0 && ctaBounceLift(i / 100) <= 1);
    assert.equal(ctaRadiusPx(make({ radius: 100 }), 84, KIOSK_DEFAULTS.theme), 42);
    assert.equal(ctaRadiusPx(make({ radius: 0 }), 84, KIOSK_DEFAULTS.theme), 0);
    assert.equal(ctaRadiusPx(make({ radius: null }), 84, KIOSK_DEFAULTS.theme), 42); // the pill theme
    assert.equal(ctaRadiusPx(make({ radius: null }), 84, { buttonShape: 'square', cornerRadius: 20 }), 4);
  });

  it('validates the button', () => {
    const codes = (c: KioskConfig) => validateKioskConfig(c).map((e) => `${e.path}:${e.code}`);
    const ok = { size: 'custom', widthPct: 20, heightDp: 56, position: 'custom', x: 0, y: 100, radius: 0, borderWidth: 8, fontSize: 64 };
    assert.deepEqual(codes(cfg({ attract: { cta: ok } })), []);
    const bad = cfg({
      attract: {
        cta: {
          size: 'huge', widthPct: 10, heightDp: 300, position: 'corner', x: 101, y: -1, fillColor: 'red',
          fontSize: 12, fontWeight: 'thin', radius: 120, borderWidth: 9, shadow: 'yes', icon: 'rocket',
          iconPosition: 'middle', animation: 'spin', subtitle: 'x'.repeat(81), tapAnywhere: 1,
        },
      },
    });
    assert.deepEqual(codes(bad).sort(), [
      'attract.cta.animation:enum',
      'attract.cta.borderWidth:range',
      'attract.cta.fillColor:color',
      'attract.cta.fontSize:range',
      'attract.cta.fontWeight:enum',
      'attract.cta.heightDp:range',
      'attract.cta.icon:enum',
      'attract.cta.iconPosition:enum',
      'attract.cta.position:enum',
      'attract.cta.radius:range',
      'attract.cta.shadow:enum',
      'attract.cta.size:enum',
      'attract.cta.subtitle:tooLong',
      'attract.cta.tapAnywhere:enum',
      'attract.cta.widthPct:range',
      'attract.cta.x:range',
      'attract.cta.y:range',
    ]);
  });
});

describe('the attract content around the button (never under it)', () => {
  const base: KioskCta = KIOSK_DEFAULTS.attract.cta;
  const make = (patch: Partial<KioskCta>): KioskCta => ({ ...base, ...patch });
  const header = 136; // the till: status bar 24 + margin 28 + header 84

  it('above a bottom button: the content ends 20 dp over its top, the hint under it', () => {
    const c = make({});
    assert.deepEqual(attractSpans(c, ctaBox(c, 800, 1280), 1280, header), {
      messagesTop: header,
      messagesBottom: 1116,
      stackTop: header,
      stackBottom: 1116,
      shared: true,
      hint: true,
    });
    const noHint = make({ tapAnywhere: false });
    const sp = attractSpans(noHint, ctaBox(noHint, 800, 1280), 1280, header);
    assert.equal(sp.stackBottom, 1280 - 28 - 84 - 20);
    assert.equal(sp.hint, false);
  });

  it('below a top button, around a middle one, a custom place by its centre', () => {
    const top = make({ size: 'm', position: 'top_center' });
    const t = attractSpans(top, ctaBox(top, 800, 1280), 1280, header);
    assert.deepEqual([t.stackTop, t.stackBottom, t.shared], [150 + 72 + 30 + 20, 1252, true]);
    const mid = make({ size: 'm', position: 'middle_center' });
    const m = attractSpans(mid, ctaBox(mid, 800, 1280), 1280, header);
    assert.deepEqual([m.messagesTop, m.messagesBottom, m.stackTop, m.stackBottom, m.shared], [header, 584, 726, 1252, false]);
    const low = make({ size: 'm', position: 'custom', x: 50, y: 90 });
    assert.equal(attractSpans(low, ctaBox(low, 800, 1280), 1280, header).stackBottom, ctaBox(low, 800, 1280).y - 20);
  });

  it('sections that do not fit are left out, never pushed under the button', () => {
    const heights = [120, 170, 152];
    assert.equal(fittingCount(500, heights, 16, 1), 3);
    assert.equal(fittingCount(320, heights, 16, 1), 2);
    assert.equal(fittingCount(300, heights, 16, 1), 1);
    assert.equal(fittingCount(50, heights, 16, 1), 1);
    assert.equal(fittingCount(100, [], 16, 0), 0);
  });

  it('every style at every size: the shortcuts, the button and its hint never overlap', () => {
    const screens: Array<[number, number]> = [
      [360, 640],
      [600, 1024],
      [800, 1280],
      [1080, 1920],
      [1280, 800],
      [1920, 1080],
      [400, 600], // the preview's tablet frame
      [300, 620], // the preview's phone frame
    ];
    const heights = [110, 170, 152];
    for (const style of Object.keys(KIOSK_UI_PRESET_CTA) as Array<keyof typeof KIOSK_UI_PRESET_CTA>) {
      for (const size of ['s', 'm', 'l', 'xl'] as const) {
        for (const [w, h] of screens) {
          for (const tapAnywhere of [true, false]) {
            const c = make({ ...KIOSK_UI_PRESET_CTA[style], size, tapAnywhere });
            const b = ctaBox(c, w, h);
            const sp = attractSpans(c, b, h, header);
            const what = `${style}/${size} on ${w}x${h} tap=${tapAnywhere}`;
            const span = sp.stackBottom - sp.stackTop;
            const keep = fittingCount(span, heights, 16, 1);
            const used = heights.slice(0, keep).reduce((a, x) => a + x, 0) + 16 * Math.max(0, keep - 1);
            const stackTop = sp.stackBottom - Math.min(used, span);
            const buttonBottom = b.y + b.h + (sp.hint ? CTA_HINT_BLOCK : 0);
            assert.ok(!(stackTop < buttonBottom && sp.stackBottom > b.y), what);
            assert.ok(sp.stackBottom <= b.y - ATTRACT_CONTENT_GAP || stackTop >= buttonBottom, what);
            if (sp.hint) assert.ok(b.y + b.h + CTA_HINT_BLOCK <= h, what);
          }
        }
      }
    }
  });

  it('the side order panel only on a wide screen (a landscape kiosk), as on the till', () => {
    const classic = { cartStyle: 'panel' as const };
    assert.equal(cartPanelShown(classic, 800), false); // a portrait tablet: the bar
    assert.equal(cartPanelShown(classic, 1280), true);
    assert.equal(cartPanelShown({ cartStyle: 'bar' }, 1920), false);
  });
});

describe('the kiosk screens: their texts exist in he.json', () => {
  // Every literal key the kiosk dashboard code asks for (t('…') under its useTranslations
  // namespaces, and m.t('…') in the preview) must be in the messages: a missing one shows
  // as its raw path ("kiosks.preview.tapToStart") and as a Next dev-overlay issue.
  it('has every literal key', () => {
    const root = join(process.cwd(), 'src');
    const messages = JSON.parse(readFileSync(join(root, 'messages', 'he.json'), 'utf8')) as Record<string, unknown>;
    const has = (path: string) =>
      path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), messages) !== undefined;
    const dir = join(root, 'components', 'dashboard', 'kiosks');
    const missing: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      const spaces = new Map<string, Set<string>>();
      for (const [, name, ns] of src.matchAll(/const\s+(\w+)\s*=\s*useTranslations\(\s*'([^']*)'\s*\)/g)) {
        if (!spaces.has(name)) spaces.set(name, new Set());
        spaces.get(name)!.add(ns);
      }
      if (/m\.t\(/.test(src)) spaces.set('m.t', new Set(['kiosks.preview']));
      for (const [name, set] of spaces) {
        const call = new RegExp(String.raw`(?<![\w.])${name.replace('.', '\\.')}\(\s*'([A-Za-z0-9_.]+)'`, 'g');
        for (const [, key] of src.matchAll(call)) {
          if (![...set].some((ns) => has(ns ? `${ns}.${key}` : key))) missing.push(`${file}: ${[...set].join('|')}.${key}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });
});
