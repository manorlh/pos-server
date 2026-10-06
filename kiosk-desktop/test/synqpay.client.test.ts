/**
 * The Windows kiosk's SynqPay client and provider (src/main/payment/synqpay/) against a scripted
 * terminal — the same card-recovery cases as the Android till's SynqPayTerminalTest — plus the
 * link transport over an in-memory channel and the HTTP transport against an in-process server.
 * No terminal, no network beyond 127.0.0.1, no charge.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandOf } from '../src/core/nayax';
import { SynqPayClient } from '../src/main/payment/synqpay/client';
import { FrameDecoder, TYPE, errorFrame, LINK_ERROR, payloadFrame } from '../src/main/payment/synqpay/link';
import { SynqPayProvider, cardLockOf, expectedTerminalOf, synqpayFactory, synqpaySettingsOf } from '../src/main/payment/synqpay/provider';
import { HttpTransport, LinkTransport, SynqAuthError, SynqNotSentError, httpRequest, pickSerialPort, serialChannel, type LinkChannel, type SynqTransport } from '../src/main/payment/synqpay/transport';
import { PROVIDERS } from '../src/main/payment/registry';
import type { ProviderContext } from '../src/main/payment/provider';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'synqpay', name), 'utf8');

/** Answers per method, in order; an Error entry is a lost reply. */
class Script implements SynqTransport {
  readonly label = 'script';
  calls: Array<{ method: string; params: Record<string, unknown> | null; unauthenticated: boolean }> = [];
  private answers = new Map<string, Array<string | Error>>();
  flips = 0;

  on(method: string, ...replies: Array<string | Error>) {
    this.answers.set(method, [...(this.answers.get(method) ?? []), ...replies]);
    return this;
  }

  methods() {
    return this.calls.map((c) => c.method);
  }

  async call(id: string, json: string, _t: number, unauthenticated = false): Promise<string> {
    const req = JSON.parse(json) as { method: string; params: Record<string, unknown> | null };
    this.calls.push({ method: req.method, params: req.params, unauthenticated });
    const next = this.answers.get(req.method)?.shift();
    if (next === undefined) throw new Error(`unscripted ${req.method}`);
    if (next instanceof Error) throw next;
    return JSON.stringify({ ...JSON.parse(next), id });
  }

  flipCrcOrder() {
    this.flips++;
    return true;
  }

  close() {}
}

const result = (r: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 'x', result: r });
const error = (code: number, message = 'e') => JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { code, message } });
const approved = (ref: string, amount = 1000) => {
  const o = JSON.parse(fixture('sale_approved.json'));
  Object.assign(o.result.transaction, { referenceId: ref, amount, totalAmount: amount });
  return JSON.stringify(o);
};
const found = (ref: string, status: string, amount = 1000) =>
  result({ transactionResult: 'OK', transaction: { transactionStatus: status, referenceId: ref, transactionId: `T-${ref}`, amount, totalAmount: amount, maskedPan: '458008XXXXXX3303', brand: 2, brandName: 'ויזה' } });

const noSleep = async () => undefined;
const ref = 'kiosk1-v1';
const client = (s: Script, serialNumber: string | null = '235JKD8B2961') => new SynqPayClient(s, 'kiosk1', { sleep: noSleep, serialNumber });

describe('SynqPayClient — money', () => {
  it('an approved sale is sent once', async () => {
    const s = new Script().on('startTransaction', approved(ref));
    const a = await client(s).sale('v1', 1000, 0, 1);
    expect(a.answer).toBe('APPROVED');
    expect(s.methods()).toEqual(['startTransaction']);
    expect(s.calls[0].params).toMatchObject({ referenceId: ref, amount: 1000, currency: 376 });
    if (a.answer === 'APPROVED') expect(brandOf(a.result)).toBe('visa');
  });

  it('a lost reply is looked up first — found approved, no cancel', async () => {
    const s = new Script().on('startTransaction', new Error('timeout')).on('getTransaction', found(ref, 'CAPTURED'));
    const a = await client(s).sale('v1', 1000, 0, 1);
    expect(a.answer).toBe('APPROVED');
    expect(s.methods()).toEqual(['startTransaction', 'getTransaction']);
  });

  it('a lost reply that cannot be settled is UNKNOWN — cancelled once, never declined', async () => {
    const s = new Script()
      .on('startTransaction', new Error('link closed'))
      .on('getTransaction', error(201), error(302), error(302))
      .on('cancel', result(null));
    const a = await client(s).sale('v1', 1000, 0, 1);
    expect(a.answer).toBe('UNKNOWN');
    expect(s.methods()).toEqual(['startTransaction', 'getTransaction', 'cancel', 'getTransaction', 'getTransaction']);
  });

  it('a 303 is looked up; nothing sent is a definite no; a refused key is a no', async () => {
    const dup = new Script().on('startTransaction', error(303)).on('getTransaction', found(ref, 'CAPTURED'));
    expect((await client(dup).sale('v1', 1000, 0, 1)).answer).toBe('APPROVED');
    const notSent = new Script().on('startTransaction', new SynqNotSentError('refused'));
    const n = await client(notSent).sale('v1', 1000, 0, 1);
    expect(n.answer).toBe('DECLINED');
    expect(n.answer === 'DECLINED' && n.result.statusCode).toBe(-1);
    expect(notSent.methods()).toEqual(['startTransaction']);
    const auth = new Script().on('startTransaction', new SynqAuthError('מפתח'));
    expect((await client(auth).sale('v1', 1000, 0, 1)).answer).toBe('DECLINED');
  });

  it('NETWORK_ERROR without a status is looked up, and a declined record settles it', async () => {
    const s = new Script().on('startTransaction', result({ result: 'NETWORK_ERROR', commandStatus: 'COMPLETED' })).on('getTransaction', found(ref, 'DECLINED'));
    expect((await client(s).sale('v1', 1000, 0, 1)).answer).toBe('DECLINED');
  });

  it('resolve: not found twice, 5 s apart, with one cancel', async () => {
    const s = new Script().on('getTransaction', error(302), error(302), error(302), error(302)).on('cancel', result(null));
    const r = await client(s).resolve('v1', 1000);
    expect(r.kind).toBe('not_found');
    expect(s.methods().filter((m) => m === 'cancel')).toHaveLength(1);
    expect(s.methods()[0]).toBe('getTransaction');
  });

  it('a void finds the sale by its uid and voids it by its referenceId; a settled one is refused', async () => {
    const s = new Script().on('getTransaction', found(ref, 'CAPTURED')).on('startTransaction', found(ref, 'VOIDED').replace('transactionResult', 'result'));
    expect((await client(s).void(`T-${ref}`)).answer).toBe('APPROVED');
    expect(s.calls[1].params).toMatchObject({ transactionType: 'VOID', referenceId: ref });
    const settled = new Script().on('getTransaction', found(ref, 'SETTLED'));
    expect((await client(settled).void(`T-${ref}`)).answer).toBe('DECLINED');
    expect(settled.methods()).toEqual(['getTransaction']);
  });

  it('transmission is the settlement; the batch file is counted', async () => {
    const s = new Script().on('settlement', fixture('settlement_ok.json')).on('getBatchFileStatus', fixture('batch_file.json'));
    const c = client(s);
    const t = await c.transmit();
    expect(t.outcome).toBe('success');
    expect(t.batchNumber).toBe('01649624');
    expect(await c.batchCount()).toBe(1);
  });

  it('probe: ready, another terminal, unreachable, a CRC flip', async () => {
    const ok = new Script().on('getStatus', fixture('status_idle.json')).on('getTerminalStatus', fixture('terminal_status.json')).on('getDeviceInfo', fixture('device_info.json'));
    expect((await client(ok).probe()).health).toBe('ready');
    const other = new Script().on('getStatus', fixture('status_idle.json')).on('getTerminalStatus', fixture('terminal_status.json')).on('getDeviceInfo', fixture('device_info.json'));
    const p = await client(other, '999OTHER0001').probe();
    expect(p.health).toBe('error');
    const down = new Script().on('getStatus', new SynqNotSentError('refused'));
    expect((await client(down).probe()).health).toBe('disconnected');
    const { SynqLinkError } = await import('../src/main/payment/synqpay/transport');
    const crc = new Script()
      .on('getStatus', new SynqLinkError(LINK_ERROR.CRC_ERROR), fixture('status_idle.json'))
      .on('getTerminalStatus', fixture('terminal_status.json'))
      .on('getDeviceInfo', fixture('device_info.json'));
    expect((await client(crc).probe()).health).toBe('ready');
    expect(crc.flips).toBe(1);
  });

  it('pairing goes without the key', async () => {
    const s = new Script().on('pair', result(null)).on('authenticate', result({ apiKey: '1234abcd' }));
    const c = client(s);
    await c.pair('244RKR528387');
    expect(await c.authenticate('400091')).toBe('1234abcd');
    expect(s.calls.every((x) => x.unauthenticated)).toBe(true);
  });
});

/* ---------------------------------------------------------------- provider */

const ctx = (): ProviderContext & { logs: string[] } => {
  const kv = new Map<string, string>();
  let seq = 0;
  const logs: string[] = [];
  return {
    machineId: 'kiosk1-machine',
    nextSequence: () => ++seq,
    getValue: (k) => kv.get(k) ?? null,
    setValue: (k, v) => kv.set(k, v),
    parameter: () => undefined,
    log: (m) => logs.push(m),
    logs,
  };
};

const lanSettings = {
  paymentIntegration: 'synqpay',
  synqpayDeviceModel: 'dx8000',
  synqpayConnection: 'lan',
  synqpayHost: '192.168.1.40',
  synqpayApiKey: '1234abcd',
  expectedTerminalNumber: '0883198',
  terminalConfigSources: { expectedTerminalNumber: 'machine' },
};

describe('SynqPay provider', () => {
  it('reads the cloud settings as the till does', () => {
    expect(synqpaySettingsOf(lanSettings).settings).toMatchObject({ connection: 'lan', host: '192.168.1.40', protocol: 'tcp', port: 9000 });
    expect(synqpaySettingsOf({ ...lanSettings, synqpayProtocol: 'http', synqpayTls: true }).settings?.port).toBe(8443);
    expect(synqpaySettingsOf({ synqpayConnection: 'lan' }).missing).toEqual(['synqpayDeviceModel', 'synqpayHost', 'synqpayApiKey']);
    expect(synqpaySettingsOf({ ...lanSettings, synqpayConnection: 'usb', synqpayHost: null }).missing).toEqual([]);
    expect(synqpaySettingsOf({ ...lanSettings, synqpayConnection: 'usb_serial', synqpayHost: null }).settings?.connection).toBe('usb');
    expect(synqpaySettingsOf({ ...lanSettings, synqpayConnection: 'builtin' }).missing).toContain('synqpayConnection');
    expect(synqpaySettingsOf({ ...lanSettings, synqpayConnection: 'usb_ip' }).missing).toContain('synqpayConnection');
  });

  it('is in the registry, and only for paymentIntegration = synqpay (never built-in on Windows)', () => {
    expect(PROVIDERS).toContain(synqpayFactory);
    expect(synqpayFactory({ ...lanSettings, paymentIntegration: 'nayax_lan' }, ctx())).toBeNull();
    const p = synqpayFactory(lanSettings, ctx());
    expect(p?.kind).toBe('synqpay');
    expect(p?.describe().address).toBe('192.168.1.40:9000 (TCP)');
    expect(JSON.stringify(p?.describe())).not.toContain('1234abcd');
    const c = ctx();
    expect(synqpayFactory({ ...lanSettings, synqpayConnection: 'builtin' }, c)).toBeNull();
    expect(c.logs.join()).toContain('synqpayConnection');
  });

  it("an approved sale carries the till's card meta", async () => {
    const c = ctx();
    const s = new Script();
    const p = new SynqPayProvider(synqpaySettingsOf(lanSettings).settings!, c, s);
    const reference = p.newReference();
    s.on('getTerminalStatus', fixture('terminal_status.json'));
    s.on('startTransaction', approved(p.client.referenceId(reference)));
    const r = await p.sale({ amountAgorot: 1000, reference, payments: 1 });
    expect(r.answer).toBe('APPROVED');
    if (r.answer !== 'APPROVED') return;
    expect(r.card).toMatchObject({ brand: 'visa', last4: '3303', authNum: '0792200', uid: '24112017553208811987387', chargedAgorot: 1000 });
    expect(r.card.meta).toMatchObject({ vuid: reference, uid: '24112017553208811987387', cardLast4: '3303', statusCode: 0, outcome: 'approved' });
    expect((r.card.meta.result as Record<string, unknown>).provider).toBe('synqpay');
  });

  it('the identity rule: the machine number, read off the terminal, or the card is locked', async () => {
    expect(cardLockOf('0883198', '883198')).toBeNull();
    expect(cardLockOf('0883198', '0884401')?.reason).toBe('mismatch');
    expect(cardLockOf(null, '0883198')?.reason).toBe('not_configured');
    expect(cardLockOf('0883198', null)?.reason).toBe('unknown');
    // An inherited number is no number for an external terminal.
    expect(expectedTerminalOf({ expectedTerminalNumber: '0883198', terminalConfigSources: { expectedTerminalNumber: 'shop' } })).toBeNull();
    // Another terminal on the line: nothing is sent, the sale is refused, the check fails.
    const s = new Script().on('getTerminalStatus', result({ terminalId: '0884401', terminalName: 'x' }));
    const p = new SynqPayProvider(synqpaySettingsOf(lanSettings).settings!, ctx(), s);
    const r = await p.sale({ amountAgorot: 1000, reference: 'v1', payments: 1 });
    expect(r.answer).toBe('DECLINED');
    expect(s.methods()).toEqual(['getTerminalStatus']);
    const unset = new Script();
    const q = new SynqPayProvider(synqpaySettingsOf({ ...lanSettings, expectedTerminalNumber: null }).settings!, ctx(), unset);
    expect((await q.sale({ amountAgorot: 1000, reference: 'v2', payments: 1 })).answer).toBe('DECLINED');
    expect(unset.methods()).toEqual([]);
  });

  it('resolve maps to the kiosk resolutions', async () => {
    const s = new Script().on('getTransaction', found('kiosk1machin-v9', 'CAPTURED'));
    const p = new SynqPayProvider(synqpaySettingsOf(lanSettings).settings!, ctx(), s);
    const r = await p.resolve({ reference: 'v9', amountAgorot: 1000, terminalTip: false });
    expect(r.kind).toBe('approved');
  });
});

/* -------------------------------------------------------------- transports */

/** A simulated terminal on an in-memory link channel. */
function fakeTerminal(answer: (method: string, id: string) => Buffer[] | null) {
  const decoder = new FrameDecoder();
  let onData: (b: Buffer) => void = () => undefined;
  const keys: string[] = [];
  const channel: LinkChannel = {
    write: (bytes) => {
      for (const f of decoder.feed(bytes)) {
        if (f.kind !== 'request') continue;
        keys.push(f.apiKey.toString('hex'));
        const req = JSON.parse(f.json) as { method: string; id: string };
        const out = answer(req.method, req.id);
        if (out) setImmediate(() => out.forEach((b) => onData(b)));
      }
    },
    close: () => undefined,
    onData: (cb) => {
      onData = cb;
    },
    onClose: () => undefined,
  };
  return { channel, keys };
}

describe('SynqPay transports', () => {
  it('link: framed with the key, the reply matched by id, an error frame given to its request', async () => {
    const t = fakeTerminal((method, id) =>
      method === 'getStatus'
        ? [payloadFrame(TYPE.EVENT, '{"jsonrpc":"2.0","method":"transactionEvent","params":{"type":"CARD_DETECTED"}}'), payloadFrame(TYPE.RESPONSE, JSON.stringify({ jsonrpc: '2.0', id, result: { deviceStatus: 'IDLE' } }))]
        : [errorFrame(LINK_ERROR.NOT_AUTHENTICATED)],
    );
    const events: string[] = [];
    const link = new LinkTransport('fake', () => '1234abcd', async () => t.channel, { onEvent: (e) => events.push(e) });
    const raw = await link.call('42', '{"jsonrpc":"2.0","method":"getStatus","id":"42","params":null}', 2_000);
    expect(JSON.parse(raw).result.deviceStatus).toBe('IDLE');
    expect(t.keys).toEqual(['1234abcd']);
    expect(events[0]).toContain('CARD_DETECTED');
    await expect(link.call('43', '{"jsonrpc":"2.0","method":"getConfig","id":"43","params":null}', 2_000)).rejects.toBeInstanceOf(SynqAuthError);
    link.close();
  });

  it('link: a key it cannot carry refuses; an unreachable terminal is not sent', async () => {
    const t = fakeTerminal(() => null);
    await expect(new LinkTransport('fake', () => 'not-hex!', async () => t.channel).call('1', '{}', 500)).rejects.toBeInstanceOf(SynqAuthError);
    await expect(
      new LinkTransport('fake', () => '1234abcd', async () => {
        throw new Error('ECONNREFUSED');
      }).call('1', '{}', 500),
    ).rejects.toBeInstanceOf(SynqNotSentError);
  });

  it('serial: the port named, the USB device named, or the only one; no package is not sent', async () => {
    const ports = [
      { path: 'COM1' },
      { path: 'COM3', vendorId: '0b00', productId: '0080', pnpId: 'USB\\VID_0B00&PID_0080' },
    ];
    expect(pickSerialPort(ports, 'com3')?.path).toBe('COM3');
    expect(pickSerialPort(ports, '0B00:0080')?.path).toBe('COM3');
    expect(pickSerialPort(ports, null)?.path).toBe('COM3');
    expect(pickSerialPort([...ports, { path: 'COM4', vendorId: '1234', productId: '5678' }], null)).toBeNull();
    await expect(serialChannel(null, async () => null)).rejects.toBeInstanceOf(SynqNotSentError);
  });

  it('http: the key in its header, 401 is the key refused', async () => {
    const text = httpRequest('192.168.1.40', 8000, '1234abcd', '{"a":"ש"}').toString('utf8');
    expect(text.startsWith('POST /synqpay HTTP/1.1\r\n')).toBe(true);
    expect(text).toContain('\r\napi-key: 1234abcd\r\n');
    expect(text).toContain('\r\nContent-Length: 10\r\n\r\n{"a":"ש"}');
    expect(httpRequest('h', 8000, null, '{}').toString('utf8')).not.toContain('api-key');
  });
});

describe('SynqPay HTTP against an in-process server', () => {
  let server: http.Server;
  let port = 0;
  const seen: Array<{ key: string | undefined; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ key: req.headers['api-key'] as string | undefined, body });
        if (req.headers['api-key'] !== '1234abcd') {
          res.statusCode = 401;
          res.end();
          return;
        }
        const id = (JSON.parse(body) as { id: string }).id;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { cancelable: false, deviceStatus: 'IDLE' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => server.close());

  it('answers with the key and refuses without it', async () => {
    const ok = new HttpTransport('127.0.0.1', port, () => '1234abcd', null);
    const raw = await ok.call('7', '{"jsonrpc":"2.0","method":"getStatus","id":"7","params":null}', 2_000);
    expect(JSON.parse(raw).result.deviceStatus).toBe('IDLE');
    expect(seen.at(-1)?.key).toBe('1234abcd');
    const wrong = new HttpTransport('127.0.0.1', port, () => 'ffffffff', null);
    await expect(wrong.call('8', '{"jsonrpc":"2.0","method":"getStatus","id":"8","params":null}', 2_000)).rejects.toBeInstanceOf(SynqAuthError);
  });

  it('a closed port is not sent', async () => {
    const closed = new HttpTransport('127.0.0.1', 1, () => '1234abcd', null, 500);
    await expect(closed.call('9', '{}', 1_000)).rejects.toBeInstanceOf(SynqNotSentError);
  });
});
