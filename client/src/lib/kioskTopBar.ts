/**
 * "סרגל עליון" (layout.topBar, P:/specs/kiosk-rail-motion.md §6.1) on the real web and Windows kiosks: what the
 * club, search and language buttons do there, as the Android kiosk's KioskTopBar (ui/kiosk/layouts/KioskRailUi.kt):
 *
 *  - club: the club's window — the club's QR card (the attract screen's) and, where a voucher pays, where it is entered;
 *  - search: a field under the bar (the kiosk's own keyboard) over the menu — the dishes whose name or description has
 *    the words (KioskCatalogView.search); ✕ closes it;
 *  - language: the kiosk's languages (general.languages) in turn, its texts in that language (textsByLang, else the
 *    registry's defaults there) — back to the kiosk's own at rest.
 *
 * Pure, no React: the hosts' hook is kiosk-shared/top-bar.tsx. Until the customer switches, the language is the one the
 * web kiosks have always drawn (Hebrew), so a kiosk without the top bar's language button is exactly as before.
 */

import { LANGUAGES } from './kioskConfig';
import { configuredText, defaultText } from './kioskTexts';

/** The search's longest query (the till's KioskKeyboardLayout.SEARCH_MAX, the list layout's). */
export const TOP_BAR_SEARCH_MAX = 40;

/** The language the web kiosks draw while the customer has switched to none. */
export const HOME_LANGUAGE = 'he';

export interface KioskTopBarState {
  /** The language the customer switched to; null — the kiosk's own (HOME_LANGUAGE). */
  lang: string | null;
  /** The search's field is shown under the bar. */
  searchOpen: boolean;
  query: string;
  /** The kiosk's keyboard is open over the search. */
  typing: boolean;
  /** The club's window is open. */
  clubOpen: boolean;
}

export const TOP_BAR_START: KioskTopBarState = { lang: null, searchOpen: false, query: '', typing: false, clubOpen: false };

export type KioskTopBarEvent =
  /** "חבר מועדון / קופונים": its window. */
  | { type: 'club' }
  | { type: 'clubClose' }
  /** 🔍: the field (and the keyboard at once while nothing is typed); ✕ (open): closed, the query gone. */
  | { type: 'search' }
  /** The field tapped: the keyboard, with what is typed. */
  | { type: 'edit' }
  /** The keyboard's answer. */
  | { type: 'typed'; query: string }
  /** The keyboard closed with ✕ (the query as it was). */
  | { type: 'typingClose' }
  /** The field's ✕: the query cleared, the field kept. */
  | { type: 'clear' }
  /** The language button: the next of the kiosk's languages. */
  | { type: 'lang'; languages: readonly string[] }
  /** Another screen: the windows close (the search stays with the order); at rest everything as at the start. */
  | { type: 'screen'; resting: boolean };

export function topBarReduce(s: KioskTopBarState, e: KioskTopBarEvent): KioskTopBarState {
  switch (e.type) {
    case 'club':
      return { ...s, clubOpen: true, typing: false };
    case 'clubClose':
      return s.clubOpen ? { ...s, clubOpen: false } : s;
    case 'search':
      return s.searchOpen ? { ...s, searchOpen: false, query: '', typing: false } : { ...s, searchOpen: true, typing: s.query.trim() === '', clubOpen: false };
    case 'edit':
      return s.searchOpen ? { ...s, typing: true } : s;
    case 'typed':
      return { ...s, searchOpen: true, query: e.query.slice(0, TOP_BAR_SEARCH_MAX), typing: false };
    case 'typingClose':
      return s.typing ? { ...s, typing: false } : s;
    case 'clear':
      return { ...s, query: '' };
    case 'lang': {
      const next = nextLanguage(e.languages, s.lang ?? HOME_LANGUAGE);
      return { ...s, lang: next === HOME_LANGUAGE ? null : next };
    }
    case 'screen':
      if (e.resting) return TOP_BAR_START;
      return s.clubOpen || s.typing ? { ...s, clubOpen: false, typing: false } : s;
  }
}

/** The kiosk's languages, in their order (general.languages; only the ones the kiosks know), at least Hebrew. */
export function kioskLanguages(cfg: { general?: { languages?: readonly string[] | null } | null }): string[] {
  const out: string[] = [];
  for (const l of cfg.general?.languages ?? []) if ((LANGUAGES as readonly string[]).includes(l) && !out.includes(l)) out.push(l);
  return out.length > 0 ? out : [HOME_LANGUAGE];
}

/** The language after `current` in the kiosk's order (the first after the last, or when `current` is none of them). */
export function nextLanguage(languages: readonly string[], current: string): string {
  if (languages.length === 0) return current;
  return languages[(languages.indexOf(current) + 1) % languages.length];
}

/** The screens' direction in a language: right to left in Hebrew and Arabic. */
export function languageDir(lang: string): 'rtl' | 'ltr' {
  return lang === 'he' || lang === 'ar' ? 'rtl' : 'ltr';
}

/**
 * A screen text (`m.txt`) in `lang`, as the dashboard's preview draws it in that language: the business's, else the
 * host's built-in one in Hebrew, else the registry's default there. In Hebrew: exactly the web kiosks' text of before.
 */
export function screenTextIn<K extends string>(cfg: Parameters<typeof configuredText>[0], lang: string, key: K, builtin: (key: K) => string): string {
  return configuredText(cfg, lang, key) ?? (lang === HOME_LANGUAGE ? builtin(key) : (defaultText(lang, key) ?? builtin(key)));
}

/** Whether a dish matches the search: its name or its description holds the words, any case (KioskCatalogView.search). */
export function searchMatches(p: { name: string; description?: string | null }, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (q === '') return true;
  return p.name.toLocaleLowerCase().includes(q) || (p.description ?? '').toLocaleLowerCase().includes(q);
}

/**
 * The menu as the search shows it: every category with its matching dishes only, in their order; a category with
 * none is left out. Nothing typed: the menu as it is (the same array).
 */
export function catalogSearch<C extends { products: ReadonlyArray<{ name: string; description?: string | null }> }>(categories: readonly C[], query: string): C[] {
  if (query.trim() === '') return categories as C[];
  return categories.flatMap((c) => {
    const products = c.products.filter((p) => searchMatches(p, query));
    return products.length > 0 ? [{ ...c, products }] : [];
  });
}
