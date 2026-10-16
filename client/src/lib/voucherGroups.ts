/**
 * Production vouchers of groups ("שוברי הפקה", "פריט אחד מכל קבוצה" — P:\specs\voucher-one-per-group.md): which group each
 * unit of a basket fills, and whether a chosen redemption is valid — the cloud's `assign_units` / `check_selection`
 * (server/app/services/production_voucher_rules.py) and the Android till's ProductionVoucherRules.assignUnits /
 * checkSelection, ported once and pinned by the same fixture (server/tests/fixtures/prepaid_voucher_rules.json, sections
 * `assignment` and `selection`; the same bytes in pos-android). The Windows till matches a scanned voucher to its basket
 * with them before it asks the cloud to hold it; the cloud checks the same again. Pure; no imports.
 */

/* ------------------------------------------------------------------ codes */

export const NOT_IN_GROUP = 'prepaid_voucher_item_not_on_voucher';
export const EXCLUDED = 'prepaid_voucher_item_excluded';
export const GROUP_OVER = 'prepaid_voucher_group_over';
export const TOTAL_OVER = 'prepaid_voucher_total_over';
export const REPEAT = 'prepaid_voucher_repeat_not_allowed';
export const PACKAGE_INCOMPLETE = 'prepaid_voucher_package_incomplete';
export const NOTHING_CHOSEN = 'prepaid_voucher_nothing_chosen';
/** The cloud's refusal of a unit several groups take: the cashier says which (`units: [{ref, groupKeys, groupNames}]`). */
export const GROUP_AMBIGUOUS = 'prepaid_voucher_group_ambiguous';

/** Why a unit was left without a group. */
export const UNIT_NOT_ELIGIBLE = 'not_eligible';
export const UNIT_GROUP_FULL = 'group_full';
export const UNIT_TOTAL_FULL = 'total_full';
export type UnitWhy = typeof UNIT_NOT_ELIGIBLE | typeof UNIT_GROUP_FULL | typeof UNIT_TOTAL_FULL;

/** The Hebrew the cashier reads (the spec's §11) — the cloud's TEXT. */
export const GROUP_TEXT = {
  [NOT_IN_GROUP]: 'הפריט אינו כלול בשובר זה',
  [EXCLUDED]: 'הפריט הוחרג משובר זה',
  oneOnly: 'ניתן לבחור פריט אחד בלבד בשובר זה',
  groupOver: (n: number, group: string) => `ניתן לבחור עד ${n} פריטים מ"${group}"`,
  groupOne: (group: string) => `ניתן לבחור פריט אחד בלבד מ"${group}"`,
  groupLeft: (group: string, n: number) => `מקבוצת "${group}" אפשר לממש עוד ${unitsText(n)} בשובר זה`,
  groupUsed: (group: string) => `מקבוצת "${group}" כבר מומש כל מה שבשובר זה`,
  totalOver: (n: number) => `ניתן לבחור עד ${n} פריטים בשובר זה`,
  repeat: (group: string) => `אי אפשר לבחור את אותו פריט פעמיים ב${group}`,
  incomplete: (group: string, type: string) => `חסר ${group} להשלמת ${type}`,
  voucher: 'השובר',
  [NOTHING_CHOSEN]: 'לא נבחר פריט למימוש',
} as const;

/** "פריט אחד", "3 פריטים" — the glossary's units, always said. */
export function unitsText(n: number): string {
  return Math.trunc(n) === 1 ? 'פריט אחד' : `${Math.trunc(n)} פריטים`;
}

/* ------------------------------------------------------------- assignment */

/** A group as the assignment sees it: what it takes, and its room. */
export interface GroupCap<U = string> {
  key: string;
  /** Whether the group takes [unit] (a product id, or the unit itself). */
  takes: (unit: U) => boolean;
  remaining: number;
}

export interface Assignment {
  /** Unit ref → group key, in basket order. */
  assigned: Record<string, string>;
  unassigned: Array<{ ref: string; reason: UnitWhy }>;
  /** A unit several open groups take: the cashier's choice (nothing is taken for it). */
  ambiguous: Array<{ ref: string; groupKeys: string[] }>;
}

/**
 * Each basket unit, in basket order, to a group — only when the match is single and clear (§11: "בכמה התאמות מציגים
 * בחירה ולא משייכים בסתר"): the voucher's total used up → `total_full`; no group takes it → `not_eligible`; every group
 * that takes it is full → `group_full`; exactly one with room → assigned (its room and the total shrink); more → ambiguous.
 * A unit fills one group only: a line of 3 is three units.
 */
export function assignUnitsBy<U>(groups: ReadonlyArray<GroupCap<U>>, units: ReadonlyArray<readonly [string, U]>, totalRemaining: number): Assignment {
  const room = new Map(groups.map((g) => [g.key, Math.trunc(g.remaining)] as const));
  let total = Math.trunc(totalRemaining);
  const out: Assignment = { assigned: {}, unassigned: [], ambiguous: [] };
  for (const [ref, unit] of units) {
    if (total <= 0) {
      out.unassigned.push({ ref, reason: UNIT_TOTAL_FULL });
      continue;
    }
    const takers = groups.filter((g) => g.takes(unit)).map((g) => g.key);
    if (takers.length === 0) {
      out.unassigned.push({ ref, reason: UNIT_NOT_ELIGIBLE });
      continue;
    }
    const open = takers.filter((k) => (room.get(k) ?? 0) > 0);
    if (open.length === 0) out.unassigned.push({ ref, reason: UNIT_GROUP_FULL });
    else if (open.length === 1) {
      out.assigned[ref] = open[0];
      room.set(open[0], (room.get(open[0]) ?? 0) - 1);
      total -= 1;
    } else out.ambiguous.push({ ref, groupKeys: open });
  }
  return out;
}

/** The cloud's own shape: groups by their product ids, units as (ref, productId). */
export function assignUnits(groups: ReadonlyArray<{ key: string; productIds: readonly string[]; remaining: number }>, units: ReadonlyArray<readonly [string, string]>, totalRemaining: number): Assignment {
  return assignUnitsBy(
    groups.map((g) => ({ key: g.key, remaining: g.remaining, takes: (pid: string) => g.productIds.includes(pid) })),
    units,
    totalRemaining,
  );
}

/* -------------------------------------------------------------- selection */

export interface SelectionGroup {
  key: string;
  name: string;
  minQty: number;
  maxQty: number;
  remaining: number;
  productIds: readonly string[];
  allowRepeat?: boolean;
  excludedIds?: readonly string[];
}

export interface SelectionRefusal {
  code: string;
  text: string;
  groupKey: string | null;
}

/**
 * The first thing wrong with redeeming [chosen] — (productId, groupKey, quantity) — or null: nothing chosen; a product
 * its group does not take (an excluded one says so); a group over what it has left (a one-of-N voucher: "ניתן לבחור פריט
 * אחד בלבד בשובר זה"; a voucher of two groups or more: the group and what is left of it); a product twice in a group
 * that does not allow it; the voucher's total over; `wholeAtOnce` and a group short of its minimum ("חסר משקה להשלמת
 * שובר הארוחה").
 */
export function checkSelection(
  groups: readonly SelectionGroup[],
  chosen: ReadonlyArray<readonly [string, string, number]>,
  o: { totalMax: number; totalRemaining: number; wholeAtOnce: boolean; typeName?: string | null },
): SelectionRefusal | null {
  const byKey = new Map(groups.map((g) => [g.key, g] as const));
  if (chosen.length === 0 || chosen.reduce((s, [, , q]) => s + Math.trunc(q), 0) <= 0) return { code: NOTHING_CHOSEN, text: GROUP_TEXT[NOTHING_CHOSEN], groupKey: null };
  const taken = new Map<string, number>();
  const seen = new Map<string, Map<string, number>>();
  for (const [pid, key, q] of chosen) {
    const g = byKey.get(key);
    if (!g || !g.productIds.includes(pid)) {
      if (g && (g.excludedIds ?? []).includes(pid)) return { code: EXCLUDED, text: GROUP_TEXT[EXCLUDED], groupKey: key };
      return { code: NOT_IN_GROUP, text: GROUP_TEXT[NOT_IN_GROUP], groupKey: key };
    }
    taken.set(key, (taken.get(key) ?? 0) + Math.trunc(q));
    const per = seen.get(key) ?? new Map<string, number>();
    per.set(pid, (per.get(pid) ?? 0) + Math.trunc(q));
    seen.set(key, per);
  }
  for (const g of groups) {
    if ((taken.get(g.key) ?? 0) > g.remaining) {
      let text: string;
      if (o.totalMax === 1) text = GROUP_TEXT.oneOnly;
      else if (groups.length >= 2) text = g.remaining >= 1 ? GROUP_TEXT.groupLeft(g.name, g.remaining) : GROUP_TEXT.groupUsed(g.name);
      else if (g.remaining === 1) text = GROUP_TEXT.groupOne(g.name);
      else text = GROUP_TEXT.groupOver(g.remaining, g.name);
      return { code: GROUP_OVER, text, groupKey: g.key };
    }
  }
  for (const g of groups) {
    if (g.allowRepeat === false && [...(seen.get(g.key)?.values() ?? [])].some((n) => n > 1)) return { code: REPEAT, text: GROUP_TEXT.repeat(g.name), groupKey: g.key };
  }
  const total = [...taken.values()].reduce((s, n) => s + n, 0);
  if (total > o.totalRemaining) return { code: TOTAL_OVER, text: o.totalMax === 1 ? GROUP_TEXT.oneOnly : GROUP_TEXT.totalOver(o.totalRemaining), groupKey: null };
  if (o.wholeAtOnce) {
    for (const g of groups) {
      const need = Math.min(g.minQty, g.remaining);
      if ((taken.get(g.key) ?? 0) < need) return { code: PACKAGE_INCOMPLETE, text: GROUP_TEXT.incomplete(g.name, o.typeName || GROUP_TEXT.voucher), groupKey: g.key };
    }
  }
  return null;
}
