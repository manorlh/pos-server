/**
 * The server-built designed reports (P:\specs\reports-designed-pdf.md §7.3, §7.6): "סיכום יום"
 * v2 and "מכירות מוצרים לפי ימים" — the JSON each page shows and the PDF the server draws
 * from the same parameters.
 */
import axios from 'axios';
import { api } from './api';
import { daySummaryV2Query, isDaySummaryV2, type DaySummaryV2, type DaySummaryV2Params } from './daySummaryV2';
import { productsByDayQuery, type ProductsByDayParams, type ProductsByDayReport } from './productsByDay';

/** A blob error body as its `detail`, so the toast says what the server said. */
async function readBlobError(err: unknown): Promise<never> {
  if (axios.isAxiosError(err) && err.response?.data instanceof Blob) {
    try {
      const parsed = JSON.parse(await err.response.data.text()) as { detail?: unknown };
      if (typeof parsed.detail === 'string') err.response.data = { detail: parsed.detail };
    } catch {
      // Not JSON: the generic message.
    }
  }
  throw err;
}

/**
 * One business day (§7.3). A server that predates v2 answers with the old Z roll-up: that is
 * an error here (the page says the server is not updated yet), never a page of zeros.
 */
export async function fetchDaySummaryV2(params: DaySummaryV2Params): Promise<DaySummaryV2> {
  const { data } = await api.get<unknown>(`/reports/day-summary?${daySummaryV2Query(params)}`);
  if (!isDaySummaryV2(data)) throw new Error('day-summary-v1');
  return data;
}

export async function downloadDaySummaryPdf(params: DaySummaryV2Params): Promise<Blob> {
  try {
    const { data } = await api.get<Blob>(`/reports/day-summary/pdf?${daySummaryV2Query(params)}`, { responseType: 'blob' });
    return data;
  } catch (err) {
    return readBlobError(err);
  }
}

export async function fetchProductsByDay(params: ProductsByDayParams): Promise<ProductsByDayReport> {
  const { data } = await api.get<ProductsByDayReport>(`/reports/products-by-day?${productsByDayQuery(params)}`);
  return data;
}

export async function downloadProductsByDayPdf(params: ProductsByDayParams): Promise<Blob> {
  try {
    const { data } = await api.get<Blob>(`/reports/products-by-day/pdf?${productsByDayQuery(params)}`, { responseType: 'blob' });
    return data;
  } catch (err) {
    return readBlobError(err);
  }
}
