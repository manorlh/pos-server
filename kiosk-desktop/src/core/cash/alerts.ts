/**
 * A cash station's alerts (contract §11.9): what is wrong now, by code and unit, for the heartbeat's
 * `cash.stations[].alerts` (the cloud opens / closes a `cash_unit` exception per code and unit, and
 * routes it to the manager and to `cashAlertTills`), the station's status and its fault lamp.
 *
 * Two kinds: conditions read from the device every tick (driver, DES, sensors, switches, levels),
 * and latched ones raised by an event (jam, fraud, stacker) and cleared by its "fixed" event, by a
 * NOW_OK of the same unit, or by staff.
 *
 * Pure.
 */

import type { DeviceSnapshot } from './device';
import type { LedgerView } from './ledger';
import {
  ACCEPTOR_DEAD,
  ACCEPTOR_FRAUD,
  ACCEPTOR_NO_KEY,
  classifyEvent,
  desOperational,
  PAY_FAILED_BLOCKED,
  PAY_FRAUD,
  PAY_JAMMED,
  PAY_NO_KEY,
  PAY_US,
  STANDARD_DRIVER,
} from './paylinkApi';
import { shekelText, type CashSettings } from './settings';

export type AlertCode =
  | 'offline'
  | 'driver_missing'
  | 'driver_down'
  | 'device_offline'
  | 'consistency'
  | 'jam'
  | 'fraud'
  | 'door_open'
  | 'stacker_full'
  | 'cashbox_removed'
  | 'cashbox_near_full'
  | 'hopper_low'
  | 'hopper_empty'
  | 'change_low'
  | 'bills_pending'
  | 'des_lock'
  | 'held_credit'
  | 'change_owed'
  | 'unacked';

export interface StationAlert {
  code: AlertCode;
  /** What it is about: "coin:100", "dispenser:<key>", "acceptor:<index>", "station". */
  unit: string;
  message: string;
  since: number;
}

/** Codes that stop the station taking money (status `fault`). */
export const BLOCKING: ReadonlySet<AlertCode> = new Set(['driver_missing', 'driver_down', 'device_offline', 'consistency', 'des_lock', 'fraud', 'stacker_full', 'cashbox_removed']);

export const ALERT_TEXT: Record<AlertCode, string> = {
  offline: 'שרת המזומן מנותק',
  driver_missing: 'דרייבר מזומן לא מותקן',
  driver_down: 'דרייבר המזומן לא פעיל',
  device_offline: 'מכשיר המזומן לא מחובר',
  consistency: 'שגיאת עקביות במכשיר המזומן',
  jam: 'תקיעה',
  fraud: 'ניסיון הונאה',
  door_open: 'דלת פתוחה',
  stacker_full: 'קופסת השטרות מלאה',
  cashbox_removed: 'קופסת הכסף הוסרה',
  cashbox_near_full: 'קופסת הכסף כמעט מלאה',
  hopper_low: 'עודף נמוך',
  hopper_empty: 'העודף אזל',
  change_low: 'עודף נמוך — סכום מדויק בלבד',
  bills_pending: 'שטרות ממתינים במכשיר אחרי הפסקת חשמל',
  des_lock: 'נעילת DES — המכשיר לא מזוהה',
  held_credit: 'זיכוי מוחזק',
  change_owed: 'עודף חייב ללקוח',
  unacked: 'עסקת מזומן ללא אישור מהקיוסק',
};

/** A latched alert (from an event). */
export interface Latched {
  code: 'jam' | 'fraud' | 'stacker_full' | 'bills_pending';
  unit: string;
  since: number;
  detail: string | null;
}

/** Applies one device event to the latched alerts (returns the new list). */
export function applyEvent(latched: readonly Latched[], e: { code: number; raw: number; dispenser: boolean; index: number; at: number }): Latched[] {
  const c = classifyEvent(e.code);
  const unit = `${e.dispenser ? 'dispenser' : 'acceptor'}:${e.index}`;
  const without = (codes: Latched['code'][]) => latched.filter((l) => !(l.unit === unit && codes.includes(l.code)));
  const add = (code: Latched['code']) => (latched.some((l) => l.unit === unit && l.code === code) ? [...latched] : [...latched, { code, unit, since: e.at, detail: c.name }]);
  switch (c.alert) {
    case 'jam':
      return add('jam');
    case 'jam_fixed':
      return without(['jam']);
    case 'fraud':
      return add('fraud');
    case 'stacker_problem':
      return add('stacker_full');
    case 'stacker_fixed':
      return without(['stacker_full']);
    case 'bills_pending':
      return add('bills_pending');
    case 'unit_ok':
      return without(['jam', 'stacker_full']);
    default:
      return [...latched];
  }
}

export interface AlertInput {
  now: number;
  /** The driver / DLL were found (the supervisor's word). */
  driverInstalled: boolean;
  snapshot: DeviceSnapshot | null;
  ledger: LedgerView | null;
  latched: readonly Latched[];
  settings: CashSettings;
  /** When each code was first seen (kept by the station so `since` is stable). */
  firstSeen: Map<string, number>;
  /** Paid transactions the kiosk never acknowledged (older than a minute). */
  unackedCount: number;
  exactOnly: boolean;
}

/** Door / cashbox switch states (null: no switch mapped). */
export function switchStates(snap: DeviceSnapshot | null, settings: CashSettings): { doorOpen: boolean | null; cashboxPresent: boolean | null } {
  const closed = (n: number): boolean | null => {
    const s = snap?.switches.find((x) => x.n === n);
    // The manual: closes == opens ⇔ the switch is open now (every switch starts open).
    return s ? s.closes > s.opens : null;
  };
  const door = settings.switchMap.door;
  const box = settings.switchMap.cashbox;
  const dc = door ? closed(door.n) : null;
  const bc = box ? closed(box.n) : null;
  return {
    doorOpen: dc === null ? null : door!.closedMeans === 'closed' ? !dc : dc,
    cashboxPresent: bc === null ? null : box!.closedMeans === 'present' ? bc : !bc,
  };
}

export function stationAlerts(i: AlertInput): StationAlert[] {
  const out: Array<Omit<StationAlert, 'since'>> = [];
  const s = i.snapshot;
  if (!i.driverInstalled) out.push({ code: 'driver_missing', unit: 'station', message: ALERT_TEXT.driver_missing });
  else if (!s || !s.open) {
    if (s && s.driver !== null && s.driver !== STANDARD_DRIVER) out.push({ code: 'driver_down', unit: 'station', message: ALERT_TEXT.driver_down });
    else out.push({ code: 'device_offline', unit: 'station', message: ALERT_TEXT.device_offline });
  }
  if (s && s.open) {
    if (s.driver !== null && s.driver !== STANDARD_DRIVER) out.push({ code: 'driver_down', unit: 'station', message: ALERT_TEXT.driver_down });
    if (s.consistencyError) out.push({ code: 'consistency', unit: 'station', message: `${ALERT_TEXT.consistency}: ${s.consistencyError}` });
    if (!desOperational(s.des)) out.push({ code: 'des_lock', unit: 'station', message: ALERT_TEXT.des_lock });
    for (const a of s.acceptors) {
      if (a.status & ACCEPTOR_NO_KEY) out.push({ code: 'des_lock', unit: `acceptor:${a.index}`, message: `${ALERT_TEXT.des_lock} (${a.kind === 'note' ? 'מקבל שטרות' : 'מקבל מטבעות'})` });
      if (a.status & ACCEPTOR_FRAUD) out.push({ code: 'fraud', unit: `acceptor:${a.index}`, message: `${ALERT_TEXT.fraud} (${a.kind === 'note' ? 'מקבל שטרות' : 'מקבל מטבעות'})` });
      if (a.status & ACCEPTOR_DEAD) out.push({ code: 'device_offline', unit: `acceptor:${a.index}`, message: `${a.kind === 'note' ? 'מקבל השטרות' : 'מקבל המטבעות'} לא מגיב` });
    }
    for (const d of s.dispensers) {
      const what = d.valueAgorot > 0 && d.valueAgorot < 999_999_999 ? shekelText(d.valueAgorot) : 'מכונת עודף';
      if (d.status === PAY_NO_KEY) out.push({ code: 'des_lock', unit: `dispenser:${d.index}`, message: `${ALERT_TEXT.des_lock} (${what})` });
      if (d.status === PAY_FRAUD) out.push({ code: 'fraud', unit: `dispenser:${d.index}`, message: `${ALERT_TEXT.fraud} (${what})` });
      if (d.status === PAY_JAMMED || d.status === PAY_FAILED_BLOCKED) out.push({ code: 'jam', unit: `dispenser:${d.index}`, message: `${ALERT_TEXT.jam}: ${what}` });
      if (d.status === PAY_US) out.push({ code: 'device_offline', unit: `dispenser:${d.index}`, message: `מכונת העודף ${what} לא פעילה` });
    }
  }
  for (const l of i.latched) {
    if (out.some((o) => o.code === l.code && o.unit === l.unit)) continue;
    out.push({ code: l.code, unit: l.unit, message: ALERT_TEXT[l.code] });
  }
  const sw = switchStates(s, i.settings);
  if (sw.doorOpen === true) out.push({ code: 'door_open', unit: 'door', message: ALERT_TEXT.door_open });
  if (sw.cashboxPresent === false) out.push({ code: 'cashbox_removed', unit: 'cashbox', message: ALERT_TEXT.cashbox_removed });
  if (i.ledger && s?.open) {
    if (i.ledger.cashbox.full) out.push({ code: 'stacker_full', unit: 'cashbox', message: ALERT_TEXT.stacker_full });
    else if (i.ledger.cashbox.nearFull) out.push({ code: 'cashbox_near_full', unit: 'cashbox', message: ALERT_TEXT.cashbox_near_full });
    for (const d of i.ledger.denominations) {
      if (d.isEmpty) out.push({ code: 'hopper_empty', unit: `${d.kind}:${d.valueAgorot}`, message: `${ALERT_TEXT.hopper_empty}: ${shekelText(d.valueAgorot)}` });
      else if (d.isLow) out.push({ code: 'hopper_low', unit: `${d.kind}:${d.valueAgorot}`, message: `${ALERT_TEXT.hopper_low}: ${shekelText(d.valueAgorot)}` });
    }
    if (i.exactOnly && i.ledger.denominations.length > 0) out.push({ code: 'change_low', unit: 'station', message: ALERT_TEXT.change_low });
  }
  if (i.unackedCount > 0) out.push({ code: 'unacked', unit: 'station', message: `${ALERT_TEXT.unacked} (${i.unackedCount})` });
  // Stable `since`, and only one row per code+unit.
  const seen = new Set<string>();
  const result: StationAlert[] = [];
  for (const a of out) {
    const key = `${a.code}|${a.unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!i.firstSeen.has(key)) i.firstSeen.set(key, i.now);
    result.push({ ...a, since: i.firstSeen.get(key)! });
  }
  for (const k of [...i.firstSeen.keys()]) if (!seen.has(k)) i.firstSeen.delete(k);
  return result;
}

/**
 * Whether any alert stops the station from taking money: the station itself (driver, device,
 * consistency, DES), fraud, a stacker problem the acceptor reported, a removed cashbox. A ledger
 * estimate ("the cashbox is full by our count") only alerts — staff may have emptied it unrecorded.
 */
export function blocking(alerts: readonly StationAlert[]): StationAlert | null {
  return (
    alerts.find((a) => {
      if (!BLOCKING.has(a.code)) return false;
      if (a.code === 'stacker_full') return a.unit !== 'cashbox';
      if (a.code === 'device_offline' || a.code === 'des_lock') return a.unit === 'station';
      return true;
    }) ?? null
  );
}
