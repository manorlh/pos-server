/**
 * The Nayax network pinpad's TweezerComm frames (JSON-RPC over HTTP POST to
 * http(s)://host:8080/SPICy), as the Android till builds and reads them
 * (pos-android hardware/payment/TweezerRequests.kt, TweezerOutcome.kt, CardRecovery.kt).
 *
 *  - The envelope: {"jsonrpc":"2.0","method":…,"params":["ashrait",{…}],"id":"1"} — the id is
 *    always the string "1"; key order as on the till.
 *  - Amounts in agorot (JSON numbers); currency the string "376".
 *  - No retries anywhere: re-sending a doTransaction answers 995 although the first charged.
 *
 * Pure: frames out, classifications in. The HTTP transport is main/payment/pinpad.ts.
 */

export const DEFAULT_PORT = 8080;
export const DEFAULT_PATH = '/SPICy';

/** Timeouts per call (ms), as on the till. */
export const TIMEOUTS = {
  connect: 5_000,
  sale: 180_000,
  abort: 5_000,
  lookup: 15_000,
  internalStatus: 5_000,
  status: 6_000,
  periodic: 150_000,
  report: 20_000,
  /** After an abort, how long the sale's own reply is still awaited. */
  cancelGrace: 60_000,
} as const;

export function frame(method: string, params: Record<string, unknown> | null, service = 'ashrait'): string {
  const p: unknown[] = [service];
  if (params !== null) p.push(params);
  return JSON.stringify({ jsonrpc: '2.0', method, params: p, id: '1' });
}

/** A sale of [amountAgorot] (the card leg, tip included) under [vuid]; 1 payment unless more. */
export function saleFrame(amountAgorot: number, vuid: string, payments = 1): string {
  const body: Record<string, unknown> = {
    amount: Math.round(amountAgorot),
    vuid,
    currency: '376',
    creditTerms: payments > 1 ? 8 : 1,
    tranCode: 1,
    tranType: 1,
    cardNumber: '',
    expDate: '',
    cvv: '',
  };
  if (payments > 1) body.creditPayments = payments;
  return frame('doTransaction', body);
}

export const abortFrame = (vuid: string) => frame('abortTransaction', { vuid });
export const lookupFrame = (vuid: string) => frame('getTransactionByVuid', { vuid });
export const statusFrame = () => frame('getStatus', {});
export const internalStatusFrame = () => frame('getInternalStatus', null);
export const reportFrame = (type: 'x' | 'queryReports' = 'x') => frame('getReport', { type });
export function periodicFrame(forceUpdateParams = false): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'doPeriodic', params: ['ashrait', 'wide', { forceUpdateParams }], id: '1' });
}

/* ------------------------------------------------------------------ vuid */

/** Java's String.hashCode (int32 overflow over UTF-16 code units). */
export function javaStringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** The till's vuid: 3 digits of the machine, then a 10-digit counter ("%03d%010d"). */
export function vuidOf(machineId: string | null, seq: number): string {
  const prefix = Math.abs(javaStringHash(machineId ?? 'unpaired')) % 1000;
  return `${String(prefix).padStart(3, '0')}${String(seq).padStart(10, '0')}`;
}

/* --------------------------------------------------------------- replies */

export type SaleOutcome =
  | 'APPROVED'
  | 'PARTIAL'
  | 'CANCELLED'
  | 'TERMINAL_BUSY'
  | 'DUPLICATE_VUID'
  | 'TIMEOUT'
  | 'UNKNOWN'
  | 'DECLINED'
  | 'TRANSPORT_ERROR';

/** Whether the card was charged, as far as one reply tells. */
export type CardAnswer = 'APPROVED' | 'DECLINED' | 'UNKNOWN';

export interface ParsedReply {
  /** The reply was JSON with a `result` object. */
  ok: boolean;
  /** statusCode as a strict integer; null when missing or not a number (never "0" by leniency). */
  statusCode: number | null;
  statusMessage: string | null;
  result: Record<string, unknown> | null;
  /** The raw `result` text of big ids kept losslessly. */
  rawUid: string | null;
  rawTransactionId: string | null;
  error: unknown;
}

/** Strict integer parse: a number, or a string of digits (with a sign); anything else null. */
export function strictInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Big numeric ids lose precision through JSON.parse: read them from the raw text. */
function rawField(body: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*("?)(-?[0-9A-Za-z_\\-]+)\\1`).exec(body);
  return m ? m[2] : null;
}

export function parseReply(body: string): ParsedReply {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, statusCode: null, statusMessage: null, result: null, rawUid: null, rawTransactionId: null, error: 'not_json' };
  }
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (o.error !== undefined && o.error !== null) {
    return { ok: false, statusCode: null, statusMessage: null, result: null, rawUid: null, rawTransactionId: null, error: o.error };
  }
  const result = o.result && typeof o.result === 'object' && !Array.isArray(o.result) ? (o.result as Record<string, unknown>) : null;
  return {
    ok: result !== null,
    statusCode: result ? strictInt(result.statusCode) : null,
    statusMessage: result && typeof result.statusMessage === 'string' ? result.statusMessage : null,
    result,
    rawUid: result ? rawField(body, 'uid') : null,
    rawTransactionId: result ? rawField(body, 'transactionId') : null,
    error: null,
  };
}

/** The sale reply's outcome (TweezerOutcome.kt). */
export function saleOutcome(reply: ParsedReply): SaleOutcome {
  if (!reply.ok) return reply.error === null ? 'UNKNOWN' : 'TRANSPORT_ERROR';
  const c = reply.statusCode;
  if (c === null) return 'UNKNOWN';
  if (c === 0) return 'APPROVED';
  if (c === 10) return 'PARTIAL';
  if (c === 126 || c === 998) return 'CANCELLED';
  if (c === -1 || c === -5) return 'TERMINAL_BUSY';
  if (c === 995) return 'DUPLICATE_VUID';
  if (c === 993) return 'TIMEOUT';
  if (c === 162) return 'UNKNOWN';
  return 'DECLINED';
}

/** cardAnswerOf: approved, certainly not charged, or nobody knows. */
export function cardAnswerOf(outcome: SaleOutcome): CardAnswer {
  switch (outcome) {
    case 'APPROVED':
    case 'PARTIAL':
      return 'APPROVED';
    case 'CANCELLED':
    case 'TERMINAL_BUSY':
    case 'DUPLICATE_VUID':
    case 'DECLINED':
      return 'DECLINED';
    default:
      return 'UNKNOWN';
  }
}

/** What a sale reply tells about the card, from its parsed fields (parseCardResponse). */
export interface CardResponse {
  statusCode: number | null;
  statusMessage: string | null;
  uid: string | null;
  authNum: string | null;
  cardNumber: string | null;
  last4: string | null;
  amountAgorot: number | null;
  creditPayments: number | null;
  firstPaymentAmount: number | null;
  brand: CardBrand;
}

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'diners' | 'isracard' | 'jcb' | 'discover' | 'maestro' | 'other';

export const BRAND_LABEL_HE: Record<CardBrand, string> = {
  visa: 'ויזה',
  mastercard: 'מאסטרקארד',
  amex: 'אמריקן אקספרס',
  diners: 'דיינרס',
  isracard: 'ישראכרט',
  jcb: 'JCB',
  discover: 'דיסקבר',
  maestro: 'מאסטרו',
  other: '',
};

/** The brand from the reply's text fields (CardBrands.fromResult, by name). */
export function brandOf(result: Record<string, unknown> | null): CardBrand {
  if (!result) return 'other';
  const text = ['mutagName', 'cardName', 'mutag', 'manpik', 'solek']
    .map((k) => (result[k] === undefined || result[k] === null ? '' : String(result[k])))
    .join(' ')
    .toLowerCase();
  if (/visa|ויזה/.test(text)) return 'visa';
  if (/maestro|מאסטרו/.test(text)) return 'maestro';
  if (/master|מאסטר/.test(text)) return 'mastercard';
  if (/amex|american|אמריקן/.test(text)) return 'amex';
  if (/diners|דיינרס/.test(text)) return 'diners';
  if (/isracard|ישראכרט/.test(text)) return 'isracard';
  if (/jcb/.test(text)) return 'jcb';
  if (/discover|דיסקבר/.test(text)) return 'discover';
  return 'other';
}

export function parseCardResponse(reply: ParsedReply): CardResponse {
  const r = reply.result ?? {};
  const cardNumber = typeof r.cardNumber === 'string' ? r.cardNumber : null;
  let last4: string | null = null;
  if (cardNumber) {
    const tail = cardNumber.slice(cardNumber.lastIndexOf('*') + 1);
    last4 = tail.length === 4 ? tail : null;
  }
  const payments = strictInt(r.creditPayments);
  const first = strictInt(r.firstPaymentAmount);
  return {
    statusCode: reply.statusCode,
    statusMessage: reply.statusMessage,
    uid: reply.rawUid ?? (r.uid === undefined || r.uid === null ? null : String(r.uid)),
    authNum: r.issuerAuthNum === undefined || r.issuerAuthNum === null ? null : String(r.issuerAuthNum),
    cardNumber,
    last4,
    amountAgorot: strictInt(r.amount),
    creditPayments: payments !== null && payments > 1 ? payments : null,
    firstPaymentAmount: first !== null && first > 0 ? first : null,
    brand: brandOf(reply.result),
  };
}

/* --------------------------------------------------------------- lookup */

export type LookupVerdict =
  | { kind: 'approved'; reply: ParsedReply }
  | { kind: 'declined'; reply: ParsedReply }
  | { kind: 'not_found' }
  | { kind: 'unknown'; message: string };

/** Codes that describe the request, not the transaction: a lookup with one of them proves nothing. */
const REQUEST_CODES = new Set([-51, -64, 4000, 5003, -1, -5, 993, 995, 162]);

/**
 * A getTransactionByVuid reply (CardRecovery.readLookupReply), in this order: unreadable →
 * unknown; `found:false` or -61 → not found; another vuid → unknown; approved in the amount sent
 * (or more with a terminal tip) → approved, in another amount → unknown; a request code →
 * unknown; declined/cancelled → declined; anything else → unknown.
 */
export function readLookupReply(body: string, vuid: string, expectedAgorot: number, terminalTip = false): LookupVerdict {
  const reply = parseReply(body);
  if (!reply.ok || !reply.result) return { kind: 'unknown', message: 'תשובת בירור לא קריאה' };
  if (reply.result.found === false) return { kind: 'not_found' };
  const code = reply.statusCode;
  if (code === null) return { kind: 'unknown', message: 'תשובת בירור בלי statusCode' };
  if (code === -61) return { kind: 'not_found' };
  const echoed = reply.result.vuid;
  if (echoed !== undefined && echoed !== null && String(echoed) !== vuid) {
    return { kind: 'unknown', message: `תשובה על עסקה אחרת (${String(echoed)})` };
  }
  if (code === 0 || code === 10) {
    const amount = strictInt(reply.result.amount);
    if (amount === null || amount === expectedAgorot || (terminalTip && amount > expectedAgorot)) return { kind: 'approved', reply };
    return { kind: 'unknown', message: `נמצאה עסקה מאושרת בסכום ${(amount / 100).toFixed(2)} במקום ${(expectedAgorot / 100).toFixed(2)}` };
  }
  if (REQUEST_CODES.has(code)) return { kind: 'unknown', message: `המסוף ענה ${code} על הבירור` };
  const answer = cardAnswerOf(saleOutcome(reply));
  if (answer === 'DECLINED') return { kind: 'declined', reply };
  return { kind: 'unknown', message: `קוד ${code}` };
}

/** getInternalStatus says the terminal is in the middle of something (Periodic.internalStatusBusy). */
export function internalStatusBusy(body: string | null): boolean {
  if (!body) return false;
  const reply = parseReply(body);
  const r = reply.result;
  if (!r) return false;
  if (r.busy === true || r.inTransaction === true) return true;
  for (const key of ['status', 'state', 'internalStatus']) {
    const v = r[key];
    if (typeof v === 'string' && /busy|transaction|processing|in_progress|inprogress/i.test(v)) return true;
  }
  return false;
}

/* -------------------------------------------------------------- address */

export interface PinpadAddress {
  host: string;
  port: number;
  path: string;
  tls: boolean;
}

/**
 * The pinpad's address from the cloud settings (`nayaxDeviceHost`, `nayaxDevicePort`,
 * `nayaxSpicyPath`), as pinpadAddressOf: a scheme (http:// = no TLS), an inline port and path
 * taken when the separate fields are empty, then 8080 and /SPICy. Null without a host.
 */
export function pinpadAddressOf(hostRaw: string | null | undefined, portRaw?: string | null, pathRaw?: string | null): PinpadAddress | null {
  let host = (hostRaw ?? '').trim();
  if (!host) return null;
  let tls = true;
  const scheme = /^(https?):\/\//i.exec(host);
  if (scheme) {
    tls = scheme[1].toLowerCase() === 'https';
    host = host.slice(scheme[0].length);
  }
  let inlinePath: string | null = null;
  const slash = host.indexOf('/');
  if (slash >= 0) {
    inlinePath = host.slice(slash);
    host = host.slice(0, slash);
  }
  let inlinePort: number | null = null;
  const colon = host.lastIndexOf(':');
  if (colon > 0) {
    const p = Number(host.slice(colon + 1));
    if (Number.isInteger(p) && p > 0 && p < 65536) inlinePort = p;
    host = host.slice(0, colon);
  }
  host = host.trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  if (/^\d+(\.\d+){3}$/.test(host) && !host.split('.').every((o) => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)) return null;
  const port = Number((portRaw ?? '').trim()) || inlinePort || DEFAULT_PORT;
  let path = (pathRaw ?? '').trim() || inlinePath || DEFAULT_PATH;
  if (!path.startsWith('/')) path = `/${path}`;
  return { host, port, path, tls };
}

export function pinpadUrl(a: PinpadAddress): string {
  return `${a.tls ? 'https' : 'http'}://${a.host}:${a.port}${a.path}`;
}

/** RFC 1918 IPv4 literal: the only hosts plain HTTP may be used with (and only with pinpadAllowHttp). */
export function privateIpv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
