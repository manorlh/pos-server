/**
 * "סקירת שינויים לפני שידור לקופות" — pos-server app/routers/menu_broadcast.py
 * (docs/SPEC_MENU_BROADCAST_REVIEW.md). In a shop with tables (or the override «תמיד»),
 * menu edits are a draft: the tills keep the last broadcast version until someone
 * reviews the changes and approves the broadcast.
 */
import { api } from './api';

/** The review screen's sections, in the server's order. */
export const BROADCAST_SECTIONS = [
  'products',
  'prices',
  'categories',
  'modifiers',
  'availability',
  'hours',
  'menu',
] as const;
export type BroadcastSection = (typeof BROADCAST_SECTIONS)[number];

/** Why a shop is (or is not) in review mode. */
export type ReviewReason = 'tables' | 'always' | 'never' | 'no_tables';

export interface ReviewState {
  enabled: boolean;
  reason: ReviewReason;
  /** The shop's `menuBroadcastReview` (Hebrew option). */
  override: string;
  tablesEnabled: boolean;
  shopTablesMode: string | null;
  tablesTills: { machineId: string; name: string; posNumber: string | null; mode: string }[];
}

export interface BroadcastChange {
  /** `price`, `name`, `categoryId`, `option.price`, `optionAdded`, `groups`, `notes`, `meal`… */
  field: string;
  before: unknown;
  after: unknown;
  /** The option (or similar) the change is about. */
  label?: string;
}

export interface BroadcastItem {
  type: 'added' | 'removed' | 'changed';
  id: string;
  name: string | null;
  /** A category name (products), or the kind: group, links_category, notes_product, meal, upsell, course… */
  detail?: string;
  changes: BroadcastChange[];
}

export interface PublicationSummary {
  initial?: boolean;
  totals?: { products: number; categories: number };
  counts?: Partial<Record<BroadcastSection, number>>;
  total?: number;
}

export interface Publication {
  id: string;
  version: number;
  kind: 'initial' | 'broadcast';
  publishedAt: string | null;
  publishedByName: string | null;
  note: string | null;
  summary: PublicationSummary | null;
  closedAt: string | null;
}

export interface BroadcastTarget {
  machineId: string;
  name: string;
  posNumber: string | null;
  areaName: string | null;
  online: boolean;
  lastSyncAt: string | null;
}

export interface ShopPreview {
  shopId: string;
  shopName: string;
  companyId: string | null;
  review: ReviewState;
  publication: Publication | null;
  fingerprint: string | null;
  hasChanges: boolean;
  sections: Record<BroadcastSection, BroadcastItem[]>;
  counts: Record<BroadcastSection, number>;
  total: number;
  targets: BroadcastTarget[];
}

export interface BroadcastStatus {
  shops: {
    shopId: string;
    shopName: string;
    reason: ReviewReason;
    version: number;
    publishedAt: string | null;
    hasChanges: boolean;
    pending: number;
  }[];
  pending: number;
}

export interface WorkTypes {
  shopId: string;
  tables: boolean;
  tablesMode: string | null;
  tablesModeOptions: string[];
  tablesModeDefault: string | null;
  tablesTills: ReviewState['tablesTills'];
  takeAway: boolean | null;
  quickOrder: boolean | null;
  delivery: boolean | null;
  review: ReviewState;
  reviewOverrideOptions: string[];
  canEdit: boolean;
}

export interface WorkTypesPatch {
  tables?: boolean;
  tablesMode?: string;
  takeAway?: boolean;
  quickOrder?: boolean;
  delivery?: boolean;
  reviewOverride?: string;
}

export async function fetchBroadcastStatus(scope: {
  companyId?: string | null;
  shopId?: string | null;
}): Promise<BroadcastStatus> {
  const params: Record<string, string> = {};
  if (scope.shopId) params.shopId = scope.shopId;
  else if (scope.companyId) params.companyId = scope.companyId;
  return (await api.get<BroadcastStatus>('/menu-broadcast/status', { params })).data;
}

export async function fetchShopPreview(shopId: string): Promise<ShopPreview> {
  return (await api.get<ShopPreview>(`/shops/${shopId}/menu-broadcast/preview`)).data;
}

export async function fetchCompanyPreview(
  companyId: string,
): Promise<{ companyId: string; shops: ShopPreview[]; total: number }> {
  return (await api.get(`/companies/${companyId}/menu-broadcast/preview`)).data;
}

export async function broadcastShop(
  shopId: string,
  body: { fingerprint?: string | null; note?: string | null },
): Promise<{ shopId: string; publication: Publication; targets: BroadcastTarget[] }> {
  return (await api.post(`/shops/${shopId}/menu-broadcast`, body)).data;
}

export async function broadcastCompany(
  companyId: string,
  body: { shops: { shopId: string; fingerprint?: string | null }[]; note?: string | null },
): Promise<{
  companyId: string;
  results: { shopId: string; shopName?: string; ok: boolean; error?: string; publication?: Publication }[];
}> {
  return (await api.post(`/companies/${companyId}/menu-broadcast`, body)).data;
}

export async function fetchBroadcastHistory(shopId: string): Promise<{ shopId: string; versions: Publication[] }> {
  return (await api.get(`/shops/${shopId}/menu-broadcast/history`)).data;
}

export async function fetchWorkTypes(shopId: string): Promise<WorkTypes> {
  return (await api.get<WorkTypes>(`/shops/${shopId}/work-types`)).data;
}

export async function saveWorkTypes(shopId: string, body: WorkTypesPatch): Promise<WorkTypes> {
  return (await api.put<WorkTypes>(`/shops/${shopId}/work-types`, body)).data;
}

/** The 409 codes the review screen explains (`detail`, or `detail.code`). */
export function broadcastErrorCode(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'code' in detail) {
    const code = (detail as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** The query keys every catalog page's banner and the review screen share. */
export const BROADCAST_KEYS = {
  status: (companyId: string | null, shopId: string | null) => ['menu-broadcast-status', companyId, shopId] as const,
  shop: (shopId: string) => ['menu-broadcast-preview', shopId] as const,
  company: (companyId: string) => ['menu-broadcast-company', companyId] as const,
  history: (shopId: string) => ['menu-broadcast-history', shopId] as const,
  workTypes: (shopId: string) => ['shop-work-types', shopId] as const,
};
