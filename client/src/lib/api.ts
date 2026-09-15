import axios from 'axios';
import { useAuth } from './auth';
import type {
  CashierSalesReport,
  DaySummaryReport,
  CategoryReorderEntry,
  CategoryReorderResponse,
  CloseDayCreateResponse,
  CloseDayRequest,
  Company,
  DashboardBreakdown,
  DashboardStats,
  BrandingImageKind,
  BrandingUploadResult,
  EntitySettingsResponse,
  PosMachine,
  PosSettingsPatch,
  ProductSalesReport,
  Shop,
  ShopSettingsResponse,
  StockLevel,
  TipsRangeReport,
  TipsReport,
  TaxOpenFormatPreview,
  ParentOptions,
  ZReport,
  ZReportListResponse,
} from './types';
import { normalizePosMachine } from './posMachine';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  headers: { 'Content-Type': 'application/json' },
});

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type CloudinaryUploadParams = {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
};

export type ImageUploadResult = {
  url: string;
  publicId: string;
};

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (typeof window === 'undefined') return headers;

  const clerk = (window as any).Clerk;
  if (clerk && !clerk.loaded) {
    await clerk.load?.();
  }
  const token = await clerk?.session?.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const fromStore = useAuth.getState().activeTenantId;
  const fromStorage = window.localStorage.getItem('activeTenantId');
  const activeTenantId = fromStore || fromStorage;
  if (activeTenantId) headers['X-Tenant-Id'] = activeTenantId;

  return headers;
}

function validateImageFile(file: File): void {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Unsupported file type. Use JPEG, PNG, WebP, or GIF.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('File exceeds 5 MB limit.');
  }
}

/** Fetch signed Cloudinary upload params from pos-server (api_secret never exposed). */
export async function fetchImageUploadParams(
  resource: 'products' | 'categories' = 'products',
): Promise<CloudinaryUploadParams> {
  const { data } = await api.get<CloudinaryUploadParams>('/images/upload-params', {
    params: { resource },
  });
  return data;
}

/** Signed direct upload to Cloudinary, then return secure_url for product.imageUrl. */
export async function uploadProductImage(
  file: File,
  resource: 'products' | 'categories' = 'products',
): Promise<ImageUploadResult> {
  validateImageFile(file);
  const params = await fetchImageUploadParams(resource);

  const form = new FormData();
  form.append('file', file);
  form.append('api_key', params.apiKey);
  form.append('timestamp', String(params.timestamp));
  form.append('signature', params.signature);
  form.append('folder', params.folder);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${params.cloudName}/image/upload`;
  const res = await fetch(uploadUrl, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Cloudinary upload failed (${res.status})`);
  }

  const result = (await res.json()) as { secure_url?: string; public_id?: string };
  if (!result.secure_url) {
    throw new Error('Cloudinary did not return a secure URL');
  }
  return { url: result.secure_url, publicId: result.public_id ?? '' };
}

/**
 * Branding images go through pos-server rather than straight to Cloudinary: the
 * size and dimension limits a POS terminal needs are enforced server-side, and a
 * signed direct upload would skip them. The returned URL is unique per upload,
 * so a replaced image never collides with a cached copy on the till.
 */
export async function uploadBrandingImage(
  file: File,
  kind: BrandingImageKind,
): Promise<BrandingUploadResult> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<BrandingUploadResult>('/images/branding', form, {
    params: { kind },
    // Let the browser set multipart/form-data with its own boundary.
    headers: { 'Content-Type': undefined },
  });
  return data;
}

/**
 * Take a dashboard user out of service. `DELETE /users/{id}` is a soft deactivate
 * — it flips `is_active` to false and returns 204 — so nothing is destroyed and
 * the documents the user touched keep pointing at a row that still exists.
 */
export async function deactivateUser(userId: string): Promise<void> {
  await api.delete(`/users/${userId}`);
}

/**
 * Choose your own till PIN.
 *
 * Yours, so it is usable immediately — nobody else knows it. Compare
 * `assignTillPin`, which always lands as temporary because the person setting it
 * is not the person it belongs to.
 */
export async function setMyTillPin(pin: string): Promise<void> {
  await api.put('/users/me/till-pin', { pin });
}

export async function clearMyTillPin(): Promise<void> {
  await api.delete('/users/me/till-pin');
}

/**
 * Issue somebody a temporary till PIN.
 *
 * Always temporary: the till makes them replace it before it authorises anything.
 * That is what keeps "Yossi approved this" honest — otherwise it would only ever
 * mean "somebody who knew the PIN typed into this form".
 */
export async function assignTillPin(userId: string, pin: string): Promise<void> {
  await api.post(`/users/${userId}/till-pin`, { pin });
}

/** Take away someone's ability to authorise anything at a till. */
export async function revokeTillPin(userId: string): Promise<void> {
  await api.delete(`/users/${userId}/till-pin`);
}

/**
 * The other half of the same switch. Same authority as deactivating: not
 * yourself, in scope, and strictly below your own role level.
 *
 * The 200 body is the refreshed user, but callers refetch the list rather than
 * trust it — `UserResponse` is still serialised snake_case (see the note in the
 * users page), so the shape would need normalising to be usable.
 */
export async function activateUser(userId: string): Promise<void> {
  await api.post(`/users/${userId}/activate`);
}

/**
 * The three lists the shared dashboard scope is built from.
 *
 * They keep the query keys the pages already used (`['companies']`, `['shops']`,
 * `['machines']`) on purpose: the scope bar and every page now read the same
 * cache entry, so making the scope global did not add a single extra request.
 */
export async function fetchCompanies(): Promise<Company[]> {
  const { data } = await api.get<Company[]>('/companies');
  return Array.isArray(data) ? data : [];
}

export async function fetchShops(companyId?: string): Promise<Shop[]> {
  const { data } = await api.get<Shop[]>('/shops', {
    params: companyId ? { companyId } : undefined,
  });
  return Array.isArray(data) ? data : [];
}

/** `GET /machines`, normalised — the raw rows mix camelCase and snake_case. */
export async function fetchMachines(): Promise<PosMachine[]> {
  const { data } = await api.get('/machines');
  const list = Array.isArray(data) ? data : [];
  return list.map((row: Record<string, unknown>) => normalizePosMachine(row));
}

/**
 * Persist a whole category order in one request.
 *
 * `PUT /categories/reorder` is atomic server-side, so the entire visible order
 * goes in a single body rather than one PUT per moved row: N requests would leave
 * the tills reading a half-applied order if any of them failed, and would fire a
 * catalog notification per row.
 */
export async function reorderCategories(
  order: CategoryReorderEntry[],
): Promise<CategoryReorderResponse> {
  const { data } = await api.put<CategoryReorderResponse>('/categories/reorder', { order });
  return data;
}

export async function fetchTenantSettings(tenantId: string): Promise<EntitySettingsResponse> {
  const { data } = await api.get<EntitySettingsResponse>(`/tenants/${tenantId}/settings`);
  return data;
}

export async function patchTenantSettings(
  tenantId: string,
  patch: PosSettingsPatch,
): Promise<EntitySettingsResponse> {
  const { data } = await api.patch<EntitySettingsResponse>(`/tenants/${tenantId}/settings`, patch);
  return data;
}

export async function fetchCompanySettings(companyId: string): Promise<EntitySettingsResponse> {
  const { data } = await api.get<EntitySettingsResponse>(`/companies/${companyId}/settings`);
  return data;
}

export async function patchCompanySettings(
  companyId: string,
  patch: PosSettingsPatch,
): Promise<EntitySettingsResponse> {
  const { data } = await api.patch<EntitySettingsResponse>(`/companies/${companyId}/settings`, patch);
  return data;
}

export async function fetchShopSettings(
  shopId: string,
  includeEffective = true,
): Promise<ShopSettingsResponse> {
  const { data } = await api.get<ShopSettingsResponse>(`/shops/${shopId}/settings`, {
    params: includeEffective ? { includeEffective: true } : undefined,
  });
  return data;
}

export async function patchShopSettings(
  shopId: string,
  patch: PosSettingsPatch,
): Promise<ShopSettingsResponse> {
  const { data } = await api.patch<ShopSettingsResponse>(`/shops/${shopId}/settings`, patch);
  return data;
}

export async function fetchShopStock(shopId: string): Promise<StockLevel[]> {
  const { data } = await api.get<StockLevel[]>(`/shops/${shopId}/stock`);
  return data;
}

export async function postGoodsReceipt(
  shopId: string,
  body: { productId: string; quantity: number; note?: string },
): Promise<StockLevel> {
  const { data } = await api.post<StockLevel>(`/shops/${shopId}/stock/goods-receipt`, body);
  return data;
}

export async function postStockAdjustment(
  shopId: string,
  body: { productId: string; delta: number; note?: string },
): Promise<StockLevel> {
  const { data } = await api.post<StockLevel>(`/shops/${shopId}/stock/adjustment`, body);
  return data;
}

export async function postStocktake(
  shopId: string,
  body: { productId: string; quantity: number; note?: string },
): Promise<StockLevel> {
  const { data } = await api.post<StockLevel>(`/shops/${shopId}/stock/stocktake`, body);
  return data;
}

export async function fetchTipsReport(
  shopId: string,
  params: { from?: string; to?: string; tradingDayId?: string },
): Promise<TipsReport> {
  const { data } = await api.get<TipsReport>(`/shops/${shopId}/tips/report`, { params });
  return data;
}

/**
 * Query params shared by GET /reports/products, /reports/cashiers, /reports/tips.
 *
 * `from`/`to` are calendar days; `fromHour`/`toHour` narrow EVERY day in that
 * range to the same hour band (inclusive/exclusive, wrapping past midnight when
 * fromHour > toHour). The server 400s if only one of the hour pair is sent — use
 * `hourQueryParams` in `lib/reportWindow` to build them.
 */
export type ReportWindowParams = {
  from?: string;
  to?: string;
  fromHour?: number;
  toHour?: number;
  /** IANA zone. Omit to let the server resolve tenant → Asia/Jerusalem. */
  tz?: string;
  shopId?: string;
  machineId?: string;
};

export async function fetchProductSalesReport(
  params: ReportWindowParams & { cashierId?: string; limit?: number },
): Promise<ProductSalesReport> {
  const { data } = await api.get<ProductSalesReport>('/reports/products', { params });
  return data;
}

export async function fetchCashierSalesReport(
  params: ReportWindowParams,
): Promise<CashierSalesReport> {
  const { data } = await api.get<CashierSalesReport>('/reports/cashiers', { params });
  return data;
}

/**
 * Day summary over a range, optionally narrowed to shops and/or tills.
 *
 * `shopIds`/`machineIds` are repeated query params and combine as an intersection,
 * matching the server. Axios serialises arrays as `shopIds[]=…` by default, which
 * FastAPI does not read, so they are expanded explicitly.
 */
export async function fetchDaySummaryReport(params: {
  from: string;
  to: string;
  tz?: string;
  shopIds?: string[];
  machineIds?: string[];
}): Promise<DaySummaryReport> {
  const search = new URLSearchParams();
  search.set('from', params.from);
  search.set('to', params.to);
  if (params.tz) search.set('tz', params.tz);
  for (const id of params.shopIds ?? []) search.append('shopIds', id);
  for (const id of params.machineIds ?? []) search.append('machineIds', id);
  const { data } = await api.get<DaySummaryReport>(`/reports/day-summary?${search.toString()}`);
  return data;
}

export async function fetchTipsRangeReport(
  params: ReportWindowParams,
): Promise<TipsRangeReport> {
  const { data } = await api.get<TipsRangeReport>('/reports/tips', { params });
  return data;
}

export type ZReportListParams = {
  /** Repeatable. Serialised as `machineIds=a&machineIds=b` (no `[]` suffix). */
  machineIds?: string[];
  shopId?: string;
  /** Filters `day_date` — the trading day the till filed the close under. */
  from?: string;
  to?: string;
  /** ISO datetimes on `closed_at`; naive values are read as UTC server-side. */
  closedFrom?: string;
  closedTo?: string;
  page?: number;
  pageSize?: number;
};

/**
 * One Z report by id.
 *
 * Exists so the day summary can hand the reader the document itself rather than a
 * restatement of it. The list read cannot stand in: a Z from six weeks ago is not on
 * the page the reader happens to be looking at.
 */
/**
 * Close a dead terminal's trading day from the cloud.
 *
 * Produces a Z built from the documents the cloud holds, marked `reconstructed`. Refused
 * while the terminal is still online or was seen in the last two hours, unless forced.
 */
export async function reconstructCloseTradingDay(
  machineId: string,
  body: { force?: boolean; note?: string } = {},
): Promise<{
  created: boolean;
  zReportId: string;
  shopSequenceNumber: number | null;
  reconstructed: boolean;
  basis: Record<string, unknown> | null;
}> {
  const { data } = await api.post(`/machines/${machineId}/trading-day/reconstruct-close`, body);
  return data;
}

/**
 * A pairing code that hands this terminal's identity to a replacement device.
 *
 * Refused while the terminal has an open trading day — the replacement has none of that
 * day's records and could not issue a truthful Z for it.
 */
export async function createReplacementCode(machineId: string): Promise<{
  code: string;
  expiresAt: string;
  replacesMachineId: string;
  machineCode: string;
}> {
  const { data } = await api.post(`/machines/${machineId}/replacement-code`, {});
  return data;
}

/**
 * Which companies may be this one's parent, and what a move would carry with it.
 *
 * Asked of the server rather than computed here: the no-self, no-descendant and
 * depth rules are the ones the save enforces, and a second copy in TypeScript would
 * drift the first time either changed — offering a parent the save then refuses.
 *
 * Omit `companyId` when creating: nothing exists under a company that does not exist,
 * so every company is a candidate and the move counts are zero.
 */
export async function fetchParentOptions(companyId?: string): Promise<ParentOptions> {
  const { data } = await api.get<ParentOptions>('/companies/parent-options', {
    params: companyId ? { companyId } : undefined,
  });
  return data;
}

export async function fetchZReport(id: string): Promise<ZReport> {
  const { data } = await api.get<ZReport>(`/z-reports/${id}`);
  return data;
}

export async function fetchZReports(params: ZReportListParams): Promise<ZReportListResponse> {
  const { data } = await api.get<ZReportListResponse>('/z-reports', {
    params,
    // FastAPI reads a repeated `List[UUID]` query param as `machineIds=a&machineIds=b`.
    // Axios' default array format is `machineIds[]=a`, which FastAPI would ignore
    // entirely — the filter would silently do nothing.
    paramsSerializer: { indexes: null },
  });
  return data;
}

export type TaxOpenFormatParams = {
  scope: 'shop' | 'company';
  shopId?: string;
  companyId?: string;
  mode: 'date-range' | 'year';
  from?: string;
  to?: string;
  year?: number;
};

export async function fetchTaxOpenFormatPreview(
  params: TaxOpenFormatParams,
): Promise<TaxOpenFormatPreview> {
  const { data } = await api.get<TaxOpenFormatPreview>('/reports/tax/openformat/preview', { params });
  return data;
}

export async function downloadTaxOpenFormat(params: TaxOpenFormatParams): Promise<Blob> {
  const { data } = await api.get<Blob>('/reports/tax/openformat', {
    params,
    responseType: 'blob',
  });
  return data;
}

export async function fetchDashboardStats(params: {
  from?: string;
  to?: string;
  companyId?: string;
  shopId?: string;
  machineId?: string;
}): Promise<DashboardStats> {
  const { data } = await api.get<DashboardStats>('/dashboard/stats', { params });
  return data;
}

export async function fetchDashboardBreakdown(params: {
  from?: string;
  to?: string;
  companyId?: string;
}): Promise<DashboardBreakdown> {
  const { data } = await api.get<DashboardBreakdown>('/dashboard/breakdown', { params });
  return data;
}

export async function postCloseDay(payload: {
  machineIds?: string[];
  shopId?: string;
  /**
   * Several shops at once. Combines with the other two as a union on the server and
   * is deduplicated, so a till named directly *and* covered by a chosen shop is only
   * closed once.
   */
  shopIds?: string[];
}): Promise<CloseDayCreateResponse> {
  const { data } = await api.post('/machines/close-day', payload);
  return data;
}

export async function fetchCloseDayRequest(requestId: string): Promise<CloseDayRequest> {
  const { data } = await api.get(`/close-day-requests/${requestId}`);
  return data;
}

// Attach Clerk JWT on every request
api.interceptors.request.use(async (config) => {
  const headers = await getAuthHeaders();
  Object.assign(config.headers, headers);
  config.headers['X-Request-Id'] = crypto.randomUUID();
  return config;
});

// Redirect to sign-in on 401 only when Clerk is done loading and there is no session.
// Right after OAuth redirect, Clerk may still be loading — a 401 + no session would
// otherwise send users back to /sign-in in a loop.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      const clerk = (window as any).Clerk;
      if (clerk && !clerk.loaded) {
        return Promise.reject(err);
      }
      const hasSession = !!clerk?.session;
      if (!hasSession) {
        window.location.href = '/sign-in';
      }
    }
    if (err.response?.status === 403 && err.response?.data?.detail === 'tenant_forbidden') {
      const { tenants, setActiveTenant } = useAuth.getState();
      const fallback = tenants[0]?.id;
      if (fallback) {
        setActiveTenant(fallback);
        if (typeof window !== 'undefined') window.location.reload();
      }
    }
    return Promise.reject(err);
  },
);
