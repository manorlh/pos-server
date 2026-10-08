/**
 * Run with `npm test`. The self-order kiosk's configuration rules (lib/kioskConfig.ts):
 * the layer merge, the minimal layer to save, validation, the kiosk's catalog order and
 * the pickup label — the same rules the server and the till apply.
 */
import { describe, it } from 'node:test';
import { enterCategory, pickKioskUpsell, rulePlaces, upsellActiveAt, upsellTriggers, type UpsellRuleLite } from './kioskUpsell';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  attractTapAnywhere,
  CHECKOUT_STEPS,
  PAYMENT_METHODS,
  kioskAsksPayMethod,
  payMethodAsk,
  kioskPayMethods,
  kioskRemainderAgorot,
  TIP_OTHER_MAX_SHEKELS,
  checkoutBar,
  checkoutStepOrder,
  checkoutStepsNow,
  kioskServiceLook,
  kioskTipAsked,
  tipOtherAgorot,
  tipPercentAgorot,
} from './kioskConfig';

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
  catalogColumns,
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
  addFrame,
  addMs,
  kioskAddPath,
  ADD_MAX_MS,
  ADD_END_ALPHA,
  ADD_END_SCALE,
  ADD_POP_LIFT_DP,
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
  kioskOpenAt,
  kioskScheduleIssues,
  scheduleFormOf,
  scheduleFormHours,
  scheduleFormAutoClose,
  cartPanelShown,
  CTA_HINT_BLOCK,
  ATTRACT_CONTENT_GAP,
  ctaSubtitleSp,
  contrastRatio,
  kioskNextOpening,
  kioskRestLook,
  kioskRestText,
  mixHex,
  REST_DARK_INK,
  REST_LARGE_TEXT_CONTRAST,
  KIOSK_UI_PRESET_MOTION,
  PRESET_MOTION_KEYS,
  CATEGORY_SWITCH_FX,
  ITEMS_ENTER_FX,
  SCREEN_CHANGE_FX,
  SHEET_FX,
  ADD_TO_CART_FX,
  MOTION_EFFECTS,
  MOTION_SPEEDS,
  MOTION_SPEED_FACTOR,
  NO_TRANSITIONS,
  STAGGER_CAP_MS,
  STAGGER_MAX_CARDS,
  TRANSITION_BASE_MS,
  gridEnterMs,
  staggerDelayMs,
  swapSide,
  transitionSpec,
  type KioskConfig,
  type KioskCta,
  type KioskRestTextKey,
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

  it('never shows one catalog column on a wide screen', () => {
    // classic: large cards beside the cart panel
    assert.equal(catalogColumns('large', true, true, true), 2);
    assert.equal(catalogColumns('large', false, false, true), 1);
    assert.equal(catalogColumns('comfortable', true, true, true), 2);
    assert.equal(catalogColumns('comfortable', true, false, true), 3);
    assert.equal(catalogColumns('compact', false, false, true), 2);
    assert.equal(catalogColumns('compact', true, true, true), 3);
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
    assert.deepEqual(presetLayer('ios'), {
      theme: KIOSK_UI_PRESETS.ios,
      attract: { cta: KIOSK_UI_PRESET_CTA.ios },
      motion: KIOSK_UI_PRESET_MOTION.ios,
    });
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

  it('turns the add into a fade with reduceMotion, and scales the pop and arc by the animation level', () => {
    const fade = { popMs: 0, popScale: 1, flyMs: 0, arcDp: 0, fadeMs: 280, bounce: 0, countUpMs: 0 };
    assert.deepEqual(motionSpec({ animation: 'lively' }, { reduceMotion: true }), fade);
    assert.deepEqual(motionSpec({ animation: 'subtle' }, { reduceMotion: true }), fade);
    const subtle = motionSpec({ animation: 'subtle' }, { reduceMotion: false });
    const lively = motionSpec({ animation: 'lively' }, { reduceMotion: false });
    // The same pop-and-fly in both (the picture and the name): only how big and how high differ.
    assert.ok(subtle.popScale < lively.popScale && subtle.arcDp < lively.arcDp);
    assert.ok(addMs(subtle) > 0 && addMs(subtle) < addMs(lively) && addMs(lively) < ADD_MAX_MS);
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
    assert.equal(base.position, 'bottom_center');
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
    assert.deepEqual(ctaSize(make({ size: 'l', position: 'bottom_center' }), 800, 1280), { w: 520, h: 84 });
    assert.deepEqual(ctaSize(make({ size: 'xl', position: 'bottom_center' }), 800, 1280), { w: 640, h: 112 });
    assert.deepEqual(ctaSize(make({ size: 'm', position: 'top_left' }), 800, 1280), { w: 420, h: 72 });
    assert.deepEqual(ctaSize(make({ size: 'l', position: 'bottom_full' }), 800, 1280), { w: 744, h: 84 });
    assert.equal(ctaSize(make({ size: 'l' }), 785, 1396).w, 520);
    assert.equal(ctaSize(make({ size: 's', position: 'top_left' }), 360, 640).w, 160);
    assert.equal(ctaSize(make({ size: 'custom', widthPct: 100, position: 'top_left' }), 360, 640).w, 304);
    assert.equal(ctaSize(make({ size: 'custom', heightDp: 200 }), 360, 640).h, 192);
    assert.equal(ctaSize(make({ size: 'xl' }), 320, 150).h, 56);
    assert.deepEqual(ctaSize(make({ size: 'm', position: 'top_right' }), 1280, 800), { w: 420, h: 72 });
    assert.deepEqual(ctaSize(make({ size: 'l', position: 'bottom_full' }), 1920, 1080), { w: 1864, h: 84 });
  });

  it('places the 3x3 grid physically (right is the screen right): 800x1280, size m', () => {
    const m = make({ size: 'm' });
    assert.deepEqual(at(ctaBox({ ...m, position: 'top_right' }, 800, 1280)), [352, 150]);
    assert.deepEqual(at(ctaBox({ ...m, position: 'top_left' }, 800, 1280)), [28, 150]);
    assert.deepEqual(at(ctaBox({ ...m, position: 'middle_center' }, 800, 1280)), [190, 604]);
    assert.equal(ctaBox({ ...m, position: 'bottom_center' }, 800, 1280).y, 1148);
    assert.equal(ctaBox({ ...m, position: 'bottom_center', tapAnywhere: false }, 800, 1280).y, 1180);
    assert.deepEqual(ctaBox(make({ size: 'l', position: 'bottom_full' }), 800, 1280), { x: 28, y: 1136, w: 744, h: 84 });
    assert.deepEqual(ctaBox(make({ size: 'l' }), 800, 1280), { x: 140, y: 1136, w: 520, h: 84 });
    assert.equal(ctaBox({ ...m, position: 'top_right' }, 1280, 800).x, 1280 - 28 - 420);
    assert.deepEqual(ctaBox({ ...m, position: 'middle_left' }, 1920, 1080), { x: 28, y: 504, w: 420, h: 72 });
    assert.deepEqual(ctaBox(make({ size: 'l', position: 'bottom_full' }), 360, 640), { x: 28, y: 640 - 60 - 84, w: 304, h: 84 });
  });

  it('keeps a custom place (the centre, in percent) on the screen', () => {
    const m = make({ size: 'm', position: 'custom' });
    assert.deepEqual(at(ctaBox({ ...m, x: 50, y: 50 }, 800, 1280)), [190, 604]);
    assert.deepEqual(at(ctaBox({ ...m, x: 0, y: 0 }, 800, 1280)), [28, 28]);
    assert.deepEqual(at(ctaBox({ ...m, x: 100, y: 100 }, 800, 1280)), [352, 1180]);
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

describe('"נעילה למכירה" and "פתיחה אוטומטית" (the server kiosk_schedule.py)', () => {
  const WEEK = [0, 1, 2, 3, 4, 5, 6];
  it('opens by the hours, past midnight, and a range with no close never closes', () => {
    const late = { enabled: true, ranges: [{ days: [5], open: '18:00', close: '02:00' }] };
    assert.equal(kioskOpenAt(late, 5, 23 * 60), true);
    assert.equal(kioskOpenAt(late, 6, 60 + 59), true); // Friday's, past midnight
    assert.equal(kioskOpenAt(late, 6, 2 * 60), false);
    assert.equal(kioskOpenAt(late, 6, 18 * 60 + 30), false);
    assert.equal(kioskOpenAt({ enabled: true, ranges: [{ days: WEEK, open: '07:00', close: null }] }, 1, 3 * 60), true);
    assert.equal(kioskOpenAt({ enabled: false, ranges: [] }, 1, 0), true);
  });
  it('close → automatic Z → open', () => {
    const daily = { enabled: true, ranges: [{ days: WEEK, open: '07:00', close: '23:00' }] };
    assert.deepEqual(kioskScheduleIssues(daily, '23:30'), []);
    assert.deepEqual(kioskScheduleIssues(daily, '23:00'), []);
    assert.equal(kioskScheduleIssues(daily, '22:00')[0].code, 'auto_z_while_open');
    assert.equal(kioskScheduleIssues(daily, '07:00')[0].code, 'auto_z_at_opening');
    assert.deepEqual(kioskScheduleIssues(daily, ''), []);
    const late = { enabled: true, ranges: [{ days: WEEK, open: '18:00', close: '02:00' }] };
    assert.equal(kioskScheduleIssues(late, '01:00')[0].code, 'auto_z_while_open');
    assert.deepEqual(kioskScheduleIssues(late, '03:00'), []);
  });
  it('the simple form: the Z at the close unless given, all days by default', () => {
    const f = scheduleFormOf({ enabled: true, open: '08:00', close: '22:00' });
    assert.deepEqual(f.days, WEEK);
    assert.equal(scheduleFormAutoClose(f, null), '22:00');
    assert.equal(scheduleFormAutoClose({ ...f, autoCloseAt: '23:15' }, null), '23:15');
    assert.equal(scheduleFormAutoClose({ ...f, close: null }, '02:00'), '02:00');
    assert.deepEqual(scheduleFormHours({ ...f, close: null }).ranges[0].close, null);
  });
});

describe('the owner UI batch: service placement, menu mode, details step, upsell, end message (the server kiosk_config.py)', () => {
  const codes = (c: KioskConfig) => validateKioskConfig(c).map((e) => `${e.path}:${e.code}`);
  it('defaults: "הזמינו כאן" first, one category at a time, details before payment, menu upsells, no end message', () => {
    assert.equal(KIOSK_DEFAULTS.general.servicePlacement, 'after_start');
    assert.equal(KIOSK_DEFAULTS.catalog.oneCategory, true);
    assert.equal(KIOSK_DEFAULTS.payment.detailsStep, 'before_pay');
    assert.equal(KIOSK_DEFAULTS.payment.tableNumber, 'off');
    assert.deepEqual(KIOSK_DEFAULTS.upsell, { maxShown: 2 });
    assert.deepEqual(KIOSK_DEFAULTS.success, { message: '', image: null });
    assert.deepEqual(codes(resolveKioskConfig({})), []);
  });
  it('accepts every placement, step and upsell cap', () => {
    for (const servicePlacement of ['after_start', 'attract']) {
      for (const detailsStep of ['after_service', 'before_cart', 'before_pay', 'after_pay']) {
        for (const maxShown of [1, 3, 5]) {
          const c = cfg({ general: { servicePlacement }, payment: { detailsStep, tableNumber: 'required' }, upsell: { maxShown } });
          assert.deepEqual(codes(c), [], `${servicePlacement} ${detailsStep} ${maxShown}`);
        }
      }
    }
  });
  it('refuses unknown values, a bad count and a long end message', () => {
    const c = cfg({
      general: { servicePlacement: 'both' },
      catalog: { oneCategory: 'yes' },
      payment: { detailsStep: 'never', tableNumber: 'maybe' },
      upsell: { maxShown: 6 },
      success: { message: 'x'.repeat(301) },
    });
    assert.deepEqual(codes(c).sort(), [
      'catalog.oneCategory:enum',
      'general.servicePlacement:enum',
      'payment.detailsStep:enum',
      'payment.tableNumber:enum',
      'success.message:tooLong',
      'upsell.maxShown:range',
    ]);
  });
  it("the kiosk's own rules of the first round are gone: a layer that has them loses them quietly", () => {
    const layer = { upsell: { when: 'both', maxShown: 3, rules: [{ id: 'x', offerProductIds: ['muffin'] }] } };
    const c = resolveKioskConfig(layer as never);
    assert.deepEqual(c.upsell, { maxShown: 3 });
    assert.deepEqual(codes(c), []);
    assert.ok((layer.upsell.rules as unknown[]).length === 1, 'the layer itself is not changed');
  });
});

describe('"הוסף לסל" — the add-to-cart pop-and-fly (the till\'s KioskMotion / KioskAddPath)', () => {
  const from = { x: 300, y: 900 };
  const to = { x: 400, y: 1500 };
  it('a simple dish straight in, a meal or a required choice its window, sold out nothing', () => {
    assert.equal(kioskAddPath(false, false, false), 'direct');
    assert.equal(kioskAddPath(false, true, false), 'sheet');
    assert.equal(kioskAddPath(false, false, true), 'sheet');
    assert.equal(kioskAddPath(true, false, false), 'none');
  });
  it('pops by the card, flies an arc to the cart, lands small and faded, about 560 ms (under a second)', () => {
    for (const animation of ['lively', 'subtle'] as const) {
      const m = motionSpec({ animation }, { reduceMotion: false });
      assert.ok(m.popMs >= 140 && m.popMs <= 170 && m.flyMs >= 370 && m.flyMs <= 410, animation);
      assert.ok(m.popScale >= 1.3 && m.popScale <= 1.5, animation);
      assert.ok(addMs(m) < ADD_MAX_MS);
      const start = addFrame(m, 0, from, to);
      assert.deepEqual([start.x, start.y, start.scale, start.alpha], [from.x, from.y, 1, 1]);
      const popped = addFrame(m, m.popMs, from, to);
      assert.ok(Math.abs(popped.scale - m.popScale) < 1e-6);
      assert.ok(Math.abs(popped.y - (from.y - ADD_POP_LIFT_DP)) < 1e-6);
      // An arc: halfway, at least half its height above the straight line, both ways (rising first to a cart below).
      const mid = addFrame(m, m.popMs + m.flyMs / 2, from, to);
      const sy = from.y - ADD_POP_LIFT_DP;
      assert.ok(Math.abs(mid.x - (from.x + to.x) / 2) < 1e-6);
      assert.ok(mid.y <= (sy + to.y) / 2 - m.arcDp / 2 + 1e-6, 'above the straight line');
      assert.ok(addFrame(m, m.popMs + m.flyMs * 0.2, from, to).y < sy, 'rises before it falls');
      const up = addFrame(m, m.popMs + m.flyMs / 2, to, from);
      assert.ok(up.y <= (to.y - ADD_POP_LIFT_DP + from.y) / 2 - m.arcDp / 2 + 1e-6, 'to a cart above: still bowed upwards');
      const end = addFrame(m, addMs(m), from, to);
      assert.ok(Math.abs(end.x - to.x) < 1e-6 && Math.abs(end.y - to.y) < 1e-6);
      assert.ok(Math.abs(end.scale - ADD_END_SCALE) < 1e-6 && Math.abs(end.alpha - ADD_END_ALPHA) < 1e-6);
    }
  });
  it('reduce motion: a fade where the dish was, nothing moves or grows', () => {
    const m = motionSpec({ animation: 'lively' }, { reduceMotion: true });
    for (let i = 0; i <= 10; i++) {
      const f = addFrame(m, (addMs(m) * i) / 10, from, to);
      assert.deepEqual([f.x, f.y, f.scale], [from.x, from.y, 1]);
      assert.ok(Math.abs(f.alpha - (1 - i / 10)) < 1e-6);
    }
  });
});

/*
 * Every flow rule under every UI style ("סגנון ממשק"): the styles differ in look only, never in
 * flow or features — the till's KioskPresetFlowTest, and the preview / Windows kiosk screens,
 * which never branch on the style's name.
 */
for (const style of UI_STYLES) {
  describe(`the flow under the "${style}" style is the same as under every other`, () => {
    const c = (patch: Record<string, unknown> = {}) => resolveKioskConfig({ ...patch, theme: { uiStyle: style, ...((patch.theme as object) ?? {}) } });
    it('defaults: start button first, a category at a time, details before payment, the menu upsells, the end message off', () => {
      const cfg = c();
      assert.equal(cfg.theme.uiStyle, style);
      assert.equal(cfg.general.servicePlacement, 'after_start');
      assert.equal(cfg.catalog.oneCategory, true);
      assert.equal(cfg.payment.detailsStep, 'before_pay');
      assert.deepEqual(cfg.upsell, { maxShown: 2 });
      assert.deepEqual(cfg.success, { message: '', image: null });
      assert.deepEqual(validateKioskConfig(cfg), []);
    });
    it('every flow setting is accepted with the style', () => {
      const cfg = c({
        general: { servicePlacement: 'attract', reduceMotion: true },
        catalog: { oneCategory: false },
        payment: { detailsStep: 'after_pay', tableNumber: 'required', customerName: 'required' },
        upsell: { maxShown: 3 },
        success: { message: 'תודה!' },
      });
      assert.deepEqual(validateKioskConfig(cfg), []);
      assert.equal(cfg.general.servicePlacement, 'attract');
      assert.equal(cfg.catalog.oneCategory, false);
      assert.equal(cfg.payment.detailsStep, 'after_pay');
      assert.equal(cfg.success.message, 'תודה!');
    });
    it('the start button at the bottom centre of every screen', () => {
      const cta = c().attract.cta;
      assert.equal(cta.position, 'bottom_center');
      for (const [w, h] of [[785, 1396], [800, 1280], [1280, 800], [1080, 1920], [400, 600]]) {
        const box = ctaBox(cta, w, h);
        assert.ok(Math.abs(box.x * 2 + box.w - w) <= 1, `${style} ${w}x${h} centred`);
        assert.ok(box.y > h / 2, `${style} ${w}x${h} low`);
      }
    });
    it('the pop-and-fly, and the fade with reduce motion', () => {
      const cfg = c();
      const m = motionSpec(cfg.theme, cfg.general);
      assert.ok(m.popMs > 0 && m.flyMs > 0 && m.popScale >= 1.3 && m.bounce > 1 && m.countUpMs > 0);
      assert.ok(addMs(m) < ADD_MAX_MS);
      const reduced = c({ general: { reduceMotion: true } });
      const r = motionSpec(reduced.theme, reduced.general);
      assert.equal(r.flyMs, 0);
      assert.ok(r.fadeMs > 0 && addMs(r) < ADD_MAX_MS);
    });
    it('messages centred, never on the payment', () => {
      for (const s of ['attract', 'success', 'paused', 'closed']) assert.equal(messagePlacement(s), 'inline-center');
      for (const s of ['service', 'catalog', 'cart']) assert.equal(messagePlacement(s), 'overlay-center');
      assert.equal(messagePlacement('pay'), 'none');
    });
  });
}

describe('the kiosk screens never branch on the style\'s name (look only)', () => {
  it('preview-screens.tsx and kiosk-preview.tsx', () => {
    const dir = join(process.cwd(), 'src', 'components', 'dashboard', 'kiosks');
    const branch = /uiStyle\s*(===|!==|==|!=)|case\s+'(ios|wolt|classic|minimal_dark|tech)'|'(ios|wolt|classic|minimal_dark|tech)'\s*(===|!==)/;
    const offenders = ['preview-screens.tsx', 'kiosk-preview.tsx'].filter((f) => branch.test(readFileSync(join(dir, f), 'utf8')));
    // The shared layouts and the two kiosk apps draw the chrome from its tokens too.
    const shared = join(process.cwd(), 'src', 'kiosk-shared');
    const more = [
      ...readdirSync(join(shared, 'layouts')).filter((f) => f.endsWith('.tsx')).map((f) => join(shared, 'layouts', f)),
      join(shared, 'pay-method.tsx'),
      join(process.cwd(), 'src', 'components', 'kiosk-web', 'web-kiosk-app.tsx'),
      join(process.cwd(), '..', 'kiosk-desktop', 'src', 'renderer', 'kiosk', 'KioskApp.tsx'),
    ].filter((f) => branch.test(readFileSync(f, 'utf8')));
    assert.deepEqual(more, []);
    assert.deepEqual(offenders, []);
  });
});

describe('"הגדלת מכירה" on the kiosk screens (lib/kioskUpsell.ts — the till\'s UpsellMatch / atStep)', () => {
  const rule = (over: Partial<UpsellRuleLite>): UpsellRuleLite => ({
    id: 'r', name: 'r', triggerType: 'product', triggerIds: [], options: [], places: ['quick', 'tables', 'kiosk'], ...over,
  });
  const noon = new Date(2026, 9, 6, 12, 0);
  const catalog: Record<string, string[]> = { drinks: ['cola', 'water'], sweets: ['chocolate', 'gum'] };
  const opts = (over: Partial<Parameters<typeof pickKioskUpsell>[2]> = {}) => ({
    asked: [], inCart: [], cap: 2, now: noon, sellable: () => true,
    productsOf: (ids: string[]) => ids.flatMap((c) => catalog[c] ?? []), ...over,
  });
  it('one test per scope: item, category, step, every order', () => {
    const item = rule({ triggerType: 'product', triggerIds: ['coffee'] });
    assert.ok(upsellTriggers(item, { kind: 'added', productId: 'coffee', categoryIds: ['hot'] }, 'kiosk'));
    assert.ok(!upsellTriggers(item, { kind: 'step', code: 'to_pay' }, 'kiosk'));
    const cat = rule({ triggerType: 'category', triggerIds: ['drinks'] });
    assert.ok(upsellTriggers(cat, { kind: 'added', productId: 'cola', categoryIds: ['drinks'] }, 'kiosk'));
    const step = rule({ triggerType: 'transition', triggerIds: ['order_start', enterCategory('drinks'), 'before_send'] });
    assert.ok(upsellTriggers(step, { kind: 'step', code: 'order_start' }, 'kiosk'));
    assert.ok(upsellTriggers(step, { kind: 'step', code: 'enter_category:drinks' }, 'kiosk'));
    assert.ok(!upsellTriggers(step, { kind: 'step', code: 'before_send' }, 'kiosk'), 'a step the kiosk lacks');
    assert.ok(upsellTriggers(step, { kind: 'step', code: 'before_send' }, 'tables'));
    const every = rule({ triggerType: 'order' });
    assert.ok(upsellTriggers(every, { kind: 'step', code: 'to_pay' }, 'kiosk'), 'every order = to_pay on the kiosk');
    assert.ok(!upsellTriggers(every, { kind: 'step', code: 'to_pay' }, 'tables'));
  });
  it('places: the kiosk only where chosen; an older rule by its where', () => {
    const kioskOnly = rule({ triggerType: 'product', triggerIds: ['coffee'], places: ['kiosk'] });
    assert.ok(!upsellTriggers(kioskOnly, { kind: 'added', productId: 'coffee', categoryIds: [] }, 'quick'));
    assert.deepEqual(rulePlaces({ where: 'quick' }), ['quick', 'kiosk']);
    assert.deepEqual(rulePlaces({ where: 'tables' }), ['tables']);
    assert.deepEqual(rulePlaces({ where: 'both' }), ['quick', 'tables', 'kiosk']);
  });
  it('priority, once per order, the cap, and what the basket holds is hidden', () => {
    const low = rule({ id: 'low', name: 'low', triggerType: 'transition', triggerIds: ['to_pay'], priority: 1, options: [{ type: 'product', id: 'gum' }, { type: 'product', id: 'water' }] });
    const high = rule({ id: 'high', name: 'high', triggerType: 'transition', triggerIds: ['to_pay'], priority: 5, options: [{ type: 'category', id: 'sweets' }] });
    const at = { kind: 'step', code: 'to_pay' } as const;
    assert.deepEqual(pickKioskUpsell([low, high], at, opts({ inCart: ['cola'] })), { rule: high, items: ['chocolate', 'gum'] });
    assert.equal(pickKioskUpsell([low, high], at, opts({ inCart: ['cola'], asked: ['high'] }))?.rule.id, 'low');
    assert.deepEqual(pickKioskUpsell([low], at, opts({ inCart: ['water'] }))?.items, ['gum']);
    assert.equal(pickKioskUpsell([low], at, opts({ inCart: ['water', 'gum'] })), null, 'nothing left to offer');
    assert.equal(pickKioskUpsell([low, high], at, opts({ asked: ['a', 'b'] })), null, 'the cap');
    const every = rule({ id: 'every', triggerType: 'order', options: [{ type: 'product', id: 'gum' }] });
    assert.equal(pickKioskUpsell([every], at, opts()), null, 'every order is never asked of an empty basket');
  });
  it('days and hours, past midnight', () => {
    const late = { startTime: '22:00', endTime: '02:00', weekdays: [5] };
    assert.ok(upsellActiveAt(late, new Date(2026, 9, 9, 23, 0)));
    assert.ok(upsellActiveAt(late, new Date(2026, 9, 10, 1, 0)), 'Friday night, after midnight');
    assert.ok(!upsellActiveAt(late, new Date(2026, 9, 10, 23, 0)));
    assert.ok(!upsellActiveAt({ isActive: false }, noon));
  });
});

describe('"התראות לקופות" and "סגירה יחד עם ה-Z הסניפי" (the server kiosk_config.py / kiosk_ops.py)', () => {
  const codes = (c: KioskConfig) => validateKioskConfig(c).map((e) => `${e.path}:${e.code}`);
  it('defaults: the main till (else all the shop tills), everyone, help clears after 10 minutes; no close with the shop Z', () => {
    assert.deepEqual(KIOSK_DEFAULTS.alerts.printer, { tills: 'main', machineIds: [], audience: 'everyone' });
    assert.equal(KIOSK_DEFAULTS.alerts.help.clearAfterMin, 10);
    assert.equal(KIOSK_DEFAULTS.operations.closeWithShopZ, false);
    assert.deepEqual(codes(cfg()), []);
  });
  it('validates which tills, who and the minutes', () => {
    const c = cfg({
      alerts: { printer: { tills: 'kitchen' }, terminal: { tills: 'selected' }, help: { audience: 'owners', clearAfterMin: 500 } },
    });
    assert.deepEqual(codes(c).sort(), [
      'alerts.help.audience:enum',
      'alerts.help.clearAfterMin:range',
      'alerts.printer.tills:enum',
      'alerts.terminal.machineIds:atLeastOne',
    ]);
    const ok = cfg({ alerts: { help: { tills: 'selected', machineIds: ['a0000000-0000-0000-0000-000000000001'], audience: 'managers' } } });
    assert.deepEqual(codes(ok), []);
    assert.deepEqual(codes(cfg({ operations: { closeWithShopZ: true } })), []);
  });
  it('a chosen list a parent left empty goes to the main till, as the server repairs it', () => {
    const c = resolveKioskConfig({ alerts: { printer: { tills: 'selected', machineIds: [] } } });
    assert.equal(c.alerts.printer.tills, 'main');
  });
  it('every alert text the editor asks exists in he.json', () => {
    const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
    const a = he.kiosks.alerts;
    for (const key of ['intro', 'channels', 'tills', 'tillsHint', 'tillsMain', 'tillsAll', 'tillsSelected', 'machineIds',
      'machineIdsHint', 'noneChosen', 'clear', 'noTills', 'audience', 'audienceEveryone', 'audienceManagers',
      'clearAfterMin', 'clearAfterMinHint', 'minutes', 'open']) {
      assert.equal(typeof a[key], 'string', key);
    }
    for (const kind of ['printer', 'terminal', 'help']) assert.equal(typeof a[kind].title, 'string', kind);
    for (const state of ['pending', 'delivered', 'done', 'doneZ', 'failed', 'expired']) assert.equal(typeof a.shopZClose[state], 'string', state);
    assert.equal(typeof he.kiosks.settings.sections.alerts, 'string');
    assert.equal(typeof he.kiosks.fields.operations.closeWithShopZ, 'string');
    assert.equal(typeof he.kiosks.timers.closeWithShopZHint, 'string');
    assert.equal(typeof he.kiosks.validation.server.unknown_till, 'string');
  });
});

describe('"יצאתי לנוח… תכף אשוב": the closed screen (the till\'s KioskRestTextTest)', () => {
  const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
  const builtin = he.kiosks.builtin as Record<string, string>;
  const txtOf = (texts: Record<string, string> = {}) => (key: KioskRestTextKey) => texts[key] || builtin[key];
  // Wednesday 7 October 2026, 13:50, local time.
  const now = new Date(2026, 9, 7, 13, 50);
  const noHours = { enabled: false, ranges: [] };
  const local = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();

  it('the built-in words: a break, back soon; outside the hours their own subtitle', () => {
    assert.equal(builtin.pausedTitle, 'יצאתי לנוח…');
    assert.equal(builtin.pausedBody, 'תכף אשוב');
    assert.equal(builtin.closedTitle, 'יצאתי לנוח…');
    assert.equal(builtin.closedBody, 'הקיוסק יחזור לפעול בשעות הפעילות.');
    const p = kioskRestText('paused', { hours: noHours }, {}, txtOf(), now);
    assert.deepEqual([p.title, p.subtitle, p.backAt, p.backClock, p.backInDays], ['יצאתי לנוח…', 'תכף אשוב', null, null, null]);
    for (const key of ['backAt', 'backTomorrow', 'backOn', 'orderAtTill']) assert.equal(typeof he.kiosks.preview.rest[key], 'string', key);
  });
  it("the manager's pause message takes the subtitle's place", () => {
    const p = kioskRestText('paused', { hours: noHours }, { message: '  הפסקת צהריים  ' }, txtOf(), now);
    assert.equal(p.title, 'יצאתי לנוח…');
    assert.equal(p.subtitle, 'הפסקת צהריים');
    assert.equal(kioskRestText('paused', { hours: noHours }, { message: '   ' }, txtOf(), now).subtitle, 'תכף אשוב');
  });
  it('a pause with an end: back today, tomorrow or on its day; an end already past lifts it', () => {
    const today = kioskRestText('paused', { hours: noHours }, { until: local(7, 14, 30) }, txtOf(), now);
    assert.deepEqual([today.backClock, today.backInDays], ['14:30', 0]);
    const tomorrow = kioskRestText('paused', { hours: noHours }, { until: local(8, 7, 0) }, txtOf(), now);
    assert.deepEqual([tomorrow.backClock, tomorrow.backInDays], ['07:00', 1]);
    const friday = kioskRestText('paused', { hours: noHours }, { until: local(9, 9, 5) }, txtOf(), now);
    assert.deepEqual([friday.backClock, friday.backInDays, friday.backWeekday], ['09:05', 2, 5]);
    const both = kioskRestText('paused', { hours: noHours }, { message: 'חוזרים מיד', until: local(7, 14, 10) }, txtOf(), now);
    assert.deepEqual([both.subtitle, both.backClock], ['חוזרים מיד', '14:10']);
    const old = kioskRestText('paused', { hours: noHours }, { message: 'ישן', until: local(7, 13, 49) }, txtOf(), now);
    assert.deepEqual([old.subtitle, old.backAt], ['תכף אשוב', null]);
  });
  it('configured texts win over the built-in ones; operations first; the message over them all', () => {
    const texts = { pausedTitle: 'סגור לרגע', pausedBody: 'נשוב בקרוב', closedTitle: 'לילה טוב', closedBody: 'נפתח מחר' };
    const p = kioskRestText('paused', { hours: noHours }, {}, txtOf(texts), now);
    assert.deepEqual([p.title, p.subtitle], ['סגור לרגע', 'נשוב בקרוב']);
    const ops = { pausedTitle: 'הפסקה', pausedBody: 'עוד רגע' };
    const o = kioskRestText('paused', { operations: ops, hours: noHours }, {}, txtOf(texts), now);
    assert.deepEqual([o.title, o.subtitle], ['הפסקה', 'עוד רגע']);
    assert.equal(kioskRestText('paused', { operations: ops, hours: noHours }, { message: 'מנקים את המכונה' }, txtOf(texts), now).subtitle, 'מנקים את המכונה');
    const c = kioskRestText('closed', { hours: noHours }, {}, txtOf(texts), now);
    assert.deepEqual([c.title, c.subtitle], ['לילה טוב', 'נפתח מחר']);
  });
  it('outside the hours: the next opening; a pause never uses the hours', () => {
    const hours = { enabled: true, ranges: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '07:00', close: '13:00' }] };
    const c = kioskRestText('closed', { hours }, {}, txtOf(), now);
    assert.deepEqual([c.title, c.subtitle, c.backClock, c.backInDays], ['יצאתי לנוח…', 'הקיוסק יחזור לפעול בשעות הפעילות.', '07:00', 1]);
    const early = kioskRestText('closed', { hours }, {}, txtOf(), new Date(2026, 9, 7, 5, 30));
    assert.deepEqual([early.backClock, early.backInDays], ['07:00', 0]);
    assert.equal(kioskRestText('closed', { hours: noHours }, {}, txtOf(), now).backAt, null);
    assert.equal(kioskRestText('paused', { hours }, {}, txtOf(), now).backAt, null);
    assert.equal(kioskNextOpening({ enabled: true, ranges: [{ days: [5], open: '18:00', close: '02:00' }] }, now)?.getDate(), 9);
  });
  it("each UI style's colours, with words that read on them (the till's numbers)", () => {
    const look = (style: keyof typeof KIOSK_UI_PRESETS, patch: Record<string, unknown> = {}) => {
      const c = resolveKioskConfig({ theme: { uiStyle: style, ...patch } });
      return kioskRestLook(c.theme, resolveThemeColors(c.theme));
    };
    const ios = look('ios');
    assert.deepEqual([ios.from, ios.to, ios.diagonal, ios.ink], ['#2390FF', '#075CB3', false, '#FFFFFF']);
    const wolt = look('wolt');
    assert.deepEqual([wolt.from, wolt.to, wolt.diagonal, wolt.spots, wolt.ink], ['#1F6FEB', '#16707F', true, true, '#FFFFFF']);
    const classic = look('classic');
    assert.deepEqual([classic.from, classic.to, classic.ink], ['#E11D48', '#E11D48', '#FFFFFF']);
    const dark = look('minimal_dark');
    assert.deepEqual([dark.from, dark.glow, dark.title, dark.ink], ['#0B0B0D', '#C9A227', '#C9A227', '#F5F5F4']);
    const yellow = look('classic', { primaryColor: '#FACC15' });
    assert.equal(yellow.ink, REST_DARK_INK);
    for (const l of [ios, wolt, classic, yellow]) {
      assert.ok(contrastRatio(l.ink, l.from) >= REST_LARGE_TEXT_CONTRAST);
      assert.ok(contrastRatio(l.ink, l.to) >= REST_LARGE_TEXT_CONTRAST);
    }
    assert.equal(mixHex('#000000', '#FFFFFF', 0.5), '#808080');
  });
});

describe('"הנפשות ומעברים" — the transitions (the server kiosk_config.py UI_PRESET_MOTION, the till KioskTransitions)', () => {
  it('the defaults are the wolt style, and every style animates the category and pops its dishes in', () => {
    // The style's keys, and "אפקטים" (the device's, not a style's): auto.
    assert.deepEqual(KIOSK_DEFAULTS.motion, { ...KIOSK_UI_PRESET_MOTION.wolt, effects: 'auto' });
    assert.deepEqual([...PRESET_MOTION_KEYS], ['categorySwitch', 'itemsEnter', 'screenChange', 'sheet', 'addToCart', 'speed']);
    for (const style of UI_STYLES) {
      const c = resolveKioskConfig({ theme: { uiStyle: style } });
      assert.deepEqual(c.motion, { ...KIOSK_UI_PRESET_MOTION[style], effects: 'auto' }, style);
      assert.deepEqual(validateKioskConfig(c), [], style);
      const t = transitionSpec(c.motion, c.general);
      assert.notEqual(t.categorySwitch, 'none', style);
      assert.ok(t.categoryMs > 0 && t.itemMs > 0 && t.screenMs > 0 && t.sheetMs > 0, style);
      assert.ok(t.itemsEnter === 'pop' || t.itemsEnter === 'cascade', style);
      assert.equal(t.addToCart, 'fly', style);
    }
  });

  it('layers company → shop → kiosk, explicit beating the style; a style switch moves only what followed it', () => {
    const company = { motion: { speed: 'fast' } };
    const shop = { theme: { uiStyle: 'minimal_dark' }, motion: { itemsEnter: 'flip' } };
    const kiosk = { motion: { categorySwitch: 'push' } };
    assert.deepEqual(resolveKioskConfig(company, shop, kiosk).motion, {
      categorySwitch: 'push', itemsEnter: 'flip', screenChange: 'fade', sheet: 'fade', addToCart: 'fly', speed: 'fast', effects: 'auto',
    });
    // The editor: rebased on the level's style, reset goes back to it, a draft following it saves nothing.
    const parents = { motion: { speed: 'fast' } };
    const inherited = resolveKioskConfig(parents);
    const base = rebaseInherited(inherited, parents, 'classic');
    assert.equal(base.motion.categorySwitch, 'push'); // the classic style's
    assert.equal(base.motion.speed, 'fast'); // explicit in a parent: kept
    const draft = deepMergeKiosk(inherited, { motion: { sheet: 'fade' } });
    const next = switchUiStyle(draft, rebaseInherited(inherited, parents, draft.theme.uiStyle), base, 'classic');
    assert.equal(next.motion.sheet, 'fade'); // chosen here: stays
    assert.equal(next.motion.itemsEnter, 'pop'); // followed the style: moves
    assert.deepEqual(pruneOverrides(base, next), { theme: { uiStyle: 'classic' }, motion: { sheet: 'fade' } });
    assert.deepEqual(resolveKioskConfig(parents, pruneOverrides(base, next)), next);
  });

  it('validates every choice', () => {
    const ok = cfg({ motion: { categorySwitch: 'fade_scale', itemsEnter: 'rise', screenChange: 'zoom', sheet: 'slide_up', addToCart: 'bounce', speed: 'relaxed' } });
    assert.deepEqual(validateKioskConfig(ok), []);
    for (const fx of CATEGORY_SWITCH_FX) assert.deepEqual(validateKioskConfig(cfg({ motion: { categorySwitch: fx } })), [], fx);
    const bad = cfg({ motion: { categorySwitch: 'spin', itemsEnter: 'explode', screenChange: 'push', sheet: 'zoom', addToCart: 'teleport', speed: 'warp', effects: 'turbo' } });
    assert.deepEqual(
      validateKioskConfig(bad).map((e) => `${e.path}:${e.code}`),
      [...PRESET_MOTION_KEYS, 'effects'].map((k) => `motion.${k}:enum`),
    );
    for (const fx of MOTION_EFFECTS) assert.deepEqual(validateKioskConfig(cfg({ motion: { effects: fx } })), [], fx);
    // The server's vocabularies, word for word.
    assert.deepEqual(ITEMS_ENTER_FX, ['pop', 'cascade', 'rise', 'flip', 'none']);
    assert.deepEqual(SCREEN_CHANGE_FX, ['slide', 'fade', 'zoom', 'none']);
    assert.deepEqual(SHEET_FX, ['slide_up', 'scale', 'fade', 'none']);
    assert.deepEqual(ADD_TO_CART_FX, ['fly', 'bounce', 'none']);
    assert.deepEqual(MOTION_SPEEDS, ['fast', 'normal', 'relaxed']);
    assert.deepEqual(MOTION_EFFECTS, ['auto', 'full', 'light']);
  });

  it('reduceMotion turns every transition off', () => {
    for (const style of UI_STYLES) {
      const c = resolveKioskConfig({ theme: { uiStyle: style }, general: { reduceMotion: true } });
      assert.deepEqual(transitionSpec(c.motion, c.general), NO_TRANSITIONS, style);
      assert.equal(gridEnterMs(transitionSpec(c.motion, c.general)), 0);
      assert.equal(motionSpec(c.theme, c.general, c.motion).flyMs, 0);
    }
  });

  it('scales every duration by the speed; unknown values fall back to the defaults', () => {
    const at = (speed: string) => transitionSpec({ ...KIOSK_DEFAULTS.motion, speed: speed as never }, { reduceMotion: false });
    assert.deepEqual(MOTION_SPEED_FACTOR, { fast: 0.75, normal: 1, relaxed: 1.35 });
    assert.equal(at('normal').categoryMs, TRANSITION_BASE_MS.categorySwitch.slide);
    assert.equal(at('fast').categoryMs, Math.round(TRANSITION_BASE_MS.categorySwitch.slide * 0.75));
    assert.equal(at('relaxed').screenMs, Math.round(TRANSITION_BASE_MS.screenChange.slide * 1.35));
    assert.ok(at('fast').itemMs < at('normal').itemMs && at('normal').itemMs < at('relaxed').itemMs);
    assert.deepEqual(at('warp'), at('normal'));
    const t = transitionSpec({ categorySwitch: 'spin' as never, itemsEnter: 'none', sheet: 'none' }, { reduceMotion: false });
    assert.equal(t.categorySwitch, KIOSK_DEFAULTS.motion.categorySwitch);
    assert.deepEqual([t.itemsEnter, t.itemMs, t.staggerMs, t.sheet, t.sheetMs], ['none', 0, 0, 'none', 0]);
    assert.equal(transitionSpec(undefined, { reduceMotion: false }).itemsEnter, KIOSK_DEFAULTS.motion.itemsEnter);
  });

  it('staggers only the first cards, the last one by the cap, at every speed', () => {
    for (const speed of MOTION_SPEEDS) {
      for (const fx of ITEMS_ENTER_FX) {
        const t = transitionSpec({ itemsEnter: fx, speed }, { reduceMotion: false });
        assert.equal(staggerDelayMs(t, 0), 0);
        let last = 0;
        for (let i = 0; i < 60; i++) {
          const d = staggerDelayMs(t, i);
          assert.ok(d >= last && d <= t.staggerCapMs, `${fx} ${speed} ${i}`);
          last = d;
        }
        // Past a screenful the cards come with the last staggered one.
        assert.equal(staggerDelayMs(t, 200), staggerDelayMs(t, STAGGER_MAX_CARDS - 1));
        if (fx === 'none') assert.equal(gridEnterMs(t), 0);
        else assert.equal(gridEnterMs(t), staggerDelayMs(t, STAGGER_MAX_CARDS - 1) + t.itemMs);
      }
    }
    // "pop" lands the whole grid at once (barely staggered); "cascade" runs card after card.
    const pop = transitionSpec({ itemsEnter: 'pop' }, { reduceMotion: false });
    const cascade = transitionSpec({ itemsEnter: 'cascade' }, { reduceMotion: false });
    assert.ok(staggerDelayMs(pop, 8) < staggerDelayMs(cascade, 8));
    assert.equal(staggerDelayMs(cascade, STAGGER_MAX_CARDS - 1), STAGGER_CAP_MS);
  });

  it('the owner pace (07.10.2026, "המעברים עוברים מאוד לאט"): snappy — a screen 220 ms, cards 260 ms 32 ms apart, a grid under half a second', () => {
    const t = transitionSpec(KIOSK_DEFAULTS.motion, { reduceMotion: false });
    assert.deepEqual(
      [t.screenMs, t.categoryMs, t.itemMs, t.staggerMs, t.staggerCapMs, t.sheetMs],
      [220, 240, 260, 32, STAGGER_CAP_MS, 220],
    );
    assert.equal(STAGGER_CAP_MS, 200);
    assert.ok(gridEnterMs(t) < 500, String(gridEnterMs(t)));
    assert.equal(addMs(motionSpec({ animation: 'lively' }, { reduceMotion: false }, KIOSK_DEFAULTS.motion)), 560);
    // Fast three quarters of normal; relaxed a third longer, the add still under a second.
    const fast = transitionSpec({ ...KIOSK_DEFAULTS.motion, speed: 'fast' }, { reduceMotion: false });
    assert.deepEqual([fast.categoryMs, fast.itemMs], [180, 195]);
    const relaxed = transitionSpec({ ...KIOSK_DEFAULTS.motion, speed: 'relaxed' }, { reduceMotion: false });
    assert.equal(relaxed.screenMs, Math.round(220 * 1.35));
    assert.ok(addMs(motionSpec({ animation: 'lively' }, { reduceMotion: false }, { addToCart: 'fly', speed: 'relaxed' })) < ADD_MAX_MS);
  });

  it('moves the way the customer reads: forward from the left in Hebrew, from the right in English', () => {
    assert.equal(swapSide(true, true), -1);
    assert.equal(swapSide(false, true), 1);
    assert.equal(swapSide(true, false), 1);
    assert.equal(swapSide(false, false), -1);
  });

  it('the add to cart: fly, the basket button bounce, or nothing; the speed never takes it past a second', () => {
    const theme = { animation: 'lively' as const };
    const on = { reduceMotion: false };
    const fly = motionSpec(theme, on, { addToCart: 'fly', speed: 'normal' });
    assert.deepEqual(fly, motionSpec(theme, on));
    const relaxed = motionSpec(theme, on, { addToCart: 'fly', speed: 'relaxed' });
    assert.ok(addMs(relaxed) > addMs(fly) && addMs(relaxed) < ADD_MAX_MS);
    assert.ok(addMs(motionSpec(theme, on, { addToCart: 'fly', speed: 'fast' })) < addMs(fly));
    const bounce = motionSpec(theme, on, { addToCart: 'bounce' });
    assert.equal(addMs(bounce), 0);
    assert.ok(bounce.bounce > fly.bounce && bounce.countUpMs > 0);
    const none = motionSpec(theme, on, { addToCart: 'none' });
    assert.deepEqual([addMs(none), none.bounce, none.countUpMs], [0, 0, 0]);
    // "ללא" stays nothing with reduce motion; the others are the short fade.
    assert.equal(addMs(motionSpec(theme, { reduceMotion: true }, { addToCart: 'none' })), 0);
    assert.equal(motionSpec(theme, { reduceMotion: true }, { addToCart: 'bounce' }).fadeMs, 280);
  });
});

describe('"טיפ לצוות" and the steps before the payment (the till\'s KioskCheckoutSteps)', () => {
  const pay = (over: Partial<typeof KIOSK_DEFAULTS.payment> = {}) => ({ ...KIOSK_DEFAULTS.payment, tipEnabled: true, ...over });
  it('defaults: the tip, then the details; a setting may swap them, and is valid', () => {
    // "איך תרצו לשלם?" (payMethod) is always the last, right before the payment.
    assert.deepEqual(KIOSK_DEFAULTS.payment.checkoutSteps, ['tip', 'details', 'payMethod']);
    assert.equal(KIOSK_DEFAULTS.payment.tipOther, true);
    assert.deepEqual(checkoutStepOrder(undefined), CHECKOUT_STEPS);
    assert.deepEqual(checkoutStepOrder(['details']), ['details', 'tip', 'payMethod']);
    assert.deepEqual(checkoutStepOrder(['details', 'tip', 'tip', 'nope']), ['details', 'tip', 'payMethod']);
    assert.deepEqual(validateKioskConfig(resolveKioskConfig({ payment: { checkoutSteps: ['details', 'tip'] } })), []);
    const bad = validateKioskConfig(resolveKioskConfig({ payment: { checkoutSteps: ['tip', 'review'] } as never }));
    assert.ok(bad.some((e) => e.path === 'payment.checkoutSteps' && e.code === 'enum'));
    const twice = validateKioskConfig(resolveKioskConfig({ payment: { checkoutSteps: ['tip', 'tip'] } }));
    assert.ok(twice.some((e) => e.path === 'payment.checkoutSteps' && e.code === 'duplicate'));
    // "לאכול כאן או לקחת?": pick then "להמשך" by default, or straight on.
    assert.equal(KIOSK_DEFAULTS.general.serviceSelect, 'confirm');
    assert.deepEqual(validateKioskConfig(resolveKioskConfig({ general: { serviceSelect: 'instant' } })), []);
    assert.ok(validateKioskConfig(resolveKioskConfig({ general: { serviceSelect: 'double' } } as never)).some((e) => e.path === 'general.serviceSelect'));
  });
  it('the steps of an order: the tip when on, the details when asked before the payment', () => {
    assert.deepEqual(checkoutStepsNow(pay(), true, false), ['tip', 'details']);
    assert.deepEqual(checkoutStepsNow(pay({ checkoutSteps: ['details', 'tip'] }), true, false), ['details', 'tip']);
    // The tip off: only the details; nothing asked: no step at all.
    assert.deepEqual(checkoutStepsNow(pay({ tipEnabled: false }), true, false), ['details']);
    assert.deepEqual(checkoutStepsNow(pay({ tipEnabled: false }), false, false), []);
    assert.equal(kioskTipAsked(pay({ tipPresets: [], tipOther: false })), false);
    assert.equal(kioskTipAsked(pay({ tipPresets: [], tipOther: true })), true);
    // Details asked before the basket (and given) or after the payment: only the tip here.
    assert.deepEqual(checkoutStepsNow(pay({ detailsStep: 'before_cart' }), true, true), ['tip']);
    assert.deepEqual(checkoutStepsNow(pay({ detailsStep: 'before_cart' }), true, false), ['tip', 'details']);
    assert.deepEqual(checkoutStepsNow(pay({ detailsStep: 'after_pay' }), true, false), ['tip']);
  });
  it('the step bar: the review done, the current step, the payment last', () => {
    const bar = checkoutBar(['tip', 'details'], 'tip');
    assert.deepEqual(bar.map((b) => [b.key, b.textKey, b.state]), [
      ['review', 'stepReview', 'done'],
      ['tip', 'stepTip', 'current'],
      ['details', 'stepDetails', 'next'],
      ['pay', 'stepPay', 'next'],
    ]);
    assert.deepEqual(checkoutBar(['details', 'tip'], 'tip').map((b) => b.state), ['done', 'done', 'current', 'next']);
    for (const b of bar) assert.ok((TEXT_KEYS as readonly string[]).includes(b.textKey));
    const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
    const builtin = he.kiosks.builtin as Record<string, string>;
    assert.deepEqual([builtin.stepReview, builtin.stepTip, builtin.stepPay], ['ההזמנה שלכם', 'טיפ לצוות', 'תשלום']);
    for (const k of ['tipCaption', 'tipTitle', 'tipSubtitle', 'tipOtherLabel', 'tipOtherHint', 'tipOrderTotal', 'tipLine', 'tipTotal', 'tipContinue', 'tipSkip', 'stepDetails']) {
      assert.ok(builtin[k], k);
      assert.ok(he.kiosks.fields.texts[k], `kiosks.fields.texts.${k}`);
    }
    // "דינמיות מלאה": every screen text is editable — each has its built-in words and its editor label.
    assert.deepEqual(TEXT_KEYS.filter((k) => !builtin[k] || !he.kiosks.fields.texts[k]), []);
    assert.equal(builtin.serviceTitle, 'לאכול כאן או לקחת?');
  });
  it('the amounts: a percent of the total to the agora, half up; "סכום אחר" in whole shekels up to the total', () => {
    assert.deepEqual([5, 10, 15].map((p) => tipPercentAgorot(12800, p)), [640, 1280, 1920]);
    assert.equal(tipPercentAgorot(1234, 12), 148); // 148.08
    assert.equal(tipPercentAgorot(1250, 10), 125);
    assert.equal(tipPercentAgorot(1245, 10), 125); // 124.5 → 125
    assert.equal(tipPercentAgorot(1244, 10), 124);
    assert.equal(tipPercentAgorot(12800, null), 0);
    assert.equal(tipOtherAgorot('20', 12800), 2000);
    assert.equal(tipOtherAgorot('0', 12800), null);
    assert.equal(tipOtherAgorot('', 12800), null);
    assert.equal(tipOtherAgorot('129', 12800), null); // more than the order
    assert.equal(tipOtherAgorot(String(TIP_OTHER_MAX_SHEKELS + 1), 10_000_000), null);
  });
  it("each UI style's service choices, the words reading on them (the till's numbers)", () => {
    const look = (style: keyof typeof KIOSK_UI_PRESETS, patch: Record<string, unknown> = {}) => {
      const c = resolveKioskConfig({ theme: { uiStyle: style, ...patch } });
      return kioskServiceLook(c.theme, resolveThemeColors(c.theme));
    };
    assert.deepEqual(look('ios'), { from: '#E2F0FF', to: '#E2F0FF', diagonal: false, ink: '#111827', badge: '#0A84FF', icon: '#FFFFFF', border: null });
    assert.deepEqual(look('wolt'), { from: '#1F6FEB', to: '#16707F', diagonal: true, ink: '#FFFFFF', badge: '#FFFFFF33', icon: '#FFFFFF', border: null });
    assert.deepEqual(look('classic'), { from: '#E11D48', to: '#E11D48', diagonal: false, ink: '#FFFFFF', badge: '#FFFFFF33', icon: '#FFFFFF', border: null });
    assert.deepEqual(look('minimal_dark'), { from: '#16161A', to: '#16161A', diagonal: false, ink: '#F5F5F4', badge: '#C9A2272E', icon: '#C9A227', border: '#C9A227' });
    const yellow = look('classic', { primaryColor: '#FACC15' });
    assert.equal(yellow.ink, REST_DARK_INK);
    for (const l of [look('ios'), look('wolt'), look('classic'), look('minimal_dark'), yellow]) {
      assert.ok(contrastRatio(l.ink, l.from) >= REST_LARGE_TEXT_CONTRAST && contrastRatio(l.ink, l.to) >= REST_LARGE_TEXT_CONTRAST);
    }
  });
});

import {
  KIOSK_LIMITS,
  TICKER_SCREENS,
  TICKER_SPEED_PX,
  TICKER_STATIC_MS,
  nextTickerItemId,
  textDirection,
  tickerAt,
  tickerColors,
  tickerCopies,
  tickerDirection,
  tickerItemLive,
  tickerLoopMs,
  tickerScreenOf,
  tickerStaticIndex,
  tickerTextsNow,
  tickerWindowOpen,
  tickerBandPx,
  type KioskTicker,
  type KioskTickerItem,
} from './kioskConfig';

describe('"כיתוב רץ" (config ticker — the server kiosk_config.py, the till domain/KioskTicker.kt)', () => {
  const item = (over: Partial<KioskTickerItem> = {}): KioskTickerItem => ({
    id: 't1',
    text: 'מבצע צהריים',
    enabled: true,
    from: null,
    to: null,
    days: [0, 1, 2, 3, 4, 5, 6],
    startsAt: null,
    endsAt: null,
    ...over,
  });
  const ticker = (over: Partial<KioskTicker> = {}): KioskTicker => ({ ...KIOSK_DEFAULTS.ticker, enabled: true, items: [item()], ...over });
  const errorsOf = (t: Partial<KioskTicker>) =>
    validateKioskConfig({ ...KIOSK_DEFAULTS, ticker: { ...KIOSK_DEFAULTS.ticker, ...t } }).filter((x) => x.path.startsWith('ticker'));
  // A local date: 2026-10-07 is a Wednesday (3).
  const at = (hh: number, mm = 0, day = 7) => new Date(2026, 9, day, hh, mm);

  it('defaults: off, on the menu and the basket, under the header, slow, the theme colours, medium, no pause — and valid', () => {
    assert.deepEqual(KIOSK_DEFAULTS.ticker, {
      enabled: false,
      items: [],
      screens: ['catalog', 'cart'],
      position: 'top',
      speed: 'slow',
      backgroundColor: null,
      textColor: null,
      size: 'm',
      pauseOnTouch: false,
    });
    assert.deepEqual(validateKioskConfig(KIOSK_DEFAULTS), []);
    assert.deepEqual(resolveKioskConfig().ticker, KIOSK_DEFAULTS.ticker);
    assert.deepEqual([...TICKER_SCREENS], ['attract', 'service', 'catalog', 'cart', 'details', 'pay', 'success']);
    assert.ok(TICKER_SPEED_PX.slow < TICKER_SPEED_PX.normal && TICKER_SPEED_PX.normal < TICKER_SPEED_PX.fast);
  });

  it('layers merge the section key by key, the texts replace whole', () => {
    const cfg = resolveKioskConfig(
      { ticker: { enabled: true, items: [item({ id: 'a' }), item({ id: 'b' })], backgroundColor: '#000000' } },
      { ticker: { speed: 'normal', items: [item({ id: 's' })] } },
      { ticker: { position: 'bottom', backgroundColor: null } },
    );
    assert.equal(cfg.ticker.enabled, true);
    assert.equal(cfg.ticker.speed, 'normal');
    assert.equal(cfg.ticker.position, 'bottom');
    assert.equal(cfg.ticker.backgroundColor, '#000000');
    assert.deepEqual(cfg.ticker.items.map((x) => x.id), ['s']);
    assert.deepEqual(cfg.ticker.screens, ['catalog', 'cart']);
  });

  it('validation: the look, the screens, the texts, their hours, days and dates', () => {
    assert.deepEqual(errorsOf({ enabled: true, items: [item(), item({ id: 't2', from: '22:00', to: '02:00', days: [5] })] }), []);
    const bad = errorsOf({
      screens: ['catalog', 'paused' as never],
      position: 'middle' as never,
      speed: 'warp' as never,
      size: 'xl' as never,
      backgroundColor: 'red',
      textColor: '#12345',
      pauseOnTouch: 1 as never,
      items: [
        item({ id: 'bad id!' }),
        item({ id: 't2', text: 'x'.repeat(201) }),
        item({ id: 't2' }),
        item({ id: 't4', from: '25:00', to: '7:5' }),
        item({ id: 't5', from: '08:00', to: '08:00' }),
        item({ id: 't6', days: [] }),
        item({ id: 't7', days: [7] }),
        item({ id: 't8', startsAt: 'tomorrow' }),
        item({ id: 't9', startsAt: '2026-10-06T10:00:00Z', endsAt: '2026-10-06T09:00:00Z' }),
      ],
    });
    const got = Object.fromEntries(bad.map((x) => [x.path, x.code]));
    assert.equal(got['ticker.screens'], 'enum');
    assert.equal(got['ticker.position'], 'enum');
    assert.equal(got['ticker.speed'], 'enum');
    assert.equal(got['ticker.size'], 'enum');
    assert.equal(got['ticker.backgroundColor'], 'color');
    assert.equal(got['ticker.textColor'], 'color');
    assert.equal(got['ticker.pauseOnTouch'], 'enum');
    assert.equal(got['ticker.items.0.id'], 'messageId');
    assert.equal(got['ticker.items.1.text'], 'tooLong');
    assert.equal(got['ticker.items.2.id'], 'duplicate');
    assert.equal(got['ticker.items.3.from'], 'time');
    assert.equal(got['ticker.items.3.to'], 'time');
    assert.equal(got['ticker.items.4.to'], 'sameTimes');
    assert.equal(got['ticker.items.5.days'], 'atLeastOne');
    assert.equal(got['ticker.items.6.days'], 'enum');
    assert.equal(got['ticker.items.7.startsAt'], 'date');
    assert.equal(got['ticker.items.8.endsAt'], 'endsBeforeStarts');
    const many = Array.from({ length: KIOSK_LIMITS.tickerItemsMax + 1 }, (_, i) => item({ id: `t${i}` }));
    assert.equal(errorsOf({ items: many })[0]?.code, 'tooMany');
    // An older server's config (no ticker at all) is not an error.
    const { ticker: _omit, ...older } = KIOSK_DEFAULTS;
    void _omit;
    assert.deepEqual(validateKioskConfig(older as KioskConfig), []);
  });

  it('a text by its hours and days: all day, from, until, past midnight', () => {
    const all = item();
    assert.equal(tickerWindowOpen(all, 3, 0), true);
    assert.equal(tickerWindowOpen({ ...all, days: [5, 6] }, 3, 600), false);
    const lunch = { from: '12:00', to: '15:00', days: [0, 1, 2, 3, 4] };
    assert.equal(tickerWindowOpen(lunch, 3, 11 * 60 + 59), false);
    assert.equal(tickerWindowOpen(lunch, 3, 12 * 60), true);
    assert.equal(tickerWindowOpen(lunch, 3, 15 * 60), false); // the end is not included
    assert.equal(tickerWindowOpen(lunch, 5, 13 * 60), false); // Friday is not one of its days
    assert.equal(tickerWindowOpen({ from: '18:00', to: null, days: [3] }, 3, 23 * 60 + 59), true);
    assert.equal(tickerWindowOpen({ from: '18:00', to: null, days: [3] }, 3, 17 * 60), false);
    assert.equal(tickerWindowOpen({ from: null, to: '10:00', days: [3] }, 3, 9 * 60), true);
    assert.equal(tickerWindowOpen({ from: null, to: '10:00', days: [3] }, 3, 10 * 60), false);
    // Thursday night 22:00 → 02:00: Thursday late, and Friday's small hours (they are Thursday's).
    const late = { from: '22:00', to: '02:00', days: [4] };
    assert.equal(tickerWindowOpen(late, 4, 23 * 60), true);
    assert.equal(tickerWindowOpen(late, 5, 60), true);
    assert.equal(tickerWindowOpen(late, 5, 2 * 60), false);
    assert.equal(tickerWindowOpen(late, 4, 60), false); // Thursday's own small hours are Wednesday's
    assert.equal(tickerWindowOpen(late, 5, 23 * 60), false);
    // No days given counts as every day.
    assert.equal(tickerWindowOpen({ from: null, to: null, days: [] }, 2, 0), true);
  });

  it('a text live now: on, not blank, within its dates and its hours', () => {
    const now = at(13);
    assert.equal(tickerItemLive(item(), now), true);
    assert.equal(tickerItemLive(item({ enabled: false }), now), false);
    assert.equal(tickerItemLive(item({ text: '   ' }), now), false);
    assert.equal(tickerItemLive(item({ startsAt: at(14).toISOString() }), now), false);
    assert.equal(tickerItemLive(item({ endsAt: at(13).toISOString() }), now), false);
    assert.equal(tickerItemLive(item({ startsAt: at(12).toISOString(), endsAt: at(14).toISOString() }), now), true);
    assert.equal(tickerItemLive(item({ from: '12:00', to: '15:00', days: [3] }), now), true);
    assert.equal(tickerItemLive(item({ from: '12:00', to: '15:00', days: [3] }), at(16)), false);
  });

  it('the screens: only the chosen ones, the tip as "details", and only at its position', () => {
    const tk = ticker({ items: [item({ text: ' א ' }), item({ id: 't2', text: 'ב', enabled: false }), item({ id: 't3', text: 'ג', from: '20:00' })] });
    assert.deepEqual(tickerTextsNow(tk, 'catalog', at(13)), ['א']);
    assert.deepEqual(tickerTextsNow(tk, 'catalog', at(21)), ['א', 'ג']);
    assert.deepEqual(tickerTextsNow(tk, 'product', at(13)), ['א']);
    assert.deepEqual(tickerTextsNow(tk, 'cart', at(13)), ['א']);
    assert.deepEqual(tickerTextsNow(tk, 'pay', at(13)), []);
    assert.deepEqual(tickerTextsNow({ ...tk, enabled: false }, 'catalog', at(13)), []);
    assert.deepEqual(tickerTextsNow(undefined, 'catalog', at(13)), []);
    assert.deepEqual(tickerTextsNow({ ...tk, screens: ['details'] }, 'tip', at(13)), ['א']);
    assert.equal(tickerScreenOf('tip'), 'details');
    assert.equal(tickerScreenOf('confirm'), 'cart');
    assert.equal(tickerScreenOf('paused'), null);
    assert.equal(tickerScreenOf('closed'), null);
    assert.equal(tickerAt(tk, 'catalog', 'top'), true);
    assert.equal(tickerAt(tk, 'catalog', 'bottom'), false);
    assert.equal(tickerAt({ ...tk, position: 'bottom' }, 'cart', 'bottom'), true);
    assert.equal(tickerAt(tk, 'attract', 'top'), false);
  });

  it('it moves the way it reads, and loops seamlessly at its speed', () => {
    assert.equal(textDirection('מבצע 1+1'), 'rtl');
    assert.equal(textDirection('  2 for 1 '), 'ltr');
    assert.equal(textDirection('١٢ خصم'), 'rtl');
    assert.equal(textDirection('123 — 456'), null);
    assert.equal(tickerDirection(['123', 'Happy hour', 'שעה שמחה'], 'rtl'), 'ltr');
    assert.equal(tickerDirection(['₪ 5'], 'rtl'), 'rtl');
    assert.equal(tickerDirection([], 'ltr'), 'ltr');
    assert.equal(tickerCopies(1080, 400), 4); // 3 to fill 1080, one to spare
    assert.equal(tickerCopies(1080, 2000), 2);
    assert.equal(tickerCopies(0, 0), 2);
    assert.equal(tickerLoopMs(450, 'slow'), 10_000);
    assert.equal(tickerLoopMs(750, 'normal'), 10_000);
    assert.equal(tickerLoopMs(10, 'fast'), 1000); // never under a second
  });

  it('reduce motion: one text at a time, the next every few seconds', () => {
    assert.equal(tickerStaticIndex(3, 0), 0);
    assert.equal(tickerStaticIndex(3, TICKER_STATIC_MS - 1), 0);
    assert.equal(tickerStaticIndex(3, TICKER_STATIC_MS), 1);
    assert.equal(tickerStaticIndex(3, 3 * TICKER_STATIC_MS), 0);
    assert.equal(tickerStaticIndex(0, 99_999), 0);
  });

  it('colours: the theme button by default, custom ones as given (readable text on a custom background)', () => {
    const c = resolveThemeColors(KIOSK_DEFAULTS.theme);
    assert.deepEqual(tickerColors(KIOSK_DEFAULTS.ticker, c), { bg: c.button, fg: c.buttonText });
    assert.deepEqual(tickerColors({ backgroundColor: '#FFD60A', textColor: null }, c), { bg: '#FFD60A', fg: '#111111' });
    assert.deepEqual(tickerColors({ backgroundColor: '#111111', textColor: '#FFD60A' }, c), { bg: '#111111', fg: '#FFD60A' });
    assert.deepEqual(tickerColors({ backgroundColor: null, textColor: '#00FF00' }, c), { bg: c.button, fg: '#00FF00' });
  });

  it('a new text gets a free id', () => {
    assert.equal(nextTickerItemId([]), 't1');
    assert.equal(nextTickerItemId([{ id: 't2' }]), 't3');
    assert.equal(nextTickerItemId([{ id: 't1' }, { id: 't3' }]), 't4');
  });

  it('the room the strip takes on the attract screen (the hosts lay its start button out on the rest)', () => {
    const theme = KIOSK_DEFAULTS.theme;
    const on = ticker({ screens: ['attract'] });
    assert.deepEqual(tickerBandPx({ ticker: on, theme }, 'attract', at(13)), { top: 32, bottom: 0 });
    assert.deepEqual(tickerBandPx({ ticker: { ...on, position: 'bottom', size: 'l' }, theme }, 'attract', at(13), 18), { top: 0, bottom: 58 });
    assert.deepEqual(tickerBandPx({ ticker: on, theme: { ...theme, typeScale: 'xlarge' } }, 'attract', at(13)).top, 32 * 1.25);
    // Not on that screen, off, no text right now, or an older config: no room.
    assert.deepEqual(tickerBandPx({ ticker: on, theme }, 'catalog', at(13)), { top: 0, bottom: 0 });
    assert.deepEqual(tickerBandPx({ ticker: { ...on, enabled: false }, theme }, 'attract', at(13)), { top: 0, bottom: 0 });
    assert.deepEqual(tickerBandPx({ ticker: { ...on, items: [item({ from: '20:00' })] }, theme }, 'attract', at(13)), { top: 0, bottom: 0 });
    assert.deepEqual(tickerBandPx({ ticker: undefined, theme }, 'attract', at(13)), { top: 0, bottom: 0 });
  });
});

describe('"אפשר לבטל גם כפתור ברוכים הבאים": the attract button hidden, the whole screen starts', () => {
  it('visible by default; hidden needs "כל המסך פותח הזמנה", and the touch line is a text', () => {
    assert.equal(KIOSK_DEFAULTS.attract.cta.visible, true);
    assert.equal(KIOSK_DEFAULTS.attract.cta.touchHint, true);
    assert.deepEqual(validateKioskConfig(resolveKioskConfig({ attract: { cta: { visible: false } } })), []);
    const off = validateKioskConfig(resolveKioskConfig({ attract: { cta: { visible: false, tapAnywhere: false } } }));
    assert.ok(off.some((e) => e.path === 'attract.cta.tapAnywhere' && e.code === 'tapAnywhereRequired'));
    assert.equal(attractTapAnywhere({ tapAnywhere: false, visible: false }), true);
    assert.equal(attractTapAnywhere({ tapAnywhere: false, visible: true }), false);
    assert.ok((TEXT_KEYS as readonly string[]).includes('attractTouchHint'));
  });
});

describe('"איך תרצו לשלם?" — card, voucher, cash at the till (docs/SPEC_KIOSK.md §23)', () => {
  const codes = (c: KioskConfig) => validateKioskConfig(c).map((e) => `${e.path}:${e.code}`);
  it('the methods: card, voucher and cash at the till; a voucher never alone; bare cash refused', () => {
    assert.deepEqual(PAYMENT_METHODS, ['card', 'voucher', 'cash_at_till']);
    assert.deepEqual(KIOSK_DEFAULTS.payment.methods, ['card']);
    assert.equal(KIOSK_DEFAULTS.payment.cashAtTillExpiryMin, 30);
    assert.equal(KIOSK_DEFAULTS.payment.cashAtTillKitchenBeforePay, false);
    assert.deepEqual(validateKioskConfig(resolveKioskConfig({ payment: { methods: ['card', 'voucher', 'cash_at_till'] } })), []);
    assert.deepEqual(validateKioskConfig(resolveKioskConfig({ payment: { methods: ['cash_at_till'] } })), []);
    assert.ok(codes(cfg({ payment: { methods: ['voucher'] } })).includes('payment.methods:voucher_needs_method'));
    assert.ok(codes(cfg({ payment: { methods: ['card', 'cash'] } })).includes('payment.methods:cash_not_supported'));
    assert.ok(codes(cfg({ payment: { methods: ['card', 'bitcoin'] } })).includes('payment.methods:enum'));
    assert.ok(codes(cfg({ payment: { methods: ['card', 'card'] } })).includes('payment.methods:duplicate'));
    assert.ok(codes(cfg({ payment: { methods: [] } })).includes('payment.methods:atLeastOne'));
    assert.ok(codes(cfg({ payment: { cashAtTillExpiryMin: 2 } })).includes('payment.cashAtTillExpiryMin:range'));
    assert.ok(codes(cfg({ payment: { cashAtTillExpiryMin: 241 } })).includes('payment.cashAtTillExpiryMin:range'));
    assert.deepEqual(validateKioskConfig(resolveKioskConfig({ payment: { cashAtTillExpiryMin: 45, cashAtTillKitchenBeforePay: true } })), []);
    // What a kiosk takes (the cloud's repair, the till's parseList): a voucher gets the card beside it.
    assert.deepEqual(kioskPayMethods(['voucher']), ['card', 'voucher']);
    assert.deepEqual(kioskPayMethods(['cash_at_till', 'cash', 'voucher', 'cash_at_till']), ['cash_at_till', 'voucher']);
    assert.deepEqual(kioskPayMethods(undefined), ['card']);
    assert.deepEqual(resolveKioskConfig({ payment: { methods: ['voucher'] } }).payment.methods, ['card', 'voucher']);
  });
  it('the choice: asked with more than one method (or cash at the till alone), always the last step', () => {
    assert.equal(kioskAsksPayMethod(['card']), false);
    assert.equal(kioskAsksPayMethod(['card', 'voucher']), true);
    assert.equal(kioskAsksPayMethod(['cash_at_till']), true);
    const pay = { ...KIOSK_DEFAULTS.payment, tipEnabled: true, methods: ['card', 'cash_at_till'] };
    assert.deepEqual(checkoutStepsNow(pay, true, false), ['tip', 'details', 'payMethod']);
    assert.deepEqual(checkoutStepsNow({ ...pay, tipEnabled: false }, false, false), ['payMethod']);
    assert.deepEqual(checkoutStepsNow({ ...pay, checkoutSteps: ['payMethod', 'details', 'tip'] }, true, false), ['details', 'tip', 'payMethod']);
    assert.deepEqual(resolveKioskConfig({ payment: { checkoutSteps: ['payMethod', 'details'] } }).payment.checkoutSteps, ['details', 'payMethod']);
    const bar = checkoutBar(['details', 'payMethod'], 'payMethod');
    assert.deepEqual(bar.map((b) => [b.key, b.textKey, b.state]), [
      ['review', 'stepReview', 'done'],
      ['details', 'stepDetails', 'done'],
      ['payMethod', 'stepPayMethod', 'current'],
      ['pay', 'stepPay', 'next'],
    ]);
  });
  it('the remainder after the vouchers, in agorot', () => {
    assert.equal(kioskRemainderAgorot(6250, 500, [2500]), 4250);
    assert.equal(kioskRemainderAgorot(6250, 0, [2500, 3750]), 0);
    assert.equal(kioskRemainderAgorot(1000, 0, [5000]), 0);
    assert.equal(kioskRemainderAgorot(1000, 0, [-100]), 1000);
  });
  it('every new text is editable, with built-in Hebrew words', () => {
    const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
    for (const k of ['stepPayMethod', 'payMethodTitle', 'payCashLabel', 'remainingToPay', 'voucherOffline', 'cashSlipTitle', 'cashSlipFooter', 'cashSlipPending', 'cashDoneTitle', 'cashDoneBody']) {
      assert.ok((TEXT_KEYS as readonly string[]).includes(k), k);
      assert.ok(he.kiosks.builtin[k], k);
      assert.ok(he.kiosks.fields.texts[k], k);
    }
    assert.equal(he.kiosks.builtin.payMethodTitle, 'איך תרצו לשלם?');
    assert.equal(he.kiosks.builtin.cashSlipTitle, 'לתשלום בקופה');
    assert.equal(he.kiosks.builtin.cashSlipFooter, 'ההזמנה תוכן לאחר התשלום');
  });
});

import { STEP_MODE_DEFAULTS, STEP_MODE_KEYS, stepMode, stepDefaultService, validateKioskConfig as validateForSteps } from './kioskConfig';

describe('"חובה / רשות / כבוי" per step (payment.stepModes — the server kiosk_config.step_mode, the till KioskStepModes.kt)', () => {
  const cfg = (general: Record<string, unknown> = {}, payment: Record<string, unknown> = {}) => ({
    general: { ...KIOSK_DEFAULTS.general, ...general },
    payment: { ...KIOSK_DEFAULTS.payment, ...payment },
  });
  it('the defaults, as the server sends them', () => {
    assert.deepEqual(KIOSK_DEFAULTS.payment.stepModes, {
      service: 'required', tip: 'optional', payMethod: 'required', upsellItem: 'optional', upsellSteps: 'optional', upsellCheckout: 'optional',
    });
    assert.deepEqual(STEP_MODE_KEYS, Object.keys(STEP_MODE_DEFAULTS));
  });
  it("each step's own switch comes first", () => {
    assert.equal(stepMode(cfg(), 'service'), 'required');
    assert.equal(stepMode(cfg(), 'tip'), 'off'); // tips off by default
    assert.equal(stepMode(cfg(), 'payMethod'), 'off'); // the card alone
    assert.equal(stepMode(cfg({ serviceTypes: ['take_away'] }), 'service'), 'off');
    const on = cfg({}, { tipEnabled: true, methods: ['card', 'cash_at_till'], stepModes: { tip: 'required', payMethod: 'optional' } });
    assert.equal(stepMode(on, 'tip'), 'required');
    assert.equal(stepMode(on, 'payMethod'), 'optional');
    assert.equal(stepMode(cfg({ upsellEnabled: false }), 'upsellItem'), 'off');
    assert.equal(stepMode(cfg({}, { stepModes: { upsellCheckout: 'required' } }), 'upsellCheckout'), 'required');
    assert.equal(stepMode(cfg({}, { customerPhone: 'required' }), 'customerPhone'), 'required');
    // A layer from before the field: the defaults.
    assert.equal(stepMode({ general: {}, payment: { tipEnabled: true, tipPresets: [10] } }, 'tip'), 'optional');
  });
  it('a step set off is never asked before the payment', () => {
    const pay = { ...KIOSK_DEFAULTS.payment, tipEnabled: true, methods: ['card', 'cash_at_till'] };
    assert.deepEqual(checkoutStepsNow(pay, false, false), ['tip', 'payMethod']);
    assert.deepEqual(checkoutStepsNow({ ...pay, stepModes: { tip: 'off' } }, false, false), ['payMethod']);
    assert.deepEqual(checkoutStepsNow({ ...pay, stepModes: { payMethod: 'off' } }, false, false), ['tip']);
  });
  it('validated like the server', () => {
    const good = { ...KIOSK_DEFAULTS, payment: { ...KIOSK_DEFAULTS.payment, stepModes: { service: 'optional' as const } } };
    assert.equal(validateForSteps(good).filter((e) => e.path.startsWith('payment.stepModes')).length, 0);
    const bad = { ...KIOSK_DEFAULTS, payment: { ...KIOSK_DEFAULTS.payment, stepModes: { tip: 'sometimes', soon: 'off' } as never } };
    const paths = validateForSteps(bad).map((e) => e.path);
    assert.ok(paths.includes('payment.stepModes.tip') && paths.includes('payment.stepModes.soon'));
  });
  it('the default service when the step is passed', () => {
    assert.equal(stepDefaultService(['eat_in', 'take_away']), 'eat_in');
    assert.equal(stepDefaultService([]), 'take_away');
  });
});

describe('"מנוע תצוגה בקיוסק אנדרואיד" — general.renderer (the server kiosk_config.py RENDERERS)', () => {
  it('defaults to the built-in screens and takes native or web only', () => {
    assert.equal(KIOSK_DEFAULTS.general.renderer, 'native');
    const codes = (renderer: unknown) =>
      validateKioskConfig(setPath(cloneJson(KIOSK_DEFAULTS), 'general.renderer', renderer)).map((e) => `${e.path}:${e.code}`);
    assert.deepEqual(codes('web'), []);
    assert.deepEqual(codes('native'), []);
    assert.deepEqual(codes('html'), ['general.renderer:enum']);
  });
});

describe('"איך תרצו לשלם?" by its mode (payMethodAsk, stepModes.payMethod — PARITY gap 10)', () => {
  it('the card alone and usable: straight to the pinpad; nothing that pays: not asked', () => {
    assert.deepEqual(payMethodAsk(['card'], ['card'], 'off'), { asks: false, optional: false, fallback: 'card' });
    assert.deepEqual(payMethodAsk(['card', 'voucher'], ['voucher'], 'required'), { asks: false, optional: false, fallback: null });
  });

  it('off: the card charged without asking when it is offered and usable — else asked as required', () => {
    assert.deepEqual(payMethodAsk(['card', 'cash_at_till', 'voucher'], ['card', 'cash_at_till', 'voucher'], 'off'), { asks: false, optional: false, fallback: 'card' });
    assert.deepEqual(payMethodAsk(['card', 'cash_at_till'], ['cash_at_till'], 'off'), { asks: true, optional: false, fallback: 'cash_at_till' });
    assert.deepEqual(payMethodAsk(['cash_at_till', 'voucher'], ['cash_at_till', 'voucher'], 'off'), { asks: true, optional: false, fallback: 'cash_at_till' });
  });

  it('optional: asked, and may be passed with the default; required: a choice made', () => {
    assert.deepEqual(payMethodAsk(['cash_at_till', 'card'], ['cash_at_till', 'card'], 'optional'), { asks: true, optional: true, fallback: 'card' });
    assert.deepEqual(payMethodAsk(['cash_at_till', 'card'], ['cash_at_till', 'card'], 'required'), { asks: true, optional: false, fallback: 'card' });
    assert.deepEqual(payMethodAsk(['cash_at_till'], ['cash_at_till'], 'required'), { asks: true, optional: false, fallback: 'cash_at_till' });
  });
});

import {
  MONO_FIGURES_STACK,
  NO_CHROME,
  STATUS_LINE_DP,
  STATUS_WARN,
  TECH_ADD_GLOW_MS,
  TECH_PRESS_SCALE,
  TECH_SCAN_MS,
  buttonRadius as buttonRadiusOf,
  contrastRatio as contrastRatioOf,
  contrastText as contrastTextOf,
  kioskChrome,
  kioskRestLook as kioskRestLookOf,
  kioskServiceLook as kioskServiceLookOf,
  kioskStatusLine,
  luminance as luminanceOf,
  resolveKioskConfig as resolveTech,
  resolveThemeColors as colorsOf,
  statusClock,
  UI_STYLES as STYLES,
  validateKioskConfig as validateTech,
} from './kioskConfig';

describe('"טכנולוגי" — the tech style (the server UI_PRESETS["tech"], the till KioskUiPresets / KioskChrome)', () => {
  const tech = () => resolveTech({ theme: { uiStyle: 'tech' } });

  it('is one pick: its theme, attract button and transitions, valid, the last of the styles', () => {
    assert.equal(STYLES[STYLES.length - 1], 'tech');
    const c = tech();
    assert.deepEqual(validateTech(c), []);
    assert.deepEqual(
      [c.theme.mode, c.theme.font, c.theme.primaryColor, c.theme.accentColor, c.theme.backgroundColor, c.theme.surfaceColor, c.theme.textColor],
      ['dark', 'heebo', '#22E1FF', '#22E1FF', '#0B0F14', '#111821', '#E6EDF3'],
    );
    assert.deepEqual([c.theme.cornerRadius, c.theme.cardStyle, c.theme.buttonShape, c.theme.categoryStyle, c.theme.typeWeight], [10, 'outlined', 'rounded', 'tabs', 'regular']);
    assert.deepEqual(
      [c.attract.cta.size, c.attract.cta.icon, c.attract.cta.animation, c.attract.cta.shadow, c.attract.cta.borderWidth],
      ['l', 'arrow', 'none', false, 0],
    );
    assert.deepEqual(c.motion, { categorySwitch: 'fade', itemsEnter: 'cascade', screenChange: 'fade', sheet: 'scale', addToCart: 'fly', speed: 'normal', effects: 'auto' });
    // The brand colour stays the business's: the style follows it.
    assert.equal(resolveTech({ theme: { uiStyle: 'tech' } }, { theme: { primaryColor: '#3B82F6' } }).theme.primaryColor, '#3B82F6');
  });

  it('reads: dark words on the accent (on the till too — its luminance is above 0.55), text and muted text on the background', () => {
    const c = tech();
    const colors = colorsOf(c.theme);
    assert.equal(colors.buttonText, '#111111');
    assert.equal(contrastTextOf('#22E1FF'), '#111111');
    assert.ok(luminanceOf('#22E1FF') > 0.55);
    assert.ok(contrastRatioOf(colors.buttonText, colors.button) >= 4.5);
    assert.ok(contrastRatioOf(colors.text, colors.background) >= 7);
    assert.ok(contrastRatioOf(colors.mutedText, colors.background) >= 4.5);
    assert.equal(buttonRadiusOf(c.theme), 6);
  });

  it("its chrome, the till's numbers: a 32 dp grid at 6 %, 1 dp outlines, the status line, the figures, the micro-motion", () => {
    const c = tech();
    const ch = kioskChrome(c.theme, colorsOf(c.theme), c.general);
    assert.deepEqual(ch, {
      backdrop: 'grid', backdropStep: 32, backdropInk: '#E6EDF30F', outline: '#2F363E',
      statusBar: true, tabularFigures: true, monoFigures: true,
      pressScale: TECH_PRESS_SCALE, addGlowMs: TECH_ADD_GLOW_MS, scanMs: TECH_SCAN_MS, accent: '#22E1FF',
    });
    assert.deepEqual([TECH_PRESS_SCALE, TECH_ADD_GLOW_MS, TECH_SCAN_MS, STATUS_LINE_DP, STATUS_WARN], [0.98, 150, 7000, 28, '#F5A524']);
    assert.ok(MONO_FIGURES_STACK.endsWith('monospace'));
    // Reduce motion: nothing moves (the scan line not even mounted); the look stays.
    const still = kioskChrome(c.theme, colorsOf(c.theme), { reduceMotion: true });
    assert.deepEqual([still.addGlowMs, still.scanMs, still.backdrop, still.statusBar], [0, 0, 'grid', true]);
    // The accent follows the brand colour.
    const blue = resolveTech({ theme: { uiStyle: 'tech', primaryColor: '#3b82f6' } });
    assert.equal(kioskChrome(blue.theme, colorsOf(blue.theme), blue.general).accent, '#3B82F6');
  });

  it('every other style draws exactly as before: no chrome at all', () => {
    for (const style of STYLES.filter((s) => s !== 'tech')) {
      const c = resolveTech({ theme: { uiStyle: style } });
      const { accent, ...rest } = kioskChrome(c.theme, colorsOf(c.theme), c.general);
      assert.deepEqual(rest, NO_CHROME, style);
      assert.equal(accent, c.theme.primaryColor.toUpperCase(), style);
    }
  });

  it("its service choices and its closed screen (the till's KioskServiceLook / KioskRestLook)", () => {
    const c = tech();
    const colors = colorsOf(c.theme);
    assert.deepEqual(kioskServiceLookOf(c.theme, colors), {
      from: '#111821', to: '#111821', diagonal: false, ink: '#E6EDF3', badge: '#22E1FF1F', icon: '#22E1FF', border: '#22E1FF',
    });
    assert.deepEqual(kioskRestLookOf(c.theme, colors), {
      from: '#0B0F14', to: '#0B0F14', diagonal: false, glow: null, ink: '#E6EDF3', title: '#22E1FF', spots: false,
    });
  });

  it("the status line: the state of every screen, its tone, the order's number once it has one; the clock", () => {
    const at = (screen: string, pickup?: string | null) => kioskStatusLine(screen, pickup);
    assert.deepEqual(at('attract'), { key: 'ready', tone: 'ok', order: null });
    for (const s of ['service', 'catalog', 'product', 'confirm', 'cart', 'tip', 'details']) assert.equal(at(s).key, 'ordering', s);
    assert.equal(at('pay').key, 'paying');
    assert.deepEqual(at('success', ' A-17 '), { key: 'done', tone: 'ok', order: 'A-17' });
    assert.deepEqual(at('success', ''), { key: 'done', tone: 'ok', order: null });
    const warn: Array<[string, string]> = [['paused', 'paused'], ['closed', 'closed'], ['no_payment', 'noPayment'], ['noPayment', 'noPayment'], ['offline', 'offline'], ['setup', 'setup']];
    for (const [s, key] of warn) assert.deepEqual(at(s), { key, tone: 'warn', order: null }, s);
    assert.equal(at('something-new').key, 'ready');
    assert.equal(statusClock(new Date(2026, 9, 7, 9, 5)), '09:05');
    assert.equal(statusClock(new Date(2026, 9, 7, 23, 59)), '23:59');
  });

  it("the status line's words are in the dashboard's messages (the kiosks read them from there)", () => {
    const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
    const words = he.kiosks.preview.status;
    for (const key of ['ready', 'ordering', 'paying', 'done', 'paused', 'closed', 'noPayment', 'offline', 'setup', 'order']) {
      assert.ok(typeof words[key] === 'string' && words[key].length > 0, key);
    }
    assert.equal(words.ready, 'מוכן לקבל הזמנה');
    assert.equal(he.kiosks.appearance.styles.tech.name, 'טכנולוגי');
  });
});

import { SERVICE_CHOICES, serviceChoiceOf, serviceChoicePatch, waitLogoOf, WAIT_LOGO_STYLES } from './kioskConfig';

describe('"סוג שירות" — שואלים · תמיד טייק אווי · תמיד ישיבה במקום · ללא (general.serviceMode, the server kiosk_config.py)', () => {
  it('the four choices read from serviceTypes and serviceMode', () => {
    assert.deepEqual(SERVICE_CHOICES, ['ask', 'take_away', 'eat_in', 'none']);
    assert.equal(KIOSK_DEFAULTS.general.serviceMode, 'types');
    assert.equal(serviceChoiceOf(KIOSK_DEFAULTS.general), 'ask');
    assert.equal(serviceChoiceOf({ serviceTypes: ['eat_in'] }), 'eat_in');
    assert.equal(serviceChoiceOf({ serviceTypes: ['take_away'], serviceMode: 'types' }), 'take_away');
    assert.equal(serviceChoiceOf({ serviceTypes: ['take_away', 'eat_in'], serviceMode: 'none' }), 'none');
    assert.equal(serviceChoiceOf({}), 'take_away', 'a layer from before the field, with nothing: as the kiosk reads it');
  });

  it('each choice writes both fields; "ללא" keeps the types for the day it is back', () => {
    const asked = { serviceTypes: ['eat_in', 'take_away'] as ('eat_in' | 'take_away')[], serviceMode: 'types' as const };
    assert.deepEqual(serviceChoicePatch(asked, 'none'), { serviceTypes: ['eat_in', 'take_away'], serviceMode: 'none' });
    assert.deepEqual(serviceChoicePatch({ ...asked, serviceMode: 'none' }, 'ask'), { serviceTypes: ['eat_in', 'take_away'], serviceMode: 'types' });
    assert.deepEqual(serviceChoicePatch({ serviceTypes: ['eat_in'] }, 'ask'), { serviceTypes: ['eat_in', 'take_away'], serviceMode: 'types' });
    assert.deepEqual(serviceChoicePatch(asked, 'take_away'), { serviceTypes: ['take_away'], serviceMode: 'types' });
    assert.deepEqual(serviceChoicePatch(asked, 'eat_in'), { serviceTypes: ['eat_in'], serviceMode: 'types' });
    assert.deepEqual(serviceChoicePatch({ serviceTypes: [] }, 'none'), { serviceTypes: ['take_away'], serviceMode: 'none' });
  });

  it('"ללא": the service step is off, and the mode is validated', () => {
    const none = { general: { ...KIOSK_DEFAULTS.general, serviceMode: 'none' as const }, payment: { ...KIOSK_DEFAULTS.payment } };
    assert.equal(stepMode(none, 'service'), 'off');
    assert.equal(stepMode({ general: { ...KIOSK_DEFAULTS.general }, payment: { ...KIOSK_DEFAULTS.payment } }, 'service'), 'required');
    const ok = { ...KIOSK_DEFAULTS, general: { ...KIOSK_DEFAULTS.general, serviceMode: 'none' as const } };
    assert.equal(validateKioskConfig(ok).filter((e) => e.path.startsWith('general.service')).length, 0);
    const bad = { ...KIOSK_DEFAULTS, general: { ...KIOSK_DEFAULTS.general, serviceMode: 'never' as never } };
    assert.ok(validateKioskConfig(bad).some((e) => e.path === 'general.serviceMode' && e.code === 'enum'));
  });
});

describe('"לוגו במסך התשלום" (payment.waitLogo, the server kiosk_config.py WAIT_LOGO_STYLES)', () => {
  const ref = { url: 'https://cdn.example/wait.png', kind: 'image' as const, sha256: null, bytes: null };

  it('its own picture: none by default — nothing shows', () => {
    assert.deepEqual(KIOSK_DEFAULTS.payment.waitLogo, { media: null, style: 'plain' });
    assert.equal(waitLogoOf(KIOSK_DEFAULTS.payment), null);
    assert.equal(waitLogoOf({}), null, 'a server from before it');
    assert.deepEqual(waitLogoOf({ waitLogo: { media: ref, style: 'plain' } }), { url: ref.url, plate: false });
    assert.deepEqual(waitLogoOf({ waitLogo: { media: ref, style: 'plate' } }), { url: ref.url, plate: true });
    assert.deepEqual(WAIT_LOGO_STYLES, ['plain', 'plate']);
  });

  it('validated: an image only, and its style', () => {
    const cfgWith = (waitLogo: unknown) => ({ ...KIOSK_DEFAULTS, payment: { ...KIOSK_DEFAULTS.payment, waitLogo: waitLogo as never } });
    assert.equal(validateKioskConfig(cfgWith({ media: ref, style: 'plate' })).filter((e) => e.path.startsWith('payment.waitLogo')).length, 0);
    const bad = validateKioskConfig(cfgWith({ media: { ...ref, kind: 'video' }, style: 'glow' })).map((e) => e.path);
    assert.ok(bad.some((p) => p.startsWith('payment.waitLogo.media')), String(bad));
    assert.ok(bad.includes('payment.waitLogo.style'), String(bad));
  });
});

import {
  ADD_LIVELY as GOLD_ADD_LIVELY,
  ADD_MAX_MS as GOLD_ADD_MAX_MS,
  ADD_SUBTLE as GOLD_ADD_SUBTLE,
  EASE_ENTER as GOLD_EASE_ENTER,
  EASE_EXIT as GOLD_EASE_EXIT,
  EASE_POP_RISE as GOLD_EASE_POP_RISE,
  EASE_POP_SETTLE as GOLD_EASE_POP_SETTLE,
  EASE_STRIP as GOLD_EASE_STRIP,
  FRAME_MIN,
  FRAME_P90_BUDGETS,
  FRAME_SLOW_FACTOR,
  FRAME_SLOW_SHARE,
  MOTION_EFFECTS as GOLD_EFFECTS,
  MOTION_SPEED_FACTOR as GOLD_SPEED,
  STAGGER_CAP_MS as GOLD_STAGGER_CAP_MS,
  STAGGER_MAX_CARDS as GOLD_STAGGER_MAX_CARDS,
  TRANSITION_BASE_MS as GOLD_BASE,
  frameVerdict,
  gridEnterMs as goldGridEnterMs,
  kioskChrome as goldChrome,
  kioskRenderProfile,
  lightenMotion,
  motionSpec as goldMotionSpec,
  profileMotion,
  resolveKioskConfig as goldResolve,
  resolveThemeColors as goldColors,
  transitionSpec as goldTransitionSpec,
  type KioskMotionSettings,
} from './kioskConfig';

/**
 * The shared golden of the kiosk's motion — server/tests/fixtures/kiosk_motion_timings.json, the
 * till's KioskTransitions / KioskMotion / KioskEase / KioskPerf numbers (pos-android
 * perf/kiosk-render). This side's table, curves and resolved specs must be exactly it.
 */
describe('"הנפשות ומעברים" — the shared motion golden (kiosk_motion_timings.json, the till\'s table)', () => {
  const gold = JSON.parse(readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'kiosk_motion_timings.json'), 'utf8'));
  const bezier = (c: number[]) => `cubic-bezier(${c.map((n) => String(n).replace(/^0\./, '.')).join(',')})`;

  it('the table: each effect at normal speed, the speeds, the cascade', () => {
    assert.deepEqual(GOLD_SPEED, gold.speedFactor);
    assert.deepEqual(GOLD_BASE.screenChange, gold.screenChange);
    assert.deepEqual(GOLD_BASE.categorySwitch, gold.categorySwitch);
    assert.deepEqual(GOLD_BASE.itemsEnter, gold.itemsEnter);
    assert.deepEqual(GOLD_BASE.stagger, gold.stagger);
    assert.deepEqual(GOLD_BASE.sheet, gold.sheet);
    assert.equal(GOLD_STAGGER_CAP_MS, gold.staggerCapMs);
    assert.equal(GOLD_STAGGER_MAX_CARDS, gold.staggerMaxCards);
  });

  it('the add: the pop-and-fly ~560 ms, the count-up 360, the bounce-only and the reduce-motion fade', () => {
    const pick = (m: typeof GOLD_ADD_LIVELY) => ({ popMs: m.popMs, popScale: m.popScale, flyMs: m.flyMs, arcDp: m.arcDp, bounce: m.bounce, countUpMs: m.countUpMs });
    assert.deepEqual(pick(GOLD_ADD_LIVELY), gold.add.lively);
    assert.deepEqual(pick(GOLD_ADD_SUBTLE), gold.add.subtle);
    assert.equal(GOLD_ADD_LIVELY.popMs + GOLD_ADD_LIVELY.flyMs, 560);
    assert.equal(GOLD_ADD_MAX_MS, gold.add.maxMs);
    const on = { reduceMotion: false };
    assert.equal(goldMotionSpec({ animation: 'lively' }, on, { addToCart: 'bounce' }).bounce, gold.add.bounceOnly.lively);
    assert.equal(goldMotionSpec({ animation: 'subtle' }, on, { addToCart: 'bounce' }).bounce, gold.add.bounceOnly.subtle);
    assert.equal(goldMotionSpec({ animation: 'lively' }, { reduceMotion: true }).fadeMs, gold.add.reduceMotionFadeMs);
  });

  it('the curves: arrivals, departures, the push as one strip, the pop — and the CSS plays exactly them', () => {
    assert.equal(GOLD_EASE_ENTER, bezier(gold.curves.arrive));
    assert.equal(GOLD_EASE_EXIT, bezier(gold.curves.leave));
    assert.equal(GOLD_EASE_STRIP, bezier(gold.curves.strip));
    assert.equal(GOLD_EASE_POP_RISE, bezier(gold.curves.popRise));
    assert.equal(GOLD_EASE_POP_SETTLE, bezier(gold.curves.popSettle));
    const css = readFileSync(join(process.cwd(), 'src', 'components', 'dashboard', 'kiosks', 'preview-motion.tsx'), 'utf8');
    // No other curve, and no old time, left in the transitions' CSS.
    const curves = new Set(css.match(/cubic-bezier\([^)]*\)/g) ?? []);
    for (const c of curves) assert.fail(`a literal curve in MOTION_CSS: ${c}`);
    assert.ok(css.includes('.k-anim { animation-duration: var(--k-ms, 220ms); animation-timing-function: ${EASE_ENTER};'));
    assert.ok(css.includes('.k-leave.k-anim { animation-fill-mode: forwards; animation-timing-function: ${EASE_EXIT}; }'));
    assert.ok(css.includes('.k-anim.k-push-in, .k-leave.k-anim.k-push-out { animation-timing-function: ${EASE_STRIP}; }'));
  });

  it('every example resolves to the golden times — full and light, every speed', () => {
    for (const ex of gold.examples as Array<{ motion: KioskMotionSettings; light?: boolean; animation: 'lively' | 'subtle'; transitions: Record<string, number>; add: Record<string, number> }>) {
      const played = profileMotion(ex.motion, ex.light ? 'light' : 'full');
      const t = goldTransitionSpec(played, { reduceMotion: false });
      const got = { categoryMs: t.categoryMs, itemMs: t.itemMs, staggerMs: t.staggerMs, staggerCapMs: t.staggerCapMs, screenMs: t.screenMs, sheetMs: t.sheetMs, gridEnterMs: goldGridEnterMs(t) };
      assert.deepEqual(got, ex.transitions, JSON.stringify(ex.motion));
      const m = goldMotionSpec({ animation: ex.animation }, { reduceMotion: false }, played);
      assert.deepEqual({ popMs: m.popMs, flyMs: m.flyMs, countUpMs: m.countUpMs }, ex.add, JSON.stringify(ex.motion));
    }
  });
});

describe('"אפקטים" — motion.effects: auto / full / light (the till\'s KioskPerf)', () => {
  const gold = JSON.parse(readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'kiosk_motion_timings.json'), 'utf8'));

  it('the vocabulary, its default (auto: the device decides) and no style choosing it', () => {
    assert.deepEqual(GOLD_EFFECTS, gold.effects);
    assert.equal(goldResolve().motion.effects, 'auto');
    for (const style of ['ios', 'wolt', 'classic', 'minimal_dark', 'tech'] as const) {
      assert.equal(goldResolve({ theme: { uiStyle: style } }).motion.effects, 'auto', style);
    }
    assert.equal(goldResolve({ motion: { effects: 'light' } }, { theme: { uiStyle: 'classic' } }).motion.effects, 'light');
  });

  it('light: fades at the fast pace, no cascade ("none" stays none), the add keeps its kind', () => {
    const wolt = goldResolve().motion;
    const light = lightenMotion(wolt);
    assert.deepEqual(
      { categorySwitch: light.categorySwitch, itemsEnter: light.itemsEnter, screenChange: light.screenChange, sheet: light.sheet, speed: light.speed },
      gold.light,
    );
    assert.equal(light.addToCart, wolt.addToCart);
    assert.equal(light.effects, 'auto');
    const none = lightenMotion({ ...wolt, categorySwitch: 'none', screenChange: 'none', sheet: 'none' });
    assert.deepEqual([none.categorySwitch, none.screenChange, none.sheet], ['none', 'none', 'none']);
    assert.equal(profileMotion(wolt, 'full'), wolt);
  });

  it('the profile: the config first; auto — light when the device asks for less motion or measured slow', () => {
    assert.equal(kioskRenderProfile('full', { reducedMotion: true, slow: true }), 'full');
    assert.equal(kioskRenderProfile('light'), 'light');
    assert.equal(kioskRenderProfile('auto'), 'full');
    assert.equal(kioskRenderProfile(undefined), 'full');
    assert.equal(kioskRenderProfile('auto', { reducedMotion: true }), 'light');
    assert.equal(kioskRenderProfile('auto', { slow: true }), 'light');
    assert.equal(kioskRenderProfile('auto', { slow: false }), 'full');
    assert.equal(kioskRenderProfile('auto', { slow: null }), 'full');
  });

  it('the slow-frame probe judges as the till does: enough frames, a quarter late or the slowest tenth at two budgets', () => {
    assert.deepEqual([FRAME_MIN, FRAME_SLOW_FACTOR, FRAME_SLOW_SHARE, FRAME_P90_BUDGETS], [
      gold.frameProbe.minFrames, gold.frameProbe.slowFactor, gold.frameProbe.slowShare, gold.frameProbe.p90Budgets,
    ]);
    const steady = Array.from({ length: 160 }, () => 16.7);
    assert.equal(frameVerdict(steady).slow, false);
    assert.equal(frameVerdict(steady.slice(0, 100).map(() => 40)).slow, false, 'too few frames judge nothing');
    // A quarter over 1.25 budgets (≈20.8 ms at 60 Hz).
    const jank = steady.map((d, i) => (i % 4 === 0 ? 25 : d));
    assert.equal(frameVerdict(jank).slow, true);
    assert.ok(Math.abs(frameVerdict(jank).slowShare - 0.25) < 1e-9);
    // The slowest tenth at two budgets and more.
    const tail = steady.map((d, i) => (i % 8 === 0 ? 34 : d));
    assert.equal(frameVerdict(tail).p90Ms, 34);
    assert.equal(frameVerdict(tail).slow, true);
    assert.equal(frameVerdict(steady.map((d) => d / 2), 120).slow, false, 'a 120 Hz screen at its own budget');
    assert.deepEqual(frameVerdict([]), { frames: 0, p50Ms: 0, p90Ms: 0, slowShare: 0, budgetMs: 1000 / 60, slow: false });
  });

  it('light draws none of the tech style\'s glow and scan line; the look stays', () => {
    const c = goldResolve({ theme: { uiStyle: 'tech' } });
    const full = goldChrome(c.theme, goldColors(c.theme), c.general, 'full');
    const light = goldChrome(c.theme, goldColors(c.theme), c.general, 'light');
    assert.ok(full.addGlowMs > 0 && full.scanMs > 0);
    assert.deepEqual([light.addGlowMs, light.scanMs], [0, 0]);
    assert.deepEqual({ ...light, addGlowMs: full.addGlowMs, scanMs: full.scanMs }, full);
  });
});

describe('"בון מטבח במדפסת הקיוסק" — printing.bonOnKiosk (the server kiosk_config.py, the till KioskBon.route)', () => {
  const codes = (c: KioskConfig) => validateKioskConfig(c).map((e) => `${e.path}:${e.code}`);
  it('off by default — an existing kiosk whose layers never had it too — and a boolean', () => {
    assert.equal(KIOSK_DEFAULTS.printing.bonOnKiosk, false);
    assert.equal(KIOSK_DEFAULTS.printing.pickupSlip, true);
    const royal = resolveKioskConfig({ printing: { bonMode: 'single', bonPrinterId: 'p-usb', receiptPrinterId: 'p-usb', bonAutoRetryMin: 0 } });
    assert.equal(royal.printing.bonOnKiosk, false);
    assert.deepEqual(validateKioskConfig(royal), []);
    assert.equal(resolveKioskConfig({ printing: { bonOnKiosk: true } }).printing.bonOnKiosk, true);
    assert.equal(resolveKioskConfig({ printing: { bonOnKiosk: true } }, { printing: { bonOnKiosk: false } }).printing.bonOnKiosk, false);
    assert.ok(codes(cfg({ printing: { bonOnKiosk: 'yes' } })).includes('printing.bonOnKiosk:enum'));
  });
});