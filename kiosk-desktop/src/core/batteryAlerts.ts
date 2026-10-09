/**
 * "סוללה חלשה" on the device itself (pos-server docs/SPEC_KIOSK_INSIGHTS.md §6) — the same rule as
 * the cloud's app/services/battery_alerts.py `step` and the till's domain/BatteryAlerts.kt:
 *
 *  - while discharging, the lowest threshold the battery is at or under fires (15 / 10 / 5 % by
 *    default, the till parameter `lowBatteryThresholds`; the lowest is critical) — only ever
 *    downwards in a discharge cycle: a level at or above one already fired counts as passed;
 *  - the alert clears when the device charges or climbs HYSTERESIS points above its threshold;
 *    the cycle ends when it charges or climbs HYSTERESIS above the highest threshold;
 *  - each level fired plays a 2-second alarm (`lowBatterySound`, on by default) — never while a
 *    payment is under way: it waits for it to end (AlarmGate).
 */

export const DEFAULT_THRESHOLDS = [15, 10, 5] as const;
export const HYSTERESIS = 5;
export const ALARM_MS = 2000;

export function parseThresholds(raw: unknown): number[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.replace(/;/g, ',').split(',') : [];
  const out = new Set<number>();
  for (const p of parts) {
    const n = Number(String(p).trim());
    if (Number.isInteger(n) && n >= 1 && n <= 50) out.add(n);
  }
  const list = [...out].sort((a, b) => b - a).slice(0, 3);
  return list.length > 0 ? list : [...DEFAULT_THRESHOLDS];
}

export interface BatteryCycle {
  /** A discharge cycle is under way. */
  open: boolean;
  /** The levels fired in it. */
  fired: number[];
  /** The alert showing now (null: none). */
  openLevel: number | null;
}

export const NO_CYCLE: BatteryCycle = { open: false, fired: [], openLevel: null };

export interface BatteryStep {
  fire: number | null;
  clear: 'charging' | 'recovered' | 'escalated' | null;
  endCycle: boolean;
}

export function batteryStep(state: BatteryCycle, percent: number | null, charging: boolean, thresholds: readonly number[]): BatteryStep {
  const none: BatteryStep = { fire: null, clear: null, endCycle: false };
  if (percent === null || !Number.isFinite(percent)) return none;
  const levels = [...new Set(thresholds.map((t) => Math.round(t)))].sort((a, b) => b - a);
  const all = levels.length > 0 ? levels : [...DEFAULT_THRESHOLDS];
  const top = all[0];
  if (charging || percent >= top + HYSTERESIS) {
    if (!state.open) return none;
    return { fire: null, clear: state.openLevel !== null ? (charging ? 'charging' : 'recovered') : null, endCycle: true };
  }
  const under = all.filter((t) => percent <= t);
  const levelNow = under.length > 0 ? Math.min(...under) : null;
  const fired = state.open ? state.fired : [];
  const floor = fired.length > 0 ? Math.min(...fired) : null;
  if (levelNow !== null && (floor === null || levelNow < floor)) return { fire: levelNow, clear: state.openLevel !== null ? 'escalated' : null, endCycle: false };
  if (state.openLevel !== null && percent >= state.openLevel + HYSTERESIS) return { fire: null, clear: 'recovered', endCycle: false };
  return none;
}

/** The cycle after a step. */
export function applyBatteryStep(state: BatteryCycle, s: BatteryStep): BatteryCycle {
  if (s.endCycle) return NO_CYCLE;
  let next = state;
  if (s.clear) next = { ...next, openLevel: null };
  if (s.fire !== null) next = { open: true, fired: [...(next.open ? next.fired : []), s.fire], openLevel: s.fire };
  return next;
}

export function isCritical(level: number, thresholds: readonly number[]): boolean {
  return level === Math.min(...(thresholds.length > 0 ? thresholds : DEFAULT_THRESHOLDS));
}

/** What the screens show: the open alert, the battery, and the alarm to play (by its sequence number). */
export interface BatteryAlertView {
  level: number | null;
  percent: number | null;
  charging: boolean;
  critical: boolean;
  /** Grows by one each time a level fires; the screen plays the alarm once per number. */
  alarmSeq: number;
  sound: boolean;
}

/**
 * The alarm never over a payment: a level that fires while one is under way waits, and plays the
 * moment it ends — once (the latest only).
 */
export class AlarmGate {
  private played = 0;
  private pending: { seq: number; critical: boolean } | null = null;

  /** A view arrived / the payment state changed: the alarm to play now, or null. */
  next(view: Pick<BatteryAlertView, 'alarmSeq' | 'critical' | 'sound'>, busy: boolean): { critical: boolean } | null {
    if (view.alarmSeq > this.played && view.sound) this.pending = { seq: view.alarmSeq, critical: view.critical };
    if (!this.pending || busy) return null;
    const p = this.pending;
    this.pending = null;
    this.played = p.seq;
    return { critical: p.critical };
  }

  /** Start from what was already sounded (a reloaded screen does not replay an old alarm). */
  seen(seq: number) {
    this.played = Math.max(this.played, seq);
  }
}
