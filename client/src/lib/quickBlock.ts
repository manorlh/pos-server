/**
 * "חסימה מהירה" on the phone (P:/specs/item-block-control.md §4; pos-server app/routers/item_blocks.py
 * `/item-blocks/quick`): the page's rows as a tap changes them, and what the full form ("חסום / אזל")
 * takes from the shop's `quickDefaults`. The types and the Hebrew of the states: lib/itemBlockControl.ts.
 *
 * Kept free of React and Next so it can be tested on its own (quickBlock.test.ts).
 */
import { BLOCK_CHANNELS, formatUntil, orderedChannels, type BlockChannel, type DurationChoice } from './liveControl';
import {
  quickLeftovers,
  type QuickBlockRow,
  type QuickDefaults,
  type QuickDuration,
  type QuickItem,
  type QuickList,
  type QuickState,
} from './itemBlockControl';
import { SCOPE_PARAM } from './tenantSwitch';

export const QUICK_BLOCK_PATH = '/dashboard/stock/quick-block';

// ── The full form's defaults ──────────────────────────────────────────────────

/** The full form's "משך" from the quick one: "עד סוף היום" when it says nothing usable. */
export function durationOfQuick(d: QuickDuration | null | undefined): DurationChoice {
  if (d?.mode === 'none') return { mode: 'none' };
  if (d?.mode === 'minutes' && d.minutes != null && d.minutes >= 1) return { mode: 'minutes', minutes: d.minutes };
  return { mode: 'end_of_day' };
}

/** The full form's "איפה": "קיוסק" alone for a kiosk, else the quick channels (all four when there are none). */
export function sheetChannels(q: Pick<QuickDefaults, 'channels'> | null | undefined, deviceIsKiosk: boolean): BlockChannel[] {
  if (deviceIsKiosk) return ['kiosk'];
  const list = orderedChannels(q?.channels ?? []);
  return list.length ? list : [...BLOCK_CHANNELS];
}

/** The full form's "רמה": the company when the quick level is the company and the form offers it, else the shop. */
export function sheetLevel(q: Pick<QuickDefaults, 'level'> | null | undefined, companyOffered: boolean): 'company' | 'shop' {
  return q?.level === 'company' && companyOffered ? 'company' : 'shop';
}

// ── The page's rows ───────────────────────────────────────────────────────────

/** The state the blocks make on the quick channels: "חסום" over "אזל" over "זמין" (as the server decides it). */
function stateOf(blocks: readonly QuickBlockRow[], channels: readonly BlockChannel[]): { state: QuickState; deciding: QuickBlockRow | null } {
  const here = blocks.filter((b) => b.channels.some((c) => channels.includes(c)));
  const state: QuickState = here.some((b) => b.kind === 'blocked') ? 'blocked' : here.length ? 'sold_out' : 'available';
  return { state, deciding: here.find((b) => b.kind === state) ?? null };
}

/**
 * A tap's row at once, before the server answers. "זמין" lifts what the quick block lifts — what
 * `quickLeftovers` names stays, and may still keep the product "אזל" / "חסום". "אזל" / "חסום" shows the
 * new state; its end and scope come with the answer.
 */
export function optimisticQuickItem(item: QuickItem, next: QuickState, quick: Pick<QuickDefaults, 'channels' | 'level'>): QuickItem {
  if (next !== 'available') return { ...item, state: next, until: null, scopeLevel: null, scopeName: null };
  const blocks = quickLeftovers(item, quick);
  const { state, deciding } = stateOf(blocks, quick.channels);
  return {
    ...item,
    state,
    blocks,
    until: deciding?.until ?? null,
    scopeLevel: deciding?.level ?? null,
    scopeName: deciding?.scopeName ?? null,
  };
}

/** The list with the product's row replaced (and the quick defaults the server answered with). */
export function replaceQuickItem(list: QuickList | undefined, item: QuickItem, quickDefaults?: QuickDefaults): QuickList | undefined {
  if (!list) return list;
  if (!list.items.some((r) => r.productId === item.productId)) return quickDefaults ? { ...list, quickDefaults } : list;
  return {
    ...list,
    quickDefaults: quickDefaults ?? list.quickDefaults,
    items: list.items.map((r) => (r.productId === item.productId ? item : r)),
  };
}

/** "עד 14:35" / "עד מחר 04:00" / "עד ביטול" under a blocked or sold-out product; null when it is available. */
export function quickUntilText(item: Pick<QuickItem, 'state' | 'until'>, nowMs: number, timeZone?: string): string | null {
  if (item.state === 'available') return null;
  const at = formatUntil(item.until, nowMs, timeZone);
  return at ? `עד ${at}` : 'עד ביטול';
}

/**
 * Why some blocks stay after "זמין" (`quickLeftovers`): "חסימת מחלקה", "ערוצים נוספים", "חסימת החברה" —
 * each once, in this order.
 */
export function leftoverReasons(rows: readonly QuickBlockRow[], quick: Pick<QuickDefaults, 'channels' | 'level'>): string[] {
  const set = new Set(quick.channels);
  const category = rows.some((b) => b.itemType === 'category');
  const channels = rows.some((b) => b.itemType !== 'category' && !b.channels.every((c) => set.has(c)));
  const company = rows.some((b) => b.level === 'company' && quick.level !== 'company');
  return [category && 'חסימת מחלקה', channels && 'ערוצים נוספים', company && 'חסימת החברה'].filter((x): x is string => !!x);
}

/** What a tap ends in, when it is not what was tapped: the toast's words. Null when it is. */
export function tapOutcomeNote(asked: QuickState, got: QuickItem | null): string | null {
  if (!got || got.state === asked) return null;
  return asked === 'available'
    ? `${got.name}: נשארה חסימה שלא משתחררת מכאן — "התאמה" לפרטים`
    : `${got.name}: חסימה אחרת עדיין קובעת — "התאמה" לפרטים`;
}

// ── Links ─────────────────────────────────────────────────────────────────────

/**
 * A page's link that keeps the scope (`useScopeQuery`'s "?company=…&shop=…"), with the shop a form
 * picked on its own when the scope names none, and the page's own params (`tab`).
 */
export function scopedHref(
  path: string,
  scopeQuery: string,
  opts: { shop?: { id: string; companyId?: string | null } | null; params?: Record<string, string> } = {},
): string {
  const params = new URLSearchParams(scopeQuery.replace(/^\?/, ''));
  const shop = opts.shop;
  if (shop && !params.get(SCOPE_PARAM.shop)) {
    params.set(SCOPE_PARAM.shop, shop.id);
    if (shop.companyId) params.set(SCOPE_PARAM.company, shop.companyId);
    params.delete(SCOPE_PARAM.machine);
  }
  for (const [k, v] of Object.entries(opts.params ?? {})) params.set(k, v);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
