/**
 * Till anomalies and quick actions — pos-server app/routers/insights.py (docs/SPEC_INSIGHTS.md §10).
 * Every money field is integer agorot.
 */
import { api } from './api';
import type { ActionResult, ActionScope, DurationBody, QuickTargetLevel } from './insightsActions';
import { scopeQuery } from './insightsActions';
import type { InsightCard, InsightMeta, InsightScopeParams } from './insightsApi';

// ── Anomalies ────────────────────────────────────────────────────────────────

export interface TillRow {
  machineId: string;
  name: string;
  group: string;
  groupName: string | null;
  shopId: string | null;
  shopName: string | null;
  kiosk: boolean;
  documents: number;
  sales: number;
  net: number;
  refunds: number;
  refundsCount: number;
  openHours: number | null;
  openSource: 'shifts' | 'activity' | 'none';
  netPerHour: number | null;
  salesPerHour: number | null;
  avgTicket: number | null;
  cash: number;
  cashSharePct: number | null;
  cashDocs: number;
  cashAvg: number | null;
  voids: number;
  cancels: number;
  noSaleOpens: number;
  flags: string[];
}

export interface AnomalyGroup {
  group: string;
  name: string | null;
  kiosk: boolean;
  tills: TillRow[];
  judgeable: boolean;
  median: { netPerHour: number | null; avgTicket: number | null; cashSharePct: number | null };
}

export interface AnomalyThresholds {
  lowSalesPct: number;
  ticketDeviationPct: number;
  cashSharePoints: number;
  cashAvgDeviationPct: number;
  robustZ: number;
  minPeers: number;
  minDocs: number;
  minOpenHours: number;
}

export interface EventMeta {
  id: string;
  name: string;
  shopId: string;
  status: string;
  startsAt: string;
  endsAt: string;
  machineIds: string[];
}

export interface TillAnomalies extends InsightMeta {
  cards: InsightCard[];
  groups: AnomalyGroup[];
  counts: { critical: number; warning: number };
  tills: number;
  window: { kind: 'period' | 'today'; from: string; to: string; hours: number };
  thresholds: AnomalyThresholds;
  event?: EventMeta;
}

export interface AnomalySettings {
  thresholds: AnomalyThresholds;
  stored: Partial<AnomalyThresholds>;
  defaults: AnomalyThresholds;
  limits: Record<keyof AnomalyThresholds, { min: number; max: number; integer: boolean }>;
  canEdit: boolean;
}

export type InsightParamsWithEvent = InsightScopeParams & { eventId?: string };

export const fetchTillAnomalies = (p: InsightParamsWithEvent & { window?: 'period' | 'today' }) =>
  api.get<TillAnomalies>('/insights/anomalies', { params: p }).then((r) => r.data);

export const fetchAnomalySettings = () => api.get<AnomalySettings>('/insights/anomaly-settings').then((r) => r.data);

export const saveAnomalySettings = (thresholds: Partial<AnomalyThresholds> | null) =>
  api.put<AnomalySettings>('/insights/anomaly-settings', { thresholds }).then((r) => r.data);

/** The scope of a sheet / the cockpit as the anomalies' parameters: today so far, or the event. */
export const fetchScopeAnomalies = (scope: ActionScope, window: 'period' | 'today' = 'today') =>
  fetchTillAnomalies({ ...scopeQuery(scope), window, days: 7 });

// ── Quick actions ────────────────────────────────────────────────────────────

export interface QuickAction {
  id: string;
  kind: 'message' | 'promotion';
  status: 'active' | 'ended' | 'cancelled';
  productId: string | null;
  productName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  target: { level: QuickTargetLevel; id: string; name: string | null };
  tills: number;
  machineIds: string[];
  promotionId: string | null;
  tillMessageIds: string[];
  params: Record<string, unknown>;
  source: string | null;
  startsAt: string;
  endsAt: string | null;
  cancelledAt: string | null;
  createdBy: string | null;
  result: (ActionResult & { from: string; to: string; discount?: number; lastDocumentAt?: string | null }) | null;
}

export interface QuickActionList {
  items: QuickAction[];
  generatedAt: string;
  canMessage: boolean;
  canPromote: boolean;
}

export const fetchQuickActions = (params: { productId?: string; limit?: number } = {}) =>
  api.get<QuickActionList>('/insights/quick-actions', { params }).then((r) => r.data);

export interface QuickMessageBody {
  text: string;
  targetLevel: QuickTargetLevel;
  targetId: string;
  duration: DurationBody;
  productId?: string | null;
  display?: 'banner' | 'fullscreen';
  color?: string | null;
  source?: string;
}

export const sendQuickMessage = (body: QuickMessageBody) =>
  api.post<QuickAction>('/insights/quick-actions/messages', body).then((r) => r.data);

export const cancelQuickMessage = (id: string) =>
  api.post<QuickAction>(`/insights/quick-actions/messages/${id}/cancel`).then((r) => r.data);

export interface Offer {
  kind: 'percent' | 'second_half' | 'fixed_price';
  value: number | null;
  newPrice?: number;
  lowestUnitPrice?: number;
  effectivePct: number;
  belowCost: boolean;
  /** A unit at nothing, or under ₪1. */
  tooLow?: boolean;
  /** Not offered: under cost or under ₪1. */
  refused?: boolean;
  floor?: number | null;
  marginAfterPct?: number | null;
  offenders?: { productId: string; name: string; floor: number; lowestUnitPrice: number }[];
  offendersCount?: number;
  checked?: number;
}

export interface PromotionSuggestion {
  subject: { kind: 'product' | 'category' | 'all'; id: string | null; name: string };
  product: { id: string; name: string } | null;
  price: number | null;
  minPrice: number | null;
  cost: number | null;
  vatRate: number | null;
  floor: number | null;
  marginPct: number | null;
  costedProducts: number | null;
  options: Offer[];
  suggested: Offer | null;
  canCreate: boolean;
  canAnnounce: boolean;
  /** The general item or an open-price item: no promotion on it. */
  unsupported?: 'general' | 'open_price' | null;
  maxHours: number;
  maxUntilDays: number;
}

export interface SubjectParams {
  productId?: string;
  categoryId?: string;
  all?: boolean;
  targetLevel?: QuickTargetLevel;
  targetId?: string;
}

export const fetchPromotionSuggestion = (p: SubjectParams) =>
  api.get<PromotionSuggestion>('/insights/quick-actions/promotions/suggestion', { params: p }).then((r) => r.data);

export interface AnnounceSettings {
  enabled: boolean;
  text: string | null;
  endEnabled: boolean;
  endText: string | null;
}

export interface QuickPromotionBody extends SubjectParams {
  targetLevel: QuickTargetLevel;
  targetId: string;
  offer: { kind: Offer['kind']; value: number | null };
  duration: DurationBody;
  announce?: AnnounceSettings | null;
  source?: string;
}

export const createQuickPromotion = (body: QuickPromotionBody) =>
  api.post<QuickAction>('/insights/quick-actions/promotions', body).then((r) => r.data);

export const cancelQuickPromotion = (id: string) =>
  api.post<QuickAction>(`/insights/quick-actions/promotions/${id}/cancel`).then((r) => r.data);

// ── Happy hour ───────────────────────────────────────────────────────────────

export interface HappyHourSuggestion {
  id: string;
  weekday: number;
  weekdays: number[];
  fromHour: number;
  toHour: number;
  startTime: string;
  endTime: string;
  deviationPct: number | null;
  gapPerWeek: number;
  typicalNet: number;
  usual: number;
  overlaps: { id: string; name: string; at: string; weekdays: number[] | null; startTime: string; endTime: string }[];
}

export interface HappyHourSuggestions extends InsightMeta {
  suggestions: HappyHourSuggestion[];
  weeks: number;
  maxWeeks: number;
}

export const fetchHappyHourSuggestions = (p: InsightParamsWithEvent) =>
  api.get<HappyHourSuggestions>('/insights/happy-hours/suggestions', { params: p }).then((r) => r.data);

export interface HappyHourBody extends SubjectParams {
  weekdays: number[];
  startTime: string;
  endTime: string;
  weeks: number;
  offer: { kind: Offer['kind']; value: number | null };
  targetLevel: QuickTargetLevel;
  targetId: string;
  announce?: AnnounceSettings | null;
}

export const createHappyHour = (body: HappyHourBody) =>
  api.post<QuickAction>('/insights/quick-actions/happy-hours', body).then((r) => r.data);

/** The server's 400 detail for an offer below cost, when that is what it is. */
export function belowCostDetail(err: unknown): { code: string; floor?: number | null; offenders?: Offer['offenders'] } | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  const code = detail && typeof detail === 'object' ? (detail as { code?: string }).code : undefined;
  if (code === 'quick_promo_below_cost' || code === 'quick_promo_below_minimum') {
    return detail as { code: string; floor?: number | null; offenders?: Offer['offenders'] };
  }
  return null;
}
