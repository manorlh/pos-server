/**
 * The till's clock as documents are stamped with it (core/clockTrust.ts): the device clock, or — from 90 s of skew
 * measured against the cloud over TLS — the server-corrected time. One per process: the ledger, the shift, the Z,
 * the drawer, attendance and the outbox read {@link nowDate} / {@link nowIso} instead of `new Date()`.
 *
 * The heartbeat feeds it ({@link noteMeasurement}); the last measurement is kept (`cloud.clockMeasurement`) so a
 * restarted app stamps the corrected time before its first beat — as long as the wall clock was not stepped and the
 * computer did not restart since (`bootWallMs`, core/clockTrust.ts `trustedNow`), else the device clock until the
 * next beat. Never throws.
 */

import os from 'node:os';
import { trustedNow, type ClockMeasurement, type FixAction, type FixResult, type Trusted } from '../../core/clockTrust';

export interface StoredMeasurement extends ClockMeasurement {
  /** Monotonic (uptime) at the measurement, for its age. */
  monoMs: number;
}

export interface LastFix {
  at: string;
  action: FixAction;
  result: FixResult;
  fromMs: number | null;
  /** Monotonic (uptime) at the attempt, for the cooldown. */
  monoMs: number;
  message?: string | null;
}

export interface ClockStore {
  load(): { m: StoredMeasurement | null; lastFix: LastFix | null };
  save(m: StoredMeasurement | null, lastFix: LastFix | null): void;
}

let wall: () => number = () => Date.now();
/** Milliseconds since the computer started (Windows: GetTickCount64 — not moved by a clock change). */
let mono: () => number = () => os.uptime() * 1000;
let measurement: StoredMeasurement | null = null;
let lastFix: LastFix | null = null;
let store: ClockStore | null = null;

/** Tests and the service: other clocks, a store. Loads what the store kept. */
export function configureTrustedClock(o: { wall?: () => number; mono?: () => number; store?: ClockStore | null }): void {
  if (o.wall) wall = o.wall;
  if (o.mono) mono = o.mono;
  if (o.store !== undefined) {
    store = o.store;
    try {
      const kept = store?.load() ?? { m: null, lastFix: null };
      measurement = kept.m;
      lastFix = kept.lastFix;
    } catch {
      measurement = null;
      lastFix = null;
    }
  }
}

/** Tests: back to the real clocks, nothing measured. */
export function resetTrustedClock(): void {
  wall = () => Date.now();
  mono = () => os.uptime() * 1000;
  measurement = null;
  lastFix = null;
  store = null;
}

function persist() {
  try {
    store?.save(measurement, lastFix);
  } catch {
    /* a store that fails keeps the memory copy */
  }
}

/** A heartbeat measured `skewMs` (device − server) on an answer that was `secure` (TLS / loopback). */
export function noteMeasurement(skewMs: number, secure: boolean): void {
  if (!Number.isFinite(skewMs)) return;
  const w = wall();
  const m = mono();
  measurement = { skewMs: Math.round(skewMs), bootWallMs: w - m, secure, monoMs: m };
  persist();
}

export function noteFix(fix: Omit<LastFix, 'monoMs' | 'at'> & { at?: string }): void {
  lastFix = { ...fix, at: fix.at ?? new Date(trusted().nowMs).toISOString(), monoMs: mono() };
  persist();
}

export function trusted(): Trusted {
  try {
    return trustedNow(wall(), mono(), measurement);
  } catch {
    return { nowMs: Date.now(), source: 'device', reason: 'none' };
  }
}

export function nowMs(): number {
  return trusted().nowMs;
}

export function nowDate(): Date {
  return new Date(nowMs());
}

export function nowIso(): string {
  return nowDate().toISOString();
}

/** The measurement as kept, with its monotonic age (null: none, or from before a restart). */
export function measurementView(): { m: StoredMeasurement | null; ageMs: number | null } {
  if (!measurement) return { m: null, ageMs: null };
  const age = mono() - measurement.monoMs;
  return { m: measurement, ageMs: age >= 0 ? age : null };
}

export function lastFixView(): { fix: LastFix | null; sinceMs: number | null } {
  if (!lastFix) return { fix: null, sinceMs: null };
  const since = mono() - lastFix.monoMs;
  return { fix: lastFix, sinceMs: since >= 0 ? since : null };
}
