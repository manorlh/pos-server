/**
 * "סרגל עליון" (layout.topBar, P:/specs/kiosk-rail-motion.md §6.1) on the Windows and browser kiosks: the club, search and
 * language buttons now have their actions here (kiosk-shared/top-bar.tsx — the same hook in KioskApp and the browser
 * kiosk), so a real kiosk shows all four, as the dashboard's preview and the Android kiosk do. The shared screens drawn
 * with the hook's state as it moves (topBarHost + lib/kioskTopBar.ts topBarReduce, the hook without React):
 *
 *  - club → the club's window: the club's QR card (the attract screen's), the vouchers' note, "הבנתי";
 *  - search → the field under the bar and the kiosk's keyboard; the menu shows the matching dishes (every layout);
 *  - language → the next of the kiosk's languages, the texts drawn in it.
 *
 * Layouts without the top bar draw exactly as before. The rules alone: client src/lib/kioskTopBar.test.ts.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aspectRatioCss,
  buttonRadius,
  ctaBox,
  engineMotionSpec,
  engineTransitionSpec,
  fontStack,
  kioskMotionEngine,
  resolveKioskConfig,
  resolveThemeColors,
} from '@dash-lib/kioskConfig';
import { topBarItems } from '@dash-lib/kioskLayout';
import { kioskTextOf, webTextIn } from '@dash-lib/kioskTexts';
import { TOP_BAR_START, topBarReduce, type KioskTopBarEvent, type KioskTopBarState } from '@dash-lib/kioskTopBar';
import {
  AttractScreen,
  CatalogHeader,
  ClubQrCard,
  ClubWindow,
  KioskTopBarWindows,
  LayoutCatalog,
  TopBar,
  searchedModel,
  topBarHost,
  type KioskLive,
  type PCategory,
  type PProduct,
  type PreviewModel,
} from '@kiosk-shared/index';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
/** The preview's labels, as the kiosks read them (he.json kiosks.preview — virtual:kiosk-strings on this kiosk). */
const PREVIEW = (JSON.parse(readFileSync(path.join(here, '..', '..', 'client', 'src', 'messages', 'he.json'), 'utf8')) as { kiosks: { preview: Record<string, unknown> } }).kiosks.preview;
const label = (key: string): string => {
  let cur: unknown = PREVIEW;
  for (const part of key.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
  return typeof cur === 'string' ? cur : key;
};

const dish = (id: string, name: string, categoryId: string, description: string | null = null): PProduct => ({
  id,
  name,
  price: 42,
  priceAgorot: 4200,
  imageUrl: null,
  soldOut: false,
  description,
  categoryId,
  dietaryTags: [],
  addPath: 'direct',
});

const MENU: PCategory[] = [
  { id: 'pizza', name: 'פיצות', imageUrl: null, products: [dish('p1', 'פיצה מרגריטה', 'pizza', 'עגבניות ובזיליקום'), dish('p2', 'פיצה פטריות', 'pizza')] },
  { id: 'drinks', name: 'שתייה', imageUrl: null, products: [dish('d1', 'קוקה קולה', 'drinks', 'פחית'), dish('d2', 'מים מינרליים', 'drinks')] },
];

/** The restaurant_rail template with every top-bar button it can have: the club on, the search on, two languages. */
const RAIL = {
  layout: { template: 'restaurant_rail', topBar: ['club', 'cancel', 'search', 'lang'] },
  club: { enabled: true, joinUrl: 'https://club.example/join', title: '', body: '' },
  general: { searchEnabled: true, languages: ['he', 'en'] },
  payment: { methods: ['card', 'voucher'] },
};

/** A screens' model as the hosts build it (KioskApp / web-kiosk-app), in `lang`. */
function model(layer: Record<string, unknown>, live?: KioskLive, lang = 'he'): PreviewModel {
  const cfg = resolveKioskConfig(layer);
  const engine = kioskMotionEngine(cfg.motion, cfg.general, 'full');
  return {
    cfg,
    c: resolveThemeColors(cfg.theme),
    radius: cfg.theme.cornerRadius,
    btnRadius: buttonRadius(cfg.theme),
    wide: false,
    cols: 2,
    ratio: aspectRatioCss(cfg.theme.imageRatio),
    font: fontStack(cfg.theme.font),
    txt: (key) => kioskTextOf(cfg, lang, key),
    t: (key, values) => webTextIn(cfg, lang, key, values) ?? label(key),
    kt: (key, values) => kioskTextOf(cfg, lang, key, values),
    money: (n) => `₪${n}`,
    categories: MENU,
    featured: [MENU[0].products[0]],
    logoUrl: null,
    brandName: 'בדיקה',
    nowMs: 0,
    go: () => undefined,
    openProduct: () => undefined,
    cart: [],
    setCart: () => undefined,
    service: 'take_away',
    setService: () => undefined,
    motion: engineMotionSpec(engine, cfg.theme),
    transitions: engineTransitionSpec(engine),
    engine,
    justAddedId: null,
    cartBump: 0,
    setCartTarget: () => undefined,
    panel: false,
    screen: { w: 540, h: 960 },
    ctaBox: ctaBox(cfg.attract.cta, 540, 960),
    live,
  } as PreviewModel;
}

/** The hook's state as a host's taps move it (useKioskTopBar = this state + topBarHost). */
function hostAfter(layer: Record<string, unknown>, ...taps: Array<(h: ReturnType<typeof topBarHost>) => void>) {
  const cfg = resolveKioskConfig(layer);
  let state: KioskTopBarState = TOP_BAR_START;
  const send = (e: KioskTopBarEvent) => {
    state = topBarReduce(state, e);
  };
  for (const tap of taps) tap(topBarHost(cfg, state, send));
  return topBarHost(cfg, state, send);
}

/** A real kiosk's live hooks with the top bar's (as both hosts spread them). */
const liveOf = (h: ReturnType<typeof topBarHost>): KioskLive => ({ startOver: () => undefined, back: () => undefined, topBar: h.live.topBar, search: h.live.search });

const html = (el: ReactElement) => renderToStaticMarkup(el);
const buttons = (markup: string) => [...markup.matchAll(/data-top="(\w+)"/g)].map((x) => x[1]);

describe('the top bar on a real Windows / browser kiosk: all four buttons', () => {
  it('club, cancel, search and the language — each with its action (before: cancel alone)', () => {
    const h = hostAfter(RAIL);
    const m = model(RAIL, liveOf(h));
    expect(topBarItems(m.cfg)).toEqual(['club', 'cancel', 'search', 'lang']);
    expect(buttons(html(createElement(TopBar, { m, items: topBarItems(m.cfg) ?? [] })))).toEqual(['club', 'cancel', 'search', 'lang']);
    // A host without the actions (as before this change): only the cancel a real kiosk can honour.
    const bare = model(RAIL, { startOver: () => undefined });
    expect(buttons(html(createElement(TopBar, { m: bare, items: topBarItems(bare.cfg) ?? [] })))).toEqual(['cancel']);
    // The dashboard's preview: all of them, as before.
    const preview = model(RAIL);
    expect(buttons(html(createElement(TopBar, { m: preview, items: topBarItems(preview.cfg) ?? [] })))).toEqual(['club', 'cancel', 'search', 'lang']);
  });

  it('a button the config hides stays hidden (no club, no search, one language)', () => {
    const layer = { ...RAIL, club: { enabled: false, joinUrl: '' }, payment: { methods: ['card'] }, general: { searchEnabled: false, languages: ['he'] } };
    const m = model(layer, liveOf(hostAfter(layer)));
    expect(buttons(html(createElement(TopBar, { m, items: topBarItems(m.cfg) ?? [] })))).toEqual(['cancel']);
  });

  it('the club button opens the club’s window: the club’s QR card, the vouchers’ note, "הבנתי"', () => {
    const h = hostAfter(RAIL, (x) => x.live.topBar?.club?.());
    expect(h.state.clubOpen).toBe(true);
    const m = model(RAIL, liveOf(h));
    const win = html(createElement(KioskTopBarWindows, { m, bar: h, screen: 'catalog' }));
    expect(win).toContain('data-club-window');
    expect(win).toContain('role="dialog"');
    expect(win).toContain('<svg'); // the QR of club.joinUrl
    expect(win).toContain(kioskTextOf(m.cfg, 'he', 'clubTitle'));
    expect(win).toContain(label('clubScan'));
    expect(win).toContain('שוברים וקופונים מזינים בשלב התשלום');
    expect(win).toContain(kioskTextOf(m.cfg, 'he', 'helpClose'));
    // Closed by its button; never over another screen.
    const closed = hostAfter(RAIL, (x) => x.live.topBar?.club?.(), (x) => x.send({ type: 'clubClose' }));
    expect(closed.state.clubOpen).toBe(false);
    expect(html(createElement(KioskTopBarWindows, { m, bar: closed, screen: 'catalog' }))).toBe('');
    expect(html(createElement(KioskTopBarWindows, { m, bar: h, screen: 'cart' }))).toBe('');
  });

  it('the club’s window where only a voucher pays: no card, the vouchers’ note', () => {
    const layer = { ...RAIL, club: { enabled: false, joinUrl: '' } };
    const m = model(layer);
    expect(topBarItems(m.cfg)).toContain('club');
    const win = html(createElement(ClubWindow, { m, onClose: () => undefined }));
    expect(win).not.toContain('data-club-card');
    expect(win).toContain('data-club-vouchers');
  });

  it('the attract screen’s club card is the same card as before (QR, title, words)', () => {
    const m = model(RAIL);
    const card = html(createElement(ClubQrCard, { m }));
    expect(card).toContain('data-club-card');
    expect(card).toContain('width="64"');
    expect(card).toContain(label('clubTitle'));
    expect(card).toContain(label('clubScan'));
    expect(html(createElement(AttractScreen, { m: model({ ...RAIL, attract: { sections: ['club'] } }) }))).toContain('data-club-card');
  });

  it('search: the keyboard at once, then the field under the bar with what was typed; ✕ on the bar closes it', () => {
    const typing = hostAfter(RAIL, (x) => x.live.topBar?.search?.());
    expect(typing.state).toMatchObject({ searchOpen: true, typing: true });
    const keyboard = html(createElement(KioskTopBarWindows, { m: model(RAIL, liveOf(typing)), bar: typing, screen: 'catalog' }));
    expect(keyboard).toContain(kioskTextOf(resolveKioskConfig(RAIL), 'he', 'searchTitle'));
    expect(keyboard).toContain(kioskTextOf(resolveKioskConfig(RAIL), 'he', 'searchHint'));
    const typed = hostAfter(RAIL, (x) => x.live.topBar?.search?.(), (x) => x.send({ type: 'typed', query: 'פיצה' }));
    const m = model(RAIL, liveOf(typed));
    const header = html(createElement(CatalogHeader, { m }));
    expect(header).toContain('data-top-search');
    expect(header).toContain('פיצה');
    expect(header).toContain('aria-pressed="true"');
    // The field tapped: the keyboard with the query.
    expect(hostAfter(RAIL, (x) => x.live.topBar?.search?.(), (x) => x.send({ type: 'typed', query: 'פיצה' }), (x) => x.live.search?.onEdit()).state.typing).toBe(true);
    // The bar's ✕: closed and forgotten.
    const closed = hostAfter(RAIL, (x) => x.live.topBar?.search?.(), (x) => x.send({ type: 'typed', query: 'פיצה' }), (x) => x.live.topBar?.search?.());
    expect(closed.live.search).toBeUndefined();
    expect(html(createElement(CatalogHeader, { m: model(RAIL, liveOf(closed)) }))).not.toContain('data-top-search');
  });

  it('search: the menu shows the matching dishes only — in the rail and every layout (LayoutCatalog)', () => {
    const typed = hostAfter(RAIL, (x) => x.live.topBar?.search?.(), (x) => x.send({ type: 'typed', query: 'קולה' }));
    const m = model(RAIL, liveOf(typed));
    const shown = searchedModel(m);
    expect(shown.categories.map((c) => [c.id, c.products.map((p) => p.id)])).toEqual([['drinks', ['d1']]]);
    expect(shown.featured).toEqual([]);
    const rail = html(createElement(LayoutCatalog, { m, activeCategory: null, onCategory: () => undefined }));
    expect(rail).toContain('קוקה קולה');
    expect(rail).not.toContain('פיצה מרגריטה');
    expect(rail).not.toContain('מים מינרליים');
    for (const template of ['standard', 'tabs', 'list', 'magazine', 'wall', 'cafe']) {
      const layer = { ...RAIL, layout: { ...RAIL.layout, template } };
      const out = html(createElement(LayoutCatalog, { m: model(layer, liveOf(typed)), activeCategory: null, onCategory: () => undefined }));
      expect(out, template).not.toContain('פיצה מרגריטה');
    }
    // Nothing matches: "לא מצאנו מנה בשם הזה" where the menu would say it has nothing.
    const none = hostAfter(RAIL, (x) => x.live.topBar?.search?.(), (x) => x.send({ type: 'typed', query: 'סושי' }));
    const empty = html(createElement(LayoutCatalog, { m: model(RAIL, liveOf(none)), activeCategory: null, onCategory: () => undefined }));
    expect(empty).toContain(kioskTextOf(resolveKioskConfig(RAIL), 'he', 'searchNone'));
    expect(empty).not.toContain(label('empty'));
  });

  it('the list layout keeps its own search field: no search button on its bar', () => {
    const layer = { ...RAIL, layout: { ...RAIL.layout, template: 'list', catalog: 'list' } };
    const m = model(layer, liveOf(hostAfter(layer)));
    const out = html(createElement(LayoutCatalog, { m, activeCategory: null, onCategory: () => undefined }));
    expect(buttons(out)).toEqual(['club', 'cancel', 'lang']);
  });

  it('language: the button says the next language; a tap draws the texts in it, left to right; rest — back home', () => {
    const home = hostAfter(RAIL);
    expect(home.lang).toBe('he');
    expect(home.dir).toBe('rtl');
    expect(home.live.topBar?.nextLang).toBe('en');
    expect(html(createElement(TopBar, { m: model(RAIL, liveOf(home)), items: ['lang'] }))).toContain('>en</span>');
    const en = hostAfter(RAIL, (x) => x.live.topBar?.lang?.());
    expect(en.lang).toBe('en');
    expect(en.dir).toBe('ltr');
    expect(en.live.topBar?.nextLang).toBe('he');
    const m = model(RAIL, liveOf(en), en.lang);
    const bar = html(createElement(TopBar, { m, items: topBarItems(m.cfg) ?? [] }));
    expect(bar).toContain('Cancel order');
    expect(bar).toContain('Join our club');
    expect(bar).toContain('>he</span>');
    // Another ordering screen keeps it; back at rest: the kiosk's own language again.
    expect(hostAfter(RAIL, (x) => x.live.topBar?.lang?.(), (x) => x.send({ type: 'screen', resting: false })).lang).toBe('en');
    const rest = hostAfter(RAIL, (x) => x.live.topBar?.lang?.(), (x) => x.send({ type: 'screen', resting: true }));
    expect([rest.lang, rest.dir]).toEqual(['he', 'rtl']);
  });
});

describe('a kiosk without the top bar: exactly as before', () => {
  it('today’s header (no bar, no field) even with the hooks', () => {
    const layer = { general: { searchEnabled: true, languages: ['he', 'en'] }, club: { enabled: true, joinUrl: 'https://club.example/join' } };
    const h = hostAfter(layer);
    const m = model(layer, liveOf(h));
    const header = html(createElement(CatalogHeader, { m }));
    expect(header).not.toContain('data-top-bar');
    expect(header).not.toContain('data-top-search');
    // No search typed: the screens' model is the very same object, and the menu as it is.
    expect(searchedModel(m)).toBe(m);
    // Today's menu: every category on the side, the first one's dishes (one category at a time).
    const out = html(createElement(LayoutCatalog, { m, activeCategory: null, onCategory: () => undefined }));
    for (const c of MENU) expect(out).toContain(`data-cat="${c.id}"`);
    for (const p of MENU[0].products) expect(out).toContain(p.name);
  });
});
