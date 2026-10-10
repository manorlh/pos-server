/**
 * Every row a paged list matches, for an export (docs/SPEC_REPORTS.md §2).
 *
 * The owner's rule: an Excel export holds ALL the rows of the current filters, never just
 * the page on screen. A list with its own export endpoint (transactions, the Z table) is
 * read from it; any other paged list goes through here — page after page at the list's
 * largest page size, until `total` rows are in. A list longer than [max] is refused with a
 * message rather than cut short: a silently partial export reads as the whole.
 *
 * Pure over [fetchPage], so the paging rule is tested without a network.
 */

export interface Page<T> {
  items: T[];
  total: number;
}

export class TooManyRowsError extends Error {
  constructor(
    public readonly total: number,
    public readonly max: number,
  ) {
    super(`יותר מ-${max.toLocaleString('he-IL')} שורות (${total.toLocaleString('he-IL')}) — צמצמו את הסינון או את טווח התאריכים`);
    this.name = 'TooManyRowsError';
  }
}

export interface FetchAllOptions {
  /** Rows per request: the list's largest page size. */
  pageSize?: number;
  /** The most rows an export takes; more is refused (TooManyRowsError). */
  max?: number;
}

export const EXPORT_PAGE_SIZE = 200;
export const EXPORT_MAX_ROWS = 50_000;

export async function fetchAllPages<T>(
  fetchPage: (page: number, pageSize: number) => Promise<Page<T>>,
  { pageSize = EXPORT_PAGE_SIZE, max = EXPORT_MAX_ROWS }: FetchAllOptions = {},
): Promise<T[]> {
  const first = await fetchPage(1, pageSize);
  if (first.total > max) throw new TooManyRowsError(first.total, max);
  const rows = [...first.items];
  const pages = Math.ceil(first.total / pageSize);
  for (let page = 2; page <= pages; page += 1) {
    const next = await fetchPage(page, pageSize);
    rows.push(...next.items);
    // A list that shrank while we read it ends where it ends.
    if (next.items.length < pageSize) break;
  }
  return rows;
}
