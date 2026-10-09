/**
 * SynqPay's JSON-RPC 2.0 API (https://docs.synqpay.com/api/), pure — the same requests, readings
 * and classification as the Android till (pos-android hardware/payment/synqpay/SynqPayProtocol.kt;
 * pos-server docs/SPEC_SYNQPAY.md §3):
 *
 *  - a transaction status that says charged (AUTHORIZED, CAPTURED, SETTLED, DEPOSITED) is
 *    believed whatever `result` says; DECLINED / VOIDED / INFORMATIVE took no money;
 *  - without a status, only a definite result is a decline (HOST_ERROR, card errors, CANCELED);
 *    TIMEOUT, NETWORK_ERROR, GENERAL_ERROR and no reply are UNKNOWN — asked for by the same
 *    referenceId, never charged again;
 *  - JSON-RPC errors refuse before anything happened, except 303 (the referenceId exists: ours may
 *    have charged), which is looked up.
 */

export const METHOD = {
  PAIR: 'pair',
  AUTHENTICATE: 'authenticate',
  GET_STATUS: 'getStatus',
  CANCEL: 'cancel',
  START_TRANSACTION: 'startTransaction',
  CONTINUE_TRANSACTION: 'continueTransaction',
  GET_TRANSACTION: 'getTransaction',
  GET_TERMINAL_STATUS: 'getTerminalStatus',
  GET_BATCH_FILE_STATUS: 'getBatchFileStatus',
  SETTLEMENT: 'settlement',
  GET_SETTLEMENT: 'getSettlement',
  QUERY_SETTLEMENTS: 'querySettlements',
  DEPOSIT: 'deposit',
  GET_DEVICE_INFO: 'getDeviceInfo',
  GET_CONFIG: 'getConfig',
  SET_CONFIG: 'setConfig',
  UPLOAD_LOGS: 'uploadLogs',
  REBOOT: 'reboot',
  RESTART: 'restart',
  READ_CARD: 'readCard',
  USER_INPUT: 'userInput',
  USER_SELECTION: 'userSelection',
  SHOW_QR: 'showQR',
  CAPTURE_SIGNATURE: 'captureSignature',
  TRANSACTION_EVENT: 'transactionEvent',
} as const;

/** The application's JSON-RPC error codes (https://docs.synqpay.com/api/errors/). */
export const ERR = {
  GENERAL_ERROR: 100,
  ILLEGAL_REQUEST: 101,
  MISSING_PARAM: 102,
  INVALID_PARAM: 103,
  ILLEGAL_STATE: 201,
  SCREEN_NOT_READY: 202,
  INSUFFICIENT_BATTERY: 203,
  PAYMENT_METHOD_DISABLED: 300,
  HOST_NOT_READY: 301,
  TRANSACTION_NOT_FOUND: 302,
  TRANSACTION_ALREADY_EXIST: 303,
  ILLEGAL_TRANSACTION_STATUS: 304,
  /** HostDisabled and SettlementNotFound: both 401 in the docs. */
  HOST_DISABLED: 401,
} as const;

export const CURRENCY_ILS = 376;
export const HOST_SHVA = 'SHVA';

const REFERENCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function rpc(method: string, params: Record<string, unknown> | null, id: string): string {
  return JSON.stringify({ jsonrpc: '2.0', method, id, params });
}

function ref(referenceId: string): string {
  if (!REFERENCE_ID.test(referenceId)) throw new RangeError('referenceId must be 1-64 of A-Z a-z 0-9 _ -');
  return referenceId;
}

function positiveInt(n: number, what: string): number {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`${what} must be a positive integer (agorot)`);
  return n;
}

/** This kiosk's referenceId for [vuid]: its machine id's first 12 letters/digits, then the vuid (as on the till). */
export function referenceIdOf(tillTag: string | null, vuid: string): string {
  const tag = (tillTag ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'till';
  return `${tag}-${vuid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64 - tag.length - 1)}`;
}

export function vuidOfReference(tillTag: string | null, referenceId: string | null | undefined): string | null {
  const tag = (tillTag ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'till';
  return referenceId && referenceId.startsWith(`${tag}-`) ? referenceId.slice(tag.length + 1) : null;
}

const tx = (type: string, referenceId: string) => ({ paymentMethod: 'CREDIT_CARD', transactionType: type, referenceId: ref(referenceId) });

export const requests = {
  pair: (serialNumber: string, id: string) => rpc(METHOD.PAIR, { serialNumber }, id),
  authenticate(otp: string, id: string) {
    if (!/^\d{6}$/.test(otp)) throw new RangeError('the OTP is the 6 digits on the terminal screen');
    return rpc(METHOD.AUTHENTICATE, { otp }, id);
  },
  getStatus: (id: string) => rpc(METHOD.GET_STATUS, null, id),
  cancel: (referenceId: string, id: string) => rpc(METHOD.CANCEL, { referenceId: ref(referenceId) }, id),
  /** A sale of [totalAgorot] (tip included): the tip as `tipAmount` beside `amount`; instalments as INSTALLMENTS. */
  sale(referenceId: string, totalAgorot: number, tipAgorot: number, payments: number, id: string, notifyEvents = false) {
    positiveInt(totalAgorot, 'amount');
    if (!Number.isInteger(payments) || payments < 1) throw new RangeError('payments must be at least 1');
    const tip = Number.isInteger(tipAgorot) && tipAgorot > 0 && tipAgorot < totalAgorot ? tipAgorot : 0;
    const p: Record<string, unknown> = { ...tx('SALE', referenceId), amount: totalAgorot - tip, currency: CURRENCY_ILS };
    if (tip > 0) p.tipAmount = tip;
    if (payments > 1) {
      p.creditTerms = 'INSTALLMENTS';
      p.noOtherInstallmentPayments = payments - 1;
    }
    if (notifyEvents) p.notifyEvents = true;
    return rpc(METHOD.START_TRANSACTION, p, id);
  },
  refund: (referenceId: string, amountAgorot: number, id: string) =>
    rpc(METHOD.START_TRANSACTION, { ...tx('REFUND', referenceId), amount: positiveInt(amountAgorot, 'amount'), currency: CURRENCY_ILS }, id),
  /** VOID of an AUTHORIZED / CAPTURED transaction not yet settled, by ITS referenceId. */
  void: (originalReferenceId: string, id: string) => rpc(METHOD.START_TRANSACTION, tx('VOID', originalReferenceId), id),
  authOnly: (referenceId: string, amountAgorot: number, id: string) =>
    rpc(METHOD.START_TRANSACTION, { ...tx('AUTH_ONLY', referenceId), amount: positiveInt(amountAgorot, 'amount'), currency: CURRENCY_ILS }, id),
  capture: (referenceId: string, amountAgorot: number, id: string) =>
    rpc(METHOD.START_TRANSACTION, { ...tx('CAPTURE', referenceId), amount: positiveInt(amountAgorot, 'amount'), currency: CURRENCY_ILS }, id),
  continueTransaction(id: string, opts: { referenceId?: string; newAmount?: number; authorizationNumber?: string } = {}) {
    const p: Record<string, unknown> = {};
    if (opts.referenceId) p.referenceId = ref(opts.referenceId);
    if (opts.newAmount !== undefined) p.newAmount = positiveInt(opts.newAmount, 'newAmount');
    if (opts.authorizationNumber !== undefined) {
      if (opts.authorizationNumber.length < 1 || opts.authorizationNumber.length > 7) throw new RangeError('authorizationNumber is 1-7 characters');
      p.authorizationNumber = opts.authorizationNumber;
    }
    return rpc(METHOD.CONTINUE_TRANSACTION, p, id);
  },
  transactionByReference: (referenceId: string, id: string) =>
    rpc(METHOD.GET_TRANSACTION, { lookupMethod: 'REF_ID', lookupValue: ref(referenceId) }, id),
  transactionById: (transactionId: string, id: string) => rpc(METHOD.GET_TRANSACTION, { lookupMethod: 'TRANS_ID', lookupValue: transactionId }, id),
  lastTransaction: (id: string) => rpc(METHOD.GET_TRANSACTION, { lookupMethod: 'LAST_TRANS' }, id),
  getTerminalStatus: (id: string) => rpc(METHOD.GET_TERMINAL_STATUS, null, id),
  getBatchFileStatus: (id: string) => rpc(METHOD.GET_BATCH_FILE_STATUS, null, id),
  settlement(id: string, reportFormat?: 'NARROW' | 'MEDIUM' | 'WIDE' | 'XML') {
    const p: Record<string, unknown> = { host: HOST_SHVA };
    if (reportFormat) p.reportFormat = reportFormat;
    return rpc(METHOD.SETTLEMENT, p, id);
  },
  getSettlement(lookupMethod: 'SETTLEMENT_ID' | 'BATCH_NO' | 'LAST_SETTLEMENT', value: string | null, id: string) {
    const p: Record<string, unknown> = { lookupMethod };
    if (lookupMethod !== 'LAST_SETTLEMENT') {
      if (!value) throw new RangeError('lookupValue is required');
      p.lookupValue = value;
    }
    return rpc(METHOD.GET_SETTLEMENT, p, id);
  },
  querySettlements(id: string, q: { from?: string; to?: string; limit?: number; order?: 'ASC' | 'DESC' } = {}) {
    return rpc(METHOD.QUERY_SETTLEMENTS, { queryParams: { ...q } }, id);
  },
  deposit: (id: string) => rpc(METHOD.DEPOSIT, { host: HOST_SHVA }, id),
  getDeviceInfo: (id: string) => rpc(METHOD.GET_DEVICE_INFO, null, id),
  getConfig: (id: string) => rpc(METHOD.GET_CONFIG, null, id),
  setConfig(config: Record<string, unknown>, id: string) {
    const unknown = Object.keys(config).filter((k) => !SETTABLE_CONFIG.includes(k));
    if (unknown.length) throw new RangeError(`setConfig does not take ${unknown.join(', ')}`);
    return rpc(METHOD.SET_CONFIG, { config }, id);
  },
  uploadLogs: (id: string) => rpc(METHOD.UPLOAD_LOGS, null, id),
  reboot: (id: string) => rpc(METHOD.REBOOT, null, id),
  restart: (id: string) => rpc(METHOD.RESTART, null, id),
  readCard: (commandId: string, id: string, o: { mag?: boolean; nfc?: boolean; title?: string; body?: string; timeout?: number }) => {
    if (!o.mag && !o.nfc) throw new RangeError('at least one reader');
    return rpc(METHOD.READ_CARD, clean({ commandId, title: o.title, body: o.body, timeout: o.timeout, readMagCard: o.mag || undefined, readNfcCard: o.nfc || undefined }), id);
  },
  userInput: (commandId: string, id: string, o: { inputType: 'NUMERIC' | 'ALPHANUMERIC' | 'EMAIL' | 'NUMBER'; title?: string; body?: string; minLength?: number; maxLength?: number; minValue?: number; maxValue?: number; timeout?: number }) =>
    rpc(METHOD.USER_INPUT, clean({ commandId, ...o }), id),
  userSelection: (commandId: string, id: string, options: Array<{ id: string; label: string }>, o: { title?: string; body?: string; timeout?: number } = {}) => {
    if (!options.length) throw new RangeError('options must not be empty');
    return rpc(METHOD.USER_SELECTION, clean({ commandId, ...o, options }), id);
  },
  showQr: (commandId: string, id: string, qrData: string, o: { title?: string; body?: string; timeout?: number } = {}) =>
    rpc(METHOD.SHOW_QR, clean({ commandId, ...o, qrData }), id),
  captureSignature: (commandId: string, id: string, mimeType: 'image/png' | 'image/svg+xml' = 'image/png', o: { title?: string; body?: string; timeout?: number } = {}) =>
    rpc(METHOD.CAPTURE_SIGNATURE, clean({ commandId, ...o, mimeType }), id),
};

/** Only these fields are processed by setConfig (docs). */
export const SETTABLE_CONFIG = ['printTransactionReceipt', 'printSettlement', 'cachedResponses', 'nsd'];

function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/* ------------------------------------------------------------------ replies */

export interface RpcError {
  code: number;
  message: string | null;
  data: string | null;
}

export interface Reply {
  id: string | null;
  result: unknown;
  error: RpcError | null;
  raw: string;
}

/** Null when not a JSON object. */
export function parseReply(raw: string): Reply | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  let error: RpcError | null = null;
  if (r.error && typeof r.error === 'object') {
    const e = r.error as Record<string, unknown>;
    const data = e.data === undefined || e.data === null ? null : typeof e.data === 'object' ? JSON.stringify(e.data) : String(e.data);
    error = { code: typeof e.code === 'number' ? e.code : ERR.GENERAL_ERROR, message: typeof e.message === 'string' ? e.message : null, data };
  }
  return { id: r.id === undefined || r.id === null ? null : String(r.id), result: r.result ?? null, error, raw };
}

export function idOf(json: string): string | null {
  try {
    const o = JSON.parse(json) as { id?: unknown };
    return o.id === undefined || o.id === null ? null : String(o.id);
  } catch {
    return null;
  }
}

export function errorHebrew(e: RpcError): string {
  switch (e.code) {
    case ERR.ILLEGAL_REQUEST:
      if (e.data === 'AMOUNT_LIMIT_EXCEEDED') return 'הסכום חורג מהמותר במסוף';
      if (e.data === 'ILLEGAL_NEW_AMOUNT') return 'הסכום החדש אינו חוקי';
      if (e.data === 'NO_GATEWAY') return 'לא הוגדר שער תשלום במסוף';
      return 'בקשה לא חוקית למסוף';
    case ERR.MISSING_PARAM:
    case ERR.INVALID_PARAM:
      return `בקשה לא תקינה למסוף (${e.message ?? e.code})`;
    case ERR.ILLEGAL_STATE:
      return 'המסוף עסוק בפעולה אחרת';
    case ERR.SCREEN_NOT_READY:
      return 'המסוף אינו במסך הראשי';
    case ERR.INSUFFICIENT_BATTERY:
      return 'סוללת המסוף חלשה מדי';
    case ERR.PAYMENT_METHOD_DISABLED:
      return 'אמצעי התשלום מושבת במסוף';
    case ERR.HOST_NOT_READY:
      return 'המסוף אינו מוכן לעסקה (נדרש שידור / פרמטרים)';
    case ERR.TRANSACTION_NOT_FOUND:
      return 'העסקה לא נמצאה במסוף';
    case ERR.TRANSACTION_ALREADY_EXIST:
      return 'מזהה העסקה כבר קיים במסוף';
    case ERR.ILLEGAL_TRANSACTION_STATUS:
      return 'העסקה המקורית אינה במצב שמאפשר את הפעולה';
    case ERR.HOST_DISABLED:
      return 'השרת מושבת במסוף, או שההתחשבנות לא נמצאה';
    default:
      return e.code <= -32600 ? 'המסוף לא הבין את הבקשה' : `שגיאת מסוף ${e.message ?? e.code}`;
  }
}

export interface ReceiptField {
  id: string | null;
  key: string;
  value: string | null;
}

export interface SynqTransaction {
  status: string | null;
  type: string | null;
  referenceId: string | null;
  transactionId: string | null;
  amount: number | null;
  totalAmount: number | null;
  tipAmount: number | null;
  authorizationNumber: string | null;
  rrn: string | null;
  systemTraceNumber: string | null;
  terminalId: string | null;
  maskedPan: string | null;
  panSuffix: string | null;
  cardName: string | null;
  panEntryMode: string | null;
  creditTerms: string | null;
  noOtherInstallmentPayments: number | null;
  firstPayment: number | null;
  noCreditPayments: number | null;
  brand: number | null;
  brandName: string | null;
  issuer: number | null;
  acquirer: number | null;
  hostErrorCode: number | null;
  hostErrorMessage: string | null;
  customerReceipt: ReceiptField[];
  merchantReceipt: ReceiptField[];
}

const str = (v: unknown): string | null => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : String(v));
const int = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
};

function receipt(r: unknown): ReceiptField[] {
  const fields = r && typeof r === 'object' ? (r as { fields?: unknown }).fields : null;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({ id: str(f.id), key: typeof f.key === 'string' ? f.key : '', value: str(f.value) }));
}

export function parseTransaction(t: Record<string, unknown>): SynqTransaction {
  return {
    status: str(t.transactionStatus),
    type: str(t.transactionType),
    referenceId: str(t.referenceId),
    transactionId: str(t.transactionId),
    amount: int(t.amount),
    totalAmount: int(t.totalAmount),
    tipAmount: int(t.tipAmount),
    authorizationNumber: str(t.authorizationNumber),
    rrn: str(t.rrn)?.trim() ?? null,
    systemTraceNumber: str(t.systemTraceNumber),
    terminalId: str(t.terminalId),
    maskedPan: str(t.maskedPan),
    panSuffix: str(t.panSuffix),
    cardName: str(t.cardName),
    panEntryMode: str(t.panEntryMode),
    creditTerms: str(t.creditTerms),
    noOtherInstallmentPayments: int(t.noOtherInstallmentPayments),
    firstPayment: int(t.firstPayment),
    noCreditPayments: int(t.noCreditPayments),
    brand: int(t.brand),
    brandName: str(t.brandName),
    issuer: int(t.issuer),
    acquirer: int(t.acquirer),
    hostErrorCode: int(t.hostErrorCode),
    hostErrorMessage: str(t.hostErrorMessage),
    customerReceipt: receipt(t.cardHolderReceipt),
    merchantReceipt: receipt(t.merchantReceipt),
  };
}

export interface TxReply {
  result: string | null;
  commandStatus: string | null;
  transaction: SynqTransaction | null;
}

/** startTransaction's `result` and getTransaction's `transactionResult` alike. */
export function parseTxReply(result: unknown): TxReply {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const t = r.transaction && typeof r.transaction === 'object' ? parseTransaction(r.transaction as Record<string, unknown>) : null;
  return { result: str(r.result) ?? str(r.transactionResult), commandStatus: str(r.commandStatus), transaction: t };
}

export const chargedOf = (t: SynqTransaction | null): number | null =>
  t ? t.totalAmount ?? (t.amount !== null ? t.amount + (t.tipAmount ?? 0) : null) : null;

export const last4Of = (t: SynqTransaction | null): string | null => {
  if (!t) return null;
  const s = (t.panSuffix ?? '').replace(/\D/g, '');
  if (s.length === 4) return s;
  const d = (t.maskedPan ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
};

export const paymentsOf = (t: SynqTransaction | null): number | null => {
  if (!t) return null;
  if (t.creditTerms === 'INSTALLMENTS') return t.noOtherInstallmentPayments !== null ? t.noOtherInstallmentPayments + 1 : null;
  if (t.creditTerms === 'CREDIT') return t.noCreditPayments;
  return null;
};

/* ------------------------------------------------------------------ meaning */

export type Outcome = 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'BUSY' | 'TIMEOUT' | 'UNKNOWN';

export interface Verdict {
  outcome: Outcome;
  message: string;
  hostCode: number | null;
}

export const CHARGED = new Set(['AUTHORIZED', 'CAPTURED', 'SETTLED', 'DEPOSITED']);
export const NOT_CHARGED = new Set(['DECLINED', 'VOIDED', 'INFORMATIVE']);

export function resultHebrew(result: string | null): string | null {
  switch (result) {
    case 'OK':
      return 'אושר';
    case 'GENERAL_ERROR':
      return 'שגיאה כללית במסוף';
    case 'CANCELED':
      return 'העסקה בוטלה במסוף';
    case 'TIMEOUT':
      return 'תם הזמן במסוף';
    case 'NETWORK_ERROR':
      return 'אין תקשורת מהמסוף לחברת האשראי';
    case 'HOST_ERROR':
      return 'העסקה לא אושרה';
    case 'SMART_READER_ERROR':
      return 'תקלה בקורא הכרטיסים';
    case 'SMART_CARD_ERROR':
      return 'תקלה בקריאת הכרטיס';
    case 'NONE_CREDIT_CARD':
      return 'הכרטיס אינו כרטיס אשראי';
    case 'CARD_NOT_ALLOWED':
      return 'הכרטיס אינו מורשה במסוף';
    default:
      return null;
  }
}

export function classifyTx(reply: TxReply): Verdict {
  const t = reply.transaction;
  const status = t?.status ?? null;
  const hostMessage = t?.hostErrorMessage ?? null;
  const hostCode = t?.hostErrorCode ?? null;
  if (status && CHARGED.has(status)) return { outcome: 'APPROVED', message: 'אושר', hostCode };
  if (status && NOT_CHARGED.has(status)) {
    if (reply.result === 'CANCELED' || status === 'VOIDED') return { outcome: 'CANCELLED', message: status === 'VOIDED' ? 'העסקה בוטלה' : 'העסקה בוטלה במסוף', hostCode: null };
    const resultText = reply.result && reply.result !== 'OK' && reply.result !== 'HOST_ERROR' ? resultHebrew(reply.result) : null;
    return { outcome: 'DECLINED', message: hostMessage ?? resultText ?? `העסקה לא אושרה${hostCode !== null ? ` (קוד ${hostCode})` : ''}`, hostCode };
  }
  if (reply.commandStatus === 'UPDATE' || reply.commandStatus === 'REFERRAL') {
    return { outcome: 'UNKNOWN', message: `המסוף ממתין להמשך העסקה (${reply.commandStatus})`, hostCode: null };
  }
  switch (reply.result) {
    case 'CANCELED':
      return { outcome: 'CANCELLED', message: 'העסקה בוטלה במסוף', hostCode: null };
    case 'HOST_ERROR':
    case 'SMART_READER_ERROR':
    case 'SMART_CARD_ERROR':
    case 'NONE_CREDIT_CARD':
    case 'CARD_NOT_ALLOWED':
      return { outcome: 'DECLINED', message: hostMessage ?? resultHebrew(reply.result)!, hostCode };
    case 'TIMEOUT':
      return { outcome: 'TIMEOUT', message: 'תם הזמן במסוף', hostCode: null };
    case 'OK':
      return { outcome: 'UNKNOWN', message: 'המסוף ענה OK בלי מצב עסקה', hostCode: null };
    case null:
      return { outcome: 'UNKNOWN', message: 'תשובה ללא תוצאה מהמסוף', hostCode: null };
    default:
      return { outcome: 'UNKNOWN', message: resultHebrew(reply.result) ?? `תוצאה לא מוכרת מהמסוף: ${reply.result}`, hostCode: null };
  }
}

export function classifyRequestError(e: RpcError): Verdict {
  if (e.code === ERR.TRANSACTION_ALREADY_EXIST) return { outcome: 'UNKNOWN', message: errorHebrew(e), hostCode: null };
  if (e.code === ERR.ILLEGAL_STATE || e.code === ERR.SCREEN_NOT_READY) return { outcome: 'BUSY', message: errorHebrew(e), hostCode: null };
  return { outcome: 'DECLINED', message: errorHebrew(e), hostCode: null };
}

/** Codes the till reads as something other than a decline (TweezerStatus): never sent as one. */
const RESERVED_STATUS = new Set([0, 10, 162, 126, 998, 993, 995]);

export function declinedStatus(hostCode: number | null): number {
  return hostCode !== null && hostCode >= 1 && hostCode <= 999 && !RESERVED_STATUS.has(hostCode) ? hostCode : 4;
}

/** The ashrait `statusCode` the till's documents and receipts read (as SynqPayProtocol.ashraitStatusOf). */
export function ashraitStatusOf(v: Verdict): number {
  switch (v.outcome) {
    case 'APPROVED':
      return v.hostCode === 10 ? 10 : 0;
    case 'DECLINED':
      return declinedStatus(v.hostCode);
    case 'CANCELLED':
      return 998;
    case 'BUSY':
      return -1;
    default:
      return 993;
  }
}

/**
 * The reply in the till's ashrait shape (the card meta's `result`): statusCode, uid / transactionId
 * (SynqPay's transactionId), vuid, issuerAuthNum, a masked cardNumber, amount = charged in all,
 * instalments, mutag / manpik / solek, the slip as {fieldName, fieldValue}, provider: synqpay.
 */
export function ashraitResult(v: Verdict, t: SynqTransaction | null, vuid: string | null, referenceId: string | null, requestedPayments: number | null = null): Record<string, unknown> {
  const r: Record<string, unknown> = { provider: 'synqpay', statusCode: ashraitStatusOf(v), statusMessage: v.message };
  if (vuid) r.vuid = vuid;
  const refId = t?.referenceId ?? referenceId;
  if (refId) r.synqpayReferenceId = refId;
  if (t?.status) r.synqpayTransactionStatus = t.status;
  if (t?.transactionId) {
    r.uid = t.transactionId;
    r.transactionId = t.transactionId;
  }
  if (t?.authorizationNumber) r.issuerAuthNum = t.authorizationNumber;
  if (t?.maskedPan) r.cardNumber = t.maskedPan.trim().replace(/[Xx•]/g, '*');
  const charged = chargedOf(t);
  if (charged !== null) r.amount = charged;
  if (t?.tipAmount && t.tipAmount > 0) r.tipAmount = t.tipAmount;
  const payments = paymentsOf(t) ?? (v.outcome === 'APPROVED' ? requestedPayments : null);
  if (payments !== null && payments > 1) r.creditPayments = payments;
  if (t?.firstPayment && t.firstPayment > 0) r.firstPaymentAmount = t.firstPayment;
  if (t?.creditTerms) r.synqpayCreditTerms = t.creditTerms;
  if (t?.brand !== null && t?.brand !== undefined) r.mutag = t.brand;
  if (t?.brandName) r.mutagName = t.brandName;
  if (t?.issuer !== null && t?.issuer !== undefined) r.manpik = t.issuer;
  if (t?.acquirer !== null && t?.acquirer !== undefined) r.solek = t.acquirer;
  if (t?.cardName) r.cardName = t.cardName;
  if (t?.panEntryMode) r.panEntryMode = t.panEntryMode;
  if (t?.rrn) r.rrn = t.rrn;
  if (t?.systemTraceNumber) r.voucherNumber = t.systemTraceNumber;
  if (t?.terminalId) r.terminalId = t.terminalId;
  if (t?.hostErrorCode !== null && t?.hostErrorCode !== undefined) r.synqpayHostErrorCode = t.hostErrorCode;
  const slip = (fields: ReceiptField[] | undefined) =>
    fields && fields.length ? fields.map((f) => ({ fieldName: f.key, fieldValue: f.value ?? '', fieldId: f.id })) : null;
  const customer = slip(t?.customerReceipt);
  if (customer) r.customerReceipt = customer;
  const merchant = slip(t?.merchantReceipt);
  if (merchant) r.merchantReceipt = merchant;
  return r;
}

/* ----------------------------------------------------------- terminal state */

export type Health = 'ready' | 'online_only' | 'not_established' | 'busy' | 'error';

export function healthOf(deviceStatus: string | null, terminalStatus: string | null): { health: Health; detail: string | null } {
  switch (deviceStatus) {
    case 'IDLE':
      if (terminalStatus === null || terminalStatus === 'READY') return { health: 'ready', detail: null };
      if (terminalStatus === 'SETTLE_NEEDED') return { health: 'online_only', detail: 'הפרמטרים במסוף ישנים — נדרש שידור' };
      if (terminalStatus === 'NO_PARAMS') return { health: 'not_established', detail: 'אין פרמטרים במסוף — נדרש שידור ראשון' };
      if (terminalStatus === 'NOT_READY') return { health: 'error', detail: 'המסוף אינו מוכן לעסקה' };
      return { health: 'error', detail: `מצב מסוף לא מוכר: ${terminalStatus}` };
    case 'SCREEN_OFF':
      return { health: 'busy', detail: 'מסך המסוף כבוי' };
    case 'SCREEN_BUSY':
      return { health: 'busy', detail: 'המסוף אינו במסך הראשי' };
    case 'TRANSACTION':
    case 'WAITING_CONTINUE_TRANSACTION':
    case 'WAITING_FOR_CONTINUE':
      return { health: 'busy', detail: 'המסוף באמצע עסקה' };
    case 'SETTLEMENT':
      return { health: 'busy', detail: 'המסוף משדר עסקאות' };
    case 'PAIRING':
    case 'UPLOAD_LOGS':
    case 'READ_CARD':
    case 'PROMPT':
    case 'SYSTEM':
      return { health: 'busy', detail: `המסוף עסוק (${deviceStatus})` };
    case null:
      return { health: 'error', detail: 'תשובה ללא מצב מהמסוף' };
    default:
      return { health: 'error', detail: `מצב מכשיר לא מוכר: ${deviceStatus}` };
  }
}

/** The pay screen's line for a transactionEvent (notifyEvents). */
export function eventHebrew(type: string | null): string | null {
  switch (type) {
    case 'WAITING_FOR_CARD':
      return 'הצמד, הכנס או העבר את הכרטיס';
    case 'CARD_DETECTED':
      return 'הכרטיס נקרא…';
    case 'PIN_STARTED':
      return 'הקישו את הקוד הסודי במסוף';
    case 'AUTHORIZATION_STARTED':
      return 'מאשר מול חברת האשראי…';
    case 'TIP_SELECTION':
      return 'בחרו טיפ במסוף';
    case 'ENTER_CVV':
      return 'הקישו CVV במסוף';
    case 'ENTER_CARDHOLDER_ID':
      return 'הקישו תעודת זהות במסוף';
    case 'COMBINED_CARD':
      return 'בחרו אשראי או חיוב מיידי במסוף';
    case 'CREDIT_CONFORMATION':
      return 'אשרו את תנאי האשראי במסוף';
    default:
      return null;
  }
}

/* -------------------------------------------------------------------- batch */

export interface SettlementReading {
  outcome: 'success' | 'failed' | 'busy' | 'unknown';
  batchNumber: string | null;
  settlementId: string | null;
  report: string | null;
  /** SynqPay's transactionId, then our vuid when the referenceId is ours. */
  transactions: Array<{ transactionId: string | null; referenceId: string | null; vuid: string | null; type: string | null }>;
  message: string | null;
}

export function readSettlement(reply: Reply, tillTag: string | null): SettlementReading {
  const none = { batchNumber: null, settlementId: null, report: null, transactions: [] };
  if (reply.error) {
    const busy = reply.error.code === ERR.ILLEGAL_STATE || reply.error.code === ERR.SCREEN_NOT_READY || reply.error.code === ERR.INSUFFICIENT_BATTERY;
    return { ...none, outcome: busy ? 'busy' : 'failed', message: errorHebrew(reply.error) };
  }
  const r = (reply.result && typeof reply.result === 'object' ? reply.result : null) as Record<string, unknown> | null;
  if (!r) return { ...none, outcome: 'unknown', message: 'תשובה ללא תוצאה מהמסוף' };
  const s = (r.settlement && typeof r.settlement === 'object' ? r.settlement : {}) as Record<string, unknown>;
  const list = Array.isArray(s.settledTransactions) ? (s.settledTransactions as Array<Record<string, unknown>>) : [];
  const reading = {
    batchNumber: str(s.batchNo),
    settlementId: str(s.settlementId),
    report: str(s.report)?.split('<!>').join('\n') ?? null,
    transactions: list.map((t) => ({
      transactionId: str(t.transactionId),
      referenceId: str(t.referenceId),
      vuid: vuidOfReference(tillTag, str(t.referenceId)),
      type: str(t.type),
    })),
  };
  if (str(r.result) !== 'OK') return { ...reading, outcome: 'failed', message: resultHebrew(str(r.result)) ?? `השידור נכשל (${str(r.result)})` };
  return { ...reading, outcome: 'success', message: 'שודר' };
}
