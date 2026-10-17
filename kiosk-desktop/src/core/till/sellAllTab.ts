/**
 * "הכל" in the order's catalog — the Android till's rule (pos-android domain/SellAllTab.kt, the owner 14.10: "אפשר
 * להסתיר אותה או לשנות את הסדר"): the till parameter `sellAllTab` — `first`, `last` or `hidden`. Hidden is the default:
 * unset (a cloud too old to send it) or anything unknown is `hidden`, and the order opens on the first category. One rule
 * for every category bar of the order (the clean pills, the designed chips, rail and two rows).
 */

export const PARAM_SELL_ALL_TAB = 'sellAllTab';

export type SellAllTab = 'first' | 'last' | 'hidden';

/** The parameter as the cloud sends it; unset or anything else is `hidden`, the default. */
export function parseSellAllTab(raw: unknown): SellAllTab {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'first' || v === 'last' ? v : 'hidden';
}

/** A category bar: its tabs in order (a category's id, null for "הכל") and the category on screen (null: every product). */
export interface CategoryBar {
  tabs: Array<string | null>;
  selected: string | null;
}

/**
 * The bar of the `shown` categories under `mode`, and the category on screen given the cashier's `picked` one (null:
 * "הכל"). `chosen`: `picked` was tapped under this mode; false — the order is opening — and the mode's opening rule holds.
 * `known`: every category the catalog has (a pick of one the bar does not show stands; only one gone falls back).
 *
 *  - first: "הכל", then the categories; the pick as it is (null when opening);
 *  - last: the categories, then "הכל"; opens on the first category; "הכל" tapped stays;
 *  - hidden: the categories only; opens on the first; no categories at all — null, every product.
 */
export function categoryBarOf(mode: SellAllTab, shown: readonly string[], picked: string | null, chosen: boolean, known: readonly string[] = shown): CategoryBar {
  const tabs: Array<string | null> = mode === 'first' ? [null, ...shown] : mode === 'last' ? [...shown, null] : [...shown];
  let selected: string | null;
  if (mode === 'first') selected = picked;
  else if (!chosen) selected = shown[0] ?? null;
  else if (picked === null) selected = null;
  else if (shown.includes(picked) || known.includes(picked)) selected = picked;
  else selected = shown[0] ?? null;
  return { tabs, selected };
}
