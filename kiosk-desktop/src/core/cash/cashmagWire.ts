/**
 * The CashMag server's WebSocket JSON-RPC — the CMCMonetic API as the vendor's JavaScript connector sample ("API
 * BEECOMM", from a Linux setup) speaks it (P:/vendor/cashmag/windows-js-protocol-notes.md; our own reading, none of the
 * sample's code; its Windows package of 2024-02-13 is the same protocol, a newer revision — the claim signal, the
 * transfer to the cash box, `isDispensePossible`'s new parameters). The protocol is the server's, whatever OS the
 * CashMag box runs; the client may be any OS. Pure: the
 * envelope, the function table (the ONE place their names live — the names carry version hashes), the statuses,
 * the signals, and a payment's answer read into the contract's [CashRecyclerReply] (core/cash/cashmag.ts).
 *
 *   client → server  {"cm_ws_rpc_call":   {"session_id", "function", "job_id", "params"?}}
 *   server → client  {"cm_ws_rpc_result": {"job_id", "function", "status": {"ii_status", "ilst_warnings", "is_message"}, "result"}}
 *                    {"cm_ws_rpc_call":   {...}}  a handshake step, or a signal ("<x>.<y>.signalDeposits")
 *
 * Handshake: HELLO → WHOAREYOU, IAM → WELCOME (its `session_id`, reused on every call and on reconnects); ERROR with
 * the invalid-session status: the session is dropped and the handshake starts again. The machine another client's:
 * the claim signal (`signalClaimStateChanged`: FREE / IN_USE_BY_MYSELF / IN_USE_BY_ANOTHER), or a server that closes
 * the socket with the reason "Service occupé !" — never reconnected to in a loop.
 */

import { balanceOf, cashmagAgorot, CASHMAG_ERRORS, type CashPiece, type CashRecyclerReply } from './cashmag';

export const RPC_CALL = 'cm_ws_rpc_call';
export const RPC_RESULT = 'cm_ws_rpc_result';

export const HANDSHAKE = {
  HELLO: 'HELLO',
  WHOAREYOU: 'WHOAREYOU',
  IAM: 'IAM',
  WELCOME: 'WELCOME',
  ERROR: 'ERROR',
  GOODBYE: 'GOODBYE',
} as const;
export type HandshakeStep = (typeof HANDSHAKE)[keyof typeof HANDSHAKE];
const STEPS: ReadonlySet<string> = new Set(Object.values(HANDSHAKE));

/** `ii_status`: 0 success (a warning when `ilst_warnings` is not empty), above 0 an error, below 0 a fatal one. */
export const STATUS_OK = 0;
export const STATUS_INVALID_SESSION = -100000001;
export const STATUS_FUNCTION_NOT_SUPPORTED = -100000004;

/** The vendor's statuses we know by number (the rest are named `CM_STATUS_<n>` — the vendor's list is asked for). */
export const STATUS_NAMES: Readonly<Record<number, string>> = {
  [STATUS_INVALID_SESSION]: 'INVALID_SESSION',
  [STATUS_FUNCTION_NOT_SUPPORTED]: 'FUNCTION_NOT_IMPLEMENTED',
};

export function statusName(code: number): string {
  return STATUS_NAMES[code] ?? `CM_STATUS_${code}`;
}

/** The close reason of a server that is another client's now ("Service occupé !"). */
export const BUSY_CLOSE_REASON = 'Service occupé !';

/** The busy close, whatever the spacing, case or accent's normal form. */
export function isBusyClose(reason: unknown): boolean {
  if (typeof reason !== 'string') return false;
  const r = reason.normalize('NFC').trim().toLowerCase();
  return r === BUSY_CLOSE_REASON.normalize('NFC').toLowerCase() || r.startsWith('service occup');
}

/**
 * The functions by our name → the server's, version hash and all (the sample's of 2024-02). One table: a server
 * with other hashes is configured here, or per kiosk (kiosk.json `cashmag.functions`), never in the code that calls.
 * `setTerminal` comes from the vendor's ActiveX docs (not in the WebSocket sample): called best effort.
 */
export const CASHMAG_FUNCTIONS = {
  setUserName: 'API.setUserName_a934b56a',
  setTerminal: 'API.setTerminal_c5314924',
  terminalFullName: 'API.terminalFullName_f0edf2fc',
  start: 'API.crCashRecycler.start',
  stop: 'API.crCashRecycler.stop',
  pay: 'API.crCashRecycler.payTransaction_7f2a80d0',
  dialogValid: 'API.crCashRecycler.dialogValid',
  dialogCancel: 'API.crCashRecycler.dialogCancel',
  isDispensePossible: 'API.crCashRecycler.isDispensePossible_6ae57301',
  dialogChangeDeviceSelect: 'API.crCashRecycler.dialogChangeDeviceSelect_be3f943a',
  refill: 'API.crCashRecycler.refill_e1117f7c',
  pickup: 'API.crCashRecycler.pickup_c63e3ddd',
  /** The recyclers' money to the cash box (`alst_amounts_transfered`) — the staff's, a later stage. */
  transferToCassette: 'API.crCashRecycler.transferFromRecyclerToCassette_d4697ee5',
} as const;
export type CashMagFunction = keyof typeof CASHMAG_FUNCTIONS;
export type CashMagFunctions = Record<CashMagFunction, string>;

/** The server's signals by the third dot-segment of their function ("API.crCashRecycler.signalDeposits"). */
export const CASHMAG_SIGNALS = {
  deposits: 'signalDeposits',
  question: 'signalQuestionNotification',
  deviceChange: 'signalChangeDeviceNotification',
  /** Who has the machine (the shared CashRecycler Server): drives the busy screen and the payment's going on. */
  claim: 'signalClaimStateChanged',
} as const;

/** The vendor's ClaimState: UNKNOWN 0, FREE 1, IN_USE_BY_MYSELF 2, IN_USE_BY_ANOTHER 3. */
export type CashMagClaim = 'unknown' | 'free' | 'mine' | 'other';
const CLAIM_BY_NUMBER: Readonly<Record<number, CashMagClaim>> = { 0: 'unknown', 1: 'free', 2: 'mine', 3: 'other' };
const CLAIM_BY_NAME: Readonly<Record<string, CashMagClaim>> = { UNKNOWN: 'unknown', FREE: 'free', IN_USE_BY_MYSELF: 'mine', IN_USE_BY_ANOTHER: 'other' };

function claimValue(v: unknown): CashMagClaim | null {
  if (typeof v === 'number' && Number.isInteger(v)) return CLAIM_BY_NUMBER[v] ?? null;
  if (typeof v === 'string') {
    const t = v.trim().replace(/^"|"$/g, '').toUpperCase();
    if (/^\d$/.test(t)) return CLAIM_BY_NUMBER[Number(t)] ?? null;
    return CLAIM_BY_NAME[t] ?? null;
  }
  return null;
}

/**
 * The claim state a `signalClaimStateChanged` carries. The parameter's own name is not in the sample (it hands
 * `params` on as is): a key naming the claim first, then a `state`, then a lone value; anything unreadable is
 * `unknown` (never "free" by a guess).
 */
export function claimOf(params: Record<string, unknown>): CashMagClaim {
  const entries = Object.entries(params);
  const named = entries.filter(([k]) => /claim/i.test(k));
  for (const [, v] of named) {
    const c = claimValue(v);
    if (c) return c;
  }
  for (const [k, v] of entries) {
    if (/state/i.test(k)) {
      const c = claimValue(v);
      if (c) return c;
    }
  }
  if (entries.length === 1) return claimValue(entries[0][1]) ?? 'unknown';
  return 'unknown';
}

/** `isDispensePossible`'s parameters as the 2024-02-13 connector sends them (no `ab_enable_change` any more). */
export function dispensePossibleParams(amountAgorot: number, currency: string): Record<string, unknown> {
  return { ahash_amounts_to_dispense: [{ idc_amount: Number((amountAgorot / 100).toFixed(2)), is_currency: currency }] };
}

const FUNCTION_NAME = /^[A-Za-z0-9_.]{1,120}$/;

/** The table with a kiosk's own names over it (kiosk.json `cashmag.functions`); a malformed name is ignored. */
export function cashmagFunctionsOf(overrides: unknown): CashMagFunctions {
  const out: CashMagFunctions = { ...CASHMAG_FUNCTIONS };
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return out;
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (k in out && typeof v === 'string' && FUNCTION_NAME.test(v.trim())) out[k as CashMagFunction] = v.trim();
  }
  return out;
}

/* ------------------------------------------------------------------ the envelope */

export interface RpcCall {
  session_id: string;
  function: string;
  job_id: string;
  params?: Record<string, unknown>;
}

export function encodeCall(c: { sessionId: string | null; fn: string; jobId: string; params?: Record<string, unknown> | null }): string {
  const call: RpcCall = { session_id: c.sessionId ?? '', function: c.fn, job_id: c.jobId };
  if (c.params) call.params = c.params;
  return JSON.stringify({ [RPC_CALL]: call });
}

export interface RpcStatus {
  code: number;
  warnings: unknown[];
  message: string | null;
}

/** What the server sent, read leniently. */
export type Incoming =
  | { kind: 'result'; jobId: string | null; fn: string | null; status: RpcStatus; result: Record<string, unknown> | null; raw: Record<string, unknown> }
  | { kind: 'step'; step: HandshakeStep; sessionId: string | null; status: RpcStatus | null; raw: Record<string, unknown> }
  | { kind: 'signal'; name: string; fn: string; params: Record<string, unknown>; raw: Record<string, unknown> }
  | { kind: 'invalid'; why: string };

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** A status object (`{ii_status, ilst_warnings, is_message}`); a missing one reads as a fatal unknown. */
export function statusOf(v: unknown): RpcStatus {
  const s = rec(v);
  const raw = s?.ii_status;
  const code = typeof raw === 'number' && Number.isInteger(raw) ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  return {
    code: Number.isNaN(code) ? -1 : code,
    warnings: Array.isArray(s?.ilst_warnings) ? (s!.ilst_warnings as unknown[]) : [],
    message: typeof s?.is_message === 'string' && s.is_message.trim() ? s.is_message.trim() : null,
  };
}

/** The signal's name: the third dot-segment of its function (the last one, when it has fewer). */
export function signalNameOf(fn: string): string {
  const parts = fn.split('.');
  return parts.length >= 3 ? parts[2] : parts[parts.length - 1];
}

export function decodeMessage(text: string): Incoming {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid', why: 'not json' };
  }
  const top = rec(parsed);
  if (!top) return { kind: 'invalid', why: 'not an object' };
  const result = rec(top[RPC_RESULT]);
  const call = rec(top[RPC_CALL]);
  const body = result ?? call;
  if (!body) return { kind: 'invalid', why: 'no envelope' };
  const fn = str(body.function);
  // A handshake step may come either way (as a call or as a result).
  if (fn && STEPS.has(fn)) {
    const params = rec(body.params);
    const status = params?.status !== undefined ? statusOf(params.status) : body.status !== undefined ? statusOf(body.status) : null;
    return { kind: 'step', step: fn as HandshakeStep, sessionId: str(body.session_id), status, raw: body };
  }
  if (result) return { kind: 'result', jobId: str(body.job_id), fn, status: statusOf(body.status), result: rec(body.result), raw: body };
  if (!fn) return { kind: 'invalid', why: 'call without function' };
  return { kind: 'signal', name: signalNameOf(fn), fn, params: rec(body.params) ?? {}, raw: body };
}

/* ------------------------------------------------------------------ amounts on the wire */

/** `ie_fund_type`: 2 coin, 3 note — as a number, a numeric string or the enum's name. */
function kindOf(v: unknown): CashPiece['kind'] {
  const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().replace(/^"|"$/g, '').toUpperCase() : '';
  if (t === '2' || t === 'CASH_COIN' || t === 'COIN') return 'coin';
  if (t === '3' || t === 'CASH_NOTE' || t === 'NOTE') return 'note';
  return 'other';
}

/** An amounts list (`alst_transaction_deposits`, a signal's `deposits`): its pieces; null when it is no list. */
export function piecesOf(v: unknown): CashPiece[] | null {
  if (!Array.isArray(v)) return null;
  const out: CashPiece[] = [];
  for (const item of v) {
    const o = rec(item);
    if (!o) continue;
    const value = cashmagAgorot(o.idc_value);
    const qty = typeof o.ii_qty === 'number' ? o.ii_qty : typeof o.ii_qty === 'string' && /^-?\d+$/.test(o.ii_qty.trim()) ? Number(o.ii_qty.trim()) : NaN;
    if (value === null || !Number.isInteger(qty) || qty <= 0 || value <= 0) continue;
    const currency = typeof o.is_currency === 'string' ? o.is_currency.trim().replace(/^"|"$/g, '') || null : null;
    out.push({ valueAgorot: value, count: qty, kind: kindOf(o.ie_fund_type), currency, manual: o.ib_manual === true || o.ib_manual === 'true' });
  }
  return out;
}

export function totalOf(pieces: readonly CashPiece[]): number {
  return pieces.reduce((s, p) => s + p.valueAgorot * p.count, 0);
}

/**
 * A balance and the lists may disagree by the rounding's residue at most (−4…+5 agorot): beyond it the answer's
 * figures are not trusted for money.
 */
const BALANCE_TOLERANCE = 5;

/**
 * The payment's answer (`payTransaction`) read into the contract's reply. The figures are the lists — what went in
 * (`alst_transaction_deposits`) and what came out (`alst_transaction_dispensed`) — and the customer's balance
 * (`adc_transaction_amount_balance`: above 0 still to pay, below 0 change still owed to the customer). With no
 * deposits list there are no figures (never "nothing went in" by default); a balance that contradicts the lists
 * makes the figures untrusted (INCONSISTENT: a fault for the staff, never a document and never "given back").
 */
export function payReplyOf(r: { status: RpcStatus; result: Record<string, unknown> | null }, dueAgorot: number): CashRecyclerReply {
  const valid = r.status.code === STATUS_OK;
  const res = r.result;
  const deposits = piecesOf(res?.alst_transaction_deposits);
  const dispensed = piecesOf(res?.alst_transaction_dispensed) ?? [];
  const balanceAgorot = res ? cashmagAgorot(res.adc_transaction_amount_balance) : null;
  const currency = typeof res?.is_currency === 'string' && res.is_currency.trim() ? res.is_currency.trim() : null;
  const base = {
    valid,
    error: valid ? null : statusName(r.status.code),
    message: r.status.message,
    reachedDevice: true,
    fields: {
      status: String(r.status.code),
      ...(r.status.warnings.length > 0 ? { warnings: JSON.stringify(r.status.warnings).slice(0, 300) } : {}),
      ...(balanceAgorot !== null ? { balanceAgorot: String(balanceAgorot) } : {}),
    },
  };
  if (!deposits) return { ...base, balance: null };
  const cashIn = totalOf(deposits);
  const cashOut = totalOf(dispensed);
  if (balanceAgorot !== null && Math.abs(balanceAgorot - (dueAgorot - (cashIn - cashOut))) > BALANCE_TOLERANCE) {
    return { ...base, valid: false, error: CASHMAG_ERRORS.INCONSISTENT, balance: null, fields: { ...base.fields, inAgorot: String(cashIn), outAgorot: String(cashOut) } };
  }
  return {
    ...base,
    balance: balanceOf({ currency, cashInAgorot: cashIn, cashOutAgorot: cashOut, customerBalanceAgorot: balanceAgorot, cashIn: deposits, cashOut: dispensed }),
  };
}

/** A question from the server (`signalQuestionNotification`): its title and text. */
export function questionOf(params: Record<string, unknown>): { title: string; text: string } {
  const t = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
  return { title: t(params.title), text: t(params.text) };
}
