/**
 * "סימוני תזונה" and "תיאור הפריט" as the product form edits them (pos-server
 * app/services/dietary.py, docs/SPEC_PRODUCT_DIETARY.md). Self-contained, so `npm test`
 * compiles it alone.
 *
 * The rules (the server applies the same ones and refuses a contradiction):
 * - `vegan` is also `vegetarian`: picking טבעוני marks צמחוני too.
 * - `meat` and `dairy` never go together (kashrut): picking one clears the other.
 * - `vegan` goes with neither: picking טבעוני clears חלבי and בשרי; picking either clears טבעוני.
 * - `vegetarian` is not `meat`: picking בשרי clears צמחוני (and טבעוני); picking צמחוני clears בשרי.
 * - Clearing צמחוני on a vegan dish clears טבעוני too (a vegan dish is vegetarian).
 * Every change that touches another chip says so in a note under the chips.
 */

export const DIETARY_TAGS = ['vegan', 'vegetarian', 'dairy', 'meat', 'gluten_free', 'spicy'] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];

/** The product's `description` column; the kiosk card reads best up to the recommended length. */
export const DESCRIPTION_RECOMMENDED = 300;
export const DESCRIPTION_MAX = 1000;

/** Pairs that cannot both be on one product. */
export const DIETARY_CONFLICTS: ReadonlyArray<readonly [DietaryTag, DietaryTag]> = [
  ['meat', 'dairy'],
  ['vegan', 'meat'],
  ['vegan', 'dairy'],
  ['vegetarian', 'meat'],
];

export function isDietaryTag(value: unknown): value is DietaryTag {
  return typeof value === 'string' && (DIETARY_TAGS as readonly string[]).includes(value);
}

/** Known codes only, each once, in the fixed order; `vegetarian` added to `vegan`. */
export function normalizeDietaryTags(value: unknown): DietaryTag[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set<DietaryTag>();
  for (const v of value) {
    const code = typeof v === 'string' ? v.trim().toLowerCase() : v;
    if (isDietaryTag(code)) wanted.add(code);
  }
  if (wanted.has('vegan')) wanted.add('vegetarian');
  return DIETARY_TAGS.filter((t) => wanted.has(t));
}

/** The first pair of `tags` that cannot go together, or null. */
export function dietaryConflict(tags: readonly string[]): readonly [DietaryTag, DietaryTag] | null {
  const have = new Set(tags);
  return DIETARY_CONFLICTS.find(([a, b]) => have.has(a) && have.has(b)) ?? null;
}

export interface DietaryToggle {
  /** The tags after the toggle, in the fixed order. */
  tags: DietaryTag[];
  /** Turned on because of the toggled one (צמחוני with טבעוני). */
  added: DietaryTag[];
  /** Turned off because of it (חלבי when בשרי was picked…). */
  cleared: DietaryTag[];
}

/** What each tag clears when it is turned on. */
const CLEARS: Record<DietaryTag, DietaryTag[]> = {
  vegan: ['dairy', 'meat'],
  vegetarian: ['meat'],
  dairy: ['meat', 'vegan'],
  meat: ['dairy', 'vegan', 'vegetarian'],
  gluten_free: [],
  spicy: [],
};

/** One chip tapped: the new tags, and what else changed with it (for the note). */
export function toggleDietaryTag(current: readonly string[], tag: DietaryTag): DietaryToggle {
  const before = new Set(normalizeDietaryTags([...current]));
  const next = new Set(before);
  const added: DietaryTag[] = [];
  const cleared: DietaryTag[] = [];
  if (before.has(tag)) {
    next.delete(tag);
    if (tag === 'vegetarian' && next.has('vegan')) {
      next.delete('vegan');
      cleared.push('vegan');
    }
  } else {
    next.add(tag);
    for (const other of CLEARS[tag]) {
      if (next.delete(other)) cleared.push(other);
    }
    if (tag === 'vegan' && !next.has('vegetarian')) {
      next.add('vegetarian');
      added.push('vegetarian');
    }
  }
  const order = (xs: DietaryTag[]) => DIETARY_TAGS.filter((t) => xs.includes(t));
  return { tags: DIETARY_TAGS.filter((t) => next.has(t)), added: order(added), cleared: order(cleared) };
}

export type DescriptionLevel = 'ok' | 'long' | 'over';

/** The counter under "תיאור הפריט": within the recommendation, longer than it, or over the limit. */
export function descriptionLevel(text: string | null | undefined): DescriptionLevel {
  const n = (text ?? '').length;
  if (n > DESCRIPTION_MAX) return 'over';
  if (n > DESCRIPTION_RECOMMENDED) return 'long';
  return 'ok';
}
