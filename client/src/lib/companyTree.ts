/**
 * The tenant's company hierarchy, built from the flat `GET /companies` list.
 *
 * There is deliberately no tree endpoint: `parentCompanyId` rides along on the
 * ordinary company response and the shape is assembled here. That keeps one
 * request feeding the companies page, the scope selector and the breadcrumbs, and
 * it means a server that does not send the field yet degrades to the flat list
 * the dashboard has always shown.
 *
 * Three cases this has to survive, because all three occur in real tenants:
 *
 * * **No parents at all** — the common case today. `nested` is false and every
 *   company is a root at depth 0, so the caller renders a plain table with no
 *   indentation, no expanders, and nothing that hints at a broken tree.
 * * **A parent outside the visible set** — a company manager sees only their own
 *   company, whose parent is filtered out by role scoping; or the parent lives in
 *   another tenant. The child is kept, promoted to a root, and flagged
 *   `parentMissing` so the UI can say so. Dropping it would hide a company the
 *   caller is entitled to see.
 * * **A cycle** (A → B → A), which no valid data should contain but a bad edit
 *   can produce. The walk is bounded and the offending node becomes a root rather
 *   than hanging the browser.
 */
import type { Company, CompanyTree, CompanyTreeNode } from './types';

/** Indentation past this depth stops growing; the path label carries the rest. */
export const MAX_TREE_INDENT_DEPTH = 6;

function byName(a: CompanyTreeNode, b: CompanyTreeNode): number {
  return a.company.name.localeCompare(b.company.name, 'he-IL', { sensitivity: 'base' });
}

/**
 * Company ids are UUID strings from the API and are compared as-is elsewhere via
 * `sameId`; parent links are matched case-insensitively here for the same reason.
 */
function normalizeId(id: string | null | undefined): string | null {
  if (id == null) return null;
  const s = String(id).trim();
  return s === '' ? null : s.toLowerCase();
}

export function buildCompanyTree(companies: readonly Company[]): CompanyTree {
  const nodes = new Map<string, CompanyTreeNode>();
  for (const company of companies) {
    const key = normalizeId(company.id);
    if (!key) continue;
    nodes.set(key, { company, depth: 0, children: [], parentMissing: false });
  }

  const roots: CompanyTreeNode[] = [];
  let anyParentResolved = false;

  for (const node of nodes.values()) {
    const parentKey = normalizeId(node.company.parentCompanyId);
    if (!parentKey) {
      roots.push(node);
      continue;
    }
    const parent = parentKey === normalizeId(node.company.id) ? undefined : nodes.get(parentKey);
    if (!parent) {
      // Parent exists somewhere but not in what this caller can see. Keep the
      // company visible as a root and let the UI explain the orphaned link.
      node.parentMissing = true;
      roots.push(node);
      continue;
    }
    parent.children.push(node);
    anyParentResolved = true;
  }

  // A cycle leaves its members unreachable from any root. Detect that by walking
  // down from the roots and promoting whatever the walk never touched.
  const reached = new Set<CompanyTreeNode>();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (reached.has(node)) continue;
    reached.add(node);
    for (const child of node.children) stack.push(child);
  }
  for (const node of nodes.values()) {
    if (reached.has(node)) continue;
    node.parentMissing = true;
    node.children = node.children.filter((child) => !reached.has(child) && child !== node);
    roots.push(node);
    reached.add(node);
  }

  roots.sort(byName);

  const flat: CompanyTreeNode[] = [];
  const assign = (node: CompanyTreeNode, depth: number) => {
    node.depth = depth;
    flat.push(node);
    node.children.sort(byName);
    for (const child of node.children) assign(child, depth + 1);
  };
  for (const root of roots) assign(root, 0);

  const byId = new Map<string, CompanyTreeNode>();
  for (const node of flat) {
    byId.set(node.company.id, node);
    const key = normalizeId(node.company.id);
    if (key && key !== node.company.id) byId.set(key, node);
  }

  return { roots, flat, byId, nested: anyParentResolved };
}

/**
 * Root-first chain down to `companyId`, or an empty array when unknown.
 * Used by the breadcrumbs and by the "A ▸ B ▸ C" label in the scope selector.
 */
export function companyPath(tree: CompanyTree, companyId: string | null | undefined): Company[] {
  if (!companyId) return [];
  const start = tree.byId.get(companyId) ?? tree.byId.get(String(companyId).toLowerCase());
  if (!start) return [];

  // Walk up through the flat list's parent links, bounded by the node count so a
  // cycle that slipped through cannot spin here either.
  const parentOf = new Map<CompanyTreeNode, CompanyTreeNode>();
  for (const node of tree.flat) {
    for (const child of node.children) parentOf.set(child, node);
  }

  const chain: Company[] = [];
  let cursor: CompanyTreeNode | undefined = start;
  const guard = new Set<CompanyTreeNode>();
  while (cursor && !guard.has(cursor) && chain.length <= tree.flat.length) {
    guard.add(cursor);
    chain.unshift(cursor.company);
    cursor = parentOf.get(cursor);
  }
  return chain;
}

/** "A ▸ B ▸ C" — the company plus its ancestors, for a one-line trigger label. */
export function companyPathLabel(
  tree: CompanyTree,
  companyId: string | null | undefined,
  fallback: string,
): string {
  const path = companyPath(tree, companyId);
  if (path.length === 0) return fallback;
  return path.map((c) => c.name).join(' ▸ ');
}

/**
 * A company plus every company beneath it.
 *
 * Used for client-side filtering only — picking which shops the scope selector
 * offers, which machines a company's page lists. The server's own `companyId`
 * filters match one company exactly, so anything sent to the API stays a single
 * id and the UI says where the difference matters.
 */
export function companySubtreeIds(
  tree: CompanyTree,
  companyId: string | null | undefined,
): string[] {
  if (!companyId) return [];
  const start = tree.byId.get(companyId) ?? tree.byId.get(String(companyId).toLowerCase());
  if (!start) return [companyId];
  const ids: string[] = [];
  const stack = [start];
  const seen = new Set<CompanyTreeNode>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    ids.push(node.company.id);
    for (const child of node.children) stack.push(child);
  }
  return ids;
}

/** Direct children of a company, name-sorted. Empty for a leaf. */
export function companyChildren(
  tree: CompanyTree,
  companyId: string | null | undefined,
): Company[] {
  if (!companyId) return [];
  const node = tree.byId.get(companyId) ?? tree.byId.get(String(companyId).toLowerCase());
  return (node?.children ?? []).map((child) => child.company);
}
