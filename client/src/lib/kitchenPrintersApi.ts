/**
 * Kitchen / bar ticket printers ("מדפסות בונים") — pos-server app/routers/printers.py,
 * docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §4.
 */
import { api } from './api';
import type { BonTillLocalPrinter, LocalConnection } from './kioskBonPrinters';
import type { TillParameterValueType } from './types';

export type PrinterConnectionType = 'network' | 'bluetooth' | 'cloud' | 'till' | 'usb';
/** kitchen — "מדפסת בונים" (tickets, by the routing); receipt — "מדפסת חשבוניות" (bills, receipts, the drawer). */
export type PrinterPurpose = 'kitchen' | 'receipt';
/** How a cloud printer's host till reaches it: its own head, a network / Bluetooth printer, or its own USB port. */
export type PrinterHostConnection = 'till' | 'network' | 'bluetooth' | 'usb';

export interface KitchenPrinter {
  id: string;
  shopId: string;
  name: string;
  purpose: PrinterPurpose;
  /** A receipt printer with the cash drawer on its port. */
  cashDrawer: boolean;
  connectionType: PrinterConnectionType;
  host: string | null;
  port: number | null;
  btAddress: string | null;
  btName: string | null;
  hostMachineId: string | null;
  hostMachineName: string | null;
  hostConnection: PrinterHostConnection | null;
  areaId: string | null;
  areaName: string | null;
  machineId: string | null;
  machineName: string | null;
  paperWidth: 58 | 80;
  /** "רוחב הדפסה" in dots; null — by the paper (58 mm → 384, 80 mm → 576). */
  printWidthDots?: PrintWidthDots | null;
  copies: number;
  cutPaper: boolean;
  beep: boolean;
  isActive: boolean;
  sortOrder: number;
  updatedAt: string | null;
}

/** How many dots wide the printer's head prints; a narrower head than the ticket skews it. */
export type PrintWidthDots = 576 | 512 | 432 | 384;
export const PRINT_WIDTHS: PrintWidthDots[] = [576, 512, 432, 384];

export interface KitchenPrinterInput {
  name: string;
  purpose: PrinterPurpose;
  cashDrawer: boolean;
  connectionType: PrinterConnectionType;
  host?: string | null;
  port?: number | null;
  btAddress?: string | null;
  btName?: string | null;
  hostMachineId?: string | null;
  hostConnection?: PrinterHostConnection | null;
  areaId?: string | null;
  machineId?: string | null;
  paperWidth: 58 | 80;
  printWidthDots?: PrintWidthDots | null;
  copies: number;
  cutPaper: boolean;
  beep: boolean;
  isActive: boolean;
  sortOrder?: number;
}

/** A printing setting's value (a till parameter: text, number or on/off). */
export type PrinterSettingValue = string | number | boolean;
/** The values set at one level, by parameter key; a key left out inherits. */
export type PrinterSettingValues = Record<string, PrinterSettingValue>;

/** One printing setting (a till parameter the printers page edits). */
export interface PrinterSettingDef {
  key: string;
  label: string;
  description?: string | null;
  valueType: TillParameterValueType;
  enumOptions?: string[] | null;
  defaultValue?: PrinterSettingValue | null;
}

/**
 * The printing settings ("הגדרות הדפסה") by shop → point of sale → till. `inherited` is
 * what the shop takes from above it: the company's value (keys in `fromCompany`), else
 * the default.
 */
export interface KitchenOptions {
  parameters: PrinterSettingDef[];
  defaults: Record<string, PrinterSettingValue | null>;
  inherited: Record<string, PrinterSettingValue | null>;
  fromCompany: string[];
  shop: PrinterSettingValues;
  areas: Record<string, PrinterSettingValues>;
  machines: Record<string, PrinterSettingValues>;
}

export interface KitchenPrintersPage {
  shopId: string;
  canEdit: boolean;
  printers: KitchenPrinter[];
  areas: { id: string; name: string }[];
  machines: { id: string; name: string; areaId: string | null; hasPrinter: boolean }[];
  options: KitchenOptions;
  /** The shop's print server ("שרת הדפסות", till parameter printHostTill), or null. */
  printHost: PrintHost | null;
}

export interface PrintHost {
  machineId: string;
  name: string;
  /** Where it last said it listens on the shop's LAN; null before its first report. */
  lanAddress: string | null;
  port: number;
  reportedAt: string | null;
}

/** Make one till of the shop its print server, or none (null). */
export async function savePrintHost(shopId: string, machineId: string | null): Promise<PrintHost | null> {
  const { data } = await api.put<{ printHost: PrintHost | null }>(`/shops/${shopId}/print-host`, { machineId });
  return data.printHost;
}

export type PrintJobStatus = 'pending' | 'printing' | 'done' | 'failed' | 'expired';

export interface PrintJob {
  id: string;
  printerId: string | null;
  printerName: string | null;
  kind: 'ticket' | 'test';
  status: PrintJobStatus;
  error: string | null;
  targetMachineId: string | null;
  targetMachineName: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
}

export interface RoutingCategory {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export type ProductRouteMode = 'inherit' | 'none' | 'printers';

export interface ProductRoute {
  productId: string;
  name: string | null;
  categoryId: string | null;
  /** Its rows in this shop (printers / none), or "ללא בון" on the product itself (no_ticket). */
  mode: Exclude<ProductRouteMode, 'inherit'> | 'no_ticket';
  printerIds: string[];
  noTicket: boolean;
  /** In how many shops it has rows of its own (the reset asks first when more than one). */
  overrideShopCount: number;
  /** May the viewer change the product itself (its "ללא בון" / reset). */
  canEditProduct: boolean | null;
}

/** Where a product prints in a shop now, and why. */
export interface ProductEffective {
  source: 'no_ticket' | 'product' | 'product_none' | 'category';
  printerIds: string[];
  printerNames: string[];
}

export interface ProductOverrideShop {
  shopId: string;
  shopName: string | null;
  mode: 'printers' | 'none';
  printerIds: string[];
  printerNames: string[];
}

/** A product's kitchen settings: product-wide, and — with a shop — in that shop. */
export interface ProductKitchenState {
  productId: string;
  productName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  noTicket: boolean;
  overrideShops: ProductOverrideShop[];
  canEditProduct: boolean | null;
  shopId?: string;
  mode?: ProductRouteMode;
  printerIds?: string[];
  inheritedPrinterIds?: string[];
  inheritedFromId?: string | null;
  inheritedFromName?: string | null;
  printers?: { id: string; name: string; isActive: boolean; type: string }[];
  effective?: ProductEffective;
}

export async function fetchProductKitchen(productId: string, shopId?: string | null): Promise<ProductKitchenState> {
  const { data } = await api.get<ProductKitchenState>(`/products/${productId}/kitchen-printers`, {
    params: shopId ? { shopId } : {},
  });
  return data;
}

/** "ללא בון": no kitchen ticket for the product in any shop (true), or back to its category (false). */
export async function setProductNoTicket(
  productId: string,
  noTicket: boolean,
  shopId?: string | null,
): Promise<ProductKitchenState> {
  const { data } = await api.put<ProductKitchenState>(
    `/products/${productId}/kitchen-printers/no-ticket`,
    { noTicket },
    { params: shopId ? { shopId } : {} },
  );
  return data;
}

/** "אפס להגדרת המחלקה": every product-level setting, in every shop, removed. */
export async function resetProductKitchen(productId: string, shopId?: string | null): Promise<ProductKitchenState> {
  const { data } = await api.post<ProductKitchenState>(
    `/products/${productId}/kitchen-printers/reset`,
    {},
    { params: shopId ? { shopId } : {} },
  );
  return data;
}

export interface PrinterRouting {
  categories: RoutingCategory[];
  /** Each category's own printers. */
  categoryRoutes: Record<string, string[]>;
  /** What each category prints on after inheritance from its parents. */
  effectiveCategoryRoutes: Record<string, string[]>;
  products: ProductRoute[];
}

export async function fetchKitchenPrinters(shopId: string): Promise<KitchenPrintersPage> {
  const { data } = await api.get<KitchenPrintersPage>(`/shops/${shopId}/printers`);
  return data;
}

/** A till's own printer (built-in head, USB, Bluetooth), by name — the kiosk's "מדפסת בונים" (SPEC_KIOSK §16.9). */
export type TillLocalPrinter = BonTillLocalPrinter & {
  btAddress: string | null;
  paperWidth: number | null;
  printerStatus: string | null;
  printerName: string | null;
};

export async function fetchTillLocalPrinters(shopId: string): Promise<TillLocalPrinter[]> {
  const { data } = await api.get<{ printers: TillLocalPrinter[] }>(`/shops/${shopId}/till-local-printers`);
  return data.printers ?? [];
}

/** The hosted printer behind a till's own printer: made, or reused (and switched on). */
export async function ensureTillLocalPrinter(
  shopId: string,
  machineId: string,
  connection: LocalConnection,
): Promise<KitchenPrinter> {
  const { data } = await api.post<KitchenPrinter>(`/shops/${shopId}/till-local-printers`, { machineId, connection });
  return data;
}

export async function createKitchenPrinter(shopId: string, body: KitchenPrinterInput): Promise<KitchenPrinter> {
  const { data } = await api.post<KitchenPrinter>(`/shops/${shopId}/printers`, body);
  return data;
}

export async function updateKitchenPrinter(id: string, body: KitchenPrinterInput): Promise<KitchenPrinter> {
  const { data } = await api.put<KitchenPrinter>(`/printers/${id}`, body);
  return data;
}

export async function deleteKitchenPrinter(id: string): Promise<void> {
  await api.delete(`/printers/${id}`);
}

/**
 * A test ticket for the printer's host, or for every till that uses it. With `idempotencyKey`
 * the POST carries an `Idempotency-Key` (lib/deviceCommandsStore.ts `idempotencyHeaders`): a
 * retry with the same key never makes a second test.
 */
export async function testKitchenPrinter(id: string, idempotencyKey?: string): Promise<PrintJob[]> {
  const { data } = await api.post<{ jobs: PrintJob[] }>(
    `/printers/${id}/test`,
    {},
    idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
  );
  return data.jobs ?? [];
}

export async function fetchPrinterTestJobs(id: string): Promise<PrintJob[]> {
  const { data } = await api.get<{ jobs: PrintJob[] }>(`/printers/${id}/test-jobs`);
  return data.jobs ?? [];
}

export async function fetchPrinterRouting(shopId: string): Promise<PrinterRouting> {
  const { data } = await api.get<PrinterRouting>(`/shops/${shopId}/printer-routing`);
  return data;
}

/** The whole category matrix: every category's own printers. */
export async function saveCategoryRoutes(
  shopId: string,
  routes: Record<string, string[]>,
): Promise<PrinterRouting> {
  const { data } = await api.put<PrinterRouting>(`/shops/${shopId}/printer-routing/categories`, { routes });
  return data;
}

export async function saveProductRoute(
  shopId: string,
  productId: string,
  mode: ProductRouteMode,
  printerIds: string[],
): Promise<PrinterRouting> {
  const { data } = await api.put<PrinterRouting>(
    `/shops/${shopId}/printer-routing/products/${productId}`,
    { mode, printerIds },
  );
  return data;
}

/** One level's printing settings; `null` removes the value there (it inherits again). */
export async function savePrinterSettings(
  shopId: string,
  scopeType: 'shop' | 'area' | 'machine',
  scopeId: string,
  values: Record<string, PrinterSettingValue | null>,
): Promise<KitchenOptions> {
  const { data } = await api.put<KitchenOptions>(`/shops/${shopId}/printer-options`, {
    scopeType,
    scopeId,
    values,
  });
  return data;
}

export interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
}

/** Products for the per-product override search. */
export async function searchProducts(search: string): Promise<ProductOption[]> {
  const { data } = await api.get<{ items: Record<string, unknown>[] }>('/products', {
    params: { page: 1, pageSize: 30, catalogLevel: 'global', ...(search.trim() ? { search: search.trim() } : {}) },
  });
  return (data.items ?? []).map((p) => ({
    id: String(p.id),
    name: String(p.name ?? ''),
    sku: (p.sku as string | null | undefined) ?? null,
  }));
}

/** One product's or category's printers in a shop: its own setting and what it inherits now. */
export interface TargetRoute {
  shopId: string;
  mode: ProductRouteMode;
  printerIds: string[];
  inheritedPrinterIds: string[];
  inheritedFromId: string | null;
  inheritedFromName: string | null;
  printers: { id: string; name: string; isActive: boolean; type: string }[];
}

export async function fetchTargetRoute(
  shopId: string,
  kind: 'product' | 'category',
  id: string,
): Promise<TargetRoute> {
  const { data } = await api.get<TargetRoute>(
    `/shops/${shopId}/printer-routing/${kind === 'product' ? 'products' : 'categories'}/${id}`,
  );
  return data;
}

export async function saveTargetRoute(
  shopId: string,
  kind: 'product' | 'category',
  id: string,
  mode: ProductRouteMode,
  printerIds: string[],
): Promise<void> {
  await api.put(`/shops/${shopId}/printer-routing/${kind === 'product' ? 'products' : 'categories'}/${id}`, {
    mode,
    printerIds,
  });
}

// ── Kitchen stations ("תחנות") ───────────────────────────────────────────────

export interface KitchenStation {
  id: string;
  name: string;
  sortOrder: number;
  /** Its printers in the shop asked about (empty without a shop). */
  printerIds: string[];
  categoryIds: string[];
  productIds: string[];
}

export interface KitchenStationsPage {
  stations: KitchenStation[];
  /** Stations are network-wide: super admin, distributor, company manager. */
  canEdit: boolean;
}

export async function fetchKitchenStations(shopId?: string | null): Promise<KitchenStationsPage> {
  const { data } = await api.get<KitchenStationsPage>('/kitchen-stations', {
    params: shopId ? { shopId } : undefined,
  });
  return data;
}

export async function createKitchenStation(name: string): Promise<void> {
  await api.post('/kitchen-stations', { name });
}

export async function renameKitchenStation(id: string, name: string, sortOrder = 0): Promise<void> {
  await api.put(`/kitchen-stations/${id}`, { name, sortOrder });
}

export async function deleteKitchenStation(id: string): Promise<void> {
  await api.delete(`/kitchen-stations/${id}`);
}

export async function setKitchenStationPrinters(shopId: string, stationId: string, printerIds: string[]): Promise<void> {
  await api.put(`/shops/${shopId}/kitchen-stations/${stationId}/printers`, { printerIds });
}

/** A category or product to a station; `stationId` null clears it. */
export async function setKitchenStationTarget(
  targetType: 'category' | 'product',
  targetId: string,
  stationId: string | null,
): Promise<void> {
  await api.put('/kitchen-station-targets', { targetType, targetId, stationId });
}
