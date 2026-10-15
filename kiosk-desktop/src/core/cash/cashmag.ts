/**
 * CashMag (CMC Monetic) on the Windows kiosk — the money's rules (P:/specs/cashmag.md §12, the contract the
 * Android till and kiosk keep in pos-android `domain/CashMag.kt`; P:/specs/cashmag-windows.md for this side).
 *
 * A cash recycler run by the vendor's own CashMag server on a PC of its own on the shop's LAN: the kiosk is a
 * network client of it, exactly like the Android kiosk (the owner: "קיוסק ווינדוס פונה לקאש מג כמו קיוסק
 * אנדרואיד"). It is a second cash device beside PayLink's cash station: the document's `cash` leg carries
 * `cashDevice` the same way (`stationId` `cashmag:<host>:<port>`, `hostId` `cashmag`).
 *
 * Everything here is pure, in agorot (never floating point on the money path), and names no wire format: what
 * the server answered comes in as a [CashRecyclerReply] (core/cash/cashmagWire.ts reads the wire into it) and
 * leaves as a [CashMagOutcome]. The shared golden fixture (test/fixtures/cashmag_outcomes_golden.json, byte-equal
 * with pos-android's) pins it.
 */

import { halfUpScaled } from '../money';

/* ------------------------------------------------------------------ the settings */

export type CashMagRounding = 'none' | 'nearest_10';

/**
 * `cashmagProtocol` (pos-server app/services/cashmag_params.py): `jar` — the CMCMonetic API, the protocol the
 * vendor's client jar speaks (on Windows this kiosk speaks it itself over the WebSocket, core/cash/cashmagWire.ts);
 * `rlp` — the vendor's "Full Protocol", whose wire format we do not have: "not available", never guessed.
 */
export type CashMagProtocol = 'jar' | 'rlp';

/** The vendor's documented RLP port (unused until RLP exists). */
export const RLP_DEFAULT_PORT = 55110;

export const CASHMAG_PARAMS = {
  enabled: 'cashmagEnabled',
  protocol: 'cashmagProtocol',
  host: 'cashmagHost',
  port: 'cashmagPort',
  terminal: 'cashmagTerminal',
  userCode: 'cashmagUserCode',
  currency: 'cashmagCurrency',
  rounding: 'cashmagRounding',
  queueTimeoutSec: 'cashmagQueueTimeoutSec',
  autoCancelSec: 'cashmagAutoCancelSec',
  callTimeoutSec: 'cashmagCallTimeoutSec',
} as const;

export const DEFAULT_CURRENCY = 'ILS';
export const DEFAULT_CALL_TIMEOUT_SEC = 30;
export const DEFAULT_TERMINAL = 'R2M Kiosk';

/**
 * The kiosk's own (kiosk.json `cashmag`, never synced): a kiosk standing next to its machine may name the server
 * itself — the owner: "הכל מהענן ויורד לקופה או בהגדרה של קיוסק מקומי". Empty / absent: the cloud's.
 */
export interface CashMagLocal {
  host?: string | null;
  port?: number | null;
  terminal?: string | null;
  userCode?: string | null;
}

export type CashMagSource = 'cloud' | 'local' | 'default';

export interface CashMagConfig {
  enabled: boolean;
  protocol: CashMagProtocol;
  host: string;
  port: number;
  /** This kiosk's name at the CashMag server. */
  terminal: string;
  /** The numeric user code of the CashMag configuration (`setUserName`). Never in a log line. */
  userCode: string;
  currency: string;
  rounding: CashMagRounding;
  /** How long a customer waits for a machine another client has (0: until it is free, or "חזרה"). */
  queueTimeoutSec: number;
  /** The jar's detailed call's own cancel time; the WebSocket's payment has no such parameter (kept, unused). */
  autoCancelSec: number;
  /** The longest a call other than a payment may take (connect, user, start). */
  callTimeoutSec: number;
  /** Where each setting came from (the staff screen shows it). */
  sources: Record<'host' | 'port' | 'terminal' | 'userCode', CashMagSource>;
}

export type CashMagField = 'host' | 'port' | 'userCode' | 'currency';

const USER_CODE = /^[0-9]{1,12}$/;
const CURRENCY = /^[A-Z]{3}$/;
const HOST = /^[A-Za-z0-9._:\-[\]]{1,253}$/;

const on = (v: unknown): boolean => {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on', 'כן'].includes(v.trim().toLowerCase());
  return false;
};

const text = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};

const whole = (v: unknown, d: number, min: number, max: number): number => {
  const t = text(v);
  const n = t === null ? NaN : Number(t);
  if (!Number.isFinite(n)) return d;
  const i = Math.trunc(n);
  return i >= min && i <= max ? i : d;
};

/**
 * CashMag at this kiosk: the till parameters as the cloud resolved them (company → shop → point of sale →
 * machine) and the kiosk's own [local] address / name / user code. Absent or malformed values keep the defaults
 * — off. [kioskName]: the terminal's name when nothing names it.
 */
export function cashmagConfigOf(params: Record<string, unknown> | null | undefined, local: CashMagLocal | null | undefined, kioskName?: string | null): CashMagConfig {
  const p = params ?? {};
  const l = local ?? {};
  const K = CASHMAG_PARAMS;
  const pick = (localValue: unknown, cloudValue: unknown): { v: string | null; source: CashMagSource } => {
    const lv = text(localValue);
    if (lv !== null) return { v: lv, source: 'local' };
    const cv = text(cloudValue);
    return cv !== null ? { v: cv, source: 'cloud' } : { v: null, source: 'default' };
  };
  const protocol: CashMagProtocol = text(p[K.protocol])?.toLowerCase() === 'rlp' ? 'rlp' : 'jar';
  const host = pick(l.host, p[K.host]);
  const port = pick(l.port, p[K.port]);
  const terminal = pick(l.terminal, p[K.terminal]);
  const userCode = pick(l.userCode, p[K.userCode]);
  const rounding = text(p[K.rounding])?.toLowerCase() === 'none' ? 'none' : 'nearest_10';
  return {
    enabled: on(p[K.enabled]),
    protocol,
    host: (host.v ?? '').slice(0, 253),
    // RLP has a documented port; the API server's port is the shop's own (no default).
    port: whole(port.v, protocol === 'rlp' ? RLP_DEFAULT_PORT : 0, 1, 65535),
    terminal: (terminal.v ?? (kioskName?.trim() || DEFAULT_TERMINAL)).replace(/[\r\n\t\0]/g, ' ').slice(0, 40),
    userCode: userCode.v ?? '',
    currency: (text(p[K.currency]) ?? DEFAULT_CURRENCY).toUpperCase(),
    rounding,
    queueTimeoutSec: whole(p[K.queueTimeoutSec], 0, 0, 1800),
    autoCancelSec: whole(p[K.autoCancelSec], 0, 0, 1800),
    callTimeoutSec: whole(p[K.callTimeoutSec], DEFAULT_CALL_TIMEOUT_SEC, 5, 120),
    sources: { host: host.source, port: port.source, terminal: terminal.source, userCode: userCode.source },
  };
}

/** What [c] still lacks before the kiosk can reach the server. */
export function cashmagMissing(c: CashMagConfig): CashMagField[] {
  const out: CashMagField[] = [];
  if (!HOST.test(c.host)) out.push('host');
  if (!(c.port >= 1 && c.port <= 65535)) out.push('port');
  // The user code may be left empty (the server's default user); when set, digits only.
  if (c.userCode !== '' && !USER_CODE.test(c.userCode)) out.push('userCode');
  if (!CURRENCY.test(c.currency)) out.push('currency');
  return out;
}

/** On, and everything a connection needs is there. */
export function cashmagUsable(c: CashMagConfig): boolean {
  return c.enabled && cashmagMissing(c).length === 0;
}

/** The config as a log line may show it: never the user code. */
export function cashmagConfigText(c: CashMagConfig): string {
  return `cashmag enabled=${c.enabled} protocol=${c.protocol} ${c.host}:${c.port} terminal=${c.terminal} currency=${c.currency} rounding=${c.rounding} user=${c.userCode ? 'set' : 'none'}`;
}

/* ------------------------------------------------------------------ the cash leg's ids */

export const CASHMAG_HOST_ID = 'cashmag';
const NOT_ID = /[^A-Za-z0-9_.:-]/g;

/** The cash leg's `stationId`: the device by its server (the cloud keeps ids of `[A-Za-z0-9_.:-]{1,64}`). */
export function cashmagStationId(host: string, port: number): string {
  return `cashmag:${(host.trim() || 'unset').replace(NOT_ID, '-')}:${port}`.slice(0, 64);
}

/* ------------------------------------------------------------------ amounts */

/** `cashmagRounding`: what the device collects — to ten agorot (1–4 down, 5–9 up), never rounded to nothing. */
export function cashmagPayable(mode: CashMagRounding, amountAgorot: number): number {
  if (mode === 'none') return amountAgorot;
  const r = amountAgorot % 10;
  const due = r === 0 ? amountAgorot : r <= 4 ? amountAgorot - r : amountAgorot + (10 - r);
  return due > 0 ? due : amountAgorot;
}

/**
 * A decimal as the server may send it — a number, or text with a point or a comma ("10,1"): the last of "." / ","
 * is the decimal point, the other a thousands separator. Half up to the agora; null when unreadable.
 */
export function cashmagAgorot(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? halfUpScaled(v, 2) : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/[\s\u00A0]/g, '');
  if (!t) return null;
  const point = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
  const whole = point < 0 ? t : t.slice(0, point).replace(/[.,]/g, '');
  const frac = point < 0 ? '' : t.slice(point + 1);
  const m = /^([+-]?)(\d*)$/.exec(whole);
  if (!m || !/^\d*$/.test(frac) || (m[2] === '' && frac === '')) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const digits = (frac + '000').slice(0, 3);
  let agorot = Number(m[2] || '0') * 100 + Number(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) agorot += 1;
  if (!Number.isSafeInteger(agorot)) return null;
  return agorot === 0 ? 0 : sign * agorot;
}

/** Shekels for the wire: a number with at most two decimals (never a float sum). */
export function cashmagShekels(agorot: number): number {
  return Number((agorot / 100).toFixed(2));
}

/* ------------------------------------------------------------------ the server's answer */

/** One denomination the device counted. */
export interface CashPiece {
  valueAgorot: number;
  count: number;
  kind: 'coin' | 'note' | 'other';
  currency: string | null;
  /** Entered by hand in the vendor's virtual device (VCR). */
  manual: boolean;
}

/** A payment's figures as the server gave them, in agorot. */
export interface CashRecyclerBalance {
  currency: string | null;
  /** What the device was asked (only the jar's detailed call names it). */
  transactionAgorot: number | null;
  roundedAgorot: number | null;
  cashInAgorot: number;
  cashOutAgorot: number;
  /** Positive: the customer still owes; negative: the merchant owes the customer (change not given). */
  customerBalanceAgorot: number | null;
  merchantBalanceAgorot: number | null;
  /** More change given than due (`over_dispensing`, the jar's detailed call only). */
  overDispensedAgorot: number | null;
  cashIn: CashPiece[];
  cashOut: CashPiece[];
}

export function balanceOf(b: Partial<CashRecyclerBalance>): CashRecyclerBalance {
  return {
    currency: b.currency ?? null,
    transactionAgorot: b.transactionAgorot ?? null,
    roundedAgorot: b.roundedAgorot ?? null,
    cashInAgorot: b.cashInAgorot ?? 0,
    cashOutAgorot: b.cashOutAgorot ?? 0,
    customerBalanceAgorot: b.customerBalanceAgorot ?? null,
    merchantBalanceAgorot: b.merchantBalanceAgorot ?? null,
    overDispensedAgorot: b.overDispensedAgorot ?? null,
    cashIn: b.cashIn ?? [],
    cashOut: b.cashOut ?? [],
  };
}

/** How one call to the server ended, as the driver read it — never a wire type. */
export interface CashRecyclerReply {
  valid: boolean;
  /** The vendor's error by name, or one of [CASHMAG_ERRORS]; null when valid. */
  error: string | null;
  message: string | null;
  /** False: refused before the call reached the device — nothing could have been paid or given. */
  reachedDevice: boolean;
  /** A payment's figures; null for other calls (or when the server gave none). */
  balance: CashRecyclerBalance | null;
  /** The call's own answer fields as text (diagnostics). */
  fields: Record<string, string>;
}

export function okReply(fields: Record<string, string> = {}): CashRecyclerReply {
  return { valid: true, error: null, message: null, reachedDevice: true, balance: null, fields };
}

/** Refused before anything reached the device. */
export function refusedReply(error: string, message: string | null = null): CashRecyclerReply {
  return { valid: false, error, message, reachedDevice: false, balance: null, fields: {} };
}

/** Our own error names beside the vendor's, and how each reads for money (pos-android `CashMagErrors`). */
export const CASHMAG_ERRORS = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NOT_CONNECTED: 'NOT_CONNECTED',
  NOT_STARTED: 'NOT_STARTED',
  CLAIMED_BY_ANOTHER: 'CLAIMED_BY_ANOTHER',
  BUSY: 'BUSY',
  UNRESOLVED: 'UNRESOLVED',
  AMOUNT: 'AMOUNT',
  TIMEOUT: 'TIMEOUT',
  EXCEPTION: 'EXCEPTION',
  RLP_NOT_AVAILABLE: 'RLP_NOT_AVAILABLE',
  WAIT_CANCELLED: 'WAIT_CANCELLED',
  /** The server refused the user code (`setUserName`). */
  USER_REFUSED: 'USER_REFUSED',
  NO_BALANCE: 'NO_BALANCE',
  CURRENCY: 'CURRENCY',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  HELD: 'HELD',
  /** The WebSocket answer's balance and its own lists disagree: its figures are not trusted (cashmagWire.ts). */
  INCONSISTENT: 'INCONSISTENT',
  /** The connection dropped while the payment was with the server: no telling what the device did. */
  DISCONNECTED: 'DISCONNECTED',
} as const;

const E = CASHMAG_ERRORS;

/** Refusals of the request itself: the device was not taking money for it (no figures: "not available"). */
export const BEFORE_MONEY: ReadonlySet<string> = new Set([
  'INVALID_SESSION', 'CMD_PARSE_ERROR', 'FUNCTION_NOT_IMPLEMENTED', 'TOO_MANY_CONNECTIONS', 'MAX_CONNECTION_REACHED',
  'SERVER_STOPPING', 'SESSION_ID_ALREADY_USED', 'MISSING_FUNCTION', 'UNSUPPORTED_PLATFORM', 'NOT_IMPLEMENTED_PLATFORM',
  'BAD_FUNCTION_FORMAT', 'UNSUPPORTED_API', 'UNSUPPORTED_SERVICE', 'DIALOG_ANDROID_EXCEPTION', 'INVALID_CONNECTION_SETTINGS',
  'INVALID_REQUEST', 'INVALID_JSON_GENERATION', 'DUPLICATE_EXEC_FUNCTION', 'OFFLINE_REQUEST', 'API_IS_BUSY',
  'HARDWARE_MISSING', 'INVALID_LICENSE', 'NOT_INSTALLED', 'NO_ACTIVITY', 'NOT_TRAINING',
  E.NOT_CONFIGURED, E.NOT_CONNECTED, E.NOT_STARTED, E.CLAIMED_BY_ANOTHER, E.BUSY, E.UNRESOLVED, E.AMOUNT,
  E.RLP_NOT_AVAILABLE, E.WAIT_CANCELLED, E.USER_REFUSED,
]);

/** "Pay transaction has been interrupted": called off at the device. */
export const CANCELLED_ERRORS: ReadonlySet<string> = new Set(['PAY_TRANSACTION_FAILED']);

/** The machine is another client's now (first come, first served): asked again after a while. */
export const WAIT_FOR: ReadonlySet<string> = new Set([E.CLAIMED_BY_ANOTHER, 'API_IS_BUSY']);

/** Every few seconds while the machine is another client's. */
export const WAIT_POLL_MS = 3_000;

/** The wait for a machine another client has: never a second charge — only a refusal with no money in is asked again. */
export function cashmagMayWait(reply: CashRecyclerReply): boolean {
  return !reply.valid && reply.error !== null && WAIT_FOR.has(reply.error) && (reply.balance?.cashInAgorot ?? 0) === 0;
}

/* ------------------------------------------------------------------ the outcome */

export interface CashMagPayRequest {
  txId: string;
  /** The document's (what is left to pay, the tip with it). */
  amountAgorot: number;
  /** What the device collects: [amountAgorot] after `cashmagRounding`. */
  dueAgorot: number;
  stationId: string;
  currency: string;
}

export type CashMagOutcome =
  /** The only one with a document: the cash leg's figures. */
  | { kind: 'paid'; receivedAgorot: number; changeAgorot: number; changeOwedAgorot: number; roundingAgorot: number; dueAgorot: number }
  /** Nothing kept: nothing went in, or all of it came back. */
  | { kind: 'cancelled'; refundedAgorot: number }
  /** Never reached the money (not configured, unreachable, busy after the wait, refused before money). */
  | { kind: 'unavailable'; reason: string | null }
  /** Money may be in the device without a sale, or the answer was lost: staff, no document. */
  | { kind: 'failed'; insertedAgorot: number; heldAgorot: number; reason: string; lost: boolean };

/**
 * The server's answer to a payment, read the way the money demands (P:/specs/cashmag.md §3.1 5, §12): a document only
 * on an answer that says plainly "paid" — valid, in this kiosk's currency, money in, the net (in less out) covering
 * the due, the customer owing nothing. Anything else is not a sale: given back, not started, or a fault the staff
 * look at. Change owed = the net less the due (the customer's balance below zero).
 */
export function cashmagOutcome(request: CashMagPayRequest, reply: CashRecyclerReply): CashMagOutcome {
  const b = reply.balance;
  if (!reply.valid) {
    const error = reply.error;
    if (!reply.reachedDevice) return error === E.WAIT_CANCELLED ? { kind: 'cancelled', refundedAgorot: 0 } : { kind: 'unavailable', reason: error };
    if (b && b.cashInAgorot > 0) {
      // Figures with the refusal: what went in, and what came back.
      const net = b.cashInAgorot - b.cashOutAgorot;
      return net <= 0 ? { kind: 'cancelled', refundedAgorot: b.cashOutAgorot } : { kind: 'failed', insertedAgorot: b.cashInAgorot, heldAgorot: net, reason: error ?? E.HELD, lost: false };
    }
    if (error !== null && BEFORE_MONEY.has(error)) return { kind: 'unavailable', reason: error };
    // The server's own figures say nothing went in; or it says the payment was called off there.
    if (b || (error !== null && CANCELLED_ERRORS.has(error))) return { kind: 'cancelled', refundedAgorot: 0 };
    // Aborted, disconnected, threw: no telling what the device did.
    return { kind: 'failed', insertedAgorot: 0, heldAgorot: 0, reason: error ?? E.EXCEPTION, lost: true };
  }
  if (!b) return { kind: 'failed', insertedAgorot: 0, heldAgorot: 0, reason: E.NO_BALANCE, lost: true };
  const net = b.cashInAgorot - b.cashOutAgorot;
  if (b.currency !== null && b.currency.trim().toUpperCase() !== request.currency.trim().toUpperCase()) {
    return { kind: 'failed', insertedAgorot: b.cashInAgorot, heldAgorot: Math.max(0, net), reason: E.CURRENCY, lost: false };
  }
  if (b.transactionAgorot !== null && b.transactionAgorot !== request.amountAgorot && b.transactionAgorot !== request.dueAgorot) {
    return { kind: 'failed', insertedAgorot: b.cashInAgorot, heldAgorot: Math.max(0, net), reason: E.AMOUNT_MISMATCH, lost: false };
  }
  if (b.cashInAgorot <= 0) return { kind: 'cancelled', refundedAgorot: 0 };
  const owes = b.customerBalanceAgorot;
  const over = b.overDispensedAgorot ?? 0;
  const paid =
    owes !== null && owes > 0
      ? false
      : net >= request.dueAgorot
        ? true
        : // More change given than due: paid, the gap is the device's (only when its own figures say so).
          owes !== null && net > 0 && over > 0 && net + over >= request.dueAgorot;
  if (!paid) {
    return net <= 0 ? { kind: 'cancelled', refundedAgorot: b.cashOutAgorot } : { kind: 'failed', insertedAgorot: b.cashInAgorot, heldAgorot: net, reason: E.HELD, lost: false };
  }
  return {
    kind: 'paid',
    receivedAgorot: b.cashInAgorot,
    changeAgorot: b.cashOutAgorot,
    changeOwedAgorot: Math.max(0, net - request.dueAgorot),
    roundingAgorot: request.dueAgorot - request.amountAgorot,
    dueAgorot: request.dueAgorot,
  };
}

/* ------------------------------------------------------------------ words */

/** The busy screen, exactly as the owner set it (P:/specs/cashmag.md §0 9, the kiosk's wording). */
export const CASHMAG_BUSY_TEXT = 'עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום';
export const CASHMAG_INSERT_TEXT = 'הכנס מזומן';

/** What the customer (and the staff screen) is told when CashMag cannot take this payment. */
export function cashmagUnavailableText(reason: string | null): string {
  switch (reason) {
    case E.NOT_CONFIGURED:
      return 'מכשיר המזומן לא מוגדר לקיוסק';
    case E.RLP_NOT_AVAILABLE:
      return 'פרוטוקול CashMag שנבחר עוד לא נתמך';
    case E.NOT_CONNECTED:
    case 'OFFLINE_REQUEST':
    case 'INVALID_CONNECTION_SETTINGS':
    case 'TOO_MANY_CONNECTIONS':
    case 'MAX_CONNECTION_REACHED':
    case 'SERVER_STOPPING':
    case E.TIMEOUT:
      return 'אין חיבור לשרת CashMag';
    case E.NOT_STARTED:
    case 'HARDWARE_MISSING':
      return 'מכשיר המזומן לא הופעל';
    case E.CLAIMED_BY_ANOTHER:
    case 'API_IS_BUSY':
    case E.BUSY:
      return 'עמדת המזומן בשימוש כרגע על ידי לקוח אחר — נסו שוב';
    case E.UNRESOLVED:
      return 'תשלום קודם במכשיר המזומן ממתין לבירור. אנא פנו לצוות.';
    case 'INVALID_LICENSE':
      return 'רישיון CashMag לא תקף';
    case E.USER_REFUSED:
      return 'שרת CashMag לא קיבל את קוד המשתמש';
    case 'INVALID_SESSION':
    case 'FUNCTION_NOT_IMPLEMENTED':
      return 'שרת CashMag לא קיבל את הבקשה';
    default:
      return 'מכשיר המזומן לא זמין';
  }
}
