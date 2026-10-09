/**
 * Stock over the hierarchy and targets — API calls (pos-server app/routers/stock_live.py, targets.py).
 */
import { api } from '@/lib/api';
import type { QuickRow, StockAlert, StockLevelName, StockNode, StockOp, TargetProgress, WizardEntry } from '@/lib/stockLive';

export interface StockTree {
  company: { id: string; name: string } | null;
  shops: {
    id: string;
    name: string;
    manageable: boolean;
    areas: { id: string; name: string }[];
    machines: { id: string; name: string; posNumber?: string | null; areaId: string | null; isKiosk: boolean }[];
  }[];
  narrowed: boolean;
}

export const stockKeys = {
  tree: (n: StockNode | null) => ['stock-live', 'tree', n?.level ?? null, n?.targetId ?? null] as const,
  quick: (n: StockNode | null, categoryId: string | null, q: string, productId: string | null = null) =>
    ['stock-live', 'quick', n?.level ?? null, n?.targetId ?? null, categoryId, q, productId] as const,
  alerts: (s: { companyId?: string | null; shopId?: string | null }) => ['stock-live', 'alerts', s.companyId ?? null, s.shopId ?? null] as const,
  settings: (scopeLevel: string, scopeId: string) => ['stock-live', 'settings', scopeLevel, scopeId] as const,
  resets: (s: { companyId?: string | null; shopId?: string | null }) => ['stock-live', 'resets', s.companyId ?? null, s.shopId ?? null] as const,
  leftover: (s: { companyId?: string | null; shopId?: string | null }, day: string | null) => ['stock-live', 'leftover', s.companyId ?? null, s.shopId ?? null, day] as const,
  targets: (s: { companyId?: string | null; shopId?: string | null }) => ['targets', s.companyId ?? null, s.shopId ?? null] as const,
  progress: (s: { companyId?: string | null; shopId?: string | null }) => ['targets', 'progress', s.companyId ?? null, s.shopId ?? null] as const,
};

export async function fetchTree(n: StockNode): Promise<StockTree> {
  return (await api.get('/stock/tree', { params: n })).data;
}

export async function fetchQuick(
  n: StockNode,
  opts: { categoryId?: string | null; q?: string; productId?: string | null } = {},
): Promise<{ rows: QuickRow[]; serverTime: string }> {
  return (
    await api.get('/stock/quick', {
      params: { ...n, categoryId: opts.categoryId || undefined, q: opts.q || undefined, productId: opts.productId || undefined },
    })
  ).data;
}

export async function postUpdate(body: StockNode & { productId: string; op: StockOp; quantity: number; note?: string }): Promise<{
  location: StockNode & { name: string | null; levelLabel: string };
  redirected: boolean;
  quantity: number;
}> {
  return (await api.post('/stock/update', body)).data;
}

export async function postTransfer(body: { productId: string; from: StockNode; to: StockNode; quantity: number; note?: string }) {
  return (await api.post('/stock/transfer', body)).data as { from: StockNode & { quantity: number }; to: StockNode & { quantity: number } };
}

export interface MovementRow {
  id: string;
  delta: number;
  reason: string;
  location: StockNode & { name: string | null };
  transferId: string | null;
  by: string | null;
  note: string | null;
  createdAt: string | null;
}

export async function fetchMovements(productId: string, n: StockNode): Promise<MovementRow[]> {
  return (await api.get('/stock/movements', { params: { productId, ...n } })).data;
}

export async function fetchAlerts(s: { companyId?: string | null; shopId?: string | null }): Promise<StockAlert[]> {
  return (await api.get('/stock/alerts', { params: { companyId: s.companyId || undefined, shopId: s.shopId || undefined } })).data;
}

export interface LevelRule {
  id: string;
  itemKind: 'category' | 'product' | null;
  itemId: string | null;
  itemName: string | null;
  levels: StockLevelName[];
}

export async function fetchSettings(scopeLevel: 'company' | 'shop', scopeId: string): Promise<{
  rules: LevelRule[];
  default: StockLevelName[];
  inherited?: { rules: LevelRule[] } | null;
}> {
  return (await api.get('/stock/settings', { params: { scopeLevel, scopeId } })).data;
}

export interface SwitchBody {
  scopeLevel: 'company' | 'shop';
  scopeId: string;
  itemKind: 'category' | 'product' | null;
  itemId: string | null;
  levels: StockLevelName[];
}

export async function previewSwitch(body: SwitchBody): Promise<{ levels: StockLevelName[]; products: number; newlyManaged: WizardEntry[]; stranded: WizardEntry[] }> {
  return (await api.post('/stock/settings/preview', body)).data;
}

export async function applySwitch(
  body: SwitchBody & {
    openings: { productId: string; level: StockLevelName; targetId: string; quantity: number }[];
    transfers: { productId: string; from: StockNode; to: StockNode; quantity: number }[];
    writeOff: boolean;
    openingsConfirmed: boolean;
  },
) {
  return (await api.post('/stock/settings/apply', body)).data;
}

export async function putOpening(
  n: StockNode,
  items: { productId: string; openingQuantity?: number | null; dailyReset?: boolean; resetMode?: 'set' | 'top_up'; reorderMin?: number | null }[],
) {
  return (await api.put('/stock/opening', { ...n, items })).data as { updated: number };
}

export async function resetNow(n: StockNode) {
  return (await api.post('/stock/reset', n)).data as { id: string; items: number; businessDay: string };
}

export interface ResetRow {
  id: string;
  businessDay: string;
  trigger: 'schedule' | 'manual';
  by: string | null;
  runAt: string;
  items: number;
  location: StockNode & { name: string | null; levelLabel: string };
}

export async function fetchResets(s: { companyId?: string | null; shopId?: string | null }): Promise<ResetRow[]> {
  return (await api.get('/stock/resets', { params: { companyId: s.companyId || undefined, shopId: s.shopId || undefined } })).data;
}

export interface LeftoverRow {
  resetId: string;
  businessDay: string;
  closedDay: string;
  runAt: string;
  trigger: string;
  location: StockNode & { name: string | null };
  productId: string;
  productName: string | null;
  leftover: number;
  opening: number;
  mode: string;
  delta: number;
  shortfall: number | null;
}

export async function fetchLeftover(s: { companyId?: string | null; shopId?: string | null }, day?: string | null): Promise<LeftoverRow[]> {
  return (await api.get('/stock/leftover', { params: { companyId: s.companyId || undefined, shopId: s.shopId || undefined, day: day || undefined } })).data;
}

// ── Targets ──────────────────────────────────────────────────────────────────

export interface TargetRow {
  id: string;
  shopId: string;
  scope: 'shop' | 'area' | 'cashier';
  period: 'day' | 'event';
  areaId: string | null;
  posUserId: string | null;
  eventId: string | null;
  day: string | null;
  amount: number;
  dayStart: string;
  dayEnd: string;
  name: string | null;
  label: string;
}

export async function fetchTargets(s: { companyId?: string | null; shopId?: string | null }): Promise<TargetRow[]> {
  return (await api.get('/targets', { params: { companyId: s.companyId || undefined, shopId: s.shopId || undefined } })).data;
}

export async function fetchProgress(s: { companyId?: string | null; shopId?: string | null }): Promise<TargetProgress[]> {
  return (await api.get('/targets/progress', { params: { companyId: s.companyId || undefined, shopId: s.shopId || undefined } })).data;
}

export async function saveTarget(body: Partial<TargetRow> & { shopId: string; amount: number }, id?: string) {
  return id ? (await api.put(`/targets/${id}`, body)).data : (await api.post('/targets', body)).data;
}

export async function deleteTarget(id: string) {
  await api.delete(`/targets/${id}`);
}
