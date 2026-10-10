/**
 * Promotions ("מבצעים") — `pos-server app/routers/promotions.py`.
 *
 * Defined here, pulled by the tills, computed on the till. The config differs by type
 * (see `PromotionConfig`); category ids are stored as chosen and reach the till with their
 * sub-categories added.
 */
import { api, type ReportWindowParams } from './api';
import type { ReportWindowOut } from './types';

export const PROMOTION_TYPES = [
  'buy_x_get_y',
  'bundle_price',
  'discount',
  'threshold_gift',
  'threshold_item_price',
  'threshold_basket_discount',
  'combo',
] as const;

export type PromotionType = (typeof PROMOTION_TYPES)[number];

/** The spend-threshold types: once per sale unless told otherwise. */
export const THRESHOLD_TYPES: PromotionType[] = ['threshold_gift', 'threshold_item_price', 'threshold_basket_discount'];

export type PromotionStatus = 'active' | 'scheduled' | 'ended' | 'paused';
export type PromotionScopeType = 'company' | 'shop' | 'area' | 'machine';
export type DiscountKind = 'percent' | 'amount';

export interface PromoGroup {
  all?: boolean;
  productIds?: string[];
  categoryIds?: string[];
  excludeProductIds?: string[];
  excludeCategoryIds?: string[];
}

export interface PromotionConfig {
  target?: PromoGroup;
  counted?: PromoGroup;
  reward?: PromoGroup;
  buyQuantity?: number;
  getQuantity?: number;
  getDiscountPercent?: number;
  quantity?: number;
  price?: number;
  discountKind?: DiscountKind;
  discountValue?: number;
  threshold?: number;
  giftProductId?: string;
  giftQuantity?: number;
  specialPrice?: number;
  components?: { group: PromoGroup; quantity: number }[];
}

export interface PromotionScope {
  type: PromotionScopeType;
  id: string;
  name?: string | null;
  context?: string | null;
}

export interface Promotion {
  id: string;
  name: string;
  description: string | null;
  type: PromotionType;
  config: PromotionConfig;
  scopes: PromotionScope[];
  validFrom: string | null;
  validTo: string | null;
  weekdays: number[] | null;
  startTime: string | null;
  endTime: string | null;
  maxApplications: number | null;
  priority: number;
  isPaused: boolean;
  /** "שלח הודעה לעובדים": the settings, and when its messages are planned. */
  announcement?: PromotionAnnouncement;
  status: PromotionStatus;
  canEdit: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PromotionAnnouncement {
  enabled: boolean;
  text: string | null;
  endEnabled: boolean;
  endText: string | null;
  startAt?: string | null;
  endAt?: string | null;
  messages?: number;
}

export interface PromotionList {
  items: Promotion[];
  counts: Record<PromotionStatus, number>;
  canCreate: boolean;
}

export interface PromotionInput {
  name: string;
  description?: string | null;
  type: PromotionType;
  config: PromotionConfig;
  scopes: { type: PromotionScopeType; id: string }[];
  validFrom?: string | null;
  validTo?: string | null;
  weekdays?: number[] | null;
  startTime?: string | null;
  endTime?: string | null;
  maxApplications?: number | null;
  priority: number;
  isPaused: boolean;
  /** Null / missing: keep what the promotion has. */
  announcement?: Pick<PromotionAnnouncement, 'enabled' | 'text' | 'endEnabled' | 'endText'> | null;
}

export async function fetchPromotions(params: { search?: string; status?: PromotionStatus } = {}): Promise<PromotionList> {
  const { data } = await api.get<PromotionList>('/promotions', {
    params: {
      ...(params.search?.trim() ? { search: params.search.trim() } : {}),
      ...(params.status ? { status: params.status } : {}),
    },
  });
  return data;
}

export async function createPromotion(body: PromotionInput): Promise<Promotion> {
  return (await api.post<Promotion>('/promotions', body)).data;
}

export async function updatePromotion(id: string, body: PromotionInput): Promise<Promotion> {
  return (await api.put<Promotion>(`/promotions/${id}`, body)).data;
}

export async function pausePromotion(id: string, paused: boolean): Promise<Promotion> {
  return (await api.post<Promotion>(`/promotions/${id}/pause`, { paused })).data;
}

export async function duplicatePromotion(id: string): Promise<Promotion> {
  return (await api.post<Promotion>(`/promotions/${id}/duplicate`)).data;
}

export async function deletePromotion(id: string): Promise<void> {
  await api.delete(`/promotions/${id}`);
}

/** A product as the pickers list it. */
export interface PromoProductOption {
  id: string;
  name: string;
  price: number;
  sku: string | null;
}

export async function searchPromoProducts(search: string): Promise<PromoProductOption[]> {
  const { data } = await api.get<{ items: Record<string, unknown>[] }>('/products', {
    params: { page: 1, pageSize: 50, catalogLevel: 'global', ...(search.trim() ? { search: search.trim() } : {}) },
  });
  return (data.items ?? []).map((p) => ({
    id: String(p.id),
    name: String(p.name ?? ''),
    price: Number(p.price ?? 0),
    sku: (p.sku as string | null | undefined) ?? null,
  }));
}

/** Names for ids a promotion already holds (the search above only lists 50). */
export async function fetchPromoProduct(id: string): Promise<PromoProductOption | null> {
  try {
    const { data } = await api.get<Record<string, unknown>>(`/products/${id}`);
    return { id: String(data.id), name: String(data.name ?? ''), price: Number(data.price ?? 0), sku: (data.sku as string) ?? null };
  } catch {
    return null;
  }
}

export interface PromoCategoryOption {
  id: string;
  name: string;
  parentId: string | null;
}

export async function fetchPromoCategories(): Promise<PromoCategoryOption[]> {
  const { data } = await api.get<Record<string, unknown>[] | { items: Record<string, unknown>[] }>('/categories');
  const rows = Array.isArray(data) ? data : (data.items ?? []);
  return rows.map((c) => ({
    id: String(c.id),
    name: String(c.name ?? ''),
    parentId: (c.parentId as string | null | undefined) ?? null,
  }));
}

/* ---------------- report ---------------- */

export interface PromotionReportFigures {
  applications: number;
  documents: number;
  discount: number;
}

export interface PromotionsReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: PromotionReportFigures;
  byPromotion: (PromotionReportFigures & { promotionId: string | null; name: string | null; type: PromotionType | null })[];
  byShop: (PromotionReportFigures & { shopId: string | null; name: string | null })[];
  byTill: (PromotionReportFigures & {
    machineId: string | null;
    name: string | null;
    posNumber: string | null;
    shopName: string | null;
  })[];
  byDay: (PromotionReportFigures & { date: string })[];
}

export async function fetchPromotionsReport(
  params: ReportWindowParams & { promotionId?: string },
): Promise<PromotionsReport> {
  return (await api.get<PromotionsReport>('/reports/promotions', { params })).data;
}
