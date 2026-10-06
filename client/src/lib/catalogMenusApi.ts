/**
 * "תפריטים" — sales menus by schedule (pos-server app/routers/catalog_menus.py,
 * docs/SPEC_MENUS.md): the menus and their items, where they are assigned, what is active
 * now and the simulator ("מה יהיה פעיל ביום ג׳ ב-18:00"), and the sales report by menu.
 * The rules themselves are lib/menuSchedule.ts.
 */
import { api, type ReportWindowParams } from './api';
import type { ReportWindowOut } from './types';
import type { FallbackMode, MenuChannel, MenuLevel, MenuSurface, ResolutionMode, TimeRange } from './menuSchedule';

export interface CatalogMenuCategory {
  categoryId: string;
  name: string;
  /** Every product of the category (the listed ones first); false: only the listed ones. */
  allProducts: boolean;
}

export interface CatalogMenuProduct {
  productId: string;
  name: string;
  categoryId: string | null;
  /** The price while the menu is active; null: the catalog's. */
  price: number | null;
  catalogPrice: number | null;
}

export interface CatalogMenuAssignment {
  level: MenuLevel;
  targetId: string;
  targetName: string | null;
  priority: number;
}

export interface CatalogMenu {
  id: string;
  name: string;
  /** Null: the whole organization. */
  companyId: string | null;
  companyName: string | null;
  channel: MenuChannel;
  isActive: boolean;
  always: boolean;
  /** 0 = Sunday … 6 = Saturday; null: every day. */
  days: number[] | null;
  ranges: TimeRange[];
  validFrom: string | null;
  validTo: string | null;
  color: string | null;
  sortOrder: number;
  categories: CatalogMenuCategory[];
  products: CatalogMenuProduct[];
  assignments: CatalogMenuAssignment[];
  canEdit: boolean;
  updatedAt: string | null;
}

export interface CatalogMenuList {
  menus: CatalogMenu[];
  canCreate: boolean;
  /** The organization's zone: the schedules are its wall clock. */
  timezone: string;
}

export interface CatalogMenuInput {
  name: string;
  companyId: string | null;
  channel: MenuChannel;
  isActive: boolean;
  always: boolean;
  days: number[] | null;
  ranges: TimeRange[];
  validFrom: string | null;
  validTo: string | null;
  color: string | null;
  /** In the order shown. */
  categories: { categoryId: string; allProducts: boolean }[];
  /** In the order shown: by category, then within it. */
  products: { productId: string; price: number | string | null }[];
}

export async function fetchCatalogMenus(): Promise<CatalogMenuList> {
  return (await api.get<CatalogMenuList>('/catalog-menus')).data;
}

export async function fetchCatalogMenu(id: string): Promise<CatalogMenu> {
  return (await api.get<CatalogMenu>(`/catalog-menus/${id}`)).data;
}

export async function createCatalogMenu(body: CatalogMenuInput): Promise<CatalogMenu> {
  return (await api.post<CatalogMenu>('/catalog-menus', body)).data;
}

export async function updateCatalogMenu(id: string, body: CatalogMenuInput): Promise<CatalogMenu> {
  return (await api.put<CatalogMenu>(`/catalog-menus/${id}`, body)).data;
}

export async function deleteCatalogMenu(id: string): Promise<void> {
  await api.delete(`/catalog-menus/${id}`);
}

export async function reorderCatalogMenus(ids: string[]): Promise<void> {
  await api.put('/catalog-menus-order', { ids });
}

/** A menu as the PUT body takes it back — for a change of one field (the list's switch). */
export function menuInputOf(m: CatalogMenu): CatalogMenuInput {
  return {
    name: m.name,
    companyId: m.companyId,
    channel: m.channel,
    isActive: m.isActive,
    always: m.always,
    days: m.days,
    ranges: m.ranges.map((r) => ({ start: r.start, end: r.end })),
    validFrom: m.validFrom,
    validTo: m.validTo,
    color: m.color,
    categories: m.categories.map((c) => ({ categoryId: c.categoryId, allProducts: c.allProducts })),
    products: m.products.map((p) => ({ productId: p.productId, price: p.price })),
  };
}

/* ---------------- assignments ---------------- */

export interface MenuTarget {
  level: MenuLevel;
  id: string;
  name: string;
  /** A till: its point of sale, else its shop; a point of sale: its shop; a shop: its company; a company: the one above. */
  parentId: string | null;
  canEdit: boolean;
  posNumber?: string | null;
  shopId?: string;
  isKiosk?: boolean;
}

export interface MenuTargetAssignment {
  level: MenuLevel;
  targetId: string;
  menuId: string;
  priority: number;
}

export interface MenuTargetFallback {
  level: MenuLevel;
  targetId: string;
  mode: FallbackMode;
}

export interface MenuTargets {
  targets: MenuTarget[];
  assignments: MenuTargetAssignment[];
  fallbacks: MenuTargetFallback[];
}

export interface ScopeParams {
  companyId?: string | null;
  shopId?: string | null;
}

function scopeParams(p: ScopeParams): Record<string, string> {
  return {
    ...(p.companyId ? { companyId: p.companyId } : {}),
    ...(p.shopId ? { shopId: p.shopId } : {}),
  };
}

export async function fetchMenuTargets(p: ScopeParams = {}): Promise<MenuTargets> {
  return (await api.get<MenuTargets>('/catalog-menus-targets', { params: scopeParams(p) })).data;
}

export interface TargetAssignmentsInput {
  level: MenuLevel;
  targetId: string;
  menus: { menuId: string; priority: number }[];
  /** Null: inherit from the level above. */
  fallback: FallbackMode | null;
}

export async function saveMenuTarget(body: TargetAssignmentsInput): Promise<void> {
  await api.put('/catalog-menus-targets', body);
}

/* ---------------- what is active ---------------- */

export interface MenuNextChange {
  /** Local `"YYYY-MM-DDTHH:MM"`. */
  at: string;
  mode: ResolutionMode;
  menuId: string | null;
  menuName: string | null;
}

export interface MenuResolutionOut {
  mode: ResolutionMode;
  menuId: string | null;
  menuName: string | null;
  level: MenuLevel | null;
  depth: number | null;
  priority: number | null;
  next: MenuNextChange | null;
}

export interface MenuNowRow {
  level: 'shop' | 'area' | 'machine';
  id: string;
  name: string;
  parentId: string | null;
  posNumber?: string | null;
  isKiosk?: boolean;
  /** `published`: the shop reviews menu changes before broadcast — its tills have the last broadcast. */
  source: 'live' | 'published';
  pos: MenuResolutionOut;
  kiosk: MenuResolutionOut;
}

export interface MenuNow {
  at: string;
  timezone: string;
  rows: MenuNowRow[];
}

export async function fetchMenusNow(p: ScopeParams & { at?: string } = {}): Promise<MenuNow> {
  return (
    await api.get<MenuNow>('/catalog-menus-now', { params: { ...scopeParams(p), ...(p.at ? { at: p.at } : {}) } })
  ).data;
}

export interface MenuCandidate {
  menuId: string;
  menuName: string | null;
  level: MenuLevel;
  depth: number;
  priority: number;
  channel: MenuChannel | null;
  onChannel: boolean;
  activeNow: boolean;
  chosen: boolean;
}

export interface MenuPreviewProduct {
  id: string;
  name: string | null;
  price: number;
  catalogPrice: number | null;
  priceSource: 'menu' | 'catalog';
  blocked: boolean;
}

export interface MenuPreviewCategory {
  id: string;
  name: string | null;
  isActive: boolean;
  products: MenuPreviewProduct[];
}

export interface MenuSimulation {
  at: string;
  weekday: number;
  surface: MenuSurface;
  source: 'live' | 'published';
  level: MenuLevel;
  targetId: string;
  resolution: MenuResolutionOut;
  candidates: MenuCandidate[];
  preview: { categories: MenuPreviewCategory[]; products: number } | null;
}

export async function simulateMenus(p: {
  level: MenuLevel;
  targetId: string;
  at: string;
  channel?: MenuSurface;
}): Promise<MenuSimulation> {
  return (
    await api.get<MenuSimulation>('/catalog-menus-simulate', {
      params: { level: p.level, targetId: p.targetId, at: p.at, preview: true, ...(p.channel ? { channel: p.channel } : {}) },
    })
  ).data;
}

/* ---------------- the report ---------------- */

export interface MenuSalesRow {
  /** Null: lines sold with no menu active ("ללא תפריט"). */
  menuId: string | null;
  menuName: string | null;
  unitsSold: number;
  unitsRefunded: number;
  unitsNet: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  /** Of the units / money sold, what was at the menu's own price. */
  menuPricedUnits: number;
  menuPricedGross: number;
  lines: number;
}

export interface MenuSalesReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: { units: number; gross: number; refunds: number; net: number };
  rows: MenuSalesRow[];
}

export async function fetchMenuSalesReport(params: ReportWindowParams): Promise<MenuSalesReport> {
  return (await api.get<MenuSalesReport>('/reports/menu-sales', { params })).data;
}

/* ---------------- the catalog the editor picks from ---------------- */

export interface MenuCatalogCategory {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
}

/** The organization's catalog categories, every page of them (`/categories` pages by 200). */
export async function fetchMenuCategories(): Promise<MenuCatalogCategory[]> {
  const out: MenuCatalogCategory[] = [];
  const limit = 200;
  for (let skip = 0; skip < 5000; skip += limit) {
    const { data } = await api.get<Record<string, unknown>[] | { items: Record<string, unknown>[] }>('/categories', {
      params: { skip, limit, catalogLevel: 'global' },
    });
    const rows = Array.isArray(data) ? data : (data.items ?? []);
    for (const c of rows) {
      out.push({
        id: String(c.id),
        name: String(c.name ?? ''),
        parentId: (c.parentId as string | null | undefined) ?? null,
        isActive: c.isActive !== false,
      });
    }
    if (rows.length < limit) break;
  }
  return out;
}

export interface MenuCatalogProduct {
  id: string;
  name: string;
  price: number;
  categoryId: string | null;
  isActive: boolean;
}

/**
 * A category's products in the organization's catalog (the menus take the catalog's own
 * products, never a till's local copy), every page of them.
 */
export async function fetchCategoryProducts(categoryId: string): Promise<MenuCatalogProduct[]> {
  const out: MenuCatalogProduct[] = [];
  const pageSize = 200;
  for (let page = 1; page <= 25; page++) {
    const { data } = await api.get<{ items: Record<string, unknown>[]; total?: number }>('/products', {
      params: { page, pageSize, catalogLevel: 'global', categoryId },
    });
    const items = data.items ?? [];
    for (const p of items) {
      out.push({
        id: String(p.id),
        name: String(p.name ?? ''),
        price: Number(p.price ?? 0),
        categoryId: (p.categoryId as string | null | undefined) ?? null,
        isActive: p.isActive !== false,
      });
    }
    if (items.length < pageSize || (typeof data.total === 'number' && out.length >= data.total)) break;
  }
  return out;
}
