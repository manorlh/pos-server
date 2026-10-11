/**
 * The voucher setup's quick presets and its item groups ("קבוצות פריטים", the production vouchers
 * contract §1) as the forms edit them — the type editor and the new batch.
 *
 * A preset only fills the form with values the owner could set by hand; nothing new reaches the
 * cloud. The groups are sent as the API takes them (server/app/schemas/prepaid_voucher.py
 * `PrepaidGroupIn`), and checked here first with the cloud's own limits — the value, the reason and
 * the limit in each message (P:\specs\voucher-glossary.md §6).
 *
 * "כרטיסייה — מכסת שימושים" (the owner, 12.10.2026; P:\specs\voucher-punch-card.md): a goods voucher
 * of ONE group "פריטים" (min 1, max N, the same item more than once), N items in all, redeemed in
 * parts — one scan takes every approved item of the sale, up to what is left.
 */

import type { PrepaidDiscountType, PrepaidVoucherKind } from './prepaidVoucherBenefit';

/** The most units one group gives (the cloud's `MAX_ITEM_QUANTITY`). */
export const MAX_GROUP_QTY = 100;
/** The most groups a voucher has (the cloud's `MAX_GROUPS`). */
export const MAX_GROUPS = 20;

export type VoucherSelection = 'items' | 'groups';
export type VoucherPreset = 'choice' | 'meal' | 'punch' | 'discount';
export const VOUCHER_PRESETS: readonly VoucherPreset[] = ['choice', 'meal', 'punch', 'discount'];

/** A chosen product or category, with its name for the chips and the summary. */
export interface NamedRef {
  id: string;
  name: string;
}

/** One item group as the form holds it (numbers as typed). */
export interface DraftGroup {
  key?: string;
  name: string;
  minQty: string;
  maxQty: string;
  /** "אותו פריט יותר מפעם אחת" — on by default (the cloud's default). */
  allowRepeat: boolean;
  /** "כל התפריט". */
  allItems: boolean;
  products: NamedRef[];
  categories: NamedRef[];
  includeSubcategories: boolean;
  excludeProducts: NamedRef[];
  excludeCategories: NamedRef[];
  /** ₪ per item of the group in a fixed-value voucher ('' — by the list prices). Kept as it came. */
  value: string;
}

/** The groups as the API takes them (`groups` of a type or a batch). */
export interface GroupBody {
  key?: string;
  name: string;
  minQty: number;
  maxQty: number;
  value?: number | null;
  allowRepeat: boolean;
  allItems: boolean;
  productIds: string[];
  categoryIds: string[];
  includeSubcategories: boolean;
  excludeProductIds: string[];
  excludeCategoryIds: string[];
  sortOrder: number;
}

/** A group as the API returns it (₪ for its value). */
export interface GroupOut {
  key: string;
  name: string;
  minQty: number;
  maxQty: number;
  value?: number | null;
  allowRepeat?: boolean;
  allItems?: boolean;
  productIds?: string[];
  categoryIds?: string[];
  includeSubcategories?: boolean;
  excludeProductIds?: string[];
  excludeCategoryIds?: string[];
}

/** The names the cloud sends with a type's / batch's groups (`groupNames`). */
export interface GroupNames {
  products: Record<string, string>;
  categories: Record<string, string>;
}

export function emptyGroup(name = ''): DraftGroup {
  return {
    name, minQty: '1', maxQty: '1', allowRepeat: true, allItems: false, products: [], categories: [],
    includeSubcategories: true, excludeProducts: [], excludeCategories: [], value: '',
  };
}

/** What a preset sets on the form. */
export interface PresetValues {
  kind: PrepaidVoucherKind;
  selection: VoucherSelection;
  groups: DraftGroup[];
  /** "סה״כ פריטים בשובר" as typed ('' — the groups' maxima). */
  totalQty: string;
  splitAllowed: boolean;
  discountType?: PrepaidDiscountType;
}

/**
 * The values of [preset]:
 * * `choice` — "פריט אחד מתוך מגוון": one group "פריט לבחירה" of 1, one item in all, in one sale;
 * * `meal` — "ארוחה: מנה + תוספת + משקה": three groups of one each, the package whole in one sale;
 * * `punch` — "כרטיסייה — מכסת שימושים": one group "פריטים" of 1–[uses], the same item again, [uses]
 *   items in all, redeemed in parts;
 * * `discount` — "הנחה בש״ח או באחוזים": a discount on the whole sale (₪ by default).
 * [keep]: the groups' products and categories already chosen stay on the first group.
 */
export function presetValues(preset: VoucherPreset, uses = 50, keep?: DraftGroup): PresetValues {
  const picks = (g: DraftGroup): DraftGroup => (keep ? {
    ...g, allItems: keep.allItems, products: keep.products, categories: keep.categories,
    includeSubcategories: keep.includeSubcategories, excludeProducts: keep.excludeProducts, excludeCategories: keep.excludeCategories,
  } : g);
  switch (preset) {
    case 'choice':
      return { kind: 'items', selection: 'groups', groups: [picks(emptyGroup('פריט לבחירה'))], totalQty: '1', splitAllowed: false };
    case 'meal':
      return {
        kind: 'items', selection: 'groups', totalQty: '', splitAllowed: false,
        groups: [picks(emptyGroup('מנה')), emptyGroup('תוספת'), emptyGroup('משקה')],
      };
    case 'punch': {
      const n = String(Math.max(1, Math.min(MAX_GROUP_QTY, Math.round(uses) || 1)));
      return {
        kind: 'items', selection: 'groups', totalQty: n, splitAllowed: true,
        groups: [{ ...picks(emptyGroup('פריטים')), minQty: '1', maxQty: n, allowRepeat: true }],
      };
    }
    case 'discount':
      return { kind: 'order_discount', selection: 'items', groups: [], totalQty: '', splitAllowed: false, discountType: 'fixed' };
  }
}

/** The punch card's uses ("כמה פריטים בכרטיסייה") set on [groups] / the total, the rest as it is. */
export function withPunchUses(groups: DraftGroup[], uses: string): { groups: DraftGroup[]; totalQty: string } {
  const [first, ...rest] = groups.length ? groups : [emptyGroup('פריטים')];
  return { groups: [{ ...first, maxQty: uses, minQty: first.minQty || '1' }, ...rest], totalQty: uses };
}

function whole(text: string): number | null {
  const t = String(text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  return parseInt(t, 10);
}

/**
 * A punch card: ONE group of the same item again, as many items in all as the group gives — the form
 * shows it as "כרטיסייה" (one field, "כמה פריטים בכרטיסייה") and the summary says so.
 */
export function isPunchCard(selection: VoucherSelection | null | undefined, groups: readonly { minQty: number | string; maxQty: number | string; allowRepeat?: boolean }[], totalQty: number | string | null | undefined): boolean {
  if (selection !== 'groups' || groups.length !== 1) return false;
  const g = groups[0];
  const max = typeof g.maxQty === 'number' ? g.maxQty : whole(g.maxQty);
  const min = typeof g.minQty === 'number' ? g.minQty : whole(g.minQty);
  const total = totalQty == null || totalQty === '' ? max : typeof totalQty === 'number' ? totalQty : whole(totalQty);
  return max != null && max > 1 && total === max && (min ?? 0) <= 1 && g.allowRepeat !== false;
}

export interface GroupProblem {
  /** The group's index, or null for the voucher as a whole. */
  group: number | null;
  text: string;
}

/**
 * What is wrong with the groups and the total, in words — the value, the reason and the limit — or
 * an empty list. The cloud refuses the same (`PrepaidGroupIn`, `_check_terms`).
 */
export function groupProblems(groups: readonly DraftGroup[], totalQty: string): GroupProblem[] {
  const out: GroupProblem[] = [];
  if (!groups.length) out.push({ group: null, text: 'הוסיפו לפחות קבוצת פריטים אחת.' });
  if (groups.length > MAX_GROUPS) {
    out.push({ group: null, text: `לא ניתן לשמור ${groups.length} קבוצות פריטים: אפשר עד ${MAX_GROUPS} קבוצות בשובר.` });
  }
  let least = 0;
  let most = 0;
  groups.forEach((g, i) => {
    const label = g.name.trim() || `קבוצה ${i + 1}`;
    if (!g.name.trim()) out.push({ group: i, text: `קבוצה ${i + 1}: חסר שם (למשל "מנה" או "משקה").` });
    const min = whole(g.minQty);
    const max = whole(g.maxQty);
    if (max === null || max < 1 || max > MAX_GROUP_QTY) {
      out.push({ group: i, text: `${label}: לא ניתן לשמור "${g.maxQty}" פריטים לכל היותר — מספר שלם בין 1 ל-${MAX_GROUP_QTY}.` });
    }
    if (min === null || min < 0 || min > MAX_GROUP_QTY) {
      out.push({ group: i, text: `${label}: לא ניתן לשמור "${g.minQty}" פריטים לפחות — מספר שלם בין 0 ל-${MAX_GROUP_QTY}.` });
    } else if (max !== null && min > max) {
      out.push({ group: i, text: `${label}: לפחות ${min} פריטים גבוה מ"עד ${max} פריטים". המינימום לא יכול לעלות על המקסימום.` });
    }
    if (!g.allItems && !g.products.length && !g.categories.length) {
      out.push({ group: i, text: `${label}: לא נבחרו פריטים. בחרו מוצרים, קטגוריות או "כל התפריט".` });
    }
    least += min ?? 0;
    most += max ?? 0;
  });
  const t = totalQty.trim();
  if (t) {
    const total = whole(t);
    if (total === null || total < 1) {
      out.push({ group: null, text: `לא ניתן לשמור "${t}" כסה״כ פריטים בשובר: מספר שלם מ-1 ומעלה, או ריק (סכום המקסימום של הקבוצות).` });
    } else if (groups.length && (total < least || total > most)) {
      out.push({
        group: null,
        text: total > most
          ? `לא ניתן לשמור ${total} פריטים בשובר: הקבוצות נותנות יחד עד ${most} פריטים. הגדילו את "עד" בקבוצה או הקטינו את הסה״כ.`
          : `לא ניתן לשמור ${total} פריטים בשובר: הקבוצות דורשות יחד לפחות ${least} פריטים.`,
      });
    }
  }
  return out;
}

/** "כמה פריטים בכרטיסייה" as typed: null when fine, else the value, the reason and the limit. */
export function punchUsesProblem(uses: string): string | null {
  const n = whole(uses);
  if (n !== null && n >= 1 && n <= MAX_GROUP_QTY) return null;
  return `לא ניתן לשמור "${uses.trim()}": בכרטיסייה אפשר 1–${MAX_GROUP_QTY} פריטים (המכסה של קבוצת פריטים אחת).`;
}

/** The groups as the API takes them. */
export function groupsBody(groups: readonly DraftGroup[]): GroupBody[] {
  return groups.map((g, i) => {
    const value = g.value.trim() ? Number(g.value.replace(',', '.')) : null;
    return {
      ...(g.key ? { key: g.key } : {}),
      name: g.name.trim(),
      minQty: whole(g.minQty) ?? 0,
      maxQty: whole(g.maxQty) ?? 1,
      value: Number.isFinite(value as number) ? value : null,
      allowRepeat: g.allowRepeat,
      allItems: g.allItems,
      productIds: g.allItems ? [] : g.products.map((p) => p.id),
      categoryIds: g.allItems ? [] : g.categories.map((c) => c.id),
      includeSubcategories: g.includeSubcategories,
      excludeProductIds: g.excludeProducts.map((p) => p.id),
      excludeCategoryIds: g.excludeCategories.map((c) => c.id),
      sortOrder: i,
    };
  });
}

/** "סה״כ פריטים בשובר" as the API takes it: null — the groups' maxima. */
export function totalQtyBody(totalQty: string): number | null {
  return whole(totalQty);
}

/** A type's / batch's groups as the form edits them, named by the cloud's `groupNames` (an id when unnamed). */
export function draftGroupsOf(groups: readonly GroupOut[] | null | undefined, names?: GroupNames | null): DraftGroup[] {
  const product = (id: string): NamedRef => ({ id, name: names?.products?.[id.toLowerCase()] ?? names?.products?.[id] ?? id });
  const category = (id: string): NamedRef => ({ id, name: names?.categories?.[id.toLowerCase()] ?? names?.categories?.[id] ?? id });
  return (groups ?? []).map((g) => ({
    key: g.key,
    name: g.name ?? '',
    minQty: String(g.minQty ?? 0),
    maxQty: String(g.maxQty ?? 1),
    allowRepeat: g.allowRepeat !== false,
    allItems: !!g.allItems,
    products: (g.productIds ?? []).map(product),
    categories: (g.categoryIds ?? []).map(category),
    includeSubcategories: g.includeSubcategories !== false,
    excludeProducts: (g.excludeProductIds ?? []).map(product),
    excludeCategories: (g.excludeCategoryIds ?? []).map(category),
    value: g.value == null ? '' : String(g.value),
  }));
}
