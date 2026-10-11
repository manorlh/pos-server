/**
 * "תהליך פריט עם תוספות והערות" (kiosk config `motion.itemFlow`; the server's kiosk_config MOTION_ITEM_FLOWS — the
 * native kiosk implements the same contract):
 *
 *  - `sheet` (the default, and any value this build does not know): today's one window / screen with every add-on
 *    group and the notes;
 *  - `pages` ("דף אחר דף"): a dish with add-on groups and / or note chips opens page after page — one page per
 *    modifier group the dish actually has (with something to choose), in the group order; a required group's minimum
 *    before "הבא"; then one notes page, only when the dish has note chips; the last page adds the dish and the
 *    customer is back on the menu. A dish with neither keeps today's window.
 *
 * And the pictures the pages show: an option's (`imageUrl` of the menu's options — its own, else its linked
 * product's, as the cloud sends it) and a note chip's (`imageUrl` of `menu.notes` — such a note is an image tile,
 * chosen like an option).
 *
 * Pure; no imports (the node tests compile it on its own).
 */

export type ItemFlow = 'sheet' | 'pages';

/** The flow a kiosk config asks for: `pages` only when it says so. */
export function itemFlowOf(cfg: { motion?: { itemFlow?: unknown } | null } | null | undefined): ItemFlow {
  return cfg?.motion?.itemFlow === 'pages' ? 'pages' : 'sheet';
}

/** One page of the flow: a modifier group (by its place among the dish's groups), or the notes. */
export type ItemPage = { kind: 'group'; groupId: string; groupIndex: number } | { kind: 'notes' };

/**
 * The pages of a dish, in order: each of its groups that has an option to choose (a group with none is never a page
 * of its own — the kiosks drop those already), then the notes page when it has note chips. Empty: nothing to page
 * through (today's window).
 */
export function itemFlowPages(
  groups: ReadonlyArray<{ id: string; options: ReadonlyArray<unknown> }>,
  notes: ReadonlyArray<unknown> | null | undefined,
): ItemPage[] {
  const pages: ItemPage[] = [];
  groups.forEach((g, groupIndex) => {
    if (g.options.length > 0) pages.push({ kind: 'group', groupId: g.id, groupIndex });
  });
  if ((notes ?? []).length > 0) pages.push({ kind: 'notes' });
  return pages;
}

/** Page after page for this dish: the config asks for it and the dish has something to page through. */
export function usesItemPages(flow: ItemFlow, pages: ReadonlyArray<ItemPage>): boolean {
  return flow === 'pages' && pages.length > 0;
}

/**
 * Where "הבא" goes from page `at`: the next page, or `add` on the last one. A group page whose minimum is not met
 * stays (`stay`) — `lacking(groupId)` says so.
 */
export function nextFromPage(pages: ReadonlyArray<ItemPage>, at: number, lacking: (groupId: string) => boolean): number | 'add' | 'stay' {
  const page = pages[at];
  if (page && page.kind === 'group' && lacking(page.groupId)) return 'stay';
  return at + 1 >= pages.length ? 'add' : at + 1;
}

/** "הקודם" from page `at`: the previous page, or `close` from the first (back to the menu, nothing added). */
export function backFromPage(at: number): number | 'close' {
  return at <= 0 ? 'close' : at - 1;
}

/** The first group page that is not answered yet (its index among the pages), else null. */
export function firstLackingPage(pages: ReadonlyArray<ItemPage>, lacking: (groupId: string) => boolean): number | null {
  const i = pages.findIndex((p) => p.kind === 'group' && lacking(p.groupId));
  return i >= 0 ? i : null;
}

type Row = Record<string, unknown>;

const url = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The note chips' pictures of a menu block's `notes` (every dish's, the categories', the products'): text → picture. */
export function noteImagesOf(notes: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (chips: unknown) => {
    if (!Array.isArray(chips)) return;
    for (const c of chips) {
      if (!c || typeof c !== 'object') continue;
      const text = url((c as Row).text);
      const pic = url((c as Row).imageUrl);
      if (text && pic && !(text in out)) out[text] = pic;
    }
  };
  if (!notes || typeof notes !== 'object') return out;
  const n = notes as Row;
  for (const kind of ['products', 'categories'] as const) {
    const byId = n[kind];
    if (byId && typeof byId === 'object') for (const chips of Object.values(byId as Row)) take(chips);
  }
  take(n.all);
  return out;
}

/** The options' pictures of a menu block's `groups`: option id → picture (its own, else its linked product's). */
export function optionImagesOf(groups: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(groups)) return out;
  for (const g of groups) {
    const options = g && typeof g === 'object' ? (g as Row).options : null;
    if (!Array.isArray(options)) continue;
    for (const o of options) {
      if (!o || typeof o !== 'object') continue;
      const id = url((o as Row).id);
      const pic = url((o as Row).imageUrl);
      if (id && pic) out[id] = pic;
    }
  }
  return out;
}
