/**
 * Run with `npm test`. "סרגל עליון" (layout.topBar) on the real web and Windows kiosks (lib/kioskTopBar.ts): the club's
 * window, the search over the menu and the language — the rules both hosts share (kiosk-shared/top-bar.tsx), and their
 * wiring in the hosts' sources (read as text: the React parts are not compiled by this runner). The screens drawn with
 * them: kiosk-desktop/test/kioskTopBar.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveKioskConfig } from './kioskConfig';
import { topBarItems } from './kioskLayout';
import { configuredText, webTextIn, webTextOverride } from './kioskTexts';
import {
  HOME_LANGUAGE,
  TOP_BAR_SEARCH_MAX,
  TOP_BAR_START,
  catalogSearch,
  kioskLanguages,
  languageDir,
  nextLanguage,
  screenTextIn,
  searchMatches,
  topBarReduce,
  type KioskTopBarEvent,
  type KioskTopBarState,
} from './kioskTopBar';

const run = (...events: KioskTopBarEvent[]): KioskTopBarState => events.reduce(topBarReduce, TOP_BAR_START);

describe('the top bar on a real kiosk: what its buttons do (topBarReduce)', () => {
  it('starts with nothing open, in the kiosk’s own language', () => {
    assert.deepEqual(TOP_BAR_START, { lang: null, searchOpen: false, query: '', typing: false, clubOpen: false });
    assert.equal(HOME_LANGUAGE, 'he');
  });

  it('club: its window opens, "הבנתי" closes it', () => {
    const open = run({ type: 'club' });
    assert.equal(open.clubOpen, true);
    assert.equal(topBarReduce(open, { type: 'clubClose' }).clubOpen, false);
    // Nothing to close: the same state.
    assert.equal(topBarReduce(TOP_BAR_START, { type: 'clubClose' }), TOP_BAR_START);
  });

  it('search: the field and the keyboard at once; the answer filters, the keyboard closes', () => {
    const open = run({ type: 'search' });
    assert.equal(open.searchOpen, true);
    assert.equal(open.typing, true);
    const typed = topBarReduce(open, { type: 'typed', query: 'פיצה' });
    assert.deepEqual({ open: typed.searchOpen, query: typed.query, typing: typed.typing }, { open: true, query: 'פיצה', typing: false });
    // The field tapped: the keyboard again, the query kept.
    assert.deepEqual({ query: topBarReduce(typed, { type: 'edit' }).query, typing: topBarReduce(typed, { type: 'edit' }).typing }, { query: 'פיצה', typing: true });
    // The keyboard's ✕: closed, the query as it was.
    const back = topBarReduce(topBarReduce(typed, { type: 'edit' }), { type: 'typingClose' });
    assert.deepEqual({ open: back.searchOpen, query: back.query, typing: back.typing }, { open: true, query: 'פיצה', typing: false });
    // The field's ✕: cleared, the field kept.
    assert.deepEqual({ open: topBarReduce(typed, { type: 'clear' }).searchOpen, query: topBarReduce(typed, { type: 'clear' }).query }, { open: true, query: '' });
    // The bar's ✕: the search closed and forgotten.
    assert.deepEqual(topBarReduce(typed, { type: 'search' }), TOP_BAR_START);
  });

  it('search: a query never longer than the kiosk keyboard’s limit; the field tapped while closed does nothing', () => {
    assert.equal(run({ type: 'search' }, { type: 'typed', query: 'x'.repeat(60) }).query.length, TOP_BAR_SEARCH_MAX);
    assert.equal(TOP_BAR_SEARCH_MAX, 40);
    assert.equal(topBarReduce(TOP_BAR_START, { type: 'edit' }), TOP_BAR_START);
  });

  it('the club’s window and the search’s keyboard are never open together', () => {
    assert.equal(run({ type: 'club' }, { type: 'search' }).clubOpen, false);
    assert.equal(run({ type: 'search' }, { type: 'club' }).typing, false);
  });

  it('language: the kiosk’s languages in turn, back to its own (null) after the last', () => {
    const languages = ['he', 'en', 'ar'];
    const en = run({ type: 'lang', languages });
    assert.equal(en.lang, 'en');
    assert.equal(topBarReduce(en, { type: 'lang', languages }).lang, 'ar');
    assert.equal(run({ type: 'lang', languages }, { type: 'lang', languages }, { type: 'lang', languages }).lang, null);
    // One language: nothing changes.
    assert.equal(run({ type: 'lang', languages: ['he'] }).lang, null);
  });

  it('another screen closes the windows (the search stays with the order); rest brings everything back', () => {
    const busy = run({ type: 'lang', languages: ['he', 'en'] }, { type: 'search' }, { type: 'typed', query: 'קולה' }, { type: 'club' });
    const cart = topBarReduce(busy, { type: 'screen', resting: false });
    assert.deepEqual(cart, { lang: 'en', searchOpen: true, query: 'קולה', typing: false, clubOpen: false });
    assert.equal(topBarReduce(cart, { type: 'screen', resting: false }), cart);
    assert.deepEqual(topBarReduce(busy, { type: 'screen', resting: true }), TOP_BAR_START);
  });
});

describe('the kiosk’s languages', () => {
  it('general.languages in their order, known and once each; none — Hebrew', () => {
    assert.deepEqual(kioskLanguages({ general: { languages: ['he', 'en'] } }), ['he', 'en']);
    assert.deepEqual(kioskLanguages({ general: { languages: ['en', 'he', 'en', 'xx'] } }), ['en', 'he']);
    assert.deepEqual(kioskLanguages({ general: { languages: [] } }), ['he']);
    assert.deepEqual(kioskLanguages({}), ['he']);
  });

  it('the next language, and the screens’ direction in it', () => {
    assert.equal(nextLanguage(['he', 'en'], 'he'), 'en');
    assert.equal(nextLanguage(['he', 'en'], 'en'), 'he');
    assert.equal(nextLanguage(['en', 'ru'], 'he'), 'en');
    assert.equal(nextLanguage([], 'he'), 'he');
    assert.deepEqual(['he', 'ar', 'en', 'ru'].map(languageDir), ['rtl', 'rtl', 'ltr', 'ltr']);
  });

  it('a screen text in Hebrew: exactly the web kiosks’ of before (the business’s, else the built-in)', () => {
    const builtin = (k: string) => `builtin:${k}`;
    const plain = resolveKioskConfig({});
    const own = resolveKioskConfig({ texts: { catalogTitle: 'התפריט שלנו' } });
    for (const cfg of [plain, own]) {
      for (const key of ['catalogTitle', 'checkoutCta', 'searchTitle']) {
        assert.equal(screenTextIn(cfg, 'he', key, builtin), configuredText(cfg, 'he', key) ?? builtin(key));
      }
    }
    assert.equal(screenTextIn(own, 'he', 'catalogTitle', builtin), 'התפריט שלנו');
    // The web labels too: in Hebrew, webTextIn is the web kiosks' webTextOverride of before.
    const club = resolveKioskConfig({ texts: { clubTitle: 'המועדון שלנו' } });
    for (const cfg of [plain, club]) for (const key of ['clubTitle', 'search', 'startOver']) assert.equal(webTextIn(cfg, 'he', key), webTextOverride(cfg, 'he', key));
  });

  it('a screen text in another language: its own text there, else the registry’s default there, else the built-in', () => {
    const builtin = (k: string) => `builtin:${k}`;
    const cfg = resolveKioskConfig({ general: { languages: ['he', 'en'] }, textsByLang: { en: { catalogTitle: 'Our menu' } } });
    assert.equal(screenTextIn(cfg, 'en', 'catalogTitle', builtin), 'Our menu');
    assert.equal(screenTextIn(cfg, 'en', 'checkoutCta', builtin), 'Pay');
    assert.equal(screenTextIn(cfg, 'en', 'noSuchText', builtin), 'builtin:noSuchText');
  });
});

describe('the search over the menu (catalogSearch)', () => {
  const menu = [
    { id: 'pizza', products: [{ name: 'פיצה מרגריטה', description: 'עגבניות ובזיליקום' }, { name: 'פיצה פטריות', description: null }] },
    { id: 'drinks', products: [{ name: 'Coca Cola', description: 'פחית' }, { name: 'מים', description: '' }] },
    { id: 'salads', products: [{ name: 'סלט יווני', description: 'עגבניות, פטה' }] },
  ];

  it('the dishes whose name or description hold the words, any case; categories with none left out', () => {
    assert.deepEqual(catalogSearch(menu, 'פיצה').map((c) => [c.id, c.products.map((p) => p.name)]), [['pizza', ['פיצה מרגריטה', 'פיצה פטריות']]]);
    assert.deepEqual(catalogSearch(menu, '  cola ').map((c) => c.products.map((p) => p.name)), [['Coca Cola']]);
    assert.deepEqual(catalogSearch(menu, 'עגבניות').map((c) => c.id), ['pizza', 'salads']);
    assert.deepEqual(catalogSearch(menu, 'סושי'), []);
    assert.equal(searchMatches({ name: 'Coca Cola' }, 'COCA'), true);
  });

  it('nothing typed: the menu as it is (the very same array)', () => {
    assert.equal(catalogSearch(menu, ''), menu);
    assert.equal(catalogSearch(menu, '   '), menu);
  });
});

describe('the restaurant_rail template on a real kiosk: every button it can show', () => {
  it('club (club on), cancel, search (search on), the language (two languages)', () => {
    const cfg = resolveKioskConfig({
      layout: { template: 'restaurant_rail', topBar: ['club', 'cancel', 'search', 'lang'] },
      club: { enabled: true, joinUrl: 'https://club.example/join' },
      general: { searchEnabled: true, languages: ['he', 'en'] },
    });
    assert.deepEqual(topBarItems(cfg), ['club', 'cancel', 'search', 'lang']);
    // The template's own bar, as today: no top bar without the key.
    assert.equal(topBarItems(resolveKioskConfig({})), null);
  });
});

describe('the hosts wire the top bar alike (sources)', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
  const web = src('src/components/kiosk-web/web-kiosk-app.tsx');
  const windows = src('../kiosk-desktop/src/renderer/kiosk/KioskApp.tsx');

  for (const [host, code] of [
    ['web', web],
    ['windows', windows],
  ] as const) {
    it(`${host}: the shared hook, its actions in live, its windows drawn, the texts and the direction in its language`, () => {
      assert.match(code, /const bar = useKioskTopBar\(cfg, flow\.screen, resting\);/, host);
      assert.match(code, /topBar: bar\.live\.topBar,\n\s+search: bar\.live\.search,/, host);
      assert.match(code, /<KioskTopBarWindows m=\{m\} bar=\{bar\} screen=\{screen\} \/>/, host);
      assert.match(code, /dir=\{bar\.dir\}/, host);
      assert.doesNotMatch(code, /dir="rtl"/, host);
      assert.match(code, /screenTextIn\(cfg, lang, key, /, host);
      assert.match(code, /t: \(key, values\) => webTextIn\(cfg, lang, key, values\) \?\? /, host);
      assert.match(code, /kt: \(key, values\) => kioskTextOf\(cfg, lang, key, values\),/, host);
      // A scan never adds a dish under the club's window or the search's keyboard.
      assert.match(code, /sheetOpen: [^\n]*bar\.state\.clubOpen \|\| bar\.state\.typing,/, host);
    });
  }

  it('the layouts’ one switch point shows the search’s matches in every layout', () => {
    const layouts = src('src/kiosk-shared/layouts/index.tsx');
    assert.match(layouts, /export function LayoutCatalog\(\{ m: given, \.\.\.rest \}: CatalogProps\) \{\n\s+const m = searchedModel\(given\);/);
  });
});
