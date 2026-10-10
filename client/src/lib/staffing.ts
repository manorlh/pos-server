/**
 * "תחזית ואיוש" — the forecast per shop and the tills to open (pos-server `GET /insights/staffing`,
 * app/services/insights/staffing.py): the types and the pure rules — money (the API speaks
 * agorot), which shop the card shows, the summary line, the peak hours.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */

export interface StaffingHour {
  hour: number;
  net: number;
  docs: number;
  tills: number;
  short: boolean;
  partial?: boolean;
}

export interface StaffingShop {
  shopId: string;
  shopName: string;
  availableTills: number;
  capacityPerTill: number;
  capacitySource: 'history' | 'default';
  cashierShare: number;
  trendFactor: number | null;
  historyStart: string | null;
  today: {
    date: string;
    pacePct: number | null;
    factor: number;
    factorSource: 'pace' | 'trend' | 'none';
    actual: number;
    nextHours: StaffingHour[];
    nextHoursNet: number;
  };
  tomorrow: {
    date: string;
    weekday: number;
    net: number | null;
    docs: number | null;
    low: number | null;
    high: number | null;
    confidence: 'high' | 'medium' | 'low' | 'none';
    holiday: { name: string; factor: number } | null;
    hourly: StaffingHour[];
    peakTills: number;
    short: boolean;
  };
}

export interface StaffingReport {
  generatedAt: string;
  timezone: string;
  today: string;
  shops: StaffingShop[];
  totals: { tomorrowNet: number; nextHoursNet: number; tomorrowPeakTills: number };
}

/** Agorot → shekels. */
export function shekels(agorot: number | null | undefined): number | null {
  if (agorot === null || agorot === undefined || !Number.isFinite(agorot)) return null;
  return Math.round(agorot) / 100;
}

export function hourLabel(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
}

/** The shop the card shows: the asked one, else the busiest tomorrow, else the first. */
export function pickShop(report: StaffingReport | undefined, shopId?: string | null): StaffingShop | null {
  const shops = report?.shops ?? [];
  if (!shops.length) return null;
  if (shopId) return shops.find((s) => s.shopId === shopId) ?? shops[0];
  return [...shops].sort((a, b) => (b.tomorrow.net ?? -1) - (a.tomorrow.net ?? -1))[0];
}

/** Hours that need the most tills tomorrow, as ranges ("11:00–14:00"). */
export function peakRanges(hours: StaffingHour[]): string[] {
  const peak = Math.max(0, ...hours.map((h) => h.tills));
  if (peak <= 0) return [];
  const peakHours = hours.filter((h) => h.tills === peak).map((h) => h.hour).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const h of peakHours) {
    const last = ranges[ranges.length - 1];
    if (last && h === last[1] + 1) last[1] = h;
    else ranges.push([h, h]);
  }
  return ranges.map(([a, b]) => `${hourLabel(a)}–${hourLabel(b + 1)}`);
}

/** The opening span tomorrow: first and last hour with anything expected. */
export function openingSpan(hours: StaffingHour[]): { from: string; to: string } | null {
  const active = hours.filter((h) => h.docs > 0 || h.net > 0).map((h) => h.hour);
  if (!active.length) return null;
  return { from: hourLabel(active[0]), to: hourLabel(active[active.length - 1] + 1) };
}

export type StaffingNote = 'short' | 'noHistory' | 'defaultCapacity' | 'holiday';

/** What the card should warn about. */
export function staffingNotes(shop: StaffingShop): StaffingNote[] {
  const out: StaffingNote[] = [];
  if (shop.tomorrow.net === null) out.push('noHistory');
  else if (shop.capacitySource === 'default') out.push('defaultCapacity');
  if (shop.tomorrow.short) out.push('short');
  if (shop.tomorrow.holiday) out.push('holiday');
  return out;
}
