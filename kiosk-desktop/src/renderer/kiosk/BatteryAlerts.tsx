/**
 * "סוללה חלשה" on the kiosk's screen (core/batteryAlerts.ts; pos-server docs/SPEC_KIOSK_INSIGHTS.md §6):
 * the battery read here (Chromium's navigator.getBattery — a PC on mains reports full and charging,
 * and nothing ever shows), handed to the local service, which applies the rule; a strip at 15 / 10 %
 * ("סוללה חלשה — 10%, חברו למטען"), a full-width red one at the critical level, and a 2-second
 * alarm (WebAudio, louder and more urgent at the critical level) each time a level fires — never
 * over a payment: both wait for it to end.
 */

import { useEffect, useState } from 'react';
import { AlarmGate, ALARM_MS, type BatteryAlertView } from '../../core/batteryAlerts';
import { kiosk } from '../bridge';

const POLL_MS = 30_000;
const SEEN_KEY = 'battery.alarmSeq';

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

function readSeen(): number {
  try {
    return Number(window.localStorage.getItem(SEEN_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function writeSeen(seq: number) {
  try {
    window.localStorage.setItem(SEEN_KEY, String(seq));
  } catch {
    // Private storage off: the alarm may sound once more after a reload.
  }
}

/** Two seconds: a warning's two-tone beeps, or the critical level's rising siren, louder. */
export function playBatteryAlarm(critical: boolean): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void ctx.resume().catch(() => undefined);
    const gain = ctx.createGain();
    gain.gain.value = critical ? 0.9 : 0.5;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = critical ? 'sawtooth' : 'square';
    const t0 = ctx.currentTime;
    const seconds = ALARM_MS / 1000;
    if (critical) {
      // A siren: four sweeps up in two seconds.
      for (let i = 0; i < 4; i++) {
        osc.frequency.setValueAtTime(650, t0 + i * 0.5);
        osc.frequency.linearRampToValueAtTime(1300, t0 + i * 0.5 + 0.45);
      }
    } else {
      // Beeps: 880 / 660 Hz, a quarter second each.
      for (let i = 0; i < 8; i++) osc.frequency.setValueAtTime(i % 2 === 0 ? 880 : 660, t0 + i * 0.25);
    }
    gain.gain.setValueAtTime(gain.gain.value, t0 + seconds - 0.05);
    gain.gain.linearRampToValueAtTime(0, t0 + seconds);
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t0 + seconds);
    osc.onended = () => void ctx.close().catch(() => undefined);
  } catch {
    // No audio device: the strip still shows.
  }
}

export function BatteryAlerts({ busy }: { busy: boolean }) {
  const [view, setView] = useState<BatteryAlertView | null>(null);
  const [gate] = useState(() => {
    const g = new AlarmGate();
    g.seen(readSeen());
    return g;
  });

  useEffect(() => {
    if (!kiosk.battery) return;
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (typeof nav.getBattery !== 'function') return;
    let battery: BatteryManagerLike | null = null;
    let stopped = false;
    const report = () => {
      if (!battery || stopped) return;
      void kiosk.battery?.({ percent: Math.round(battery.level * 100), charging: battery.charging }).then((v) => {
        if (!stopped) setView(v);
      });
    };
    void nav.getBattery().then((b) => {
      battery = b;
      b.addEventListener('levelchange', report);
      b.addEventListener('chargingchange', report);
      report();
    }).catch(() => undefined);
    const id = window.setInterval(report, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
      battery?.removeEventListener('levelchange', report);
      battery?.removeEventListener('chargingchange', report);
    };
  }, []);

  // The alarm: once per level fired, never over a payment (it plays when the payment ends).
  useEffect(() => {
    if (!view) return;
    const play = gate.next(view, busy);
    if (play) {
      writeSeen(view.alarmSeq);
      playBatteryAlarm(play.critical);
    }
  }, [view, busy, gate]);

  if (!view || view.level === null || view.charging || busy) return null;
  const percent = view.percent ?? view.level;
  return (
    <div
      role="alert"
      className="pointer-events-none absolute inset-x-0 top-0 z-[60] flex items-center justify-center px-4 text-center font-bold text-white"
      style={{
        background: view.critical ? '#C62828' : '#E65100',
        minHeight: view.critical ? 64 : 34,
        fontSize: view.critical ? 22 : 15,
        boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
      }}
    >
      {view.critical ? `סוללה קריטית — ${percent}%! חברו למטען מיד` : `סוללה חלשה — ${percent}%, חברו למטען`}
    </div>
  );
}
