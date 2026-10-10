/**
 * The category tree for the dashboard's "קטגוריית אב" select (app/dashboard/categories/page.tsx): which categories a
 * category may sit under, and how they read ("אוכל › מנות"). The cloud keeps the rule (pos-server routers/categories.py
 * `_check_parent`: an existing category of the same tenant, never the category itself or anything beneath it);
 * this is the same rule on the screen, so the select never offers what the server would refuse.
 *
 * Self-contained, so `npm test` compiles it alone.
 */

/** A category row as far as the tree goes. */
export interface CategoryNode {
  id: string;
  name: string;
  parentId?: string | null;
}

/** How deep a tree is followed: a guard against a loop in bad data. */
const MAX_DEPTH = 64;

/** The separator of a path ("אוכל › מנות"); written for a right-to-left reader, the parent first. */
export const PATH_SEPARATOR = ' › ';

function childrenOf(categories: readonly CategoryNode[]): Map<string, CategoryNode[]> {
  const out = new Map<string, CategoryNode[]>();
  for (const c of categories) {
    if (c.parentId == null || c.parentId === c.id) continue;
    const list = out.get(c.parentId) ?? [];
    list.push(c);
    out.set(c.parentId, list);
  }
  return out;
}

/** The ids of everything beneath `id` — its children, theirs, and so on — not `id` itself. A loop in the data is walked once. */
export function descendantIds(categories: readonly CategoryNode[], id: string): Set<string> {
  const children = childrenOf(categories);
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop()!;
    for (const child of children.get(next) ?? []) {
      if (child.id === id || out.has(child.id)) continue;
      out.add(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

/** Whether making `parentId` the parent of `id` would close a loop: `id` itself, or something beneath it. */
export function wouldCycle(categories: readonly CategoryNode[], id: string, parentId: string): boolean {
  return parentId === id || descendantIds(categories, id).has(parentId);
}

/** "אוכל › מנות": the names from the top category down to `id`. An unknown id: its own text; a loop ends the walk. */
export function categoryPath(categories: readonly CategoryNode[], id: string): string {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = id;
  while (cur != null && !seen.has(cur) && names.length < MAX_DEPTH) {
    const row = byId.get(cur);
    if (!row) break;
    seen.add(cur);
    names.unshift(row.name);
    cur = row.parentId;
  }
  return names.join(PATH_SEPARATOR);
}

export interface ParentOption {
  id: string;
  /** How deep it sits: 0 for a top category. */
  depth: number;
  /** Its path, "אוכל › מנות". */
  label: string;
}

/**
 * The categories `editingId` may be filed under, as a tree in the order given (each category, then what is beneath it):
 * never `editingId` itself or anything beneath it. A new category (`editingId` absent) may sit under any. A category
 * whose parent is not in the list is a top one; whatever a loop in the data leaves out of the walk follows at the end,
 * so nothing disappears.
 */
export function parentOptions(categories: readonly CategoryNode[], editingId?: string | null): ParentOption[] {
  const banned = editingId ? new Set([editingId, ...descendantIds(categories, editingId)]) : new Set<string>();
  const known = new Set(categories.map((c) => c.id));
  const children = childrenOf(categories);
  const out: ParentOption[] = [];
  const placed = new Set<string>();

  const place = (c: CategoryNode, depth: number, path: string) => {
    if (placed.has(c.id) || depth > MAX_DEPTH) return;
    placed.add(c.id);
    const label = path ? `${path}${PATH_SEPARATOR}${c.name}` : c.name;
    if (!banned.has(c.id)) out.push({ id: c.id, depth, label });
    for (const child of children.get(c.id) ?? []) place(child, depth + 1, label);
  };

  for (const c of categories) {
    const top = c.parentId == null || c.parentId === c.id || !known.has(c.parentId);
    if (top) place(c, 0, '');
  }
  // A loop in the data has no top: still shown (by its path as far as it goes) rather than lost.
  for (const c of categories) if (!placed.has(c.id)) place(c, 0, '');
  return out;
}
