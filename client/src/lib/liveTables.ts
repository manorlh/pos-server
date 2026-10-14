/**
 * "שולחנות פתוחים — חי" and "כרטיס שולחן" (P:/specs/live-tables-cloud.md §1–§4, §6; pos-server
 * app/services/table_actions.py, app/services/table_card.py): the pure pieces of the live floor and the
 * table card — a table's colour as the till draws it, the next course's countdown, the filters that dim
 * the rest, the zones' counts, a grid zone's cells, the map's zoom, how often to refresh, and an action
 * sent to a till as the card follows it.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

// ── A table's state, as the till's floor colours it ──────────────────────────

/**
 * The till's words for a table (pos-android domain/TableFloor.kt `tableBadge`, ui/tables/TableVisuals.kt),
 * most pressing first: at another till, the bill printed ("לתשלום"), sat past the red mark ("חריגת זמן"),
 * sent to the kitchen, seated; paid and waiting to be cleared; free.
 */
export type VisualState = 'other_till' | 'to_pay' | 'overdue' | 'kitchen' | 'occupied' | 'cleaning' | 'free';
export const VISUAL_STATES: VisualState[] = ['occupied', 'kitchen', 'to_pay', 'other_till', 'overdue', 'cleaning', 'free'];

/**
 * The colours (the till's modern look, `modernBadgeColor` / `stateRing`): a free table quiet slate,
 * occupied blue, the kitchen orange, to pay amber, at another till violet, overdue red.
 */
export const STATE_COLOR: Record<VisualState, string> = {
  free: '#94a3b8',
  occupied: '#2563eb',
  kitchen: '#f97316',
  to_pay: '#d97706',
  other_till: '#7c3aed',
  overdue: '#dc2626',
  cleaning: '#64748b',
};

/**
 * How loudly a table stands out (TableFloor.kt `TableEmphasis`): its tint over the table's white and its
 * edge's width. Free: no colour; cleaning: the edge only; seated: a light tint; to pay / overdue: stronger.
 */
export const STATE_EMPHASIS: Record<VisualState, { tint: number; edge: number }> = {
  free: { tint: 0, edge: 1 },
  cleaning: { tint: 0, edge: 1.5 },
  occupied: { tint: 0.1, edge: 2 },
  kitchen: { tint: 0.1, edge: 2 },
  other_till: { tint: 0.1, edge: 2 },
  to_pay: { tint: 0.18, edge: 3 },
  overdue: { tint: 0.18, edge: 3 },
};

export interface StateInput {
  /** The cloud's word: free | occupied | sent | awaiting_payment | locked (another till inside). */
  state: string;
  order: { billPrintedAt?: string | null; sendCount?: number | null; openedAt?: string | null } | null;
  cleaningSince?: string | null;
}

/** Whole minutes from `iso` to `nowMs` (never negative); null when the time cannot be read. */
export function minutesSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}

/** The table's colour word, the till's order: another till; to pay; overdue; the kitchen; seated; cleaning; free. */
export function visualState(t: StateInput, nowMs: number, alertMinutes: number): VisualState {
  if (t.state === 'locked') return 'other_till';
  const o = t.order;
  if (o) {
    if (o.billPrintedAt) return 'to_pay';
    const minutes = minutesSince(o.openedAt, nowMs);
    if (minutes !== null && minutes >= alertMinutes) return 'overdue';
    if ((o.sendCount ?? 0) > 0) return 'kitchen';
    return 'occupied';
  }
  if (t.cleaningSince) return 'cleaning';
  return 'free';
}

/** The table's fill: its colour as a tint over white (`#rrggbb` at `tint`), in rgba. */
export function tintOf(color: string, tint: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m || tint <= 0) return '#ffffff';
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(255 + (c - 255) * tint);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/** "45 דק׳" or "1:20" — the time seated, as the till writes it (`seatedParts`). */
export function seatedText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} דק׳`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** A total as a table on the floor writes it: "₪248", "₪64.50" — no agorot when there are none. */
export function compactMoney(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return '₪0';
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  const text = whole ? Math.round(n).toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₪${text}`;
}

/** Who is inside the table: "2 (דנה)" — its till's number or name, and the employee. */
export function holderText(lock: { posNumber?: string | null; machineName?: string | null; posUserName?: string | null } | null | undefined): string | null {
  if (!lock) return null;
  const till = lock.posNumber || lock.machineName || '?';
  const user = (lock.posUserName ?? '').trim();
  return user ? `${till} (${user})` : String(till);
}

// ── The next course ("עיקריות בעוד 6 ד׳") ──────────────────────────────────────

export interface NextCourse {
  courseId: string;
  name: string;
  paused: boolean;
  dueAt: string | null;
  trigger?: string | null;
  minutes?: number | null;
}

export type Countdown =
  | { kind: 'in'; minutes: number }
  | { kind: 'now' }
  | { kind: 'paused' }
  | { kind: 'waiting' };

/**
 * The tag on a table: in N minutes (rounded up — "בעוד 1 ד׳" until it goes), now (due: the cloud's pass
 * fires it within seconds), paused ("מושהה"), or waiting with no time (auto-fire off, nothing before it
 * sent, the KDS not ready yet).
 */
export function countdown(next: NextCourse | null | undefined, nowMs: number): Countdown | null {
  if (!next) return null;
  if (next.paused) return { kind: 'paused' };
  if (!next.dueAt) return { kind: 'waiting' };
  const due = Date.parse(next.dueAt);
  if (!Number.isFinite(due)) return { kind: 'waiting' };
  const left = due - nowMs;
  if (left <= 0) return { kind: 'now' };
  return { kind: 'in', minutes: Math.ceil(left / 60_000) };
}

// ── The filters: the rest dimmed, never hidden ────────────────────────────────

export interface FloorFilter {
  /** A waiter's name ("דנה"); null: every waiter. */
  waiter: string | null;
  /** States picked; empty: every state. */
  states: VisualState[];
}

export const NO_FILTER: FloorFilter = { waiter: null, states: [] };

export function filterActive(f: FloorFilter): boolean {
  return f.waiter !== null || f.states.length > 0;
}

/** Whether a table stands out under the filter (a waiter's filter picks their open tables only). */
export function matchesFilter(t: { order: { waiterName?: string | null } | null }, visual: VisualState, f: FloorFilter): boolean {
  if (f.waiter !== null && (t.order?.waiterName ?? null) !== f.waiter) return false;
  if (f.states.length > 0 && !f.states.includes(visual)) return false;
  return true;
}

/** Dimmed: a filter is on and the table is not one it picks. */
export function dimmed(t: { order: { waiterName?: string | null } | null }, visual: VisualState, f: FloorFilter): boolean {
  return filterActive(f) && !matchesFilter(t, visual, f);
}

/** The waiters with open tables, by name, for the filter. */
export function waitersOf(tables: { order: { waiterName?: string | null } | null }[]): string[] {
  const out = new Set<string>();
  for (const t of tables) {
    const name = t.order?.waiterName?.trim();
    if (name) out.add(name);
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'he'));
}

// ── Zones ─────────────────────────────────────────────────────────────────────

/** Open tables per zone, for its tab ("אולם · 4"). */
export function zoneCounts(tables: { zoneId: string; order: unknown | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    if (!(t.zoneId in out)) out[t.zoneId] = 0;
    if (t.order) out[t.zoneId] += 1;
  }
  return out;
}

/** A grid zone ("ריבועים"): its tables by number, row after row. */
export function gridCells<T extends { number: number }>(tables: T[], columns: number): { table: T; row: number; col: number }[] {
  const cols = Math.max(1, Math.floor(columns));
  return [...tables]
    .sort((a, b) => a.number - b.number)
    .map((table, i) => ({ table, row: Math.floor(i / cols), col: i % cols }));
}

/** How many grid cells of `cell` px fit across `width` px (at least 2, at most 12). */
export function gridColumns(width: number, cell = 132): number {
  if (!Number.isFinite(width) || width <= 0) return 4;
  return Math.min(12, Math.max(2, Math.floor(width / cell)));
}

// ── The map's zoom (fit to the width, pinch to zoom, drag to look around) ─────

export interface MapView {
  scale: number;
  x: number;
  y: number;
}

export const FIT: MapView = { scale: 1, x: 0, y: 0 };
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

/** The view kept inside the map: never smaller than the fitted map, never past its edges. */
export function clampView(v: MapView, width: number, height: number): MapView {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale));
  const minX = width - width * scale;
  const minY = height - height * scale;
  return {
    scale,
    x: Math.min(0, Math.max(minX, v.x)),
    y: Math.min(0, Math.max(minY, v.y)),
  };
}

/** Zoomed by `factor` about a point (px in the box): the point stays under the fingers. */
export function zoomAbout(v: MapView, factor: number, px: number, py: number, width: number, height: number): MapView {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
  const k = scale / v.scale;
  return clampView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, width, height);
}

/** Moved by a drag of (dx, dy) px. */
export function panBy(v: MapView, dx: number, dy: number, width: number, height: number): MapView {
  return clampView({ ...v, x: v.x + dx, y: v.y + dy }, width, height);
}

/** A press that moved less than this (px) is a tap on the table under it, not a drag. */
export const TAP_SLOP = 8;

export function isTap(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP;
}

// ── Refreshing ────────────────────────────────────────────────────────────────

/**
 * How often the live view polls: every 5 s without push; with Ably push connected, a slow safety net —
 * but every 5 s still while a LAN host's or a single till's tables are shown (their reports send no
 * signal).
 */
export function liveRefetchMs(pushConnected: boolean, hasTillOrders: boolean): number {
  if (!pushConnected || hasTillOrders) return 5_000;
  return 30_000;
}

// ── An action sent to a till, as the card follows it ──────────────────────────

/** `GET /device-commands/{id}` for a table action (pos-server table_actions.view). */
export interface ActionStatus {
  id: string;
  currentId: string;
  action: string;
  status: string;
  outcome: 'waiting' | 'done' | 'refused' | 'timeout' | 'failed' | 'cancelled';
  reason: string | null;
  heldBy?: string | null;
  retargeted: boolean;
  result?: Record<string, unknown> | null;
  hostName: string | null;
  tableLabel: string | null;
  /** "הדפס חשבון" on another till (bill-print-other-till §7): where it was to print. */
  printOnName?: string | null;
}

export type ActionPhase = 'sending' | 'done' | 'refused' | 'timeout' | 'failed';

export interface ActionView {
  phase: ActionPhase;
  /** A key under `tables.card.result`. */
  key: string;
  values?: Record<string, string>;
  /** The floor is stale: read it again. */
  refresh: boolean;
}

/** The refusals the card words (spec §6.7); any other is shown with its code. */
export const ACTION_REFUSALS = [
  'table_in_use',
  'table_not_open',
  'order_changed',
  'not_host',
  'payment_in_progress',
  'course_not_held',
  'course_already_out',
  'nothing_sent',
  'waiter_not_found',
  'target_not_free',
  'target_not_found',
  'source_not_open',
  'merge_basket_discount',
  'printer_not_found',
  // "הדפס חשבון" on another till (bill-print-other-till §7): it did not print there, nor anywhere.
  'print_target_unavailable',
] as const;

/** The 409s of a direct action besides the refusals (the cloud's own). */
export const DIRECT_ERRORS = [
  'table_busy',
  'remote_action_blocked',
  'table_order_not_open',
  // "הדפס חשבון" on another till: off for the till that holds the table, a till not offered, an older build.
  'remote_print_off',
  'print_target_not_found',
  'print_target_needs_update',
] as const;

/** Past the timeout by this much with no word from the cloud either: "לא זמינה" all the same. */
export const ACTION_GRACE_MS = 15_000;

/** The refusal's key, and whether the floor must be read again. */
export function refusalView(reason: string | null | undefined, heldBy?: string | null): ActionView {
  const r = reason ?? '';
  const known = (ACTION_REFUSALS as readonly string[]).includes(r);
  return {
    phase: 'refused',
    key: known ? `refused.${r}` : 'refused.other',
    values: known ? { till: heldBy ?? '?' } : { reason: r || '?' },
    refresh: r === 'order_changed' || r === 'table_not_open' || r === 'target_not_free' || r === 'source_not_open',
  };
}

/**
 * What the card shows for an action sent to a till: [status] as last read (null before the first read),
 * sent at [startedAtMs] with the till's [timeoutSeconds], now [nowMs].
 */
export function actionView(status: ActionStatus | null, startedAtMs: number, timeoutSeconds: number, nowMs: number): ActionView {
  const outcome = status?.outcome ?? 'waiting';
  switch (outcome) {
    case 'done':
      return { phase: 'done', key: `done.${status?.action ?? 'other'}`, refresh: true };
    case 'refused':
      return refusalView(status?.reason, status?.heldBy);
    case 'timeout':
    case 'cancelled':
      return { phase: 'timeout', key: 'timeout', refresh: false };
    case 'failed':
      return { phase: 'failed', key: 'failed', refresh: false };
    default:
      if (nowMs - startedAtMs > timeoutSeconds * 1000 + ACTION_GRACE_MS) {
        return { phase: 'timeout', key: 'timeout', refresh: false };
      }
      return { phase: 'sending', key: status?.retargeted ? 'retargeting' : 'sending', refresh: false };
  }
}

/** Still following it: poll again. */
export function stillWaiting(view: ActionView): boolean {
  return view.phase === 'sending';
}

/** A direct action's 409 as the card words it (null: not one of ours — the generic error). */
export function directErrorView(code: string | null, detail?: { till?: string | null } | null): ActionView | null {
  if (!code) return null;
  if ((ACTION_REFUSALS as readonly string[]).includes(code)) return refusalView(code, detail?.till ?? null);
  if ((DIRECT_ERRORS as readonly string[]).includes(code)) {
    return { phase: 'refused', key: `refused.${code}`, refresh: code === 'table_order_not_open' };
  }
  return null;
}

// ── The card's lines, by diner and course ─────────────────────────────────────

export interface CardLineLike {
  seat: number | null;
  seatName?: string | null;
  course: { id: string; name: string; order: number } | null;
}

export interface SeatGroup<L> {
  seat: number | null;
  seatName: string | null;
  courses: { course: { id: string; name: string; order: number } | null; lines: L[] }[];
}

/** The lines grouped by diner (the table's own first), then by course in the sequence (none last). */
export function groupLines<L extends CardLineLike>(lines: L[]): SeatGroup<L>[] {
  const seats = new Map<string, SeatGroup<L>>();
  for (const line of lines) {
    const key = line.seat === null ? '-' : String(line.seat);
    let group = seats.get(key);
    if (!group) {
      group = { seat: line.seat, seatName: line.seatName ?? null, courses: [] };
      seats.set(key, group);
    }
    if (!group.seatName && line.seatName) group.seatName = line.seatName;
    const ckey = line.course?.id ?? null;
    let bucket = group.courses.find((c) => (c.course?.id ?? null) === ckey);
    if (!bucket) {
      bucket = { course: line.course, lines: [] };
      group.courses.push(bucket);
    }
    bucket.lines.push(line);
  }
  const out = [...seats.values()].sort((a, b) => (a.seat ?? -1) - (b.seat ?? -1));
  for (const g of out) {
    g.courses.sort((a, b) => (a.course ? a.course.order : Number.MAX_SAFE_INTEGER) - (b.course ? b.course.order : Number.MAX_SAFE_INTEGER));
  }
  return out;
}

/** "הדפסה חוזרת — בחירה": a pick of one line of one round. */
export interface Pick {
  roundId: string;
  lineId: string;
}

export function pickKey(p: Pick): string {
  return `${p.roundId}::${p.lineId}`;
}

/** [picks] with the whole round in, or — when it is all in already — all out (the till's `toggleRound`). */
export function toggleRound(picks: Pick[], round: { id: string; lines: { lineId: string }[] }): Pick[] {
  const its = round.lines.map((l) => ({ roundId: round.id, lineId: l.lineId }));
  const have = new Set(picks.map(pickKey));
  const all = its.length > 0 && its.every((p) => have.has(pickKey(p)));
  if (all) {
    const drop = new Set(its.map(pickKey));
    return picks.filter((p) => !drop.has(pickKey(p)));
  }
  return [...picks, ...its.filter((p) => !have.has(pickKey(p)))];
}
