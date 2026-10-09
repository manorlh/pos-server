/**
 * "הגדלות מכירה" (upsell rules) — the plain rules behind the dashboard's rules list and
 * rule form, kept free of React and Next so `npm test` can run them:
 *
 * - the list's filters (place, trigger type, active only, search) and how they live in the
 *   URL query (`?place=quick,kiosk&trigger=transition&active=1&q=קפה`);
 * - "איפה" of a rule (`places`, or the legacy `where` of an older server);
 * - "מעבר בין מסכים": which step codes the chosen places offer (`GET /menu/upsells` →
 *   `steps`), in one stable order, and the `enter_category:<category id>` codes.
 *
 * The types here are structural (no import of lib/menuApi), so the test build compiles this
 * file alone; `UpsellRule` fits `FilterableUpsell` as is.
 */

/** "איפה": the till's quick order, its tables, the self-order kiosk. */
export const UPSELL_PLACES = ['quick', 'tables', 'kiosk'] as const;
export type UpsellPlaceCode = (typeof UPSELL_PLACES)[number];

/** What starts a rule, in the order the dashboard shows them. */
export const UPSELL_TRIGGERS = ['product', 'category', 'transition', 'order'] as const;
export type UpsellTriggerCode = (typeof UPSELL_TRIGGERS)[number];

/** The step whose codes carry a category: `enter_category:<category id>`. */
export const CATEGORY_STEP = 'enter_category';

/** `GET /menu/upsells` → `steps`: the step codes each channel has, in its own flow order. */
export type UpsellSteps = Partial<Record<UpsellPlaceCode, readonly string[]>>;

/* ---------------- the list's filters ---------------- */

export interface UpsellFilter {
  /** Any of these places (none = all). */
  places: UpsellPlaceCode[];
  /** Any of these trigger types (none = all). */
  triggers: UpsellTriggerCode[];
  activeOnly: boolean;
  /** Rule name or item (trigger names, option names). */
  q: string;
}

export const EMPTY_UPSELL_FILTER: UpsellFilter = { places: [], triggers: [], activeOnly: false, q: '' };

/** The query keys the filters own; any other key (the scope's) is left alone. */
export const UPSELL_FILTER_KEYS = ['place', 'trigger', 'active', 'q'] as const;

const MAX_QUERY = 100;

/** Anything with `get` — URLSearchParams, Next's ReadonlyURLSearchParams. */
export interface QueryLike {
  get(name: string): string | null;
}

/** The known values of a comma list, in the canonical order, each once. */
function listParam<T extends string>(raw: string | null, known: readonly T[]): T[] {
  if (!raw) return [];
  const asked = new Set(raw.split(',').map((s) => s.trim()));
  return known.filter((k) => asked.has(k));
}

/** The filters in a query (`?place=…&trigger=…&active=1&q=…`); unknown values are dropped. */
export function parseUpsellFilter(query: QueryLike | string): UpsellFilter {
  const params = typeof query === 'string' ? new URLSearchParams(query.replace(/^\?/, '')) : query;
  const active = params.get('active');
  return {
    places: listParam(params.get('place'), UPSELL_PLACES),
    triggers: listParam(params.get('trigger'), UPSELL_TRIGGERS),
    activeOnly: active === '1' || active === 'true',
    q: (params.get('q') ?? '').trim().slice(0, MAX_QUERY),
  };
}

export function isEmptyUpsellFilter(f: UpsellFilter): boolean {
  return !f.places.length && !f.triggers.length && !f.activeOnly && !f.q.trim();
}

/** The filters as query pairs: stable order, defaults left out. */
export function upsellFilterEntries(f: UpsellFilter): [string, string][] {
  const out: [string, string][] = [];
  const places = UPSELL_PLACES.filter((p) => f.places.includes(p));
  const triggers = UPSELL_TRIGGERS.filter((t) => f.triggers.includes(t));
  if (places.length) out.push(['place', places.join(',')]);
  if (triggers.length) out.push(['trigger', triggers.join(',')]);
  if (f.activeOnly) out.push(['active', '1']);
  const q = f.q.trim().slice(0, MAX_QUERY);
  if (q) out.push(['q', q]);
  return out;
}

/** `place=quick,kiosk&trigger=transition&active=1&q=…` ('' for no filter). Lists keep their commas. */
export function serializeUpsellFilter(f: UpsellFilter): string {
  return upsellFilterEntries(f)
    .map(([k, v]) => `${k}=${k === 'q' ? encodeURIComponent(v) : v}`)
    .join('&');
}

/** `search` (the page's current query) with the filters replaced by `f`, every other key kept. */
export function withUpsellFilter(search: string, f: UpsellFilter): string {
  const rest = new URLSearchParams(search.replace(/^\?/, ''));
  for (const k of UPSELL_FILTER_KEYS) rest.delete(k);
  return [rest.toString(), serializeUpsellFilter(f)].filter(Boolean).join('&');
}

/** The slice of a rule the list filters read (`UpsellRule` fits). */
export interface FilterableUpsell {
  name: string;
  triggerType: string;
  triggerNames?: readonly (string | null)[] | null;
  options?: readonly { name?: string | null }[] | null;
  productName?: string | null;
  places?: readonly string[] | null;
  where?: string | null;
  isActive: boolean;
}

/**
 * A rule's places. An older server sends only `where`: "quick" and "both" reached the kiosk
 * too (before it had a place of its own), and null is a kiosk-only rule; no `where` at all
 * is a rule from before places, which was everywhere.
 */
export function placesOf(rule: Pick<FilterableUpsell, 'places' | 'where'>): UpsellPlaceCode[] {
  const own = UPSELL_PLACES.filter((p) => rule.places?.includes(p));
  if (own.length) return own;
  switch (rule.where) {
    case 'tables':
      return ['tables'];
    case 'quick':
      return ['quick', 'kiosk'];
    case null:
      return ['kiosk'];
    default:
      return [...UPSELL_PLACES];
  }
}

/**
 * Text for a search, both sides: Unicode-normalised, Hebrew points and cantillation dropped
 * (קָפֶה = קפה), geresh / gershayim and curly quotes as plain quotes (צ׳יפס = צ'יפס), maqaf
 * as a hyphen, lower case (Hebrew has none; Latin names do), whitespace collapsed.
 */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[֑-ׇֽֿׁׂׅׄ]/g, '')
    .replace(/[׳‘’‛`´]/g, "'")
    .replace(/[״“”‟]/g, '"')
    .replace(/־/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every word of the search in the rule's name or one of its items (triggers, options, product). */
function matchesSearch(rule: FilterableUpsell, words: string[]): boolean {
  const fields = [
    rule.name,
    ...(rule.triggerNames ?? []),
    ...(rule.options ?? []).map((o) => o.name),
    rule.productName,
  ]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map(normalizeSearch);
  return words.every((w) => fields.some((f) => f.includes(w)));
}

/**
 * The rules that pass the filters: any of the chosen places, any of the chosen trigger
 * types, active when asked, and every word of the search (rule name or item).
 */
export function filterUpsells<R extends FilterableUpsell>(rules: readonly R[], f: UpsellFilter): R[] {
  const places = new Set<string>(f.places);
  const triggers = new Set<string>(f.triggers);
  const words = normalizeSearch(f.q).split(' ').filter(Boolean);
  return rules.filter(
    (r) =>
      (!places.size || placesOf(r).some((p) => places.has(p))) &&
      (!triggers.size || triggers.has(r.triggerType)) &&
      (!f.activeOnly || r.isActive) &&
      (!words.length || matchesSearch(r, words)),
  );
}

/* ---------------- "מעבר בין מסכים": the steps ---------------- */

/**
 * Every channel's steps merged into one order that keeps each channel's own: channels are
 * read quick → tables → kiosk, and a step not placed yet goes right after the step before it
 * on its channel (the channel's first: right before the next one already placed, else last).
 */
export function stepOrder(steps: UpsellSteps): string[] {
  const out: string[] = [];
  for (const place of UPSELL_PLACES) {
    const list = steps[place] ?? [];
    list.forEach((code, i) => {
      if (out.includes(code)) return;
      if (i > 0) {
        out.splice(out.indexOf(list[i - 1]) + 1, 0, code);
        return;
      }
      const next = list.slice(1).map((c) => out.indexOf(c)).find((k) => k >= 0);
      if (next === undefined) out.push(code);
      else out.splice(next, 0, code);
    });
  }
  return out;
}

/**
 * The step codes of the chosen places (the union), in `stepOrder` — the same order whatever
 * places are chosen, so a step never jumps when a place is switched on or off.
 */
export function validSteps(steps: UpsellSteps, places: readonly string[]): string[] {
  const offered = new Set(UPSELL_PLACES.filter((p) => places.includes(p)).flatMap((p) => steps[p] ?? []));
  return stepOrder(steps).filter((code) => offered.has(code));
}

/** Which of `places` (all, when not given) have the step, in the canonical order. */
export function stepPlaces(steps: UpsellSteps, code: string, places?: readonly string[]): UpsellPlaceCode[] {
  return UPSELL_PLACES.filter((p) => (!places || places.includes(p)) && (steps[p] ?? []).includes(code));
}

/** A transition rule's `triggerIds` as the form holds them: the steps, and the categories of "כניסה למחלקה". */
export function splitStepCodes(ids: readonly string[]): { steps: string[]; categories: string[] } {
  const steps: string[] = [];
  const categories: string[] = [];
  const prefix = `${CATEGORY_STEP}:`;
  for (const id of ids) {
    const step = id.startsWith(prefix) ? CATEGORY_STEP : id;
    if (!steps.includes(step)) steps.push(step);
    if (id.startsWith(prefix)) {
      const category = id.slice(prefix.length);
      if (category && !categories.includes(category)) categories.push(category);
    }
  }
  return { steps, categories };
}

/**
 * The `triggerIds` to send: the chosen steps in `order` (those not in it are dropped — no
 * chosen place has them), "כניסה למחלקה" as one `enter_category:<id>` per category.
 */
export function joinStepCodes(chosen: readonly string[], categories: readonly string[], order: readonly string[]): string[] {
  return order
    .filter((code) => chosen.includes(code))
    .flatMap((code) => (code === CATEGORY_STEP ? categories.map((id) => `${CATEGORY_STEP}:${id}`) : [code]));
}

/** For the list: a transition rule's codes by step, with the category names of "כניסה למחלקה". */
export function groupStepCodes(
  ids: readonly string[],
  names: readonly (string | null)[] = [],
): { step: string; names: string[] }[] {
  const out: { step: string; names: string[] }[] = [];
  const prefix = `${CATEGORY_STEP}:`;
  ids.forEach((id, i) => {
    const step = id.startsWith(prefix) ? CATEGORY_STEP : id;
    let group = out.find((g) => g.step === step);
    if (!group) {
      group = { step, names: [] };
      out.push(group);
    }
    if (id.startsWith(prefix)) group.names.push(names[i] ?? '—');
  });
  return out;
}
