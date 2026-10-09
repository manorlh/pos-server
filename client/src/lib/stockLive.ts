/**
 * Stock over the hierarchy (pos-server app/routers/stock_live.py) — the quick stock screen's pure
 * parts: nodes, location labels, quantities, the wizard's sums, the targets' words.
 */
import type { LiveItem } from './liveControl';

export type StockLevelName = 'company' | 'shop' | 'area' | 'group' | 'machine';

export const LEVEL_LABELS: Record<StockLevelName, string> = {
  company: 'חברה',
  shop: 'סניף',
  area: 'נקודת מכירה',
  group: 'קבוצת מכשירים',
  machine: 'קופה',
};

/** Top down: the order the settings and the picker list them. */
export const LEVELS_TOP_DOWN: StockLevelName[] = ['company', 'shop', 'area', 'machine'];

export interface StockNode {
  level: StockLevelName;
  targetId: string;
}

export interface StockLocation extends StockNode {
  name: string | null;
  levelLabel?: string;
  quantity: number;
  managed: boolean;
  reorderMin: number | null;
  low: boolean;
  openingQuantity: number | null;
  dailyReset: boolean;
  resetMode: 'set' | 'top_up';
}

export interface QuickRow {
  productId: string;
  productName: string;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  categoryId: string | null;
  managedLevels: StockLevelName[];
  total: number;
  updateTarget: (StockNode & { name: string | null; levelLabel: string }) | null;
  quantityAtTarget: number | null;
  low: boolean;
  locations: StockLocation[];
  blocks: { id: string; kind: 'sold_out' | 'blocked'; scope: string; scopeName: string | null; until: string | null; source: string }[];
  devicesSee: { state: 'available' | 'sold_out' | 'blocked'; reason: string | null } | null;
}

export function nodeKey(n: StockNode): string {
  return `${n.level}:${n.targetId}`;
}

/** The narrowest node a scope names: a till, a point of sale, a shop, a company. */
export function nodeOfScope(s: { companyId?: string | null; shopId?: string | null; areaId?: string | null; machineId?: string | null }): StockNode | null {
  if (s.machineId) return { level: 'machine', targetId: s.machineId };
  if (s.areaId) return { level: 'area', targetId: s.areaId };
  if (s.shopId) return { level: 'shop', targetId: s.shopId };
  if (s.companyId) return { level: 'company', targetId: s.companyId };
  return null;
}

export function parseNodeKey(key: string | null | undefined): StockNode | null {
  if (!key) return null;
  const [level, targetId] = key.split(':');
  if (!targetId || !(level in LEVEL_LABELS)) return null;
  return { level: level as StockLevelName, targetId };
}

/** "3", "2.5", "−1" — quantities as the floor reads them (no trailing zeros, a real minus). */
export function formatQty(q: number | null | undefined): string {
  if (q == null || Number.isNaN(q)) return '—';
  const rounded = Math.round(q * 1000) / 1000;
  const text = Number.isInteger(rounded) ? String(Math.abs(rounded)) : String(Math.abs(rounded)).replace(/0+$/, '');
  return rounded < 0 ? `−${text}` : text;
}

/** "סניף · הרצליה", "נקודת מכירה · בר". */
export function locationLabel(l: { level: StockLevelName; name?: string | null }): string {
  const base = LEVEL_LABELS[l.level] ?? l.level;
  return l.name ? `${base} · ${l.name}` : base;
}

/** The managed levels as words, top down: "סניף + נקודת מכירה". */
export function levelsLabel(levels: StockLevelName[]): string {
  return LEVELS_TOP_DOWN.filter((l) => levels.includes(l)).map((l) => LEVEL_LABELS[l]).join(' + ') || LEVEL_LABELS.shop;
}

/** A quantity typed in a field: a number (a comma is a decimal point), or null. */
export function parseQty(text: string, { allowNegative = false } = {}): number | null {
  const t = text.trim().replace(',', '.').replace('−', '-');
  if (!/^-?\d+(\.\d{1,3})?$/.test(t)) return null;
  const n = Number(t);
  if (!allowNegative && n < 0) return null;
  return n;
}

export type StockOp = 'add' | 'remove' | 'count' | 'receive' | 'wastage';

export const OP_LABELS: Record<StockOp, string> = {
  add: 'הוסף',
  remove: 'הורד',
  count: 'ספירה',
  receive: 'קבלת סחורה',
  wastage: 'פחת',
};

/** What the quantity becomes after an op (for the sheet's preview). */
export function afterOp(current: number, op: StockOp, quantity: number): number {
  if (op === 'count') return quantity;
  if (op === 'add' || op === 'receive') return current + quantity;
  return current - quantity;
}

// ── The switch wizard ────────────────────────────────────────────────────────

export interface WizardEntry {
  productId: string;
  productName: string;
  quantity: number;
  location: StockNode & { name: string | null; levelLabel: string };
}

/** Every stranded location's quantity, summed per product (what must move or be written off). */
export function strandedByProduct(stranded: WizardEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of stranded) out.set(s.productId, (out.get(s.productId) ?? 0) + s.quantity);
  return out;
}

/** One wizard row's key: the product and its location. */
export function entryKey(e: { productId: string; location: StockNode }): string {
  return `${e.productId}|${nodeKey(e.location)}`;
}

/** A transfer the owner adds under a stranded location: where to (a node key) and how much (typed). */
export interface WizardLine {
  to: string;
  quantity: string;
}

export interface WizardPlan {
  openings: { productId: string; level: StockLevelName; targetId: string; quantity: number }[];
  transfers: { productId: string; from: StockNode; to: StockNode; quantity: number }[];
  /** Per stranded row: what is left there after its transfers (to transfer or write off). */
  remaining: Map<string, number>;
  /** Newly managed locations with neither an opening count nor a transfer in: they start at 0. */
  unfilled: number;
  /** Why it cannot be applied yet, in the owner's words (null: it can). */
  problem: string | null;
}

/**
 * The switch wizard's plan from what the owner typed: openings for newly managed locations, transfers
 * out of locations no longer managed, and whether it may be applied — nothing left behind unless
 * written off explicitly, nothing moved that is not there, new locations at 0 only when confirmed.
 */
export function wizardPlan(
  preview: { newlyManaged: WizardEntry[]; stranded: WizardEntry[] },
  openings: Record<string, string>,
  lines: Record<string, WizardLine[]>,
  { writeOff, confirmZero }: { writeOff: boolean; confirmZero: boolean },
): WizardPlan {
  const plan: WizardPlan = { openings: [], transfers: [], remaining: new Map(), unfilled: 0, problem: null };
  const filled = new Set<string>();
  let badLine = false;
  let overdrawn = false;
  for (const s of preview.stranded) {
    const key = entryKey(s);
    let moved = 0;
    for (const line of lines[key] ?? []) {
      if (!line.to && !line.quantity.trim()) continue;
      const to = parseNodeKey(line.to);
      const qty = parseQty(line.quantity);
      if (!to || qty == null || qty <= 0) {
        badLine = true;
        continue;
      }
      moved += qty;
      plan.transfers.push({ productId: s.productId, from: { level: s.location.level, targetId: s.location.targetId }, to, quantity: qty });
      filled.add(`${s.productId}|${nodeKey(to)}`);
    }
    const left = Math.round((s.quantity - moved) * 1000) / 1000;
    if (left < 0 && moved > 0) overdrawn = true;
    plan.remaining.set(key, left);
  }
  for (const n of preview.newlyManaged) {
    const key = entryKey(n);
    const typed = (openings[key] ?? '').trim();
    if (typed) {
      const qty = parseQty(typed);
      if (qty == null) badLine = true;
      else {
        plan.openings.push({ productId: n.productId, level: n.location.level, targetId: n.location.targetId, quantity: qty });
        filled.add(key);
      }
    }
    if (!filled.has(key)) plan.unfilled += 1;
  }
  const leftBehind = [...plan.remaining.values()].some((v) => v !== 0);
  if (badLine) plan.problem = 'יש שורה עם כמות או יעד לא תקינים';
  else if (overdrawn) plan.problem = 'הועברה כמות גדולה ממה שיש במיקום';
  else if (leftBehind && !writeOff) plan.problem = 'נשאר מלאי במיקומים שלא ינוהלו יותר — העבירו אותו או אשרו מחיקה';
  else if (plan.unfilled > 0 && !confirmZero) plan.problem = 'למיקומים החדשים נדרשת ספירת פתיחה או העברה (או אישור שהם מתחילים מ-0)';
  return plan;
}

// ── Low-stock alerts ─────────────────────────────────────────────────────────

export interface StockAlert {
  id: string;
  kind: 'low' | 'out';
  productId: string;
  productName: string | null;
  location: StockNode & { name: string | null; levelLabel: string };
  shopId?: string | null;
  areaId?: string | null;
  quantity: number;
  threshold: number | null;
  suggestTransfer: (StockNode & { name: string | null; quantity: number }) | null;
  raisedAt: string | null;
}

/** "מלאי נמוך בבר: קולה", "אזל במחסן: קולה". */
export function alertTitle(a: StockAlert): string {
  const where = a.location.name ?? LEVEL_LABELS[a.location.level];
  return `${a.kind === 'out' ? 'אזל ב' : 'מלאי נמוך ב'}${where}: ${a.productName ?? ''}`.trim();
}

/** "נשארו 2 (מינימום 10) · מומלץ להעביר 8 מהסניף". */
export function alertBody(a: StockAlert): string {
  const base = `נשארו ${formatQty(a.quantity)}${a.threshold != null ? ` (מינימום ${formatQty(a.threshold)})` : ''}`;
  if (!a.suggestTransfer || a.suggestTransfer.quantity <= 0) return base;
  return `${base} · מומלץ להעביר ${formatQty(a.suggestTransfer.quantity)} מ${a.suggestTransfer.name ?? LEVEL_LABELS[a.suggestTransfer.level]}`;
}

/** The Manager Cockpit's items for open stock alerts: transfer the suggestion, update, block. */
export function lowStockItems(alerts: StockAlert[]): LiveItem[] {
  return alerts.map((a) => {
    const actions: LiveItem['actions'] = [];
    if (a.suggestTransfer && a.suggestTransfer.quantity > 0) {
      actions.push({
        labelKey: 'liveControl.transferSuggested',
        actionId: 'stock.transfer',
        context: {
          productId: a.productId,
          fromLevel: a.suggestTransfer.level,
          fromTargetId: a.suggestTransfer.targetId,
          toLevel: a.location.level,
          toTargetId: a.location.targetId,
          quantity: a.suggestTransfer.quantity,
        },
      });
    }
    actions.push({ labelKey: 'liveControl.updateStock', actionId: 'stock.update', context: { productId: a.productId, level: a.location.level, targetId: a.location.targetId } });
    actions.push({ labelKey: 'liveControl.block', actionId: 'block.create', context: { productId: a.productId, shopId: a.shopId ?? null } });
    return {
      id: `stock:${a.id}`,
      severity: a.kind === 'out' ? 'critical' : 'warning',
      title: alertTitle(a),
      body: alertBody(a),
      actions,
    };
  });
}

// ── Targets ──────────────────────────────────────────────────────────────────

export interface TargetProgress {
  targetId: string;
  label: string;
  scope: 'shop' | 'area' | 'cashier';
  period: 'day' | 'event';
  amount: number;
  actual: number;
  percent: number | null;
  forecast: number | null;
  forecastReaches: boolean | null;
  elapsed: number;
  reached: boolean;
}

export function shekels(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `₪${Math.round(v).toLocaleString('en-US')}`;
}

/** "בקצב הנוכחי: ₪6,100 עד סוף היום" (an event: "עד סוף האירוע"), "מוקדם מדי לחזות", or that it is over. */
export function paceLine(p: Pick<TargetProgress, 'forecast' | 'period' | 'elapsed'>): string {
  const end = p.period === 'event' ? 'עד סוף האירוע' : 'עד סוף היום';
  if (p.elapsed >= 1) return p.period === 'event' ? 'האירוע הסתיים' : 'היום הסתיים';
  if (p.forecast == null) return 'מוקדם מדי לחזות';
  return `בקצב הנוכחי: ${shekels(p.forecast)} ${end}`;
}

/** 0–100 for the bar (over 100 stays full). */
export function barPercent(p: Pick<TargetProgress, 'actual' | 'amount'>): number {
  if (!p.amount || p.amount <= 0) return 0;
  return Math.max(0, Math.min(100, (p.actual / p.amount) * 100));
}

export function targetTone(p: Pick<TargetProgress, 'reached' | 'forecastReaches'>): 'ok' | 'on_track' | 'behind' | 'unknown' {
  if (p.reached) return 'ok';
  if (p.forecastReaches == null) return 'unknown';
  return p.forecastReaches ? 'on_track' : 'behind';
}
