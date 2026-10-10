/**
 * Type-to-filter for the dashboard's searchable pickers (components/ui/combobox.tsx): which
 * options a query finds, best first, and where the arrow keys move the highlight. The owner:
 * "בבחירת דגם בהוספת קופה/מכשיר אפשר לחפש את הדגם" — and a model is typed every which way
 * ("a920pro", "A920 Pro", "a920-pro", "סאנמי").
 *
 * Matching is forgiving: case, spaces, hyphens, dots and other punctuation, niqqud, geresh /
 * gershayim (and the ASCII quotes typed in their place) and Hebrew final letters are ignored,
 * and the words of a query may come in any order. Ranking: an exact name first, then a name
 * that starts with the query, then one with a word that does, then one that merely contains
 * it; at the same level the label before the keywords before the description, then the
 * options' own order (never how many keywords an option has).
 *
 * Pure: no imports, so `npm test` compiles it on its own (lib/optionSearch.test.ts).
 */

export interface SearchOption<V extends string = string> {
  value: V;
  /** What the list shows, and the first thing searched. */
  label: string;
  /** Other names it is found by, best first: a model's name, its code, its aliases, its maker. */
  keywords?: readonly string[];
  /** A second, muted line under the label (searched last). */
  description?: string;
  disabled?: boolean;
}

/** How well a query matched, best first. */
export const MATCH_TIER = {
  /** The whole name, give or take spaces and punctuation ("a920pro" for "A920 Pro"). */
  exact: 0,
  /** The name starts with it. */
  prefix: 1,
  /** A word of the name starts with it, or each word of the query starts a word of the name. */
  wordPrefix: 2,
  /** Somewhere inside the name. */
  substring: 3,
  /** Each word of the query is somewhere inside the name. */
  words: 4,
  /** Each word of the query is in one of the option's names (the maker in one, the model in another). */
  spread: 5,
} as const;

/** Anything but a letter or a digit, in any script (built at run time: the dashboard targets ES2017). */
const NOT_LETTER_OR_DIGIT = new RegExp('[^\\p{L}\\p{N}]+', 'gu');

/** Maqaf, the Hebrew hyphen: a word break like "-". */
const MAQAF = /־/g;
/** Combining accents (after NFKD), niqqud and cantillation. */
const MARKS = /[̀-֑ͯ-ׇ]/g;
/** Geresh, gershayim and the quotes typed for them (ASCII and typographic). */
const QUOTES = /[׳״'"`‘’“”]/g;
const FINALS = /[ךםןףץ]/g;
const FINAL_LETTERS: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

/**
 * A text as the search compares it: lower case, no diacritics / niqqud, no geresh or quotes,
 * Hebrew final letters as the others, and every run of anything but letters and digits one space.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(MAQAF, ' ')
    .replace(MARKS, '')
    .replace(QUOTES, '')
    .toLowerCase()
    .replace(FINALS, (c) => FINAL_LETTERS[c] ?? c)
    .replace(NOT_LETTER_OR_DIGIT, ' ')
    .trim();
}

interface PreparedText {
  compact: string;
  words: string[];
  /** The compact text from each word on ("sunmi t2 lite" → "sunmit2lite", "t2lite", "lite"). */
  fromWord: string[];
}

function prepare(text: string): PreparedText | null {
  const normal = normalizeSearchText(text);
  if (!normal) return null;
  const words = normal.split(' ');
  const fromWord = words.map((_, i) => words.slice(i).join(''));
  return { compact: fromWord[0], words, fromWord };
}

/** The tier of one name against the query, or null when it does not match at all. */
function tierOf(field: PreparedText, query: PreparedText): number | null {
  if (field.compact === query.compact) return MATCH_TIER.exact;
  if (field.compact.startsWith(query.compact)) return MATCH_TIER.prefix;
  if (
    field.fromWord.some((rest, i) => i > 0 && rest.startsWith(query.compact)) ||
    (query.words.length > 1 && query.words.every((q) => field.words.some((w) => w.startsWith(q))))
  ) {
    return MATCH_TIER.wordPrefix;
  }
  if (field.compact.includes(query.compact)) return MATCH_TIER.substring;
  if (query.words.every((q) => field.compact.includes(q))) return MATCH_TIER.words;
  return null;
}

/** Which kind of name matched: at the same tier the label wins over a keyword, a keyword over the description. */
const LABEL = 0;
const KEYWORD = 1;
const DESCRIPTION = 2;

/** The names an option is searched by, each with its kind. */
function namesOf(option: SearchOption): { text: string; kind: number }[] {
  return [
    { text: option.label, kind: LABEL },
    ...(option.keywords ?? []).map((text) => ({ text, kind: KEYWORD })),
    ...(option.description ? [{ text: option.description, kind: DESCRIPTION }] : []),
  ];
}

/**
 * The options the query finds, best first (see the file comment); an empty query (or one of
 * punctuation only) is every option in its own order. Never mutates `options`.
 */
export function rankOptions<T extends SearchOption>(options: readonly T[], query: string): T[] {
  const q = prepare(query);
  if (!q) return [...options];
  const scored: { option: T; score: number; index: number }[] = [];
  options.forEach((option, index) => {
    const fields = namesOf(option).flatMap(({ text, kind }) => {
      const field = prepare(text);
      return field ? [{ field, kind }] : [];
    });
    let best: number | null = null;
    for (const { field, kind } of fields) {
      const tier = tierOf(field, q);
      if (tier === null) continue;
      const score = tier * 10 + kind;
      if (best === null || score < best) best = score;
    }
    if (best === null && q.words.every((word) => fields.some(({ field }) => field.compact.includes(word)))) {
      best = MATCH_TIER.spread * 10;
    }
    if (best !== null) scored.push({ option, score: best, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.option);
}

/** A key of the open list: ArrowDown / ArrowUp, Home / End. */
export type HighlightMove = 'next' | 'previous' | 'first' | 'last';

/**
 * Where a key moves the list's highlight (an index into `options`), skipping disabled options;
 * null when nothing can be highlighted. From no highlight, "next" is the first option and
 * "previous" the last; past either end it wraps around.
 */
export function moveHighlight(
  options: readonly { disabled?: boolean }[],
  current: number | null,
  move: HighlightMove,
): number | null {
  const enabled: number[] = [];
  options.forEach((o, i) => {
    if (!o.disabled) enabled.push(i);
  });
  if (enabled.length === 0) return null;
  const first = enabled[0];
  const last = enabled[enabled.length - 1];
  if (move === 'first') return first;
  if (move === 'last') return last;
  const at = current === null ? -1 : enabled.indexOf(current);
  if (at === -1) return move === 'next' ? first : last;
  const step = move === 'next' ? 1 : -1;
  return enabled[(at + step + enabled.length) % enabled.length];
}
