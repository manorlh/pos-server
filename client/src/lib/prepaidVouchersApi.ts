/**
 * Prepaid vouchers ("שוברי הפקה", `/prepaid-vouchers`): batches of vouchers worth goods,
 * handed to an event's production team and redeemed at the tills by QR.
 *
 * Unrelated to `/vouchers` (gift-voucher templates) and to item tickets.
 */
import { api } from './api';

export type PrepaidVoucherStatus = 'active' | 'partially_used' | 'used' | 'cancelled';

export interface PrepaidBatchItem {
  productId: string;
  name: string;
  quantity: number;
}

export interface PrepaidBatchStats {
  total: number;
  active: number;
  partiallyUsed: number;
  used: number;
  cancelled: number;
}

export interface PrepaidVoucherBatch {
  id: string;
  name: string;
  eventName: string | null;
  logoUrl: string | null;
  freeText: string | null;
  validFrom: string | null;
  validUntil: string | null;
  splitAllowed: boolean;
  status: 'active' | 'cancelled';
  companyId: string;
  companyName: string | null;
  shopIds: string[] | null;
  shops: { id: string; name: string | null }[];
  items: PrepaidBatchItem[];
  stats: PrepaidBatchStats;
  createdAt: string | null;
  cancelledAt: string | null;
}

export interface PrepaidVoucherItem extends PrepaidBatchItem {
  remaining: number;
}

export interface PrepaidRedemptionLine {
  productId: string;
  name: string | null;
  quantity: number;
}

export interface PrepaidRedemption {
  id: string;
  redeemedAt: string | null;
  machineId: string | null;
  machineName: string | null;
  shopId: string | null;
  posUserId: string | null;
  posUserName: string | null;
  transactionId: string | null;
  items: PrepaidRedemptionLine[];
  forfeited: PrepaidRedemptionLine[];
  /** Set when the till gave it back (its payment was abandoned): the goods returned to the voucher. */
  reversedAt?: string | null;
}

export interface PrepaidVoucher {
  id: string;
  batchId: string;
  serial: number;
  code: string;
  displayCode: string;
  qrPayload: string;
  status: PrepaidVoucherStatus;
  /** Free text from the dashboard; the till's lookup shows it too. */
  note?: string | null;
  items: PrepaidVoucherItem[];
  firstRedeemedAt: string | null;
  lastRedeemedAt: string | null;
  cancelledAt: string | null;
  redemptions?: PrepaidRedemption[];
}

export interface PrepaidBatchCreate {
  name: string;
  companyId: string;
  shopIds: string[] | null;
  eventName: string | null;
  logoUrl: string | null;
  freeText: string | null;
  validFrom: string | null;
  validUntil: string | null;
  splitAllowed: boolean;
  items: { productId: string; quantity: number }[];
  count: number;
}

/** A catalog product as the item picker needs it (`GET /products`, global level). */
export interface PrepaidProductOption {
  id: string;
  name: string;
  price: number;
  sku?: string | null;
}

export async function fetchPrepaidBatches(): Promise<PrepaidVoucherBatch[]> {
  const { data } = await api.get<{ items: PrepaidVoucherBatch[] }>('/prepaid-vouchers/batches');
  return data.items ?? [];
}

export async function fetchPrepaidBatch(id: string): Promise<PrepaidVoucherBatch> {
  const { data } = await api.get<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}`);
  return data;
}

export async function createPrepaidBatch(body: PrepaidBatchCreate): Promise<PrepaidVoucherBatch> {
  const { data } = await api.post<PrepaidVoucherBatch>('/prepaid-vouchers/batches', body);
  return data;
}

export async function updatePrepaidBatch(
  id: string,
  body: Partial<Pick<PrepaidBatchCreate, 'name' | 'eventName' | 'logoUrl' | 'freeText' | 'validFrom' | 'validUntil'>>,
): Promise<PrepaidVoucherBatch> {
  const { data } = await api.patch<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}`, body);
  return data;
}

export async function addPrepaidVouchers(id: string, count: number): Promise<PrepaidVoucherBatch> {
  const { data } = await api.post<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}/vouchers`, { count });
  return data;
}

export async function cancelPrepaidBatch(id: string): Promise<PrepaidVoucherBatch> {
  const { data } = await api.post<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}/cancel`);
  return data;
}

export async function fetchPrepaidVouchers(
  batchId: string,
  params: { status?: PrepaidVoucherStatus; serial?: number; limit?: number; offset?: number } = {},
): Promise<{ total: number; items: PrepaidVoucher[] }> {
  const { data } = await api.get<{ total: number; items: PrepaidVoucher[] }>(
    `/prepaid-vouchers/batches/${batchId}/vouchers`,
    { params },
  );
  return data;
}

/** Every voucher of a batch, for printing / PDF (the server answers up to 5000 per page). */
export async function fetchAllPrepaidVouchers(batchId: string): Promise<PrepaidVoucher[]> {
  const out: PrepaidVoucher[] = [];
  for (let offset = 0; offset < 100_000; offset += 5000) {
    const page = await fetchPrepaidVouchers(batchId, { limit: 5000, offset });
    out.push(...page.items);
    if (page.items.length < 5000) break;
  }
  return out;
}

export async function fetchPrepaidVoucher(id: string): Promise<PrepaidVoucher> {
  const { data } = await api.get<PrepaidVoucher>(`/prepaid-vouchers/vouchers/${id}`);
  return data;
}

export async function cancelPrepaidVoucher(id: string): Promise<PrepaidVoucher> {
  const { data } = await api.post<PrepaidVoucher>(`/prepaid-vouchers/vouchers/${id}/cancel`);
  return data;
}

/** A voucher's free-text note; blank clears it. */
export async function setPrepaidVoucherNote(id: string, note: string | null): Promise<PrepaidVoucher> {
  const { data } = await api.put<PrepaidVoucher>(`/prepaid-vouchers/vouchers/${id}/note`, { note });
  return data;
}

// ── Report (`GET /prepaid-vouchers/batches/{id}/report`) ─────────────────────

export interface PrepaidReportCounts {
  redemptions: number;
  vouchers: number;
  units: number;
}

export interface PrepaidReportProduct {
  productId: string;
  name: string | null;
  perVoucher: number;
  /** perVoucher × vouchers issued; = taken + forfeited + outstanding + void. */
  issued: number;
  taken: number;
  /** Given up on one-time vouchers taken in part. */
  forfeited: number;
  /** Still on live vouchers. */
  outstanding: number;
  /** Left on cancelled vouchers. */
  void: number;
}

export interface PrepaidReportGroup extends PrepaidReportCounts {
  key: string | null;
  name: string | null;
  shopName?: string | null;
}

export interface PrepaidBatchReport {
  batchId: string;
  timezone: string;
  generatedAt: string;
  vouchers: PrepaidBatchStats;
  products: PrepaidReportProduct[];
  totals: PrepaidReportCounts;
  byHour: (PrepaidReportCounts & { hour: number })[];
  byDay: (PrepaidReportCounts & {
    date: string;
    products: { productId: string; name: string | null; quantity: number }[];
  })[];
  byShop: PrepaidReportGroup[];
  byTill: PrepaidReportGroup[];
  byEmployee: PrepaidReportGroup[];
}

export async function fetchPrepaidBatchReport(batchId: string): Promise<PrepaidBatchReport> {
  const { data } = await api.get<PrepaidBatchReport>(`/prepaid-vouchers/batches/${batchId}/report`);
  return data;
}

export async function searchPrepaidProducts(search: string, companyId?: string): Promise<PrepaidProductOption[]> {
  const { data } = await api.get<{ items: Record<string, unknown>[] }>('/products', {
    params: {
      page: 1,
      pageSize: 50,
      catalogLevel: 'global',
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(companyId ? { companyId } : {}),
    },
  });
  return (data.items ?? [])
    .filter((p) => !p.isGeneral && !p.is_general && !p.isWeighed && !p.is_weighed)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name ?? ''),
      price: Number(p.price ?? 0),
      sku: (p.sku as string | null | undefined) ?? null,
    }));
}

/**
 * The vouchers as a file drawn on the server (`GET /prepaid-vouchers/batches/{id}/file`):
 * `pdf` — one PDF; `zip` — a PDF per voucher. Downloaded as `fileName`.
 * Used vouchers are left out, as in printing; `voucherId` narrows it to one.
 */
export async function downloadPrepaidVouchersFile(
  batchId: string,
  opts: {
    format: 'pdf' | 'zip';
    layout: string;
    width?: number;
    height?: number;
    voucherId?: string;
    fileName: string;
  },
): Promise<void> {
  const { data } = await api.get<Blob>(`/prepaid-vouchers/batches/${batchId}/file`, {
    params: {
      format: opts.format,
      layout: opts.layout,
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
      ...(opts.voucherId ? { voucherId: opts.voucherId, includeUsed: true } : { includeUsed: false }),
    },
    responseType: 'blob',
    timeout: 300_000,
  });
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
