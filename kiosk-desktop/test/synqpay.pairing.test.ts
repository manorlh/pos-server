/**
 * "צימוד מסוף SynqPay" on the Windows kiosk (pos-server docs/SPEC_SYNQPAY.md §2.2) — the same
 * cases as the Android till's SynqPayPairingTest: pair → the code from the terminal's screen →
 * the key; a wrong code, a code that ran out, a busy terminal, a serial that is not its, one that
 * cannot be reached; the kiosk's own key until the cloud has it; and a terminal with no key (or a
 * refused one) that never takes a card and says it needs pairing. No terminal, no network.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { PayService } from '../src/main/payment/payService';
import type { ProviderContext } from '../src/main/payment/provider';
import { mergeLocalKey, OTP_VALID_MS, PAIRING_TEXT, PairingSession, uploadOutcome, type PairingTerminal } from '../src/main/payment/synqpay/pairing';
import { SynqPayProvider, synqpayFactory, synqpaySettingsOf } from '../src/main/payment/synqpay/provider';
import { parseReply, type Reply } from '../src/main/payment/synqpay/protocol';
import { SynqAuthError, SynqNotSentError, type SynqTransport } from '../src/main/payment/synqpay/transport';

const KEY = '1234abcd';
const SERIAL = '244RKR528387';
const CODE = '400091';

const reply = (o: unknown): Reply => parseReply(JSON.stringify({ jsonrpc: '2.0', id: 'x', ...(o as object) }))!;
const ok = (r: unknown = null) => reply({ result: r });
const err = (code: number) => reply({ error: { code, message: 'e' } });

/** A terminal for the session: scripted answers, every call recorded. */
function terminal(script: { pair?: Array<Reply | Error>; authenticate?: Array<Reply | Error>; serial?: string | null }) {
  const calls: string[] = [];
  const next = (list: Array<Reply | Error> | undefined, name: string) => {
    calls.push(name);
    const a = list?.shift();
    if (!a) throw new Error(`unscripted ${name}`);
    if (a instanceof Error) throw a;
    return a;
  };
  const t: PairingTerminal = {
    pair: async () => next(script.pair, 'pair'),
    authenticateReply: async () => next(script.authenticate, 'authenticate'),
    serialWithoutKey: async () => {
      calls.push('getDeviceInfo');
      return script.serial ?? null;
    },
  };
  return { t, calls };
}

describe('the pairing session', () => {
  it('pair, the code from the screen, and the key', async () => {
    let now = 1_000;
    const s = new PairingSession(() => now);
    const { t, calls } = terminal({ pair: [ok()], authenticate: [ok({ apiKey: KEY })] });
    const st = await s.start(t, SERIAL);
    expect(st).toMatchObject({ phase: 'awaiting_code', serial: SERIAL, expiresAtMs: 1_000 + OTP_VALID_MS, error: null });
    now += 10_000;
    const r = await s.code(t, CODE);
    expect(r.apiKey).toBe(KEY);
    expect(r.status.phase).toBe('paired');
    expect(calls).toEqual(['pair', 'authenticate']);
  });

  it('no serial configured: the terminal is asked; refused, the manager types it', async () => {
    const s = new PairingSession();
    const asked = terminal({ pair: [ok()], serial: '235JKD8B2961' });
    expect((await s.start(asked.t, null)).serial).toBe('235JKD8B2961');
    expect(asked.calls).toEqual(['getDeviceInfo', 'pair']);
    const silent = terminal({ serial: null });
    expect((await s.start(silent.t, null)).phase).toBe('need_serial');
    expect(silent.calls).toEqual(['getDeviceInfo']);
    expect((await s.start(silent.t, 'ab')).error).toBe(PAIRING_TEXT.serialInvalid);
  });

  it('a wrong code keeps the code window open; the right one then pairs', async () => {
    const s = new PairingSession(() => 0);
    const { t } = terminal({ pair: [ok()], authenticate: [err(103), ok({ apiKey: KEY })] });
    await s.start(t, SERIAL);
    const wrong = await s.code(t, '111111');
    expect(wrong).toMatchObject({ apiKey: null, status: { phase: 'awaiting_code', error: PAIRING_TEXT.wrongCode } });
    expect((await s.code(t, CODE)).apiKey).toBe(KEY);
  });

  it('an expired code is never sent; the terminal saying so is expired too', async () => {
    let now = 0;
    const s = new PairingSession(() => now);
    const { t, calls } = terminal({ pair: [ok(), ok()], authenticate: [err(201)] });
    await s.start(t, SERIAL);
    now = OTP_VALID_MS;
    expect((await s.code(t, CODE)).status.phase).toBe('expired');
    expect(calls).toEqual(['pair']);
    now = 100_000;
    expect((await s.start(t, SERIAL)).expiresAtMs).toBe(100_000 + OTP_VALID_MS);
    expect((await s.code(t, CODE)).status).toMatchObject({ phase: 'expired', error: PAIRING_TEXT.codeExpired });
  });

  it('the countdown runs out on the kiosk clock', async () => {
    let now = 0;
    const s = new PairingSession(() => now);
    await s.start(terminal({ pair: [ok()] }).t, SERIAL);
    now = OTP_VALID_MS - 1;
    expect(s.expireIfDue().phase).toBe('awaiting_code');
    now = OTP_VALID_MS;
    expect(s.expireIfDue().phase).toBe('expired');
  });

  it('busy terminal, a serial that is not its, unreachable, a code that is not 6 digits', async () => {
    const s = new PairingSession(() => 0);
    expect(await s.start(terminal({ pair: [err(201)] }).t, SERIAL)).toMatchObject({ phase: 'failed', error: PAIRING_TEXT.terminalBusy });
    expect(await s.start(terminal({ pair: [err(202)] }).t, SERIAL)).toMatchObject({ phase: 'failed', error: PAIRING_TEXT.terminalBusy });
    expect(await s.start(terminal({ pair: [err(103)] }).t, SERIAL)).toMatchObject({ phase: 'need_serial', error: PAIRING_TEXT.serialMismatch });
    const down = await s.start(terminal({ pair: [new SynqNotSentError('ECONNREFUSED')] }).t, SERIAL);
    expect(down.phase).toBe('failed');
    expect(down.error).toContain('המסוף לא זמין');
    const { t, calls } = terminal({ pair: [ok()] });
    await s.start(t, SERIAL);
    expect((await s.code(t, '12a45')).status.error).toBe(PAIRING_TEXT.codeDigits);
    expect(calls).toEqual(['pair']);
  });

  it('an answer without a key keeps nothing', async () => {
    const s = new PairingSession(() => 0);
    const { t } = terminal({ pair: [ok()], authenticate: [ok({})] });
    await s.start(t, SERIAL);
    expect(await s.code(t, CODE)).toMatchObject({ apiKey: null, status: { phase: 'failed', error: PAIRING_TEXT.noKey } });
  });
});

describe('the kiosk’s own key until the cloud has it', () => {
  const cloud = { paymentIntegration: 'synqpay', synqpayApiKey: 'abcd0000' };
  it('a pending key wins over the sync’s; the cloud sending it settles it', () => {
    const local = { apiKey: KEY, pending: true, approver: 'u1', serial: SERIAL };
    expect(mergeLocalKey(cloud, local)).toEqual({ settings: { ...cloud, synqpayApiKey: KEY }, settled: false });
    expect(mergeLocalKey({ paymentIntegration: 'synqpay' }, local).settings.synqpayApiKey).toBe(KEY);
    expect(mergeLocalKey({ ...cloud, synqpayApiKey: KEY }, local)).toEqual({ settings: { ...cloud, synqpayApiKey: KEY }, settled: true });
    // Settled: the cloud's key is the kiosk's from then on.
    expect(mergeLocalKey(cloud, { ...local, pending: false }).settings.synqpayApiKey).toBe('abcd0000');
    expect(mergeLocalKey(cloud, null).settings).toBe(cloud);
  });

  it('the upload’s answer', () => {
    expect(uploadOutcome({ kind: 'ok' })).toBe('uploaded');
    expect(uploadOutcome({ kind: 'offline' })).toBe('offline');
    expect(uploadOutcome({ kind: 'refused', status: 401 })).toBe('needs_approval');
    expect(uploadOutcome({ kind: 'refused', status: 409 })).toBe('refused');
  });
});

/* ------------------------------------------------------- the provider itself */

class Script implements SynqTransport {
  readonly label = 'script';
  calls: Array<{ method: string; unauthenticated: boolean }> = [];
  private answers = new Map<string, Array<string | Error>>();

  on(method: string, ...replies: Array<string | Error>) {
    this.answers.set(method, [...(this.answers.get(method) ?? []), ...replies]);
    return this;
  }

  async call(id: string, json: string, _t: number, unauthenticated = false): Promise<string> {
    const req = JSON.parse(json) as { method: string };
    this.calls.push({ method: req.method, unauthenticated });
    const next = this.answers.get(req.method)?.shift();
    if (next === undefined) throw new Error(`unscripted ${req.method}`);
    if (next instanceof Error) throw next;
    return JSON.stringify({ ...JSON.parse(next), id });
  }

  close() {}
}

function ctx(rejected: Array<string | null> = []): ProviderContext {
  const kv = new Map<string, string>();
  return {
    machineId: 'kiosk1-machine',
    nextSequence: () => 1,
    getValue: (k) => kv.get(k) ?? null,
    setValue: (k, v) => void kv.set(k, v),
    parameter: () => undefined,
    log: () => undefined,
    onKeyRejected: (d) => void rejected.push(d),
  };
}

const lan = {
  paymentIntegration: 'synqpay',
  synqpayDeviceModel: 'dx8000',
  synqpayConnection: 'lan',
  synqpayHost: '192.168.1.40',
  expectedTerminalNumber: '0883198',
  terminalConfigSources: { expectedTerminalNumber: 'machine' },
};

describe('a SynqPay terminal with no key, or a refused one', () => {
  it('not paired: set up, never charged, nothing sent — and it pairs without a key', async () => {
    const s = new Script();
    const p = new SynqPayProvider(synqpaySettingsOf(lan).settings!, ctx(), s);
    expect(p.configured).toBe(false);
    expect(await p.check()).toEqual({ ok: false, detail: PAIRING_TEXT.notPaired });
    const sale = await p.sale({ amountAgorot: 1000, reference: 'v1', payments: 1 });
    expect(sale).toMatchObject({ answer: 'DECLINED', message: PAIRING_TEXT.notPaired });
    expect(s.calls).toEqual([]);
    s.on('getDeviceInfo', JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { serialNumber: SERIAL } }));
    s.on('pair', JSON.stringify({ jsonrpc: '2.0', id: 'x', result: null }));
    s.on('authenticate', JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { apiKey: KEY } }));
    const session = new PairingSession(() => 0);
    await session.start(p.pairing(), null);
    expect((await session.code(p.pairing(), CODE)).apiKey).toBe(KEY);
    expect(s.calls).toEqual([
      { method: 'getDeviceInfo', unauthenticated: true },
      { method: 'pair', unauthenticated: true },
      { method: 'authenticate', unauthenticated: true },
    ]);
  });

  it('a refused key: the check says pairing is needed and the cloud is told', async () => {
    const rejected: Array<string | null> = [];
    const s = new Script().on('getStatus', new SynqAuthError('מפתח ה-API נדחה במסוף (HTTP 401)'));
    const p = new SynqPayProvider(synqpaySettingsOf({ ...lan, synqpayApiKey: KEY }).settings!, ctx(rejected), s);
    expect(p.configured).toBe(true);
    const r = await p.check();
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('המסוף דורש צימוד — מפתח ה-API נדחה במסוף (HTTP 401)');
    expect(rejected).toEqual(['מפתח ה-API נדחה במסוף (HTTP 401)']);
  });

  it('the kiosk takes no orders on an unpaired terminal, and does once it is paired', () => {
    const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), 'kd-synq-')), 'k.db'));
    migrate(db);
    const pay = new PayService(db);
    const unpaired = synqpayFactory(lan, ctx());
    expect(unpaired).not.toBeNull();
    pay.setProvider(unpaired, 'synqpay');
    expect(pay.monitor.config).toBe('unconfigured');
    expect(pay.monitor.state).toBe('unconfigured');
    const paired = synqpayFactory({ ...lan, synqpayApiKey: KEY }, ctx());
    pay.setProvider(paired, 'synqpay');
    expect(pay.current).toBe(paired);
    expect(pay.monitor.config).toBe('ready');
  });
});
