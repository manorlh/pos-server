/**
 * How a page states what the shared scope means to it, and what the scope bar
 * does about it.
 *
 * The scope bar is one control for the whole dashboard, but the eighteen pages
 * behind it do not all answer the same question. `/dashboard/products` is the
 * tenant's global catalogue and a shop cannot narrow it. `/dashboard/stock` is
 * meaningless until a shop is chosen. `/dashboard/transactions` filters by shop
 * or by device but has no company filter at all on the server.
 *
 * So each page declares a `PageScopeSpec` and `resolvePageScope` turns the
 * current selection into one of three outcomes. The important property is that
 * none of them is "quietly show something else":
 *
 * * `ok` — the page runs. `effective` is the selection clamped to what the page
 *   can actually use, so a page whose `maxLevel` is `'shop'` never receives a
 *   machine id it would ignore. `ignoredDeeper` says whether clamping dropped
 *   anything, which the page surfaces as a one-line note.
 * * `needs` — the selection is too shallow (`minLevel` unmet). The page renders a
 *   prompt naming the level to pick, not an empty table.
 * * `unsupported` — the selection sits at a level this page cannot express
 *   (`unsupported`). Same: say so, and offer the way out.
 *
 * The bar reads the same spec: levels above `maxLevel` are shown disabled with a
 * "does not affect this page" hint rather than silently accepting a value the
 * page throws away.
 */
import type { ScopeLevel, ScopeSelection } from './types';

export const SCOPE_LEVELS: ScopeLevel[] = ['tenant', 'company', 'shop', 'machine'];

export const SCOPE_LEVEL_ORDER: Record<ScopeLevel, number> = {
  tenant: 0,
  company: 1,
  shop: 2,
  machine: 3,
};

export interface PageScopeSpec {
  /**
   * The deepest level whose id this page's requests actually carry. Anything
   * deeper is dropped from `effective` and reported as ignored.
   */
  maxLevel: ScopeLevel;
  /** Shallowest level the page can work at. Default `'tenant'`. */
  minLevel?: ScopeLevel;
  /**
   * Levels between `minLevel` and `maxLevel` that the page still cannot express —
   * `['company']` for the reports, whose endpoints take `shopId`/`machineId` only.
   */
  unsupported?: ScopeLevel[];
  /**
   * Suppress the "the scope does not narrow this page" note. For pages where the
   * scope is simply irrelevant (the user's own profile) rather than clamped.
   */
  silent?: boolean;
}

export function scopeLevelOf(selection: ScopeSelection): ScopeLevel {
  if (selection.machineId) return 'machine';
  if (selection.shopId) return 'shop';
  if (selection.companyId) return 'company';
  return 'tenant';
}

/** Drop every id deeper than `maxLevel`. */
export function clampSelection(selection: ScopeSelection, maxLevel: ScopeLevel): ScopeSelection {
  const max = SCOPE_LEVEL_ORDER[maxLevel];
  return {
    companyId: max >= SCOPE_LEVEL_ORDER.company ? selection.companyId : null,
    shopId: max >= SCOPE_LEVEL_ORDER.shop ? selection.shopId : null,
    machineId: max >= SCOPE_LEVEL_ORDER.machine ? selection.machineId : null,
  };
}

export type PageScopeResolution =
  | {
      status: 'ok';
      effective: ScopeSelection;
      effectiveLevel: ScopeLevel;
      /** True when clamping to `maxLevel` dropped a level the user had chosen. */
      ignoredDeeper: boolean;
      maxLevel: ScopeLevel;
    }
  | {
      status: 'needs';
      /** The level the user must choose before the page can show anything. */
      needed: ScopeLevel;
      effective: ScopeSelection;
      effectiveLevel: ScopeLevel;
      maxLevel: ScopeLevel;
    }
  | {
      status: 'unsupported';
      /** The level currently selected that this page cannot filter by. */
      level: ScopeLevel;
      effective: ScopeSelection;
      effectiveLevel: ScopeLevel;
      maxLevel: ScopeLevel;
    };

export function resolvePageScope(
  spec: PageScopeSpec,
  selection: ScopeSelection,
): PageScopeResolution {
  const maxLevel = spec.maxLevel;
  const minLevel = spec.minLevel ?? 'tenant';
  const effective = clampSelection(selection, maxLevel);
  const effectiveLevel = scopeLevelOf(effective);
  const selectedLevel = scopeLevelOf(selection);
  const ignoredDeeper = SCOPE_LEVEL_ORDER[selectedLevel] > SCOPE_LEVEL_ORDER[maxLevel];

  if (SCOPE_LEVEL_ORDER[effectiveLevel] < SCOPE_LEVEL_ORDER[minLevel]) {
    return { status: 'needs', needed: minLevel, effective, effectiveLevel, maxLevel };
  }
  if ((spec.unsupported ?? []).includes(effectiveLevel)) {
    return { status: 'unsupported', level: effectiveLevel, effective, effectiveLevel, maxLevel };
  }
  return { status: 'ok', effective, effectiveLevel, ignoredDeeper, maxLevel };
}

/** True when the bar should let the user set this level on the current page. */
export function levelEnabledForSpec(spec: PageScopeSpec | null, level: ScopeLevel): boolean {
  if (!spec) return true;
  return SCOPE_LEVEL_ORDER[level] <= SCOPE_LEVEL_ORDER[spec.maxLevel];
}
