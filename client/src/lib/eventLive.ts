/**
 * "מצב אירוע חי" — the event's live screen (pos-server `GET /report-events/{id}/live`,
 * app/services/report_events/live.py): the types and the pure rules of the big screen —
 * how often it refreshes, the countdown and ETA words, the chart rows, the target the
 * manager types, the tone of each figure, and Ably's server-sent events URL when push is on.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */
import { formatTime } from './format';

export type LivePhase = 'upcoming' | 'live' | 'ended';
export type LiveBucket = 1 | 5;

export interface LiveEventBlock {
  id: string;
  name: string;
  shopId: string;
  shopName: string | null;
  startsAt: string;
  endsAt: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timezone: string;
  status: 'draft' | 'confirmed';
  producerName: string | null;
  machineIds: string[];
}

export interface LivePoint {
  at: string;
  net: number;
  docs: number;
}

export interface LiveTill {
  machineId: string;
  name: string;
  posNumber: string | null;
  online: boolean;
  lastSeenAt: string | null;
  net: number;
  sales: number;
  docs: number;
  lastSaleAt: string | null;
  pendingDocuments: number | null;
  pendingAsOf: string | null;
}

export interface LiveItem {
  key: string;
  name: string;
  quantity: number;
  revenue: number;
}

export interface LiveTarget {
  amount: number;
  source: 'targets' | 'event';
  progressPct: number | null;
  remaining: number;
  reached: boolean;
  etaMinutes: number | null;
  etaAt: string | null;
  onPace: boolean;
}

export interface LivePace {
  projected: number | null;
  low: number | null;
  high: number | null;
  ratePerHour: number | null;
  recentRatePerHour: number | null;
  averageRatePerHour: number | null;
}

export interface LiveKds {
  openOrders: number;
  avgWaitMinutes: number | null;
  oldestWaitMinutes: number | null;
  lateOrders: number;
  lateMinutes: number;
  readyLastHour: number;
  avgPrepMinutesLastHour: number | null;
  maxPrepMinutesLastHour: number | null;
}

export interface LiveVouchers {
  redemptions: number;
  vouchers: number;
  units: number;
  lastHour: number;
  byBatch: { batchId: string; name: string; redemptions: number; vouchers: number; units: number }[];
}

export interface EventLive {
  event: LiveEventBlock;
  now: string;
  phase: LivePhase;
  elapsedMinutes: number;
  remainingMinutes: number;
  startsInMinutes: number | null;
  bucketMinutes: LiveBucket;
  totals: {
    net: number;
    sales: number;
    docs: number;
    refunds: number;
    refundsAmount: number;
    tips: number;
    avgTicket: number | null;
    docsPerHour: number | null;
    docsLastHour: number;
    netLastHour: number;
  };
  series: LivePoint[];
  target: LiveTarget | null;
  pace: LivePace;
  items: { lastHour: LiveItem[]; event: LiveItem[] };
  tills: LiveTill[];
  kds: LiveKds | null;
  vouchers: LiveVouchers;
  canSetTarget: boolean;
}

export interface CurrentLiveEvent extends LiveEventBlock {
  phase: LivePhase;
}

export interface LivePushInfo {
  enabled: boolean;
  channel: string;
  token?: string | null;
  expiresAt?: string | null;
}

// ── Refreshing ────────────────────────────────────────────────────────────────

/** Polling cadence: fast while live, slower with push connected (a safety net), slow otherwise. */
export function liveRefetchMs(phase: LivePhase | undefined, pushConnected: boolean): number {
  if (phase === 'live') return pushConnected ? 60_000 : 15_000;
  if (phase === 'upcoming') return 60_000;
  return 5 * 60_000;
}

/** Ably's server-sent events endpoint for one channel with a token (no client library needed). */
export function ablySseUrl(channel: string, token: string): string {
  const q = new URLSearchParams({ channels: channel, v: '1.2', accessToken: token, enveloped: 'false' });
  return `https://realtime.ably.io/sse?${q.toString()}`;
}

// ── Words ─────────────────────────────────────────────────────────────────────

/** "45 דק׳" / "2:05 שע׳" / "3 ימים" — for a countdown or an ETA. */
export function minutesText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} דק׳`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} שע׳`;
  return `${Math.round(m / (24 * 60))} ימים`;
}

/** ₪ without agorot, grouped ("₪12,480"), for the big screen. */
export function bigMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  const sign = amount < 0 ? '−' : '';
  return `${sign}₪${Math.round(Math.abs(amount)).toLocaleString('en-US')}`;
}

/** ₪12.5K / ₪1.2M — chart axes and tight tiles. */
export function compactMoney(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}₪${trim(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}₪${trim(abs / 1000)}K`;
  return `${sign}₪${Math.round(abs).toLocaleString('en-US')}`;
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

// ── The chart ────────────────────────────────────────────────────────────────

export interface ChartRow {
  label: string;
  net: number;
  docs: number;
  cumulative: number;
}

/** The series as chart rows: local clock labels and the running total of what the chart shows. */
export function chartRows(series: LivePoint[], timeZone: string): ChartRow[] {
  let running = 0;
  return series.map((p) => {
    running += p.net;
    return {
      label: formatTime(p.at, { timeZone }),
      net: Math.round(p.net * 100) / 100,
      docs: p.docs,
      cumulative: Math.round(running * 100) / 100,
    };
  });
}

/** The progress bar's fill: 0–100, never past the end. */
export function progressFill(pct: number | null | undefined): number {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** The pace against the target: reached / on pace = good, within 10% = warn, behind = bad. */
export function paceTone(live: Pick<EventLive, 'phase' | 'target' | 'pace'>): Tone {
  const target = live.target;
  if (!target) return 'neutral';
  if (target.reached) return 'good';
  const projected = live.pace.projected;
  if (live.phase !== 'live' || projected === null) return 'neutral';
  if (projected >= target.amount) return 'good';
  if (projected >= target.amount * 0.9) return 'warn';
  return 'bad';
}

/** Offline tills first (they need a look), then by net. */
export function orderTills(tills: LiveTill[]): LiveTill[] {
  return [...tills].sort((a, b) => Number(a.online) - Number(b.online) || b.net - a.net || a.name.localeCompare(b.name, 'he'));
}

/** Kitchen tone: anything late = bad; the oldest past half the late minutes = warn. */
export function kdsTone(kds: LiveKds | null): Tone {
  if (!kds) return 'neutral';
  if (kds.lateOrders > 0) return 'bad';
  if ((kds.oldestWaitMinutes ?? 0) >= kds.lateMinutes / 2) return 'warn';
  return 'good';
}

// ── The target the manager types ─────────────────────────────────────────────

/** "12,500" / "₪ 12500.50" → 12500.5; empty → null (clears); anything else → undefined (invalid). */
export function parseTargetInput(text: string): number | null | undefined {
  const cleaned = text.replace(/[₪,\s]/g, '');
  if (cleaned === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) return undefined;
  return n;
}

// ── Picking an event ─────────────────────────────────────────────────────────

/** The event to open straight away: the only live one (none, or several → let the person choose). */
export function autoOpenEvent(events: CurrentLiveEvent[]): string | null {
  const live = events.filter((e) => e.phase === 'live');
  return live.length === 1 ? live[0].id : null;
}
