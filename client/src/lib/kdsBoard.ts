/**
 * "מסך מטבח (KDS)" — what a kitchen screen shows and which buttons it has (pure, tested in
 * kiosk-desktop/test/kdsBoard.test.ts). Shared by the Windows app (kiosk-desktop/src/core/kdsBoard.ts
 * re-exports it) and the browser KDS at `/kds`; self-contained (no `@/` imports). The rules are the cloud's (server app/services/kds.py `_apply`,
 * `_task_action`, `_recompute`, `board`; docs/SPEC_KDS.md §6, §8; the Android screens
 * ui/kds/KdsScreens.kt and domain/KdsBoard.kt) — the screen never decides more than the cloud
 * allows, it only offers what the cloud would accept:
 *
 *  - station:  per item "התחל" (when the order requires a start) → "מוכן" → "בטל מוכן"; per card
 *              "הכול מוכן" (station_ready), or "התחל הכול" while items wait for a start;
 *  - expo:     the same on every item, and per card "מוכן לאיסוף" when every station is done (or
 *              before that, with a reason — override), "נמסר" when the order tracks handover,
 *              "החזר להכנה" / "החזר" (undo_pickup);
 *  - manager:  as the expo, plus "דחוף" / "בטל דחיפות" (priority, with a reason).
 *
 * Plus: the age timer of a card (counted on the cloud's clock, coloured by the station settings:
 * בזמן / מתעכב / באיחור), the changes that need a "ראיתי", the order of the cards, their columns,
 * and the optimistic overlay — this screen's own actions drawn over the cloud's last board until
 * the cloud confirms them, never reviving a cancelled quantity.
 */

import type { KdsActionInput, KdsActionType, KdsChange, KdsDeviceInfo, KdsItemTap, KdsOrder, KdsTask, KdsView } from './kdsScreenTypes';

const EPS = 1e-6;

/* --------------------------------------------------------------------- roles */

export type KdsScreenRole = 'station' | 'expo' | 'manager';

/** The device's KDS role (station unless the cloud says expo / manager). */
export function screenRole(device: Pick<KdsDeviceInfo, 'role'> | null | undefined): KdsScreenRole {
  const r = device?.role;
  return r === 'expo' ? 'expo' : r === 'manager' ? 'manager' : 'station';
}

/** The header's title: a station's names, else the role. */
export function roleTitle(device: KdsDeviceInfo | null | undefined): string {
  const role = screenRole(device);
  if (role === 'expo') return 'Expo — הוצאה';
  if (role === 'manager') return 'מנהל מטבח';
  const names = (device?.stations ?? []).map((s) => s.name).filter(Boolean);
  return names.length > 0 ? names.join(' · ') : 'תחנה';
}

/* --------------------------------------------------------------------- tasks */

export const isHeld = (t: KdsTask): boolean => t.release === 'hold';

/**
 * A held line that waits for its own time (P:/specs/fire-restaurant-flow.md §8.4), as the screen words it:
 * "מתוזמן 20:30" (local time), "מתוזמן · אחרי עיקריות"; null for any other line.
 */
export function scheduledText(t: Pick<KdsTask, 'release' | 'scheduledAt' | 'scheduledNote'>): string | null {
  if (t.release !== 'hold') return null;
  const parts: string[] = [];
  if (t.scheduledAt) {
    const at = new Date(t.scheduledAt);
    if (!Number.isNaN(at.getTime())) {
      parts.push(`${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`);
    }
  }
  const note = (t.scheduledNote ?? '').trim();
  if (!parts.length && !note) return null;
  return note ? `מתוזמן${parts.length ? ` ${parts[0]}` : ''} · ${note}` : `מתוזמן ${parts[0]}`;
}
export const isCancelled = (t: KdsTask): boolean => t.activeQty <= EPS;
/** Released and not cancelled: work on the screen. */
export const isLive = (t: KdsTask): boolean => !isHeld(t) && !isCancelled(t);
export const isReady = (t: KdsTask): boolean => t.state === 'ready';
export const remaining = (t: KdsTask): number => Math.max(0, t.activeQty - t.preparedQty);
/** Printed on the fallback printer while the KDS was out of reach: reconcile, never prepare twice. */
export const needsFallbackDecision = (t: KdsTask): boolean => !!t.fallbackPrinted && !t.fallbackResolved && !isCancelled(t);

/** Every required, released, active task is ready (server `all_ready`). */
export function allReady(tasks: readonly KdsTask[]): boolean {
  const req = tasks.filter((t) => t.required && isLive(t));
  return req.length > 0 && req.every(isReady);
}

/** Live tasks still to prepare. */
export function openTasks(order: KdsOrder): KdsTask[] {
  return order.tasks.filter((t) => isLive(t) && !isReady(t));
}

/** The stations whose required work is not done yet (the Expo's "ממתין ל…"). */
export function waitingFor(order: KdsOrder): string[] {
  const names = order.tasks.filter((t) => t.required && isLive(t) && !isReady(t)).map((t) => t.stationName ?? 'ללא תחנה');
  return [...new Set(names)];
}

/** "2" / "1.5" — a quantity as the kitchen reads it. */
export function qtyText(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n);
  if (Math.abs(n - r) < 1e-6) return String(r);
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** The tasks by round, oldest first (a later round is a "תוספת"). */
export function rounds(tasks: readonly KdsTask[]): Array<{ roundNo: number; tasks: KdsTask[]; releasedAt: string | null }> {
  const by = new Map<number, KdsTask[]>();
  for (const t of tasks) by.set(t.roundNo, [...(by.get(t.roundNo) ?? []), t]);
  return [...by.entries()]
    .sort(([a], [b]) => a - b)
    .map(([roundNo, ts]) => ({ roundNo, tasks: ts, releasedAt: oldestIso(ts.map((t) => t.releasedAt)) }));
}

/* -------------------------------------------------------------------- orders */

const FINISHED_GROUP = new Set(['handed_over', 'cancelled']);
const FINISHED_STATUS = new Set(['handed_over', 'cancelled', 'closed']);

/** Handed over, cancelled, or (view only) bumped. */
export function isFinished(order: KdsOrder): boolean {
  return FINISHED_GROUP.has(order.groupState ?? '') || FINISHED_STATUS.has(order.status);
}

export function pendingChanges(order: KdsOrder): KdsChange[] {
  return order.changes.filter((c) => c.requiresAck && !c.acked);
}

/**
 * The card's headline: the table, the pickup number, the order's reference. A kiosk's order says
 * what its slip says ("A-17", or "17" with the kiosk's "מספר בלבד"); any other, `#17`.
 */
export function orderTitle(order: KdsOrder): string {
  if (order.tableRef) return order.displayRef && order.displayRef.includes(order.tableRef) ? order.displayRef : `שולחן ${order.tableRef}`;
  const label = order.pickupLabel?.trim();
  if (label) return label;
  if (order.pickupNumber) return `#${order.pickupNumber}`;
  return order.displayRef ?? order.id.slice(0, 6);
}

/**
 * The order's number when the title does not already say it (`ticketInfo.orderNumber`, §16): the
 * pickup number, else the document's number ("#20000057"). A table's order has none on the board.
 */
export function orderNumberText(order: KdsOrder): string | null {
  const title = orderTitle(order);
  const ref = order.displayRef?.trim() || null;
  const candidates = [order.pickupNumber ? `#${order.pickupNumber}` : null, ref ? (/^\d+$/.test(ref) ? `#${ref}` : ref) : null];
  for (const c of candidates) if (c && c !== title && !title.includes(c.replace(/^#/, ''))) return c;
  return null;
}

export function sourceText(source: string): string {
  if (source === 'table') return 'שולחן';
  if (source === 'kiosk') return 'קיוסק';
  if (source === 'external') return 'חיצוני';
  return 'הזמנה מהירה';
}

export function serviceText(serviceType: string | null): string | null {
  if (serviceType === 'eat_in') return 'לשבת';
  if (serviceType === 'take_away') return 'לקחת';
  // An external order's courier (docs/SPEC_KDS.md §16); no till sends it yet.
  if (serviceType === 'delivery') return 'משלוח';
  return null;
}

export function groupText(order: KdsOrder): string | null {
  if (order.groupState === 'ready_for_pickup') return 'מוכן לאיסוף';
  if (order.groupState === 'handed_over') return 'נמסר';
  if (order.groupState === 'cancelled' || order.status === 'cancelled') return 'בוטל';
  return null;
}

/** A change the kitchen must see, in words. */
export function changeText(c: KdsChange, order: KdsOrder): string {
  const task = order.tasks.find((t) => t.id === c.taskId);
  const name = task?.name ?? '';
  if (c.kind === 'cancel') return `בוטל: ${qtyText(c.qty ?? 0)} × ${c.text ?? name}`;
  if (c.kind === 'note') return c.text ? `שינוי הערה${name ? ` — ${name}` : ''}: ${c.text}` : `ההערה הוסרה${name ? ` — ${name}` : ''}`;
  if (c.kind === 'remake') return `הכנה מחדש${name ? ` — ${name}` : ''}: ${c.text ?? ''}`;
  return c.text ?? c.kind;
}

/* --------------------------------------------------------------------- timer */

export type TimerLevel = 'normal' | 'warn' | 'late' | 'done';

export const TIMER_TEXT: Record<TimerLevel, string> = { normal: 'בזמן', warn: 'מתעכב', late: 'באיחור', done: 'מוכן' };

/** The cloud's station defaults (KdsStationSettingIn: warn 10, late 20). */
export const DEFAULT_WARN_MIN = 10;
export const DEFAULT_LATE_MIN = 20;

/** An ISO time from the cloud ("…+00:00", "…Z", or naive = UTC) as epoch ms; null if unreadable. */
export function epochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const s = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function oldestIso(list: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const iso of list) {
    const ms = epochMs(iso);
    if (ms !== null && ms < bestMs) {
      bestMs = ms;
      best = iso ?? null;
    }
  }
  return best;
}

/** Whole minutes from `iso` to `nowMs` (never negative: a clock a little ahead). */
export function minutesSince(iso: string | null | undefined, nowMs: number): number {
  const t = epochMs(iso);
  return t === null ? 0 : Math.max(0, Math.floor((nowMs - t) / 60_000));
}

/** The order's thresholds: the strictest of its stations' settings (else the cloud's defaults). */
export function thresholds(order: KdsOrder, settings: KdsView['stationSettings']): { warn: number; late: number } {
  const stations = [...new Set(order.tasks.filter(isLive).map((t) => t.stationId).filter((s): s is string => !!s))];
  const warns = stations.map((s) => settings[s]?.warnMinutes).filter((n): n is number => typeof n === 'number' && n > 0);
  const lates = stations.map((s) => settings[s]?.lateMinutes).filter((n): n is number => typeof n === 'number' && n > 0);
  return { warn: warns.length ? Math.min(...warns) : DEFAULT_WARN_MIN, late: lates.length ? Math.min(...lates) : DEFAULT_LATE_MIN };
}

export function timerLevel(minutes: number, warn: number, late: number): TimerLevel {
  if (minutes >= late) return 'late';
  if (minutes >= warn) return 'warn';
  return 'normal';
}

/**
 * The card's age and colour, on the cloud's clock (`nowMs` = local now + serverOffsetMs): counted
 * from the release of the oldest work still open (a later round — "תוספת" — starts its own
 * count), "מוכן" when nothing is left to prepare or the order is ready / handed over.
 */
export function orderTimer(
  order: KdsOrder,
  settings: KdsView['stationSettings'],
  nowMs: number,
  look?: TimerLook | null,
): { minutes: number; level: TimerLevel } {
  const start = order.firstReleasedAt ?? order.createdAt;
  const open = openTasks(order);
  const done = open.length === 0 || order.groupState === 'ready_for_pickup' || isFinished(order);
  if (done) return { minutes: minutesSince(start, nowMs), level: 'done' };
  const since = oldestIso(open.map((t) => t.releasedAt)) ?? start;
  const minutes = minutesSince(since, nowMs);
  // "צבע לפי זמן" off: the minutes only, never orange or red.
  if (look && look.ageColors === false) return { minutes, level: 'normal' };
  const { warn, late } = look?.thresholds ?? thresholds(order, settings);
  return { minutes, level: timerLevel(minutes, warn, late) };
}

/** The screen's own look on the timer (`device.display`): its thresholds (else the stations'), colours on / off. */
export interface TimerLook {
  thresholds?: { warn: number; late: number } | null;
  ageColors?: boolean;
}

/* ------------------------------------------------------------------- buttons */

export type ButtonTone = 'start' | 'ready' | 'undo' | 'pickup' | 'handover' | 'neutral' | 'urgent';

export interface KdsButton {
  /** Stable per target (debounce, tap feedback). */
  key: string;
  label: string;
  tone: ButtonTone;
  /** Sent in order (one tap may start several items). */
  actions: KdsActionInput[];
  /** Asks for a reason first (the cloud refuses without one). */
  reason?: 'override' | 'priority';
  /** The card's main button (wide). */
  primary?: boolean;
}

/** The one button of an item row, or null (held, cancelled, finished order, fallback to reconcile). */
export function taskButton(order: KdsOrder, task: KdsTask): KdsButton | null {
  if (!isLive(task) || isFinished(order) || needsFallbackDecision(task)) return null;
  if (isReady(task)) return { key: `task:${task.id}`, label: 'בטל מוכן', tone: 'undo', actions: [{ type: 'undo_ready', taskId: task.id }] };
  if (task.state === 'queued' && order.requireStart) return { key: `task:${task.id}`, label: 'התחל', tone: 'start', actions: [{ type: 'start', taskId: task.id }] };
  return { key: `task:${task.id}`, label: 'מוכן', tone: 'ready', actions: [{ type: 'item_ready', taskId: task.id }] };
}

/** "כבר הוכן" / "להכין" for a round printed on the fallback printer. */
export function fallbackButtons(task: KdsTask): KdsButton[] {
  if (!needsFallbackDecision(task)) return [];
  return [
    { key: `fb:${task.id}`, label: 'כבר הוכן', tone: 'ready', actions: [{ type: 'resolve_fallback', taskId: task.id, resolution: 'prepared' }] },
    { key: `fb:${task.id}`, label: 'להכין', tone: 'neutral', actions: [{ type: 'resolve_fallback', taskId: task.id, resolution: 'prepare' }] },
  ];
}

/** "ראיתי" on a change that needs it. */
export function ackButton(c: KdsChange): KdsButton {
  return { key: `ack:${c.id}`, label: 'ראיתי', tone: 'neutral', actions: [{ type: 'ack_change', changeId: c.id }] };
}

/** The card's buttons for this screen's role. */
export function orderButtons(order: KdsOrder, role: KdsScreenRole): KdsButton[] {
  const out: KdsButton[] = [];
  if (isFinished(order)) return out;
  const open = openTasks(order).filter((t) => !needsFallbackDecision(t));
  const queued = open.filter((t) => t.state === 'queued');
  const expo = role !== 'station';
  const waiting = order.groupState === 'waiting' || order.groupState === null;
  // The kitchen's bump: on a station always; on the Expo while the order is still being prepared.
  if (open.length > 0 && (!expo || waiting || order.viewOnly)) {
    if (order.requireStart && queued.length > 0) {
      out.push({
        key: `card:${order.id}`,
        label: queued.length === open.length ? 'התחל הכול' : `התחל (${queued.length})`,
        tone: 'start',
        actions: queued.map((t) => ({ type: 'start' as const, taskId: t.id })),
        primary: true,
      });
    } else {
      out.push({ key: `card:${order.id}`, label: 'הכול מוכן', tone: 'ready', actions: [{ type: 'station_ready', orderId: order.id }], primary: true });
    }
  }
  if (!expo || order.viewOnly) return out;
  if (waiting) {
    if (allReady(order.tasks)) {
      out.push({ key: `pickup:${order.id}`, label: 'מוכן לאיסוף', tone: 'pickup', actions: [{ type: 'ready_for_pickup', orderId: order.id }], primary: true });
    } else {
      out.push({
        key: `pickup:${order.id}`,
        label: 'מוכן לאיסוף…',
        tone: 'neutral',
        actions: [{ type: 'ready_for_pickup', orderId: order.id, override: true }],
        reason: 'override',
      });
    }
  } else if (order.groupState === 'ready_for_pickup') {
    if (order.trackHandover) out.push({ key: `handover:${order.id}`, label: 'נמסר', tone: 'handover', actions: [{ type: 'handover', orderId: order.id }], primary: true });
    out.push({ key: `undo:${order.id}`, label: 'החזר להכנה', tone: 'undo', actions: [{ type: 'undo_pickup', orderId: order.id }] });
  }
  if (role === 'manager') {
    const urgent = (order.priority ?? 0) > 0;
    out.push({
      key: `prio:${order.id}`,
      label: urgent ? 'בטל דחיפות' : 'דחוף',
      tone: urgent ? 'neutral' : 'urgent',
      actions: [{ type: 'priority', orderId: order.id, priority: urgent ? 0 : 1 }],
      reason: 'priority',
    });
  }
  return out;
}

/** "החזר" on a handed-over (or, view only, bumped) order in the Expo's recent strip. */
export function recallButton(order: KdsOrder): KdsButton | null {
  if (order.groupState === 'handed_over') return { key: `undo:${order.id}`, label: 'החזר', tone: 'undo', actions: [{ type: 'undo_pickup', orderId: order.id }] };
  if (order.viewOnly && order.status === 'closed') {
    const ready = order.tasks.filter((t) => isLive(t) && isReady(t));
    if (ready.length) return { key: `undo:${order.id}`, label: 'החזר', tone: 'undo', actions: ready.map((t) => ({ type: 'undo_ready' as const, taskId: t.id })) };
  }
  return null;
}

/* ------------------------------------------- learned from a reference KDS (§16) */

/** An order's urgency in words: 1 "דחוף", 2 "דחוף מאוד", 3 and up "בהול"; null when it is not urgent. */
export function urgencyText(priority: number | null | undefined): string | null {
  const p = priority ?? 0;
  if (p <= 0) return null;
  if (p === 1) return 'דחוף';
  if (p === 2) return 'דחוף מאוד';
  return 'בהול';
}

/** An item's state in words (the chip of a row that takes taps): ממתין / בהכנה / מוכן. */
export function taskStateText(t: KdsTask): 'ממתין' | 'בהכנה' | 'מוכן' {
  if (isReady(t)) return 'מוכן';
  if (t.state === 'preparing' || t.preparedQty > EPS) return 'בהכנה';
  return 'ממתין';
}

/**
 * What a tap on an item row does (`itemTap`, docs/SPEC_KDS.md §16): "button" — nothing (the row's
 * button acts, as always); "cycle" — ממתין → בהכנה (start) → מוכן (item_ready) → ממתין (requeue);
 * "ready" ("מוכן בנגיעה") — מוכן (a start first where the order requires one), and again בטל מוכן.
 * Null where the item takes no tap: held, cancelled, a finished order, a fallback round to reconcile.
 */
export function itemTapButton(order: KdsOrder, task: KdsTask, mode: KdsItemTap): KdsButton | null {
  if (mode === 'button' || !isLive(task) || isFinished(order) || needsFallbackDecision(task)) return null;
  const key = `task:${task.id}`;
  const taskId = task.id;
  if (mode === 'ready') {
    if (isReady(task)) return { key, label: 'בטל מוכן', tone: 'undo', actions: [{ type: 'undo_ready', taskId }] };
    const start: KdsActionInput[] = task.state === 'queued' && order.requireStart ? [{ type: 'start', taskId }] : [];
    return { key, label: 'מוכן', tone: 'ready', actions: [...start, { type: 'item_ready', taskId }] };
  }
  if (isReady(task)) return { key, label: 'ממתין', tone: 'undo', actions: [{ type: 'requeue', taskId }] };
  if (task.state === 'queued' && task.preparedQty <= EPS) return { key, label: 'בהכנה', tone: 'start', actions: [{ type: 'start', taskId }] };
  return { key, label: 'מוכן', tone: 'ready', actions: [{ type: 'item_ready', taskId }] };
}

/** Who may mark an order urgent from the ticket's menu: the Expo and the manager; a station when its screen allows (`stationRush`). */
export interface TicketMenuOptions {
  stationRush: boolean;
  urgencyLevels: boolean;
}

/**
 * The ticket header's menu (§16): "דחוף" (with `urgencyLevels`: "דחוף מאוד", "בהול"; "בטל דחיפות"
 * when urgent — each asks for the reason the cloud requires), and for the card's items: "הכול ממתין"
 * (requeue), "הכול בהכנה" (start the waiting, undo the ready), "הכול מוכן" (a start first where the
 * order requires one). `tasks`: the items the card shows (a station's own; all on the Expo).
 * Only what would change something is offered.
 */
export function ticketMenu(order: KdsOrder, role: KdsScreenRole, opts: TicketMenuOptions, tasks: readonly KdsTask[] = order.tasks): KdsButton[] {
  const out: KdsButton[] = [];
  if (isFinished(order)) return out;
  const orderId = order.id;
  if (role !== 'station' || opts.stationRush) {
    const now = order.priority ?? 0;
    if (now > 0) out.push({ key: `prio:${orderId}:0`, label: 'בטל דחיפות', tone: 'neutral', actions: [{ type: 'priority', orderId, priority: 0 }], reason: 'priority' });
    for (const level of opts.urgencyLevels ? [1, 2, 3] : [1]) {
      if (level === now || (!opts.urgencyLevels && now > 0)) continue;
      out.push({ key: `prio:${orderId}:${level}`, label: urgencyText(level) ?? 'דחוף', tone: 'urgent', actions: [{ type: 'priority', orderId, priority: level }], reason: 'priority' });
    }
  }
  const live = tasks.filter((t) => isLive(t) && !needsFallbackDecision(t));
  const begun = live.filter((t) => t.state !== 'queued' || t.preparedQty > EPS);
  if (begun.length) out.push({ key: `bulk:${orderId}:queued`, label: 'הכול ממתין', tone: 'neutral', actions: begun.map((t) => ({ type: 'requeue' as const, taskId: t.id })) });
  const toStart = live.filter((t) => t.state === 'queued' && t.preparedQty <= EPS);
  const toUndo = live.filter(isReady);
  if (toStart.length || toUndo.length) {
    out.push({
      key: `bulk:${orderId}:preparing`,
      label: 'הכול בהכנה',
      tone: 'start',
      actions: [...toStart.map((t) => ({ type: 'start' as const, taskId: t.id })), ...toUndo.map((t) => ({ type: 'undo_ready' as const, taskId: t.id }))],
    });
  }
  const open = live.filter((t) => !isReady(t));
  if (open.length) {
    const starts = order.requireStart ? open.filter((t) => t.state === 'queued').map((t) => ({ type: 'start' as const, taskId: t.id })) : [];
    out.push({ key: `bulk:${orderId}:ready`, label: 'הכול מוכן', tone: 'ready', actions: [...starts, ...open.map((t) => ({ type: 'item_ready' as const, taskId: t.id }))] });
  }
  return out;
}

/**
 * "החזר" from the history (§16): handed over → back to ready (as the Expo's strip); on the Expo a
 * ready-for-pickup order → back to preparation; else this screen's ready items → not ready (they
 * come back on the screen). Null when nothing can come back.
 */
export function recallFor(order: KdsOrder, role: KdsScreenRole): KdsButton | null {
  const strip = recallButton(order);
  if (strip) return strip;
  if (isFinished(order)) return null;
  if (role !== 'station' && !order.viewOnly && order.groupState === 'ready_for_pickup') {
    return { key: `undo:${order.id}`, label: 'החזר להכנה', tone: 'undo', actions: [{ type: 'undo_pickup', orderId: order.id }] };
  }
  const ready = order.tasks.filter((t) => isLive(t) && isReady(t));
  if (!ready.length) return null;
  return { key: `undo:${order.id}`, label: 'החזר', tone: 'undo', actions: ready.map((t) => ({ type: 'undo_ready' as const, taskId: t.id })) };
}

/** Ready presets for a reason (a touch screen without a keyboard); free text is allowed too. */
export const REASON_PRESETS: Record<'override' | 'priority', string[]> = {
  override: ['הלקוח ממתין', 'פריט חסר יוגש בהמשך', 'אושר ע״י מנהל'],
  priority: ['לקוח ממתין', 'תלונת לקוח', 'אושר ע״י מנהל', 'טופל'],
};

/** What the cloud would refuse outright (422) — said here, before anything is queued. */
export function checkAction(a: KdsActionInput): string | null {
  const needsTask: KdsActionType[] = ['start', 'item_ready', 'undo_ready', 'resolve_fallback', 'requeue'];
  const needsOrder: KdsActionType[] = ['station_ready', 'ready_for_pickup', 'undo_pickup', 'handover', 'priority'];
  if (needsTask.includes(a.type) && !a.taskId) return 'חסר פריט לפעולה';
  if (needsOrder.includes(a.type) && !a.orderId) return 'חסרה הזמנה לפעולה';
  if (a.type === 'ack_change' && !a.changeId && !a.taskId) return 'חסר שינוי לאישור';
  if (a.type === 'resolve_fallback' && a.resolution !== 'prepared' && a.resolution !== 'prepare') return 'חסרה בחירה: כבר הוכן / להכין';
  const reasonNeeded = a.type === 'priority' || (a.type === 'ready_for_pickup' && a.override === true);
  if (reasonNeeded && !(a.reason ?? '').trim()) return 'נדרשת סיבה';
  if (a.type === 'priority' && (typeof a.priority !== 'number' || a.priority < 0 || a.priority > 9)) return 'עדיפות לא תקינה';
  return null;
}

/* ------------------------------------------------------------------- refusals */

const REFUSAL_TEXT: Record<string, string> = {
  start_required: 'יש להתחיל הכנה לפני סימון מוכן',
  not_all_ready: 'לא כל התחנות סיימו',
  task_cancelled: 'הפריט בוטל',
  task_held: 'המנה עדיין בהמתנה (טרם הוצאה)',
  reason_required: 'נדרשת סיבה',
  not_order_process: 'במכירה במקום אין שלב מוכן לאיסוף',
  version_conflict: 'המצב השתנה במסך אחר — המסך עודכן',
  task_of_another_station: 'הפריט שייך לתחנה אחרת',
  expo_or_manager_only: 'רק מסך Expo או מנהל מטבח יכול לבצע פעולה זו',
  group_handed_over: 'ההזמנה כבר נמסרה',
  group_cancelled: 'ההזמנה בוטלה',
  task_not_found: 'הפריט כבר לא קיים',
  order_not_found: 'ההזמנה כבר לא קיימת',
  change_not_found: 'השינוי כבר לא קיים',
  not_a_kds_device: 'המכשיר אינו מוגדר כמסך מטבח בענן',
  pickup_screen_is_read_only: 'מסך איסוף — לצפייה בלבד',
  task_required: 'חסר פריט לפעולה',
  order_required: 'חסרה הזמנה לפעולה',
  change_required: 'חסר שינוי לאישור',
  unknown_action: 'פעולה לא מוכרת בענן',
  invalid_request: 'הענן דחה את הבקשה (נתונים לא תקינים)',
  unauthorized: 'המכשיר אינו מורשה בענן',
};

/** The cloud's refusal code in Hebrew (the code itself when there is no translation). */
export function refusalText(code: string): string {
  return REFUSAL_TEXT[code] ?? `הפעולה לא בוצעה (${code})`;
}

export const ACTION_TEXT: Record<KdsActionType, string> = {
  start: 'התחל',
  item_ready: 'מוכן',
  undo_ready: 'בטל מוכן',
  station_ready: 'הכול מוכן',
  ack_change: 'ראיתי',
  ready_for_pickup: 'מוכן לאיסוף',
  undo_pickup: 'החזר',
  handover: 'נמסר',
  priority: 'עדיפות',
  resolve_fallback: 'התאמת הדפסת גיבוי',
  requeue: 'חזרה לממתין',
};

/* ------------------------------------------------------------ the overlay */

/** A screen action drawn over the board; `unsent` = still in the outbox (marked pending). */
export type OverlayAction = KdsActionInput & { unsent?: boolean };

export interface OverlayContext {
  role: KdsScreenRole;
  /** The device's stations (a station's "הכול מוכן" covers them). */
  stationIds: readonly string[];
}

function prepareAll(t: KdsTask): KdsTask {
  return { ...t, preparedQty: t.activeQty, state: 'ready' };
}

function mark<T extends { pending?: boolean }>(x: T, unsent: boolean | undefined): T {
  return unsent ? { ...x, pending: true } : x;
}

/** The order's readiness again after its tasks changed (server `_recompute`; the Expo's view only). */
function recompute(o: KdsOrder, ctx: OverlayContext): KdsOrder {
  const ready = allReady(o.tasks);
  let next: KdsOrder = { ...o, allReady: ready };
  if (ctx.role === 'station' || o.viewOnly) return next;
  if (o.groupState === 'ready_for_pickup' && !ready && !o.groupOverride) next = { ...next, groupState: 'waiting', status: 'open', readyAt: null };
  else if ((o.groupState === 'waiting' || o.groupState === null) && ready && !o.requireExpo) next = { ...next, groupState: 'ready_for_pickup', status: 'ready' };
  return next;
}

function onTask(order: KdsOrder, a: OverlayAction, ctx: OverlayContext, f: (t: KdsTask) => KdsTask): KdsOrder {
  if (!a.taskId || !order.tasks.some((t) => t.id === a.taskId)) return order;
  let changed = false;
  const tasks = order.tasks.map((t) => {
    if (t.id !== a.taskId) return t;
    const n = f(t);
    if (n === t) return t;
    changed = true;
    return mark(n, a.unsent);
  });
  return changed ? mark(recompute({ ...order, tasks }, ctx), a.unsent) : order;
}

function applyOne(order: KdsOrder, a: OverlayAction, ctx: OverlayContext): KdsOrder {
  switch (a.type) {
    case 'start':
      return onTask(order, a, ctx, (t) => (t.state === 'queued' && isLive(t) ? { ...t, state: 'preparing' } : t));
    case 'item_ready':
      return onTask(order, a, ctx, (t) => {
        if (!isLive(t) || (order.requireStart && t.state === 'queued') || remaining(t) <= EPS) return t;
        return prepareAll(t);
      });
    case 'undo_ready':
      return onTask(order, a, ctx, (t) => {
        if (t.preparedQty <= EPS) return t;
        return { ...t, preparedQty: 0, state: t.activeQty > EPS ? 'preparing' : t.state, readyAt: null };
      });
    case 'requeue':
      return onTask(order, a, ctx, (t) => {
        if (!isLive(t) || (t.state === 'queued' && t.preparedQty <= EPS)) return t;
        return { ...t, preparedQty: 0, overPrepared: false, state: 'queued', startedAt: null, readyAt: null };
      });
    case 'resolve_fallback':
      return onTask(order, a, ctx, (t) => {
        if (!t.fallbackPrinted || t.fallbackResolved) return t;
        const resolved = { ...t, fallbackResolved: true };
        return a.resolution === 'prepared' && !isCancelled(t) ? prepareAll(resolved) : resolved;
      });
    case 'station_ready': {
      if (a.orderId !== order.id) return order;
      const scope = a.stationId ? new Set([a.stationId]) : ctx.role === 'station' ? new Set(ctx.stationIds) : null;
      let changed = false;
      const tasks = order.tasks.map((t) => {
        if (scope && !(t.stationId && scope.has(t.stationId))) return t;
        if (isHeld(t) || remaining(t) <= EPS) return t;
        if (order.requireStart && t.state === 'queued') return t;
        changed = true;
        return mark(prepareAll(t), a.unsent);
      });
      return changed ? mark(recompute({ ...order, tasks }, ctx), a.unsent) : order;
    }
    case 'ack_change': {
      let changed = false;
      const changes = order.changes.map((c) => {
        const hit = a.changeId ? c.id === a.changeId : !!a.taskId && c.taskId === a.taskId;
        if (!hit || c.acked) return c;
        changed = true;
        return { ...c, acked: true };
      });
      return changed ? mark({ ...order, changes }, a.unsent) : order;
    }
    case 'ready_for_pickup': {
      if (a.orderId !== order.id || order.viewOnly || order.groupState === 'ready_for_pickup' || isFinished(order)) return order;
      const ready = allReady(order.tasks);
      if (!ready && !a.override) return order;
      return mark({ ...order, groupState: 'ready_for_pickup', status: 'ready', groupOverride: ready ? null : (a.reason ?? '').trim() || null }, a.unsent);
    }
    case 'undo_pickup': {
      if (a.orderId !== order.id || order.viewOnly) return order;
      if (order.groupState === 'handed_over') return mark({ ...order, groupState: 'ready_for_pickup', status: 'ready' }, a.unsent);
      if (order.groupState === 'ready_for_pickup') return mark({ ...order, groupState: 'waiting', status: 'open', readyAt: null, groupOverride: null }, a.unsent);
      return order;
    }
    case 'handover': {
      if (a.orderId !== order.id || order.viewOnly || order.groupState === 'handed_over' || order.groupState === 'cancelled') return order;
      return mark({ ...order, groupState: 'handed_over', status: 'handed_over' }, a.unsent);
    }
    case 'priority': {
      if (a.orderId !== order.id) return order;
      return mark({ ...order, priority: a.priority ?? 0, priorityReason: a.reason ?? null }, a.unsent);
    }
    default:
      return order;
  }
}

/**
 * The board as this screen shows it: the cloud's orders with this screen's own actions applied
 * in order (delivered ones until the next board shows them, and the outbox's). An action acts
 * only on what is active — a cancelled unit is never made ready here either.
 */
export function applyPending(orders: readonly KdsOrder[], actions: readonly OverlayAction[], ctx: OverlayContext): KdsOrder[] {
  if (actions.length === 0) return [...orders];
  return orders.map((o) => actions.reduce((acc, a) => applyOne(acc, a, ctx), o));
}

/** A delivered action stays drawn until the board shows it (or a while has passed). */
export interface Settling {
  action: KdsActionInput;
  /** The board's `version` when the action was delivered. */
  boardVersion: number | null;
  /** The order's version in the cloud's answer, when it gave one. */
  orderVersion: number | null;
  at: number;
}

export const SETTLE_MAX_MS = 15_000;

/** Whether the cloud's board now shows the delivered action (or it waited long enough). */
export function isSettled(s: Settling, board: { version: number | null; orders: readonly KdsOrder[] }, nowMs: number): boolean {
  if (nowMs - s.at > SETTLE_MAX_MS) return true;
  if (board.version === s.boardVersion) return false;
  const orderId = s.action.orderId ?? (s.action.taskId ? board.orders.find((o) => o.tasks.some((t) => t.id === s.action.taskId))?.id : undefined);
  if (s.orderVersion !== null && orderId) {
    const o = board.orders.find((x) => x.id === orderId);
    return !o || o.version >= s.orderVersion;
  }
  if (s.action.type === 'ack_change' && s.action.changeId) {
    const c = board.orders.flatMap((o) => o.changes).find((x) => x.id === s.action.changeId);
    return !c || c.acked;
  }
  return true;
}

/* ---------------------------------------------------------- what is on screen */

/** Without handover tracking a ready number leaves the pickup screen after this (server PICKUP_READY_TTL). */
export const READY_TTL_MS = 15 * 60_000;

/** Something left to do on it: an item to prepare, a change to see, a fallback round to reconcile. */
export function hasWork(order: KdsOrder): boolean {
  return openTasks(order).length > 0 || pendingChanges(order).length > 0 || order.tasks.some(needsFallbackDecision);
}

/**
 * The cards and (Expo / manager) the recently handed over strip. A station shows what the cloud
 * sends (its ready items stay a few minutes for an undo — at the end; a card whose items were all
 * cancelled leaves once the cancellation was seen). The Expo: handed over and
 * bumped orders go to the strip (for "החזר"), cancelled ones disappear once their changes were
 * seen, and a ready order without handover tracking leaves after 15 minutes, as on the pickup
 * screen. Sorted: urgent first, then the oldest (`lifo`: the newest — docs/SPEC_KDS.md §16).
 */
export function screenOf(orders: readonly KdsOrder[], role: KdsScreenRole, nowMs: number, opts: { lifo?: boolean } = {}): { cards: KdsOrder[]; recent: KdsOrder[] } {
  const cards: KdsOrder[] = [];
  const recent: KdsOrder[] = [];
  for (const o of orders) {
    const seenAll = pendingChanges(o).length === 0;
    if (role === 'station') {
      // Everything cancelled and seen: nothing left for this station.
      if (!(seenAll && o.tasks.every(isCancelled))) cards.push(o);
      continue;
    }
    if (isFinished(o) && seenAll) {
      if (recallButton(o)) recent.push(o);
      continue;
    }
    if (o.groupState === 'ready_for_pickup' && !o.trackHandover && !o.pending) {
      const readyAt = epochMs(o.readyAt);
      if (readyAt !== null && nowMs - readyAt > READY_TTL_MS && seenAll) continue;
    }
    cards.push(o);
  }
  return { cards: sortOrders(cards, role, opts.lifo), recent: sortOrders(recent, role).reverse() };
}

/** Urgent first, then the oldest (`lifo`: the newest); on a station the cards with nothing left to do go last. */
export function sortOrders(orders: readonly KdsOrder[], role: KdsScreenRole, lifo = false): KdsOrder[] {
  const key = (o: KdsOrder) => ({
    done: role === 'station' && !hasWork(o) ? 1 : 0,
    priority: o.priority ?? 0,
    at: epochMs(o.firstReleasedAt ?? o.createdAt) ?? Number.MAX_SAFE_INTEGER,
  });
  return [...orders].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka.done - kb.done || kb.priority - ka.priority || (lifo ? kb.at - ka.at : ka.at - kb.at) || a.id.localeCompare(b.id);
  });
}

/** Items still to prepare on the screen (the header's count). */
export function openItemCount(orders: readonly KdsOrder[]): number {
  return orders.reduce((n, o) => n + openTasks(o).length, 0);
}

/** Orders that were not on the previous board (the chime and the flash; the first board announces nothing). */
export function newArrivals(prev: ReadonlySet<string> | null, orders: readonly KdsOrder[]): string[] {
  if (prev === null) return [];
  return orders.filter((o) => !prev.has(o.id)).map((o) => o.id);
}

/* ------------------------------------------------------------------ columns */

/** How many card columns fit (a card is at least `minWidth` px). */
export function columnsFor(width: number, minWidth = 330, gap = 12): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}

/** A card's height in rough "lines" (to balance the columns without measuring). */
export function cardWeight(order: KdsOrder): number {
  let w = 4; // header, buttons
  if (order.waiterName || order.pickupName) w += 0.6;
  if (order.orderNote) w += 1;
  w += pendingChanges(order).length * 1.6;
  for (const t of order.tasks) {
    w += 1.3;
    if (t.mods.length) w += 0.6;
    if (t.removals.length) w += 0.6;
    if (t.notes) w += 0.6;
    if (t.allergies.length) w += 0.7;
    if (needsFallbackDecision(t)) w += 1.8;
  }
  if (rounds(order.tasks).length > 1) w += 0.6 * (rounds(order.tasks).length - 1);
  return w;
}

/** Cards into `n` columns, in order, each to the shortest column so far (no gaps, reading order kept). */
export function layoutColumns<T>(items: readonly T[], n: number, weight: (t: T) => number): T[][] {
  const cols: T[][] = Array.from({ length: Math.max(1, n) }, () => []);
  const heights = cols.map(() => 0);
  for (const item of items) {
    let best = 0;
    for (let i = 1; i < cols.length; i++) if (heights[i] < heights[best] - 1e-9) best = i;
    cols[best].push(item);
    heights[best] += weight(item);
  }
  return cols;
}
