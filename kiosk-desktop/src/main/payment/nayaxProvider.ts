/**
 * The Nayax network pinpad ("nayax_lan") as a PaymentProvider: the till's TweezerComm frames
 * (core/nayax.ts) over the pinned HTTP transport (pinpadHttp.ts), the till's card meta, and the
 * card-recovery lookup by vuid (core/cardRecovery.ts).
 *
 * What is TweezerComm and not HTTP (the sale, the acknowledgement, the lookups, the abort, the
 * day's batch) is NayaxTweezerProvider, shared with the C4 on the kiosk's USB (nayaxUsb.ts).
 */

import { resolveAttempt, type CallFn } from '../../core/cardRecovery';
import { acknowledgeApproval } from '../../core/terminalAck';
import {
  abortFrame,
  cardAnswerOf,
  parseCardResponse,
  parseReply,
  periodicFrame,
  pinpadAddressOf,
  pinpadUrl,
  privateIpv4,
  saleFrame,
  saleOutcome,
  statusFrame,
  strictInt,
  TIMEOUTS,
  vuidOf,
  type ParsedReply,
  type PinpadAddress,
} from '../../core/nayax';
import { postFrame, tlsRefused, type PinStore } from './pinpadHttp';
import type { ApprovedCard, PaymentProvider, ProviderContext, ProviderFactory, ProviderKind, Resolution, SaleResult, TransmitResult } from './provider';

const HTTP_MEMORY_MS = 24 * 3_600_000;

function parameterOn(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on', 'כן'].includes(v.trim().toLowerCase());
  return false;
}

/** The till's card meta for a completed sale (cardSaleMeta): nulls left out, the raw result kept. */
export function cardSaleMeta(vuid: string, reply: ParsedReply, chargedAgorot: number, payments: number, recovered: boolean): Record<string, unknown> {
  const card = parseCardResponse(reply);
  const meta: Record<string, unknown> = {
    vuid,
    uid: card.uid,
    authNum: card.authNum,
    cardLast4: card.last4,
    statusCode: card.statusCode,
    outcome: card.statusCode === 10 ? 'partial' : 'approved',
    chargedAmount: chargedAgorot,
    keyed: false,
    creditPayments: card.creditPayments,
    firstPaymentAmount: card.firstPaymentAmount,
    requestedPayments: payments > 1 ? payments : null,
  };
  if (recovered) meta.recoveredByLookup = true;
  meta.result = reply.result;
  for (const k of Object.keys(meta)) if (meta[k] === null || meta[k] === undefined) delete meta[k];
  return meta;
}

function approvedCard(vuid: string, reply: ParsedReply, chargedAgorot: number, payments: number, recovered: boolean): ApprovedCard {
  const card = parseCardResponse(reply);
  return {
    brand: card.brand,
    last4: card.last4,
    authNum: card.authNum,
    uid: card.uid,
    payments: card.creditPayments,
    firstPaymentAgorot: card.firstPaymentAmount,
    chargedAgorot: card.amountAgorot,
    meta: cardSaleMeta(vuid, reply, chargedAgorot, payments, recovered),
  };
}

/**
 * A Nayax terminal spoken to in TweezerComm (core/nayax.ts), whatever carries the frames ([call]):
 * HTTP to the network pinpad (NayaxLanProvider) or the C4's own USB (nayaxUsb.ts). The money rules
 * live here once: one sale frame, never re-sent; "ackTransaction" before anything is written; a
 * lost answer settled by the vuid (core/cardRecovery.ts); an abort only before an answer.
 */
export abstract class NayaxTweezerProvider implements PaymentProvider {
  abstract readonly kind: ProviderKind;
  abstract describe(): { kind: ProviderKind; address: string | null };

  /** One frame to the terminal, once (a transport error is `ok: false`, never a retry). */
  protected abstract call: CallFn;

  constructor(
    protected readonly ctx: ProviderContext,
    /** The clock for the acknowledgement's ten seconds and the lookups' pauses (tests pass their own). */
    protected readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  newReference(): string {
    return vuidOf(this.ctx.machineId, this.ctx.nextSequence('vuid'));
  }

  async check(timeoutMs: number = TIMEOUTS.status) {
    const r = await this.call(statusFrame(), timeoutMs);
    return r.ok ? { ok: true, detail: null } : { ok: false, detail: r.error };
  }

  async sale(req: { amountAgorot: number; reference: string; payments: number; onProgress?: (m: string) => void; onAnswered?: () => void }): Promise<SaleResult> {
    req.onProgress?.('הצמד, הכנס או העבר את הכרטיס');
    const r = await this.call(saleFrame(req.amountAgorot, req.reference, req.payments), TIMEOUTS.sale);
    if (!r.ok) return { answer: 'UNKNOWN', message: `אין תשובה מהמסוף: ${r.error}`, raw: null };
    req.onAnswered?.();
    const reply = parseReply(r.body);
    const outcome = saleOutcome(reply);
    const answer = cardAnswerOf(outcome);
    if (answer === 'APPROVED') {
      // "ackTransaction" (core/terminalAck.ts): acknowledged at once, before anything is written —
      // the terminal cancels an approval nobody acknowledges within ten seconds.
      const ack = await acknowledgeApproval({ vuid: req.reference, amountAgorot: req.amountAgorot, result: reply.result }, this.call, this.sleep);
      if (ack.kind === 'final') return { answer, card: approvedCard(req.reference, reply, req.amountAgorot, req.payments, false), raw: r.body };
      if (ack.kind === 'approved') {
        const found = parseReply(ack.body);
        return { answer: 'APPROVED', card: approvedCard(req.reference, found, req.amountAgorot, req.payments, true), raw: ack.body };
      }
      if (ack.kind === 'not_charged') return { answer: 'DECLINED', message: ack.message, raw: r.body, statusCode: null };
      return { answer: 'UNKNOWN', message: ack.message, raw: r.body };
    }
    if (answer === 'DECLINED') return { answer, message: reply.statusMessage ?? outcome, raw: r.body, statusCode: reply.statusCode };
    return { answer: 'UNKNOWN', message: reply.statusMessage ?? outcome, raw: r.body };
  }

  async resolve(attempt: { reference: string; amountAgorot: number; terminalTip: boolean }): Promise<Resolution> {
    const s = await resolveAttempt({ vuid: attempt.reference, amountAgorot: attempt.amountAgorot, terminalTip: attempt.terminalTip }, this.call, this.sleep);
    if (s.kind === 'approved') {
      const reply = parseReply(s.body);
      const payments = strictInt(reply.result?.creditPayments) ?? 1;
      return { kind: 'approved', card: approvedCard(attempt.reference, reply, attempt.amountAgorot, payments, true) };
    }
    if (s.kind === 'not_charged') return { kind: 'not_charged', outcome: s.outcome, message: s.message };
    return { kind: 'unknown', message: s.message };
  }

  async abort(reference: string): Promise<void> {
    await this.call(abortFrame(reference), TIMEOUTS.abort);
  }

  async transmit(): Promise<TransmitResult> {
    const r = await this.call(periodicFrame(false), TIMEOUTS.periodic);
    if (!r.ok) return { outcome: 'unknown', batchNumber: null, statusCode: null, statusMessage: null, error: r.error, transactionCount: null, amountAgorot: null, raw: null };
    const reply = parseReply(r.body);
    const res = reply.result ?? {};
    const pick = (...keys: string[]) => {
      for (const k of keys) if (res[k] !== undefined && res[k] !== null) return String(res[k]);
      return null;
    };
    const busy = reply.statusCode === -1 || reply.statusCode === -5;
    return {
      outcome: reply.statusCode === 0 ? 'success' : busy ? 'busy' : reply.statusCode === null ? 'unknown' : 'failed',
      batchNumber: pick('batchNumber', 'batch', 'depositNumber', 'shovarNumber'),
      statusCode: reply.statusCode,
      statusMessage: reply.statusMessage,
      error: null,
      transactionCount: strictInt(res.transactionCount ?? res.count),
      amountAgorot: strictInt(res.amount ?? res.totalAmount),
      raw: r.body,
    };
  }
}

export class NayaxLanProvider extends NayaxTweezerProvider {
  readonly kind = 'nayax_lan' as const;
  private readonly pins: PinStore;

  constructor(
    private readonly address: PinpadAddress,
    ctx: ProviderContext,
    /** The clock for the acknowledgement's ten seconds and the lookups' pauses (tests pass their own). */
    sleep?: (ms: number) => Promise<void>,
  ) {
    super(ctx, sleep);
    this.pins = {
      get: (hp) => ctx.getValue(`pinpad.pin:${hp}`),
      set: (hp, pin) => ctx.setValue(`pinpad.pin:${hp}`, pin),
    };
  }

  describe() {
    return { kind: this.kind, address: pinpadUrl(this.address) };
  }

  /** Which scheme to use now (pinpadSchemePlan): https, http, or detect. */
  private plan(): 'https' | 'http' | 'detect' | 'refused' {
    const allowHttp = parameterOn(this.ctx.parameter('pinpadAllowHttp')) && privateIpv4(this.address.host);
    const hp = `${this.address.host}:${this.address.port}`;
    if (!this.address.tls) return allowHttp ? 'http' : 'refused';
    if (this.pins.get(hp) || !allowHttp) return 'https';
    const remembered = this.ctx.getValue(`pinpad.scheme:${hp}`);
    const at = remembered?.startsWith('http@') ? Number(remembered.slice(5)) : NaN;
    if (Number.isFinite(at) && Date.now() - at < HTTP_MEMORY_MS) return 'http';
    return 'detect';
  }

  /** One frame to the pinpad. A sale frame is never sent twice: detection uses getStatus only. */
  protected call: CallFn = async (frame, timeoutMs) => {
    const plan = this.plan();
    if (plan === 'refused') return { ok: false, error: 'http_not_allowed' };
    const https: PinpadAddress = { ...this.address, tls: true };
    const http: PinpadAddress = { ...this.address, tls: false };
    try {
      if (plan === 'http') return this.ok(await postFrame(http, frame, timeoutMs, null));
      if (plan === 'https') return this.ok(await postFrame(https, frame, timeoutMs, this.pins));
      // detect: getStatus over HTTPS; only a TLS-level refusal tries HTTP (getStatus), and only then the frame.
      try {
        await postFrame(https, statusFrame(), TIMEOUTS.status, this.pins);
        return this.ok(await postFrame(https, frame, timeoutMs, this.pins));
      } catch (e) {
        if (!tlsRefused(e)) throw e;
        await postFrame(http, statusFrame(), TIMEOUTS.status, null);
        this.ctx.setValue(`pinpad.scheme:${this.address.host}:${this.address.port}`, `http@${Date.now()}`);
        return this.ok(await postFrame(http, frame, timeoutMs, null));
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  private ok(r: { status: number; body: string }) {
    if (r.status < 200 || r.status >= 300) return { ok: false as const, error: `HTTP ${r.status}` };
    return { ok: true as const, body: r.body };
  }
}

/** The kiosk's pinpad from the cloud settings (nayaxDeviceHost / Port / SpicyPath, paymentIntegration). */
export const nayaxLanFactory: ProviderFactory = (settings, ctx) => {
  const integration = String(settings.paymentIntegration ?? 'auto').toLowerCase().replace(/-/g, '_');
  if (integration !== 'auto' && integration !== 'nayax_lan') return null;
  const addr = pinpadAddressOf(
    settings.nayaxDeviceHost as string | null,
    settings.nayaxDevicePort === undefined || settings.nayaxDevicePort === null ? null : String(settings.nayaxDevicePort),
    settings.nayaxSpicyPath as string | null,
  );
  return addr ? new NayaxLanProvider(addr, ctx) : null;
};
