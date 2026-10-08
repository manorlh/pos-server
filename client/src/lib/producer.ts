/**
 * "עמדת מפיק" — the producer's portal and the owner's tab on the event (pos-server
 * app/routers/producer.py, app/routers/event_producers.py): the types and the pure rules —
 * who is a producer, where they land, the e-mail the owner types, the hourly chart rows,
 * the owner's settings ⇄ body.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */

export const PRODUCER_ROLE = 'producer_view';
export const PRODUCER_HOME = '/dashboard/producer';

export type ProducerPhase = 'upcoming' | 'live' | 'ended';

export interface ProducerEventCard {
  id: string;
  name: string;
  shopName: string | null;
  producerName: string | null;
  startsAt: string;
  endsAt: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timezone: string;
  phase: ProducerPhase;
  settlementEnabled: boolean;
}

export interface ProducerSummary {
  event: ProducerEventCard;
  now: string;
  totals: {
    net: number;
    sales: number;
    docs: number;
    refunds: number;
    refundsAmount: number;
    avgTicket: number | null;
    itemsSold: number;
  };
  hourly: { at: string; hour: string; date: string; net: number; docs: number }[];
  items: { key: string; name: string; quantity: number; revenue: number }[];
}

export interface ProducerVoucherBatch {
  batchId: string;
  name: string;
  eventName: string | null;
  issued: number;
  redeemedVouchers: number;
  redemptions: number;
  units: number;
  lastRedeemedAt: string | null;
}

export interface ProducerVouchers {
  event: ProducerEventCard;
  batches: ProducerVoucherBatch[];
  totals: { issued: number; redeemedVouchers: number; redemptions: number; units: number };
  byHour: { hour: string; redemptions: number }[];
}

export interface ProducerSettlement {
  event: ProducerEventCard;
  basis: 'redemption';
  rows: (ProducerVoucherBatch & { productionPrice: number | null; amount: number | null })[];
  totalAmount: number;
  missingPrices: boolean;
  redeemedVouchers: number;
}

// ── The owner's tab ──────────────────────────────────────────────────────────

export interface ProducerGrant {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  signedIn: boolean;
  active: boolean;
  createdAt: string | null;
  revokedAt: string | null;
}

export interface ProducerSettings {
  settlementEnabled: boolean;
  batchIds: string[];
  productionPrices: Record<string, number | string>;
}

export interface ProducerBatchOption {
  id: string;
  name: string;
  eventName: string | null;
  customerName: string | null;
  linked: boolean;
  auto: boolean;
  productionPrice: number | null;
  createdAt: string | null;
}

export interface ProducerOwnerView {
  grants: ProducerGrant[];
  settings: ProducerSettings;
  batches: ProducerBatchOption[];
  inviteUrl?: string;
}

// ── Rules ────────────────────────────────────────────────────────────────────

export function isProducer(role: string | null | undefined): boolean {
  return role === PRODUCER_ROLE;
}

/** A producer is kept on their portal: anything else under the dashboard goes home. */
export function producerRedirect(pathname: string): string | null {
  if (pathname === PRODUCER_HOME || pathname.startsWith(`${PRODUCER_HOME}/`)) return null;
  return PRODUCER_HOME;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validEmail(text: string): boolean {
  const t = text.trim();
  return t.length <= 255 && EMAIL.test(t);
}

/** The event to open straight away: the only one, else the live one when exactly one is live. */
export function autoOpen(events: ProducerEventCard[]): string | null {
  if (events.length === 1) return events[0].id;
  const live = events.filter((e) => e.phase === 'live');
  return live.length === 1 ? live[0].id : null;
}

/** The hours with their share of the best hour (for a bar list), labelled with the day when the event spans days. */
export function hourlyBars(hourly: ProducerSummary['hourly']): { label: string; net: number; docs: number; pct: number }[] {
  const days = new Set(hourly.map((h) => h.date));
  const max = Math.max(0, ...hourly.map((h) => h.net));
  return hourly.map((h) => ({
    label: days.size > 1 ? `${h.date.slice(8, 10)}/${h.date.slice(5, 7)} ${h.hour}` : h.hour,
    net: h.net,
    docs: h.docs,
    pct: max > 0 ? Math.max(0, Math.round((h.net / max) * 100)) : 0,
  }));
}

/** The owner's settings as the server takes them: prices as numbers, empty ones dropped. */
export function settingsBody(s: ProducerSettings): ProducerSettings {
  const prices: Record<string, number> = {};
  for (const [id, raw] of Object.entries(s.productionPrices)) {
    const text = String(raw ?? '').replace(/[₪,\s]/g, '');
    if (text === '') continue;
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0) prices[id] = n;
  }
  return { settlementEnabled: s.settlementEnabled, batchIds: [...new Set(s.batchIds)], productionPrices: prices };
}

/** A typed price is fine: empty, or a number ≥ 0 with up to two decimals. */
export function validPrice(raw: string | number | null | undefined): boolean {
  const text = String(raw ?? '').replace(/[₪,\s]/g, '');
  return text === '' || /^\d+(\.\d{1,2})?$/.test(text);
}
