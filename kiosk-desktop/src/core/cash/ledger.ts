/**
 * The change on hand, per denomination — PayLink's `AvailableValue` is not implemented, so the host
 * keeps its own ledger (P:/specs/cash-paylink.md §11.9):
 *
 *  - a dispenser that counts (`CoinCountStatus` ACCURATE / ACCURATE_FULL: SmartHopper, MDB tubes,
 *    most note recyclers) is believed;
 *  - a level-only hopper (ccTalk hoppers with low / high sensors, or none) is counted by the ledger:
 *    the base staff set (refill / count) + coins routed into it since − coins it paid since (its
 *    lifetime `Count`), corrected by its sensors (LOW → at most the low level, HIGH → at least the
 *    high level when the settings give them);
 *  - the cashbox: notes and coins that went to it since it was last emptied (its capacity alert).
 *
 * Dispensers are identified by what they are (unit, address, value, serial), never by their index —
 * the manual: "the numbers are assigned dynamically and are liable to change from run to run".
 *
 * Pure.
 */

import type { AcceptorSnap, DeviceSnapshot, DispenserSnap } from './device';
import { accurateCount, DISPENSER_ACCURATE_FULL, DISPENSER_COIN_HIGH, DISPENSER_COIN_LOW, holdsChange } from './paylinkApi';
import type { CashSettings } from './settings';
import { inventoryOf, type Inventory } from './change';

export function dispenserKey(d: Pick<DispenserSnap, 'unit' | 'address' | 'valueAgorot' | 'serial'>): string {
  return `${d.unit >>> 0}:${d.address}:${d.valueAgorot}:${d.serial}`;
}

export function acceptorKey(a: Pick<AcceptorSnap, 'unit' | 'address' | 'serial'>): string {
  return `${a.unit >>> 0}:${a.address}:${a.serial}`;
}

/** What the ledger remembers for one dispenser (a level-only one counts by it). */
export interface LedgerUnit {
  valueAgorot: number;
  /** The count staff set (refill / count) … */
  base: number;
  /** … the dispenser's lifetime `Count` then … */
  countAtBase: number;
  /** … and the lifetime coins routed into it then (`feedCount`). */
  feedAtBase: number;
  setAt: number;
}

export interface CashboxBase {
  /** Lifetime totals at the last emptying. */
  noteCount: number;
  coinCount: number;
  notesRecycled: number;
  coinsFed: number;
  valueAgorot: number;
  /** Notes / coins dumped into the cashbox by the host since (recycler / SmartHopper dumps). */
  dumpedNotes: number;
  dumpedCoins: number;
  dumpedValueAgorot: number;
  setAt: number;
}

export interface LedgerState {
  units: Record<string, LedgerUnit>;
  cashbox: CashboxBase | null;
}

export const EMPTY_LEDGER: LedgerState = { units: {}, cashbox: null };

export interface DenominationView {
  valueAgorot: number;
  kind: 'coin' | 'note';
  count: number;
  /** Every dispenser of it counts by itself. */
  accurate: boolean;
  /** The sensors' word (the lowest of its dispensers): 'low' | 'mid' | 'high' | 'full' | null. */
  level: 'low' | 'mid' | 'high' | 'full' | null;
  /** Its float target / low level (settings). */
  target: number | null;
  low: number | null;
  /** At or below its low level (or the sensor says LOW). */
  isLow: boolean;
  isEmpty: boolean;
  dispensers: Array<{ key: string; index: number; cls: string; count: number; accurate: boolean; status: number; inhibit: boolean }>;
}

export interface LedgerView {
  denominations: DenominationView[];
  inventory: Inventory;
  changeAvailableAgorot: number;
  cashbox: { notes: number; coins: number; valueAgorot: number; nearFull: boolean; full: boolean };
}

/** Lifetime coins routed into a level-only hopper of `value` (the inserted coins that feed it). */
export function feedCount(snap: DeviceSnapshot, valueAgorot: number, feeds: CashSettings['hopperFeeds']): number {
  if (feeds === 'none') return 0;
  let n = 0;
  for (const a of snap.acceptors) {
    if (a.kind !== 'coin') continue;
    for (const c of a.coins) {
      if (c.valueAgorot !== valueAgorot) continue;
      if (feeds === 'all') n += c.count;
      // 'auto': the manual's "route to a hopper until it is full" — Path to the hopper, DefaultPath and
      // PathSwitchLevel both set; PathCount counts what went down the hopper path.
      else if (c.path !== 0 && c.defaultPath !== 0 && c.pathSwitchLevel !== 0) n += c.pathCount;
    }
  }
  return n;
}

function levelOf(d: DispenserSnap): DenominationView['level'] {
  if (d.coinCountStatus === DISPENSER_ACCURATE_FULL) return 'full';
  if (d.coinCountStatus === DISPENSER_COIN_LOW) return 'low';
  if (d.coinCountStatus === 2) return 'mid';
  if (d.coinCountStatus === DISPENSER_COIN_HIGH) return 'high';
  return null;
}

/** One dispenser's count: the device's, or the ledger's estimate. */
export function dispenserCount(snap: DeviceSnapshot, d: DispenserSnap, state: LedgerState, settings: CashSettings): { count: number; accurate: boolean } {
  if (accurateCount(d.coinCountStatus)) return { count: Math.max(0, d.coinCount), accurate: true };
  const u = state.units[dispenserKey(d)];
  if (!u) {
    // Never set by staff: unknown — counted as empty (prevent then keeps change-needing notes off).
    return { count: 0, accurate: false };
  }
  const fed = feedCount(snap, d.valueAgorot, settings.hopperFeeds) - u.feedAtBase;
  const paid = d.count - u.countAtBase;
  let est = Math.max(0, u.base + Math.max(0, fed) - Math.max(0, paid));
  const fl = settings.floatLevels[String(d.valueAgorot)];
  // The sensors correct the estimate (a level-only hopper's only truth).
  if (d.coinCountStatus === DISPENSER_COIN_LOW && fl && fl.low > 0) est = Math.min(est, fl.low);
  if (d.coinCountStatus === DISPENSER_COIN_HIGH && fl && fl.target > 0) est = Math.max(est, Math.floor(fl.target / 2));
  return { count: est, accurate: false };
}

/** Lifetime note / coin counts and what went into recyclers / hoppers. */
function lifetime(snap: DeviceSnapshot, feeds: CashSettings['hopperFeeds']) {
  let noteCount = 0;
  let coinCount = 0;
  let notesRecycled = 0;
  let valueAgorot = 0;
  let recycledValue = 0;
  for (const a of snap.acceptors) {
    for (const c of a.coins) {
      valueAgorot += c.count * c.valueAgorot;
      if (a.kind === 'note') {
        noteCount += c.count;
        if (c.path !== 0) {
          notesRecycled += c.pathCount;
          recycledValue += c.pathCount * c.valueAgorot;
        }
      } else coinCount += c.count;
    }
  }
  let coinsFed = 0;
  let fedValue = 0;
  const values = new Set(snap.dispensers.filter((d) => d.cls === 'hopper' || d.cls === 'ghost').map((d) => d.valueAgorot));
  for (const v of values) {
    const n = feedCount(snap, v, feeds);
    coinsFed += n;
    fedValue += n * v;
  }
  // Coin recyclers (SmartHopper with acceptor, MDB changers, BCR): routed coins go to their tubes.
  for (const a of snap.acceptors) {
    if (a.kind !== 'coin') continue;
    for (const c of a.coins) {
      if (c.path !== 0 && !(c.defaultPath !== 0 && c.pathSwitchLevel !== 0) && snap.dispensers.some((d) => (d.cls === 'smart_hopper' || d.cls === 'mdb_tube') && d.valueAgorot === c.valueAgorot)) {
        coinsFed += c.pathCount;
        fedValue += c.pathCount * c.valueAgorot;
      }
    }
  }
  return { noteCount, coinCount, notesRecycled, coinsFed, valueAgorot: valueAgorot - recycledValue - fedValue };
}

export function cashboxBaseOf(snap: DeviceSnapshot, settings: CashSettings, at: number): CashboxBase {
  const l = lifetime(snap, settings.hopperFeeds);
  return { ...l, dumpedNotes: 0, dumpedCoins: 0, dumpedValueAgorot: 0, setAt: at };
}

export function ledgerView(snap: DeviceSnapshot, state: LedgerState, settings: CashSettings): LedgerView {
  const byValue = new Map<number, DenominationView>();
  for (const d of snap.dispensers) {
    if (!holdsChange(d.cls) || d.valueAgorot <= 0 || d.valueAgorot >= 999_999_999) continue;
    const { count, accurate } = dispenserCount(snap, d, state, settings);
    let v = byValue.get(d.valueAgorot);
    if (!v) {
      const fl = settings.floatLevels[String(d.valueAgorot)];
      v = {
        valueAgorot: d.valueAgorot,
        kind: d.cls === 'note' ? 'note' : 'coin',
        count: 0,
        accurate: true,
        level: null,
        target: fl ? fl.target : null,
        low: fl ? fl.low : null,
        isLow: false,
        isEmpty: false,
        dispensers: [],
      };
      byValue.set(d.valueAgorot, v);
    }
    // A dispenser the host / Paylink inhibited (MDB level 2 tubes under level 3, a jam) still holds the coins:
    // they count as change only while not inhibited — except an MDB tube, which the level 3 payout uses.
    const usable = !d.inhibit || d.cls === 'mdb_tube';
    if (usable) v.count += count;
    v.accurate = v.accurate && accurate;
    const lv = levelOf(d);
    if (lv && (v.level === null || rank(lv) < rank(v.level))) v.level = lv;
    v.dispensers.push({ key: dispenserKey(d), index: d.index, cls: d.cls, count, accurate, status: d.status, inhibit: d.inhibit });
  }
  const denominations = [...byValue.values()].sort((a, b) => a.valueAgorot - b.valueAgorot);
  for (const v of denominations) {
    v.isEmpty = v.count <= 0;
    v.isLow = v.isEmpty || v.level === 'low' || (v.low !== null && v.low > 0 && v.count <= v.low);
  }
  const inventory = inventoryOf(denominations.map((d) => ({ valueAgorot: d.valueAgorot, count: d.count })));
  let change = 0;
  for (const [v, n] of inventory) change += v * n;
  // The cashbox since its last emptying.
  const base = state.cashbox;
  const now = lifetime(snap, settings.hopperFeeds);
  const notes = base ? Math.max(0, now.noteCount - base.noteCount - (now.notesRecycled - base.notesRecycled) + base.dumpedNotes) : 0;
  const coins = base ? Math.max(0, now.coinCount - base.coinCount - (now.coinsFed - base.coinsFed) + base.dumpedCoins) : 0;
  const value = base ? Math.max(0, now.valueAgorot - base.valueAgorot + base.dumpedValueAgorot) : 0;
  const cap = settings.cashboxCapacity;
  const nearFull = notes >= cap.notes * 0.9 || coins >= cap.coins * 0.9;
  const full = notes >= cap.notes || coins >= cap.coins;
  return { denominations, inventory, changeAvailableAgorot: change, cashbox: { notes, coins, valueAgorot: value, nearFull, full } };
}

function rank(l: NonNullable<DenominationView['level']>): number {
  return l === 'low' ? 0 : l === 'mid' ? 1 : l === 'high' ? 2 : 3;
}

/* ------------------------------------------------------------- staff operations */

/** "מילוי" / "ספירה" of one dispenser: the count staff put / found in it now. */
export function setUnitCount(state: LedgerState, snap: DeviceSnapshot, d: DispenserSnap, count: number, settings: CashSettings, at: number): LedgerState {
  return {
    ...state,
    units: {
      ...state.units,
      [dispenserKey(d)]: { valueAgorot: d.valueAgorot, base: Math.max(0, Math.round(count)), countAtBase: d.count, feedAtBase: feedCount(snap, d.valueAgorot, settings.hopperFeeds), setAt: at },
    },
  };
}

/** A refill of `added` into a dispenser: its count (device or ledger) + added. */
export function addToUnit(state: LedgerState, snap: DeviceSnapshot, d: DispenserSnap, added: number, settings: CashSettings, at: number): LedgerState {
  const cur = dispenserCount(snap, d, state, settings).count;
  return setUnitCount(state, snap, d, cur + Math.max(0, Math.round(added)), settings, at);
}

/** "ריקון קופסה": the cashbox was emptied now (its counters start again). */
export function emptyCashbox(state: LedgerState, snap: DeviceSnapshot, settings: CashSettings, at: number): LedgerState {
  return { ...state, cashbox: cashboxBaseOf(snap, settings, at) };
}

/** A dump the host ran moved `n` pieces of `value` into the cashbox. */
export function dumpedToCashbox(state: LedgerState, kind: 'note' | 'coin', n: number, valueAgorot: number): LedgerState {
  if (!state.cashbox || n <= 0) return state;
  const c = state.cashbox;
  return {
    ...state,
    cashbox: {
      ...c,
      dumpedNotes: c.dumpedNotes + (kind === 'note' ? n : 0),
      dumpedCoins: c.dumpedCoins + (kind === 'coin' ? n : 0),
      dumpedValueAgorot: c.dumpedValueAgorot + n * valueAgorot,
    },
  };
}
