/**
 * The plain logic of three dashboard pages on the report framework (P:\specs\reports-upgrade.md §5):
 *
 * * דוחות תפריט — the tab in the URL (`?tab=meals`) and each tab's own report key; the meals
 *   as one list of rows, each meal followed by its components (the hierarchy the table and
 *   the Excel keep); a meal's notes; the upsells' acceptance rate.
 * * הגדלות מכירה (the rules page) — the export's totals over the rules shown.
 * * יעדים — when a target applies, as the list writes it.
 *
 * No React, no `@/` imports (the node test build compiles it alone); the types are
 * structural, so lib/menuApi's and lib/stockLiveApi's rows fit as they are.
 */

/* ---------------- דוחות תפריט ---------------- */

export const MENU_REPORT_TABS = ['modifiers', 'meals', 'upsells'] as const;
export type MenuReportTab = (typeof MENU_REPORT_TABS)[number];

/** The URL key of the tab (`?tab=meals`); the first tab is the default and is left out. */
export const MENU_REPORT_TAB_PARAM = 'tab';

/** `?tab=` → the tab; anything else is the first. */
export function parseMenuReportTab(raw: string | null | undefined): MenuReportTab {
  return (MENU_REPORT_TABS as readonly string[]).includes(raw ?? '') ? (raw as MenuReportTab) : 'modifiers';
}

/** `search` (the page's query) with the tab set, every other key kept; the default tab drops the key. */
export function withMenuReportTab(search: string, tab: MenuReportTab): string {
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  if (tab === 'modifiers') params.delete(MENU_REPORT_TAB_PARAM);
  else params.set(MENU_REPORT_TAB_PARAM, tab);
  return params.toString();
}

/**
 * Each tab is a report of its own: its own saved columns and its own company export default
 * (one default is one list per report key — a shared key would let one tab's save wipe another's).
 */
export const MENU_REPORT_KEYS: Readonly<Record<MenuReportTab, string>> = {
  modifiers: 'menu-reports.modifiers',
  meals: 'menu-reports.meals',
  upsells: 'menu-reports.upsells',
};

/** A meal's component, as the report sends it. */
export interface MealComponentLike {
  productId: string | null;
}

/** A meal row, as the report sends it. */
export interface MealLike<C extends MealComponentLike> {
  productId: string | null;
  components: readonly C[];
  unredeemed?: readonly { slotName: string; count: number }[] | null;
  takenLater?: number | null;
  refills?: number | null;
}

/** One line of the meals table: the meal itself (`component` null) or one of its components. */
export interface MealLine<M, C> {
  key: string;
  meal: M;
  component: C | null;
}

/**
 * The meals as table rows: each meal, then its components right under it — the order the
 * screen, the Excel and the PDF keep (the table does not sort them apart).
 */
export function mealLines<M extends MealLike<MealComponentLike>>(meals: readonly M[]): MealLine<M, M['components'][number]>[] {
  const out: MealLine<M, M['components'][number]>[] = [];
  meals.forEach((meal, i) => {
    // A meal / component without a product id (a deleted product) is keyed by its place: `#n` is never an id.
    const mealKey = meal.productId ?? `#${i}`;
    out.push({ key: `meal:${mealKey}`, meal, component: null });
    meal.components.forEach((component: M['components'][number], k) => {
      out.push({ key: `component:${mealKey}:${component.productId ?? `#${k}`}`, meal, component });
    });
  });
  return out;
}

export interface MealNoteWords {
  /** "לא מומש: {items}". */
  unredeemed: (items: string) => string;
  /** "נלקח אחר כך: {n}". */
  takenLater: (n: string) => string;
  /** "ריפילים: {n}". */
  refills: (n: string) => string;
  /** How a quantity is written. */
  qty: (n: number) => string;
}

/**
 * A meal's notes, in order: what the meals included and nobody took (per slot), what was
 * taken later, the refills. Empty when there is none of them.
 */
export function mealNotes(meal: MealLike<MealComponentLike>, words: MealNoteWords): string[] {
  const out: string[] = [];
  if (meal.unredeemed?.length) {
    out.push(words.unredeemed(meal.unredeemed.map((u) => `${u.slotName} ×${words.qty(u.count)}`).join(', ')));
  }
  if (meal.takenLater) out.push(words.takenLater(words.qty(meal.takenLater)));
  if (meal.refills) out.push(words.refills(words.qty(meal.refills)));
  return out;
}

/** The server's acceptance rate (0..1) as a percent with one decimal (0.3333 → 33.3); null stays null. */
export function ratePercent(rate: number | null | undefined): number | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null;
  return Math.round(rate * 1000) / 10;
}

/** The rate as the screen has always written it: whole percent ("33%"), "—" with nothing shown. */
export function rateText(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** "קולה ×3, ספרייט ×1". */
export function optionsTakenText(options: readonly { name: string | null; count: number }[] | null | undefined): string {
  return (options ?? []).map((o) => `${o.name ?? '—'} ×${o.count}`).join(', ');
}

/* ---------------- הגדלות מכירה: the rules' export ---------------- */

/** A rule's figures in the stats window (`/reports/upsells` row). */
export interface UpsellFiguresLike {
  shown: number;
  accepted: number;
  dismissed: number;
  declined?: number;
  revenue: number;
}

export interface UpsellFigureTotals {
  shown: number;
  accepted: number;
  dismissed: number;
  declined: number;
  revenue: number;
  /** Taken of shown, in percent with one decimal; null when nothing was shown. */
  rate: number | null;
}

/**
 * The totals of the rules listed (a rule without figures counts as nothing): the rate is
 * taken of shown over the same rules, as the server works it out.
 */
export function upsellFigureTotals(figures: readonly (UpsellFiguresLike | null | undefined)[]): UpsellFigureTotals {
  const t = { shown: 0, accepted: 0, dismissed: 0, declined: 0, revenue: 0 };
  for (const f of figures) {
    if (!f) continue;
    t.shown += f.shown;
    t.accepted += f.accepted;
    t.dismissed += f.dismissed;
    t.declined += f.declined ?? 0;
    t.revenue += f.revenue;
  }
  return {
    ...t,
    revenue: Math.round(t.revenue * 100) / 100,
    rate: t.shown ? ratePercent(t.accepted / t.shown) : null,
  };
}

/* ---------------- יעדים ---------------- */

export interface TargetWhenLike {
  period: 'day' | 'event';
  day: string | null;
  dayStart: string;
  dayEnd: string;
}

export interface TargetWhenWords {
  /** "לאירוע". */
  event: string;
  /** "ליום {day}". */
  day: (day: string) => string;
  /** "כל יום {from}–{to}". */
  everyDay: (from: string, to: string) => string;
}

/** When a target applies, as the targets list writes it. */
export function targetWhen(r: TargetWhenLike, words: TargetWhenWords): string {
  if (r.period === 'event') return words.event;
  return r.day ? words.day(r.day) : words.everyDay(r.dayStart, r.dayEnd);
}

/** A field a newer server added (§4): true when any row carries it, so its column is shown. */
export function anyRowHas<R>(rows: readonly R[], pick: (row: R) => unknown): boolean {
  return rows.some((r) => pick(r) !== undefined);
}
