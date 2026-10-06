/**
 * SynqPay as the kiosk's PaymentProvider (../provider.ts), from the cloud settings
 * (`paymentIntegration` = `synqpay`, the `synqpay*` keys and the `synqpayApiKey` secret the
 * settings sync delivers — pos-server docs/SPEC_SYNQPAY.md §2). PayService applies the kiosk's
 * payment rules; this speaks the terminal (SynqPayClient) and hands back the till's card meta.
 */

import { brandOf, vuidOf } from '../../../core/nayax';
import type { PinStore } from '../pinpadHttp';
import type { ApprovedCard, PaymentProvider, ProviderContext, ProviderFactory, Resolution, SaleResult, TransmitResult } from '../provider';
import { SynqPayClient, type TxAnswer } from './client';
import { PAIRING_TEXT, type PairingTerminal } from './pairing';
import { eventHebrew, last4Of, paymentsOf } from './protocol';
import { HttpTransport, LinkTransport, serialChannel, tcpChannel, type SynqTransport } from './transport';

/**
 * How the kiosk reaches its EXTERNAL SynqPay terminal (the owner: "LAN/USB זה כשמדובר בקופה עם
 * מסופון חיצוני"): `lan` (host, port, TLS — IP over USB too) or `usb` (the serial link, found by
 * itself). A Windows PC is never the terminal: there is no built-in mode here.
 */
export type SynqConnection = 'lan' | 'usb';

export interface SynqPaySettings {
  model: string;
  connection: SynqConnection;
  host: string | null;
  protocol: 'tcp' | 'http';
  port: number;
  tls: boolean;
  /** "VVVV:PPPP" or "COMn"; null = the only USB serial port. */
  usbDevice: string | null;
  serialNumber: string | null;
  /** The pairing's key; '' when there is none yet (not paired — SPEC_SYNQPAY.md §2.2). */
  apiKey: string;
  /** The kiosk holds a key: without one nothing but pair / authenticate is sent. */
  paired: boolean;
  /**
   * The terminal number this kiosk must charge on (`expectedTerminalNumber`, which the cloud sends
   * an external terminal only from the machine's own layer). Null: not set — card locked.
   */
  expectedTerminal: string | null;
}

const MODELS = ['dx8000', 'dx6000', 'ex8000', 'rx5000', 's1p2', 's1u2_m4', 'verifone', 'other'];

function text(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** The documented ports: TCP 9000 / TLS 9443, HTTP 8000 / HTTPS 8443. */
export function defaultPort(protocol: 'tcp' | 'http', tls: boolean): number {
  return protocol === 'http' ? (tls ? 8443 : 8000) : tls ? 9443 : 9000;
}

/**
 * The settings, or the keys missing (in the dashboard's order) — as synqpaySettingsOf on the till.
 * No key is not a missing field: the kiosk pairs with the terminal itself (`paired` false until then).
 */
export function synqpaySettingsOf(s: Record<string, unknown>): { settings: SynqPaySettings | null; missing: string[] } {
  const model = text(s.synqpayDeviceModel)?.toLowerCase().replace(/-/g, '_') ?? null;
  const connection = text(s.synqpayConnection)?.toLowerCase().replace(/-/g, '_') ?? null;
  const host = text(s.synqpayHost)?.toLowerCase() ?? null;
  const apiKey = text(s.synqpayApiKey);
  const conn: SynqConnection | null = connection === 'lan' ? 'lan' : connection === 'usb' || connection === 'usb_serial' ? 'usb' : null;
  const missing: string[] = [];
  if (!model || !MODELS.includes(model)) missing.push('synqpayDeviceModel');
  if (!conn) missing.push('synqpayConnection');
  if (conn === 'lan' && !(host && /^[a-z0-9.-]+$/.test(host))) missing.push('synqpayHost');
  const key = apiKey && /^[A-Za-z0-9]{1,64}$/.test(apiKey) ? apiKey : '';
  if (missing.length) return { settings: null, missing };
  const protocol = text(s.synqpayProtocol)?.toLowerCase() === 'http' ? 'http' : 'tcp';
  const tls = s.synqpayTls === true || text(s.synqpayTls)?.toLowerCase() === 'true';
  const portRaw = Number(text(s.synqpayPort));
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : defaultPort(protocol, tls);
  return {
    settings: {
      model: model!,
      connection: conn!,
      host: conn === 'usb' ? null : host,
      protocol,
      port,
      tls,
      usbDevice: text(s.synqpayUsbDevice)?.toUpperCase() ?? null,
      serialNumber: text(s.synqpaySerialNumber),
      apiKey: key,
      paired: key !== '',
      expectedTerminal: expectedTerminalOf(s),
    },
    missing: [],
  };
}

/**
 * The machine's own expected terminal number: the cloud sends an external terminal's only from
 * the machine layer (terminal_config_guard); where it says the source, anything else is no number.
 */
export function expectedTerminalOf(s: Record<string, unknown>): string | null {
  const value = text(s.expectedTerminalNumber);
  if (!value) return null;
  const sources = s.terminalConfigSources;
  if (sources && typeof sources === 'object' && !Array.isArray(sources)) {
    const from = (sources as Record<string, unknown>).expectedTerminalNumber;
    if (from !== undefined && from !== 'machine') return null;
  }
  return value;
}

/** Terminal numbers equal but for leading zeros ("0883198" is "883198"). */
const sameTerminal = (a: string, b: string) => a.replace(/^0+/, '') === b.replace(/^0+/, '');

export type CardLock = { reason: 'not_configured' | 'unknown' | 'mismatch'; expected: string | null; actual: string | null };

/**
 * The till's card lock for an external terminal (pos-android domain/CardLock.kt; SPEC_SYNQPAY.md
 * §2.1): no machine-level number, an unread terminal, or another number locks the CARD — never
 * the kiosk. Null: cards may be charged.
 */
export function cardLockOf(expected: string | null, reported: string | null): CardLock | null {
  if (!expected) return { reason: 'not_configured', expected: null, actual: reported };
  if (!reported) return { reason: 'unknown', expected, actual: null };
  return sameTerminal(expected, reported) ? null : { reason: 'mismatch', expected, actual: reported };
}

export function cardLockText(lock: CardLock): string {
  switch (lock.reason) {
    case 'not_configured':
      return 'האשראי נעול: לא הוגדר מספר מסוף לקיוסק' + (lock.actual ? ` (המסוף המחובר: ${lock.actual})` : '');
    case 'unknown':
      return `האשראי נעול: לא ניתן לקרוא את זהות המסוף (מסוף שהוגדר: ${lock.expected ?? '—'})`;
    default:
      return `האשראי נעול: המסוף המחובר (${lock.actual ?? '—'}) אינו תואם למסוף שהוגדר (${lock.expected ?? '—'})`;
  }
}

/** Where the frames go, for staff ("192.168.1.40:9000 (TCP)", "USB COM3"). Never the key. */
export function describeSettings(s: SynqPaySettings): string {
  if (s.connection === 'usb') return `USB ${s.usbDevice ?? 'auto'}`;
  return `${s.host}:${s.port} (${s.protocol.toUpperCase()}${s.tls ? '+TLS' : ''})`;
}

/** The latest key per link, so a key changed in the cloud applies without a new provider. */
const KEYS = new Map<string, string>();

export function transportFor(s: SynqPaySettings, pins: PinStore, log: (m: string) => void, onEvent?: (json: string) => void): SynqTransport {
  const address = describeSettings(s);
  KEYS.set(address, s.apiKey);
  const key = () => KEYS.get(address) ?? s.apiKey;
  if (s.connection === 'usb') {
    return new LinkTransport(address, key, () => serialChannel(s.usbDevice), { log, onEvent });
  }
  const trust = s.tls ? { pins, pinKey: `synqpay:${s.host}:${s.port}` } : null;
  if (s.protocol === 'http') return new HttpTransport(s.host!, s.port, key, trust);
  return new LinkTransport(address, key, () => tcpChannel(s.host!, s.port, trust), { log, onEvent });
}

/** The till's card meta for a completed sale (cardSaleMeta), the ashrait result kept. */
function approvedCard(vuid: string, a: Extract<TxAnswer, { answer: 'APPROVED' }>, requestedPayments: number): ApprovedCard {
  const r = a.result;
  const t = a.transaction;
  const charged = typeof r.amount === 'number' ? r.amount : null;
  const payments = paymentsOf(t);
  const meta: Record<string, unknown> = {
    vuid,
    uid: t?.transactionId ?? null,
    authNum: t?.authorizationNumber ?? null,
    cardLast4: last4Of(t),
    statusCode: r.statusCode,
    outcome: r.statusCode === 10 ? 'partial' : 'approved',
    chargedAmount: charged,
    keyed: false,
    creditPayments: payments !== null && payments > 1 ? payments : null,
    firstPaymentAmount: t?.firstPayment ?? null,
    requestedPayments: requestedPayments > 1 ? requestedPayments : null,
  };
  if (a.recovered) meta.recoveredByLookup = true;
  meta.result = r;
  for (const k of Object.keys(meta)) if (meta[k] === null || meta[k] === undefined) delete meta[k];
  return {
    brand: brandOf(r),
    last4: last4Of(t),
    authNum: t?.authorizationNumber ?? null,
    uid: t?.transactionId ?? null,
    payments: payments !== null && payments > 1 ? payments : null,
    firstPaymentAgorot: t?.firstPayment ?? null,
    chargedAgorot: charged,
    meta,
  };
}

export class SynqPayProvider implements PaymentProvider {
  readonly kind = 'synqpay' as const;
  readonly client: SynqPayClient;
  private progress: ((m: string) => void) | null = null;

  constructor(
    readonly settings: SynqPaySettings,
    private readonly ctx: ProviderContext,
    transport?: SynqTransport,
  ) {
    const pins: PinStore = {
      get: (hp) => ctx.getValue(`synqpay.pin:${hp}`),
      set: (hp, pin) => ctx.setValue(`synqpay.pin:${hp}`, pin),
    };
    const onEvent = (json: string) => {
      try {
        const type = (JSON.parse(json) as { params?: { type?: string } }).params?.type ?? null;
        const line = eventHebrew(type);
        if (line) this.progress?.(line);
      } catch {
        /* not ours to break on */
      }
    };
    this.client = new SynqPayClient(transport ?? transportFor(settings, pins, ctx.log, onEvent), ctx.machineId, {
      serialNumber: settings.serialNumber,
      log: ctx.log,
    });
  }

  describe() {
    return { kind: this.kind, address: describeSettings(this.settings) };
  }

  /** Set up but not paired: it cannot charge until it is (PayService reads it as "unconfigured"). */
  get configured(): boolean {
    return this.settings.paired;
  }

  /** The pairing's way to this terminal (pairing.ts): pair / authenticate need no key. */
  pairing(): PairingTerminal {
    return {
      pair: (serial) => this.client.pair(serial),
      authenticateReply: (otp) => this.client.authenticateReply(otp),
      serialWithoutKey: async () => {
        const info = await this.client.deviceInfo(!this.settings.paired).catch(() => null);
        const serial = info && typeof info.serialNumber === 'string' ? info.serialNumber.trim() : null;
        return serial || null;
      },
    };
  }

  newReference(): string {
    return vuidOf(this.ctx.machineId, this.ctx.nextSequence('vuid'));
  }

  /** The terminal's number as it says it now (getTerminalStatus), or null when it cannot say. */
  async reportedTerminal(): Promise<string | null> {
    try {
      const r = await this.client.terminalStatus();
      const id = (r.result as { terminalId?: unknown } | null)?.terminalId;
      return typeof id === 'string' && /^\d+$/.test(id.trim()) ? id.trim() : null;
    } catch {
      return null;
    }
  }

  /** The card lock now (SPEC_SYNQPAY.md §2.1): read off the terminal, never trusted on first use. */
  async cardLock(): Promise<CardLock | null> {
    const lock = cardLockOf(this.settings.expectedTerminal, this.settings.expectedTerminal ? await this.reportedTerminal() : null);
    if (lock) this.ctx.log(`synqpay: card locked (${lock.reason}, expected ${lock.expected ?? '-'}, connected ${lock.actual ?? '-'})`);
    return lock;
  }

  async check(): Promise<{ ok: boolean; detail: string | null }> {
    if (!this.settings.paired) return { ok: false, detail: PAIRING_TEXT.notPaired };
    const p = await this.client.probe();
    if (p.health === 'unauthorized') {
      // The terminal refused the key: a pairing to do, and the cloud told (once per key).
      this.ctx.onKeyRejected?.(p.detail);
      return { ok: false, detail: `המסוף דורש צימוד — ${p.detail ?? 'מפתח ה-API נדחה במסוף'}` };
    }
    if (p.health !== 'ready' && p.health !== 'online_only') return { ok: false, detail: p.detail };
    const lock = await this.cardLock();
    return lock ? { ok: false, detail: cardLockText(lock) } : { ok: true, detail: p.detail };
  }

  async sale(req: { amountAgorot: number; reference: string; payments: number; onProgress?: (m: string) => void }): Promise<SaleResult> {
    // Not paired: nothing is sent (SPEC_SYNQPAY.md §2.2).
    if (!this.settings.paired) return { answer: 'DECLINED', message: PAIRING_TEXT.notPaired, raw: null, statusCode: null };
    // Never a card on a terminal that is not the one set for this kiosk: nothing is sent.
    const lock = await this.cardLock();
    if (lock) return { answer: 'DECLINED', message: cardLockText(lock), raw: null, statusCode: null };
    req.onProgress?.('הצמד, הכנס או העבר את הכרטיס');
    this.progress = req.onProgress ?? null;
    try {
      // Events only where the link carries them (TCP / serial), for the pay screen's line.
      const events = this.settings.protocol === 'tcp' || this.settings.connection === 'usb';
      const a = await this.client.sale(req.reference, req.amountAgorot, 0, req.payments, events);
      if (a.answer === 'APPROVED') return { answer: 'APPROVED', card: approvedCard(req.reference, a, req.payments), raw: JSON.stringify(a.result) };
      if (a.answer === 'DECLINED') {
        const code = typeof a.result.statusCode === 'number' ? a.result.statusCode : null;
        return { answer: 'DECLINED', message: a.verdict.message, raw: JSON.stringify(a.result), statusCode: code };
      }
      return { answer: 'UNKNOWN', message: a.message, raw: null };
    } finally {
      this.progress = null;
    }
  }

  async resolve(attempt: { reference: string; amountAgorot: number; terminalTip: boolean }): Promise<Resolution> {
    const r = await this.client.resolve(attempt.reference, attempt.amountAgorot);
    if (r.kind === 'approved' && r.answer.answer === 'APPROVED') return { kind: 'approved', card: approvedCard(attempt.reference, r.answer, 1) };
    if (r.kind === 'declined') return { kind: 'not_charged', outcome: 'declined', message: 'העסקה נדחתה במסוף' };
    if (r.kind === 'not_found') return { kind: 'not_charged', outcome: 'not_found', message: 'העסקה לא נמצאה במסוף' };
    return { kind: 'unknown', message: r.kind === 'unknown' ? r.message : 'לא ידוע' };
  }

  async abort(reference: string): Promise<void> {
    await this.client.abort(reference);
  }

  async transmit(): Promise<TransmitResult> {
    const r = await this.client.transmit();
    const count = await this.client.batchCount().catch(() => null);
    return {
      outcome: r.outcome,
      batchNumber: r.batchNumber,
      statusCode: r.outcome === 'success' ? 0 : r.outcome === 'busy' ? -1 : r.outcome === 'failed' ? 4 : null,
      statusMessage: r.message,
      error: r.outcome === 'unknown' ? r.message : null,
      transactionCount: r.outcome === 'success' ? r.transactions.length : count,
      amountAgorot: null,
      raw: r.raw,
    };
  }
}

/** The kiosk's SynqPay terminal from the cloud settings; null unless `paymentIntegration` = `synqpay`. */
export const synqpayFactory: ProviderFactory = (settings, ctx) => {
  const integration = String(settings.paymentIntegration ?? '').toLowerCase().replace(/-/g, '_');
  if (integration !== 'synqpay') return null;
  const read = synqpaySettingsOf(settings);
  if (!read.settings) {
    ctx.log(`synqpay: missing ${read.missing.join(', ')}`);
    return null;
  }
  return new SynqPayProvider(read.settings, ctx);
};
