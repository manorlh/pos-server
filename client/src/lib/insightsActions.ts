/**
 * Insights' actions — the logic of the sheets (docs/SPEC_INSIGHTS.md §10): which targets a
 * quick message / promotion offers, the durations, the prefilled texts, a happy hour's
 * schedule, how an action's result reads, and the attention items (anomalies + slow
 * products) with their actions. No React here: tested on its own (insightsActions.test.ts).
 *
 * Money is integer agorot, as the server sends it.
 */

export type QuickTargetLevel = 'company' | 'shop' | 'area' | 'machine' | 'event';

/** Where the manager stands: the cockpit's / the insights page's scope. */
export interface ActionScope {
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  eventId?: string;
}

/** What the action is about: a product, a till, a category. */
export interface ActionContext {
  productId?: string;
  machineId?: string;
  categoryId?: string;
}

/** Every sheet's props (the cockpit mounts a sheet and unmounts it on `onDone`). */
export interface ActionSheetProps {
  scope: ActionScope;
  context?: ActionContext;
  onDone: () => void;
}

export interface TargetOption {
  level: QuickTargetLevel;
  id: string;
  name: string;
}

export interface TargetLookup {
  companies: { id: string; name: string }[];
  shops: { id: string; name: string; companyId?: string | null }[];
  machines: { id: string; name: string; shopId?: string | null; areaId?: string | null; areaName?: string | null }[];
  event?: { id: string; name: string } | null;
  areaName?: string | null;
}

/**
 * The targets a sheet offers, narrowest first: the till (the context's, else the scope's),
 * its point of sale, the event, the shop, the company. With nothing narrower than the whole
 * organization, every shop (a message has no "everything" level).
 */
export function targetOptions(scope: ActionScope, context: ActionContext | undefined, lookup: TargetLookup): TargetOption[] {
  const out: TargetOption[] = [];
  const add = (level: QuickTargetLevel, id: string | null | undefined, name: string | null | undefined) => {
    if (!id || out.some((o) => o.level === level && o.id === id)) return;
    out.push({ level, id, name: name || id.slice(0, 8) });
  };
  const machineId = context?.machineId ?? scope.machineId;
  const machine = machineId ? lookup.machines.find((m) => m.id === machineId) : undefined;
  if (machineId) add('machine', machineId, machine?.name);
  const areaId = scope.areaId ?? (machine?.areaId || undefined);
  if (areaId) add('area', areaId, scope.areaId ? lookup.areaName : machine?.areaName);
  if (scope.eventId) add('event', scope.eventId, lookup.event?.name);
  const shopId = scope.shopId ?? (machine?.shopId || undefined);
  const shop = shopId ? lookup.shops.find((s) => s.id === shopId) : undefined;
  if (shopId) add('shop', shopId, shop?.name);
  const companyId = scope.companyId ?? (shop?.companyId || undefined);
  if (companyId) add('company', companyId, lookup.companies.find((c) => c.id === companyId)?.name);
  if (out.length === 0) {
    for (const s of lookup.shops) add('shop', s.id, s.name);
    for (const c of lookup.companies) add('company', c.id, c.name);
  }
  return out;
}

export function targetKey(t: { level: string; id: string }): string {
  return `${t.level}:${t.id}`;
}

// ── Durations ────────────────────────────────────────────────────────────────

export type DurationChoice = 'end_of_day' | 'h2' | 'h4' | 'until';
export const DURATION_CHOICES: DurationChoice[] = ['end_of_day', 'h2', 'h4', 'until'];

export type DurationBody = { kind: 'end_of_day' } | { kind: 'hours'; hours: number } | { kind: 'until'; date: string };

/** The body's `duration` for a choice; null while "until" has no date. */
export function durationBody(choice: DurationChoice, untilDate?: string): DurationBody | null {
  switch (choice) {
    case 'end_of_day':
      return { kind: 'end_of_day' };
    case 'h2':
      return { kind: 'hours', hours: 2 };
    case 'h4':
      return { kind: 'hours', hours: 4 };
    case 'until':
      return untilDate && /^\d{4}-\d{2}-\d{2}$/.test(untilDate) ? { kind: 'until', date: untilDate } : null;
  }
}

/** "YYYY-MM-DD" n days from `from` (local calendar). */
export function addDays(from: string, n: number): string {
  const [y, m, d] = from.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

// ── Texts ────────────────────────────────────────────────────────────────────

export const MESSAGE_MAX = 500;

/** "הציעו ללקוחות: <מוצר> — <טקסט>" — the owner's quick message. */
export function productPitch(productName: string, line: string): string {
  return `הציעו ללקוחות: ${productName.trim()} — ${line.trim()}`.slice(0, MESSAGE_MAX);
}

export type AnomalyType = 'till_low_sales' | 'till_avg_ticket' | 'till_cash';

/** A prefilled line for a message to a till that stands out (the manager edits it). */
export function anomalyMessage(type: string): string {
  switch (type) {
    case 'till_low_sales':
      return 'הקופה שקטה יחסית — הזמינו לקוחות לקופה והציעו את המבצעים של היום.';
    case 'till_avg_ticket':
      return 'שימו לב לסכומים בקופה: ודאו שכל פריט נסרק בכמות ובמחיר הנכונים.';
    case 'till_cash':
      return 'נא לספור את המגירה ולוודא שכל תשלום במזומן נרשם בקופה.';
    default:
      return '';
  }
}

export interface OfferView {
  kind: 'percent' | 'second_half' | 'fixed_price';
  value: number | null;
  newPrice?: number;
  effectivePct: number;
  belowCost: boolean;
}

/** No unit is ever sold under ₪1 (agorot) — the server's rule too. */
export const MIN_UNIT_PRICE = 100;

/**
 * A fixed price typed in the sheet (shekels), checked as the server does: below the price,
 * every shop's unit (`minPrice` less the same amount off) at least ₪1, and not under the
 * cost's floor. Agorot in and out; null when it is not a number.
 */
export function checkFixedPrice(
  input: string,
  pricing: { price: number; minPrice: number; floor: number | null },
): { value: number; lowest: number; belowCost: boolean; tooLow: boolean; refused: boolean } | null {
  const shekels = parseFloat(input);
  if (!Number.isFinite(shekels)) return null;
  const value = Math.floor(Math.round(shekels * 1000) / 10);
  if (value <= 0 || value >= pricing.price) return null;
  const lowest = pricing.minPrice - (pricing.price - value);
  const belowCost = pricing.floor !== null && lowest < pricing.floor;
  const tooLow = lowest < MIN_UNIT_PRICE || value < MIN_UNIT_PRICE;
  return { value, lowest, belowCost, tooLow, refused: belowCost || tooLow };
}

export function offerKey(o: { kind: string; value: number | null }): string {
  return `${o.kind}:${o.value ?? ''}`;
}

/** "15% הנחה" / "השני ב-50%" / "₪9 ליחידה". */
export function offerLabel(o: { kind: string; value: number | null; newPrice?: number }): string {
  if (o.kind === 'percent') return `${trimNumber(o.value ?? 0)}% הנחה`;
  if (o.kind === 'second_half') return 'השני ב-50%';
  return `₪${trimNumber((o.newPrice ?? o.value ?? 0) / 100)} ליחידה`;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export const WEEKDAY_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export interface AnnouncedPromotion {
  name: string;
  type: string;
  config: {
    discountKind?: string;
    discountValue?: number;
    buyQuantity?: number;
    getQuantity?: number;
    getDiscountPercent?: number;
    quantity?: number;
    price?: number;
    target?: { all?: boolean };
  };
  weekdays?: number[] | null;
  startTime?: string | null;
  endTime?: string | null;
  validTo?: string | null;
}

/**
 * The cashiers' announcement, prefilled from the promotion (the server builds the same
 * when it is left empty): "מבצע: <שם> — <הצעה> על <מוצרים> · <ימים> · <שעות> · עד <תאריך>".
 */
export function announcementText(p: AnnouncedPromotion, productNames: string[] = []): string {
  const c = p.config ?? {};
  let offer = p.name;
  if (p.type === 'fixed_price') {
    offer = `₪${trimNumber(c.price ?? 0)} ליחידה`;
  } else if (p.type === 'discount') {
    offer = c.discountKind === 'amount' ? `₪${trimNumber(c.discountValue ?? 0)} הנחה ליחידה` : `${trimNumber(c.discountValue ?? 0)}% הנחה`;
  } else if (p.type === 'buy_x_get_y') {
    const pct = c.getDiscountPercent ?? 100;
    offer = `קנו ${c.buyQuantity ?? 1} וקבלו ${c.getQuantity ?? 1} ${pct >= 100 ? 'חינם' : `ב-${trimNumber(pct)}% הנחה`}`;
  } else if (p.type === 'bundle_price') {
    offer = `${c.quantity ?? 2} ב-₪${trimNumber(c.price ?? 0)}`;
  } else if (p.type === 'combo') {
    offer = `קומבו ב-₪${trimNumber(c.price ?? 0)}`;
  }
  let text = `מבצע: ${p.name.trim()} — ${offer}`;
  const what = productNames.slice(0, 3).join(', ') || (c.target?.all ? 'כל המוצרים' : '');
  if (what) text += ` על ${what}`;
  const parts: string[] = [];
  const days = p.weekdays ?? [];
  if (days.length && days.length < 7) parts.push(`ימים ${[...days].sort().map((d) => WEEKDAY_SHORT[d]).join(', ')}`);
  if (p.startTime && p.endTime) parts.push(`${p.startTime}–${p.endTime}`);
  if (p.validTo) {
    const [, m, d] = p.validTo.split('-');
    parts.push(`עד ${d}/${m}`);
  }
  if (parts.length) text += ` · ${parts.join(' · ')}`;
  return text.slice(0, MESSAGE_MAX);
}

export function endAnnouncementText(name: string): string {
  return `המבצע הסתיים: ${name.trim()}`.slice(0, MESSAGE_MAX);
}

// ── Happy hour ───────────────────────────────────────────────────────────────

export interface HappyHourDraft {
  weekdays: number[];
  startTime: string;
  endTime: string;
  weeks: number;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Why a happy hour cannot be created yet (a message key), or null. */
export function happyHourProblem(d: HappyHourDraft): 'needDays' | 'badTime' | 'sameTimes' | 'badWeeks' | null {
  if (!d.weekdays.length || d.weekdays.some((w) => w < 0 || w > 6)) return 'needDays';
  if (!HHMM.test(d.startTime) || !HHMM.test(d.endTime)) return 'badTime';
  if (d.startTime === d.endTime) return 'sameTimes';
  if (!Number.isInteger(d.weeks) || d.weeks < 1 || d.weeks > 12) return 'badWeeks';
  return null;
}

/** A window whose end is before its start runs past midnight (and belongs to the day it starts). */
export function crossesMidnight(startTime: string, endTime: string): boolean {
  return HHMM.test(startTime) && HHMM.test(endTime) && endTime < startTime;
}

/** The last day of a happy hour that starts on `from` and runs `weeks` weeks. */
export function happyHourLastDay(from: string, weeks: number): string {
  return addDays(from, 7 * weeks - 1);
}

export function hourLabel(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
}

export function weekdaysLabel(days: number[]): string {
  return [...days].sort().map((d) => WEEKDAY_SHORT[d] ?? '').join(', ');
}

// ── Results ──────────────────────────────────────────────────────────────────

export interface ActionResult {
  dataArrived: boolean;
  hours: number;
  since?: { units: number; net: number };
  before?: { units: number; net: number };
  lastWeek?: { units: number; net: number };
  changePct?: number | null;
  changePctLastWeek?: number | null;
  applications?: number;
}

export type ResultState = 'waiting' | 'up' | 'down' | 'flat' | 'new' | 'none';

/**
 * How an action's result reads: waiting for the tills' data; then up / down / flat against
 * the same hours before (±5% is flat), or "new" when nothing sold before.
 */
export function resultState(r: ActionResult | null | undefined): ResultState {
  if (!r) return 'none';
  if (!r.dataArrived) return 'waiting';
  if (!r.since) return 'none';
  const before = r.before?.units ?? 0;
  const since = r.since.units;
  if (before === 0) return since > 0 ? 'new' : 'flat';
  const pct = r.changePct ?? ((since - before) / before) * 100;
  if (pct > 5) return 'up';
  if (pct < -5) return 'down';
  return 'flat';
}

// ── The attention feed: anomalies and slow products, each with its actions ───

export type AttentionActionId = 'quickMessage' | 'quickPromo' | 'openMachine';
export type AttentionSeverity = 'critical' | 'warning' | 'opportunity' | 'positive' | 'info';

export interface AttentionAction {
  labelKey: string;
  actionId: AttentionActionId;
  context: ActionContext;
}

export interface AnomalyCardLike {
  id: string;
  type: string;
  severity: AttentionSeverity;
  params: Record<string, unknown>;
}

export interface SlowItemLike {
  key: string;
  productId: string | null;
  name: string;
}

/** A till card: open its details, message it. */
export function anomalyActions(card: AnomalyCardLike): AttentionAction[] {
  const machineId = typeof card.params.machineId === 'string' ? card.params.machineId : undefined;
  if (!machineId) return [];
  return [
    { labelKey: 'insightsActions.actions.openMachine', actionId: 'openMachine', context: { machineId } },
    { labelKey: 'insightsActions.actions.messageTill', actionId: 'quickMessage', context: { machineId } },
  ];
}

/** A slow product: the quick message and the quick promotion. */
export function slowActions(item: { productId: string | null }): AttentionAction[] {
  if (!item.productId) return [];
  return [
    { labelKey: 'insightsActions.actions.quickMessage', actionId: 'quickMessage', context: { productId: item.productId } },
    { labelKey: 'insightsActions.actions.quickPromo', actionId: 'quickPromo', context: { productId: item.productId } },
  ];
}

const SEVERITY_ORDER: AttentionSeverity[] = ['critical', 'warning', 'opportunity', 'positive', 'info'];

/** Anomalies first (by severity), then up to `maxSlow` slow products as opportunities. */
export function orderAttention<T extends { severity: AttentionSeverity }>(anomalies: T[], slow: T[], maxSlow = 3): T[] {
  const sorted = [...anomalies].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return [...sorted, ...slow.slice(0, maxSlow)];
}

export interface ScopeQuery {
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  eventId?: string;
}

/** The scope as the insights' query parameters (the server narrows within the caller's role). */
export function scopeQuery(scope: ActionScope): ScopeQuery {
  if (scope.eventId) return { eventId: scope.eventId, ...(scope.machineId ? { machineId: scope.machineId } : {}) };
  if (scope.machineId) return { machineId: scope.machineId };
  if (scope.areaId && scope.shopId) return { shopId: scope.shopId, areaId: scope.areaId };
  if (scope.shopId) return { shopId: scope.shopId };
  if (scope.companyId) return { companyId: scope.companyId };
  return {};
}
