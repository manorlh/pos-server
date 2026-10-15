/**
 * The PayLink (Aardvark / Money Controls "Milan") API's numbers, as the vendor's C header
 * (AESImhei.h, interface version 0x10008) defines them — only the constants and the pure
 * classification the cash host needs. The vendor's files themselves are never part of this app
 * (P:/specs/cash-paylink.md §9ב: the driver and the DLL are installed separately).
 *
 * The API is device-agnostic: every coin / note acceptor, hopper, recycler and MDB changer PayLink
 * supports is an `AcceptorBlock` or a `DispenserBlock`, told apart by the `Unit` code below. The
 * per-family behaviour the manuals describe (level-only hoppers, SmartHopper's per-denomination
 * dispensers with one "total", MDB level 2 tubes beside the level 3 payout, recyclers' dumps and
 * count updates, bills held for collection) is classified here once, and the host acts on the class.
 *
 * Pure: no Node, no FFI.
 */

/** OpenMHEVersion(INTERFACE_VERSION): the header's version (CASHLESS_CREDIT). */
export const INTERFACE_VERSION = 0x10008;

/* ----------------------------------------------------------- OpenMHE errors */

/** OpenMHE's Windows error codes, and whether the manual says to retry (for ≥ 5 s). */
export const OPEN_ERRORS: Record<number, { text: string; retry: boolean }> = {
  13: { text: 'גרסאות הספרייה, הדרייבר והמכשיר אינן תואמות', retry: false },
  20: { text: 'המכשיר לא נמצא', retry: false },
  21: { text: 'המכשיר לא מוכן', retry: true },
  31: { text: 'דרייבר המזומן (Paylink.exe) לא רץ', retry: true },
  170: { text: 'חיבור ה-USB תפוס', retry: true },
  1167: { text: 'מכשיר המזומן לא מחובר', retry: true },
};

/* ----------------------------------------------------------- acceptors */

export const ACCEPTOR_DEAD = 0x01;
export const ACCEPTOR_DISABLED = 0x04;
export const ACCEPTOR_INHIBIT = 0x08;
export const ACCEPTOR_FRAUD = 0x10;
export const ACCEPTOR_BUSY = 0x20;
export const ACCEPTOR_FAULT = 0x40;
export const ACCEPTOR_NO_KEY = 0x80;
export const MAX_ACCEPTOR_COINS = 256;

/* ----------------------------------------------------------- dispensers */

export const MAX_DISPENSERS = 16;

/** DispenserBlock.CoinCountStatus: level sensors only (0..3), or the device's own count (−1 / −2). */
export const DISPENSER_COIN_NONE = 0;
export const DISPENSER_COIN_LOW = 1;
export const DISPENSER_COIN_MID = 2;
export const DISPENSER_COIN_HIGH = 3;
export const DISPENSER_ACCURATE = -1;
export const DISPENSER_ACCURATE_FULL = -2;

/** DispenserBlock.Status written by the application (and the acknowledgements Paylink writes back). */
export const DISPENSER_REASSIGN_VALUE = 100;
export const DISPENSER_VALUE_REASSIGNED = 101;
export const DISPENSER_UPDATE_COUNT = 110;
export const DISPENSER_COUNT_UPDATED = 111;
export const DISPENSER_CASHBOX_DUMP = 120;
export const DISPENSER_PARTIAL_DUMP = 121;
export const DISPENSER_DUMP_FINISHED = 122;
export const DISPENSER_RESET_STATUS = 200;

/* ----------------------------------------------------------- LastPayStatus / dispenser Status */

export const PAY_ONGOING = 0;
export const PAY_FINISHED = 1;
export const PAY_EMPTY = -1;
export const PAY_JAMMED = -2;
export const PAY_US = -3;
export const PAY_FRAUD = -4;
export const PAY_FAILED_BLOCKED = -5;
export const PAY_NO_HOPPER = -6;
export const PAY_INHIBITED = -7;
export const PAY_SECURITY_FAIL = -8;
export const PAY_HOPPER_RESET = -9;
export const PAY_NOT_EXACT = -10;
export const PAY_GHOST = -11;
export const PAY_NO_KEY = -12;

export const PAY_TEXT: Record<number, string> = {
  [PAY_ONGOING]: 'משלם',
  [PAY_FINISHED]: 'תקין',
  [PAY_EMPTY]: 'ריק',
  [PAY_JAMMED]: 'תקוע',
  [PAY_US]: 'לא פעיל',
  [PAY_FRAUD]: 'ניסיון הונאה',
  [PAY_FAILED_BLOCKED]: 'חסום',
  [PAY_NO_HOPPER]: 'אין מכונת עודף מתאימה',
  [PAY_INHIBITED]: 'מושבת',
  [PAY_SECURITY_FAIL]: 'בדיקה עצמית נכשלה',
  [PAY_HOPPER_RESET]: 'אותחל באמצע תשלום',
  [PAY_NOT_EXACT]: 'לא יכול לשלם סכום מדויק',
  [PAY_GHOST]: 'חלק של יחידה אחרת',
  [PAY_NO_KEY]: 'ממתין למפתח DES',
};

/* ----------------------------------------------------------- extended escrow (1.12.6) */

export const EXT_ESCROW_NONE = 0;
export const EXT_ESCROW_OFF = 1;
export const EXT_ESCROW_IDLE = 2;
export const EXT_ESCROW_WAITING = 3;
export const EXT_ESCROW_LOADING = 4;
export const EXT_ESCROW_STORED = 5;
export const EXT_ESCROW_PAUSED = 6;
export const EXT_ESCROW_STACKING = 7;
export const EXT_ESCROW_RETURNING = 8;
export const EXT_ESCROW_RETURNED_OK = 9;
export const EXT_ESCROW_RETURNING_PROBLEM = 10;
export const EXT_ESCROW_STACKED_OK = 11;
export const EXT_ESCROW_STACKING_PROBLEM = 12;
export const EXT_ESCROW_FULL = 13;
export const EXT_ESCROW_POWER_ACTIVE = 14;

export const EXT_ESCROW_COMPLETE = 0;
export const EXT_ESCROW_BUSY = 1;
export const EXT_ESCROW_WRONGSTATE = 2;
export const EXT_ESCROW_ERROR = 3;

export const EXT_ESCROW_START = 0;
export const EXT_ESCROW_STOP = 1;
export const EXT_ESCROW_ACCEPT = 2;
export const EXT_ESCROW_PAUSE = 3;
export const EXT_ESCROW_STACK = 4;
export const EXT_ESCROW_RETURN = 5;
export const MAX_ESCROW = 64;

/* ----------------------------------------------------------- DES lock */

export const DES_UNLOCKED = 0;
export const DES_MATCH = 1;
export const DES_NOT = -1;
export const DES_WRONG = -2;
export const DES_CHECKING = -3;
export const DES_APPLYING = -4;

/** The manual: PayLink works only while DESStatus is UNLOCKED or MATCH (or it is not a DES unit). */
export function desOperational(status: number | null): boolean {
  return status === null || status === DES_UNLOCKED || status === DES_MATCH || status === DES_NOT;
}

/* ----------------------------------------------------------- USB driver */

export const NOT_USB = -1;
export const USB_IDLE = 0;
export const STANDARD_DRIVER = 1;
export const FLASH_LOADER = 2;
export const MANUFACTURING_TEST = 3;
export const DRIVER_RESTART = 4;
export const USB_ERROR = 5;

export const DRIVER_TEXT: Record<number, string> = {
  [NOT_USB]: 'כרטיס PCI',
  [USB_IDLE]: 'הדרייבר לא רץ',
  [STANDARD_DRIVER]: 'הדרייבר רץ',
  [FLASH_LOADER]: 'כלי עדכון הקושחה תופס את החיבור',
  [MANUFACTURING_TEST]: 'כלי הבדיקה של היצרן תופס את החיבור',
  [DRIVER_RESTART]: 'הדרייבר מופעל מחדש',
  [USB_ERROR]: 'שגיאת USB בדרייבר',
};

/** The manual: the system is not usable for 10 s after a driver (re)start, 20 s after a PayLink reset. */
export const DRIVER_SETTLE_MS = 10_000;
export const PAYLINK_RESET_SETTLE_MS = 20_000;
/** OpenMHE retried until it has failed for 5 consecutive seconds. */
export const OPEN_RETRY_MS = 5_000;
/** CheckOperation every ~500 ms (the manual's suggestion); the unit disables the acceptors when it lapses. */
export const WATCHDOG_EVERY_MS = 500;
export const WATCHDOG_TIMEOUT_MS = 2_500;
/** IMHEIConsistencyError's defaults (fastest plausible coin / note insertion). */
export const STANDARD_COIN_TIME = 500;
export const STANDARD_NOTE_TIME = 5_000;

/* ----------------------------------------------------------- device identities */

export const DP_GENERIC_MASK = 0xff000000;
export const DP_COIN_ACCEPT_DEVICE = 0x02000000;
export const DP_NOTE_ACCEPT_DEVICE = 0x12000000;
export const DP_CARD_ACCEPT_DEVICE = 0x22000000;
export const DP_COIN_PAYOUT_DEVICE = 0x01000000;
export const DP_NOTE_PAYOUT_DEVICE = 0x11000000;
export const DP_INTERFACE_MASK = 0x00ff0000;
export const DP_MANUFACTURER_MASK = 0x0000ff00;

export const DP_CCTALK_INTERFACE = 0x00020000;
export const DP_SSP_INTERFACE = 0x00030000;
export const DP_JCM_INTERFACE = 0x00060000;
export const DP_MDB_INTERFACE = 0x00080000;
export const DP_MDB_LEVEL_2_INTERFACE = 0x00090000;
export const DP_F56_INTERFACE = 0x000a0000;
export const DP_CCNET_INTERFACE = 0x000b0000;
export const DP_EBDS_INTERFACE = 0x000d0000;
export const DP_DLL_INTERFACE = 0x000e0000;
export const DP_CLS_INTERFACE = 0x000f0000;
export const DP_MANU_INNOVATIVE_TECH = 0x00000200;

/** MDB changer: one level-2 dispenser per tube (pre-inhibited) and one level-3 payout dispenser. */
export const DP_MDB_LEVEL_2_TUBE = DP_MDB_LEVEL_2_INTERFACE | DP_COIN_PAYOUT_DEVICE;
export const DP_MDB_TYPE_3_PAYOUT = DP_MDB_INTERFACE | DP_COIN_PAYOUT_DEVICE;
/** The combi hopper's higher coin ("ghost"): counted by its own Count. */
export const DP_CC_GHOST_HOPPER = 255 | DP_CCTALK_INTERFACE | DP_COIN_PAYOUT_DEVICE;
/** Innovative SmartHopper: a dispenser per denomination, and one for the whole unit (dumps). */
export const DP_SHOPPER_TOTAL = 3 | DP_MANU_INNOVATIVE_TECH | DP_CCTALK_INTERFACE | DP_COIN_PAYOUT_DEVICE;
export const DP_SHOPPER = 4 | DP_MANU_INNOVATIVE_TECH | DP_CCTALK_INTERFACE | DP_COIN_PAYOUT_DEVICE;

const u32 = (n: number) => n >>> 0;

export function isCoinAcceptor(unit: number): boolean {
  return u32(unit & DP_GENERIC_MASK) === DP_COIN_ACCEPT_DEVICE;
}
export function isNoteAcceptor(unit: number): boolean {
  return u32(unit & DP_GENERIC_MASK) === DP_NOTE_ACCEPT_DEVICE;
}
export function isNoteDispenser(unit: number): boolean {
  return u32(unit & DP_GENERIC_MASK) === DP_NOTE_PAYOUT_DEVICE;
}
export function interfaceOf(unit: number): number {
  return u32(unit & DP_INTERFACE_MASK);
}

export type BusName = 'cctalk' | 'ssp' | 'id003' | 'mdb' | 'f56' | 'ccnet' | 'ebds' | 'usb' | 'cls' | 'other';

export function busOf(unit: number): BusName {
  switch (interfaceOf(unit)) {
    case DP_CCTALK_INTERFACE:
      return 'cctalk';
    case DP_SSP_INTERFACE:
      return 'ssp';
    case DP_JCM_INTERFACE:
      return 'id003';
    case DP_MDB_INTERFACE:
    case DP_MDB_LEVEL_2_INTERFACE:
      return 'mdb';
    case DP_F56_INTERFACE:
      return 'f56';
    case DP_CCNET_INTERFACE:
      return 'ccnet';
    case DP_EBDS_INTERFACE:
      return 'ebds';
    case DP_DLL_INTERFACE:
      return 'usb';
    case DP_CLS_INTERFACE:
      return 'cls';
    default:
      return 'other';
  }
}

/**
 * What a dispenser is, for the change ledger and the staff screen:
 *
 *  - `hopper`        a coin hopper (ccTalk SCH/SUH, Azkoyen, TFlex, CX25…) — its count is the device's
 *                    when `CoinCountStatus` says ACCURATE, else level sensors only (the ledger counts);
 *  - `smart_hopper`  one denomination of an Innovative SmartHopper (accurate; partial dump only);
 *  - `smart_total`   the SmartHopper as a whole — no value of its own; only for the full dump;
 *  - `mdb_tube`      one tube of an MDB changer (level 2, pre-inhibited while level 3 exists; accurate-ish);
 *  - `mdb_payout`    the MDB changer's level 3 payout — a virtual dispenser, never counted;
 *  - `ghost`         the combi hopper's second coin (its counts settle only at the end of a payout);
 *  - `note`          a note recycler's unit / bill dispenser (ccTalk, ID-003, MDB, CCNet, EBDS, BNR, F56):
 *                    usually accurate; dumps where the device allows (never MDB).
 */
export type DispenserClass = 'hopper' | 'smart_hopper' | 'smart_total' | 'mdb_tube' | 'mdb_payout' | 'ghost' | 'note';

export function dispenserClass(unit: number): DispenserClass {
  const u = u32(unit);
  if (u === u32(DP_SHOPPER_TOTAL)) return 'smart_total';
  if (u === u32(DP_SHOPPER)) return 'smart_hopper';
  if (u === u32(DP_MDB_TYPE_3_PAYOUT)) return 'mdb_payout';
  if (u === u32(DP_MDB_LEVEL_2_TUBE)) return 'mdb_tube';
  if (u === u32(DP_CC_GHOST_HOPPER)) return 'ghost';
  if (isNoteDispenser(u)) return 'note';
  return 'hopper';
}

/** A dispenser whose coins are change on hand (a virtual / whole-unit one is not). */
export function holdsChange(cls: DispenserClass): boolean {
  return cls !== 'smart_total' && cls !== 'mdb_payout';
}

/** The full dump ("ריקון לקופסה"): recyclers and the SmartHopper as a whole; never MDB, never a plain hopper. */
export function canFullDump(cls: DispenserClass, bus: BusName): boolean {
  if (bus === 'mdb') return false;
  return cls === 'note' || cls === 'smart_total';
}

/** The partial dump (leave a float): note recyclers (not MDB) and SmartHopper denominations. */
export function canPartialDump(cls: DispenserClass, bus: BusName): boolean {
  if (bus === 'mdb') return false;
  return cls === 'note' || cls === 'smart_hopper';
}

/** DISPENSER_UPDATE_COUNT: only JCM UBA / iPro (ID-003) recyclers take a count from the application. */
export function canUpdateDeviceCount(cls: DispenserClass, bus: BusName): boolean {
  return cls === 'note' && bus === 'id003';
}

/** The device keeps the count (CoinCountStatus ACCURATE / ACCURATE_FULL). */
export function accurateCount(coinCountStatus: number): boolean {
  return coinCountStatus === DISPENSER_ACCURATE || coinCountStatus === DISPENSER_ACCURATE_FULL;
}

/* ----------------------------------------------------------- events (ImheiEvent.h) */

export const EVENT_CODE_MASK = 0x03f;
export const FAULT_BIT = 0x020;
export const COIN_DISPENSER_EVENT = 0x040;
export const NOTE_DISPENSER_EVENT = 0x080;
export const COIN_EVENT = 0x0c0;
export const NOTE_EVENT = 0x100;
export const IMHEI_OVERFLOW = 0x1f;

/** The common base codes (bottom bits). */
export const EV = {
  REJECTED: 2,
  INHIBITED: 3,
  MISREAD: 4,
  FRAUD: 5,
  JAM: 6,
  JAM_FIXED: 7,
  RETURN: 8,
  OUTPUT_PROBLEM: 9,
  OUTPUT_FIXED: 10,
  INTERNAL_PROBLEM: 11,
  UNKNOWN: 12,
  DISPENSE_UPDATE: 13,
  UNRECOGNISED: 14,
  DISPENSE_PENDING: 15,
  INPUT_STOPPED: 16,
  INPUT_STARTED: 17,
} as const;

/** Fault codes (with FAULT_BIT). */
export const FAULT = { NOW_OK: 0, REPORTED_FAULT: 1, UNIT_TIMEOUT: 2, UNIT_RESET: 3, SELF_TEST_REFUSED: 4 } as const;

export type EventUnit = 'coin' | 'note' | 'coin_dispenser' | 'note_dispenser' | 'system';

export interface ClassifiedEvent {
  unit: EventUnit;
  /** A fault (cleared later by a NOW_OK of the same unit) or a notification. */
  fault: boolean;
  /** What the host does with it: an alert's code, a note in the log, or nothing. */
  alert:
    | 'jam'
    | 'jam_fixed'
    | 'fraud'
    | 'stacker_problem'
    | 'stacker_fixed'
    | 'unit_fault'
    | 'unit_ok'
    | 'bills_pending'
    | 'dispenser_update'
    | 'overflow'
    | null;
  name: string;
}

/** ImheiEvent's code → what it means here. */
export function classifyEvent(code: number): ClassifiedEvent {
  if (code === IMHEI_OVERFLOW) return { unit: 'system', fault: false, alert: 'overflow', name: 'IMHEI_OVERFLOW' };
  const type = code & ~EVENT_CODE_MASK;
  const unit: EventUnit =
    type === COIN_EVENT ? 'coin' : type === NOTE_EVENT ? 'note' : type === COIN_DISPENSER_EVENT ? 'coin_dispenser' : type === NOTE_DISPENSER_EVENT ? 'note_dispenser' : 'system';
  const fault = (code & FAULT_BIT) !== 0;
  const base = code & (EVENT_CODE_MASK & ~FAULT_BIT);
  if (fault) {
    if (base === FAULT.NOW_OK) return { unit, fault, alert: 'unit_ok', name: `${unit}:NOW_OK` };
    return { unit, fault, alert: 'unit_fault', name: `${unit}:FAULT_${base}` };
  }
  switch (base) {
    case EV.FRAUD:
      return { unit, fault, alert: 'fraud', name: `${unit}:FRAUD` };
    case EV.JAM:
      return { unit, fault, alert: 'jam', name: `${unit}:JAM` };
    case EV.JAM_FIXED:
      return { unit, fault, alert: 'jam_fixed', name: `${unit}:JAM_FIXED` };
    case EV.OUTPUT_PROBLEM:
      return { unit, fault, alert: unit === 'coin' ? 'jam' : 'stacker_problem', name: `${unit}:OUTPUT_PROBLEM` };
    case EV.OUTPUT_FIXED:
      return { unit, fault, alert: unit === 'coin' ? 'jam_fixed' : 'stacker_fixed', name: `${unit}:OUTPUT_FIXED` };
    case EV.DISPENSE_PENDING:
      return { unit, fault, alert: 'bills_pending', name: `${unit}:DISPENSE_PENDING` };
    case EV.DISPENSE_UPDATE:
      return { unit, fault, alert: 'dispenser_update', name: `${unit}:DISPENSE_UPDATE` };
    default:
      return { unit, fault, alert: null, name: `${unit}:${base}` };
  }
}

/** The firmware version as "a.b.c.d" (4 × 8 bit). */
export function firmwareText(v: number): string {
  const x = v >>> 0;
  return [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff].join('.');
}

/**
 * PaySpecific / SetDispenseQuantity exist from release 1.12.6 on. A release is shown "V4-1-12-6"
 * (the unit's own photo: V4-1-12-6): the feature numbers of the manuals are the last three parts.
 */
export function hasPrecisePay(firmware: number | null): boolean {
  if (firmware === null) return false;
  const x = firmware >>> 0;
  const major = (x >>> 16) & 0xff;
  const minor = (x >>> 8) & 0xff;
  const patch = x & 0xff;
  return major > 1 || (major === 1 && (minor > 12 || (minor === 12 && patch >= 6)));
}
