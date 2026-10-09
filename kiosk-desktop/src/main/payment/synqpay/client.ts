/**
 * SynqPayClient: every SynqPay function the kiosk needs, over a SynqTransport, with the card
 * recovery rules (pos-server docs/SPEC_CARD_RECOVERY.md, SPEC_SYNQPAY.md §3.1) — as the Android
 * till's SynqPayTerminal.kt:
 *
 *  - a sale is sent ONCE; our referenceId (`<machine tag>-<vuid>`) is SynqPay's duplicate check;
 *  - no answer, or one that says neither way → getTransaction by the same referenceId first; our
 *    own cancel only when that does not settle it; then more lookups — never a second charge;
 *  - 303 (the referenceId exists) → looked up, never read as a decline;
 *  - nothing sent (SynqNotSentError) → a definite "not charged";
 *  - `resolve` (an attempt left unknown): lookups after 0, 2, 4 and 8 s; "not found" believed only
 *    twice ≥ 5 s apart (and SynqPay answers 302 only while idle: getTransaction needs IDLE).
 */

import { randomUUID } from 'node:crypto';
import {
  ERR,
  ashraitResult,
  chargedOf,
  classifyRequestError,
  classifyTx,
  CHARGED,
  errorHebrew,
  healthOf,
  last4Of,
  NOT_CHARGED,
  parseReply,
  parseTxReply,
  paymentsOf,
  readSettlement,
  referenceIdOf,
  requests,
  type Health,
  type Reply,
  type SettlementReading,
  type SynqTransaction,
  type Verdict,
} from './protocol';
import { SynqAuthError, SynqLinkError, SynqNotSentError, type SynqTransport } from './transport';
import { LINK_ERROR } from './link';

export const SYNQ_TIMEOUTS = {
  sale: 150_000,
  void: 60_000,
  probe: 8_000,
  abort: 8_000,
  lookup: 15_000,
  settlement: 150_000,
} as const;

export const LOOKUP_ATTEMPTS = 3;
export const LOOKUP_PAUSE_MS = 2_000;
export const RESOLVE_BACKOFF_MS = [2_000, 4_000, 8_000] as const;
export const NOT_FOUND_CONFIRM_MS = 5_000;

export type TxAnswer =
  | { answer: 'APPROVED'; verdict: Verdict; transaction: SynqTransaction | null; result: Record<string, unknown>; recovered: boolean }
  | { answer: 'DECLINED'; verdict: Verdict; transaction: SynqTransaction | null; result: Record<string, unknown> }
  | { answer: 'UNKNOWN'; message: string };

export type Lookup =
  | { kind: 'found'; answer: Extract<TxAnswer, { answer: 'APPROVED' | 'DECLINED' }> }
  | { kind: 'not_found' }
  | { kind: 'unclear'; message: string };

export interface ProbeResult {
  health: Health | 'disconnected' | 'unauthorized';
  detail: string | null;
  deviceInfo: Record<string, unknown> | null;
}

export class SynqPayClient {
  private identityChecked = false;

  constructor(
    private readonly transport: SynqTransport,
    /** This kiosk (its machine id), for the referenceIds. */
    private readonly tillTag: string | null,
    private readonly opts: {
      serialNumber?: string | null;
      sleep?: (ms: number) => Promise<void>;
      log?: (m: string) => void;
      newId?: () => string;
    } = {},
  ) {}

  referenceId(vuid: string): string {
    return referenceIdOf(this.tillTag, vuid);
  }

  private sleep(ms: number) {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  private log(m: string) {
    this.opts.log?.(m);
  }

  /** One request, its reply read. Rejects when none came (SynqAuthError: the key refused). */
  async call(method: string, timeoutMs: number, build: (id: string) => string, unauthenticated = false): Promise<Reply> {
    const id = this.opts.newId?.() ?? randomUUID();
    let raw: string;
    try {
      raw = await this.transport.call(id, build(id), timeoutMs, unauthenticated);
    } catch (e) {
      this.log(`synqpay ${method}: no reply (${e instanceof Error ? e.message : String(e)})`);
      throw e;
    }
    const reply = parseReply(raw);
    if (!reply) {
      this.log(`synqpay ${method}: unreadable reply (${raw.length} chars)`);
      throw new Error('SynqPay: unreadable reply');
    }
    this.log(`synqpay ${method}: ${reply.error ? `error ${reply.error.code}` : 'ok'}`);
    return reply;
  }

  private definite(verdict: Verdict, vuid: string | null, ref: string | null): TxAnswer {
    return { answer: 'DECLINED', verdict, transaction: null, result: ashraitResult(verdict, null, vuid, ref) };
  }

  private answerOf(verdict: Verdict, t: SynqTransaction | null, vuid: string | null, ref: string | null, payments: number | null, recovered = false): TxAnswer {
    const result = ashraitResult(verdict, t, vuid, ref, payments);
    if (verdict.outcome === 'APPROVED') return { answer: 'APPROVED', verdict, transaction: t, result, recovered };
    return { answer: 'DECLINED', verdict, transaction: t, result };
  }

  /* ------------------------------------------------------------------ money */

  sale(vuid: string, totalAgorot: number, tipAgorot: number, payments: number, notifyEvents = false): Promise<TxAnswer> {
    const ref = this.referenceId(vuid);
    return this.commit(ref, vuid, totalAgorot, payments, (id) => requests.sale(ref, totalAgorot, tipAgorot, payments, id, notifyEvents));
  }

  /** A refund (זיכוי), the card presented; SynqPay takes no link to the original sale. */
  refund(vuid: string, amountAgorot: number): Promise<TxAnswer> {
    const ref = this.referenceId(vuid);
    return this.commit(ref, vuid, amountAgorot, 1, (id) => requests.refund(ref, amountAgorot, id));
  }

  private async commit(ref: string, vuid: string, amount: number, payments: number, build: (id: string) => string): Promise<TxAnswer> {
    let reply: Reply;
    try {
      reply = await this.call('startTransaction', SYNQ_TIMEOUTS.sale, build);
    } catch (e) {
      if (e instanceof SynqAuthError) return this.definite({ outcome: 'DECLINED', message: e.message, hostCode: null }, vuid, ref);
      if (e instanceof SynqNotSentError) return this.definite({ outcome: 'BUSY', message: e.message, hostCode: null }, vuid, ref);
      return this.recoverLost(ref, vuid, amount, e instanceof Error ? e.message : String(e));
    }
    if (reply.error) {
      if (reply.error.code === ERR.TRANSACTION_ALREADY_EXIST) {
        const found = await this.lookupOwn(ref, vuid, amount);
        return found.kind === 'found' ? found.answer : { answer: 'UNKNOWN', message: 'מזהה העסקה כבר קיים במסוף ולא ניתן לברר את מצבה — בדקו במסוף לפני חיוב חוזר.' };
      }
      return this.definite(classifyRequestError(reply.error), vuid, ref);
    }
    if (!reply.result || typeof reply.result !== 'object') return this.recoverLost(ref, vuid, amount, 'תשובה ללא תוצאה');
    const tx = parseTxReply(reply.result);
    const verdict = classifyTx(tx);
    if (verdict.outcome === 'UNKNOWN' || verdict.outcome === 'TIMEOUT') return this.recoverLost(ref, vuid, amount, verdict.message);
    return this.answerOf(verdict, tx.transaction, vuid, ref, payments);
  }

  /** Our transaction [ref] as the terminal holds it; a charge of another amount than [expected] is unclear. */
  async lookupOwn(ref: string, vuid: string, expected: number | null): Promise<Lookup> {
    let reply: Reply;
    try {
      reply = await this.call('getTransaction', SYNQ_TIMEOUTS.lookup, (id) => requests.transactionByReference(ref, id));
    } catch (e) {
      return { kind: 'unclear', message: `לא ניתן לברר את העסקה מול המסוף: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (reply.error) return reply.error.code === ERR.TRANSACTION_NOT_FOUND ? { kind: 'not_found' } : { kind: 'unclear', message: errorHebrew(reply.error) };
    const t = parseTxReply(reply.result).transaction;
    if (!t) return { kind: 'unclear', message: 'תשובת בירור ללא עסקה מהמסוף' };
    if (t.referenceId && t.referenceId !== ref) return { kind: 'unclear', message: `המסוף ענה על עסקה אחרת (${t.referenceId})` };
    let verdict: Verdict;
    if (t.status && CHARGED.has(t.status)) verdict = { outcome: 'APPROVED', message: 'אושר', hostCode: t.hostErrorCode };
    else if (t.status && NOT_CHARGED.has(t.status)) verdict = classifyTx({ result: null, commandStatus: null, transaction: t });
    else return { kind: 'unclear', message: `מצב העסקה במסוף לא ברור (${t.status ?? 'ללא מצב'})` };
    const charged = chargedOf(t);
    if (verdict.outcome === 'APPROVED' && expected !== null && charged !== null && charged !== expected) {
      return { kind: 'unclear', message: `נמצאה עסקה מאושרת בסכום ${(charged / 100).toFixed(2)} במקום ${(expected / 100).toFixed(2)} — יש לבדוק במסוף` };
    }
    const a = this.answerOf(verdict, t, vuid, ref, paymentsOf(t), true);
    return { kind: 'found', answer: a as Extract<TxAnswer, { answer: 'APPROVED' | 'DECLINED' }> };
  }

  private async recoverLost(ref: string, vuid: string, amount: number, why: string): Promise<TxAnswer> {
    let cancelled = false;
    let last = why;
    for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (!cancelled) {
          cancelled = true;
          await this.cancelQuietly(ref);
        }
        await this.sleep(LOOKUP_PAUSE_MS);
      }
      const r = await this.lookupOwn(ref, vuid, amount);
      if (r.kind === 'found') return r.answer;
      last = r.kind === 'not_found' ? 'העסקה לא נמצאה במסוף' : r.message;
    }
    if (!cancelled) await this.cancelQuietly(ref);
    return { answer: 'UNKNOWN', message: `לא התקבלה תשובה ברורה מהמסוף (${last}). ייתכן שהכרטיס חויב — בדקו במסוף לפני חיוב חוזר.` };
  }

  private async cancelQuietly(ref: string) {
    try {
      await this.call('cancel', SYNQ_TIMEOUTS.abort, (id) => requests.cancel(ref, id));
    } catch {
      /* the lookups decide */
    }
  }

  /** Stop our own sale before the card is presented. True when the terminal took the cancel. */
  async abort(vuid: string): Promise<boolean> {
    try {
      return (await this.call('cancel', SYNQ_TIMEOUTS.abort, (id) => requests.cancel(this.referenceId(vuid), id))).error === null;
    } catch {
      return false;
    }
  }

  /**
   * An attempt left unknown (CardStatusResolver): lookups after 0, 2, 4 and 8 s, our cancel once
   * after the first one does not settle it; "not found" only twice, ≥ 5 s apart.
   */
  async resolve(vuid: string, amount: number): Promise<{ kind: 'approved' | 'declined'; answer: TxAnswer } | { kind: 'not_found' } | { kind: 'unknown'; message: string }> {
    const ref = this.referenceId(vuid);
    let waited = 0;
    let firstNotFound: number | null = null;
    let aborted = false;
    let last = 'המסוף לא ענה על בירור העסקה';
    for (let i = 0; i <= RESOLVE_BACKOFF_MS.length; i++) {
      if (i > 0) {
        if (!aborted) {
          aborted = true;
          await this.cancelQuietly(ref);
        }
        await this.sleep(RESOLVE_BACKOFF_MS[i - 1]);
        waited += RESOLVE_BACKOFF_MS[i - 1];
      }
      const r = await this.lookupOwn(ref, vuid, amount);
      if (r.kind === 'found') return { kind: r.answer.answer === 'APPROVED' ? 'approved' : 'declined', answer: r.answer };
      if (r.kind === 'not_found') {
        if (firstNotFound !== null && waited - firstNotFound >= NOT_FOUND_CONFIRM_MS) return { kind: 'not_found' };
        if (firstNotFound === null) firstNotFound = waited;
        last = 'העסקה לא נמצאה במסוף — לא אומת פעם שנייה';
      } else last = r.message;
    }
    if (!aborted) await this.cancelQuietly(ref);
    return { kind: 'unknown', message: last };
  }

  /** Void (ביטול) a sale not yet transmitted: found by its transactionId (or referenceId), VOID by ITS referenceId. */
  async void(original: string): Promise<TxAnswer> {
    let found: SynqTransaction | null;
    try {
      found = await this.findOriginal(original);
    } catch (e) {
      return this.definite({ outcome: 'BUSY', message: `לא ניתן לאתר את העסקה המקורית במסוף: ${e instanceof Error ? e.message : String(e)}`, hostCode: null }, null, null);
    }
    if (!found) return this.definite({ outcome: 'DECLINED', message: 'העסקה המקורית לא נמצאה במסוף', hostCode: null }, null, null);
    if (found.status === 'VOIDED') return this.answerOf({ outcome: 'APPROVED', message: 'העסקה כבר בוטלה', hostCode: null }, found, null, found.referenceId, null);
    if (found.status !== 'AUTHORIZED' && found.status !== 'CAPTURED') {
      return this.definite({ outcome: 'DECLINED', message: `לא ניתן לבטל עסקה במצב ${found.status ?? '?'} — יש לבצע זיכוי`, hostCode: null }, null, found.referenceId);
    }
    const ref = found.referenceId;
    if (!ref) return this.definite({ outcome: 'DECLINED', message: 'לעסקה המקורית אין מזהה הפניה במסוף', hostCode: null }, null, null);
    let reply: Reply;
    try {
      reply = await this.call('startTransaction', SYNQ_TIMEOUTS.void, (id) => requests.void(ref, id));
    } catch (e) {
      if (e instanceof SynqNotSentError) return this.definite({ outcome: 'BUSY', message: e.message, hostCode: null }, null, ref);
      const now = await this.findByReference(ref).catch(() => null);
      if (now?.status === 'VOIDED') return this.answerOf({ outcome: 'APPROVED', message: 'העסקה בוטלה', hostCode: null }, now, null, ref, null);
      return { answer: 'UNKNOWN', message: 'לא התקבלה תשובה לביטול מהמסוף. בדקו במסוף אם העסקה בוטלה לפני ניסיון חוזר.' };
    }
    if (reply.error) return this.definite(classifyRequestError(reply.error), null, ref);
    const tx = parseTxReply(reply.result);
    if (tx.transaction?.status === 'VOIDED' || (tx.result === 'OK' && !tx.transaction?.status)) {
      return this.answerOf({ outcome: 'APPROVED', message: 'העסקה בוטלה', hostCode: null }, tx.transaction ?? found, null, ref, null);
    }
    const v = classifyTx(tx);
    if (v.outcome === 'APPROVED') return this.definite({ outcome: 'DECLINED', message: 'הביטול לא בוצע במסוף', hostCode: null }, null, ref);
    if (v.outcome === 'UNKNOWN' || v.outcome === 'TIMEOUT') return { answer: 'UNKNOWN', message: `תשובת הביטול מהמסוף אינה ברורה (${v.message}) — בדקו במסוף.` };
    return this.definite(v, null, ref);
  }

  private async findOriginal(id: string): Promise<SynqTransaction | null> {
    const byId = await this.call('getTransaction', SYNQ_TIMEOUTS.lookup, (rid) => requests.transactionById(id, rid));
    if (byId.error) {
      if (byId.error.code !== ERR.TRANSACTION_NOT_FOUND) throw new Error(errorHebrew(byId.error));
      return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? this.findByReference(id) : null;
    }
    return parseTxReply(byId.result).transaction;
  }

  private async findByReference(ref: string): Promise<SynqTransaction | null> {
    const r = await this.call('getTransaction', SYNQ_TIMEOUTS.lookup, (id) => requests.transactionByReference(ref, id));
    if (r.error) {
      if (r.error.code === ERR.TRANSACTION_NOT_FOUND) return null;
      throw new Error(errorHebrew(r.error));
    }
    return parseTxReply(r.result).transaction;
  }

  /* ------------------------------------------------------------------ batch */

  /** שידור: settlement to Shva, all or nothing; no answer is "unknown" (the next attempt finds out). */
  async transmit(): Promise<SettlementReading & { raw: string | null }> {
    try {
      const reply = await this.call('settlement', SYNQ_TIMEOUTS.settlement, (id) => requests.settlement(id));
      return { ...readSettlement(reply, this.tillTag), raw: reply.raw };
    } catch (e) {
      const busy = e instanceof SynqNotSentError;
      return { outcome: busy ? 'busy' : 'unknown', batchNumber: null, settlementId: null, report: null, transactions: [], message: e instanceof Error ? e.message : String(e), raw: null };
    }
  }

  /** getBatchFileStatus: how many transactions wait for the next settlement (no amounts in the API). */
  async batchCount(): Promise<number | null> {
    try {
      const r = await this.call('getBatchFileStatus', SYNQ_TIMEOUTS.probe, (id) => requests.getBatchFileStatus(id));
      const main = (r.result as { mainTerminal?: { batchFile?: unknown[] } } | null)?.mainTerminal;
      return Array.isArray(main?.batchFile) ? main.batchFile.length : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ state */

  /** getStatus, then (idle) getTerminalStatus, and once getDeviceInfo: another serial number is another terminal. */
  async probe(): Promise<ProbeResult> {
    let status: Reply;
    try {
      try {
        status = await this.call('getStatus', SYNQ_TIMEOUTS.probe, (id) => requests.getStatus(id));
      } catch (e) {
        if (!(e instanceof SynqLinkError) || e.code !== LINK_ERROR.CRC_ERROR || !this.transport.flipCrcOrder?.()) throw e;
        status = await this.call('getStatus', SYNQ_TIMEOUTS.probe, (id) => requests.getStatus(id));
      }
    } catch (e) {
      if (e instanceof SynqAuthError) return { health: 'unauthorized', detail: e.message, deviceInfo: null };
      return { health: 'disconnected', detail: e instanceof Error ? e.message : String(e), deviceInfo: null };
    }
    if (status.error) return { health: 'error', detail: errorHebrew(status.error), deviceInfo: null };
    const device = ((status.result ?? {}) as Record<string, unknown>).deviceStatus;
    let terminalStatus: string | null = null;
    let info: Record<string, unknown> | null = null;
    if (device === 'IDLE') {
      try {
        const ts = await this.call('getTerminalStatus', SYNQ_TIMEOUTS.probe, (id) => requests.getTerminalStatus(id));
        if (ts.error?.code === ERR.ILLEGAL_REQUEST) return { health: 'not_established', detail: 'לא הוגדר מסוף שב"א במכשיר', deviceInfo: null };
        const r = (ts.result ?? {}) as Record<string, unknown>;
        const s = r.terminalStatus ?? r.status;
        terminalStatus = typeof s === 'string' ? s : null;
      } catch {
        terminalStatus = null;
      }
      if (!this.identityChecked) {
        info = await this.deviceInfo().catch(() => null);
        if (info) {
          const serial = typeof info.serialNumber === 'string' ? info.serialNumber : null;
          const expected = this.opts.serialNumber ?? null;
          if (expected && serial && serial.toUpperCase() !== expected.toUpperCase()) {
            return { health: 'error', detail: `מחובר מסוף אחר (מספר סידורי ${serial} במקום ${expected})`, deviceInfo: info };
          }
          this.identityChecked = true;
        }
      }
    }
    const h = healthOf(typeof device === 'string' ? device : null, terminalStatus);
    return { health: h.health, detail: h.detail, deviceInfo: info };
  }

  /* ------------------------------------------------- data and maintenance */

  /**
   * getDeviceInfo. `unauthenticated`: without the key — SynqPay documents only pair / authenticate
   * as key-free, so a terminal may refuse it; the pairing tries it once for the serial number.
   */
  async deviceInfo(unauthenticated = false): Promise<Record<string, unknown> | null> {
    const r = await this.call('getDeviceInfo', SYNQ_TIMEOUTS.probe, (id) => requests.getDeviceInfo(id), unauthenticated);
    return r.result && typeof r.result === 'object' ? (r.result as Record<string, unknown>) : null;
  }

  terminalStatus = () => this.call('getTerminalStatus', SYNQ_TIMEOUTS.probe, (id) => requests.getTerminalStatus(id));
  config = () => this.call('getConfig', SYNQ_TIMEOUTS.probe, (id) => requests.getConfig(id));
  setConfig = (config: Record<string, unknown>) => this.call('setConfig', SYNQ_TIMEOUTS.probe, (id) => requests.setConfig(config, id));
  transactionById = (transactionId: string) => this.call('getTransaction', SYNQ_TIMEOUTS.lookup, (id) => requests.transactionById(transactionId, id));
  lastTransaction = () => this.call('getTransaction', SYNQ_TIMEOUTS.lookup, (id) => requests.lastTransaction(id));
  batchFile = () => this.call('getBatchFileStatus', SYNQ_TIMEOUTS.probe, (id) => requests.getBatchFileStatus(id));
  settlementBy = (method: 'SETTLEMENT_ID' | 'BATCH_NO' | 'LAST_SETTLEMENT', value: string | null) =>
    this.call('getSettlement', SYNQ_TIMEOUTS.lookup, (id) => requests.getSettlement(method, value, id));
  settlements = (q: { from?: string; to?: string; limit?: number; order?: 'ASC' | 'DESC' } = {}) =>
    this.call('querySettlements', SYNQ_TIMEOUTS.lookup, (id) => requests.querySettlements(id, q));
  deposit = () => this.call('deposit', SYNQ_TIMEOUTS.settlement, (id) => requests.deposit(id));
  uploadLogs = () => this.call('uploadLogs', SYNQ_TIMEOUTS.settlement, (id) => requests.uploadLogs(id));
  reboot = () => this.call('reboot', SYNQ_TIMEOUTS.probe, (id) => requests.reboot(id));
  restart = () => this.call('restart', SYNQ_TIMEOUTS.probe, (id) => requests.restart(id));

  /** Pairing, step 1: the terminal shows a 6-digit OTP for 30 seconds. */
  pair = (serialNumber: string) => this.call('pair', SYNQ_TIMEOUTS.probe, (id) => requests.pair(serialNumber, id), true);

  /** Pairing, step 2: the new API key, or null when refused. Never logged. */
  async authenticate(otp: string): Promise<string | null> {
    const r = await this.authenticateReply(otp);
    const key = (r.result as { apiKey?: unknown } | null)?.apiKey;
    return typeof key === 'string' ? key : null;
  }

  /** Pairing, step 2, the whole reply: `result.apiKey`, or 103 (a wrong code) / 201 (the code ran out). */
  authenticateReply = (otp: string) => this.call('authenticate', SYNQ_TIMEOUTS.probe, (id) => requests.authenticate(otp, id), true);

  close() {
    this.transport.close();
  }
}

export { last4Of };
