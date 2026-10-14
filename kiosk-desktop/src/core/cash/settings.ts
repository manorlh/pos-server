/**
 * The cash settings (P:/specs/cash-paylink.md §6, §9, contract §11.6): all dynamic, by
 * organisation → company → shop → point of sale → device, resolved by the cloud and delivered with
 * `GET /sync/{m}/cash` (`settings`, the same keys as the till parameters). Read leniently here:
 * anything missing or malformed falls back to the default below — never a throw on the money path.
 *
 * Pure.
 */

export const ILS_COINS: readonly number[] = [10, 50, 100, 200, 500, 1000];
export const ILS_NOTES: readonly number[] = [2000, 5000, 10000, 20000];

export type ShortfallPolicy = 'prevent' | 'notify' | 'ask';
export type CashRounding = 'none' | 'nearest_10';
export type HopperFeeds = 'auto' | 'all' | 'none';

export interface FloatLevel {
  /** The float to keep in this denomination's dispenser (refill suggestion). */
  target: number;
  /** At or below this count: "עודף נמוך" for it. */
  low: number;
}

export interface CashSettings {
  /** A kiosk / till: it takes cash at a cash station. */
  enabled: boolean;
  /**
   * Which cash station ("עמדת מזומן", one PayLink unit — §12) serves it; '' = the shop's only one.
   * Several kiosks may share a station (they queue); a host box may run several stations.
   */
  stationId: string;
  coinsAccepted: number[];
  notesAccepted: number[];
  /** "עודף מקסימלי": no single insertion that would need more change than this is accepted. */
  maxChangeAgorot: number;
  /** "סכום מדויק" below this much change on hand. */
  exactChangeBelowAgorot: number;
  /** "מדיניות חוסר עודף" — prevent always runs first; notify (default) owes and alerts; ask: stage 2. */
  shortfall: ShortfallPolicy;
  /** Tills that get the cash alerts and the change owed ("שולם ללקוח"); [] = the shop's main till. */
  alertTills: string[];
  insertTimeoutSec: number;
  idleTimeoutSec: number;
  queueTimeoutSec: number;
  /** A kiosk that vanished mid-transaction: the host waits this long before refunding at the device. */
  refundGraceSec: number;
  rounding: CashRounding;
  /** Cash + card for the rest (stage 2: read, not acted on yet). */
  splitWithCard: boolean;
  /** By denomination (agorot): float target and low level. */
  floatLevels: Record<string, FloatLevel>;
  cashboxCapacity: { notes: number; coins: number };
  /** Lamp outputs: busy / fault / ready, and one per client device (arrow over the device). */
  lampMap: { busy: number | null; fault: number | null; ready: number | null; clients: Record<string, number> };
  /** Switch inputs: a door switch and a cashbox-present switch, and what "closed" means for each. */
  switchMap: { door: { n: number; closedMeans: 'closed' | 'open' } | null; cashbox: { n: number; closedMeans: 'present' | 'removed' } | null };
  receiptLines: boolean;
  /** The host runs the in-memory simulator instead of PayLink. */
  simulator: boolean;
  driverPath: string;
  dllPath: string;
  /** After the due is reached and acceptance is closed: wait for a coin still in the air. */
  settleMs: number;
  /** A bill presented as change and not taken in this long: the payout is abandoned (the bill goes back). */
  payoutTimeoutSec: number;
  /** Use a recycler's extended escrow when the unit has one (the customer's own notes back on cancel). */
  extendedEscrow: boolean;
  /** Whether inserted coins feed level-only hoppers ('auto': when the coin is routed to a hopper path with switching). */
  hopperFeeds: HopperFeeds;
  /** A paid transaction the kiosk never acknowledged becomes a held credit after this long. */
  unackedHoldMin: number;
}

export const DEFAULT_CASH_SETTINGS: CashSettings = {
  enabled: false,
  stationId: '',
  coinsAccepted: [...ILS_COINS],
  notesAccepted: [...ILS_NOTES],
  maxChangeAgorot: 10_000,
  exactChangeBelowAgorot: 3_000,
  shortfall: 'notify',
  alertTills: [],
  insertTimeoutSec: 180,
  idleTimeoutSec: 60,
  queueTimeoutSec: 120,
  refundGraceSec: 120,
  rounding: 'nearest_10',
  splitWithCard: false,
  floatLevels: {},
  cashboxCapacity: { notes: 500, coins: 1500 },
  lampMap: { busy: null, fault: null, ready: null, clients: {} },
  switchMap: { door: null, cashbox: null },
  receiptLines: true,
  simulator: false,
  driverPath: '',
  dllPath: '',
  settleMs: 1_000,
  payoutTimeoutSec: 60,
  extendedEscrow: true,
  hopperFeeds: 'auto',
  unackedHoldMin: 30,
};

/** The parameter keys (till parameters / `GET /sync/{m}/cash` settings) → the field above. */
export const CASH_PARAM_KEYS = {
  enabled: 'cashEnabled',
  stationId: 'cashStation',
  coinsAccepted: 'cashCoinsAccepted',
  notesAccepted: 'cashNotesAccepted',
  maxChangeAgorot: 'cashMaxChangeAgorot',
  exactChangeBelowAgorot: 'cashExactChangeBelowAgorot',
  shortfall: 'cashChangeShortfall',
  alertTills: 'cashAlertTills',
  insertTimeoutSec: 'cashInsertTimeoutSec',
  idleTimeoutSec: 'cashIdleTimeoutSec',
  queueTimeoutSec: 'cashQueueTimeoutSec',
  refundGraceSec: 'cashRefundGraceSec',
  rounding: 'cashRounding',
  splitWithCard: 'cashSplitWithCard',
  floatLevels: 'cashFloatLevels',
  cashboxCapacity: 'cashCashboxCapacity',
  lampMap: 'cashLampMap',
  switchMap: 'cashSwitchMap',
  receiptLines: 'cashReceiptLines',
  simulator: 'cashSimulator',
  driverPath: 'cashDriverPath',
  dllPath: 'cashDllPath',
  settleMs: 'cashSettleMs',
  payoutTimeoutSec: 'cashPayoutTimeoutSec',
  extendedEscrow: 'cashExtendedEscrow',
  hopperFeeds: 'cashHopperFeeds',
  unackedHoldMin: 'cashUnackedHoldMin',
} as const satisfies Record<keyof CashSettings, string>;

const bool = (v: unknown, d: boolean): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'כן'].includes(s)) return true;
    if (['false', '0', 'no', 'off', 'לא'].includes(s)) return false;
  }
  return d;
};

const int = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const str = (v: unknown, d: string): string => (typeof v === 'string' ? v.trim() : d);

function denoms(v: unknown, allowed: readonly number[], d: number[]): number[] {
  let raw: unknown = v;
  if (typeof v === 'string') {
    try {
      raw = JSON.parse(v);
    } catch {
      raw = v.split(/[,\s]+/).filter(Boolean).map(Number);
    }
  }
  if (!Array.isArray(raw)) return d;
  const out = [...new Set(raw.map((x) => Number(x)).filter((x) => allowed.includes(x)))].sort((a, b) => a - b);
  return out;
}

function obj(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function idList(v: unknown): string[] {
  let raw: unknown = v;
  if (typeof v === 'string') {
    try {
      raw = JSON.parse(v);
    } catch {
      raw = v.split(/[,\s]+/).filter(Boolean);
    }
  }
  return Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))] : [];
}

const output = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n < 64 ? n : null;
};

/** The settings from the cloud's `settings` object (or the raw till parameters). */
export function cashSettingsOf(raw: Record<string, unknown> | null | undefined): CashSettings {
  const p = raw ?? {};
  const K = CASH_PARAM_KEYS;
  const D = DEFAULT_CASH_SETTINGS;
  const shortfall = str(p[K.shortfall], D.shortfall);
  const rounding = str(p[K.rounding], D.rounding);
  const feeds = str(p[K.hopperFeeds], D.hopperFeeds);
  const floats: Record<string, FloatLevel> = {};
  const fl = obj(p[K.floatLevels]);
  if (fl) {
    for (const [k, v] of Object.entries(fl)) {
      const value = Number(k);
      if (!Number.isInteger(value) || value <= 0) continue;
      const o = obj(v);
      const target = int(o ? o.target : v, 0, 0, 100_000);
      const low = int(o ? o.low : 0, 0, 0, 100_000);
      floats[String(value)] = { target, low };
    }
  }
  const cap = obj(p[K.cashboxCapacity]);
  const lamps = obj(p[K.lampMap]);
  const clients: Record<string, number> = {};
  const lampClients = obj(lamps?.clients);
  if (lampClients) for (const [id, n] of Object.entries(lampClients)) if (output(n) !== null) clients[id] = output(n)!;
  const sw = obj(p[K.switchMap]);
  const door = obj(sw?.door);
  const box = obj(sw?.cashbox);
  return {
    enabled: bool(p[K.enabled], D.enabled),
    stationId: str(p[K.stationId], D.stationId),
    coinsAccepted: p[K.coinsAccepted] === undefined ? [...D.coinsAccepted] : denoms(p[K.coinsAccepted], ILS_COINS, [...D.coinsAccepted]),
    notesAccepted: p[K.notesAccepted] === undefined ? [...D.notesAccepted] : denoms(p[K.notesAccepted], ILS_NOTES, [...D.notesAccepted]),
    maxChangeAgorot: int(p[K.maxChangeAgorot], D.maxChangeAgorot, 0, 100_000),
    exactChangeBelowAgorot: int(p[K.exactChangeBelowAgorot], D.exactChangeBelowAgorot, 0, 1_000_000),
    shortfall: shortfall === 'prevent' || shortfall === 'notify' || shortfall === 'ask' ? shortfall : D.shortfall,
    alertTills: idList(p[K.alertTills]),
    insertTimeoutSec: int(p[K.insertTimeoutSec], D.insertTimeoutSec, 30, 900),
    idleTimeoutSec: int(p[K.idleTimeoutSec], D.idleTimeoutSec, 15, 600),
    queueTimeoutSec: int(p[K.queueTimeoutSec], D.queueTimeoutSec, 10, 900),
    refundGraceSec: int(p[K.refundGraceSec], D.refundGraceSec, 10, 1_800),
    rounding: rounding === 'none' || rounding === 'nearest_10' ? rounding : D.rounding,
    splitWithCard: bool(p[K.splitWithCard], D.splitWithCard),
    floatLevels: floats,
    cashboxCapacity: { notes: int(cap?.notes, D.cashboxCapacity.notes, 1, 100_000), coins: int(cap?.coins, D.cashboxCapacity.coins, 1, 100_000) },
    lampMap: { busy: output(lamps?.busy), fault: output(lamps?.fault), ready: output(lamps?.ready), clients },
    switchMap: {
      door: door && output(door.n) !== null ? { n: output(door.n)!, closedMeans: door.closedMeans === 'open' ? 'open' : 'closed' } : null,
      cashbox: box && output(box.n) !== null ? { n: output(box.n)!, closedMeans: box.closedMeans === 'removed' ? 'removed' : 'present' } : null,
    },
    receiptLines: bool(p[K.receiptLines], D.receiptLines),
    simulator: bool(p[K.simulator], D.simulator),
    driverPath: str(p[K.driverPath], D.driverPath),
    dllPath: str(p[K.dllPath], D.dllPath),
    settleMs: int(p[K.settleMs], D.settleMs, 200, 10_000),
    payoutTimeoutSec: int(p[K.payoutTimeoutSec], D.payoutTimeoutSec, 10, 600),
    extendedEscrow: bool(p[K.extendedEscrow], D.extendedEscrow),
    hopperFeeds: feeds === 'all' || feeds === 'none' || feeds === 'auto' ? feeds : D.hopperFeeds,
    unackedHoldMin: int(p[K.unackedHoldMin], D.unackedHoldMin, 5, 1_440),
  };
}

/** "₪13.50" style for Hebrew messages: whole shekels without decimals. */
export function shekelText(agorot: number): string {
  const v = Math.round(agorot) / 100;
  return `${Number.isInteger(v) ? v.toString() : v.toFixed(2)} ₪`;
}
