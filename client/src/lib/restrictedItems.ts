/**
 * "מחייב אישור מנהל במכירה" (pos-server app/services/restricted_items.py): a product, or a
 * category with everything beneath it, sold at the till only on a manager's code (till
 * permission SELL_RESTRICTED_ITEMS), and never shown at a kiosk. Self-contained, so `npm test`
 * compiles it alone and kiosk-desktop reads it through `@dash-lib`.
 *
 * The cloud stores and ships each row's own flag (`requiresManagerApproval`); whoever builds a
 * menu resolves the tree: a product is restricted when its own flag is set, or its category's,
 * or that of any category above it.
 */

export const RESTRICTED_FIELD = 'requiresManagerApproval';

/** The till permission whose holders are never asked. */
export const RESTRICTED_PERMISSION = 'SELL_RESTRICTED_ITEMS';

/** A category row as far as the tree goes. */
export interface RestrictedCategoryRow {
  id: string;
  parentId?: string | null;
  requiresManagerApproval?: boolean | null;
}

/** A product row as far as the rule goes. */
export interface RestrictedProductRow {
  categoryId?: string | null;
  requiresManagerApproval?: boolean | null;
}

/** How deep a tree is followed: a guard against a cycle in bad data. */
const MAX_DEPTH = 64;

/**
 * The ids of every restricted category: flagged itself, or beneath a flagged one. A parent
 * missing from the list ends the walk up; so does a cycle.
 */
export function restrictedCategoryIds(categories: readonly RestrictedCategoryRow[]): Set<string> {
  const parent = new Map<string, string | null>();
  const flagged = new Set<string>();
  for (const c of categories) {
    if (!c || c.id == null) continue;
    const id = String(c.id);
    parent.set(id, c.parentId == null ? null : String(c.parentId));
    if (c.requiresManagerApproval === true) flagged.add(id);
  }
  const out = new Set<string>();
  if (flagged.size === 0) return out;
  for (const start of parent.keys()) {
    const seen = new Set<string>();
    let cur: string | null = start;
    let depth = 0;
    while (cur != null && !seen.has(cur) && depth < MAX_DEPTH) {
      if (flagged.has(cur) || out.has(cur)) {
        out.add(start);
        break;
      }
      seen.add(cur);
      cur = parent.get(cur) ?? null;
      depth += 1;
    }
  }
  return out;
}

/** A product: its own flag, or its category is restricted (itself or above). */
export function isRestrictedProduct(product: RestrictedProductRow, restrictedCategories: ReadonlySet<string>): boolean {
  if (product.requiresManagerApproval === true) return true;
  return product.categoryId != null && restrictedCategories.has(String(product.categoryId));
}

/**
 * What the dashboard says about a product: `own` — its own flag; `inherited` — not its own,
 * but its category (or one above) is restricted; null — not restricted.
 */
export function restrictionOf(
  product: RestrictedProductRow,
  restrictedCategories: ReadonlySet<string>,
): 'own' | 'inherited' | null {
  if (product.requiresManagerApproval === true) return 'own';
  return product.categoryId != null && restrictedCategories.has(String(product.categoryId)) ? 'inherited' : null;
}

/** The same for a category: flagged itself, or beneath a flagged one. */
export function categoryRestrictionOf(
  category: RestrictedCategoryRow,
  restrictedCategories: ReadonlySet<string>,
): 'own' | 'inherited' | null {
  if (category.requiresManagerApproval === true) return 'own';
  return restrictedCategories.has(String(category.id)) ? 'inherited' : null;
}

/**
 * A kiosk's catalog without what needs a manager's code: every restricted product and every
 * restricted category. `extraCategories` complete the tree without being kept (parents a
 * delta did not carry).
 */
export function withoutRestricted<P extends RestrictedProductRow, C extends RestrictedCategoryRow>(
  products: readonly P[],
  categories: readonly C[],
  extraCategories: readonly RestrictedCategoryRow[] = [],
): { products: P[]; categories: C[] } {
  const restricted = restrictedCategoryIds([...categories, ...extraCategories]);
  return {
    products: products.filter((p) => !isRestrictedProduct(p, restricted)),
    categories: categories.filter((c) => !restricted.has(String(c.id))),
  };
}
