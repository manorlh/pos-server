/**
 * The catalog import preview's arithmetic ("ייבוא פריטים מאקסל"): which row tabs to show,
 * whether there is anything to import, and the lines of the confirm dialog and the result
 * — as message keys with counts, so the page only translates them.
 *
 * Pure and dependency-free (structural types only), so `npm test` runs it under node.
 * The server's shapes: pos-server app/services/catalog_import.py `summary` / `ApplyResult`.
 */

export type ImportTab = 'products' | 'categories' | 'groups' | 'options' | 'notes';

/** The counts of the preview's summary this file reads (a subset of `ImportSummary`). */
export interface SummaryCounts {
  productsNew: number;
  productsUpdated: number;
  categoriesNew: number;
  categoriesUpdated: number;
  routingChanges: number;
  routingShops: number;
  groupsNew?: number;
  groupsUpdated?: number;
  optionsNew?: number;
  optionsUpdated?: number;
  notesNew?: number;
  notesUpdated?: number;
  linkChanges?: number;
  imageChanges?: number;
  menuPriceChanges?: number;
}

/** The counts of a commit's result this file reads (a subset of `ImportResult`). */
export interface ResultCounts {
  productsCreated: number;
  productsUpdated: number;
  categoriesCreated: number;
  categoriesUpdated: number;
  routingChanges: number;
  costsUpdated: number;
  skippedErrorRows: number;
  groupsCreated?: number;
  groupsUpdated?: number;
  optionsCreated?: number;
  optionsUpdated?: number;
  linksChanged?: number;
  notesCreated?: number;
  notesUpdated?: number;
  imagesStored?: number;
  imagesRemoved?: number;
  menuPricesChanged?: number;
}

export interface CountLine {
  /** The message key under the page's namespace (`commit.*` / `result.*`). */
  key: string;
  count: number;
  /** Extra message values (the routing line's shops). */
  values?: Record<string, number>;
}

interface PreviewRowsLike {
  products: unknown[];
  categories: unknown[];
  groups?: unknown[];
  options?: unknown[];
  notes?: unknown[];
}

/** The tabs of the preview's rows: products and categories always, the others when the file has them. */
export function previewTabs(preview: PreviewRowsLike): { id: ImportTab; count: number }[] {
  const tabs: { id: ImportTab; count: number }[] = [
    { id: 'products', count: preview.products.length },
    { id: 'categories', count: preview.categories.length },
  ];
  for (const id of ['groups', 'options', 'notes'] as const) {
    const rows = preview[id] ?? [];
    if (rows.length > 0) tabs.push({ id, count: rows.length });
  }
  return tabs;
}

/** The tab to open first: the first one with rows (products when nothing has). */
export function firstTab(preview: PreviewRowsLike): ImportTab {
  return previewTabs(preview).find((tab) => tab.count > 0)?.id ?? 'products';
}

const n = (value: number | undefined): number => value ?? 0;

/** How many things the import would create or change. */
export function actionableCount(s: SummaryCounts): number {
  return (
    s.productsNew + s.productsUpdated + s.categoriesNew + s.categoriesUpdated + s.routingChanges +
    n(s.groupsNew) + n(s.groupsUpdated) + n(s.optionsNew) + n(s.optionsUpdated) + n(s.notesNew) +
    n(s.notesUpdated) + n(s.linkChanges) + n(s.imageChanges) + n(s.menuPriceChanges)
  );
}

/** The confirm dialog's lines, in order; `rowErrors` adds the "rows skipped" line. */
export function confirmLines(s: SummaryCounts, rowErrors = 0): CountLine[] {
  const lines: CountLine[] = [];
  const add = (key: string, count: number | undefined, values?: Record<string, number>) => {
    if (count) lines.push(values ? { key, count, values } : { key, count });
  };
  add('confirmCreate', s.productsNew);
  add('confirmUpdate', s.productsUpdated);
  add('confirmCategories', s.categoriesNew);
  add('confirmCategoriesUpdated', s.categoriesUpdated);
  add('confirmGroups', s.groupsNew);
  add('confirmGroupsUpdated', s.groupsUpdated);
  add('confirmOptions', s.optionsNew);
  add('confirmOptionsUpdated', s.optionsUpdated);
  add('confirmLinks', s.linkChanges);
  add('confirmNotes', s.notesNew);
  add('confirmNotesUpdated', s.notesUpdated);
  add('confirmImages', s.imageChanges);
  add('confirmMenuPrices', s.menuPriceChanges);
  add('confirmRouting', s.routingChanges, { shops: s.routingShops });
  add('confirmSkip', rowErrors);
  return lines;
}

/** The result's lines, in order. */
export function resultLines(r: ResultCounts): CountLine[] {
  const lines: CountLine[] = [];
  const add = (key: string, count: number | undefined) => {
    if (count) lines.push({ key, count });
  };
  add('productsCreated', r.productsCreated);
  add('productsUpdated', r.productsUpdated);
  add('categoriesCreated', r.categoriesCreated);
  add('categoriesUpdated', r.categoriesUpdated);
  add('groupsCreated', r.groupsCreated);
  add('groupsUpdated', r.groupsUpdated);
  add('optionsCreated', r.optionsCreated);
  add('optionsUpdated', r.optionsUpdated);
  add('linksChanged', r.linksChanged);
  add('notesCreated', r.notesCreated);
  add('notesUpdated', r.notesUpdated);
  add('imagesStored', r.imagesStored);
  add('imagesRemoved', r.imagesRemoved);
  add('menuPricesChanged', r.menuPricesChanged);
  add('routingChanges', r.routingChanges);
  add('costsUpdated', r.costsUpdated);
  add('skipped', r.skippedErrorRows);
  return lines;
}
