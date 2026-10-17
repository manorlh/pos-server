/**
 * The Windows app's side of the clock (core/clockTrust.ts): after each measured beat, the auto-fix when the app runs
 * elevated and `clockAutoFix` is on (the default); the technician's "תיקון שעון" (through UAC); and the heartbeat's
 * `clockTrust` block. Never throws into the caller, never runs a fix under a payment.
 */

import {
  TRUST_MS,
  fixAction,
  type ClockTrustReport,
  type FixAction,
  type FixCapability,
  type FixReason,
} from '../../core/clockTrust';
import { lastFixView, measurementView, noteFix, trusted } from './trustedClock';
import { isElevated, runClockFix, type Runner } from './windowsClockFix';

/** The till parameter (pos-server app/services/clock_trust.py): boolean, on by default. */
export const CLOCK_AUTO_FIX_KEY = 'clockAutoFix';

/** `clockAutoFix` from the parameters: off only when the cloud says so. */
export function clockAutoFixOn(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return true;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  return !['false', '0', 'no', 'off', 'לא'].includes(s);
}

export interface ClockFixDeps {
  /** Runs a process; null on a build that cannot (the browser demo). */
  run: Runner | null;
  enabled: () => boolean;
  /** A sale, a payment or a card operation is open. */
  busy: () => boolean;
  log: (msg: string) => void;
}

export class ClockFix {
  private elevated = false;
  private running = false;

  constructor(private readonly d: ClockFixDeps) {}

  /** Once at start: whether the app runs as an administrator. */
  async init(): Promise<void> {
    this.elevated = this.d.run ? await isElevated(this.d.run) : false;
    if (this.elevated) this.d.log('clock: running elevated — the clock auto-fix is available');
  }

  capability(): FixCapability {
    return this.d.run && this.elevated ? 'elevated' : 'none';
  }

  decide(): { action: FixAction; reason: FixReason } {
    const { m, ageMs } = measurementView();
    return fixAction({
      skewMs: m?.skewMs ?? null,
      ageMs,
      secure: m?.secure === true,
      enabled: this.d.enabled(),
      capability: this.capability(),
      autoTimeOn: null,
      sdk: null,
      busy: this.d.busy(),
      sinceAutoTimeMs: null,
      sinceSetTimeMs: lastFixView().sinceMs,
    });
  }

  /** After a measured beat: fixes by itself only when elevated and the rule says so. */
  async afterMeasurement(): Promise<void> {
    if (this.running) return;
    const d = this.decide();
    if (d.action !== 'set_time' || this.capability() !== 'elevated' || !this.d.run) return;
    const { m } = measurementView();
    if (!m) return;
    this.running = true;
    try {
      const out = await runClockFix(this.d.run, -m.skewMs, true);
      noteFix({ action: 'set_time', result: out.result, fromMs: m.skewMs, message: out.message });
      this.d.log(`clock: auto-fix from ${m.skewMs} ms: ${out.result} (${out.message})`);
    } finally {
      this.running = false;
    }
  }

  /**
   * "תיקון שעון" (the technician's screen): automatic time on and a resync — and, when the device is off by 90 s or
   * more on a fresh measurement over TLS, the clock moved to the server's time first. Through the UAC prompt unless
   * elevated.
   */
  async technicianFix(): Promise<{ ok: boolean; message: string }> {
    if (!this.d.run) return { ok: false, message: 'לא נתמך בגרסה זו' };
    if (this.running) return { ok: false, message: 'תיקון כבר רץ' };
    if (this.d.busy()) return { ok: false, message: 'לא בזמן תשלום' };
    const { m, ageMs } = measurementView();
    const adjust = m && m.secure && ageMs !== null && ageMs <= 10 * 60_000 && Math.abs(m.skewMs) >= TRUST_MS ? -m.skewMs : null;
    this.running = true;
    try {
      const out = await runClockFix(this.d.run, adjust, this.elevated);
      noteFix({ action: adjust !== null ? 'set_time' : 'enable_auto_time', result: out.result, fromMs: m?.skewMs ?? null, message: out.message });
      this.d.log(`clock: technician fix (adjust ${adjust ?? 'none'} ms): ${out.result} (${out.message})`);
      return { ok: out.result === 'ok', message: out.message };
    } finally {
      this.running = false;
    }
  }

  /** The heartbeat's `clockTrust`. */
  report(): ClockTrustReport {
    const t = trusted();
    const { m } = measurementView();
    const { fix } = lastFixView();
    const d = this.decide();
    return {
      source: t.source,
      reason: t.reason,
      offsetMs: t.source === 'server' && m ? -m.skewMs : 0,
      autoFix: this.capability(),
      autoFixEnabled: this.d.enabled(),
      autoTime: null,
      pending: d.action,
      pendingReason: d.reason,
      lastFixAt: fix?.at ?? null,
      lastFixAction: fix?.action ?? null,
      lastFixResult: fix?.result ?? null,
      lastFixFromMs: fix?.fromMs ?? null,
    };
  }
}
