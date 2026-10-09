import { describe, expect, it } from 'vitest';
import { AlarmGate, applyBatteryStep, batteryStep, isCritical, NO_CYCLE, parseThresholds, type BatteryCycle } from '../src/core/batteryAlerts';

/** The rule over (percent, charging) readings: the level fired at each, or null. */
function run(readings: Array<[number | null, boolean]>, thresholds = [15, 10, 5]) {
  let state: BatteryCycle = NO_CYCLE;
  return readings.map(([p, c]) => {
    const s = batteryStep(state, p, c, thresholds);
    state = applyBatteryStep(state, s);
    return { fire: s.fire, clear: s.clear, end: s.endCycle, open: state.openLevel };
  });
}

describe('"סוללה חלשה" (core/batteryAlerts.ts — the cloud battery_alerts.step, the till BatteryAlerts.kt)', () => {
  it('15, 10, 5 once each down a discharge; charging ends it; the next discharge fires again', () => {
    const out = run([[40, false], [15, false], [12, false], [10, false], [5, false], [3, false], [3, true], [15, false]]);
    expect(out.map((o) => o.fire)).toEqual([null, 15, null, 10, 5, null, null, 15]);
    expect(out[3].clear).toBe('escalated');
    expect(out[6]).toMatchObject({ clear: 'charging', end: true, open: null });
    expect(isCritical(5, [15, 10, 5])).toBe(true);
    expect(isCritical(10, [15, 10, 5])).toBe(false);
  });

  it('hysteresis: cleared 5 above its level, never fired again in the cycle; skipped levels fire the worse one', () => {
    const out = run([[10, false], [14, false], [15, false], [10, false], [16, false], [9, false], [5, false]]);
    expect(out.map((o) => o.fire)).toEqual([10, null, null, null, null, null, 5]);
    expect(out[2]).toMatchObject({ clear: 'recovered', end: false, open: null });
    expect(run([[16, false], [9, false]]).map((o) => o.fire)).toEqual([null, 10]);
    // Above the highest + 5 the cycle ends: 15 may fire again.
    expect(run([[15, false], [20, false], [14, false]]).map((o) => o.fire)).toEqual([15, null, 15]);
  });

  it('thresholds from the till parameter', () => {
    expect(parseThresholds('15,10,5')).toEqual([15, 10, 5]);
    expect(parseThresholds('8;20')).toEqual([20, 8]);
    expect(parseThresholds('x')).toEqual([15, 10, 5]);
    expect(run([[29, false], [19, false]], [30, 20]).map((o) => o.fire)).toEqual([30, 20]);
  });

  it('the alarm: once per level, never over a payment — right after it; off when the sound is off', () => {
    const g = new AlarmGate();
    expect(g.next({ alarmSeq: 0, critical: false, sound: true }, false)).toBeNull();
    // A level fires during a payment: it waits.
    expect(g.next({ alarmSeq: 1, critical: false, sound: true }, true)).toBeNull();
    expect(g.next({ alarmSeq: 1, critical: false, sound: true }, true)).toBeNull();
    expect(g.next({ alarmSeq: 1, critical: false, sound: true }, false)).toEqual({ critical: false });
    // Not twice.
    expect(g.next({ alarmSeq: 1, critical: false, sound: true }, false)).toBeNull();
    expect(g.next({ alarmSeq: 2, critical: true, sound: true }, false)).toEqual({ critical: true });
    expect(g.next({ alarmSeq: 3, critical: true, sound: false }, false)).toBeNull();
    // A reloaded screen does not replay what was already sounded.
    const again = new AlarmGate();
    again.seen(2);
    expect(again.next({ alarmSeq: 2, critical: true, sound: true }, false)).toBeNull();
  });
});
