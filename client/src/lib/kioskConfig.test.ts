/**
 * Run with `npm test`. The self-order kiosk's configuration rules (lib/kioskConfig.ts):
 * the layer merge, the minimal layer to save, validation, the kiosk's catalog order and
 * the pickup label — the same rules the server and the till apply.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
  type KioskConfig,
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
    assert.equal(kioskConnection({ online: true, lastKioskSyncAt: null, lastSeenAt: null }, now), 'online');
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
