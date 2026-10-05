import axios from 'axios';
import { useAuth } from './auth';
import type {
  CashierSalesReport,
  DaySummaryReport,
  OfflineAuthorizationReport,
  CategoryReorderEntry,
  CategoryReorderResponse,
  Company,
  DashboardBreakdown,
  DashboardStats,
  OverviewReport,
  LiveItemsReport,
  TillMessage,
  TillMessageCreate,
  TillMessageList,
  TillMessageUpdate,
  BrandingImageKind,
  BrandingUploadResult,
  EntitySettingsResponse,
  PosMachine,
  DeviceModel,
  PosSettingsPatch,
  ProductSalesReport,
  SalesByAreaReport,
  Shop,
  ShopArea,
  ShopSettingsResponse,
  MachineSettingsResponse,
  AreaSettingsResponse,
  AppRelease,
  AppReleaseAssignment,
  AppReleaseLevel,
  AppReleaseRolloutRow,
  StockLevel,
  TipsRangeReport,
  TipsReport,
  TaxOpenFormatPreview,
  ParentOptions,
  Shift,
  ShiftListResponse,
  ShiftStatus,
  ZCandidates,
  ZReportDetail,
  ZReportListResponse,
  ZPrintDoc,
  ZPrintDocList,
  ShiftCloseRequest,
  CardTransmission,
  CardTransmissionList,
  TransmitRequest,
  TillZRequest,
  TillZRequestStatus,
  UntransmittedCardSales,
  ZMode,
  ZRun,
  ZRunMachineSelection,
  TillParameter,
  TillParameterInput,
  TillParameterScalar,
  TillParameterScope,
  TillParameterValue,
} from './types';
import { normalizePosMachine } from './posMachine';
import { tenantFallbackAfterForbidden } from './tenantSwitch';

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
  /** The image as uploaded, when the server cut its background out. */
  originalUrl?: string | null;
  backgroundRemoved?: boolean;
};

/** The slice of Clerk's browser global this module reads. */
type ClerkGlobal = {
  loaded?: boolean;
  load?: () => Promise<void>;
  session?: { getToken: () => Promise<string | null> } | null;
};

function clerkGlobal(): ClerkGlobal | undefined {
  return (window as unknown as { Clerk?: ClerkGlobal }).Clerk;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (typeof window === 'undefined') return headers;

  const clerk = clerkGlobal();
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

/**
 * Upload an image and return its URL for product.imageUrl / category.imageUrl.
 *
 * Product images go through pos-server, which removes the background and stores
 * a trimmed transparent PNG (the original is kept as `originalUrl`); pass
 * `keepBackground` to store the image as is. Categories use a signed direct
 * upload to Cloudinary.
 */
export async function uploadProductImage(
  file: File,
  resource: 'products' | 'categories' = 'products',
  options: { keepBackground?: boolean } = {},
): Promise<ImageUploadResult> {
  validateImageFile(file);
  if (resource === 'products') {
    const body = new FormData();
    body.append('file', file);
    const { data } = await api.post<ImageUploadResult>('/images/upload', body, {
      params: { resource, keepBackground: options.keepBackground ?? false },
      // Let the browser set multipart/form-data with its own boundary.
      headers: { 'Content-Type': undefined },
    });
    return data;
  }
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

/** What `POST /images/media` answers. */
export type MediaUploadResult = {
  url: string;
  kind: 'image' | 'video';
  bytes: number;
};

/**
 * An image or a short MP4/WebM video (up to 25 MB), stored as uploaded — the startup
 * hero's video goes this way. Like a branding upload, every upload gets a new URL, so
 * the till's copy of a replaced video is never mistaken for the new one.
 */
export async function uploadBrandingMedia(file: File): Promise<MediaUploadResult> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<MediaUploadResult>('/images/media', form, {
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
/** The server's largest page of `GET /machines`. */
const MACHINES_PAGE = 100;
/** A ceiling on pages, so a server that ignores `skip` cannot loop us forever. */
const MACHINES_MAX_PAGES = 50;

/**
 * Every machine in scope. `GET /machines` answers at most 100 rows per call, so a
 * tenant with more tills is read page by page rather than silently cut at the 100th.
 */
export async function fetchMachines(): Promise<PosMachine[]> {
  const out: PosMachine[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MACHINES_MAX_PAGES; page++) {
    const { data } = await api.get('/machines', {
      params: { skip: page * MACHINES_PAGE, limit: MACHINES_PAGE },
    });
    const list: Record<string, unknown>[] = Array.isArray(data) ? data : [];
    let added = 0;
    for (const row of list) {
      const m = normalizePosMachine(row);
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
      added++;
    }
    // A short page is the last; a page of nothing new means `skip` was not honoured.
    if (list.length < MACHINES_PAGE || added === 0) break;
  }
  return out;
}

/**
 * One machine by id — including a removed one or one with no shop, which the list
 * (active only, shop-scoped for some roles) does not return.
 */
export async function fetchMachine(id: string): Promise<PosMachine> {
  const { data } = await api.get(`/machines/${id}`);
  return normalizePosMachine(data as Record<string, unknown>);
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

export async function fetchCompanySettings(
  companyId: string,
  includeEffective = false,
): Promise<ShopSettingsResponse> {
  const { data } = await api.get<ShopSettingsResponse>(`/companies/${companyId}/settings`, {
    params: includeEffective ? { includeEffective: true } : undefined,
  });
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

/**
 * One till's own settings — the last layer, under its shop. `effective` is what it
 * inherits from its shop, company and tenant; `settingsUpdatedAt` is null until first set.
 */
export async function fetchMachineSettings(
  machineId: string,
  includeEffective = true,
): Promise<MachineSettingsResponse> {
  const { data } = await api.get<MachineSettingsResponse>(`/machines/${machineId}/settings`, {
    params: includeEffective ? { includeEffective: true } : undefined,
  });
  return data;
}

export async function patchMachineSettings(
  machineId: string,
  patch: PosSettingsPatch,
): Promise<MachineSettingsResponse> {
  const { data } = await api.patch<MachineSettingsResponse>(`/machines/${machineId}/settings`, patch);
  return data;
}

/**
 * One point of sale's (shop area's) own settings — the layer between its shop and its
 * tills. `effective` is what it inherits from its shop, company and tenant.
 */
export async function fetchAreaSettings(
  areaId: string,
  includeEffective = true,
): Promise<AreaSettingsResponse> {
  const { data } = await api.get<AreaSettingsResponse>(`/areas/${areaId}/settings`, {
    params: includeEffective ? { includeEffective: true } : undefined,
  });
  return data;
}

export async function patchAreaSettings(
  areaId: string,
  patch: PosSettingsPatch,
): Promise<AreaSettingsResponse> {
  const { data } = await api.patch<AreaSettingsResponse>(`/areas/${areaId}/settings`, patch);
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
  params: { from?: string; to?: string; shiftId?: string },
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
  /** An area id, or `none` for sales of shifts with no area (and of no shift). */
  areaId?: string;
};

export async function fetchProductSalesReport(
  /** `meals`: "components" (default) reports a meal as its components; "meals" as the meal. */
  params: ReportWindowParams & { cashierId?: string; limit?: number; meals?: 'components' | 'meals' },
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

/** The tills' offline authorization runs over a range (days on the run's time). */
export async function fetchOfflineAuthorizationsReport(params: {
  from?: string;
  to?: string;
  tz?: string;
  shopId?: string;
  machineId?: string;
}): Promise<OfflineAuthorizationReport> {
  const { data } = await api.get<OfflineAuthorizationReport>('/reports/offline-authorizations', {
    params,
  });
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
  /** Filters the Z's `businessDate`, or its production date with `dateBasis`. */
  from?: string;
  to?: string;
  /** What `from`/`to` and the order are on; the server's default is `business`. */
  dateBasis?: 'business' | 'production';
  /** ISO datetimes on `closed_at`; naive values are read as UTC server-side. */
  closedFrom?: string;
  closedTo?: string;
  /** An area id, or `none` for Zs run for no area. */
  areaId?: string;
  /** `till` = Zs the tills produced themselves; `cloud` = the shop's Zs. */
  origin?: 'cloud' | 'till';
  page?: number;
  pageSize?: number;
};

/**
 * Close a dead terminal's open shift from the cloud.
 *
 * Builds that shift's X from the documents the cloud holds, marked `reconstructed`,
 * `unattended` and uncounted. It is then an ordinary candidate for the shop's next Z —
 * this issues no Z itself. Refused while the terminal is online or was seen in the
 * last two hours, unless forced.
 */
export async function administrativeCloseShift(
  machineId: string,
  shiftId: string,
  body: { force?: boolean; note?: string } = {},
): Promise<{ created: boolean; shift: Shift }> {
  const { data } = await api.post(
    `/machines/${machineId}/shifts/${shiftId}/administrative-close`,
    body,
  );
  return data;
}

/**
 * A pairing code that hands this terminal's identity to a replacement device.
 *
 * Refused while the terminal has an open shift — the replacement has none of that
 * shift's records, and its close would declare a fraction of what was taken.
 */
export async function createReplacementCode(
  machineId: string,
  opts: { acknowledgeUntransmitted?: boolean; deviceModel?: DeviceModel } = {},
): Promise<{
  code: string;
  expiresAt: string;
  replacesMachineId: string;
  machineCode: string;
  untransmittedAcknowledged?: boolean;
}> {
  const { data } = await api.post(`/machines/${machineId}/replacement-code`, {
    acknowledgeUntransmitted: !!opts.acknowledgeUntransmitted,
    ...(opts.deviceModel ? { deviceModel: opts.deviceModel } : {}),
  });
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

/** One Z with its per-till sections, its shifts and the header frozen at build. */
export async function fetchZReport(id: string): Promise<ZReportDetail> {
  const { data } = await api.get<ZReportDetail>(`/z-reports/${id}`);
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

/** One Z as the till's 80 mm print document. */
export async function fetchZPrintDocument(id: string): Promise<ZPrintDoc> {
  const { data } = await api.get<ZPrintDoc>(`/z-reports/${id}/print-document`);
  return data;
}

export type ZPrintDocumentsParams = {
  /** Explicit Zs; or a range of one shop (`shopId` with dates and/or Z numbers). */
  ids?: string[];
  shopId?: string;
  from?: string;
  to?: string;
  fromNumber?: number;
  toNumber?: number;
  dateBasis?: 'business' | 'production';
};

/** Several Zs as print documents, in Z-number order. The server refuses more than 200. */
export async function fetchZPrintDocuments(params: ZPrintDocumentsParams): Promise<ZPrintDocList> {
  const { ids, ...rest } = params;
  const { data } = await api.get<ZPrintDocList>('/z-reports/print-documents', {
    params: { ...rest, ...(ids && ids.length ? { ids: ids.join(',') } : {}) },
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

/**
 * The manager overview: today's takings (tenant timezone) as company › shop › area › till,
 * scoped by role on the server and narrowed by the scope bar here.
 */
export async function fetchOverview(params: {
  /** `YYYY-MM-DD`; the server's today when omitted. */
  date?: string;
  companyId?: string;
  shopId?: string;
  machineId?: string;
}): Promise<OverviewReport> {
  const { data } = await api.get<OverviewReport>('/reports/overview', { params });
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

export type ShiftListParams = {
  shopId?: string;
  machineId?: string;
  status?: ShiftStatus;
  /** `true` = closed and in no Z yet. */
  awaitingZ?: boolean;
  /** On `businessDate`. */
  from?: string;
  to?: string;
  /** The shift's stamped area id, or `none` for shifts stamped with no area. */
  areaId?: string;
  page?: number;
  pageSize?: number;
};

/** Shifts (X reports), newest business date first. */
export async function fetchShifts(params: ShiftListParams): Promise<ShiftListResponse> {
  const { data } = await api.get<ShiftListResponse>('/shifts', { params });
  return data;
}

/** One shift's X, with the tender breakdown recomputed from its documents. */
export async function fetchShift(id: string): Promise<Shift> {
  const { data } = await api.get<Shift>(`/shifts/${id}`);
  return data;
}

/**
 * Per till of a shop: reachability, open shift, and closed shifts awaiting a Z.
 * With `areaId`, only the tills currently in that area.
 */
export async function fetchZCandidates(shopId: string, areaId?: string | null): Promise<ZCandidates> {
  const { data } = await api.get<ZCandidates>(`/shops/${shopId}/z-candidates`, {
    params: areaId ? { areaId } : undefined,
  });
  return data;
}

/**
 * Start a Z for one shop. Several shops from the wizard are one call each — a Z never
 * spans shops. Comes back `completed` at once when nothing needed closing.
 */
export async function createZRun(body: {
  shopId: string;
  machines: ZRunMachineSelection[];
  businessDate?: string;
  /**
   * Run the Z for one area of the shop. Still the shop's Z (same number sequence);
   * every listed till must currently be in the area.
   */
  areaId?: string;
  /**
   * The operator confirms producing a shop Z without the tills a 409
   * `open_tills_need_confirmation` listed. Recorded on the Z.
   */
  confirmOpenTills?: boolean;
}): Promise<ZRun> {
  const { data } = await api.post<ZRun>('/z-runs', body);
  return data;
}

/** Progress. Reading it also sweeps expiry and builds the Z once every item is ready. */
export async function fetchZRun(id: string): Promise<ZRun> {
  const { data } = await api.get<ZRun>(`/z-runs/${id}`);
  return data;
}

/** Build now without these tills; their shifts wait for the next Z. */
export async function proceedZRun(id: string, excludeMachineIds: string[]): Promise<ZRun> {
  const { data } = await api.post<ZRun>(`/z-runs/${id}/proceed`, { excludeMachineIds });
  return data;
}

/** Ask a till to close its open shift, without a Z. Returns the pending one if any. */
export async function requestShiftClose(machineId: string): Promise<ShiftCloseRequest> {
  const { data } = await api.post<ShiftCloseRequest>(`/machines/${machineId}/close-shift`, {});
  return data;
}

export async function fetchShiftCloseRequest(id: string): Promise<ShiftCloseRequest> {
  const { data } = await api.get<ShiftCloseRequest>(`/shift-close-requests/${id}`);
  return data;
}

export async function cancelShiftCloseRequest(id: string): Promise<ShiftCloseRequest> {
  const { data } = await api.post<ShiftCloseRequest>(`/shift-close-requests/${id}/cancel`, {});
  return data;
}

/** Ask a till to transmit its card batch to Shva now. Returns the pending one if any. */
export async function requestTransmit(machineId: string): Promise<TransmitRequest> {
  const { data } = await api.post<TransmitRequest>(`/machines/${machineId}/transmit`, {});
  return data;
}

export async function fetchTransmitRequest(id: string): Promise<TransmitRequest> {
  const { data } = await api.get<TransmitRequest>(`/transmit-requests/${id}`);
  return data;
}

export async function cancelTransmitRequest(id: string): Promise<TransmitRequest> {
  const { data } = await api.post<TransmitRequest>(`/transmit-requests/${id}/cancel`, {});
  return data;
}

export async function fetchMachineTransmissions(
  machineId: string,
  params: { limit?: number; offset?: number } = {},
): Promise<CardTransmissionList> {
  const { data } = await api.get<CardTransmissionList>(`/machines/${machineId}/transmissions`, {
    params,
  });
  return data;
}

export async function fetchMachineTransmission(
  machineId: string,
  transmissionId: string,
): Promise<CardTransmission> {
  const { data } = await api.get<CardTransmission>(
    `/machines/${machineId}/transmissions/${transmissionId}`,
  );
  return data;
}

export async function fetchUntransmittedCardSales(machineId: string): Promise<UntransmittedCardSales> {
  const { data } = await api.get<UntransmittedCardSales>(`/machines/${machineId}/untransmitted`);
  return data;
}

export async function cancelZRun(id: string): Promise<ZRun> {
  const { data } = await api.post<ZRun>(`/z-runs/${id}/cancel`, {});
  return data;
}

// ── Z on the till (docs/SHIFTS_API.md §5) ──────────────────────────────────

/**
 * Who produces this till's Z. Refused (409) while the till has closed shifts no Z took
 * (`unreported_shifts`, with `count`) or a Z is being produced for it (`z_in_progress`).
 */
export async function setMachineZMode(machineId: string, zMode: ZMode): Promise<PosMachine> {
  const { data } = await api.put(`/machines/${machineId}`, { zMode });
  return normalizePosMachine(data as Record<string, unknown>);
}

/**
 * Ask these `till`-mode tills of a shop to produce their own Z — one request each. A till
 * that already has a pending request returns that one. Omitting `machineIds` asks every
 * active `till`-mode till of the shop.
 */
export async function requestShopTillZ(shopId: string, machineIds?: string[]): Promise<TillZRequest[]> {
  const { data } = await api.post<TillZRequest[]>(
    `/shops/${shopId}/till-z`,
    machineIds ? { machineIds } : {},
  );
  return Array.isArray(data) ? data : [];
}

/** Ask one `till`-mode till to produce its own Z. Returns the pending one if any. */
export async function requestMachineTillZ(machineId: string): Promise<TillZRequest> {
  const { data } = await api.post<TillZRequest>(`/machines/${machineId}/till-z`, {});
  return data;
}

export async function fetchTillZRequest(id: string): Promise<TillZRequest> {
  const { data } = await api.get<TillZRequest>(`/till-z-requests/${id}`);
  return data;
}

export async function fetchTillZRequests(params: {
  shopId?: string;
  status?: TillZRequestStatus;
}): Promise<TillZRequest[]> {
  // "A list" (§5.4): read either a bare array or a paged `{items}` body.
  const { data } = await api.get<TillZRequest[] | { items?: TillZRequest[] }>('/till-z-requests', {
    params,
  });
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

export async function cancelTillZRequest(id: string): Promise<TillZRequest> {
  const { data } = await api.post<TillZRequest>(`/till-z-requests/${id}/cancel`, {});
  return data;
}

// ── Shop areas (docs/AREAS_API.md) ─────────────────────────────────────────

/** The `areaId` filter value that means "no area". */
export const AREA_NONE = 'none';

/** A shop's areas, ordered by sortOrder then name. Archived ones only when asked. */
export async function fetchShopAreas(shopId: string, includeArchived = false): Promise<ShopArea[]> {
  const { data } = await api.get<ShopArea[]>(`/shops/${shopId}/areas`, {
    params: { includeArchived },
  });
  return Array.isArray(data) ? data : [];
}

export async function createShopArea(
  shopId: string,
  body: { name: string; sortOrder?: number },
): Promise<ShopArea> {
  const { data } = await api.post<ShopArea>(`/shops/${shopId}/areas`, body);
  return data;
}

export async function updateShopArea(
  areaId: string,
  body: { name?: string; sortOrder?: number },
): Promise<ShopArea> {
  const { data } = await api.patch<ShopArea>(`/areas/${areaId}`, body);
  return data;
}

/** Refused (`area_has_machines`) while any active till is still in the area. */
export async function archiveShopArea(areaId: string): Promise<ShopArea> {
  const { data } = await api.post<ShopArea>(`/areas/${areaId}/archive`, {});
  return data;
}

export async function restoreShopArea(areaId: string): Promise<ShopArea> {
  const { data } = await api.post<ShopArea>(`/areas/${areaId}/restore`, {});
  return data;
}

/**
 * Set the area's tills to exactly this list. Listed tills join (from no area or
 * another area of the shop); tills in it that are not listed leave it.
 */
export async function setShopAreaMachines(areaId: string, machineIds: string[]): Promise<ShopArea> {
  const { data } = await api.put<ShopArea>(`/areas/${areaId}/machines`, { machineIds });
  return data;
}

/** Record which hardware a till is ("N55F" | "MODO" | "P18"); the till reads `hasPrinter` from it. */
export async function updateMachineDeviceModel(
  machineId: string,
  deviceModel: DeviceModel,
): Promise<PosMachine> {
  const { data } = await api.put(`/machines/${machineId}`, { deviceModel });
  return normalizePosMachine(data as Record<string, unknown>);
}

/** "לקוח קבוע / זמני" on this till alone — the super admin's. */
export async function updateMachineLicense(
  machineId: string,
  license: { licenseType?: 'permanent' | 'temporary'; licenseExpiresOn?: string | null },
): Promise<PosMachine> {
  const { data } = await api.put(`/machines/${machineId}`, license);
  return normalizePosMachine(data as Record<string, unknown>);
}

/** Move one till to an area of its shop, or — with `null` — out of any area. */
export async function setMachineArea(machineId: string, areaId: string | null): Promise<PosMachine> {
  const { data } = await api.put(`/machines/${machineId}`, { areaId });
  return normalizePosMachine(data as Record<string, unknown>);
}

/** Sales per area of one shop over a day range; the rows sum to the shop's total. */
export async function fetchSalesByArea(params: {
  shopId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<SalesByAreaReport> {
  const { data } = await api.get<SalesByAreaReport>('/reports/sales-by-area', { params });
  return data;
}

// ── Till parameters ("פרמטרים לקופות", super admin only) ─────────────────────

/** Every definition, by key, with how many levels set a value for it. */
export async function fetchTillParameters(): Promise<TillParameter[]> {
  const { data } = await api.get<TillParameter[]>('/till-parameters');
  return Array.isArray(data) ? data : [];
}

/** `409 till_parameter_key_taken` when the key exists, in any case. */
export async function createTillParameter(body: TillParameterInput): Promise<TillParameter> {
  const { data } = await api.post<TillParameter>('/till-parameters', body);
  return data;
}

/**
 * Partial. `409 till_parameter_values_incompatible` when a new type or option list
 * would no longer accept a value already set somewhere.
 */
export async function updateTillParameter(
  id: string,
  body: Partial<TillParameterInput>,
): Promise<TillParameter> {
  const { data } = await api.put<TillParameter>(`/till-parameters/${id}`, body);
  return data;
}

/** Removes the parameter and every value set for it. */
export async function deleteTillParameter(id: string): Promise<void> {
  await api.delete(`/till-parameters/${id}`);
}

/** The levels that set this parameter, least specific first, with entity names. */
export async function fetchTillParameterValues(id: string): Promise<TillParameterValue[]> {
  const { data } = await api.get<TillParameterValue[]>(`/till-parameters/${id}/values`);
  return Array.isArray(data) ? data : [];
}

/** Set (or replace) the value at one level. `404 <level>_not_found` for a missing entity. */
export async function setTillParameterValue(
  id: string,
  body: { scopeType: TillParameterScope; scopeId: string; value: TillParameterScalar },
): Promise<TillParameterValue> {
  const { data } = await api.put<TillParameterValue>(`/till-parameters/${id}/values`, body);
  return data;
}

export async function deleteTillParameterValue(id: string, valueId: string): Promise<void> {
  await api.delete(`/till-parameters/${id}/values/${valueId}`);
}

// ── Till app releases ("עדכון קופות", super admin) ──────────────────────────

/** Every release, newest first. */
export async function fetchAppReleases(): Promise<AppRelease[]> {
  const { data } = await api.get<AppRelease[]>('/app-releases');
  return Array.isArray(data) ? data : [];
}

/**
 * Upload one APK. The server reads versionName / versionCode from the APK itself; the
 * typed values are only needed when it cannot (`422 apk_version_required`), and must
 * match when given (`422 apk_version_mismatch`).
 */
export async function uploadAppRelease(
  file: File,
  fields: { versionName?: string; versionCode?: number; notes?: string },
  onProgress?: (fraction: number) => void,
): Promise<AppRelease> {
  const form = new FormData();
  form.append('file', file);
  if (fields.versionName) form.append('versionName', fields.versionName);
  if (fields.versionCode !== undefined) form.append('versionCode', String(fields.versionCode));
  if (fields.notes) form.append('notes', fields.notes);
  const { data } = await api.post<AppRelease>('/app-releases', form, {
    // Let the browser set multipart/form-data with its own boundary.
    headers: { 'Content-Type': undefined },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    },
  });
  return data;
}

/** Notes, or retire / reinstate (`isActive`). */
export async function updateAppRelease(
  id: string,
  body: { notes?: string | null; isActive?: boolean },
): Promise<AppRelease> {
  const { data } = await api.patch<AppRelease>(`/app-releases/${id}`, body);
  return data;
}

export async function fetchAppReleaseAssignments(
  releaseId: string,
  includeCancelled = false,
): Promise<AppReleaseAssignment[]> {
  const { data } = await api.get<AppReleaseAssignment[]>(`/app-releases/${releaseId}/assignments`, {
    params: includeCancelled ? { includeCancelled: true } : undefined,
  });
  return Array.isArray(data) ? data : [];
}

/** `404 <level>_not_found`, `409 app_release_retired`. */
export async function createAppReleaseAssignment(
  releaseId: string,
  body: { level: AppReleaseLevel; targetId: string; autoInstall: boolean },
): Promise<AppReleaseAssignment> {
  const { data } = await api.post<AppReleaseAssignment>(`/app-releases/${releaseId}/assignments`, body);
  return data;
}

export async function cancelAppReleaseAssignment(assignmentId: string): Promise<void> {
  await api.delete(`/app-release-assignments/${assignmentId}`);
}

/** Per till of the active organization: version, target release, last report. */
export async function fetchAppReleaseRollout(params: {
  companyId?: string;
  shopId?: string;
}): Promise<AppReleaseRolloutRow[]> {
  const { data } = await api.get<AppReleaseRolloutRow[]>('/app-releases/rollout', {
    params: {
      ...(params.companyId ? { companyId: params.companyId } : {}),
      ...(params.shopId ? { shopId: params.shopId } : {}),
    },
  });
  return Array.isArray(data) ? data : [];
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
      const clerk = clerkGlobal();
      if (clerk && !clerk.loaded) {
        return Promise.reject(err);
      }
      const hasSession = !!clerk?.session;
      if (!hasSession) {
        window.location.href = '/sign-in';
      }
    }
    if (err.response?.status === 403 && err.response?.data?.detail === 'tenant_forbidden') {
      // Not every `tenant_forbidden` is about the tenant — see
      // `tenantFallbackAfterForbidden`. Resetting on any of them is what used to
      // revert every organization switch made from a page with a scope.
      const sent = err.config?.headers?.['X-Tenant-Id'];
      void recheckActiveTenant(typeof sent === 'string' ? sent : null);
    }
    return Promise.reject(err);
  },
);

let tenantRecheck: Promise<void> | null = null;

/**
 * Fall back to another tenant only if the server no longer lists the active one.
 * One check at a time: a page whose queries all 403 together asks once.
 */
function recheckActiveTenant(requestTenantId: string | null): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (tenantRecheck) return tenantRecheck;
  tenantRecheck = (async () => {
    try {
      const { data } = await api.get<Array<{ id: unknown }>>('/tenants/mine');
      const tenantIds = (Array.isArray(data) ? data : []).map((t) => String(t.id));
      const fallback = tenantFallbackAfterForbidden({
        requestTenantId,
        activeTenantId: useAuth.getState().activeTenantId,
        tenantIds,
      });
      if (fallback) {
        // Written straight to storage rather than through `setActiveTenant`, which
        // only accepts tenants from the list loaded at sign-in — the fresh list is
        // the one that counts. The reload re-reads it through `fetchUser`.
        window.localStorage.setItem('activeTenantId', fallback);
        window.location.reload();
      }
    } catch {
      // Could not ask; leave the tenant alone rather than guess.
    } finally {
      tenantRecheck = null;
    }
  })();
  return tenantRecheck;
}

// ── Live sales by item (`GET /reports/live-items`) ────────────────────────────

/**
 * Per product, what the scope has sold so far: a day (default today), a range, or the
 * shifts open now (`shift: 'open'`). The product sales report's figures, scoped by role.
 */
export async function fetchLiveItems(params: {
  date?: string;
  from?: string;
  to?: string;
  shift?: 'open';
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  limit?: number;
}): Promise<LiveItemsReport> {
  const { data } = await api.get<LiveItemsReport>('/reports/live-items', { params });
  return data;
}

// ── Messages to tills (הודעות לקופות) ─────────────────────────────────────────

export async function fetchTillMessages(params: { limit?: number; offset?: number } = {}): Promise<TillMessageList> {
  const { data } = await api.get<TillMessageList>('/till-messages', { params });
  return data;
}

export async function sendTillMessage(body: TillMessageCreate): Promise<TillMessage> {
  const { data } = await api.post<TillMessage>('/till-messages', body);
  return data;
}

export async function cancelTillMessage(id: string): Promise<TillMessage> {
  const { data } = await api.post<TillMessage>(`/till-messages/${id}/cancel`);
  return data;
}

export async function resendTillMessage(id: string): Promise<TillMessage & { notified: number }> {
  const { data } = await api.post<TillMessage & { notified: number }>(`/till-messages/${id}/resend`);
  return data;
}

export async function updateTillMessage(id: string, body: TillMessageUpdate): Promise<TillMessage> {
  const { data } = await api.patch<TillMessage>(`/till-messages/${id}`, body);
  return data;
}

export async function pauseTillMessage(id: string): Promise<TillMessage> {
  const { data } = await api.post<TillMessage>(`/till-messages/${id}/pause`);
  return data;
}

export async function resumeTillMessage(id: string): Promise<TillMessage> {
  const { data } = await api.post<TillMessage>(`/till-messages/${id}/resume`);
  return data;
}
