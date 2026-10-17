/**
 * "הערה בקיוסק" per dish (owner 17.10, "הערות זה פר פריט"; pos-server app/services/kiosk_notes.py): the kiosk
 * offers a note on a dish — the free "הוספת הערה" field and the quick-note chips — only where the dish allows
 * it: its own `kioskNotes` (true / false), else its category's, else the parent categories', up the tree;
 * nothing set anywhere — no note. The kiosk's own switches stay the masters (`general.notesEnabled` for the
 * field, `general.quickNotesEnabled` for the chips): a dish shows a note only where both say yes.
 *
 * The values reach the kiosks in the menu block (`kioskNotes`: `categories` / `products`, id → bool, the
 * explicit ones only). A menu without it (an older cloud) offers notes as before. The Android kiosk's
 * Menu.kioskNotesAllowed is the same rule; the shared golden server/tests/fixtures/kiosk_notes_golden.json.
 * Self-contained, so `npm test` compiles it alone.
 */

/** Nothing set on the dish or up its category tree: no note. */
export const KIOSK_NOTES_DEFAULT = false;

/** The menu block's `kioskNotes`. */
export interface KioskNotesBlock {
  categories?: Record<string, unknown>;
  products?: Record<string, unknown>;
}

const isDict = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The dish ([productIds] — any of its ids) offers a note under the menu's `kioskNotes` ([block]). */
export function kioskNotesAllowed(
  block: unknown,
  productIds: readonly string[],
  categoryId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (!isDict(block)) return true; // An older cloud: notes as before (the kiosk's switches decide).
  const products = isDict(block.products) ? block.products : {};
  const categories = isDict(block.categories) ? block.categories : {};
  for (const id of productIds) {
    const own = products[id];
    if (typeof own === 'boolean') return own;
  }
  const seen = new Set<string>();
  let current = categoryId ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const v = categories[current];
    if (typeof v === 'boolean') return v;
    current = parentOf(current) ?? null;
  }
  return KIOSK_NOTES_DEFAULT;
}

/** A dish as the screens hold it: `notesAllowed` from the catalog (absent — the preview's samples: allowed). */
export interface NotesDish {
  notesAllowed?: boolean;
}

interface NotesGeneral {
  general: { notesEnabled: boolean; quickNotesEnabled: boolean };
}

/** The free "הוספת הערה" field on this dish: the kiosk's switch and the dish's own say. */
export function dishNoteFieldOn(cfg: NotesGeneral, p: NotesDish): boolean {
  return !!cfg.general.notesEnabled && p.notesAllowed !== false;
}

/**
 * The dish offers a note at this kiosk, so a tap opens its window (lib/kioskLayout.ts tapPathOf `notesOn`): the
 * field, or chips it has. Only a dish the catalog said allows notes (absent — the preview's samples: no).
 */
export function dishNotesOpen(cfg: NotesGeneral, p: NotesDish, quickNotes: number): boolean {
  if (p.notesAllowed !== true) return false;
  return !!cfg.general.notesEnabled || (!!cfg.general.quickNotesEnabled && quickNotes > 0);
}

/** The quick-note chips on this dish: the kiosk's switch and the dish's own say. */
export function dishQuickNotesOn(cfg: NotesGeneral, p: NotesDish): boolean {
  return !!cfg.general.quickNotesEnabled && p.notesAllowed !== false;
}
